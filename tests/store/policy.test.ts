import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createPolicyStore } from '../../src/store/policy'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

async function insertRule(opts: {
  priority: number
  subjectType: string
  subjectValue: string
  resourceExpr: Record<string, unknown>
  assetTypes: string[]
  effect: string
  enabled: number
}): Promise<void> {
  await pool.execute(
    `INSERT INTO policy_rules
       (priority, subject_type, subject_value, resource_expr, asset_types, effect, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.priority,
      opts.subjectType,
      opts.subjectValue,
      JSON.stringify(opts.resourceExpr),
      JSON.stringify(opts.assetTypes),
      opts.effect,
      opts.enabled,
      0,
      0,
    ],
  )
}

test('按 priority 升序返回', async () => {
  const store = createPolicyStore(pool)
  await insertRule({
    priority: 20,
    subjectType: 'user',
    subjectValue: 'tm-second',
    resourceExpr: {},
    assetTypes: ['video'],
    effect: 'allow',
    enabled: 1,
  })
  await insertRule({
    priority: 5,
    subjectType: 'user',
    subjectValue: 'tm-first',
    resourceExpr: {},
    assetTypes: ['video'],
    effect: 'allow',
    enabled: 1,
  })

  const rules = await store.listEnabledRules()
  expect(rules.length).toBeGreaterThanOrEqual(2)
  const priorities = rules.map((r) => r.priority)
  expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
  expect(rules[0]?.subjectValue).toBe('tm-first')
  expect(rules[1]?.subjectValue).toBe('tm-second')
})

test('enabled = 0 的规则不返回', async () => {
  const store = createPolicyStore(pool)
  await insertRule({
    priority: 30,
    subjectType: 'user',
    subjectValue: 'tm-disabled',
    resourceExpr: {},
    assetTypes: ['video'],
    effect: 'deny',
    enabled: 0,
  })

  const rules = await store.listEnabledRules()
  expect(rules.some((r) => r.subjectValue === 'tm-disabled')).toBe(false)
})

test('JSON 列往返：resourceExpr 与 assetTypes 解析为对象与数组', async () => {
  const store = createPolicyStore(pool)
  await insertRule({
    priority: 40,
    subjectType: 'user',
    subjectValue: 'tm-json',
    resourceExpr: { host_userid: 'tm-alice' },
    assetTypes: ['video', 'audio'],
    effect: 'allow',
    enabled: 1,
  })

  const rules = await store.listEnabledRules()
  const rule = rules.find((r) => r.subjectValue === 'tm-json')
  expect(rule).toBeDefined()
  expect(rule?.resourceExpr).toEqual({ host_userid: 'tm-alice' })
  expect(Array.isArray(rule?.assetTypes)).toBe(true)
  expect(rule?.assetTypes).toEqual(['video', 'audio'])
})

test('asset_types 存 ["*"] 时正确读出通配', async () => {
  const store = createPolicyStore(pool)
  await insertRule({
    priority: 50,
    subjectType: 'role',
    subjectValue: 'admin',
    resourceExpr: {},
    assetTypes: ['*'],
    effect: 'allow',
    enabled: 1,
  })

  const rules = await store.listEnabledRules()
  const rule = rules.find((r) => r.subjectValue === 'admin')
  expect(rule?.assetTypes).toEqual(['*'])
})

test('resource_expr 含中文值时正确往返（utf8mb4）', async () => {
  const store = createPolicyStore(pool)
  await insertRule({
    priority: 60,
    subjectType: 'department',
    subjectValue: 'dept-研发部',
    resourceExpr: { subject_contains: '季度评审 🎉' },
    assetTypes: ['meeting_summary'],
    effect: 'allow',
    enabled: 1,
  })

  const rules = await store.listEnabledRules()
  const rule = rules.find((r) => r.subjectValue === 'dept-研发部')
  expect(rule).toBeDefined()
  expect(rule?.resourceExpr).toEqual({ subject_contains: '季度评审 🎉' })
})
