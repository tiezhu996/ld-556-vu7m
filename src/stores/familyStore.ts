import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { defaultMembers } from '@/constants/default-templates'
import type { FamilyMember, FamilyTreeNode, MemberRelationSummary } from '@/types/family'
import { readFamilyMembers, writeFamilyMembers } from '@/db/family-db'
import { getMemberStatus } from '@/utils/member-status'
import { closeBidirectionalRelations, RelationValidationError, validateRelations } from '@/utils/relation-validator'

function buildTree(members: FamilyMember[]): FamilyTreeNode[] {
  const map = new Map<string, FamilyTreeNode>(members.map((member) => [member.id, { ...member, status: getMemberStatus(member), children: [] }]))
  const roots: FamilyTreeNode[] = []
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)?.children?.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

export const useFamilyStore = defineStore('family', () => {
  const members = ref<FamilyMember[]>([])
  const loading = ref(false)

  const tree = computed(() => buildTree(members.value))
  const memberOptions = computed(() => members.value.map((member) => ({ label: member.name, value: member.id })))

  async function hydrate() {
    loading.value = true
    try {
      const stored = await readFamilyMembers()
      members.value = stored.length ? stored : defaultMembers
      if (!stored.length) await persist()
    } finally {
      loading.value = false
    }
  }

  async function persist() {
    await writeFamilyMembers(members.value)
  }

  function getById(id: string) {
    return members.value.find((member) => member.id === id)
  }

  function relations(id: string): MemberRelationSummary {
    const current = getById(id)
    if (!current) return { spouses: [], children: [], parents: [] }

    const parents: FamilyMember[] = []
    if (current.parentId) {
      const primary = getById(current.parentId)
      if (primary) parents.push(primary)
    }
    // 反查另一位父母：其子女列表包含本人、且不是 parentId 指向的主父母。
    for (const candidate of members.value) {
      if (candidate.id !== id && candidate.childrenIds.includes(id) && !parents.some((parent) => parent.id === candidate.id)) {
        parents.push(candidate)
      }
    }

    return {
      spouses: current.spouseIds.map(getById).filter(Boolean) as FamilyMember[],
      children: current.childrenIds.map(getById).filter(Boolean) as FamilyMember[],
      parents,
      parent: parents[0]
    }
  }

  /**
   * 原子批量导入：先基于「现有 + 待导入」做亲属关系闭环校验，
   * 任一项异常都抛出 RelationValidationError 且不改动任何现有数据；
   * 校验通过后补齐双向关系并整批落库，失败同样回滚内存与持久层。
   */
  async function importMembers(incoming: FamilyMember[]) {
    if (!incoming.length) throw new RelationValidationError([{ code: 'EMPTY_IMPORT', message: '导入文件中没有可导入的成员' }])

    const issues = validateRelations(incoming, members.value)
    if (issues.length) throw new RelationValidationError(issues)

    const incomingIds = new Set(incoming.map((member) => member.id))
    const snapshot = members.value
    try {
      members.value = closeBidirectionalRelations([...snapshot, ...incoming], incomingIds)
      await persist()
    } catch (error) {
      members.value = snapshot
      throw error
    }
  }

  async function addMember(member: FamilyMember) {
    members.value.push(member)
    if (member.parentId) {
      const parent = getById(member.parentId)
      if (parent && !parent.childrenIds.includes(member.id)) parent.childrenIds.push(member.id)
    }
    for (const spouseId of member.spouseIds) {
      const spouse = getById(spouseId)
      if (spouse && !spouse.spouseIds.includes(member.id)) spouse.spouseIds.push(member.id)
    }
    await persist()
  }

  async function updateMember(member: FamilyMember) {
    members.value = members.value.map((item) => (item.id === member.id ? member : item))
    await persist()
  }

  async function removeMember(id: string) {
    const descendantIds = new Set<string>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const member of members.value) {
        if (member.parentId && descendantIds.has(member.parentId) && !descendantIds.has(member.id)) {
          descendantIds.add(member.id)
          changed = true
        }
      }
    }
    members.value = members.value
      .filter((member) => !descendantIds.has(member.id))
      .map((member) => ({
        ...member,
        spouseIds: member.spouseIds.filter((spouseId) => !descendantIds.has(spouseId)),
        childrenIds: member.childrenIds.filter((childId) => !descendantIds.has(childId))
      }))
    await persist()
  }

  return { members, loading, tree, memberOptions, hydrate, persist, getById, relations, addMember, updateMember, removeMember, importMembers }
})
