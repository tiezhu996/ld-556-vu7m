import { Gender } from '@/constants/enums'
import type { FamilyMember } from '@/types/family'

interface GedcomPerson {
  xref: string
  name: string
  gender: Gender
  birthDate: string
  deathDate: string
  birthPlace: string
  fams: string[]
  famc: string[]
}

interface GedcomFamily {
  xref: string
  husbands: string[]
  wives: string[]
  children: string[]
}

interface GedcomLine {
  level: number
  pointer: string
  tag: string
  value: string
}

interface GedcomRecordSet {
  people: Map<string, GedcomPerson>
  families: Map<string, GedcomFamily>
}

/**
 * 解析 GEDCOM 文件为内部 FamilyMember 列表。
 * 支持 INDI（NAME/SEX/BIRT/DEAT 的 DATE/PLAC）与 FAM（HUSB/WIFE/CHIL）记录，
 * 也兼容 INDI 下的 FAMS/FAMC 指针，父母、配偶、子女一次性写成双向关系。
 */
export function parseGedcom(content: string): FamilyMember[] {
  const { people, families } = tokenizeGedcom(content)
  const members = new Map<string, FamilyMember>()

  for (const person of people.values()) {
    members.set(person.xref, {
      id: toInternalId(person.xref),
      name: person.name,
      gender: person.gender,
      birthDate: person.birthDate,
      deathDate: person.deathDate,
      birthPlace: person.birthPlace,
      bio: '由 GEDCOM 导入生成。',
      avatar: '',
      parentId: '',
      spouseIds: [],
      childrenIds: [],
      generation: 1
    })
  }

  linkSpouses(people, families, members)
  linkParentsAndChildren(people, families, members)
  assignGenerations(members)

  return [...members.values()]
}

function tokenizeGedcom(content: string): GedcomRecordSet {
  const people = new Map<string, GedcomPerson>()
  const families = new Map<string, GedcomFamily>()
  let currentPerson: GedcomPerson | null = null
  let currentFamily: GedcomFamily | null = null
  let currentEvent: 'BIRT' | 'DEAT' | '' = ''

  for (const rawLine of content.split(/\r?\n/)) {
    const line = parseLine(rawLine)
    if (!line) continue

    if (line.level === 0) {
      currentEvent = ''
      if (line.tag === 'INDI' && line.pointer) {
        currentPerson = {
          xref: line.pointer,
          name: '未命名成员',
          gender: Gender.OTHER,
          birthDate: '',
          deathDate: '',
          birthPlace: '',
          fams: [],
          famc: []
        }
        people.set(line.pointer, currentPerson)
        currentFamily = null
      } else if (line.tag === 'FAM' && line.pointer) {
        currentFamily = { xref: line.pointer, husbands: [], wives: [], children: [] }
        families.set(line.pointer, currentFamily)
        currentPerson = null
      } else {
        currentPerson = null
        currentFamily = null
      }
      continue
    }

    if (currentPerson) {
      if (line.tag === 'NAME') currentPerson.name = line.value.replace(/\//g, '').trim() || currentPerson.name
      else if (line.tag === 'SEX') currentPerson.gender = toGender(line.value)
      else if (line.tag === 'BIRT' || line.tag === 'DEAT') currentEvent = line.tag
      else if (line.tag === 'DATE' && currentEvent === 'BIRT') currentPerson.birthDate = normalizeGedcomDate(line.value)
      else if (line.tag === 'DATE' && currentEvent === 'DEAT') currentPerson.deathDate = normalizeGedcomDate(line.value)
      else if (line.tag === 'PLAC' && currentEvent === 'BIRT') currentPerson.birthPlace = line.value.trim()
      else if (line.tag === 'FAMS') pushUnique(currentPerson.fams, stripPointer(line.value))
      else if (line.tag === 'FAMC') pushUnique(currentPerson.famc, stripPointer(line.value))
    } else if (currentFamily) {
      const pointer = stripPointer(line.value)
      if (!pointer) continue
      if (line.tag === 'HUSB') pushUnique(currentFamily.husbands, pointer)
      else if (line.tag === 'WIFE') pushUnique(currentFamily.wives, pointer)
      else if (line.tag === 'CHIL') pushUnique(currentFamily.children, pointer)
    }
  }

  return { people, families }
}

function parseLine(rawLine: string): GedcomLine | null {
  const match = rawLine.trim().match(/^(\d+)\s+(?:@([^@]+)@\s+)?([A-Za-z0-9_]+)(?:\s+(.*))?$/)
  if (!match) return null
  const [, level, pointer = '', rawTag, rawValue = ''] = match
  return { level: Number(level), pointer, tag: rawTag.toUpperCase(), value: rawValue.trim() }
}

function linkSpouses(people: Map<string, GedcomPerson>, families: Map<string, GedcomFamily>, members: Map<string, FamilyMember>) {
  // 以 FAM 记录为准，同时收集 INDI 的 FAMS 指针，保证两边声明都能闭合。
  for (const family of families.values()) {
    const partners = [...family.husbands, ...family.wives]
    for (const xref of partners) {
      if (!people.has(xref)) continue
      const member = members.get(xref)
      if (!member) continue
      for (const partnerXref of partners) {
        if (partnerXref !== xref && people.has(partnerXref)) pushUnique(member.spouseIds, toInternalId(partnerXref))
      }
      pushUnique(people.get(xref)!.fams, family.xref)
    }
  }

  for (const person of people.values()) {
    const member = members.get(person.xref)
    if (!member) continue
    for (const familyXref of person.fams) {
      const family = families.get(familyXref)
      if (!family) continue
      for (const partnerXref of [...family.husbands, ...family.wives]) {
        if (partnerXref !== person.xref && people.has(partnerXref)) pushUnique(member.spouseIds, toInternalId(partnerXref))
      }
    }
  }
}

function linkParentsAndChildren(people: Map<string, GedcomPerson>, families: Map<string, GedcomFamily>, members: Map<string, FamilyMember>) {
  for (const family of families.values()) {
    const parentXrefs = [...family.husbands, ...family.wives].filter((xref) => people.has(xref))
    for (const childXref of family.children) {
      if (!people.has(childXref)) continue
      const child = members.get(childXref)
      if (!child) continue
      // 内部模型为单 parent 指针：优先 HUSB（父亲），其次 WIFE；两位父母都记录子女关系。
      if (!child.parentId) child.parentId = parentXrefs.length ? toInternalId(parentXrefs[0]) : ''
      for (const parentXref of parentXrefs) {
        const parent = members.get(parentXref)
        if (parent) pushUnique(parent.childrenIds, child.id)
      }
      pushUnique(people.get(childXref)!.famc, family.xref)
    }
  }

  // 兜底：子女通过 FAMC 声明、但 FAM 的 CHIL 缺失时也能建立父母关系。
  for (const person of people.values()) {
    const child = members.get(person.xref)
    if (!child || child.parentId) continue
    for (const familyXref of person.famc) {
      const family = families.get(familyXref)
      if (!family) continue
      const parentXrefs = [...family.husbands, ...family.wives].filter((xref) => people.has(xref))
      if (parentXrefs.length) {
        child.parentId = toInternalId(parentXrefs[0])
        for (const parentXref of parentXrefs) pushUnique(members.get(parentXref)!.childrenIds, child.id)
        break
      }
    }
  }
}

function assignGenerations(members: Map<string, FamilyMember>) {
  const resolving = new Set<string>()
  const resolve = (xref: string): number => {
    const member = members.get(xref)
    if (!member) return 1
    if (!member.parentId) return 1
    const parentXref = fromInternalId(member.parentId)
    if (!members.has(parentXref) || resolving.has(parentXref)) return 1 // 防御祖先环，正式导入会被校验拦截
    resolving.add(xref)
    const generation = resolve(parentXref) + 1
    resolving.delete(xref)
    return generation
  }
  for (const [xref, member] of members) member.generation = resolve(xref)
}

function toGender(value: string): Gender {
  const code = value.trim().toUpperCase()
  return code === 'M' ? Gender.MALE : code === 'F' ? Gender.FEMALE : Gender.OTHER
}

function normalizeGedcomDate(value: string): string {
  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
  }
  const full = value.trim().toUpperCase().match(/(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/)
  if (full) {
    const [, day, month, year] = full
    const monthNumber = months[month]
    if (monthNumber) return `${year}-${monthNumber}-${day.padStart(2, '0')}`
  }
  const year = value.match(/\d{4}/)?.[0] || ''
  return year ? `${year}-01-01` : ''
}

function stripPointer(value: string): string {
  return value.trim().replace(/^@|@$/g, '').trim()
}

function toInternalId(xref: string): string {
  return `gedcom-${xref}`
}

function fromInternalId(id: string): string {
  return id.startsWith('gedcom-') ? id.slice('gedcom-'.length) : id
}

function pushUnique(list: string[], value: string) {
  if (value && !list.includes(value)) list.push(value)
}
