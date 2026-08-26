import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import {
  AUDIT_MAX_LIMIT,
  buildAuditQuerySql,
  createAuditStore,
  type AuditEntry,
} from '../../src/store/audit'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

/** EXPLAIN 的一行。只用到判计划的这三列 */
interface PlanRow extends RowDataPacket {
  key: string | null
  type: string
  Extra: string | null
}

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

// ───────────────────────────────────────────────────────────────────────────
// 读侧（阶段 4 · T3）
//
// 整个文件共享同一个测试库，上面的写侧用例已经往 audit_log 写过几行，因此下面
// 每个用例都把自己的记录写进一段**互不重叠的时间窗**，断言时用 from/to 圈住
// 自己那几行——否则以后加一个写侧用例就会让读侧用例的计数变。
// ───────────────────────────────────────────────────────────────────────────

const WINDOW_SPAN = 1_000_000
let nextWindowStart = 2_000_000_000_000

function newWindow(): { from: number; to: number; at: (offset: number) => number } {
  const from = nextWindowStart
  nextWindowStart += WINDOW_SPAN
  return { from, to: from + WINDOW_SPAN, at: (offset) => from + offset }
}

/** meeting_cache 是 meeting_record_id → meeting_id 的唯一映射来源，
 *  listForMeeting 靠它把两种语义的 meeting_id 列合到一起 */
async function seedCache(meetingRecordId: string, meetingId: string): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_cache
       (meeting_record_id, meeting_id, sub_meeting_id, meeting_code, subject,
        host_user_id, start_time, end_time, state, updated_at)
     VALUES (?, ?, '', '', '', '', 0, 0, 'ended', 0)`,
    [meetingRecordId, meetingId],
  )
}

test('query 按时间倒序返回窗口内全部记录，total 是命中总数', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(baseEntry({ occurredAt: w.at(10), action: 'a1' }))
  await store.record(baseEntry({ occurredAt: w.at(30), action: 'a3' }))
  await store.record(baseEntry({ occurredAt: w.at(20), action: 'a2' }))

  const page = await store.query({ from: w.from, to: w.to })
  expect(page.total).toBe(3)
  expect(page.rows.map((r) => r.action)).toEqual(['a3', 'a2', 'a1'])
  expect(page.rows[0]?.id).toBeGreaterThan(0)
})

test('query 按 actorId 筛选', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(baseEntry({ occurredAt: w.at(10), actorId: 'q-actor-a' }))
  await store.record(baseEntry({ occurredAt: w.at(20), actorId: 'q-actor-b' }))

  const page = await store.query({ from: w.from, to: w.to, actorId: 'q-actor-a' })
  expect(page.total).toBe(1)
  expect(page.rows[0]?.actorId).toBe('q-actor-a')
})

test('query 按 actorType 多选筛选（人和程序混在同一条流里，界面要能只看一类）', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(baseEntry({ occurredAt: w.at(10), actorType: 'wecom_user' }))
  await store.record(baseEntry({ occurredAt: w.at(20), actorType: 'service_account' }))
  await store.record(baseEntry({ occurredAt: w.at(30), actorType: 'admin' }))

  const page = await store.query({
    from: w.from,
    to: w.to,
    actorTypes: ['service_account', 'admin'],
  })
  expect(page.total).toBe(2)
  expect(page.rows.map((r) => r.actorType)).toEqual(['admin', 'service_account'])
})

test('query 按 action 多选筛选', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(baseEntry({ occurredAt: w.at(10), action: 'login' }))
  await store.record(baseEntry({ occurredAt: w.at(20), action: 'issue_download_url' }))
  await store.record(baseEntry({ occurredAt: w.at(30), action: 'list_meetings' }))

  const page = await store.query({
    from: w.from,
    to: w.to,
    actions: ['login', 'list_meetings'],
  })
  expect(page.rows.map((r) => r.action)).toEqual(['list_meetings', 'login'])
})

test('query decision=deny 单独筛出，且 matchedRuleId 一并带出（拒绝原因由这两列组织）', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(baseEntry({ occurredAt: w.at(10), decision: 'allow', matchedRuleId: 3 }))
  await store.record(baseEntry({ occurredAt: w.at(20), decision: 'deny', matchedRuleId: 9 }))

  const page = await store.query({ from: w.from, to: w.to, decision: 'deny' })
  expect(page.total).toBe(1)
  expect(page.rows[0]?.decision).toBe('deny')
  // spec §4.10 要求被拒绝的记录写明原因。audit_log 没有「原因」列，也不加：
  // decision + matchedRuleId 已经够前端组织出那句话。
  expect(page.rows[0]?.matchedRuleId).toBe(9)
})

test('query 的时间范围是半开区间 [from, to)', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(baseEntry({ occurredAt: w.from, action: 'on-from' }))
  await store.record(baseEntry({ occurredAt: w.from + 100, action: 'inside' }))
  await store.record(baseEntry({ occurredAt: w.from + 200, action: 'on-to' }))

  const page = await store.query({ from: w.from, to: w.from + 200 })
  expect(page.rows.map((r) => r.action)).toEqual(['inside', 'on-from'])
})

test('query 分页：limit/offset 切页，total 不随分页变', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  for (let i = 0; i < 5; i++) {
    await store.record(baseEntry({ occurredAt: w.at(i * 10), action: `p${i}` }))
  }

  const first = await store.query({ from: w.from, to: w.to, limit: 2 })
  expect(first.total).toBe(5)
  expect(first.rows.map((r) => r.action)).toEqual(['p4', 'p3'])

  const second = await store.query({ from: w.from, to: w.to, limit: 2, offset: 2 })
  expect(second.total).toBe(5)
  expect(second.rows.map((r) => r.action)).toEqual(['p2', 'p1'])
})

test('query 的空数组筛选返回零行，不是「不筛选」', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(baseEntry({ occurredAt: w.at(10) }))

  const page = await store.query({ from: w.from, to: w.to, actions: [] })
  expect(page.total).toBe(0)
  expect(page.rows).toHaveLength(0)
})

test('query 的 limit 被钳制在上限内', () => {
  const { sql } = buildAuditQuerySql({ limit: 10_000 })
  expect(sql).toContain(`LIMIT ${AUDIT_MAX_LIMIT}`)
})

test('query 的 limit 不是整数时当场抛错，不悄悄换成默认值', async () => {
  const store = createAuditStore(pool)
  await expect(store.query({ limit: 1.5 })).rejects.toThrow(/整数/)
})

test('listForMeeting 同时匹配 meeting_id 与 issue_download_url 记录里的 meeting_record_id', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await seedCache('rec-hist-1', 'mtg-hist-1')
  await seedCache('rec-hist-2', 'mtg-hist-1')

  // 下载记录：meeting_id 列里存的是 record 维度 ID
  await store.record(
    baseEntry({ occurredAt: w.at(30), action: 'issue_download_url', meetingId: 'rec-hist-1' }),
  )
  await store.record(
    baseEntry({ occurredAt: w.at(20), action: 'issue_download_url', meetingId: 'rec-hist-2' }),
  )
  // 其余记录：meeting_id 列里存的就是 meeting_id
  await store.record(
    baseEntry({ occurredAt: w.at(10), action: 'grant_meeting', meetingId: 'mtg-hist-1' }),
  )

  const rows = await store.listForMeeting('mtg-hist-1', { since: w.from })
  expect(rows.map((r) => r.action)).toEqual([
    'issue_download_url',
    'issue_download_url',
    'grant_meeting',
  ])
  expect(rows.map((r) => r.meetingId)).toEqual(['rec-hist-1', 'rec-hist-2', 'mtg-hist-1'])
})

test('listForMeeting 不串场：别的会议的 record 记录不混进来', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await seedCache('rec-mine', 'mtg-mine')
  await seedCache('rec-theirs', 'mtg-theirs')

  await store.record(
    baseEntry({ occurredAt: w.at(10), action: 'issue_download_url', meetingId: 'rec-mine' }),
  )
  await store.record(
    baseEntry({ occurredAt: w.at(20), action: 'issue_download_url', meetingId: 'rec-theirs' }),
  )

  const rows = await store.listForMeeting('mtg-mine', { since: w.from })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.meetingId).toBe('rec-mine')
})

test('listForMeeting 在 meeting_cache 没有对应行时仍返回按 meeting_id 记的那些', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(
    baseEntry({ occurredAt: w.at(10), action: 'grant_meeting', meetingId: 'mtg-nocache' }),
  )

  const rows = await store.listForMeeting('mtg-nocache', { since: w.from })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.action).toBe('grant_meeting')
})

test('listForMeeting 的 since 是下界，早于它的不返回', async () => {
  const store = createAuditStore(pool)
  const w = newWindow()
  await store.record(baseEntry({ occurredAt: w.at(10), action: 'old', meetingId: 'mtg-since' }))
  await store.record(baseEntry({ occurredAt: w.at(50), action: 'new', meetingId: 'mtg-since' }))

  const rows = await store.listForMeeting('mtg-since', { since: w.at(50) })
  expect(rows.map((r) => r.action)).toEqual(['new'])
})

test('筛选查询走得上 idx_audit_time / idx_audit_actor，且不额外 filesort', async () => {
  // 优化器是按成本选计划的，几十行的表上它会直接全表扫。灌够行数这条断言才有意义。
  const values: unknown[] = []
  const placeholders: string[] = []
  const base = 3_000_000_000_000
  for (let i = 0; i < 400; i++) {
    placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    values.push(base + i * 1000, 'service_account', `plan-actor-${i % 40}`,
      'issue_download_url', `plan-m-${i % 20}`, null, null, 'allow', null, null)
  }
  await pool.query(
    `INSERT INTO audit_log
       (occurred_at, actor_type, actor_id, action, meeting_id, asset_id, asset_type,
        decision, matched_rule, client_kind)
     VALUES ${placeholders.join(', ')}`,
    values,
  )
  await pool.query('ANALYZE TABLE audit_log')

  const plan = async (q: Parameters<typeof buildAuditQuerySql>[0]): Promise<PlanRow> => {
    const built = buildAuditQuerySql(q)
    const [rows] = await pool.query<PlanRow[]>(`EXPLAIN ${built.sql}`, built.params)
    return rows[0]!
  }

  const byTime = await plan({ from: base, to: base + 20_000 })
  expect(byTime.key).toBe('idx_audit_time')
  expect(byTime.Extra ?? '').not.toContain('filesort')

  const byActor = await plan({ actorId: 'plan-actor-3' })
  expect(byActor.key).toBe('idx_audit_actor')
  expect(byActor.Extra ?? '').not.toContain('filesort')

  const byActorAndTime = await plan({ actorId: 'plan-actor-3', from: base, to: base + 20_000 })
  expect(byActorAndTime.key).toBe('idx_audit_actor')
  expect(byActorAndTime.Extra ?? '').not.toContain('filesort')
})
