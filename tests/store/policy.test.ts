import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createPolicyStore } from '../../src/store/policy'
import { matchesRule, type MeetingFacts } from '../../src/policy/conds'
import { sortStackRules } from '../../src/policy/stacks'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

async function insertRule(opts: {
  kind: string
  priority: number
  join?: string
  conds?: unknown
  condsRaw?: string
  subjectType?: string
  subjectValue?: string
  assetTypes: unknown[]
  effect: string
  note?: string | null
  createdBy?: string | null
  enabled?: number
}): Promise<number> {
  const [res] = await pool.execute(
    `INSERT INTO policy_rules
       (kind, priority, join_op, conds, subject_type, subject_value, asset_types, effect,
        note, created_by, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      opts.kind,
      opts.priority,
      opts.join ?? 'and',
      opts.condsRaw ?? JSON.stringify(opts.conds ?? []),
      opts.subjectType ?? '',
      opts.subjectValue ?? '',
      JSON.stringify(opts.assetTypes),
      opts.effect,
      opts.note ?? null,
      opts.createdBy ?? null,
      opts.enabled ?? 1,
    ],
  )
  return Number((res as { insertId: number }).insertId)
}

const facts: MeetingFacts = {
  title: '季度评审',
  hostUserId: 'tm-alice',
  dept: null,
  startTime: 1_700_000_000,
  endTime: 1_700_003_600,
  recordEndTime: 1_700_003_600,
  archived: false,
}

test('只返回指定栈的规则，别的栈不串进来', async () => {
  const store = createPolicyStore(pool)
  const allowId = await insertRule({
    kind: 'allow', priority: 10, subjectType: 'program', subjectValue: 'prog-a',
    assetTypes: ['*'], effect: 'allow', note: '放行 prog-a',
  })
  const fetchId = await insertRule({
    kind: 'fetch', priority: 10, assetTypes: ['video'], effect: 'all',
  })

  const allow = await store.listEnabledStackRules('allow')
  expect(allow.map((r) => r.id)).toContain(allowId)
  expect(allow.map((r) => r.id)).not.toContain(fetchId)
  expect(allow.every((r) => r.kind === 'allow')).toBe(true)

  const fetch = await store.listEnabledStackRules('fetch')
  expect(fetch.map((r) => r.id)).toContain(fetchId)
  expect(fetch.map((r) => r.id)).not.toContain(allowId)
})

test('listEnabledRules 一次取三栈，kind 原样带出', async () => {
  const store = createPolicyStore(pool)
  const archiveId = await insertRule({
    kind: 'archive', priority: 10, assetTypes: [], effect: '/nas/meetings/{年}/',
  })

  const all = await store.listEnabledRules()
  const row = all.find((r) => r.id === archiveId)
  expect(row).toBeDefined()
  expect(row?.kind).toBe('archive')
  expect(row?.effect).toBe('/nas/meetings/{年}/')
})

test('enabled = 0 的规则不返回', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 30, subjectType: 'program', subjectValue: 'prog-disabled',
    assetTypes: ['video'], effect: 'deny', enabled: 0,
  })
  const rules = await store.listEnabledStackRules('allow')
  expect(rules.map((r) => r.id)).not.toContain(id)
})

/**
 * 判定顺序的事实源是 stacks.ts 的 sortStackRules，不是 SQL。这里断言的是
 * 「SQL 读出来的顺序已经与它一致」——两处一致才让 DB 里翻出来的规则表
 * 与管理员在控制台看到的判定顺序对得上。真正的判定顺序仍由引擎负责。
 */
test('SQL 的读出顺序与 sortStackRules 一致：priority 降序、同 priority 按 id 升序', async () => {
  const store = createPolicyStore(pool)
  const low = await insertRule({
    kind: 'fetch', priority: 5, assetTypes: ['*'], effect: 'all', note: 'low-pri',
  })
  const highFirst = await insertRule({
    kind: 'fetch', priority: 90, assetTypes: ['*'], effect: 'all', note: 'high-1',
  })
  const highSecond = await insertRule({
    kind: 'fetch', priority: 90, assetTypes: ['*'], effect: 'all', note: 'high-2',
  })

  const rules = await store.listEnabledStackRules('fetch')
  const ids = rules.map((r) => r.id)
  expect(ids.indexOf(highFirst)).toBeLessThan(ids.indexOf(highSecond)) // 平局按 id 升序
  expect(ids.indexOf(highSecond)).toBeLessThan(ids.indexOf(low)) // priority 降序
  expect(ids).toEqual(sortStackRules(rules).map((r) => r.id))
})

test('JSON 列往返：conds 与 assetTypes 解析为数组，中文与 emoji 不失真', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow',
    priority: 40,
    join: 'or',
    conds: [
      { f: 'title', op: 'has', v: '季度评审 🎉' },
      { f: 'host', op: 'is', v: 'tm-alice' },
    ],
    subjectType: 'program',
    subjectValue: 'prog-json',
    assetTypes: ['video', 'audio'],
    effect: 'allow',
    note: '中文说明 🎉',
    createdBy: 'admin-1',
  })

  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  expect(rule).toBeDefined()
  expect(rule?.join).toBe('or')
  expect(rule?.conds).toEqual([
    { f: 'title', op: 'has', v: '季度评审 🎉' },
    { f: 'host', op: 'is', v: 'tm-alice' },
  ])
  expect(rule?.assetTypes).toEqual(['video', 'audio'])
  expect(rule?.note).toBe('中文说明 🎉')
  expect(rule?.subjectType).toBe('program')
  expect(rule?.subjectValue).toBe('prog-json')
  expect(matchesRule(rule!, facts, 1_700_003_600)).toBe(true)
})

test('asset_types 存 ["*"] 时原样读出（展开成八类是引擎的事，不是 store 的）', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 50, subjectType: 'program', subjectValue: 'prog-star',
    assetTypes: ['*'], effect: 'allow',
  })
  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  expect(rule?.assetTypes).toEqual(['*'])
})

test('fetch / archive 栈的空主体读出来是 null，不是空串', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({ kind: 'archive', priority: 60, assetTypes: [], effect: 'skip' })
  const rule = (await store.listEnabledStackRules('archive')).find((r) => r.id === id)
  expect(rule?.subjectType).toBeNull()
  expect(rule?.subjectValue).toBeNull()
})

test('note 没填时读出 null（与空说明是两回事，判定理由的措辞也不同）', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 70, subjectType: 'program', subjectValue: 'prog-nonote',
    assetTypes: ['*'], effect: 'allow', note: null,
  })
  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  expect(rule?.note).toBeNull()
})

/**
 * conds 是无 schema 校验的 JSON 列，装得下对象、数字、字符串。
 * **它读出来绝不能变成一个空数组**——空 conds 在求值器里是「匹配一切」，
 * 一条形状坏掉的规则会因此变成放行全部会议的兜底规则。
 */
test('conds 不是数组时不会被当成「匹配一切」', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 80, subjectType: 'program', subjectValue: 'prog-badconds',
    condsRaw: JSON.stringify({ f: 'title', op: 'has', v: '评审' }),
    assetTypes: ['*'], effect: 'allow',
  })
  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  expect(rule).toBeDefined()
  expect(Array.isArray(rule?.conds)).toBe(false)
  expect(matchesRule(rule!, facts, 1_700_003_600)).toBe(false)
})

/**
 * join_op 是脏数据时 store **不悄悄改成 'and'**：求值器本来就把认不出的连接词
 * 当「且」处理，但静态检查（describeRuleIssues）要能报出「连接词不认识」。
 * store 一旦归一化，管理员在规则列表里就再也看不见这个错。
 */
test('join_op 是脏数据时原样带出，交给静态检查报给管理员', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 85, join: 'xor', subjectType: 'program', subjectValue: 'prog-badjoin',
    assetTypes: ['*'], effect: 'allow',
  })
  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  // 类型上 join 是 'and' | 'or'，这里断言的正是「脏数据穿过了类型」这件事本身
  expect(rule?.join as string | undefined).toBe('xor')
})
