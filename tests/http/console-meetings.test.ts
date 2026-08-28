/**
 * A2 会议查询 API（阶段 4 · T5）的 handler 测试。
 *
 * 与 `tests/http/console/auth.test.ts` 同一套哲学：`ConsoleMeetingsStore` 的 SQL
 * 语义已由 `tests/store/console-meetings.test.ts` 覆盖、三栈求值已由
 * `tests/policy/stacks.test.ts` 覆盖、`explainMeetingAccess` 已由
 * `tests/worker/visibility.test.ts` 覆盖，所以这一层**只测这一层新增的那件事**：
 * store 交出来的「库里看得见的一半」，被叠上判定之后变成契约里的 `Meeting`。
 *
 * 因此用假 store / 假 VisibilityDeps 直接调 handler，不连数据库、不过路由派发。
 * 判定本身走的是**真实**的 `policy/stacks.ts` + `policy/override.ts`——那正是
 * 「不要自己再判一遍」这条验收要钉的东西，打桩掉就等于把它测没了。
 */
import { expect, test } from 'bun:test'
import { listMeetings, meetingTriage, getMeeting } from '../../src/http/handlers/console/meetings'
import { consoleMeetingId, type ConsoleMeetingRow, type ConsoleMeetingsStore, type Triage } from '../../src/store/console-meetings'
import type { AuditRecord, MeetingHistoryOptions } from '../../src/store/audit'
import type { JobFailureRecord, ListFailuresOptions } from '../../src/store/jobs'
import type { VisibilityDeps } from '../../src/worker/visibility'
import type { MeetingArchiveRecord } from '../../src/store/archives'
import type { MeetingGrant, MeetingOverride } from '../../src/store/grants'
import type { StackRule } from '../../src/policy/stacks'
import type { Meeting } from '../../src/domain/types'
import type { MeetingMeta } from '../../src/policy/access'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AppDeps, RouteCtx } from '../../src/http/router'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'

const NOW = 1_700_100_000
const START = 1_700_000_000
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }
const KEY = { meetingId: 'm-1', subMeetingId: '' }
const ROW_ID = consoleMeetingId(KEY.meetingId, KEY.subMeetingId)

// ── 造数据 ────────────────────────────────────────────────────────────────

function row(over: Partial<ConsoleMeetingRow> = {}): ConsoleMeetingRow {
  return {
    id: ROW_ID,
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    title: '产品周会',
    code: '881-123-40',
    startAt: START,
    durationSec: 3600,
    // E-b：库里只有 host_userid，下发原值，不编中文占位名
    host: 'zouyanjian',
    hostName: null,
    missing: [],
    assets: { ai_minutes: { got: 3, total: 3 } },
    unknownAssetTypes: [],
    fetch: 'done',
    archive: 'done',
    grants: ['kb-indexer'],
    hand: [],
    keep: {
      archivedAt: START + 7200,
      expiresAt: START + 7200 + 30 * 86400,
      extended: 0,
      extendedSource: 'none',
      extendedDays: 0,
      retentionDays: 30,
      filesGone: false,
    },
    nasPath: '/nas/meetings/2023/11/88112340-产品周会/',
    sizeBytes: 23_907_140,
    ...over,
  }
}

// MeetingMeta 而不是 Meeting：`missingFacts`（阶段 4 · T13）是"这一行哪几列在库里
// 是 NULL"的账，规则求值靠它分开"标题是空串"与"没有标题"
function meta(over: Partial<MeetingMeta> = {}): MeetingMeta {
  return {
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    meetingRecordId: '',
    meetingCode: '881-123-40',
    subject: '产品周会',
    hostUserId: 'zouyanjian',
    startTime: START,
    endTime: START + 3600,
    state: 'completed',
    ...over,
  }
}

function allowRule(over: Partial<StackRule> = {}): StackRule {
  return {
    id: 100,
    kind: 'allow',
    priority: 10,
    enabled: true,
    join: 'and',
    conds: [],
    effect: 'allow',
    assetTypes: ['*'],
    subjectType: 'program',
    subjectValue: 'kb-indexer',
    note: '标题含「周会」且已归档 → 准许采集',
    ...over,
  }
}

function archiveRule(over: Partial<StackRule> = {}): StackRule {
  return {
    id: 200,
    kind: 'archive',
    priority: 10,
    enabled: true,
    join: 'and',
    conds: [],
    effect: '/nas/meetings/{年}/{月}/',
    assetTypes: [],
    subjectType: null,
    subjectValue: null,
    note: '全部会议归档到按年月分的目录',
    ...over,
  }
}

function fetchRule(over: Partial<StackRule> = {}): StackRule {
  return {
    id: 300,
    kind: 'fetch',
    priority: 10,
    enabled: true,
    join: 'and',
    conds: [],
    effect: 'all',
    assetTypes: ['*'],
    subjectType: null,
    subjectValue: null,
    note: '全部拉取',
    ...over,
  }
}

function override(over: Partial<MeetingOverride> = {}): MeetingOverride {
  return {
    id: 1,
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    kind: 'allow',
    effect: 'allow',
    assetTypes: null,
    reason: '法务确认过，这场可以给知识库',
    createdAt: NOW - 100,
    revokedAt: null,
    ...over,
  }
}

/** `job_failures` 里的一条归档失败（阶段 5 · D-4：抽屉要显示的就是它的 reason） */
function failure(over: Partial<JobFailureRecord> = {}): JobFailureRecord {
  return {
    id: 1,
    jobName: 'archive_nas',
    target: `${KEY.meetingId}|${KEY.subMeetingId}`,
    targetLabel: '产品周会',
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    reason: 'NAS 写入超时：/nas/meetings 挂载点只读（EROFS）',
    impact: '未归档，到期会永久丢失',
    attempts: 3,
    maxAttempts: 5,
    firstFailedAt: START + 7200,
    lastFailedAt: NOW - 600,
    resolvedAt: null,
    ...over,
  }
}

/** 一行「归档失败」：store 那边的 6 小时判据已经把它翻成 failed，还没有归档记录 */
function failedRow(over: Partial<ConsoleMeetingRow> = {}): ConsoleMeetingRow {
  return row({
    archive: 'failed',
    keep: { ...row().keep, archivedAt: null, expiresAt: null, retentionDays: null },
    nasPath: null,
    ...over,
  })
}

function auditRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 1,
    occurredAt: START + 8000,
    actorType: 'service',
    actorId: 'kb-indexer',
    action: 'issue_download_url',
    meetingId: KEY.meetingId,
    assetId: 'a-1',
    assetType: 'ai_minutes',
    decision: 'allow',
    matchedRuleId: 100,
    clientKind: 'server',
    // T15 之后 detail 是必填（string | null）：审计的拒绝原因以它为第一出处
    detail: null,
    ...over,
  }
}

// ── 假依赖 ────────────────────────────────────────────────────────────────

interface Scenario {
  rows?: ConsoleMeetingRow[]
  total?: number
  single?: ConsoleMeetingRow | null
  triage?: Triage
  allowRules?: StackRule[]
  archiveRules?: StackRule[]
  fetchRules?: StackRule[]
  overrides?: MeetingOverride[]
  metas?: MeetingMeta[]
  archives?: MeetingArchiveRecord[]
  grants?: MeetingGrant[]
  history?: AuditRecord[]
  /** `job_failures` 里的归档失败记录（阶段 5 · D-4） */
  failures?: JobFailureRecord[]
  /** 读 `job_failures` 这一步自己出错（表没建、查询报错）时的错误话 */
  failuresError?: string
}

interface Harness {
  ctx: RouteCtx
  /** listForMeeting 的调用记录——列表页不许调它（那是 N+1 的入口） */
  historyCalls: Array<{ meetingId: string; opts: MeetingHistoryOptions }>
  listQueries: unknown[]
  /** listFailures 的调用记录——整页也只许问一次（同样是 N+1 的入口） */
  failureQueries: ListFailuresOptions[]
}

function harness(s: Scenario = {}, params: Record<string, string> = {}): Harness {
  const rows = s.rows ?? [row()]
  const metas = s.metas ?? [meta()]
  const historyCalls: Array<{ meetingId: string; opts: MeetingHistoryOptions }> = []
  const listQueries: unknown[] = []
  const failureQueries: ListFailuresOptions[] = []

  const store: ConsoleMeetingsStore = {
    async list(q) {
      listQueries.push(q)
      return { rows, total: s.total ?? rows.length }
    },
    async triage() {
      return (
        s.triage ?? { archiveFailed: 0, expiringIn7d: 0, awaitingGrant: 0, inProgress: 0, nasOnly: 0 }
      )
    },
    async get() {
      return s.single === undefined ? (rows[0] ?? null) : s.single
    },
    async getMeetings(keys) {
      const wanted = new Set(keys.map((k) => `${k.meetingId} ${k.subMeetingId}`))
      return metas.filter((m) => wanted.has(`${m.meetingId} ${m.subMeetingId}`))
    },
  }

  const visibility: VisibilityDeps = {
    policy: {
      async listEnabledStackRules(kind) {
        if (kind === 'allow') return s.allowRules ?? [allowRule()]
        if (kind === 'archive') return s.archiveRules ?? [archiveRule()]
        // 缺省一条拉取规则都没有 = 兼容模式（见 src/worker/fetch-policy.ts），
        // 与一个刚部署完、还没配规则的环境一致
        if (kind === 'fetch') return s.fetchRules ?? []
        return []
      },
    },
    grants: {
      async listActiveGrantsForProgram() {
        return s.grants ?? []
      },
      async findActiveGrant(meetingId, subMeetingId, programId) {
        return (
          (s.grants ?? []).find(
            (g) =>
              g.meetingId === meetingId &&
              g.subMeetingId === subMeetingId &&
              g.programId === programId,
          ) ?? null
        )
      },
      async listActiveOverridesForMeetings() {
        return s.overrides ?? []
      },
    },
    archives: {
      async listMeetingArchives() {
        return s.archives ?? []
      },
      async listMeetingsWithCompletedAssets() {
        return new Set<string>()
      },
    },
    getMeetings: (keys) => store.getMeetings(keys),
  }

  const adminAuth = {
    async verifySession() {
      return ADMIN
    },
  } as unknown as AdminAuth

  const deps = {
    now: () => NOW,
    adminAuth,
    consoleMeetings: store,
    meetingVisibility: visibility,
    meetingHistory: {
      async listForMeeting(meetingId: string, opts: MeetingHistoryOptions = {}) {
        historyCalls.push({ meetingId, opts })
        return s.history ?? []
      },
    },
    // 归档失败的真原因（阶段 5 · D-4）。真实实现是 `createJobsStore(pool).listFailures`
    archiveFailures: {
      async listFailures(opts: ListFailuresOptions = {}) {
        failureQueries.push(opts)
        if (s.failuresError !== undefined) throw new Error(s.failuresError)
        const wanted = new Set((opts.meetings ?? []).map((k) => `${k.meetingId} ${k.subMeetingId}`))
        return (s.failures ?? []).filter((f) => wanted.has(`${f.meetingId} ${f.subMeetingId}`))
      },
    },
  } as unknown as AppDeps

  return { ctx: { params, deps }, historyCalls, listQueries, failureQueries }
}

function req(path = 'https://gw.example/api/v1/admin/meetings', cookie = true): Request {
  const headers = new Headers()
  if (cookie) headers.set('cookie', `${ADMIN_SESSION_COOKIE}=token-1`)
  return new Request(path, { headers })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

async function firstMeeting(s: Scenario = {}): Promise<Record<string, unknown>> {
  const h = harness(s)
  const res = await listMeetings(req(), h.ctx)
  expect(res.status).toBe(200)
  const payload = await body(res)
  return (payload.rows as Record<string, unknown>[])[0] as Record<string, unknown>
}

// ── 验收 5：全部端点走 requireAdminAuth ───────────────────────────────────

test('三个端点在没有管理员会话时一律 401', async () => {
  const h = harness()
  for (const handler of [listMeetings, meetingTriage, getMeeting]) {
    const res = await handler(req('https://gw.example/api/v1/admin/meetings', false), h.ctx)
    expect(res.status).toBe(401)
  }
})

// ── 验收 1：响应形状逐字对上 console/src/api/types.ts 的 Meeting ──────────

test('列表行含契约 Meeting 的全部字段，host 是 host_userid 原值（E-b）', async () => {
  const m = await firstMeeting()
  for (const k of [
    'id', 'title', 'code', 'startAt', 'durationSec', 'host', 'assets',
    'fetch', 'archive', 'allow', 'grants', 'hand', 'keep', 'nasPath',
    'sizeBytes', 'why', 'history',
  ]) {
    expect(m).toHaveProperty(k)
  }
  // 不编中文占位名：库里是 userid，下发就是 userid
  expect(m.host).toBe('zouyanjian')
  const keep = m.keep as Record<string, unknown>
  for (const k of ['archivedAt', 'expiresAt', 'extended', 'filesGone']) {
    expect(keep).toHaveProperty(k)
  }
  const why = m.why as Record<string, { by: string; text: string }>
  for (const k of ['fetch', 'archive', 'allow']) {
    expect(typeof why[k]?.by).toBe('string')
    expect(typeof why[k]?.text).toBe('string')
  }
})

test('列表返回 total / limit / offset，翻页的总数不受分页影响', async () => {
  const h = harness({ total: 137 })
  const res = await listMeetings(
    req('https://gw.example/api/v1/admin/meetings?limit=20&offset=40'),
    h.ctx,
  )
  const payload = await body(res)
  expect(payload.total).toBe(137)
  expect(payload.limit).toBe(20)
  expect(payload.offset).toBe(40)
  expect(h.listQueries[0]).toMatchObject({ now: NOW, limit: 20, offset: 40 })
})

test('筛选参数原样转成 MeetingQuery；三个布尔筛选缺省时不传（不是传 false）', async () => {
  const h = harness()
  await listMeetings(
    req('https://gw.example/api/v1/admin/meetings?search=周会&triage=archiveFailed&hasGrant=false'),
    h.ctx,
  )
  const q = h.listQueries[0] as Record<string, unknown>
  expect(q.search).toBe('周会')
  expect(q.triage).toBe('archiveFailed')
  expect(q.hasGrant).toBe(false)
  // 没给的筛选必须是 undefined：给成 false 会把「不筛选」变成「只要没有的」
  expect(q.hasOverride).toBeUndefined()
  expect(q.inRetention).toBeUndefined()
})

test('分诊条取值不认识、limit/offset 不是数字，一律 400 而不是悄悄忽略', async () => {
  const h = harness()
  for (const qs of ['triage=nope', 'limit=abc', 'limit=0', 'limit=501', 'offset=-1']) {
    const res = await listMeetings(req(`https://gw.example/api/v1/admin/meetings?${qs}`), h.ctx)
    expect(res.status).toBe(400)
  }
})

// ── 验收 3（T12 / A7）：why.fetch 是一次真判定 ────────────────────────────

test('规则判 skip：why.fetch 报 rule，说得出是哪条规则、哪句 note', async () => {
  const m = await firstMeeting({
    rows: [row({ fetch: 'none' })],
    fetchRules: [
      fetchRule({ id: 301, note: '只拉财务会', conds: [{ f: 'title', op: 'has', v: '财务' }] }),
    ],
  })
  const why = (m.why as Record<string, { by: string; text: string }>).fetch!
  // 兜底（一条都不匹配）不是"某条规则明确拒绝"，但它确实是规则栈做出的判定
  expect(why.by).toBe('rule')
  expect(why.text).toContain('拉取规则')
  expect(m.fetch).toBe('blocked')
})

test('规则判 all：why.fetch 报 rule 并带上规则编号，不再是接线前那句 na', async () => {
  const m = await firstMeeting({ fetchRules: [fetchRule({ id: 302 })] })
  const why = (m.why as Record<string, { by: string; text: string }>).fetch!
  expect(why.by).toBe('rule')
  expect(why.text).toContain('#302')
  expect(why.text).not.toContain('尚未接线')
})

test('一条拉取规则都没配时报 na 并说清兼容模式，不谎称由某条规则决定', async () => {
  const m = await firstMeeting()
  const why = (m.why as Record<string, { by: string; text: string }>).fetch!
  expect(why.by).toBe('na')
  // 编一个 by:'rule' 比不说更糟——顶上的兼容兜底不是库里的规则，管理员找不到它
  expect(why.by).not.toBe('rule')
  expect(why.text).toContain('全部拉取')
  expect(why.text).toContain('skip')
})

test('元数据不全时报 na，不报 rule——管理员去改规则改不动它', async () => {
  const m = await firstMeeting({
    rows: [row({ fetch: 'none', title: '', missing: ['title'] })],
    metas: [meta({ subject: '', missingFacts: ['title'] })],
    fetchRules: [fetchRule({ conds: [{ f: 'title', op: 'has', v: '财务' }] })],
  })
  const why = (m.why as Record<string, { by: string; text: string }>).fetch!
  expect(why.by).toBe('na')
})

test('拉取被人工关掉时 why.fetch 是 hand，不是 na——那是一次真发生过的人的决定', async () => {
  const m = await firstMeeting({
    rows: [row({ fetch: 'off', hand: ['fetch'] })],
    overrides: [override({ kind: 'fetch', effect: 'skip', reason: '这场误录了' })],
  })
  const why = (m.why as Record<string, { by: string; text: string }>).fetch!
  expect(why.by).toBe('hand')
  expect(why.text).toContain('这场误录了')
  expect(m.fetch).toBe('off')
})

test('兼容模式下不叠 blocked：一条规则都没配时 worker 是全拉的，不是拦下的', async () => {
  const m = await firstMeeting({ rows: [row({ fetch: 'none' })] })
  expect(m.fetch).toBe('none')
})

test('已经拉过的会议不会被后来改成 skip 的规则追认成 blocked', async () => {
  const m = await firstMeeting({
    rows: [row({ fetch: 'done' })],
    fetchRules: [fetchRule({ conds: [{ f: 'title', op: 'has', v: '财务' }] })],
  })
  expect(m.fetch).toBe('done')
})

// ── 验收 2：why.allow 走 explainMeetingAccess，不自己再判一遍 ─────────────

test('规则判 allow：allow=allow，why.allow 由那条规则给出（含规则 id 与 note）', async () => {
  const m = await firstMeeting()
  expect(m.allow).toBe('allow')
  const why = (m.why as Record<string, { by: string; text: string }>).allow!
  expect(why.by).toBe('rule')
  expect(why.text).toContain('#100')
  expect(why.text).toContain('标题含「周会」')
})

test('规则明确拒绝：allow=deny 且 by=deny（deny 只配 allow:deny 用）', async () => {
  const m = await firstMeeting({
    allowRules: [allowRule({ effect: 'deny', note: '标题含「面试」→ 禁止采集' })],
  })
  expect(m.allow).toBe('deny')
  const why = (m.why as Record<string, { by: string; text: string }>).allow!
  expect(why.by).toBe('deny')
})

test('一条 allow 规则都没有：兜底 deny，by 是 rule 不是 deny——没有规则明确拒绝过', async () => {
  const m = await firstMeeting({ allowRules: [] })
  expect(m.allow).toBe('deny')
  const why = (m.why as Record<string, { by: string; text: string }>).allow!
  expect(why.by).toBe('rule')
  expect(why.text).toContain('兜底')
})

test('人工改写把 deny 翻成 allow：allow=allow 且 by=hand（改写优先于所有规则）', async () => {
  const m = await firstMeeting({
    allowRules: [allowRule({ effect: 'deny' })],
    overrides: [override({ kind: 'allow', effect: 'allow', assetTypes: ['ai_minutes'] })],
  })
  expect(m.allow).toBe('allow')
  const why = (m.why as Record<string, { by: string; text: string }>).allow!
  expect(why.by).toBe('hand')
})

test('会议元数据查不到：判不出来落到拒绝一侧，by=na，不编一次没发生过的判定', async () => {
  const m = await firstMeeting({ metas: [] })
  expect(m.allow).toBe('deny')
  expect((m.why as Record<string, { by: string }>).allow!.by).toBe('na')
})

test('列表与详情对同一场会议给出同一个 allow 与同一句 why.allow', async () => {
  // 场景里放一条真授权：详情走 explainMeetingAccess（会把授权行读进去）、
  // 列表走批量的 evaluateInventory（刻意传空授权）。两条路径给出的判定必须一样——
  // 哪天 decision 开始依赖授权行了，这条用例会先炸，而不是等管理员在抽屉里看到
  // 与列表不同的那句话
  const scenario: Scenario = {
    allowRules: [allowRule({ effect: 'deny' })],
    grants: [
      {
        id: 1,
        meetingId: KEY.meetingId,
        subMeetingId: KEY.subMeetingId,
        programId: 'kb-indexer',
        assetTypes: null,
        grantedAt: START,
        revokedAt: null,
      },
    ],
  }
  const listed = await firstMeeting(scenario)
  const h = harness(scenario, { meetingId: ROW_ID })
  const res = await getMeeting(req(`https://gw.example/api/v1/admin/meetings/${ROW_ID}`), h.ctx)
  expect(res.status).toBe(200)
  const detail = await body(res)
  expect(detail.allow).toBe(listed.allow)
  expect(detail.why).toMatchObject({ allow: (listed.why as Record<string, unknown>).allow as object })
})

// ── 验收 4：why.archive 走 evaluateArchiveStack + 人工改写 ────────────────

test('归档规则判 skip 且还没归档：archive 叠成 blocked，why 指向那条规则', async () => {
  const m = await firstMeeting({
    rows: [row({ archive: 'running', keep: { ...row().keep, archivedAt: null, expiresAt: null, retentionDays: null } })],
    archiveRules: [archiveRule({ effect: 'skip', note: '外部会议不归档' })],
  })
  // 没有这一层叠加，这场会议会在 6 小时宽限后翻成 failed——最高级别的红色告警，
  // 而它实际上是规则做出的决定
  expect(m.archive).toBe('blocked')
  const why = (m.why as Record<string, { by: string; text: string }>).archive!
  expect(why.by).toBe('rule')
  expect(why.text).toContain('#200')
})

test('归档被人工关掉：archive 保持 off、by=hand，不被叠成 blocked', async () => {
  const m = await firstMeeting({
    rows: [row({ archive: 'off', hand: ['archive'] })],
    archiveRules: [archiveRule({ effect: 'skip' })],
    overrides: [override({ kind: 'archive', effect: 'skip', reason: '这场归到别处了' })],
  })
  expect(m.archive).toBe('off')
  const why = (m.why as Record<string, { by: string; text: string }>).archive!
  expect(why.by).toBe('hand')
  expect(why.text).toContain('这场归到别处了')
})

test('已归档的会议不会被规则改动追认成 blocked，且理由里说明副本仍在 NAS', async () => {
  const m = await firstMeeting({ archiveRules: [archiveRule({ effect: 'skip' })] })
  expect(m.archive).toBe('done')
  const why = (m.why as Record<string, { by: string; text: string }>).archive!
  expect(why.text).toContain('/nas/meetings/2023/11/88112340-产品周会/')
})

// ── D-4：归档失败的理由先读 job_failures，读不到才回落时间启发式 ──────────
//
// 这一格曾经原样告诉管理员「真正的失败原因要等 A4 建 job_failures 才查得到」，
// 而那张表连「按会议反查」的索引都建好了（migrations/008 的 idx_job_failure_meeting）。
// 下面六条钉的是：真原因优先、查不到才回落、查不成不许装作查过。

function archiveWhyOf(m: Record<string, unknown>): { by: string; text: string } {
  return (m.why as Record<string, { by: string; text: string }>).archive!
}

test('归档失败：理由给的是 job_failures 里那条真原因，不是时间启发式', async () => {
  const scenario = { rows: [failedRow()], failures: [failure()] }
  const m = await firstMeeting(scenario)
  const why = archiveWhyOf(m)
  expect(why.by).toBe('fail')
  // 真原因原文上屏：NAS 路径与 errno 是运维接着往下查的全部线索
  expect(why.text).toContain('NAS 写入超时：/nas/meetings 挂载点只读（EROFS）')
  // 「第 3 / 5 次」与影响都来自那一行，不是这里现拼的
  expect(why.text).toContain('3 / 5')
  expect(why.text).toContain('未归档，到期会永久丢失')
  // 有真原因时**不许**再说「这是时间上的启发式」——那正是要消灭的那句假话
  expect(why.text).not.toContain('启发式')
  expect(why.text).not.toContain('6 小时')

  // 抽屉与列表是同一句：两处各说各的话，管理员点开前后会看到两种解释
  const h = harness(scenario, { meetingId: ROW_ID })
  const res = await getMeeting(req(`https://gw.example/api/v1/admin/meetings/${ROW_ID}`), h.ctx)
  expect(archiveWhyOf(await body(res))).toEqual(why)
})

test('job_failures 里没有这场的失败记录：回落到 6 小时启发式，并说明这是回落', async () => {
  const m = await firstMeeting({ rows: [failedRow()], failures: [] })
  const why = archiveWhyOf(m)
  expect(why.by).toBe('fail')
  // 启发式本身不删：没有失败记录也不许报假太平
  expect(why.text).toContain('6 小时')
  expect(why.text).toContain('永久')
  // 但要说清这一条是推断出来的，不是读出来的
  expect(why.text).toContain('启发式')
  expect(why.text).toContain('job_failures')
})

test('读 job_failures 出错：不静默吞掉——仍报失败，并把「这次没查成」写进理由', async () => {
  const m = await firstMeeting({
    rows: [failedRow()],
    failures: [failure()],
    failuresError: "Table 'mde.job_failures' doesn't exist",
  })
  const why = archiveWhyOf(m)
  // 落到安全的一侧：告警不因为一次查询失败而消失
  expect(why.by).toBe('fail')
  expect(why.text).toContain('永久')
  // 理由可回溯：错误原文上屏
  expect(why.text).toContain("Table 'mde.job_failures' doesn't exist")
  // 「查不成」不许说成「没有失败记录」——那是两件事
  expect(why.text).toContain('不等于')
})

test('反查用 (meeting_id, sub_meeting_id) 两段键，周期性会议的场次不串场', async () => {
  const sub = { meetingId: 'm-9', subMeetingId: 's-2' }
  const id = consoleMeetingId(sub.meetingId, sub.subMeetingId)
  const h = harness(
    {
      single: failedRow({ ...sub, id }),
      metas: [meta(sub)],
      failures: [failure({ ...sub, reason: '这一场的原因' })],
    },
    { meetingId: id },
  )
  const res = await getMeeting(req(`https://gw.example/api/v1/admin/meetings/${id}`), h.ctx)
  expect(res.status).toBe(200)
  expect(h.failureQueries).toHaveLength(1)
  expect(h.failureQueries[0]!.jobName).toBe('archive_nas')
  expect(h.failureQueries[0]!.meetings).toEqual([sub])
  expect(archiveWhyOf(await body(res)).text).toContain('这一场的原因')
})

test('整页只发一次 job_failures 反查，且只问归档失败的那几场', async () => {
  const other = { meetingId: 'm-3', subMeetingId: 's-1' }
  const h = harness({
    rows: [
      failedRow(),
      row(),
      failedRow({ ...other, id: consoleMeetingId(other.meetingId, other.subMeetingId) }),
    ],
    metas: [meta(), meta(other)],
    failures: [failure()],
  })
  const res = await listMeetings(req(), h.ctx)
  expect(res.status).toBe(200)
  // 逐行反查是 N+1，而这条端点的验收判据是「查询数与行数无关」
  expect(h.failureQueries).toHaveLength(1)
  expect(h.failureQueries[0]!.meetings).toEqual([KEY, other])
})

test('页上一场归档失败都没有时，一次 job_failures 都不查', async () => {
  const h = harness()
  await listMeetings(req(), h.ctx)
  expect(h.failureQueries).toHaveLength(0)
})

// ── history：走 AuditQueryStore.listForMeeting，且必须传 since ────────────

test('详情的 history 走 listForMeeting，并把这场会议的 startAt 当 since 传下去', async () => {
  const h = harness({ history: [auditRecord()] }, { meetingId: ROW_ID })
  const res = await getMeeting(req(`https://gw.example/api/v1/admin/meetings/${ROW_ID}`), h.ctx)
  expect(res.status).toBe(200)
  expect(h.historyCalls).toHaveLength(1)
  expect(h.historyCalls[0]!.meetingId).toBe(KEY.meetingId)
  // audit_log 上没有 meeting_id 索引，不给时间下界就是一次全索引扫
  expect(h.historyCalls[0]!.opts.since).toBe(START)

  const detail = await body(res)
  const history = detail.history as Array<{ at: number; text: string }>
  expect(history).toHaveLength(1)
  expect(history[0]!.at).toBe(START + 8000)
  expect(history[0]!.text).toContain('kb-indexer')
})

test('start_time 缺失时不编一个下界——宁可慢一次，也不藏起真实记录', async () => {
  const h = harness(
    { single: row({ startAt: 0, missing: ['startAt'] }), history: [] },
    { meetingId: ROW_ID },
  )
  await getMeeting(req(`https://gw.example/api/v1/admin/meetings/${ROW_ID}`), h.ctx)
  expect(h.historyCalls[0]!.opts.since).toBeUndefined()
})

test('列表不查审计：history 一律空数组，避免每页 N 次 listForMeeting', async () => {
  const h = harness({ history: [auditRecord()] })
  const res = await listMeetings(req(), h.ctx)
  const payload = await body(res)
  expect((payload.rows as Array<{ history: unknown[] }>)[0]!.history).toEqual([])
  expect(h.historyCalls).toHaveLength(0)
})

test('被拒绝的取用在历史里说得出是被拒绝的，不与成功取用混成同一句', async () => {
  const h = harness(
    { history: [auditRecord({ decision: 'deny', matchedRuleId: 7 })] },
    { meetingId: ROW_ID },
  )
  const res = await getMeeting(req(`https://gw.example/api/v1/admin/meetings/${ROW_ID}`), h.ctx)
  const detail = await body(res)
  const history = detail.history as Array<{ at: number; text: string }>
  expect(history[0]!.text).toContain('拒绝')
})

// ── 详情端点的路径解析与 404 ─────────────────────────────────────────────

test('路径段用 parseConsoleMeetingId 解，周期性会议的场次不会撞成同一行', async () => {
  const sub = { meetingId: 'm-9', subMeetingId: 's-2' }
  const id = consoleMeetingId(sub.meetingId, sub.subMeetingId)
  const seen: Array<{ meetingId: string; subMeetingId: string }> = []
  const h = harness({ single: row({ ...sub, id }) }, { meetingId: id })
  const store = (h.ctx.deps as unknown as { consoleMeetings: ConsoleMeetingsStore }).consoleMeetings
  const orig = store.get.bind(store)
  store.get = async (meetingId, subMeetingId, now) => {
    seen.push({ meetingId, subMeetingId })
    return orig(meetingId, subMeetingId, now)
  }
  const res = await getMeeting(req(`https://gw.example/api/v1/admin/meetings/${id}`), h.ctx)
  expect(res.status).toBe(200)
  expect(seen).toEqual([sub])
})

test('查不到的会议返回 404，不是一行空壳', async () => {
  const h = harness({ single: null }, { meetingId: ROW_ID })
  const res = await getMeeting(req(`https://gw.example/api/v1/admin/meetings/${ROW_ID}`), h.ctx)
  expect(res.status).toBe(404)
})

// ── 分诊条 ────────────────────────────────────────────────────────────────

test('分诊条五格原样下发，字段名与契约的 Triage 逐字一致', async () => {
  const counts: Triage = {
    archiveFailed: 2,
    expiringIn7d: 1,
    awaitingGrant: 4,
    inProgress: 3,
    nasOnly: 5,
  }
  const h = harness({ triage: counts })
  const res = await meetingTriage(req('https://gw.example/api/v1/admin/meetings/triage'), h.ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual(counts)
})
