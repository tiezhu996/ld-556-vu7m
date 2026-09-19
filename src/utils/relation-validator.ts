import type { FamilyMember } from '@/types/family'

export type RelationIssueCode =
  | 'DUPLICATE_MEMBER'
  | 'SELF_RELATION'
  | 'SPOUSE_IS_PARENT'
  | 'ANCESTOR_CYCLE'
  | 'DANGLING_REFERENCE'
  | 'EMPTY_IMPORT'

export interface RelationIssue {
  code: RelationIssueCode
  message: string
}

/** 关系校验未通过：整批导入必须被拒绝 */
export class RelationValidationError extends Error {
  issues: RelationIssue[]

  constructor(issues: RelationIssue[]) {
    super(`亲属关系校验未通过（${issues.length} 项异常），已整批拒绝导入`)
    this.name = 'RelationValidationError'
    this.issues = issues
  }
}

const unique = (values: string[]): string[] => [...new Set(values)]

/**
 * 导入前校验亲属关系闭环。
 * 检查项：重复成员、自关联、配偶与父母指向同一人、祖先环、悬空亲属引用。
 * 任一项异常都由调用方整批拒绝，existing 为库中现有成员（只读，不会被修改）。
 */
export function validateRelations(incoming: FamilyMember[], existing: FamilyMember[] = []): RelationIssue[] {
  const issues: RelationIssue[] = []
  const push = (code: RelationIssueCode, message: string) => issues.push({ code, message })

  const existingIds = new Set(existing.map((member) => member.id))
  const incomingIds = new Set<string>()
  const batchIds = new Set<string>()
  for (const member of incoming) {
    incomingIds.add(member.id)
    if (batchIds.has(member.id)) {
      push('DUPLICATE_MEMBER', `成员 ID「${member.id}」在导入文件中重复出现`)
    }
    batchIds.add(member.id)
    if (existingIds.has(member.id)) {
      push('DUPLICATE_MEMBER', `成员「${member.name}」(ID：${member.id}) 与现有成员重复`)
    }
  }

  const merged = new Map<string, FamilyMember>()
  for (const member of existing) merged.set(member.id, member)
  for (const member of incoming) merged.set(member.id, member)
  const nameOf = (id: string) => merged.get(id)?.name || id

  for (const member of incoming) {
    if (member.parentId) {
      if (member.parentId === member.id) {
        push('SELF_RELATION', `成员「${member.name}」不能将自己设为父母`)
      } else if (!merged.has(member.parentId)) {
        push('DANGLING_REFERENCE', `成员「${member.name}」引用了不存在的父母「${member.parentId}」`)
      }
    }

    for (const spouseId of unique(member.spouseIds)) {
      if (spouseId === member.id) {
        push('SELF_RELATION', `成员「${member.name}」不能与自己结为配偶`)
      } else if (!merged.has(spouseId)) {
        push('DANGLING_REFERENCE', `成员「${member.name}」引用了不存在的配偶「${spouseId}」`)
      }
      if (member.parentId && spouseId === member.parentId) {
        push('SPOUSE_IS_PARENT', `成员「${member.name}」的配偶与父母指向同一人「${nameOf(spouseId)}」`)
      }
    }

    for (const childId of unique(member.childrenIds)) {
      if (childId === member.id) {
        push('SELF_RELATION', `成员「${member.name}」不能将自己设为子女`)
      } else if (!merged.has(childId)) {
        push('DANGLING_REFERENCE', `成员「${member.name}」引用了不存在的子女「${childId}」`)
      }
    }
  }

  detectAncestorCycles(incomingIds, merged, push)

  const deduped = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.message}`
    if (deduped.has(key)) return false
    deduped.add(key)
    return true
  })
}

/** 三色 DFS 遍历父母链；只对包含本次导入成员的环报错，避免拒绝历史数据。 */
function detectAncestorCycles(
  incomingIds: Set<string>,
  merged: Map<string, FamilyMember>,
  push: (code: RelationIssueCode, message: string) => void
) {
  const parentOf = (id: string): string => {
    const parentId = merged.get(id)?.parentId || ''
    return parentId && parentId !== id && merged.has(parentId) ? parentId : ''
  }
  const colors = new Map<string, 0 | 1>() // 0 遍历中 / 1 已完成（迭代式三色 DFS）
  const cycleNodes = new Set<string>()

  const visit = (start: string) => {
    const stack: Array<{ id: string; advanced: boolean }> = [{ id: start, advanced: false }]
    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (!frame.advanced) {
        colors.set(frame.id, 0)
        frame.advanced = true
      }
      const parent = parentOf(frame.id)
      if (parent) {
        const parentColor = colors.get(parent)
        if (parentColor === undefined) {
          stack.push({ id: parent, advanced: false })
          continue
        }
        if (parentColor === 0) {
          const cycleStart = stack.findIndex((item) => item.id === parent)
          for (let i = cycleStart; i < stack.length; i += 1) cycleNodes.add(stack[i].id)
        }
      }
      colors.set(frame.id, 1)
      stack.pop()
    }
  }

  for (const id of merged.keys()) {
    if (colors.get(id) === undefined) visit(id)
  }

  for (const id of cycleNodes) {
    if (incomingIds.has(id)) {
      push('ANCESTOR_CYCLE', `成员「${nameOfSafe(merged, id)}」的祖先链存在环路（不能成为自己的祖先）`)
    }
  }
}

function nameOfSafe(merged: Map<string, FamilyMember>, id: string): string {
  return merged.get(id)?.name || id
}

/**
 * 导入成员与现有成员合并后补齐双向关系：
 * 新成员引用的现有父母/配偶/子女，反向链接补到现有成员上，保证树与详情读取同一闭环。
 */
export function closeBidirectionalRelations(all: FamilyMember[], ownerIds: Set<string>): FamilyMember[] {
  const next = all.map((member) => ({ ...member, spouseIds: [...member.spouseIds], childrenIds: [...member.childrenIds] }))
  const index = new Map(next.map((member) => [member.id, member]))

  for (const member of next) {
    if (!ownerIds.has(member.id)) continue

    if (member.parentId) {
      const parent = index.get(member.parentId)
      if (parent && !parent.childrenIds.includes(member.id)) parent.childrenIds.push(member.id)
    }

    for (const spouseId of member.spouseIds) {
      const spouse = index.get(spouseId)
      if (spouse && !spouse.spouseIds.includes(member.id)) spouse.spouseIds.push(member.id)
    }

    for (const childId of member.childrenIds) {
      const child = index.get(childId)
      if (child && !child.parentId) child.parentId = member.id
    }
  }

  return next
}

export function formatIssues(issues: RelationIssue[], limit = 3): string {
  const head = issues.slice(0, limit).map((issue) => issue.message)
  const suffix = issues.length > limit ? ` 等 ${issues.length} 项异常` : ''
  return `${head.join('；')}${suffix}`
}
