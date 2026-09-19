import type { FamilyMember } from '@/types/family'

function identityOf(member: FamilyMember): string {
  return `${member.name}|${member.birthDate}`
}

function hasAncestorCycle(start: FamilyMember, merged: Map<string, FamilyMember>): boolean {
  const visited = new Set<string>([start.id])
  let cursor = start.parentId
  while (cursor) {
    if (visited.has(cursor)) return true
    visited.add(cursor)
    cursor = merged.get(cursor)?.parentId ?? ''
  }
  return false
}

export function validateMemberBatch(existing: FamilyMember[], incoming: FamilyMember[]): string[] {
  const issues: string[] = []
  const merged = new Map<string, FamilyMember>()
  const seenIdentities = new Set(existing.map(identityOf))
  for (const member of existing) merged.set(member.id, member)

  for (const member of incoming) {
    if (merged.has(member.id)) issues.push(`重复成员：「${member.name}」的 ID（${member.id}）已存在`)
    const identity = identityOf(member)
    if (seenIdentities.has(identity)) issues.push(`重复成员：「${member.name}」（${member.birthDate || '生日未知'}）已在家谱中`)
    seenIdentities.add(identity)
    merged.set(member.id, member)
  }

  for (const member of incoming) {
    if (member.parentId === member.id || member.spouseIds.includes(member.id) || member.childrenIds.includes(member.id)) {
      issues.push(`自关联：「${member.name}」的父母、配偶或子女指向了自己`)
    }
    if (member.parentId && member.spouseIds.includes(member.parentId)) {
      issues.push(`关系冲突：「${member.name}」的配偶与父母指向同一人`)
    }
    if (member.parentId && member.parentId !== member.id && hasAncestorCycle(member, merged)) {
      issues.push(`祖先环：「${member.name}」的祖先链最终形成闭环`)
    }
  }

  return issues
}
