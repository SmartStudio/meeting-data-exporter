/**
 * 规则 API + 影响预览（阶段 4 · T6，A3 的一部分）。
 *
 * ```
 * GET    /api/v1/admin/rules              列出三栈（含 disabled）
 * POST   /api/v1/admin/rules              新建
 * PATCH  /api/v1/admin/rules/:id          改（含启用 / 停用）
 * DELETE /api/v1/admin/rules/:id          删
 * POST   /api/v1/admin/rules/preview      影响预览（**不落库**）
 * GET    /api/v1/admin/rules/:id/matches  这条规则命中哪几场（§4.7 的「命中数」可点）
 * ```
 *
 * ## 这一层做什么、不做什么
 *
 * 规则的校验、事务、排序**一概不在这里**：`src/store/policy.ts`（T2）与
 * `src/policy/`（阶段 3）已经有唯一的一份实现，这个文件一行都不重写。handler 做的是
 * 四件胶水：**认身份**、**把 store 的三条出口映成状态码**、**记审计**、
 * **把预览要的会议全集喂给 `previewStackImpact`**。
 *
 * store 的三条出口按 T2 的交接分得很清，合并任何两条都会丢信息：
 *
 * | store 的返回 | 意思 | HTTP |
 * | --- | --- | --- |
 * | 正常返回 `AdminRule` | 写成了 | 200 / 201 |
 * | 拒绝 promise（`PolicyRuleInvalid`） | 内容不合法，一行都没落库 | **400** + 逐条 issues |
 * | 返回 `null` | 这条规则不存在 | **404** |
 *
 * `PolicyRuleInvalid.issues` 是逐条中文描述且校验不短路（一次把能说的都说完），
 * 所以原样下发给规则编辑器逐条标红，这里**不做二次加工、不挑一条当 message**。
 *
 * ## 审计由这一层落，不在 store 里落（计划 §1 约束 6）
 *
 * `PolicyStore` 拿不到操作者身份——它只有一个连接池。而 spec §4.10 要回答的是
 * 「**谁**把这条规则从 deny 改成 allow」，那是数据出境闸门的开关。所以四个动作
 * （`rule_create` / `rule_update` / `rule_delete` / `rule_toggle`）在这里各落一行。
 *
 * **`deleteRule` 返回被删规则的完整内容而不是布尔，就是为这一行准备的**：
 * `policy_rules` 没有软删除列，删完这条规则在库里就不存在了，「它当时长什么样」
 * 只能由这一行记住。
 *
 * ### 一处与计划对不上的地方，裁定记在这里
 *
 * `audit_log` 没有放得下一条完整规则的列：能用的只有 `asset_id VARCHAR(255)`。
 * 加一列 `detail TEXT` 才是正解，但迁移编号在本波次里已经分给了 T4（007）与
 * T11（008），一个 handler 任务顺手插一个迁移号进去，合并时是最难拆的那种冲突。
 * 因此这里的裁定是：**快照写成紧凑 JSON，超列宽显式截断并留下 `…` 标记**
 * （见 `fitAuditColumn`），而不是指望 MySQL 非严格模式替我们静默截断——
 * 截掉一半又看不出被截过的审计记录，比没有更糟。
 * 改规则只记**真的变了的那几个字段的前后两版**（见 `diffShape`），255 个字符
 * 因此几乎总是够用：它要回答的问题就是「哪个字段被谁改成了什么」。
 *
 * 被校验挡下的写入也记一行，`decision = 'deny'`：审计流要答得出「谁试过把闸门改开」。
 * 规则不存在（404）不记——那次调用什么都没碰到，记一行只是噪音。
 *
 * ### 时间单位：写 unix 秒
 *
 * T2 的报错文案曾写成「毫秒时间戳」（其校验只要求正整数，秒同样过得去），已改对。
 * `policy_rules.created_at / updated_at` 至今**没有任何读取方**，
 * 单位是由第一个写入方定的，也就是这里。仓库其余全部时间列是 unix 秒
 * （`audit_log.occurred_at` 也是，见 `src/index.ts` 的 `now()`），前端契约
 * （`console/src/api/types.ts` 开头）明写「所有时间字段都是 unix 秒」。
 * 写毫秒的话规则页会把建立时间渲染成公元 55841 年。**所以取秒，与全仓一致。**
 */

import type { AdminIdentity } from '../../../auth/admin'
import { matchesRule, type MeetingFacts, type RuleCond } from '../../../policy/conds'
import { meetingFacts } from '../../../policy/access'
import {
  changedStackKinds,
  previewStackImpact,
  type ImpactChange,
  type PreviewSubject,
  type StackImpactPreview,
} from '../../../policy/preview'
import { describeStackRuleIssues, type StackDecision, type StackKind, type StackRule } from '../../../policy/stacks'
import type { AuditEntry } from '../../../store/audit'
import {
  consoleMeetingId,
  type ConsoleMeetingRow,
  type HandKind,
} from '../../../store/console-meetings'
import { PolicyRuleInvalid, type AdminRule, type RuleDraft, type RulePatch } from '../../../store/policy'
import { requireAdminAuth } from '../../middleware'
import { json, readJson } from '../../respond'
import type { RouteCtx } from '../../router'

const STACK_KINDS: readonly StackKind[] = ['fetch', 'archive', 'allow']

function isStackKind(v: unknown): v is StackKind {
  return typeof v === 'string' && (STACK_KINDS as readonly string[]).includes(v)
}

// ── 审计 ──────────────────────────────────────────────────────────────────

/** `audit_log.asset_id` 的列宽。快照写在这一列里 */
const AUDIT_OBJECT_MAX = 255
/** `audit_log.asset_type` 的列宽。这里存的是栈名 */
const AUDIT_KIND_MAX = 64

type RuleAction = 'rule_create' | 'rule_update' | 'rule_delete' | 'rule_toggle'

/**
 * 按**码点**截断，与 MySQL 的 VARCHAR(n) 一致（JS 的 `.length` 数的是 UTF-16 码元，
 * 一个 emoji 会算成 2）。截断必须看得见——留一个 `…`，否则读审计的人会以为
 * 那条规则本来就长这样。
 */
function fitAuditColumn(s: string, max: number): string {
  const chars = [...s]
  if (chars.length <= max) return s
  return `${chars.slice(0, max - 1).join('')}…`
}

/** 一条规则里会改变判定或说明的那几个字段。`id` 单独记在 `matched_rule` 列里 */
const SHAPE_FIELDS = [
  'kind',
  'priority',
  'enabled',
  'join',
  'conds',
  'subjectType',
  'subjectValue',
  'assetTypes',
  'effect',
  'note',
] as const

type ShapeField = (typeof SHAPE_FIELDS)[number]
type RuleShape = Partial<Record<ShapeField, unknown>>

function shapeOf(rule: Pick<StackRule, ShapeField>): RuleShape {
  const out: RuleShape = {}
  for (const f of SHAPE_FIELDS) out[f] = rule[f]
  return out
}

/**
 * 只留**真的变了**的字段的前后两版。
 *
 * 不是为了好看：`asset_id` 只有 255 个字符，把没改的 conds 与 note 一起塞进去，
 * 真正改掉的那个字段就会被挤到截断线外面——而它正是这一行审计存在的理由。
 */
function diffShape(
  before: Pick<StackRule, ShapeField>,
  after: Pick<StackRule, ShapeField>,
): { was: RuleShape; now: RuleShape } {
  const was: RuleShape = {}
  const now: RuleShape = {}
  for (const f of SHAPE_FIELDS) {
    if (JSON.stringify(before[f]) === JSON.stringify(after[f])) continue
    was[f] = before[f]
    now[f] = after[f]
  }
  return { was, now }
}

interface RuleAuditInput {
  action: RuleAction
  /** 这次写操作成没成立。不成立（校验拒绝）也记，结果是 deny */
  ok: boolean
  /** 哪一栈。脏值照原样记——记一个不认识的栈名，比记一个我们替它编的正确栈名有用 */
  kind: unknown
  /** 哪一条。新建被拒时没有 id */
  ruleId: number | null
  /** 快照。`{ now }` = 现在长这样，`{ was }` = 当时长这样，两个都有 = 改动前后 */
  object: unknown
}

async function recordRuleAudit(
  ctx: RouteCtx,
  identity: AdminIdentity,
  input: RuleAuditInput,
): Promise<void> {
  const entry: AuditEntry = {
    occurredAt: ctx.deps.now(),
    actorType: 'admin',
    actorId: identity.adminId,
    action: input.action,
    // 规则不是针对某一场会议的，这一列留空。哪一栈的哪一条见 assetType / matchedRuleId
    meetingId: null,
    assetId: fitAuditColumn(JSON.stringify(input.object), AUDIT_OBJECT_MAX),
    assetType: fitAuditColumn(String(input.kind), AUDIT_KIND_MAX),
    // 管理侧的 decision 读作「这次操作成没成立」，与网关侧的「放行 / 拒绝」是
    // 同一列的两种读法（`recordLogin` 早有先例：它用这一列记登录成没成功）
    decision: input.ok ? 'allow' : 'deny',
    matchedRuleId: input.ruleId,
    clientKind: 'console',
  }
  await ctx.deps.auditStore.record(entry)
}

// ── 入参 ──────────────────────────────────────────────────────────────────

type Body = Record<string, unknown>

function has(body: Body, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

/**
 * 路径上的规则 id。**不接受 NaN**：`Number('abc')` 是 NaN，拿它去查库会得到一条
 * 「规则不存在」的 404，把一个明显的客户端错误说成了服务端的事实。
 */
function parseRuleId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * 请求体里的字段**尽量原样往下传**，不在这里先做一遍「清洗」。
 *
 * 清洗等于替管理员改他填的东西：把 `effect: 'allwo'` 悄悄改成 `'deny'`、把
 * 非数组的 conds 兜底成 `[]`（= 匹配一切），两者都会让 `validateDraft` 再也报不出
 * 那条逐字的中文问题，而那条问题正是规则编辑器要标红的内容。
 * 只有两处例外，理由各自写在旁边。
 */
function draftFromBody(body: Body, identity: AdminIdentity, now: number): RuleDraft & { now: number } {
  return {
    kind: body.kind as StackKind,
    priority: body.priority as number,
    join: body.join as 'and' | 'or',
    conds: body.conds as RuleCond[],
    subjectType: (body.subjectType ?? null) as string | null,
    subjectValue: (body.subjectValue ?? null) as string | null,
    assetTypes: body.assetTypes as string[],
    effect: body.effect as string,
    // 例外一：`undefined` 必须变成 `null`。校验对「没填 note」是放行的，
    // 而 mysql2 的占位符收到 undefined 会直接抛——一个能过校验的请求
    // 不该在 INSERT 那一刻炸成 500
    note: body.note === undefined ? null : (body.note as string | null),
    // 例外二：建立人**只能是当前登录的管理员**，请求体里写什么都不算。
    // 否则审计里的「谁建的」可以随便填，而这正是这一列存在的理由
    createdBy: identity.adminId,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    now,
  }
}

/** 可改的字段。`createdBy` 不在里面：那一列记的是「谁建的」，改不得（T2 的 `RulePatch` 已把它排除） */
const PATCHABLE = [
  'kind',
  'priority',
  'join',
  'conds',
  'subjectType',
  'subjectValue',
  'assetTypes',
  'effect',
  'note',
  'enabled',
] as const

/**
 * 只把**请求体里真的出现过**的字段放进 patch。
 *
 * 「没填的字段」与「填了空」必须分得开：`updateRule` 用 `!== undefined` 判断要不要
 * 覆盖，一旦把没填的字段也铺成 `undefined` 之外的值，一次「只改 effect」的提交
 * 会把 note 和 conds 一起清掉。
 */
function patchFromBody(body: Body, now: number): RulePatch {
  const patch: RulePatch = { now }
  for (const key of PATCHABLE) {
    if (!has(body, key)) continue
    ;(patch as Record<string, unknown>)[key] = body[key]
  }
  return patch
}

function patchedFields(patch: RulePatch): string[] {
  return Object.keys(patch).filter((k) => k !== 'now')
}

// ── 端点：读 ──────────────────────────────────────────────────────────────

export async function listRules(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const raw = new URL(req.url).searchParams.get('kind')
  if (raw !== null && !isStackKind(raw)) {
    // 认不出的栈名不能当成「不筛选」：那会把三栈全部返回，而调用方以为自己
    // 拿到的是某一栈——`AuditQuery` 的文件头把这类静默放大讲得很清楚
    return json(400, { error: 'unknown_stack_kind', allowed: STACK_KINDS })
  }
  const kind = raw === null ? undefined : raw
  // `listAllRules` 含 disabled 的规则，位置就在它启用时会站的那一格：
  // 停用一条之后它必须还在界面上，否则再也开不回来
  const rules = await ctx.deps.policyStore.listAllRules(kind)
  return json(200, { rules })
}

// ── 端点：写 ──────────────────────────────────────────────────────────────

export async function createRule(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const body = await readJson<Body>(req)
  if (body === null || typeof body !== 'object') return json(400, { error: 'invalid_json' })

  const draft = draftFromBody(body, auth.identity, ctx.deps.now())
  try {
    const created = await ctx.deps.policyStore.createRule(draft)
    await recordRuleAudit(ctx, auth.identity, {
      action: 'rule_create',
      ok: true,
      kind: created.kind,
      ruleId: created.id,
      object: { id: created.id, now: shapeOf(created) },
    })
    return json(201, { rule: created })
  } catch (err) {
    if (!(err instanceof PolicyRuleInvalid)) throw err
    await recordRuleAudit(ctx, auth.identity, {
      action: 'rule_create',
      ok: false,
      kind: draft.kind,
      ruleId: null,
      object: { rejected: shapeOf(draft as unknown as Pick<StackRule, ShapeField>) },
    })
    return json(400, { error: 'rule_invalid', issues: err.issues })
  }
}

export async function patchRule(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const id = parseRuleId(ctx.params.id)
  if (id === null) return json(400, { error: 'invalid_rule_id' })

  const body = await readJson<Body>(req)
  if (body === null || typeof body !== 'object') return json(400, { error: 'invalid_json' })

  const patch = patchFromBody(body, ctx.deps.now())
  const fields = patchedFields(patch)
  if (fields.length === 0) return json(400, { error: 'empty_patch', patchable: PATCHABLE })

  // 改动前的那一版，只为审计里的「从什么改成什么」。并发保护不靠这次读——
  // `updateRule` 内部有 `SELECT ... FOR UPDATE`，两个管理员同时改不会互相覆盖。
  // 这里读到的是「提交那一刻我们看到的旧版」，审计记的也正是这个。
  const before = await ctx.deps.policyStore.getRule(id)
  if (before === null) return json(404, { error: 'rule_not_found' })

  // 只改 enabled 时走 setEnabled，而不是让它顺路经过 updateRule 的整体校验。
  // **这不是为了少写一个端点**：`setEnabled` 故意不做内容校验，因为出事时
  // 「把这条规则关掉」是唯一能立刻止血的动作——若它也要先过校验，恰恰是最该关掉的
  // 那条坏规则会变成关不掉的。走 updateRule 就把这个保证丢了。
  if (fields.length === 1 && fields[0] === 'enabled') {
    const enabled = body.enabled === true
    const toggled = await ctx.deps.policyStore.setEnabled(id, enabled, ctx.deps.now())
    if (toggled === null) return json(404, { error: 'rule_not_found' })
    await recordRuleAudit(ctx, auth.identity, {
      action: 'rule_toggle',
      ok: true,
      kind: toggled.kind,
      ruleId: toggled.id,
      object: { id: toggled.id, was: { enabled: before.enabled }, now: { enabled: toggled.enabled } },
    })
    return json(200, { rule: toggled })
  }

  try {
    const updated = await ctx.deps.policyStore.updateRule(id, patch)
    // 读到了、改的时候没了：并发删除。仍然是 404（这次调用没改到任何东西），
    // 不是 500——服务端一切正常，只是那条规则已经不在了
    if (updated === null) return json(404, { error: 'rule_not_found' })
    const { was, now } = diffShape(before, updated)
    await recordRuleAudit(ctx, auth.identity, {
      action: 'rule_update',
      ok: true,
      kind: updated.kind,
      ruleId: updated.id,
      object: { id: updated.id, was, now },
    })
    return json(200, { rule: updated })
  } catch (err) {
    if (!(err instanceof PolicyRuleInvalid)) throw err
    await recordRuleAudit(ctx, auth.identity, {
      action: 'rule_update',
      ok: false,
      kind: has(body, 'kind') ? body.kind : before.kind,
      ruleId: id,
      object: { id, was: shapeOf(before), rejected: fields },
    })
    return json(400, { error: 'rule_invalid', issues: err.issues })
  }
}

export async function deleteRule(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const id = parseRuleId(ctx.params.id)
  if (id === null) return json(400, { error: 'invalid_rule_id' })

  // 返回的是**被删掉的那条规则的完整内容**（T2 交接 1）。`policy_rules` 没有软删除列，
  // 这一刻之后「它当时长什么样」只存在于下面这条审计里
  const deleted = await ctx.deps.policyStore.deleteRule(id)
  if (deleted === null) return json(404, { error: 'rule_not_found' })

  await recordRuleAudit(ctx, auth.identity, {
    action: 'rule_delete',
    ok: true,
    kind: deleted.kind,
    ruleId: deleted.id,
    object: { id: deleted.id, was: shapeOf(deleted) },
  })
  // 回一份被删的内容而不是 204：规则页要在「已删除」的提示里说清删掉的是哪一条，
  // 而这份内容库里已经没有了，再查一次也查不回来
  return json(200, { rule: deleted })
}

// ── 会议全集：预览与命中列表共用 ──────────────────────────────────────────

/** 一次预览 / 一次命中列表最多考察多少场会议。与 `ConsoleMeetingsStore.list` 的上限一致 */
const MEETING_SCAN_LIMIT = 500
/** 每个变化列表最多带回多少条明细。数字仍然是全量的，只有明细采样 */
const CHANGE_SAMPLE_LIMIT = 50

interface ScannedMeeting {
  row: ConsoleMeetingRow
  facts: MeetingFacts
}

interface MeetingScan {
  meetings: ScannedMeeting[]
  /** 库里一共有多少场（去掉分页后的总数） */
  total: number
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return MEETING_SCAN_LIMIT
  return Math.min(MEETING_SCAN_LIMIT, Math.max(1, Math.trunc(n)))
}

/**
 * 取一批会议并组装成求值器要的事实。
 *
 * **事实的组装走 `policy/access.ts` 的 `meetingFacts`，这里不自己拼**：
 * `Meeting.endTime` 在 `record_files` 全缺 `record_end_time` 时会回落成 `startTime`
 * 的镜像，必须显式判成「没有录制结束时间」，否则 `age before N` 会把这类会议
 * 恒命中。那段推理只该有一份实现（同 `src/worker/visibility.ts` 与 `archive.ts`）。
 *
 * 查不到元数据的会议**直接不参与**，不造空壳顶上——空壳会让一条 `title has 财务`
 * 的规则对着空标题判不匹配，预览于是报「不会影响任何会议」，看起来一切正常。
 *
 * 发出去的查询是**两条，与会议数无关**：列一页 + 批量取元数据。
 */
async function scanMeetings(ctx: RouteCtx, limit: number): Promise<MeetingScan> {
  const now = ctx.deps.now()
  const { rows, total } = await ctx.deps.consoleMeetings.list({ now, limit })
  const metas = await ctx.deps.consoleMeetings.getMeetings(
    rows.map((r) => ({ meetingId: r.meetingId, subMeetingId: r.subMeetingId })),
  )
  const byKey = new Map(metas.map((m) => [consoleMeetingId(m.meetingId, m.subMeetingId), m]))

  const meetings: ScannedMeeting[] = []
  for (const row of rows) {
    const meta = byKey.get(row.id)
    if (meta === undefined) continue
    // 「归档了没有」的事实源是 `meeting_archives` 有没有行，也就是 `keep.archivedAt`；
    // 不用 `row.archive`（那是阶段状态，含 running / failed 等与规则无关的取值）
    meetings.push({ row, facts: meetingFacts(meta, row.keep.archivedAt !== null) })
  }
  return { meetings, total }
}

// ── 影响预览 ──────────────────────────────────────────────────────────────

/**
 * 候选规则集里没给 id 的那条草稿用的合成 id。
 *
 * 取负数是刻意的：`policy_rules.id` 是自增主键，永远 ≥ 1，所以负 id 不可能与
 * 库里任何一条撞上——`diffRules` 按 id 分组，撞上就会把一条新规则误当成
 * 「某条老规则改过了」，预览出来的范围会连老规则命中的会议一起算进去。
 */
const DRAFT_RULE_ID = -1

/**
 * 请求体里的一条候选规则 → `StackRule`。
 *
 * 与 `draftFromBody` 同一条原则：**尽量原样传**。预览要显示的是「管理员真填了什么
 * 会发生什么」，把 `conds` 兜底成 `[]` 会让预览报出「匹配全部会议」，把 effect
 * 兜底成安全侧会让预览报出一次并不会发生的收紧——两种都是编。
 * 求值器与静态检查本来就吃得下脏值（`normalizeEffect` / `describeStackRuleIssues`）。
 */
function toStackRule(raw: unknown, index: number): StackRule {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Body
  const id = Number(r.id)
  return {
    id: Number.isInteger(id) ? id : DRAFT_RULE_ID - index,
    kind: r.kind as StackKind,
    priority: r.priority as number,
    enabled: r.enabled !== false,
    join: r.join as StackRule['join'],
    conds: r.conds as RuleCond[],
    subjectType: typeof r.subjectType === 'string' ? r.subjectType : null,
    subjectValue: typeof r.subjectValue === 'string' ? r.subjectValue : null,
    assetTypes: r.assetTypes as string[],
    effect: r.effect as string,
    note: typeof r.note === 'string' ? r.note : null,
  }
}

/**
 * 这次改动够得着哪些采集程序。
 *
 * **这不是近似，是完全的**：`evaluateAllowStack` 对一个没有任何规则点名的程序，
 * 一定走兜底 deny（主体不符的规则会被显式跳过）。所以一个既不在旧规则集、也不在
 * 新规则集里出现的程序，它的判定改动前后都是 deny——不可能变。
 * 于是不必去 `service_accounts` 取全表，也不会漏掉任何一次判定变化。
 */
function programsOf(...ruleSets: readonly StackRule[][]): string[] {
  const out: string[] = []
  for (const rules of ruleSets) {
    for (const r of rules) {
      if (r.kind !== 'allow') continue
      const v = r.subjectValue
      if (typeof v !== 'string' || v === '') continue
      if (!out.includes(v)) out.push(v)
    }
  }
  return out
}

interface SubjectMeta {
  /** `consoleMeetingId` 编出来的行标识 */
  rowId: string
  title: string
  programId: string | null
}

function buildSubjects(
  kind: StackKind,
  meetings: readonly ScannedMeeting[],
  programs: readonly string[],
): { subjects: PreviewSubject[]; meta: Map<string, SubjectMeta> } {
  const subjects: PreviewSubject[] = []
  const meta = new Map<string, SubjectMeta>()
  for (const m of meetings) {
    if (kind !== 'allow') {
      // fetch / archive 是系统级行为，考察对象就是一场会议
      subjects.push({ key: m.row.id, facts: m.facts })
      meta.set(m.row.id, { rowId: m.row.id, title: m.row.title, programId: null })
      continue
    }
    // allow 栈的考察对象是**会议 × 采集程序**：同一场会议对 A 程序放行、对 B 拒绝，
    // 是两条不同的判定
    for (const programId of programs) {
      const key = `${m.row.id}|${programId}`
      subjects.push({ key, facts: m.facts, programId })
      meta.set(key, { rowId: m.row.id, title: m.row.title, programId })
    }
  }
  return { subjects, meta }
}

/** 这一栈被人工改写挡住的会议。改写优先于所有规则，规则怎么改它的结果都不变 */
function overriddenKeys(kind: StackKind, meetings: readonly ScannedMeeting[]): Set<string> {
  const out = new Set<string>()
  for (const m of meetings) {
    if (m.row.hand.includes(kind as HandKind)) out.add(m.row.id)
  }
  return out
}

/** 上屏用的判定。**丢掉 `trace`**：一场会议一条 trace，几百场就是几百倍的规则考察记录 */
function wireDecision(d: StackDecision): Record<string, unknown> {
  return {
    effect: d.effect,
    ruleId: d.ruleId,
    note: d.note,
    source: d.source,
    reason: d.reason,
    assetTypes: d.assetTypes,
    issues: d.issues,
  }
}

function wireChange(c: ImpactChange, meta: Map<string, SubjectMeta>): Record<string, unknown> {
  const m = meta.get(c.key)
  return {
    key: c.key,
    meetingId: m?.rowId ?? null,
    title: m?.title ?? '',
    programId: m?.programId ?? null,
    aspect: c.aspect,
    direction: c.direction,
    invalidRule: c.invalidRule,
    overridden: c.overridden,
    summary: c.summary,
    before: wireDecision(c.before),
    after: wireDecision(c.after),
  }
}

/**
 * spec §4.7 的琥珀警告：「有会议**从未对外开放过**却将被这条规则放行时，额外出一条」。
 *
 * **这是把 `ImpactChange` 读出来，不是重算**（计划 §3 T6 验收 3）：
 * `before.effect === 'deny'` 且 `after.effect === 'allow'` 就是「此前判拒绝、现在要放行」。
 *
 * 「从未开放过」严格讲是「对**任何**采集程序都没开放过」，而这次改动够不着的
 * 会议 × 程序对根本没被求值过（spec §5.5 刻意不去算它们——把全部会议列成受影响
 * 是虚假的规模感）。所以这里的判据是：**这场会议在本次考察范围内的每一个程序，
 * 改动前都是拒绝**。范围外还有一条老规则对别的程序放行着的话，这里会多报一次。
 * 多报的方向是安全的——数据出境闸门上，多问一句远好过少问一句。
 */
function newlyOpened(
  preview: StackImpactPreview,
  meta: Map<string, SubjectMeta>,
): Array<{ id: string; title: string }> {
  const alreadyOpen = new Set<string>()
  for (const c of [...preview.changed, ...preview.deciderOnly, ...preview.shielded]) {
    if (c.before.effect === 'allow') {
      const m = meta.get(c.key)
      if (m !== undefined) alreadyOpen.add(m.rowId)
    }
  }
  const out = new Map<string, { id: string; title: string }>()
  for (const c of preview.changed) {
    if (c.before.effect !== 'deny' || c.after.effect !== 'allow') continue
    const m = meta.get(c.key)
    if (m === undefined || alreadyOpen.has(m.rowId)) continue
    out.set(m.rowId, { id: m.rowId, title: m.title })
  }
  return [...out.values()]
}

/**
 * 影响预览。**这个端点一行都不落库**（spec §5.5 / 验收 1）：它读当前规则集与一批
 * 会议，跑的是 `policy/preview.ts` 的纯函数，`PolicyStore` 的四个写方法一个都不碰。
 *
 * 请求体两种写法，都表达「候选规则集」：
 *
 * - `{ rules: [...] }` —— 改动后的**整份**规则集（三栈混在一起也行）
 * - `{ rule: {...}, deleted?: boolean }` —— 只发正在编的那一条，服务端按 id 合进当前集合。
 *   规则编辑器一次只编一条，这个写法省得前端把整份规则回传一遍
 */
export async function previewRules(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const body = await readJson<Body>(req)
  if (body === null || typeof body !== 'object') return json(400, { error: 'invalid_json' })

  const wantKind = body.kind
  if (wantKind !== undefined && !isStackKind(wantKind)) {
    return json(400, { error: 'unknown_stack_kind', allowed: STACK_KINDS })
  }

  const hasSet = has(body, 'rules')
  const hasOne = has(body, 'rule')
  if (hasSet && !Array.isArray(body.rules)) {
    // 一份不是数组的候选集若被当成空集合，预览会报出「管理员把规则全删了」这样一次
    // 惊天动地的改动——那是这个端点最不该说的谎
    return json(400, { error: 'invalid_candidate_rules' })
  }
  if (hasOne && (typeof body.rule !== 'object' || body.rule === null)) {
    return json(400, { error: 'invalid_candidate_rules' })
  }
  if (!hasSet && !hasOne) return json(400, { error: 'missing_candidate_rules' })

  const oldRules: StackRule[] = await ctx.deps.policyStore.listAllRules()

  let newRules: StackRule[]
  if (hasSet) {
    newRules = (body.rules as unknown[]).map(toStackRule)
  } else {
    const draft = toStackRule(body.rule, 0)
    if (body.deleted === true) newRules = oldRules.filter((r) => r.id !== draft.id)
    else if (oldRules.some((r) => r.id === draft.id))
      newRules = oldRules.map((r) => (r.id === draft.id ? draft : r))
    else newRules = [...oldRules, draft]
  }

  const kinds = isStackKind(wantKind) ? [wantKind] : changedStackKinds(oldRules, newRules)
  const limit = clampLimit(body.limit)
  const scan = await scanMeetings(ctx, limit)
  const programs = programsOf(oldRules, newRules)
  const now = ctx.deps.now()

  const stacks: Array<Record<string, unknown>> = []
  const warnings: Array<Record<string, unknown>> = []
  const changedIds = new Set<number>()

  for (const kind of kinds) {
    const { subjects, meta } = buildSubjects(kind, scan.meetings, programs)
    const overridden = overriddenKeys(kind, scan.meetings)
    const preview = previewStackImpact({
      kind,
      oldRules,
      newRules,
      subjects,
      now,
      // 改写是套在规则栈外面的覆盖层：这几场会议的实际结果不会变，
      // 算进「会被改变」是错的，静默丢掉也是错的——`shielded` 单列一类
      overridden: (s) => overridden.has(meta.get(s.key)?.rowId ?? ''),
    })
    for (const id of preview.changedRuleIds) changedIds.add(id)

    stacks.push({
      kind: preview.kind,
      counts: preview.counts,
      summary: preview.summary,
      changedRuleIds: preview.changedRuleIds,
      changed: preview.changed.slice(0, CHANGE_SAMPLE_LIMIT).map((c) => wireChange(c, meta)),
      deciderOnly: preview.deciderOnly.slice(0, CHANGE_SAMPLE_LIMIT).map((c) => wireChange(c, meta)),
      shielded: preview.shielded.slice(0, CHANGE_SAMPLE_LIMIT).map((c) => wireChange(c, meta)),
      /** 明细被采样了没有。数字（counts）永远是全量的 */
      sampled: {
        changed: preview.changed.length > CHANGE_SAMPLE_LIMIT,
        deciderOnly: preview.deciderOnly.length > CHANGE_SAMPLE_LIMIT,
        shielded: preview.shielded.length > CHANGE_SAMPLE_LIMIT,
      },
    })

    if (kind !== 'allow') continue
    const opened = newlyOpened(preview, meta)
    if (opened.length === 0) continue
    warnings.push({
      level: 'amber',
      code: 'newly_opened',
      text:
        `有 ${opened.length} 场此前判定为「禁止采集」的会议将被这条规则放行给外部采集程序。` +
        '采集权限规则是数据出企业边界的唯一闸门，请确认这批会议确实可以对外开放',
      meetings: opened.slice(0, CHANGE_SAMPLE_LIMIT),
    })
  }

  // 候选规则里写坏的地方在预览阶段就说出来。不这么做的话，一条「条件字段拼错」的规则
  // 预览出来是「0 场会改变」，管理员分不清那是规则写得窄，还是规则根本不会命中——
  // 而后者正是 spec §4.7 要防的「建完一条静默失效的规则还以为生效了」
  const candidateIssues = newRules
    .filter((r) => changedIds.has(r.id))
    .map((r) => ({ id: r.id, kind: r.kind, issues: describeStackRuleIssues(r) }))

  return json(200, {
    scope: {
      /** 这次实际考察了多少场会议 */
      meetings: scan.meetings.length,
      /** 库里一共多少场。两者不等时预览说的是「这一批里」，不是「全库」 */
      meetingsTotal: scan.total,
      truncated: scan.total > scan.meetings.length,
      programs,
    },
    stacks,
    warnings,
    candidateIssues,
  })
}

// ── 命中的会议 ────────────────────────────────────────────────────────────

/**
 * 这条规则**自身的条件**命中哪几场会议（spec §4.7：规则行右侧的命中数可点）。
 *
 * 「命中」= `matchesRule`，即这条规则的 conds 匹配，**不是整栈求值的结果**：
 * 主体不符、被更高优先级顶掉的规则照样算「够得着」。这与影响预览里的口径一致
 * （`preview.ts` 文件头第一节），两处说的必须是同一件事，否则点开命中数看到的
 * 场次数和预览里的「场命中」对不上。
 *
 * 停用的规则也照样算得出来：管理员要先看得见「把它开回来会命中什么」。
 */
export async function ruleMatches(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const id = parseRuleId(ctx.params.id)
  if (id === null) return json(400, { error: 'invalid_rule_id' })

  const rule: AdminRule | null = await ctx.deps.policyStore.getRule(id)
  if (rule === null) return json(404, { error: 'rule_not_found' })

  const limit = clampLimit(new URL(req.url).searchParams.get('limit') ?? undefined)
  const scan = await scanMeetings(ctx, limit)
  const now = ctx.deps.now()

  const matches = scan.meetings
    .filter((m) => matchesRule(rule, m.facts, now))
    .map((m) => ({
      id: m.row.id,
      meetingId: m.row.meetingId,
      subMeetingId: m.row.subMeetingId,
      title: m.row.title,
      startAt: m.row.startAt,
      /** 库里这几列是 NULL。标题空着的时候，管理员要分得清「没标题」与「元数据没拉回来」 */
      missing: m.row.missing,
    }))

  return json(200, {
    rule,
    scope: {
      meetings: scan.meetings.length,
      meetingsTotal: scan.total,
      truncated: scan.total > scan.meetings.length,
    },
    matches,
  })
}
