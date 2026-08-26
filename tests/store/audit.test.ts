import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import {
  AUDIT_DETAIL_MAX_CHARS,
  AUDIT_MAX_LIMIT,
  buildAuditDetail,
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
    detail: null,
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

// ── detail（阶段 4 · T15）────────────────────────────────────────────────
//
// migrations/008 把 audit_log.detail 加了出来，但它只负责让那一列存在，没有改任何
// 写入方。这一组用例盯的是「写入方真的用上了它」，以及它的两条硬边界：
// **有明确上限且超限留痕**、**绝不因为组装明细而丢掉整行审计**。

/** 直接查 detail 列。上面的 findByActor 用的是 detail 出现之前的那份列清单，
 *  故意不动它——那份查询顺带证明了老读法在加列之后仍然成立 */
async function detailByActor(actorId: string): Promise<Array<string | null>> {
  interface DetailRow extends RowDataPacket {
    detail: string | null
  }
  const [rows] = await pool.execute<DetailRow[]>(
    `SELECT detail FROM audit_log WHERE actor_id = ? ORDER BY id`,
    [actorId],
  )
  return rows.map((r) => r.detail)
}

test('detail 落库并原样读回：长文不再被 asset_id 的 255 字符逼着截断', async () => {
  const store = createAuditStore(pool)
  const actorId = 'actor-detail-1'
  const long = buildAuditDetail({
    text: '修改规则 #12：conds',
    data: { conds: Array.from({ length: 120 }, (_, i) => ({ f: 'title', op: 'has', v: `关键词-${i}` })) },
  })
  // 前提：这段明细在旧的 asset_id(255) / asset_type(64) 两列里都装不下
  expect([...long].length).toBeGreaterThan(255)

  await store.record(baseEntry({ actorId, detail: long }))

  expect(await detailByActor(actorId)).toEqual([long])
  const page = await store.query({ actorId })
  expect(page.rows[0]!.detail).toBe(long)
})

test('detail 为 NULL 的既有记录照样读得出来——库里已经有真实数据', async () => {
  const store = createAuditStore(pool)
  const actorId = 'actor-legacy-detail'
  // 按 detail 列出现之前的列清单插一行，模拟库里那些既有记录
  await pool.execute(
    `INSERT INTO audit_log
       (occurred_at, actor_type, actor_id, action, meeting_id, asset_id, asset_type,
        decision, matched_rule, client_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1000, 'wecom_user', actorId, 'login', null, null, 'wecom_exchange_failed', 'deny', null, null],
  )

  const page = await store.query({ actorId })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]!.detail).toBeNull()
  // 老记录把明细塞在 asset_type 上，那一列必须原样带出来，否则那些记录的明细
  // 会在界面上凭空消失
  expect(page.rows[0]!.assetType).toBe('wecom_exchange_failed')
})

test('listForMeeting 也带出 detail', async () => {
  const store = createAuditStore(pool)
  const detail = buildAuditDetail({ text: '延长保留 30 天' })
  await store.record(
    baseEntry({ actorId: 'actor-detail-history', meetingId: 'mtg-detail-1', occurredAt: 5000, detail }),
  )
  const rows = await store.listForMeeting('mtg-detail-1', { since: 1 })
  expect(rows.map((r) => r.detail)).toEqual([detail])
})

test('buildAuditDetail：第一行是人话，结构化附文跟在后面', () => {
  const data = { was: { enabled: true }, now: { enabled: false } }
  const d = buildAuditDetail({ text: '停用规则 #9', data })
  const [first, ...rest] = d.split('\n')
  expect(first).toBe('停用规则 #9')
  expect(JSON.parse(rest.join('\n'))).toEqual(data)
})

test('buildAuditDetail：text 里的换行被压平，「第一行是人话」这条约定不会被内容破坏', () => {
  const d = buildAuditDetail({ text: '第一句\n第二句\r\n第三句' })
  expect(d).toBe('第一句 第二句 第三句')
})

test('buildAuditDetail 超上限时截断并留痕，不把截断从一列偷偷挪到另一列', () => {
  const d = buildAuditDetail({ text: '删除规则 #1', data: { note: '甲'.repeat(AUDIT_DETAIL_MAX_CHARS) } })
  expect([...d].length).toBe(AUDIT_DETAIL_MAX_CHARS)
  // 人话在头部，先被保住；截断这件事本身写在结尾，读的人看得见
  expect(d.startsWith('删除规则 #1')).toBe(true)
  expect(d).toContain('已截断')
  expect(d).toContain(String(AUDIT_DETAIL_MAX_CHARS))
})

test('buildAuditDetail 撞上序列化不了的附文时不抛，留一句说明', () => {
  const circular: Record<string, unknown> = { name: '环' }
  circular.self = circular
  const d = buildAuditDetail({ text: '新建规则', data: circular })
  expect(d.split('\n')[0]).toBe('新建规则')
  expect(d).toContain('附文序列化失败')

  // toJSON 自己抛、BigInt——JSON.stringify 会抛的另外两类
  expect(() => buildAuditDetail({ text: '改规则', data: { toJSON() { throw new Error('炸') } } })).not.toThrow()
  expect(() => buildAuditDetail({ text: '改规则', data: { n: 1n } })).not.toThrow()
})

/** 「第 11 个占位符（detail）满足 fail 时这次 execute 抛错」的假池。
 *  用假池而不是真灌一段超长文本：真库抛不抛取决于 sql_mode 是否严格，
 *  而这条用例要验的是「抛了之后我们怎么办」，不该被环境配置左右。 */
function flakyPool(fail: (detail: unknown) => boolean): { pool: Pool; details: unknown[] } {
  const details: unknown[] = []
  const pool = {
    async execute(_sql: string, params: unknown[]) {
      const detail = params[10]
      details.push(detail)
      if (fail(detail)) throw new Error("Data too long for column 'detail' at row 1")
      return [[], []]
    },
  } as unknown as Pool
  return { pool, details }
}

/** console.error 的噪声挡掉，同时把它收下来断言「降级留了声」——不能静默 */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  }
  try {
    await fn()
  } finally {
    console.error = original
  }
  return lines
}

test('record：detail 写不进去时退一步保住整行，并把「明细丢了」留在记录里', async () => {
  const { pool: flaky, details } = flakyPool((d) => typeof d === 'string' && d.length > 100)
  const store = createAuditStore(flaky)

  const warnings = await captureErrors(async () => {
    // 不许抛：audit_log 是数据出境的唯一账本（spec §1.4 / §4.10），
    // 丢一整行远比丢一段明细严重
    await store.record(baseEntry({ detail: 'x'.repeat(500) }))
  })

  expect(details).toHaveLength(2)
  expect(String(details[1])).toContain('明细未能写入')
  expect(warnings.join('\n')).toContain('audit')
})

test('record：与 detail 无关的写入失败照样往上抛，不被降级掩盖', async () => {
  const { pool: dead } = flakyPool(() => true)
  const store = createAuditStore(dead)

  await expect(store.record(baseEntry({ detail: null }))).rejects.toThrow('Data too long')
  await captureErrors(async () => {
    // 带 detail 时会重试一次；重试也失败就没什么可退的了，如实往上抛
    await expect(store.record(baseEntry({ detail: '一句话' }))).rejects.toThrow('Data too long')
  })
})
