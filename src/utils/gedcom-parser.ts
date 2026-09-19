import { Gender } from '@/constants/enums'
import type { FamilyMember } from '@/types/family'

interface GedcomPerson {
  id: string
  name: string
  gender: Gender
  birthDate: string
  deathDate: string
}

interface GedcomFamily {
  id: string
  husbandId: string
  wifeId: string
  childrenIds: string[]
}

interface MemberRelations {
  parentId: string
  spouseIds: Set<string>
  childrenIds: Set<string>
}

export function parseGedcom(content: string): FamilyMember[] {
  const lines = content.split(/\r?\n/)
  const people = new Map<string, GedcomPerson>()
  const families = new Map<string, GedcomFamily>()
  let context: 'INDI' | 'FAM' | '' = ''
  let currentId = ''
  let currentEvent: 'BIRT' | 'DEAT' | '' = ''

  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(?:@([^@]+)@\s+)?([A-Z0-9_]+)\s?(.*)$/)
    if (!match) continue
    const [, level, pointer, tag, value] = match
    if (level === '0') {
      currentEvent = ''
      if (pointer && tag === 'INDI') {
        context = 'INDI'
        currentId = pointer
        people.set(currentId, { id: currentId, name: '未命名成员', gender: Gender.OTHER, birthDate: '', deathDate: '' })
      } else if (pointer && tag === 'FAM') {
        context = 'FAM'
        currentId = pointer
        families.set(currentId, { id: currentId, husbandId: '', wifeId: '', childrenIds: [] })
      } else {
        context = ''
        currentId = ''
      }
      continue
    }
    if (context === 'INDI') {
      const person = people.get(currentId)
      if (!person) continue
      if (tag === 'NAME') person.name = value.replace(/\//g, '').trim() || person.name
      if (tag === 'SEX') person.gender = value === 'M' ? Gender.MALE : value === 'F' ? Gender.FEMALE : Gender.OTHER
      if (tag === 'BIRT' || tag === 'DEAT') currentEvent = tag
      if (tag === 'DATE' && currentEvent === 'BIRT') person.birthDate = normalizeGedcomDate(value)
      if (tag === 'DATE' && currentEvent === 'DEAT') person.deathDate = normalizeGedcomDate(value)
    }
    if (context === 'FAM') {
      const family = families.get(currentId)
      if (!family) continue
      const target = parsePointer(value)
      if (tag === 'HUSB' && target) family.husbandId = target
      if (tag === 'WIFE' && target) family.wifeId = target
      if (tag === 'CHIL' && target) family.childrenIds.push(target)
    }
  }

  return buildMembers(people, families)
}

function buildMembers(people: Map<string, GedcomPerson>, families: Map<string, GedcomFamily>): FamilyMember[] {
  const relations = new Map<string, MemberRelations>()
  for (const id of people.keys()) relations.set(id, { parentId: '', spouseIds: new Set(), childrenIds: new Set() })

  for (const family of families.values()) {
    const parentIds = [family.husbandId, family.wifeId].filter((id) => id && people.has(id))
    if (family.husbandId && family.wifeId && people.has(family.husbandId) && people.has(family.wifeId)) {
      relations.get(family.husbandId)?.spouseIds.add(family.wifeId)
      relations.get(family.wifeId)?.spouseIds.add(family.husbandId)
    }
    for (const childId of family.childrenIds) {
      const childRelations = relations.get(childId)
      if (!childRelations) continue
      if (!childRelations.parentId && parentIds.length) childRelations.parentId = parentIds[0]
      for (const parentId of parentIds) relations.get(parentId)?.childrenIds.add(childId)
    }
  }

  const members = [...people.values()].map((person) => {
    const relation = relations.get(person.id)
    return {
      id: person.id,
      name: person.name,
      gender: person.gender,
      birthDate: person.birthDate,
      deathDate: person.deathDate,
      birthPlace: '',
      bio: '由 GEDCOM 导入生成。',
      avatar: '',
      parentId: relation?.parentId ?? '',
      spouseIds: [...(relation?.spouseIds ?? [])],
      childrenIds: [...(relation?.childrenIds ?? [])],
      generation: 1
    }
  })
  applyGenerations(members)
  return members
}

function applyGenerations(members: FamilyMember[]) {
  const byId = new Map(members.map((member) => [member.id, member]))
  let frontier = members.filter((member) => !member.parentId || !byId.has(member.parentId))
  const visited = new Set(frontier.map((member) => member.id))
  let generation = 1
  while (frontier.length) {
    const next: FamilyMember[] = []
    for (const member of frontier) {
      member.generation = generation
      for (const childId of member.childrenIds) {
        const child = byId.get(childId)
        if (child && !visited.has(child.id)) {
          visited.add(child.id)
          next.push(child)
        }
      }
    }
    generation += 1
    frontier = next
  }
}

function parsePointer(value: string): string {
  return value.trim().match(/^@([^@]+)@$/)?.[1] ?? ''
}

function normalizeGedcomDate(value: string): string {
  const year = value.match(/\d{4}/)?.[0] || ''
  if (!year) return ''
  return `${year}-01-01`
}
