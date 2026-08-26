/**
 * 规则 API + 影响预览（阶段 4 · T6）的 handler 测试。
 *
 * 与 `tests/store/policy.test.ts`（真库、真 SQL）的分工：**这一层不重复验证 store 的
 * 语义**。`PolicyStore` 的校验、事务、`deleteRule` 返回被删内容这些事已经在那份测试里
 * 钉死了。这里只关心 handler 自己的胶水：
 *
 *  - 谁在调用（`requireAdminAuth`），身份怎么落进 `created_by` 与审计的 `actor_id`
 *  - store 的三条出口（成功 / `PolicyRuleInvalid` / `null`）各自映到哪个状态码
 *  - **每一次写操作有没有落审计**，以及审计里说不说得出「改的是哪一栈的哪一条」
 *  - 影响预览**一行都不落库**，以及琥珀警告是从 `ImpactChange` 读出来的
 *
 * 因此依赖全部是内存假实现（连 `bun:test` 的 mock 都不用，假实现自己记调用），
 * 不连数据库：一条 handler 的分支不该因为测试库没起来就跑不了。
 * 这与 `tests/http/console/auth.test.ts` 是同一套写法。
 */
import { expect, test } from 'bun:test'
import {
  createRule,
  deleteRule,
  listRules,
  patchRule,
  previewRules,
  ruleMatches,
} from '../../src/http/handlers/console/rules'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import { createApp, type AppDeps, type RouteCtx } from '../../src/http/router'
import type { AdminRule, PolicyStore, RuleDraft, RulePatch } from '../../src/store/policy'
import { PolicyRuleInvalid } from '../../src/store/policy'
import type { AuditEntry, AuditStore } from '../../src/store/audit'
import type { ConsoleMeetingRow, ConsoleMeetingsStore, HandKind } from '../../src/store/console-meetings'
import { consoleMeetingId } from '../../src/store/console-meetings'
import type { Meeting } from '../../src/domain/types'
import type { RuleCond } from '../../src/policy/conds'
import type { StackKind } from '../../src/policy/stacks'

const NOW = 1_700_000_000
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice' }

// ── 假依赖 ────────────────────────────────────────────────────────────────

function fakeAdminAuth(verify?: () => Promise<AdminIdentity>): AdminAuth {
  return {
    async authenticate() {
      throw new Error('not stubbed')
    },
    async hashPassword() {
      throw new Error('not stubbed')
    },
    async issueSession() {
      throw new Error('not stubbed')
    },
    verifySession: verify ?? (async () => ADMIN),
    async revokeSession() {
      throw new Error('not stubbed')
    },
    async revokeAllSessionsFor() {
      throw new Error('not stubbed')
    },
  }
}

interface RecordedCall {
  method: string
  args: unknown[]
}

interface FakePolicy {
  store: PolicyStore
  calls: RecordedCall[]
}

/**
 * 未被某个用例显式覆盖的方法一律抛错，而不是返回一个空值。
 *
 * 「预览端点绝不落库」这条验收就靠它：预览用例不覆盖任何写方法，
 * 一旦实现里手滑调了 `createRule`，测试炸的是那一句，而不是过一会儿在别处
 * 变成一个说不清来源的断言失败。
 */
function fakePolicyStore(overrides: Partial<PolicyStore> = {}): FakePolicy {
  const calls: RecordedCall[] = []
  const guard =
    (method: string) =>
    (...args: unknown[]): never => {
      calls.push({ method, args })
      throw new Error(`fakePolicyStore.${method} 未在本用例中打桩——不该被调用`)
    }
  const base = {
    listEnabledRules: guard('listEnabledRules'),
    listEnabledStackRules: guard('listEnabledStackRules'),
    listAllRules: guard('listAllRules'),
    getRule: guard('getRule'),
    createRule: guard('createRule'),
    updateRule: guard('updateRule'),
    setEnabled: guard('setEnabled'),
    deleteRule: guard('deleteRule'),
  } as unknown as PolicyStore

  const wrapped: Record<string, unknown> = {}
  for (const [name, impl] of Object.entries(overrides)) {
    wrapped[name] = (...args: unknown[]) => {
      calls.push({ method: name, args })
      return (impl as (...a: unknown[]) => unknown)(...args)
    }
  }
  return { store: { ...base, ...wrapped } as PolicyStore, calls }
}

function fakeAuditStore(): { store: AuditStore; entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  return {
    entries,
    store: {
      async record(entry) {
        entries.push(entry)
      },
    },
  }
}

/** 一场会议：同时产出 `list()` 的行与 `getMeetings()` 的领域对象，两者必然对得上 */
interface MeetingSpec {
  meetingId: string
  subMeetingId?: string
  title: string
  host?: string
  startTime?: number
  /** 不给时等于 startTime，即「没有结束时间数据」 */
  endTime?: number
  archived?: boolean
  /** 被人工改写过的阶段 */
  hand?: HandKind[]
}

function specRow(s: MeetingSpec): ConsoleMeetingRow {
  const sub = s.subMeetingId ?? ''
  const start = s.startTime ?? NOW - 86_400
  const end = s.endTime ?? start
  return {
    id: consoleMeetingId(s.meetingId, sub),
    meetingId: s.meetingId,
    subMeetingId: sub,
    title: s.title,
    code: '12345678',
    startAt: start,
    durationSec: end > start ? end - start : 0,
    host: s.host ?? 'host-1',
    missing: [],
    assets: {},
    unknownAssetTypes: [],
    fetch: 'none',
    archive: s.archived === true ? 'done' : 'none',
    grants: [],
    hand: s.hand ?? [],
    keep: {
      archivedAt: s.archived === true ? start + 3600 : null,
      expiresAt: s.archived === true ? start + 3600 + 30 * 86_400 : null,
      extended: 0,
      extendedSource: 'none',
      extendedDays: 0,
      retentionDays: s.archived === true ? 30 : null,
      filesGone: false,
    },
    nasPath: null,
    sizeBytes: null,
  }
}

function specMeeting(s: MeetingSpec): Meeting {
  const sub = s.subMeetingId ?? ''
  const start = s.startTime ?? NOW - 86_400
  return {
    meetingId: s.meetingId,
    subMeetingId: sub,
    meetingRecordId: `rec-${s.meetingId}`,
    meetingCode: '12345678',
    subject: s.title,
    hostUserId: s.host ?? 'host-1',
    startTime: start,
    endTime: s.endTime ?? start,
    state: 'completed',
  }
}

function fakeConsoleMeetings(specs: MeetingSpec[], total = specs.length): ConsoleMeetingsStore {
  return {
    async list(q) {
      const limit = q.limit ?? 50
      return { rows: specs.slice(0, limit).map(specRow), total }
    },
    async triage() {
      throw new Error('triage 不该被规则 API 调用')
    },
    async get() {
      throw new Error('get 不该被规则 API 调用')
    },
    async getMeetings(keys) {
      const wanted = new Set(keys.map((k) => consoleMeetingId(k.meetingId, k.subMeetingId)))
      return specs
        .filter((s) => wanted.has(consoleMeetingId(s.meetingId, s.subMeetingId ?? '')))
        .map(specMeeting)
    },
  }
}

interface CtxParts {
  policy?: PolicyStore
  audit?: AuditStore
  meetings?: ConsoleMeetingsStore
  adminAuth?: AdminAuth
  params?: Record<string, string>
}

function ctxOf(parts: CtxParts = {}): RouteCtx {
  return {
    params: parts.params ?? {},
    deps: {
      now: () => NOW,
      adminAuth: parts.adminAuth ?? fakeAdminAuth(),
      policyStore: parts.policy ?? fakePolicyStore().store,
      auditStore: parts.audit ?? fakeAuditStore().store,
      consoleMeetings: parts.meetings ?? fakeConsoleMeetings([]),
    } as unknown as AppDeps,
  }
}

function req(method: string, body?: unknown, opts: { cookie?: boolean } = {}): Request {
  const headers = new Headers()
  if (opts.cookie !== false) headers.set('cookie', `${ADMIN_SESSION_COOKIE}=session-token`)
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  return new Request('https://gw.example/api/v1/admin/rules', init)
}

function rule(over: Partial<AdminRule> = {}): AdminRule {
  return {
    id: 1,
    kind: 'allow',
    priority: 50,
    enabled: true,
    join: 'and',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
    subjectType: 'program',
    subjectValue: 'svc-a',
    assetTypes: ['ai_minutes'],
    effect: 'allow',
    note: '财务会议给数据组',
    createdBy: 'admin-0',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    issues: [],
    ...over,
  }
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

// ── 认证 ─────────────────────────────────────────────────────────────────

test('六个端点一律要管理员会话，没有 cookie 一律 401', async () => {
  const ctx = ctxOf({ params: { id: '1' } })
  const calls: Array<[string, Promise<Response>]> = [
    ['list', listRules(req('GET', undefined, { cookie: false }), ctx)],
    ['create', createRule(req('POST', {}, { cookie: false }), ctx)],
    ['patch', patchRule(req('PATCH', {}, { cookie: false }), ctx)],
    ['delete', deleteRule(req('DELETE', undefined, { cookie: false }), ctx)],
    ['preview', previewRules(req('POST', {}, { cookie: false }), ctx)],
    ['matches', ruleMatches(req('GET', undefined, { cookie: false }), ctx)],
  ]
  for (const [name, p] of calls) {
    const res = await p
    expect(`${name}:${res.status}`).toBe(`${name}:401`)
  }
})

// ── 列表 ─────────────────────────────────────────────────────────────────

test('列表把停用的规则和 issues 一并下发（交接 4：规则页要显示「这条规则不会命中任何会议」）', async () => {
  const rows: AdminRule[] = [
    rule({ id: 1 }),
    rule({ id: 2, enabled: false, issues: ['第 1 个条件永远不成立，这条规则不会命中任何会议'] }),
  ]
  const policy = fakePolicyStore({ listAllRules: async () => rows })
  const res = await listRules(req('GET'), ctxOf({ policy: policy.store }))
  expect(res.status).toBe(200)
  const body = await bodyOf(res)
  const list = body.rules as AdminRule[]
  expect(list).toHaveLength(2)
  expect(list[1]!.enabled).toBe(false)
  expect(list[1]!.issues).toEqual(['第 1 个条件永远不成立，这条规则不会命中任何会议'])
  // 不传 kind 时不做筛选
  expect(policy.calls[0]!.args[0]).toBeUndefined()
})

test('列表按栈筛选，栈名不认识时是 400 而不是静默返回全部三栈', async () => {
  const policy = fakePolicyStore({ listAllRules: async () => [rule()] })
  const ok = await listRules(
    new Request('https://gw.example/api/v1/admin/rules?kind=allow', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=t` },
    }),
    ctxOf({ policy: policy.store }),
  )
  expect(ok.status).toBe(200)
  expect(policy.calls[0]!.args[0]).toBe('allow')

  const bad = await listRules(
    new Request('https://gw.example/api/v1/admin/rules?kind=allo', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=t` },
    }),
    ctxOf({ policy: fakePolicyStore().store }),
  )
  expect(bad.status).toBe(400)
  expect((await bodyOf(bad)).error).toBe('unknown_stack_kind')
})

// ── 新建 ─────────────────────────────────────────────────────────────────

test('新建成功：created_by 用当前管理员、时刻用网关的秒级 now，并落一条 rule_create 审计', async () => {
  let seen: (RuleDraft & { now: number }) | null = null
  const created = rule({ id: 7, createdBy: ADMIN.adminId })
  const policy = fakePolicyStore({
    createRule: async (input) => {
      seen = input as RuleDraft & { now: number }
      return created
    },
  })
  const audit = fakeAuditStore()
  const res = await createRule(
    req('POST', {
      kind: 'allow',
      priority: 50,
      join: 'and',
      conds: [{ f: 'title', op: 'has', v: '财务' }],
      subjectType: 'program',
      subjectValue: 'svc-a',
      assetTypes: ['ai_minutes'],
      effect: 'allow',
      note: '财务会议给数据组',
      // 请求体里伪造的建立人必须被忽略——否则审计里「谁建的」可以随便写
      createdBy: 'someone-else',
    }),
    ctxOf({ policy: policy.store, audit: audit.store }),
  )

  expect(res.status).toBe(201)
  expect((await bodyOf(res)).rule).toMatchObject({ id: 7 })

  const draft = seen as unknown as (RuleDraft & { now: number }) | null
  expect(draft).not.toBeNull()
  expect(draft!.createdBy).toBe(ADMIN.adminId)
  expect(draft!.now).toBe(NOW)

  expect(audit.entries).toHaveLength(1)
  const e = audit.entries[0]!
  expect(e.actorType).toBe('admin')
  expect(e.actorId).toBe(ADMIN.adminId)
  expect(e.action).toBe('rule_create')
  expect(e.occurredAt).toBe(NOW)
  expect(e.decision).toBe('allow')
  // 「哪一栈的哪一条」（验收 2）
  expect(e.matchedRuleId).toBe(7)
  expect(e.assetType).toBe('allow')
})

test('新建被校验挡下：400 + 逐条 issues 原样下发（交接 2），且一行都没落库', async () => {
  const issues = [
    'conds 是空数组：空条件在求值器里是「匹配一切」',
    '采集权限规则没有指定采集程序（subject_value 为空），这条规则不会对任何程序生效',
  ]
  const policy = fakePolicyStore({
    createRule: async () => {
      throw new PolicyRuleInvalid(issues)
    },
  })
  const audit = fakeAuditStore()
  const res = await createRule(
    req('POST', { kind: 'allow', priority: 1, join: 'and', conds: [], assetTypes: [], effect: 'allow' }),
    ctxOf({ policy: policy.store, audit: audit.store }),
  )
  expect(res.status).toBe(400)
  const body = await bodyOf(res)
  expect(body.error).toBe('rule_invalid')
  expect(body.issues).toEqual(issues)
  // 被拒绝的写入也留痕，但结果是 deny——审计流要答得出「谁试过把闸门改开」
  expect(audit.entries).toHaveLength(1)
  expect(audit.entries[0]!.decision).toBe('deny')
  expect(audit.entries[0]!.action).toBe('rule_create')
})

test('请求体不是 JSON 时 400，不把 undefined 喂给 store', async () => {
  const policy = fakePolicyStore()
  const res = await createRule(req('POST', 'not json at all'), ctxOf({ policy: policy.store }))
  expect(res.status).toBe(400)
  expect((await bodyOf(res)).error).toBe('invalid_json')
  expect(policy.calls).toHaveLength(0)
})

// ── 改 ───────────────────────────────────────────────────────────────────

test('改内容走 updateRule，审计只记真的变了的字段（前后各一份）', async () => {
  const before = rule({ id: 3, effect: 'deny', note: '先关着' })
  const after = rule({ id: 3, effect: 'allow', note: '先关着', updatedAt: NOW })
  let patch: RulePatch | null = null
  const policy = fakePolicyStore({
    getRule: async () => before,
    updateRule: async (_id, p) => {
      patch = p as RulePatch
      return after
    },
  })
  const audit = fakeAuditStore()
  const res = await patchRule(
    req('PATCH', { effect: 'allow' }),
    ctxOf({ policy: policy.store, audit: audit.store, params: { id: '3' } }),
  )
  expect(res.status).toBe(200)
  expect((await bodyOf(res)).rule).toMatchObject({ id: 3, effect: 'allow' })

  const p = patch as unknown as RulePatch | null
  expect(p).not.toBeNull()
  expect(p!.now).toBe(NOW)
  // 只带了 effect：note / conds 一概不进 patch，否则「没填的字段」会被当成「清空」
  expect(Object.keys(p!).sort()).toEqual(['effect', 'now'])

  expect(audit.entries).toHaveLength(1)
  const e = audit.entries[0]!
  expect(e.action).toBe('rule_update')
  expect(e.matchedRuleId).toBe(3)
  expect(e.assetType).toBe('allow')
  // 「谁把这条规则从 deny 改成 allow」必须在这一行里读得出来
  expect(e.assetId ?? '').toContain('deny')
  expect(e.assetId ?? '').toContain('allow')
  // 没改的字段不该塞进这一行——255 个字符要留给真的改动
  expect(e.assetId ?? '').not.toContain('先关着')
})

test('只改 enabled 时走 setEnabled，动作是 rule_toggle——坏规则也必须关得掉', async () => {
  const broken = rule({ id: 9, conds: [], issues: ['conds 是空数组'] })
  const policy = fakePolicyStore({
    getRule: async () => broken,
    // updateRule 没打桩：一旦实现走了它，这条用例就炸——坏规则会因为过不了
    // 内容校验而关不掉，而「关掉它」是出事时唯一能立刻止血的动作
    setEnabled: async () => rule({ id: 9, enabled: false, conds: [] }),
  })
  const audit = fakeAuditStore()
  const res = await patchRule(
    req('PATCH', { enabled: false }),
    ctxOf({ policy: policy.store, audit: audit.store, params: { id: '9' } }),
  )
  expect(res.status).toBe(200)
  expect(policy.calls.map((c) => c.method)).toContain('setEnabled')
  expect(policy.calls.map((c) => c.method)).not.toContain('updateRule')
  expect(policy.calls.find((c) => c.method === 'setEnabled')!.args.slice(1)).toEqual([false, NOW])

  expect(audit.entries).toHaveLength(1)
  expect(audit.entries[0]!.action).toBe('rule_toggle')
  expect(audit.entries[0]!.matchedRuleId).toBe(9)
})

test('规则不存在是 404，校验不过是 400——两条路径不合并（交接 3）', async () => {
  const missing = fakePolicyStore({ getRule: async () => null })
  const notFound = await patchRule(
    req('PATCH', { effect: 'allow' }),
    ctxOf({ policy: missing.store, params: { id: '404' } }),
  )
  expect(notFound.status).toBe(404)
  expect((await bodyOf(notFound)).error).toBe('rule_not_found')

  const invalid = fakePolicyStore({
    getRule: async () => rule({ id: 5 }),
    updateRule: async () => {
      throw new PolicyRuleInvalid(['effect 写不进去：effect「allwo」不认识'])
    },
  })
  const rejected = await patchRule(
    req('PATCH', { effect: 'allwo' }),
    ctxOf({ policy: invalid.store, params: { id: '5' } }),
  )
  expect(rejected.status).toBe(400)
  expect((await bodyOf(rejected)).error).toBe('rule_invalid')

  // 并发：读到了、改的时候没了，store 返回 null → 仍然是 404，不是 500
  const vanished = fakePolicyStore({
    getRule: async () => rule({ id: 6 }),
    updateRule: async () => null,
  })
  const gone = await patchRule(
    req('PATCH', { effect: 'allow' }),
    ctxOf({ policy: vanished.store, params: { id: '6' } }),
  )
  expect(gone.status).toBe(404)
})

test('patch 一个字段都没带时 400，不发一次什么都不改的写入', async () => {
  const policy = fakePolicyStore({ getRule: async () => rule({ id: 3 }) })
  const res = await patchRule(req('PATCH', {}), ctxOf({ policy: policy.store, params: { id: '3' } }))
  expect(res.status).toBe(400)
  expect((await bodyOf(res)).error).toBe('empty_patch')
})

test('规则 id 不是正整数时 400，不拿 NaN 去查库', async () => {
  const policy = fakePolicyStore()
  const res = await patchRule(
    req('PATCH', { effect: 'allow' }),
    ctxOf({ policy: policy.store, params: { id: 'abc' } }),
  )
  expect(res.status).toBe(400)
  expect((await bodyOf(res)).error).toBe('invalid_rule_id')
  expect(policy.calls).toHaveLength(0)
})

// ── 删 ───────────────────────────────────────────────────────────────────

test('删除时把被删规则的内容记进审计（交接 1：删完库里就没有它了）', async () => {
  const doomed = rule({
    id: 12,
    kind: 'allow',
    effect: 'allow',
    subjectValue: 'svc-b',
    conds: [{ f: 'title', op: 'has', v: '董事会' }],
  })
  const policy = fakePolicyStore({ deleteRule: async () => doomed })
  const audit = fakeAuditStore()
  const res = await deleteRule(
    req('DELETE'),
    ctxOf({ policy: policy.store, audit: audit.store, params: { id: '12' } }),
  )
  expect(res.status).toBe(200)
  expect((await bodyOf(res)).rule).toMatchObject({ id: 12 })

  expect(audit.entries).toHaveLength(1)
  const e = audit.entries[0]!
  expect(e.action).toBe('rule_delete')
  expect(e.matchedRuleId).toBe(12)
  expect(e.assetType).toBe('allow')
  const snapshot = e.assetId ?? ''
  // 「它当时长什么样」：effect、主体、条件三样缺一样都答不出「为什么当时能取走」
  expect(snapshot).toContain('allow')
  expect(snapshot).toContain('svc-b')
  expect(snapshot).toContain('董事会')
  // audit_log.asset_id 是 VARCHAR(255)，写超了 MySQL 非严格模式会静默截断
  expect([...snapshot].length).toBeLessThanOrEqual(255)
})

test('审计的对象字段超过列宽时显式截断，不指望数据库替我们截', async () => {
  const huge = rule({
    id: 13,
    note: '很长的说明'.repeat(60),
    conds: Array.from({ length: 40 }, (_, i) => ({ f: 'title', op: 'has', v: `关键词${i}` })) as RuleCond[],
  })
  const policy = fakePolicyStore({ deleteRule: async () => huge })
  const audit = fakeAuditStore()
  await deleteRule(
    req('DELETE'),
    ctxOf({ policy: policy.store, audit: audit.store, params: { id: '13' } }),
  )
  const snapshot = audit.entries[0]!.assetId ?? ''
  expect([...snapshot].length).toBeLessThanOrEqual(255)
  // 截断必须看得见，否则读审计的人会以为那条规则本来就长这样
  expect(snapshot.endsWith('…')).toBe(true)
})

test('删一条不存在的规则：404，且不落审计——这次调用什么都没删掉', async () => {
  const policy = fakePolicyStore({ deleteRule: async () => null })
  const audit = fakeAuditStore()
  const res = await deleteRule(
    req('DELETE'),
    ctxOf({ policy: policy.store, audit: audit.store, params: { id: '99' } }),
  )
  expect(res.status).toBe(404)
  expect(audit.entries).toHaveLength(0)
})

// ── 影响预览 ─────────────────────────────────────────────────────────────

const FINANCE: MeetingSpec = { meetingId: 'm-1', title: '财务季度复盘' }
const TECH: MeetingSpec = { meetingId: 'm-2', title: '技术周会' }

function allowRule(over: Partial<AdminRule> = {}): AdminRule {
  return rule({ id: 1, kind: 'allow', effect: 'allow', subjectValue: 'svc-a', ...over })
}

test('预览一行都不落库（验收 1）：四个写方法一个都没被调用', async () => {
  // 四个写方法都没打桩，被调到就抛
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const audit = fakeAuditStore()
  const res = await previewRules(
    req('POST', { rules: [allowRule()] }),
    ctxOf({
      policy: policy.store,
      audit: audit.store,
      meetings: fakeConsoleMeetings([FINANCE, TECH]),
    }),
  )
  expect(res.status).toBe(200)
  expect(policy.calls.map((c) => c.method)).toEqual(['listAllRules'])
  // 预览不是写操作，也就不该产生审计噪音
  expect(audit.entries).toHaveLength(0)
})

test('预览算的是候选规则集与当前规则集的差，命中的会议数按 spec §5.5 收在改动够得着的范围内', async () => {
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const res = await previewRules(
    req('POST', { rules: [allowRule()] }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{ kind: StackKind; counts: Record<string, number> }>
  expect(stacks).toHaveLength(1)
  expect(stacks[0]!.kind).toBe('allow')
  // 两场会议 × 一个采集程序 = 2 个考察对象，但只有「财务」那场被这条规则够得着
  expect(stacks[0]!.counts.total).toBe(2)
  expect(stacks[0]!.counts.scanned).toBe(1)
  expect(stacks[0]!.counts.opened).toBe(1)
})

test('预览的琥珀警告来自 ImpactChange：此前判拒绝、现在要放行的会议才报（验收 3）', async () => {
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const res = await previewRules(
    req('POST', { rules: [allowRule()] }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const warnings = body.warnings as Array<{ level: string; code: string; meetings: Array<{ title: string }> }>
  expect(warnings).toHaveLength(1)
  expect(warnings[0]!.level).toBe('amber')
  expect(warnings[0]!.code).toBe('newly_opened')
  expect(warnings[0]!.meetings.map((m) => m.title)).toEqual(['财务季度复盘'])
})

test('本来就对外开放着的会议不出琥珀警告——那不是「从未对外开放过」', async () => {
  // 旧规则已经放行了这场会议，新规则只是把资产类型放宽
  const old = allowRule({ id: 1, assetTypes: ['ai_minutes'] })
  const next = allowRule({ id: 1, assetTypes: ['ai_minutes', 'transcript'] })
  const policy = fakePolicyStore({ listAllRules: async () => [old] })
  const res = await previewRules(
    req('POST', { rules: [next] }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{ counts: Record<string, number> }>
  expect(stacks[0]!.counts.opened).toBe(1)
  expect(body.warnings).toEqual([])
})

test('被人工改写挡住的会议进 shielded，不算「会被改变」（spec §5.4）', async () => {
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const res = await previewRules(
    req('POST', { rules: [allowRule()] }),
    ctxOf({
      policy: policy.store,
      meetings: fakeConsoleMeetings([{ ...FINANCE, hand: ['allow'] }, TECH]),
    }),
  )
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{ counts: Record<string, number> }>
  expect(stacks[0]!.counts.shielded).toBe(1)
  expect(stacks[0]!.counts.opened).toBe(0)
  // 结果不会变，就不该报「即将放行」的琥珀警告
  expect(body.warnings).toEqual([])
})

test('预览接受「只发一条草稿」的写法：合并进当前规则集，不用前端把整份规则回传', async () => {
  const existing = allowRule({ id: 1, effect: 'deny' })
  const policy = fakePolicyStore({ listAllRules: async () => [existing] })
  const res = await previewRules(
    req('POST', { rule: { ...existing, effect: 'allow' } }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{ counts: Record<string, number>; changedRuleIds: number[] }>
  expect(stacks[0]!.counts.opened).toBe(1)
  expect(stacks[0]!.changedRuleIds).toEqual([1])
})

test('预览删除一条规则：deleted 为真时把它从候选集里摘掉', async () => {
  const existing = allowRule({ id: 1, effect: 'allow' })
  const policy = fakePolicyStore({ listAllRules: async () => [existing] })
  const res = await previewRules(
    req('POST', { rule: { id: 1 }, deleted: true }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{ counts: Record<string, number> }>
  expect(stacks[0]!.counts.tightened).toBe(1)
})

test('预览报出这次只算了多少场会议，不假装算过全库', async () => {
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const res = await previewRules(
    req('POST', { rules: [allowRule()], limit: 1 }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH], 5000) }),
  )
  const body = await bodyOf(res)
  const scope = body.scope as Record<string, unknown>
  expect(scope.meetings).toBe(1)
  expect(scope.meetingsTotal).toBe(5000)
  expect(scope.truncated).toBe(true)
  expect(scope.programs).toEqual(['svc-a'])
})

test('候选规则里写坏的地方在预览里就说得出来，不必先存进去才知道', async () => {
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const res = await previewRules(
    // 条件字段拼错：一条永远不会命中任何会议的规则
    req('POST', { rules: [allowRule({ conds: [{ f: 'titel', op: 'has', v: '财务' }] })] }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const issues = body.candidateIssues as Array<{ id: number; issues: string[] }>
  expect(issues).toHaveLength(1)
  expect(issues[0]!.id).toBe(1)
  expect(issues[0]!.issues.length).toBeGreaterThan(0)
})

test('候选规则集不是数组时 400，不把一份垃圾当成「管理员把规则全删了」去预览', async () => {
  const policy = fakePolicyStore()
  const res = await previewRules(
    req('POST', { rules: 'oops' }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE]) }),
  )
  expect(res.status).toBe(400)
  expect((await bodyOf(res)).error).toBe('invalid_candidate_rules')
  expect(policy.calls).toHaveLength(0)
})

// ── 命中的会议 ───────────────────────────────────────────────────────────

test('命中列表只返回这条规则自身条件匹配的会议（§4.7 的「命中数」可点）', async () => {
  const policy = fakePolicyStore({ getRule: async () => allowRule() })
  const res = await ruleMatches(
    req('GET'),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]), params: { id: '1' } }),
  )
  expect(res.status).toBe(200)
  const body = await bodyOf(res)
  const matches = body.matches as Array<{ id: string; title: string }>
  expect(matches.map((m) => m.title)).toEqual(['财务季度复盘'])
  expect((body.scope as Record<string, unknown>).meetings).toBe(2)
})

test('命中列表：规则不存在是 404', async () => {
  const policy = fakePolicyStore({ getRule: async () => null })
  const res = await ruleMatches(
    req('GET'),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE]), params: { id: '77' } }),
  )
  expect(res.status).toBe(404)
})

test('命中列表：停用的规则照样能看命中哪几场——它开回来会命中什么，得先看得见', async () => {
  const policy = fakePolicyStore({ getRule: async () => allowRule({ enabled: false }) })
  const res = await ruleMatches(
    req('GET'),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]), params: { id: '1' } }),
  )
  expect(res.status).toBe(200)
  expect((await bodyOf(res)).matches).toHaveLength(1)
})

// ── 路由 ─────────────────────────────────────────────────────────────────

test('六条路由真的挂在 router 上：派发得到 handler（401），而不是掉进 404', async () => {
  // 用同一套假依赖直接建 app——这一条验的是 router.ts 里那六行，不需要数据库。
  // 401 说明请求走到了 requireAdminAuth，也就是路由匹配上了；404 才是没挂上
  const app = createApp(ctxOf().deps)
  const routes: Array<[string, string]> = [
    ['GET', '/api/v1/admin/rules'],
    ['POST', '/api/v1/admin/rules'],
    ['POST', '/api/v1/admin/rules/preview'],
    ['GET', '/api/v1/admin/rules/12/matches'],
    ['PATCH', '/api/v1/admin/rules/12'],
    ['DELETE', '/api/v1/admin/rules/12'],
  ]
  for (const [method, path] of routes) {
    const res = await app(new Request(`https://gw.example${path}`, { method }))
    expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 401`)
  }
})

test('POST /rules/preview 不会被 POST /rules 吃掉——两条路径各归各的 handler', async () => {
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const app = createApp(
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE]) }).deps,
  )
  const res = await app(
    new Request('https://gw.example/api/v1/admin/rules/preview', {
      method: 'POST',
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=t`, 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [allowRule()] }),
    }),
  )
  expect(res.status).toBe(200)
  // 走的是预览（只读 listAllRules），不是新建
  expect(policy.calls.map((c) => c.method)).toEqual(['listAllRules'])
})
