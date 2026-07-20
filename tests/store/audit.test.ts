import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createAuditStore, type AuditEntry } from '../../src/store/audit'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

interface AuditRow extends RowDataPacket {
  occurred_at: number
  actor_type: string
  actor_id: string
  action: string
  meeting_id: string | null
  asset_id: string | null
  asset_type: string | null
  decision: string
  matched_rule: number | null
  client_kind: string | null
}

/** AuditStore 只暴露 record()，验证落库结果时直接查表，与 store 层无 mock 的原则一致 */
async function findByActor(actorId: string): Promise<AuditRow[]> {
  const [rows] = await pool.execute<AuditRow[]>(
    `SELECT occurred_at, actor_type, actor_id, action, meeting_id, asset_id, asset_type,
            decision, matched_rule, client_kind
       FROM audit_log
      WHERE actor_id = ?
      ORDER BY occurred_at DESC`,
    [actorId],
  )
  return rows
}

function baseEntry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    occurredAt: 1000,
    actorType: 'wecom_user',
    actorId: 'actor-default',
    action: 'download',
    meetingId: 'meeting-1',
    assetId: 'asset-1',
    assetType: 'video',
    decision: 'allow',
    matchedRuleId: 1,
    clientKind: 'web',
    ...overrides,
  }
}

test('写入后可按时间倒序查出', async () => {
  const store = createAuditStore(pool)
  const actorId = 'actor-order-1'
  await store.record(baseEntry({ actorId, occurredAt: 1000, action: 'first' }))
  await store.record(baseEntry({ actorId, occurredAt: 2000, action: 'second' }))
  await store.record(baseEntry({ actorId, occurredAt: 1500, action: 'third' }))

  const rows = await findByActor(actorId)
  expect(rows.map((r) => r.action)).toEqual(['second', 'third', 'first'])
})

test('decision 为 deny 的记录同样落库', async () => {
  const store = createAuditStore(pool)
  const actorId = 'actor-deny-1'
  await store.record(baseEntry({ actorId, decision: 'deny', matchedRuleId: 7 }))

  const rows = await findByActor(actorId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.decision).toBe('deny')
  expect(rows[0]?.matched_rule).toBe(7)
})

test('meetingId 等可空字段接受 null', async () => {
  const store = createAuditStore(pool)
  const actorId = 'actor-nullable-1'
  await store.record(
    baseEntry({
      actorId,
      meetingId: null,
      assetId: null,
      assetType: null,
      matchedRuleId: null,
      clientKind: null,
    }),
  )

  const rows = await findByActor(actorId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.meeting_id).toBeNull()
  expect(rows[0]?.asset_id).toBeNull()
  expect(rows[0]?.asset_type).toBeNull()
  expect(rows[0]?.matched_rule).toBeNull()
  expect(rows[0]?.client_kind).toBeNull()
})

test('中文 actor 名与主题正确往返（utf8mb4）', async () => {
  const store = createAuditStore(pool)
  const actorId = '张三'
  await store.record(baseEntry({ actorId, action: '导出季度评审纪要 🎉' }))

  const rows = await findByActor(actorId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.actor_id).toBe('张三')
  expect(rows[0]?.action).toBe('导出季度评审纪要 🎉')
})
