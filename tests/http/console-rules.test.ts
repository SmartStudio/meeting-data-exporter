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
import { AUDIT_DETAIL_MAX_CHARS, type AuditEntry, type AuditStore } from '../../src/store/audit'
import type { ConsoleMeetingRow, ConsoleMeetingsStore, HandKind } from '../../src/store/console-meetings'
import { consoleMeetingId } from '../../src/store/console-meetings'
import type { Meeting } from '../../src/domain/types'
import type { RuleCond } from '../../src/policy/conds'
import type { StackKind } from '../../src/policy/stacks'

const NOW = 1_700_000_000
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }

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
    async revokeOtherSessionsFor() {
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
    hostName: null,
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
    recordType: 0,
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
  // asset_id 是这次动作的**对象键**，不再拿它当快照的容器（T15）
  expect(e.assetId).toBe('rule:7')
  // 快照完整落在 detail 里：第一行人话，第二行是这条规则的全部字段
  const [head, ...rest] = (e.detail ?? '').split('\n')
  expect(head).toContain('#7')
  const snapshot = JSON.parse(rest.join('\n')) as { rule: Record<string, unknown> }
  expect(snapshot.rule).toMatchObject({
    kind: 'allow',
    effect: 'allow',
    subjectValue: 'svc-a',
    note: '财务会议给数据组',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })
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
  // spec §4.10：被拒绝的记录要写明拒绝原因。逐条 issues 从前只回给了前端，
  // 审计这一侧一个字都没留——detail 装得下之后就不该再丢
  const detail = audit.entries[0]!.detail ?? ''
  expect(detail.split('\n')[0]).toContain(issues[0]!)
  expect(JSON.parse(detail.split('\n').slice(1).join('\n')).issues).toEqual(issues)
})

test('请求体不是 JSON 时 400，不把 undefined 喂给 store', async () => {
  const policy = fakePolicyStore()
  const res = await createRule(req('POST', 'not json at all'), ctxOf({ policy: policy.store }))
  expect(res.status).toBe(400)
  expect((await bodyOf(res)).error).toBe('invalid_json')
  expect(policy.calls).toHaveLength(0)
})

// ── 改 ───────────────────────────────────────────────────────────────────

test('改内容走 updateRule，审计记下改动前后的完整两版（不再只记变了的字段）', async () => {
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
  expect(e.assetId).toBe('rule:3')

  const [head, ...rest] = (e.detail ?? '').split('\n')
  // 「谁把这条规则从 deny 改成 allow」必须一眼读得出来
  expect(head).toContain('effect')
  const d = JSON.parse(rest.join('\n')) as {
    changed: string[]
    before: Record<string, unknown>
    after: Record<string, unknown>
  }
  expect(d.changed).toEqual(['effect'])
  expect(d.before.effect).toBe('deny')
  expect(d.after.effect).toBe('allow')
  // 没改的字段现在也一起记：detail 装得下之后，「改完之后这条规则长什么样」
  // 就不该再靠翻另一张表去拼
  expect(d.before.note).toBe('先关着')
  expect(d.after.note).toBe('先关着')
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
  expect(e.assetId).toBe('rule:12')
  const snapshot = e.detail ?? ''
  // 「它当时长什么样」：effect、主体、条件三样缺一样都答不出「为什么当时能取走」
  expect(snapshot).toContain('allow')
  expect(snapshot).toContain('svc-b')
  expect(snapshot).toContain('董事会')
})

test('一条大规则的快照完整落进 detail，不再被 255 字符切掉', async () => {
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
  const snapshot = audit.entries[0]!.detail ?? ''
  expect([...snapshot].length).toBeGreaterThan(255)
  // 首尾两个条件都在——从前第 3 个条件之后就被截没了
  expect(snapshot).toContain('关键词0')
  expect(snapshot).toContain('关键词39')
  expect(snapshot).toContain('很长的说明')
  expect(snapshot).not.toContain('已截断')
})

test('detail 也不是无限：超上限时截断并留痕，且人话在头部先被保住', async () => {
  const monstrous = rule({
    id: 14,
    // 远超 AUDIT_DETAIL_MAX_CHARS，逼出截断
    note: '甲'.repeat(AUDIT_DETAIL_MAX_CHARS * 2),
  })
  const policy = fakePolicyStore({ deleteRule: async () => monstrous })
  const audit = fakeAuditStore()
  await deleteRule(
    req('DELETE'),
    ctxOf({ policy: policy.store, audit: audit.store, params: { id: '14' } }),
  )
  const snapshot = audit.entries[0]!.detail ?? ''
  expect([...snapshot].length).toBe(AUDIT_DETAIL_MAX_CHARS)
  // 截断这件事本身写在记录里——把截断从一列挪到另一列还不说，比不挪更糟
  expect(snapshot).toContain('已截断')
  expect(snapshot.split('\n')[0]).toContain('#14')
})

test('明细组装失败也照样落下这一行审计——账本上不许因此少一次操作', async () => {
  // 一条 note 的 toJSON 会抛的规则。真实世界里 JSON.stringify 抛的路子有好几条
  // （循环引用、BigInt、抛异常的 toJSON），共同点是：它抛在**组装明细**这一步，
  // 而这一步失败绝不该把「谁删了哪条规则」这个事实一起带走。
  // audit_log 是数据出境的唯一账本（spec §1.4 / §4.10）。
  //
  // 只炸第一次（也就是组装审计明细那一次）：这条用例盯的是审计这一侧，
  // 响应体序列化炸不炸是另一件事，不该混进来。
  let armed = true
  const mine = {
    toJSON(): string {
      if (!armed) return '(已排雷)'
      armed = false
      throw new Error('明细里埋了个雷')
    },
  }
  const cursed = rule({ id: 15, note: mine as unknown as string })
  const policy = fakePolicyStore({ deleteRule: async () => cursed })
  const audit = fakeAuditStore()

  const res = await deleteRule(
    req('DELETE'),
    ctxOf({ policy: policy.store, audit: audit.store, params: { id: '15' } }),
  )

  expect(res.status).toBe(200)
  expect(audit.entries).toHaveLength(1)
  const e = audit.entries[0]!
  expect(e.action).toBe('rule_delete')
  expect(e.matchedRuleId).toBe(15)
  // 人话那一行完好——「谁在什么时候删了 #15」照样答得出
  expect(e.detail!.split('\n')[0]).toBe('删除规则 #15')
  // 附文没了这件事本身也留痕，不是悄悄少一段
  expect(e.detail).toContain('附文序列化失败')
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

test('原样打开一条已有规则：预览报得出「现在命中多少场」，而不是「没有够得着任何会议」', async () => {
  // 编辑器打开一条已有规则时发的就是这个：候选与库里那条逐字相同，一个字都没改。
  // 此时若按「只从改动过的规则张开范围」算，范围是空的，预览会说「没有够得着任何会议」——
  // 而同一屏的规则列表正显示着这条规则命中 1 场。两处口径相同，不许给出两个数
  const existing = allowRule({ id: 1 })
  const policy = fakePolicyStore({ listAllRules: async () => [existing] })
  const res = await previewRules(
    req('POST', { rule: existing, kind: 'allow' }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  expect(res.status).toBe(200)
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{
    counts: Record<string, number>
    changedRuleIds: number[]
    summary: string
  }>
  expect(stacks).toHaveLength(1)
  expect(stacks[0]!.counts.hits).toBe(1)
  expect(stacks[0]!.counts.scanned).toBe(1)
  // 一个字都没改，就不能报成「这次改动涉及的规则」
  expect(stacks[0]!.changedRuleIds).toEqual([])
  expect(stacks[0]!.summary).toContain('还没有改动')
  expect(stacks[0]!.summary).not.toContain('这次')
})

test('原样打开、不带 kind：零改动也要返回这条规则所在的那一栈', async () => {
  // 不带 kind 时派发按「这次动了哪几栈」算；一个字没改就是零栈，
  // 调用方会拿到一份没有任何 stacks 的响应，连「现在命中多少场」都没有
  const existing = allowRule({ id: 1 })
  const policy = fakePolicyStore({ listAllRules: async () => [existing] })
  const res = await previewRules(
    req('POST', { rule: existing }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  expect(res.status).toBe(200)
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{ kind: string; counts: Record<string, number> }>
  expect(stacks.map((s) => s.kind)).toEqual(['allow'])
  expect(stacks[0]!.counts.hits).toBe(1)
})

test('原样打开的坏规则也报问题：不必先存一次才知道自己打开的规则本来就是坏的', async () => {
  // 一条准许采集、却一个资产类型都没勾的规则：实际一类都取不到
  const broken = allowRule({ id: 1, assetTypes: [] })
  const policy = fakePolicyStore({ listAllRules: async () => [broken] })
  const res = await previewRules(
    req('POST', { rule: broken, kind: 'allow' }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const issues = body.candidateIssues as Array<{ id: number; issues: string[] }>
  expect(issues.map((i) => i.id)).toEqual([1])
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

// ── 兼容兜底翻面的琥珀警告（阶段 4 · T16）────────────────────────────────

function fetchRule(over: Partial<AdminRule> = {}): AdminRule {
  return rule({
    id: 1, kind: 'fetch', effect: 'all', assetTypes: ['*'],
    subjectType: null, subjectValue: null, note: '财务会议要拉',
    ...over,
  })
}

test('建第一条拉取规则时报琥珀：库里零条规则 = 兼容兜底全拉，这一条会给整条链路装闸门', async () => {
  // 库里一条拉取规则都没有 ⇒ worker 走兼容兜底「时间窗内全拉」，两场都在被拉。
  // 这条只命中财务的规则一落地，技术周会就不再被拉——预览不说，管理员看不出来
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const res = await previewRules(
    req('POST', { rules: [fetchRule()] }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)

  const stacks = body.stacks as Array<{ kind: StackKind; counts: Record<string, number> }>
  expect(stacks[0]!.kind).toBe('fetch')
  // 财务那场本来就在拉，这条规则没「新增」什么
  expect(stacks[0]!.counts.opened).toBe(0)
  expect(stacks[0]!.counts.tightened).toBe(1)

  const warnings = body.warnings as Array<{ level: string; code: string; text: string; meetings: Array<{ title: string }> }>
  expect(warnings).toHaveLength(1)
  expect(warnings[0]!.level).toBe('amber')
  expect(warnings[0]!.code).toBe('fetch_compat_off')
  expect(warnings[0]!.meetings.map((m) => m.title)).toEqual(['技术周会'])
  expect(warnings[0]!.text).toContain('兼容兜底')
})

test('第一条拉取规则是无条件全拉时不报琥珀——那是推荐的上线路径，不该弹假警报', async () => {
  const policy = fakePolicyStore({ listAllRules: async () => [] })
  const res = await previewRules(
    req('POST', { rules: [fetchRule({ conds: [], note: '把现状显式化：无条件全拉' })] }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{ counts: Record<string, number> }>
  expect(stacks[0]!.counts.tightened).toBe(0)
  expect(stacks[0]!.counts.deciderOnly).toBe(2)
  expect(body.warnings).toEqual([])
})

test('库里已经有启用的拉取规则时不报琥珀：兜底没翻面，收紧就是管理员自己要的', async () => {
  const base = fetchRule({ id: 1, priority: 10, effect: 'all', conds: [], note: '兜底全拉' })
  const finance = fetchRule({
    id: 2, priority: 200, effect: 'skip', note: '财务会议不落本地',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })
  const policy = fakePolicyStore({ listAllRules: async () => [base] })
  const res = await previewRules(
    req('POST', { rules: [base, finance] }),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  const body = await bodyOf(res)
  const stacks = body.stacks as Array<{ counts: Record<string, number> }>
  expect(stacks[0]!.counts.tightened).toBe(1)
  expect(body.warnings).toEqual([])
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

// ── 列表的 matchCount / matchScanned（改版：命中数直接进列表，不必再点开 /matches）───

/** `list` / `getMeetings` 各自被调用了几次——证明列表端点只扫一遍会议全集 */
function countingConsoleMeetings(specs: MeetingSpec[]): {
  store: ConsoleMeetingsStore
  calls: { list: number; getMeetings: number }
} {
  const base = fakeConsoleMeetings(specs)
  const calls = { list: 0, getMeetings: 0 }
  return {
    calls,
    store: {
      ...base,
      async list(q) {
        calls.list += 1
        return base.list(q)
      },
      async getMeetings(keys) {
        calls.getMeetings += 1
        return base.getMeetings(keys)
      },
    },
  }
}

/** 会议全集怎么问都问不到——模拟库不可达 */
function unreachableConsoleMeetings(): ConsoleMeetingsStore {
  return {
    async list() {
      throw new Error('meetings store unreachable')
    },
    async triage() {
      throw new Error('triage 不该被规则 API 调用')
    },
    async get() {
      throw new Error('get 不该被规则 API 调用')
    },
    async getMeetings() {
      throw new Error('meetings store unreachable')
    },
  }
}

test('列表：停用的规则也算得出 matchCount——不按 enabled 过滤', async () => {
  const rows: AdminRule[] = [allowRule({ id: 1, enabled: true }), allowRule({ id: 2, enabled: false })]
  const policy = fakePolicyStore({ listAllRules: async () => rows })
  const res = await listRules(
    req('GET'),
    ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
  )
  expect(res.status).toBe(200)
  const list = (await bodyOf(res)).rules as Array<AdminRule & { matchCount: number; matchScanned: number }>
  // allowRule() 的默认 conds 是「title has 财务」，只有 FINANCE 命中
  expect(list[0]!).toMatchObject({ id: 1, matchCount: 1, matchScanned: 2 })
  expect(list[1]!).toMatchObject({ id: 2, enabled: false, matchCount: 1, matchScanned: 2 })
})

test(
  '列表：conds 是合法空数组的规则——evaluateRule 判"没有条件，匹配全部"，' +
    'matchCount 必须等于 matchScanned（如实反映沉默放行的危险信号，不许因为"不合理"就改成 0）',
  async () => {
    const rows: AdminRule[] = [rule({ id: 3, conds: [] })]
    const policy = fakePolicyStore({ listAllRules: async () => rows })
    const res = await listRules(
      req('GET'),
      ctxOf({ policy: policy.store, meetings: fakeConsoleMeetings([FINANCE, TECH]) }),
    )
    const list = (await bodyOf(res)).rules as Array<{ matchCount: number; matchScanned: number }>
    expect(list[0]!.matchCount).toBe(2)
    expect(list[0]!.matchScanned).toBe(2)
    expect(list[0]!.matchCount).toBe(list[0]!.matchScanned)
  },
)

test(
  '列表：conds 不是数组（JSON 列解析失败）的规则——store 的 CONDS_UNPARSABLE 兜底' +
    '不是数组，evaluateRule 判 matched:false，matchCount 是 0。' +
    '这与 GET /:id/matches 对同一条规则给出的空列表是同一件事，口径必须一致',
  async () => {
    const broken = rule({ id: 4, conds: 'oops' as unknown as RuleCond[] })
    const policy = fakePolicyStore({
      listAllRules: async () => [broken],
      getRule: async () => broken,
    })
    const meetings = fakeConsoleMeetings([FINANCE, TECH])

    const listRes = await listRules(req('GET'), ctxOf({ policy: policy.store, meetings }))
    const list = (await bodyOf(listRes)).rules as Array<{ matchCount: number; matchScanned: number }>
    expect(list[0]!.matchCount).toBe(0)
    expect(list[0]!.matchScanned).toBe(2)

    const matchesRes = await ruleMatches(
      req('GET'),
      ctxOf({ policy: policy.store, meetings, params: { id: '4' } }),
    )
    expect((await bodyOf(matchesRes)).matches).toEqual([])
  },
)

test('列表：12 条规则只扫一遍会议全集，不是 12 次数据库往返', async () => {
  const rows: AdminRule[] = Array.from({ length: 12 }, (_, i) => allowRule({ id: i + 1 }))
  const policy = fakePolicyStore({ listAllRules: async () => rows })
  const meetings = countingConsoleMeetings([FINANCE, TECH])
  const res = await listRules(req('GET'), ctxOf({ policy: policy.store, meetings: meetings.store }))
  expect(res.status).toBe(200)
  const list = (await bodyOf(res)).rules as unknown[]
  expect(list).toHaveLength(12)
  // scanMeetings 内部发两条查询（列一页 + 批量取元数据），与规则条数无关——
  // 12 条规则算完命中数，这两条各自也还是只被调用一次
  expect(meetings.calls.list).toBe(1)
  expect(meetings.calls.getMeetings).toBe(1)
})

test(
  '列表：会议全集取不到时（库不可达）规则列表本身照常返回，' +
    'matchCount / matchScanned 一律是 null，不是 0——0 会被当成"真的一场没命中"去删规则',
  async () => {
    const rows: AdminRule[] = [allowRule({ id: 1 }), allowRule({ id: 2, enabled: false })]
    const policy = fakePolicyStore({ listAllRules: async () => rows })
    const res = await listRules(
      req('GET'),
      ctxOf({ policy: policy.store, meetings: unreachableConsoleMeetings() }),
    )
    expect(res.status).toBe(200)
    const list = (await bodyOf(res)).rules as Array<{ matchCount: number | null; matchScanned: number | null }>
    expect(list).toHaveLength(2)
    for (const r of list) {
      expect(r.matchCount).toBeNull()
      expect(r.matchScanned).toBeNull()
    }
  },
)

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
