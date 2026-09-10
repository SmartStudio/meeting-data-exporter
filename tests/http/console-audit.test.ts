/**
 * T9 · A5 审计 API 的测试。
 *
 * 分两段，因为这个 handler 有两类风险，用同一种手法测其中一类必然测不到另一类：
 *
 * 1. **handler 自身的胶水**（参数校验、默认窗口、三色块映射、结果/理由的推导）
 *    用假的 `AuditQueryStore` 直接调 handler。这样才能断言「传给 store 的查询条件
 *    长什么样」——而这恰恰是本任务最容易出错的地方（默认窗口没传、actorTypes
 *    映成了空数组、limit 超限被静默钳制）。真库跑一遍只能看到「返回了 0 行」，
 *    看不出 0 行是因为库里没数据还是因为条件构造错了。
 * 2. **`createAuditMeetingLookup` 的 SQL**（批量补齐会议标题）走真实测试库。
 *    这一层的价值全在 SQL 语义里（IN 占位符、两张表的两种 ID 维度、空集合不发查询），
 *    mock 掉等于没测。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  listAudit,
  meetingHistory,
  createAuditMeetingLookup,
  actorKindOf,
  actorTypesForKinds,
  AUDIT_ACTOR_KIND_BY_TYPE,
  AUDIT_DEFAULT_WINDOW_DAYS,
  type AuditMeetingLookup,
} from '../../src/http/handlers/console/audit'
import { AUDIT_MAX_LIMIT, AUDIT_MEETING_HISTORY_LIMIT } from '../../src/store/audit'
import type { AuditQuery, AuditQueryStore, AuditRecord, MeetingHistoryOptions } from '../../src/store/audit'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AppDeps, RouteCtx } from '../../src/http/router'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp } from './testApp'

const NOW = 1_756_000_000
const DAY = 86_400
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }

function fakeAdminAuth(): AdminAuth {
  return {
    async authenticate() { throw new Error('not stubbed') },
    async hashPassword() { throw new Error('not stubbed') },
    async issueSession() { throw new Error('not stubbed') },
    async verifySession() { return ADMIN },
    async revokeSession() { throw new Error('not stubbed') },
    async revokeAllSessionsFor() { throw new Error('not stubbed') },
    async revokeOtherSessionsFor() { throw new Error('not stubbed') },
  }
}

function record(o: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 1,
    occurredAt: NOW - 60,
    actorType: 'service_account',
    actorId: 'svc-1',
    action: 'issue_download_url',
    meetingId: 'm-1',
    assetId: 'rec-1:file-1:video:0',
    assetType: 'video',
    decision: 'allow',
    matchedRuleId: null,
    clientKind: 'cli',
    detail: null,
    ...o,
  }
}

interface Spy {
  queries: AuditQuery[]
  historyCalls: Array<{ meetingId: string; opts: MeetingHistoryOptions | undefined }>
  resolveCalls: string[][]
}

function fakeCtx(opts: {
  rows?: AuditRecord[]
  total?: number
  historyRows?: AuditRecord[]
  objects?: Map<string, ReturnType<typeof objectRef>>
  meeting?: Awaited<ReturnType<AuditMeetingLookup['findMeeting']>>
}): { ctx: RouteCtx; spy: Spy } {
  const spy: Spy = { queries: [], historyCalls: [], resolveCalls: [] }

  const auditQuery: AuditQueryStore = {
    async query(q = {}) {
      spy.queries.push(q)
      return { rows: opts.rows ?? [], total: opts.total ?? (opts.rows?.length ?? 0) }
    },
    async listForMeeting(meetingId, o) {
      spy.historyCalls.push({ meetingId, opts: o })
      return opts.historyRows ?? []
    },
  }

  const auditMeetings: AuditMeetingLookup = {
    async resolveObjects(ids) {
      spy.resolveCalls.push([...ids])
      return opts.objects ?? new Map()
    },
    async findMeeting() {
      return opts.meeting ?? null
    },
  }

  // 管理员账号表：审计行里的 actor_id 是账号 uuid，读侧要把它换成人名
  // （抽屉里每行原来都以一串 35e7d5ad-… 开头，占掉大半行宽还每行都一样）。
  // 这里给两个真账号 + 一个查不到的：查不到时读侧必须退回显示 id，
  // **不许拿 id 冒充人名**。
  const adminStore = {
    findById: async (id: string) =>
      id === 'admin-1'
        ? { id, username: '陈运维', role: 'admin' }
        : id === 'admin-2'
          ? { id, username: '邹研发', role: 'admin' }
          : null,
  }
  const deps = {
    now: () => NOW,
    adminAuth: fakeAdminAuth(),
    adminStore,
    auditQuery,
    auditMeetings,
  } as unknown as AppDeps

  return { ctx: { params: {}, deps }, spy }
}

function objectRef(o: Partial<{ id: string; idKind: string; meetingId: string | null; title: string | null; code: string | null }> = {}) {
  return {
    id: o.id ?? 'm-1',
    idKind: (o.idKind ?? 'meeting') as 'meeting' | 'meeting_record' | 'unknown',
    meetingId: o.meetingId ?? 'm-1',
    title: o.title ?? '周会',
    code: o.code ?? '123-456',
  }
}

function req(path: string): Request {
  return new Request(`https://gw.example${path}`, {
    headers: { cookie: 'mde_admin_session=session-token' },
  })
}

// ---------------------------------------------------------------- 映射表本身

test('三色块映射是一份表：正反两个方向由同一份数据推出', () => {
  expect(actorKindOf('service_account')).toBe('prog')
  expect(actorKindOf('wecom_user')).toBe('person')
  expect(actorKindOf('admin')).toBe('person')
  // 认不出的 actor_type 不塞进三色块里的任何一个——塞哪个都是编
  expect(actorKindOf('something_new')).toBe('unknown')

  expect(actorTypesForKinds(['prog']).sort()).toEqual(['service_account'])
  expect(actorTypesForKinds(['person']).sort()).toEqual(['admin', 'wecom_user'])
  // 反向映射必须从同一份表推出来，不能另抄一份
  for (const [type, kind] of Object.entries(AUDIT_ACTOR_KIND_BY_TYPE)) {
    expect(actorTypesForKinds([kind])).toContain(type)
  }
})

// ---------------------------------------------------------------- 列表端点

test('未登录返回 401，且一次库都不查', async () => {
  const { ctx, spy } = fakeCtx({})
  const res = await listAudit(new Request('https://gw.example/api/v1/admin/audit'), ctx)
  expect(res.status).toBe(401)
  expect(spy.queries).toEqual([])
})

test('不给时间范围时用默认窗口，且窗口在响应里看得见', async () => {
  const { ctx, spy } = fakeCtx({ rows: [record()] })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  expect(res.status).toBe(200)

  // 传给 store 的下界必须是「秒」量纲的 now - 7 天。给成毫秒会算出一个负数，
  // 等于没有下界（全索引扫），而响应里还写着"最近 7 天"。
  expect(spy.queries[0]?.from).toBe(NOW - AUDIT_DEFAULT_WINDOW_DAYS * DAY)

  const body = await res.json() as { window: { from: number; to: number | null; isDefault: boolean; days: number; text: string | null } }
  expect(body.window.isDefault).toBe(true)
  expect(body.window.from).toBe(NOW - AUDIT_DEFAULT_WINDOW_DAYS * DAY)
  expect(body.window.days).toBe(AUDIT_DEFAULT_WINDOW_DAYS)
  // 看不见的默认窗口会让管理员把"这 7 天之外"读成"没有操作"
  expect(body.window.text).toContain(String(AUDIT_DEFAULT_WINDOW_DAYS))
})

test('显式 from/to 原样透传，且响应标明不是默认窗口', async () => {
  const { ctx, spy } = fakeCtx({})
  const res = await listAudit(req(`/api/v1/admin/audit?from=${NOW - 90 * DAY}&to=${NOW}`), ctx)
  expect(res.status).toBe(200)
  expect(spy.queries[0]?.from).toBe(NOW - 90 * DAY)
  expect(spy.queries[0]?.to).toBe(NOW)

  const body = await res.json() as { window: { isDefault: boolean; text: string | null } }
  expect(body.window.isDefault).toBe(false)
  expect(body.window.text).toBeNull()
})

test('只给 from 时不再补默认下界（管理员已经自己划了范围）', async () => {
  const { ctx, spy } = fakeCtx({})
  await listAudit(req(`/api/v1/admin/audit?from=${NOW - 90 * DAY}`), ctx)
  expect(spy.queries[0]?.from).toBe(NOW - 90 * DAY)
  expect(spy.queries[0]?.to).toBeUndefined()
})

test('只给 to 时补的下界是相对 to 的，不是相对 now', async () => {
  const { ctx, spy } = fakeCtx({})
  const to = NOW - 30 * DAY
  await listAudit(req(`/api/v1/admin/audit?to=${to}`), ctx)
  // 相对 now 补下界的话，from 会大于 to，结果恒为空——"这段时间没有操作"的假象
  expect(spy.queries[0]?.from).toBe(to - AUDIT_DEFAULT_WINDOW_DAYS * DAY)
  expect(spy.queries[0]?.to).toBe(to)
})

test('from >= to 直接拒绝，不返回一个必然为空的结果集', async () => {
  const { ctx, spy } = fakeCtx({})
  const res = await listAudit(req(`/api/v1/admin/audit?from=${NOW}&to=${NOW - DAY}`), ctx)
  expect(res.status).toBe(400)
  expect((await res.json() as { error: string }).error).toBe('invalid_time_range')
  expect(spy.queries).toEqual([])
})

test('actorKind 映射成库里的原值传给 store', async () => {
  const { ctx, spy } = fakeCtx({})
  await listAudit(req('/api/v1/admin/audit?actorKind=prog'), ctx)
  expect(spy.queries[0]?.actorTypes).toEqual(['service_account'])

  const second = fakeCtx({})
  await listAudit(req('/api/v1/admin/audit?actorKind=prog,person'), second.ctx)
  expect([...(second.spy.queries[0]?.actorTypes ?? [])].sort()).toEqual(
    ['admin', 'service_account', 'wecom_user'],
  )
})

test('认不出的 actorKind 是 400，不是一次静默的零行', async () => {
  for (const bad of ['bogus', 'unknown', '']) {
    const { ctx, spy } = fakeCtx({})
    const res = await listAudit(req(`/api/v1/admin/audit?actorKind=${bad}`), ctx)
    expect(res.status).toBe(400)
    // 空数组传给 store 会如实返回零行，而管理员看到的是"这段时间没人操作过"
    expect(spy.queries).toEqual([])
  }
})

test('action 是空筛选时也拒绝', async () => {
  const { ctx, spy } = fakeCtx({})
  const res = await listAudit(req('/api/v1/admin/audit?action=,'), ctx)
  expect(res.status).toBe(400)
  expect(spy.queries).toEqual([])
})

test('action 支持逗号与重复参数两种写法', async () => {
  const { ctx, spy } = fakeCtx({})
  await listAudit(req('/api/v1/admin/audit?action=login,list_meetings&action=issue_download_url'), ctx)
  expect([...(spy.queries[0]?.actions ?? [])].sort()).toEqual(
    ['issue_download_url', 'list_meetings', 'login'],
  )
})

test('decision=deny 单独筛出被拒绝的记录', async () => {
  const { ctx, spy } = fakeCtx({})
  await listAudit(req('/api/v1/admin/audit?decision=deny'), ctx)
  expect(spy.queries[0]?.decision).toBe('deny')

  const bad = fakeCtx({})
  const res = await listAudit(req('/api/v1/admin/audit?decision=maybe'), bad.ctx)
  expect(res.status).toBe(400)
})

test('limit 超过上限当场说清楚，而不是被 store 静默钳制', async () => {
  const { ctx, spy } = fakeCtx({})
  const res = await listAudit(req(`/api/v1/admin/audit?limit=${AUDIT_MAX_LIMIT + 1}`), ctx)
  expect(res.status).toBe(400)
  const body = await res.json() as { error: string; max: number }
  expect(body.error).toBe('limit_too_large')
  expect(body.max).toBe(AUDIT_MAX_LIMIT)
  expect(spy.queries).toEqual([])
})

test('limit / offset 非整数或为负一律 400', async () => {
  for (const q of ['limit=abc', 'limit=0', 'limit=1.5', 'offset=-1', 'offset=x']) {
    const { ctx } = fakeCtx({})
    const res = await listAudit(req(`/api/v1/admin/audit?${q}`), ctx)
    expect(res.status).toBe(400)
  }
})

test('actorId 透传，limit/offset 回显在响应里', async () => {
  const { ctx, spy } = fakeCtx({ rows: [], total: 7 })
  const res = await listAudit(req('/api/v1/admin/audit?actorId=svc-1&limit=10&offset=20'), ctx)
  expect(spy.queries[0]?.actorId).toBe('svc-1')
  expect(spy.queries[0]?.limit).toBe(10)
  expect(spy.queries[0]?.offset).toBe(20)
  const body = await res.json() as { total: number; limit: number; offset: number }
  expect(body).toMatchObject({ total: 7, limit: 10, offset: 20 })
})

// ---------------------------------------------------------------- 行的形状

test('一行审计带齐 spec §4.10 的五个字段', async () => {
  const objects = new Map([['m-1', objectRef({ title: '产品周会', code: '123-456' })]])
  const { ctx } = fakeCtx({ rows: [record({ occurredAt: NOW - 300 })], objects })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<Record<string, unknown>> }
  const row = body.rows[0]!

  expect(row.at).toBe(NOW - 300)
  // `name` 只有管理员账号解析得出；采集程序不是账号，恒为 null
  expect(row.actor).toEqual({ kind: 'prog', type: 'service_account', id: 'svc-1', name: null })
  expect(row.action).toBe('issue_download_url')
  expect(row.actionLabel).toBe('签发下载链接')
  expect(row.object).toMatchObject({ title: '产品周会', code: '123-456' })
  expect(row.result).toMatchObject({ decision: 'allow', kind: 'allow', reason: null })
})

test('系统操作者 auto_grant 显示成「系统 · 自动授权」，不是笼统的「系统」', async () => {
  // 将来还会有别的系统操作者（到期清理、归档）。全叫「系统」会让一批本来分得开的
  // 记录读成同一个人干的，而「哪个系统动作改了这条授权」正是这一页要回答的问题
  const { ctx } = fakeCtx({
    rows: [
      record({
        actorType: 'system',
        actorId: 'auto_grant',
        action: 'auto_grant_meeting',
      }),
    ],
  })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = (await res.json()) as { rows: Array<{ actor: Record<string, unknown>; actionLabel: string | null }> }
  expect(body.rows[0]?.actor).toEqual({
    kind: 'sys',
    type: 'system',
    id: 'auto_grant',
    name: '系统 · 自动授权',
  })
  // 动作也读得懂——两件事各由一张表回答，缺一个界面上就有一半是英文
  expect(body.rows[0]?.actionLabel).toBe('系统按规则自动把一场会议授权给采集程序')
})

test('没登记的系统 actor_id 留 null，不编一个名字', async () => {
  // 编一个名字等于假装登记过，与 auditActionLabel 对没登记的动作回 null 同一个口径
  const { ctx } = fakeCtx({ rows: [record({ actorType: 'system', actorId: 'some_future_job' })] })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = (await res.json()) as { rows: Array<{ actor: { name: string | null } }> }
  expect(body.rows[0]?.actor.name).toBeNull()
})

test('认不出的 actor_type 走 unknown 色块，且原值照带', async () => {
  const { ctx } = fakeCtx({ rows: [record({ actorType: 'ghost', actorId: 'x' })] })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<{ actor: Record<string, unknown> }> }
  expect(body.rows[0]?.actor).toEqual({ kind: 'unknown', type: 'ghost', id: 'x', name: null })
})

test('认不出的 decision 既不算准许也不算拒绝', async () => {
  const { ctx } = fakeCtx({ rows: [record({ decision: 'maybe' })] })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<{ result: { decision: string; kind: string; reason: string | null } }> }
  expect(body.rows[0]?.result.decision).toBe('maybe')
  expect(body.rows[0]?.result.kind).toBe('unknown')
  expect(body.rows[0]?.result.reason).toContain('maybe')
})

test('拒绝理由只在能对回一条真实记录时才给', async () => {
  const withRule = fakeCtx({ rows: [record({ decision: 'deny', matchedRuleId: 7 })] })
  let body = await (await listAudit(req('/api/v1/admin/audit'), withRule.ctx)).json() as { rows: Array<{ result: { reason: string | null } }> }
  expect(body.rows[0]?.result.reason).toContain('#7')

  // 命中规则为 null、detail 也为 null 的拒绝：库里没有任何一列说得出原因，
  // 就不许编一句
  const noRule = fakeCtx({ rows: [record({ decision: 'deny', matchedRuleId: null })] })
  body = await (await listAudit(req('/api/v1/admin/audit'), noRule.ctx)).json() as { rows: Array<{ result: { reason: string | null } }> }
  expect(body.rows[0]?.result.reason).toBeNull()
})

// ---------------------------------------------------------------- detail（T15）

test('detail 原样带出，被拒绝的记录用它的第一行当拒绝原因（spec §4.10）', async () => {
  const detail = '采集权限 #7「财务放行」覆盖的资产类型是 ai_minutes，不含「video」'
  const { ctx } = fakeCtx({
    rows: [record({ decision: 'deny', matchedRuleId: 7, detail })],
  })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<{ detail: string | null; result: { reason: string | null } }> }
  expect(body.rows[0]?.detail).toBe(detail)
  // 拒绝原因取 detail 而不是 `命中规则 #7`：前者说得出「为什么这条不放行」，
  // 后者只说得出「命中了第几条」
  expect(body.rows[0]?.result.reason).toBe(detail)
})

test('detail 的附文不进拒绝原因——那一行是给机器看的 JSON，不是给人看的一句话', async () => {
  const detail = '修改规则 #12：改了 effect\n{"changed":["effect"],"before":{},"after":{}}'
  const { ctx } = fakeCtx({ rows: [record({ action: 'rule_update', decision: 'deny', detail })] })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<{ detail: string | null; result: { reason: string | null } }> }
  // 完整 detail 照带（前端要展开看快照）
  expect(body.rows[0]?.detail).toBe(detail)
  // 拒绝原因只取第一行
  expect(body.rows[0]?.result.reason).toBe('修改规则 #12：改了 effect')
})

test('detail 非空时，有 asset_id 的记录也读得到明细', async () => {
  // 授权类记录的 asset_id 是对象键（程序 id@场次），asset_type 为 null，
  // 明细在 detail 上。老的「asset_id 为空才算明细」判据在这里会漏掉整段明细
  const { ctx } = fakeCtx({
    rows: [record({ action: 'grant_meeting', assetId: 'svc-1@s-7', assetType: null, detail: '授权范围 ai_minutes' })],
  })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<{ asset: unknown; detail: string | null }> }
  expect(body.rows[0]?.asset).toEqual({ id: 'svc-1@s-7', type: null })
  expect(body.rows[0]?.detail).toBe('授权范围 ai_minutes')
})

test('detail 为 NULL 的既有记录仍按老读法取明细，不让它们的明细凭空消失', async () => {
  const row = record({
    action: 'login',
    decision: 'deny',
    assetId: null,
    assetType: 'wecom_exchange_failed',
    meetingId: null,
    actorType: 'wecom_user',
  })
  const { ctx } = fakeCtx({ rows: [row] })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<{ asset: unknown; detail: string | null; object: unknown; result: { reason: string | null } }> }
  expect(body.rows[0]?.asset).toBeNull()
  expect(body.rows[0]?.detail).toBe('wecom_exchange_failed')
  expect(body.rows[0]?.object).toBeNull()
  // 登录失败的原因就存在那一列里，这是那批老记录唯一的出处
  expect(body.rows[0]?.result.reason).toBe('wecom_exchange_failed')
})

test('detail 为 NULL 且带 asset_id 的既有记录：asset_type 仍是资产类型，不误当明细', async () => {
  // 老的下载记录：asset_id 是资产键，asset_type 真的是资产类型。
  // 回退判据必须只在「asset_id 为空」时生效，否则 video 会被显示成明细
  const { ctx } = fakeCtx({ rows: [record({ assetId: 'rec-1:f-1:video:0', assetType: 'video', detail: null })] })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<{ asset: unknown; detail: string | null }> }
  expect(body.rows[0]?.asset).toEqual({ id: 'rec-1:f-1:video:0', type: 'video' })
  expect(body.rows[0]?.detail).toBeNull()
})

test('对象补齐只发一次批量调用（不是逐行查）', async () => {
  const rows = [
    record({ id: 1, meetingId: 'm-1' }),
    record({ id: 2, meetingId: 'm-1' }),
    record({ id: 3, meetingId: 'rec-9' }),
    record({ id: 4, meetingId: null, action: 'login', assetId: null }),
  ]
  const { ctx, spy } = fakeCtx({ rows })
  await listAudit(req('/api/v1/admin/audit'), ctx)
  // 四行两个不同的对象 id：一页审计只允许换一次会议元数据。逐行查的话，
  // 一页 200 行就是 200 次往返，而审计页是管理员翻得最勤的一页。
  expect(spy.resolveCalls.length).toBe(1)
  // 去重是 resolveObjects 自己的事（它要拼 IN 占位符），这里只要求 id 一个不漏
  expect([...new Set(spy.resolveCalls[0])].sort()).toEqual(['m-1', 'rec-9'])
  // meeting_id 为 null 的记录（登录、列会议）不参与补齐
  expect(spy.resolveCalls[0]).not.toContain(null as unknown as string)
})

test('会议元数据查不到时对象只给 id，不编标题', async () => {
  const { ctx } = fakeCtx({ rows: [record({ meetingId: 'm-unknown' })], objects: new Map() })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as { rows: Array<{ object: { id: string; idKind: string; meetingId: string | null; title: string | null; code: string | null } }> }
  expect(body.rows[0]?.object).toEqual({
    id: 'm-unknown', idKind: 'unknown', meetingId: null, title: null, code: null,
  })
})

// ---------------------------------------------------------------- 会议历史端点

test('会议历史用这场会议的 start_time 当 since，并在响应里回显', async () => {
  const startAt = NOW - 40 * DAY
  const { ctx, spy } = fakeCtx({
    meeting: { id: 'm-1', title: '周会', code: '123-456', startAt, source: 'meetings' },
    historyRows: [record({ occurredAt: startAt + 60 })],
  })
  ctx.params = { meetingId: 'm-1' }
  const res = await meetingHistory(req('/api/v1/admin/meetings/m-1/history'), ctx)
  expect(res.status).toBe(200)

  // audit_log 上没有 meeting_id 索引，不给下界这条查询就是一次全索引扫
  expect(spy.historyCalls[0]?.opts?.since).toBe(startAt)
  const body = await res.json() as { window: { since: number | null; sinceSource: string; text: string | null }; meeting: unknown }
  expect(body.window.since).toBe(startAt)
  expect(body.window.sinceSource).toBe('meetings')
  expect(body.meeting).toMatchObject({ id: 'm-1', title: '周会' })
})

test('会议起始时间不明时不设下界，但把这件事写进响应', async () => {
  const { ctx, spy } = fakeCtx({ meeting: null, historyRows: [record()] })
  ctx.params = { meetingId: 'm-ghost' }
  const res = await meetingHistory(req('/api/v1/admin/meetings/m-ghost/history'), ctx)
  // 元数据缺失不能让审计历史消失——这是 404 与 200 的区别所在
  expect(res.status).toBe(200)
  expect(spy.historyCalls[0]?.opts?.since).toBeUndefined()
  const body = await res.json() as { meeting: unknown; rows: unknown[]; window: { since: number | null; sinceSource: string; text: string | null } }
  expect(body.meeting).toBeNull()
  expect(body.rows.length).toBe(1)
  expect(body.window.since).toBeNull()
  expect(body.window.sinceSource).toBe('none')
  expect(body.window.text).not.toBeNull()
})

test('会议历史的每一行都能当 { at, text } 用', async () => {
  const { ctx } = fakeCtx({
    meeting: { id: 'm-1', title: '周会', code: '1', startAt: NOW - DAY, source: 'meetings' },
    historyRows: [record({ decision: 'deny', matchedRuleId: 7, occurredAt: NOW - 100 })],
    objects: new Map([['m-1', objectRef()]]),
  })
  ctx.params = { meetingId: 'm-1' }
  const res = await meetingHistory(req('/api/v1/admin/meetings/m-1/history'), ctx)
  const body = await res.json() as { rows: Array<{ at: number; text: string }> }
  expect(body.rows[0]?.at).toBe(NOW - 100)
  expect(body.rows[0]?.text).toContain('拒绝')
  expect(body.rows[0]?.text).toContain('#7')
})

/**
 * 抽屉里那几十行「重复数据」（用户 2026-08-31 报的）。
 *
 * 查库之后：那一批行的 `detail` 各不相同——`content:index` / `content:chapters` /
 * `content:ai_minutes` / `content:transcript` / `media:video/…`，是这句话把唯一的
 * 区分字段丢了，十种事件在屏幕上长得一模一样。`detail` 后端一直在下发，只是
 * `describeRow` 没用它。
 */
test('同一场会议的不同查看，text 各不相同 —— 区分字段是 detail', async () => {
  const targets = ['content:index', 'content:chapters', 'content:ai_minutes', 'content:transcript']
  const { ctx } = fakeCtx({
    meeting: { id: 'm-1', title: '周会', code: '1', startAt: NOW - DAY, source: 'meetings' },
    historyRows: targets.map((t, i) =>
      record({
        id: i + 1,
        actorType: 'admin',
        actorId: 'admin-1',
        action: 'view_restricted_content',
        assetType: null,
        assetId: null,
        detail: `查看 ${t}\n{"target":"${t}"}`,
      }),
    ),
  })
  ctx.params = { meetingId: 'm-1' }
  const body = (await (await meetingHistory(req('/api/v1/admin/meetings/m-1/history'), ctx)).json()) as {
    rows: Array<{ text: string }>
  }
  const texts = body.rows.map((r) => r.text)
  expect(new Set(texts).size, `四次不同的查看渲染成了同一句话：${texts[0]}`).toBe(4)
  // 机器名翻成 spec §6.2 那张表上的中文（ASSET_LABEL 那一份，五类收拢之后是
  // 「纪要」「逐字稿」）；index / chapters 不是资产，是视图
  expect(texts.join(' ')).toContain('纪要')
  expect(texts.join(' ')).toContain('逐字稿')
  expect(texts.join(' ')).toContain('资产索引')
  expect(texts.join(' ')).toContain('时间轴')
  expect(texts.join(' '), '机器名不上屏').not.toContain('content:')
})

/**
 * 每行开头那串 uuid（`35e7d5ad-9d2d-4989-b437-4f72f733b72b`）占掉大半行宽、
 * 每行还都一样——它是用户把一列各不相同的记录读成「重复」的一半原因。
 * 换成人名；**查不到时退回显示 id，不许拿 id 冒充人名**（同 object 那一条：
 * 一个看着像名字的 id 会让人以为这个人就叫这个）。
 */
test('发起者显示人名，查不到才退回 id', async () => {
  const mk = async (actorId: string): Promise<string> => {
    const { ctx } = fakeCtx({
      meeting: { id: 'm-1', title: '周会', code: '1', startAt: NOW - DAY, source: 'meetings' },
      historyRows: [record({ actorType: 'admin', actorId, detail: null })],
    })
    ctx.params = { meetingId: 'm-1' }
    const b = (await (await meetingHistory(req('/api/v1/admin/meetings/m-1/history'), ctx)).json()) as {
      rows: Array<{ text: string; actor: { name: string | null } }>
    }
    return b.rows[0]!.text
  }
  expect(await mk('admin-1')).toContain('陈运维')
  expect(await mk('admin-1')).not.toContain('admin-1')
  // 账号已经删掉的历史记录：id 仍然是一条真线索，比留空强
  expect(await mk('admin-gone')).toContain('admin-gone')
})

/**
 * 认不出的 target 形状**原样带出**。将来新增一种 target，它会以机器名的样子
 * 出现在界面上——那正是它该有的样子：一个自己会喊的缺口，比悄悄显示成别的东西强
 * （同「未登记标签」那一条）。
 */
test('认不出的 target 原样带出，不吞掉也不编一个名字', async () => {
  const { ctx } = fakeCtx({
    meeting: { id: 'm-1', title: '周会', code: '1', startAt: NOW - DAY, source: 'meetings' },
    historyRows: [record({ actorType: 'admin', actorId: 'admin-1', detail: '查看 content:brand_new_kind' })],
  })
  ctx.params = { meetingId: 'm-1' }
  const b = (await (await meetingHistory(req('/api/v1/admin/meetings/m-1/history'), ctx)).json()) as {
    rows: Array<{ text: string }>
  }
  expect(b.rows[0]!.text).toContain('content:brand_new_kind')
})

/**
 * 被拒绝的记录里 detail 第一行**就是拒绝原因**（`buildAuditDetail` 的约定，
 * spec §4.10）。`result` 已经带着它，所以 deny 时不许再补一遍——那是同一句话
 * 在同一行里说两遍。
 */
test('deny 的行不把拒绝原因说两遍', async () => {
  const { ctx } = fakeCtx({
    meeting: { id: 'm-1', title: '周会', code: '1', startAt: NOW - DAY, source: 'meetings' },
    historyRows: [record({ decision: 'deny', matchedRuleId: 7, detail: '规则 #7 禁止采集' })],
  })
  ctx.params = { meetingId: 'm-1' }
  const b = (await (await meetingHistory(req('/api/v1/admin/meetings/m-1/history'), ctx)).json()) as {
    rows: Array<{ text: string }>
  }
  expect(b.rows[0]!.text.match(/规则 #7/g)?.length ?? 0).toBe(1)
})

test('会议历史的 limit 超过上限当场说清楚', async () => {
  const { ctx, spy } = fakeCtx({})
  ctx.params = { meetingId: 'm-1' }
  const res = await meetingHistory(req(`/api/v1/admin/meetings/m-1/history?limit=${AUDIT_MEETING_HISTORY_LIMIT + 1}`), ctx)
  expect(res.status).toBe(400)
  expect((await res.json() as { max: number }).max).toBe(AUDIT_MEETING_HISTORY_LIMIT)
  expect(spy.historyCalls).toEqual([])
})

test('会议历史未登录同样 401', async () => {
  const { ctx, spy } = fakeCtx({})
  ctx.params = { meetingId: 'm-1' }
  const res = await meetingHistory(new Request('https://gw.example/api/v1/admin/meetings/m-1/history'), ctx)
  expect(res.status).toBe(401)
  expect(spy.historyCalls).toEqual([])
})

// ---------------------------------------------------------------- 真库：批量补齐

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

async function insertMeeting(o: { meetingId: string; sub?: string; code?: string; subject?: string; startTime?: number | null }): Promise<void> {
  await pool.execute(
    `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid,
                           start_time, end_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.meetingId, o.sub ?? '', o.code ?? '000-000', o.subject ?? '会', 'host-1',
     o.startTime === undefined ? NOW : o.startTime, NOW + 3600, NOW, NOW],
  )
}

async function insertCache(o: { recordId: string; meetingId: string; code?: string; subject?: string; startTime?: number }): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_cache (meeting_record_id, meeting_id, sub_meeting_id, meeting_code,
                                subject, host_user_id, start_time, end_time, state, updated_at)
     VALUES (?, ?, '', ?, ?, 'host-1', ?, ?, 'completed', ?)`,
    [o.recordId, o.meetingId, o.code ?? '999-999', o.subject ?? '缓存里的会',
     o.startTime ?? NOW, NOW + 3600, NOW],
  )
}

test('resolveObjects：两种 ID 维度各自认得出，认不出的如实标 unknown', async () => {
  await insertMeeting({ meetingId: 'db-m1', code: '111-222', subject: '主表里的会' })
  await insertCache({ recordId: 'db-rec1', meetingId: 'db-m1', code: '111-222', subject: '缓存里的会' })

  const lookup = createAuditMeetingLookup(pool)
  const got = await lookup.resolveObjects(['db-m1', 'db-rec1', 'db-nope'])

  expect(got.get('db-m1')).toEqual({
    id: 'db-m1', idKind: 'meeting', meetingId: 'db-m1', title: '主表里的会', code: '111-222',
  })
  // action=issue_download_url 的记录里 meeting_id 列存的是 record 维度的 ID
  expect(got.get('db-rec1')).toEqual({
    id: 'db-rec1', idKind: 'meeting_record', meetingId: 'db-m1', title: '缓存里的会', code: '111-222',
  })
  expect(got.has('db-nope')).toBe(false)
})

test('resolveObjects：空集合不发查询（IN () 是语法错误）', async () => {
  const lookup = createAuditMeetingLookup(pool)
  expect((await lookup.resolveObjects([])).size).toBe(0)
  expect((await lookup.resolveObjects(['', ''])).size).toBe(0)
})

test('resolveObjects：周期性会议的多个场次只出一行', async () => {
  await insertMeeting({ meetingId: 'db-m2', sub: 's1', subject: '第一场', startTime: NOW - 2 * DAY })
  await insertMeeting({ meetingId: 'db-m2', sub: 's2', subject: '第二场', startTime: NOW - DAY })
  const lookup = createAuditMeetingLookup(pool)
  const got = await lookup.resolveObjects(['db-m2'])
  expect(got.size).toBe(1)
  // 取最早的一场，结果对同一批数据必须是确定的
  expect(got.get('db-m2')?.title).toBe('第一场')
})

test('findMeeting：主表优先，主表没有才退到缓存表', async () => {
  await insertMeeting({ meetingId: 'db-m3', subject: '主表', startTime: NOW - 10 * DAY })
  await insertCache({ recordId: 'db-rec3', meetingId: 'db-m3', subject: '缓存', startTime: NOW - 99 * DAY })
  const lookup = createAuditMeetingLookup(pool)

  expect(await lookup.findMeeting('db-m3')).toEqual({
    id: 'db-m3', title: '主表', code: '000-000', startAt: NOW - 10 * DAY, source: 'meetings',
  })

  await insertCache({ recordId: 'db-rec4', meetingId: 'db-m4', subject: '只在缓存里', startTime: NOW - 5 * DAY })
  expect(await lookup.findMeeting('db-m4')).toMatchObject({
    id: 'db-m4', title: '只在缓存里', startAt: NOW - 5 * DAY, source: 'meeting_cache',
  })

  expect(await lookup.findMeeting('db-nothing')).toBeNull()
})

test('findMeeting：主表的 start_time 可空，为空时退到缓存表而不是当成"无下界"', async () => {
  await insertMeeting({ meetingId: 'db-m5', subject: '没记开始时间', startTime: null })
  await insertCache({ recordId: 'db-rec5', meetingId: 'db-m5', subject: '缓存补上了', startTime: NOW - 7 * DAY })
  const lookup = createAuditMeetingLookup(pool)
  const got = await lookup.findMeeting('db-m5')
  expect(got?.startAt).toBe(NOW - 7 * DAY)
  // 标题仍以主表为准（E-a：meetings 是控制台主表）
  expect(got?.title).toBe('没记开始时间')
})

/**
 * 路由接线本身也要有人守。本文件其余用例都直接调 handler 函数，
 * 那样测不出「router.ts 里那两行路由被合并冲突吃掉了」——而 T9 与另外几个任务
 * 并行改的正是同一个 ROUTES 数组。404 与 401 的区别就是这一行在不在。
 */
test('两个端点在 router 里挂上了（未登录时是 401，不是 404）', async () => {
  const { app } = buildTestApp(pool)
  for (const path of ['/api/v1/admin/audit', '/api/v1/admin/meetings/m-1/history']) {
    const res = await app(new Request(`https://gw.example${path}`))
    expect(res.status).toBe(401)
  }
})

// ---------------------------------------------------- 动作标签（阶段 5 · A9）

/**
 * 这一族用例钉的是 A9 那条缺口：库里会出现 28 种动作，而读侧从前只登记了 3 种，
 * 于是「动作」那一列有 25 种记录显示成英文 snake_case。补齐之后要保证的是
 * **两件事同时成立**：登记过的有中文名；没登记过的**被点名**而不是被伪装。
 */

test('管理侧的动作也有中文名（不只是网关那三个）', async () => {
  const rows = [
    record({ id: 1, action: 'rule_toggle', actorType: 'admin', actorId: 'admin-1' }),
    record({ id: 2, action: 'view_restricted_content', actorType: 'admin', actorId: 'admin-1' }),
    record({ id: 3, action: 'extend_retention', actorType: 'admin', actorId: 'admin-1' }),
    record({ id: 4, action: 'create_admin_account', actorType: 'admin', actorId: 'admin-1' }),
  ]
  const { ctx } = fakeCtx({ rows })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as {
    rows: Array<{ action: string; actionLabel: string | null }>
    unlabeledActions: unknown[]
  }
  // 一行都不许是 null——这四个动作都在登记表里
  expect(body.rows.map((r) => r.actionLabel).filter((l) => l === null)).toEqual([])
  expect(body.rows[1]?.actionLabel).toContain('禁止采集')
  // 全都登记过时点名清单是空数组，不是 null（前端不必区分「没有」与「没算」）
  expect(body.unlabeledActions).toEqual([])
})

test('没登记标签的动作：actionLabel 是 null，并且在响应里被点名', async () => {
  const rows = [
    record({ id: 1, action: 'frobnicate' }),
    record({ id: 2, action: 'frobnicate' }),
    record({ id: 3, action: 'login' }),
  ]
  const { ctx } = fakeCtx({ rows })
  const res = await listAudit(req('/api/v1/admin/audit'), ctx)
  const body = await res.json() as {
    rows: Array<{ action: string; actionLabel: string | null }>
    unlabeledActions: Array<{ action: string; count: number; hint: string }>
  }
  // **不回退成 snake_case 原值**：回退等于假装登记过，漏登记就永远发现不了
  expect(body.rows[0]?.actionLabel).toBeNull()
  expect(body.rows[0]?.action).toBe('frobnicate')
  expect(body.unlabeledActions).toEqual([
    { action: 'frobnicate', count: 2, hint: expect.stringContaining('没有登记') },
  ])
})

test('会议历史那句现成的话在动作没登记时说出来，而不是原样塞进去', async () => {
  const { ctx } = fakeCtx({
    meeting: { id: 'm-1', title: '周会', code: '1', startAt: NOW - DAY, source: 'meetings' },
    historyRows: [record({ action: 'frobnicate', occurredAt: NOW - 100 })],
    objects: new Map([['m-1', objectRef()]]),
  })
  ctx.params = { meetingId: 'm-1' }
  const res = await meetingHistory(req('/api/v1/admin/meetings/m-1/history'), ctx)
  const body = await res.json() as {
    rows: Array<{ text: string; actionLabel: string | null }>
    unlabeledActions: Array<{ action: string; count: number; hint: string }>
  }
  expect(body.rows[0]?.actionLabel).toBeNull()
  // 原值仍要出现（它是唯一一条真线索），但旁边必须写着这是没登记的
  expect(body.rows[0]?.text).toContain('frobnicate')
  expect(body.rows[0]?.text).toContain('未登记')
  expect(body.unlabeledActions).toEqual([
    { action: 'frobnicate', count: 1, hint: expect.any(String) },
  ])
})

test('登记过的动作在会议历史里就是那句中文，不带「未登记」', async () => {
  const { ctx } = fakeCtx({
    meeting: { id: 'm-1', title: '周会', code: '1', startAt: NOW - DAY, source: 'meetings' },
    historyRows: [record({ action: 'extend_retention', occurredAt: NOW - 100 })],
    objects: new Map([['m-1', objectRef()]]),
  })
  ctx.params = { meetingId: 'm-1' }
  const res = await meetingHistory(req('/api/v1/admin/meetings/m-1/history'), ctx)
  const body = await res.json() as { rows: Array<{ text: string }>; unlabeledActions: unknown[] }
  expect(body.rows[0]?.text).toContain('延长')
  expect(body.rows[0]?.text).not.toContain('未登记')
  expect(body.unlabeledActions).toEqual([])
})
