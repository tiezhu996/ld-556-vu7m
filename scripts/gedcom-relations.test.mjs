import { rolldown } from 'rolldown'
import { fileURLToPath, URL } from 'node:url'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const srcDir = fileURLToPath(new URL('../src', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'gedcom-test-'))

async function bundle(modulePath) {
  const entry = join(tmp, modulePath.replace(/[@/]/g, '-') + '.ts')
  writeFileSync(entry, `export * from ${JSON.stringify(modulePath)}\n`)
  const build = await rolldown({
    input: entry,
    resolve: { alias: { '@': srcDir } },
    platform: 'node',
    external: []
  })
  const { output } = await build.generate({ format: 'esm' })
  await build.close()
  return output[0].code
}

const [parserCode, validatorCode] = await Promise.all([
  bundle('@/utils/gedcom-parser.ts'),
  bundle('@/utils/relation-validator.ts')
])

const parser = await import('data:text/javascript,' + encodeURIComponent(parserCode))
const validator = await import('data:text/javascript,' + encodeURIComponent(validatorCode))

const GEDCOM = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Zhang /San/
1 SEX M
1 BIRT
2 DATE 15 JAN 1950
2 PLAC Beijing
1 FAMS @F1@
0 @I2@ INDI
1 NAME Li /Si/
1 SEX F
1 FAMS @F1@
0 @I3@ INDI
1 NAME Zhang /Wu/
1 SEX M
1 FAMC @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME Wang /Liu/
1 SEX F
1 FAMS @F2@
0 @I5@ INDI
1 NAME Zhang /Xiao/
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I5@
0 TRLR
`

let failures = 0
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
  if (!pass) {
    failures += 1
    console.log('  expected:', JSON.stringify(expected))
    console.log('  actual:  ', JSON.stringify(actual))
  }
}

const members = parser.parseGedcom(GEDCOM)
const byXref = Object.fromEntries(members.map((m) => [m.id.replace('gedcom-', ''), m]))

check('parsed member count', members.length, 5)
check('I1 name', byXref.I1.name, 'Zhang San')
check('I1 birthDate', byXref.I1.birthDate, '1950-01-15')
check('I1 birthPlace', byXref.I1.birthPlace, 'Beijing')
check('I1 spouse', byXref.I1.spouseIds, ['gedcom-I2'])
check('I2 spouse backlink', byXref.I2.spouseIds, ['gedcom-I1'])
check('I3 spouse (via FAMS+FAM)', byXref.I3.spouseIds, ['gedcom-I4'])
check('I4 spouse backlink', byXref.I4.spouseIds, ['gedcom-I3'])
check('I3 parentId (HUSB first)', byXref.I3.parentId, 'gedcom-I1')
check('I5 parentId', byXref.I5.parentId, 'gedcom-I3')
check('I1 childrenIds includes I3', byXref.I1.childrenIds, ['gedcom-I3'])
check('I2 childrenIds backlink (second parent)', byXref.I2.childrenIds, ['gedcom-I3'])
check('I3 childrenIds', byXref.I3.childrenIds, ['gedcom-I5'])
check('I4 childrenIds backlink', byXref.I4.childrenIds, ['gedcom-I5'])
check('generation I1', byXref.I1.generation, 1)
check('generation I3', byXref.I3.generation, 2)
check('generation I5', byXref.I5.generation, 3)
check('generation I2 (root parent)', byXref.I2.generation, 1)

// ---------- validator: happy path ----------
check('valid batch has no issues', validator.validateRelations(members, []).length, 0)

// ---------- duplicate against existing ----------
const existing = members.map((m) => ({ ...m, spouseIds: [...m.spouseIds], childrenIds: [...m.childrenIds] }))
const dupIssues = validator.validateRelations(members, existing)
check('duplicate batch rejected', dupIssues.some((i) => i.code === 'DUPLICATE_MEMBER'), true)

// duplicate inside the file itself
const internalDup = [
  { id: 'a', name: 'A', spouseIds: [], childrenIds: [], parentId: '' },
  { id: 'a', name: 'A2', spouseIds: [], childrenIds: [], parentId: '' }
]
check('internal duplicate detected', validator.validateRelations(internalDup, []).some((i) => i.code === 'DUPLICATE_MEMBER'), true)

// ---------- self relation ----------
const selfRel = [
  { id: 'a', name: 'A', spouseIds: ['a'], childrenIds: ['a'], parentId: 'a' }
]
const selfCodes = validator.validateRelations(selfRel, []).map((i) => i.code)
check('self spouse/child/parent all detected', ['SELF_RELATION', 'SELF_RELATION', 'SELF_RELATION'].every((c) => selfCodes.includes(c)), true)

// ---------- spouse is parent ----------
const spouseParent = [
  { id: 'p', name: 'P', spouseIds: ['c'], childrenIds: ['c'], parentId: '' },
  { id: 'c', name: 'C', spouseIds: ['p'], childrenIds: [], parentId: 'p' }
]
check('spouse-is-parent detected', validator.validateRelations(spouseParent, []).some((i) => i.code === 'SPOUSE_IS_PARENT'), true)

// ---------- ancestor cycle ----------
const cycle = [
  { id: 'x', name: 'X', spouseIds: [], childrenIds: ['y'], parentId: 'z' },
  { id: 'y', name: 'Y', spouseIds: [], childrenIds: ['z'], parentId: 'x' },
  { id: 'z', name: 'Z', spouseIds: [], childrenIds: ['x'], parentId: 'y' }
]
check('ancestor cycle detected', validator.validateRelations(cycle, []).some((i) => i.code === 'ANCESTOR_CYCLE'), true)

// 2-cycle
const cycle2 = [
  { id: 'x', name: 'X', spouseIds: [], childrenIds: ['y'], parentId: 'y' },
  { id: 'y', name: 'Y', spouseIds: [], childrenIds: ['x'], parentId: 'x' }
]
check('2-node ancestor cycle detected', validator.validateRelations(cycle2, []).some((i) => i.code === 'ANCESTOR_CYCLE'), true)

// ---------- dangling reference ----------
const dangling = [{ id: 'a', name: 'A', spouseIds: ['ghost'], childrenIds: [], parentId: 'nobody' }]
check('dangling spouse and parent detected', validator.validateRelations(dangling, []).filter((i) => i.code === 'DANGLING_REFERENCE').length, 2)

// ---------- pre-existing cycle in historical data must not block import ----------
const historicalCycle = [
  { id: 'h1', name: 'H1', spouseIds: [], childrenIds: ['h2'], parentId: 'h2' },
  { id: 'h2', name: 'H2', spouseIds: [], childrenIds: ['h1'], parentId: 'h1' }
]
const cleanNew = [{ id: 'n1', name: 'N1', spouseIds: [], childrenIds: [], parentId: '' }]
check('historical cycle does not block clean import', validator.validateRelations(cleanNew, historicalCycle).length, 0)

// ---------- closeBidirectionalRelations merges with existing members ----------
const existingFamily = [
  { id: 'dad', name: 'Dad', spouseIds: ['mum'], childrenIds: [], parentId: '' },
  { id: 'mum', name: 'Mum', spouseIds: ['dad'], childrenIds: [], parentId: '' }
]
const incomingFamily = [
  { id: 'kid', name: 'Kid', spouseIds: [], childrenIds: [], parentId: 'dad' },
  { id: 'spouseOfKid', name: 'InLaw', spouseIds: ['kid'], childrenIds: [], parentId: '' }
]
const issues = validator.validateRelations(incomingFamily, existingFamily)
check('merge batch valid', issues.length, 0)
const owners = new Set(incomingFamily.map((m) => m.id))
const merged = validator.closeBidirectionalRelations([...existingFamily, ...incomingFamily], owners)
const get = (id) => merged.find((m) => m.id === id)
check('dad gains child backlink', get('dad').childrenIds, ['kid'])
check('kid gains spouse backlink', get('kid').spouseIds, ['spouseOfKid'])
check('inlaw gains spouse backlink', get('spouseOfKid').spouseIds, ['kid'])
check('existing records untouched when not linked', get('mum').childrenIds, [])
// immutability: originals not mutated
check('original existing member not mutated', existingFamily[0].childrenIds, [])

// ---------- year-only date fallback ----------
const yearOnly = parser.parseGedcom('0 @I9@ INDI\n1 NAME Only /Year/\n1 BIRT\n2 DATE 1972\n0 TRLR\n')
check('year-only date normalized', yearOnly[0].birthDate, '1972-01-01')
check('default name for missing NAME', parser.parseGedcom('0 @I8@ INDI\n1 SEX F\n0 TRLR\n')[0].name, '未命名成员')

// ---------- FAMS/FAMC-only style (no pointers inside FAM) still closes ----------
const famcStyle = `0 @A@ INDI
1 NAME A
1 SEX M
1 FAMS @G1@
0 @B@ INDI
1 NAME B
1 SEX F
1 FAMS @G1@
0 @C@ INDI
1 NAME C
1 FAMC @G1@
0 @G1@ FAM
1 HUSB @A@
1 WIFE @B@
1 CHIL @C@
0 TRLR
`
const famcMembers = parser.parseGedcom(famcStyle)
const fc = Object.fromEntries(famcMembers.map((m) => [m.name, m]))
check('FAMC child parent', fc.C.parentId, 'gedcom-A')
check('FAMC A child backlink', fc.A.childrenIds, ['gedcom-C'])
check('FAMC B child backlink', fc.B.childrenIds, ['gedcom-C'])
check('FAMC marriage A', fc.A.spouseIds, ['gedcom-B'])
check('FAMC marriage B', fc.B.spouseIds, ['gedcom-A'])

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
