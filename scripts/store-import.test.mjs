import { rolldown } from 'rolldown'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = process.cwd()
const tmp = mkdtempSync(join(tmpdir(), 'store-test-'))

// 注入内存版 family-db，记录每次写入并可模拟落库失败
const dbState = { rows: [], failWrites: false, writeCount: 0 }
globalThis.__MOCK_DB__ = dbState
const mockDbPath = join(tmp, 'family-db.ts')
writeFileSync(
  mockDbPath,
  `
const state = globalThis.__MOCK_DB__
export function readFamilyMembers() { return Promise.resolve(state.rows) }
export function writeFamilyMembers(records) {
  state.writeCount += 1
  if (state.failWrites) return Promise.reject(new Error('IndexedDB 写入失败'))
  state.rows = JSON.parse(JSON.stringify(records))
  return Promise.resolve()
}
export function clearFamilyMembers() { state.rows = []; return Promise.resolve() }
`
)

// 入口放在 src 内，使 @ 相对解析；store 对 family-db 的导入在打包后重定向到内存 mock
const entry = join(projectRoot, 'src', '__store_test_entry__.ts')
writeFileSync(entry, `
import { useFamilyStore } from './stores/familyStore'
import { createPinia, setActivePinia } from 'pinia'
export { useFamilyStore, createPinia, setActivePinia }
`)

let bundledCode
try {
  const srcDir = join(projectRoot, 'src')
  const atResolver = {
    name: 'at-alias',
    resolveId(source) {
      if (source.startsWith('@/')) return join(srcDir, source.slice(2)) + '.ts'
      return null
    }
  }
  const dbMockResolver = {
    name: 'family-db-mock',
    resolveId(source) {
      if (source.endsWith('db/family-db')) return mockDbPath
      return null
    }
  }
  const build = await rolldown({
    input: entry,
    external: ['vue', 'pinia', '@vue/devtools-api'],
    platform: 'browser',
    plugins: [dbMockResolver, atResolver]
  })
  const { output } = await build.generate({ format: 'esm' })
  await build.close()
  bundledCode = output[0].code
} finally {
  rmSync(entry, { force: true })
}

// 将裸模块名指向真实 ESM 文件，便于 Node 直接执行
bundledCode = bundledCode.replace(
  /from\s*(['"])vue\1/g,
  `from ${JSON.stringify(join(projectRoot, 'node_modules/vue/dist/vue.esm-bundler.js'))}`
)
bundledCode = bundledCode.replace(
  /from\s*(['"])pinia\1/g,
  `from ${JSON.stringify(join(projectRoot, 'node_modules/pinia/dist/pinia.mjs'))}`
)

const storeBundle = join(projectRoot, 'node_modules', '.tmp-store-test.bundle.mjs')
writeFileSync(storeBundle, bundledCode)
const { useFamilyStore, createPinia, setActivePinia } = await import(storeBundle)

let failures = 0
function assert(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail && !condition ? ` — ${detail}` : ''}`)
  if (!condition) failures += 1
}

function member(overrides = {}) {
  return {
    name: 'X',
    gender: 'OTHER',
    birthDate: '',
    deathDate: '',
    birthPlace: '',
    bio: '',
    avatar: '',
    parentId: '',
    spouseIds: [],
    childrenIds: [],
    generation: 1,
    ...overrides
  }
}

setActivePinia(createPinia())
const store = useFamilyStore()

// 预置两条现有成员
store.members = [
  member({ id: 'e1', name: 'Existing Dad' }),
  member({ id: 'e2', name: 'Existing Mum', spouseIds: ['e1'] })
]
store.members[0].spouseIds = ['e2']

// 场景 1：正常导入，关系双向闭合并落库
const incoming = [
  member({ id: 'n1', name: 'New Kid', parentId: 'e1' }),
  member({ id: 'n2', name: 'New Spouse Of Kid', spouseIds: ['n1'] })
]
await store.importMembers(incoming)
assert('success: count after import', store.members.length === 4, `got ${store.members.length}`)
assert('success: existing parent gains child backlink', store.getById('e1').childrenIds.includes('n1'))
assert('success: child gains spouse backlink', store.getById('n1').spouseIds.includes('n2'))
assert('success: spouse backlink symmetric', store.getById('n2').spouseIds.includes('n1'))
assert('success: persisted to db', dbState.rows.length === 4)
const persistedKid = dbState.rows.find((m) => m.id === 'n1')
assert('success: persisted relations in storage', persistedKid.parentId === 'e1' && persistedKid.spouseIds.includes('n2'))

// 场景 2：重复成员（与现有成员撞 ID）整批拒绝
const beforeCount = store.members.length
const beforeSnapshot = JSON.stringify(store.members)
let rejected = null
try {
  await store.importMembers([member({ id: 'e1', name: 'Duplicate' })])
} catch (error) {
  rejected = error
}
assert('reject duplicate: RelationValidationError', rejected?.name === 'RelationValidationError')
assert('reject duplicate: issue code', rejected?.issues?.[0]?.code === 'DUPLICATE_MEMBER')
assert('reject duplicate: in-memory data intact', store.members.length === beforeCount)
assert('reject duplicate: storage untouched', dbState.rows.length === beforeCount)

// 场景 3：自关联
rejected = null
try {
  await store.importMembers([member({ id: 's1', name: 'Self', spouseIds: ['s1'] })])
} catch (error) {
  rejected = error
}
assert('reject self relation', rejected?.issues?.some((i) => i.code === 'SELF_RELATION'))
assert('reject self relation: data intact', JSON.stringify(store.members) === beforeSnapshot)

// 场景 4：配偶与父母同一人
rejected = null
try {
  await store.importMembers([
    member({ id: 'p1', name: 'Parent', childrenIds: ['c1'] }),
    member({ id: 'c1', name: 'Child', parentId: 'p1', spouseIds: ['p1'] })
  ])
} catch (error) {
  rejected = error
}
assert('reject spouse-is-parent', rejected?.issues?.some((i) => i.code === 'SPOUSE_IS_PARENT'))
assert('reject spouse-is-parent: data intact', store.members.length === beforeCount)

// 场景 5：祖先环
rejected = null
try {
  await store.importMembers([
    member({ id: 'x', name: 'X', parentId: 'z' }),
    member({ id: 'y', name: 'Y', parentId: 'x' }),
    member({ id: 'z', name: 'Z', parentId: 'y' })
  ])
} catch (error) {
  rejected = error
}
assert('reject ancestor cycle', rejected?.issues?.some((i) => i.code === 'ANCESTOR_CYCLE'))
assert('reject ancestor cycle: data intact', store.members.length === beforeCount)

// 场景 6：悬空引用
rejected = null
try {
  await store.importMembers([member({ id: 'd1', name: 'Dangling', parentId: 'ghost' })])
} catch (error) {
  rejected = error
}
assert('reject dangling reference', rejected?.issues?.some((i) => i.code === 'DANGLING_REFERENCE'))
assert('reject dangling: data intact', store.members.length === beforeCount)

// 场景 7：空批次
rejected = null
try {
  await store.importMembers([])
} catch (error) {
  rejected = error
}
assert('reject empty batch', rejected?.issues?.[0]?.code === 'EMPTY_IMPORT')

// 场景 8：落库失败时内存回滚
dbState.failWrites = true
rejected = null
try {
  await store.importMembers([member({ id: 'f1', name: 'Will Fail' })])
} catch (error) {
  rejected = error
}
dbState.failWrites = false
assert('persist failure: error surfaced', rejected instanceof Error && rejected.name !== 'RelationValidationError')
assert('persist failure: memory rolled back', store.members.length === beforeCount)
assert('persist failure: old data still readable', store.getById('n1') !== undefined && store.getById('f1') === undefined)

// 场景 9：hydrate 从持久层重新读取同一关系（模拟刷新）
setActivePinia(createPinia())
const freshStore = useFamilyStore()
await freshStore.hydrate()
const reloadedKid = freshStore.getById('n1')
const reloadedDad = freshStore.getById('e1')
assert('reload: imported members present', Boolean(reloadedKid && reloadedDad))
assert('reload: parent relation readable', reloadedKid.parentId === 'e1')
assert('reload: child backlink readable', reloadedDad.childrenIds.includes('n1'))
assert('reload: spouse relation readable', reloadedKid.spouseIds.includes('n2'))
assert('reload: rejected batch never persisted', freshStore.getById('f1') === undefined)
const dadNode = freshStore.tree.find((n) => n.id === 'e1')
assert('reload: tree built from same relations', dadNode?.children?.some((c) => c.id === 'n1'))
const kidRelations = freshStore.relations('n1')
assert('reload: relations() reads same data as tree', kidRelations.parent?.id === 'e1' && kidRelations.spouses.some((s) => s.id === 'n2'))

rmSync(storeBundle, { force: true })
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll store checks passed')
process.exit(failures ? 1 : 0)
