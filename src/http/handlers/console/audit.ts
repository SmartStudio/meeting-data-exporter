/**
 * A5 · 操作审计 API（阶段 4 · T9）。spec.md §4.10。
 *
 * ```
 * GET /api/v1/admin/audit                        筛选 + 分页
 * GET /api/v1/admin/meetings/:meetingId/history  单场会议的操作历史（详情抽屉底部）
 * ```
 *
 * 读侧的 SQL 全在 `src/store/audit.ts`（T3），本文件只做四件事：把 query string
 * 翻成 `AuditQuery`、把库里的原值翻成界面词汇、批量补齐「对象」列的会议标题、
 * **把自己做过的假设写进响应**。最后一件是本文件最重要的一件，理由见下面两条。
 *
 * ## 一、时间量纲是 unix 秒，不是毫秒
 *
 * `audit_log.occurred_at` 的唯一写入者是 `src/audit/recorder.ts`，它取的是
 * `deps.now()`，而网关与 worker 两个进程里的 `now` 都是
 * `Math.floor(Date.now() / 1000)`（`src/index.ts` / `src/worker/index.ts`）——秒。
 *
 * 这条曾经**被 `src/store/audit.ts` 的注释写成毫秒**，两个并行任务各自独立撞上了它
 * （T5 与 T9，2026-08-26），那份注释已经改对。留着这段是因为错的方向很隐蔽：
 * 当成毫秒来算默认窗口，`now - 7 * 86400 * 1000` 会得到一个负数——下界形同虚设、
 * 拉的是全表，而响应里仍写着「最近 7 天」，界面上一切正常。
 * 本文件一律按秒处理，所有对外字段也是秒（与 `console/src/api/types.ts` 的口径一致）。
 *
 * ## 二、默认时间窗口必须看得见
 *
 * `query()` 不带时间范围时是一次全索引扫（T3 实测），所以这里必须给默认窗口。
 * 但**一个看不见的默认窗口比慢查询危险得多**：管理员在审计页上看不到某个操作，
 * 会读成「这个操作没发生过」，而真相是「它发生在窗口之外」。审计的全部价值就是
 * 事后能对得上账，所以响应里始终带 `window`，默认窗口时另附一句人话。
 *
 * ## 三、这里不编任何一句判定理由
 *
 * `audit_log` **没有 reason 列**。spec §4.10 举的例子（「拒绝 · 本地已到期，请去
 * NAS 取」）在现有表结构下只有两类记录给得出出处：命中了规则的（`matched_rule`）
 * 与登录失败的（原因被塞在 `asset_type` 列里，见 `audit/recorder.ts`）。
 * 其余的拒绝一律 `reason: null`，由界面显示成不带原因的「拒绝」。
 * 编一句「按兜底拒绝」看着更完整，但它对不回任何一条真实跑过的判定
 * （计划 §1 约束 3），而那正是本项目最不能接受的一类假象。
 */
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../../store/db'
import type { RouteCtx } from '../../router'
import { json } from '../../respond'
import { requireAdminAuth } from '../../middleware'
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  AUDIT_MEETING_HISTORY_LIMIT,
  type AuditQuery,
  type AuditRecord,
} from '../../../store/audit'

// ---------------------------------------------------------------------------
// 映射表：全项目唯一一份
// ---------------------------------------------------------------------------

/** spec §4.10 的三色块：`prog` 蓝 / `person` 中性 / `sys` 灰 */
export type AuditActorKind = 'prog' | 'person' | 'sys'

/**
 * `audit_log.actor_type` 的原值 → 三色块。**唯一一份映射表**，前端不要再抄一份：
 * 抄一份的代价不是重复代码，而是两边对同一条记录染出不同的颜色，而颜色正是
 * 「这次操作是人干的还是程序干的」这个问题在界面上的全部答案。
 *
 * 现在库里只会出现 `wecom_user` / `service_account` 两种（见 `domain/types.ts`
 * 的 `ActorIdentity.kind`）；`admin` 由阶段 4 的管理员写操作产生（计划 §1 约束 6），
 * `system` / `scheduler` 由 A4 的定时任务产生（T11）——后两者尚未落地，先在表里
 * 留好位置，比等它们出现时再回来加要好：漏加的那一刻，那些记录会掉进 `unknown`，
 * 在界面上是看得见的（见 `actorKindOf`），不会被悄悄染成别的颜色。
 */
export const AUDIT_ACTOR_KIND_BY_TYPE: Readonly<Record<string, AuditActorKind>> = {
  service_account: 'prog',
  wecom_user: 'person',
  admin: 'person',
  system: 'sys',
  scheduler: 'sys',
}

/** 可作为筛选条件的三种色块。`unknown` 不在其中——理由见 `parseActorKinds` */
export const AUDIT_ACTOR_KINDS: readonly AuditActorKind[] = ['prog', 'person', 'sys']

/**
 * 原值 → 色块。认不出时返回 `'unknown'` 而**不是**塞进三种里的任何一种：
 * 塞成 `prog` 是把一次人的操作说成程序干的，塞成 `person` 是反过来，
 * 塞成 `sys` 是把它说成系统自己干的——三个方向都在编。
 * 与 `store/audit.ts` 对 `decision` 脏值不归一化是同一个口径。
 */
export function actorKindOf(actorType: string): AuditActorKind | 'unknown' {
  return AUDIT_ACTOR_KIND_BY_TYPE[actorType] ?? 'unknown'
}

/** 色块 → 库里的原值（筛选用）。从同一份表反推，不另写一份 */
export function actorTypesForKinds(kinds: readonly AuditActorKind[]): string[] {
  const wanted = new Set<string>(kinds)
  return Object.entries(AUDIT_ACTOR_KIND_BY_TYPE)
    .filter(([, kind]) => wanted.has(kind))
    .map(([type]) => type)
}

/**
 * `audit_log.action` 的原值 → 界面上的「动作」。
 *
 * 认不出的动作**不报错也不隐藏**，`actionLabel` 给 null、`action` 原样带出，
 * 前端显示原值即可。新增动作时在这里补一行——漏补的后果只是界面上显示英文原值，
 * 不会丢记录。
 */
const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  issue_download_url: '签发下载链接',
  login: '登录',
  list_meetings: '列出会议',
}

/** 不指定时间范围时默认只看最近这么多天。见文件头第二条 */
export const AUDIT_DEFAULT_WINDOW_DAYS = 7
const DAY_SEC = 86_400

// ---------------------------------------------------------------------------
// 「对象」列的会议元数据：批量补齐
// ---------------------------------------------------------------------------

/**
 * 审计记录里「对象」列要显示的东西。`audit_log` 只存一个 ID，标题得另外补。
 *
 * `idKind` 说明这个 ID 是哪个维度的——`audit_log.meeting_id` 这一列有两种语义
 * （`action='issue_download_url'` 存的是 `meeting_record_id`，其余存 `meeting_id`，
 * 见 `migrations/001_init.sql` 的列注释）。把这件事透出去，是为了让前端点「对象」
 * 跳转会议详情时知道该拿哪个 ID 去跳（`meetingId` 字段），而不是拿着一个 record
 * 维度的 ID 去查会议、查不到、然后显示一个空抽屉。
 */
export interface AuditObjectRef {
  id: string
  idKind: 'meeting' | 'meeting_record' | 'unknown'
  /** 归一化到会议维度的 ID；反查不到时为 null（**不要**拿 `id` 顶上） */
  meetingId: string | null
  title: string | null
  code: string | null
}

/** 会议历史端点要的那一点会议信息 */
export interface AuditMeetingRef {
  id: string
  title: string | null
  code: string | null
  /** unix 秒。`listForMeeting` 的时间下界就取它 */
  startAt: number | null
  /** `startAt` 的出处，回显在响应里 */
  source: 'meetings' | 'meeting_cache'
}

/**
 * 审计 API 需要的会议元数据查询。**故意收窄到两个方法**，不是一个通用的会议 store。
 *
 * 本该住在 T1 的 `ConsoleMeetingsStore`（`src/store/console-meetings.ts`）里，
 * 但那份文件与本任务同期在建，跨任务依赖会把两个并行任务串成一条线。接口窄到
 * 这个程度之后，将来换成 T1 的实现只是装配点（`src/index.ts` 与 `tests/http/testApp.ts`）
 * 各改一行的事，handler 一个字都不用动。
 */
export interface AuditMeetingLookup {
  /**
   * 批量补齐「对象」列。**一页审计只发两条查询**（主表一条、缓存表一条），
   * 不逐行查——一页 200 行就是 200 次往返，而审计页是管理员翻得最勤的一页。
   *
   * 返回的 Map 只含查得到的；查不到的**不放进来**，由调用方显式落到
   * `idKind: 'unknown'`，免得「查不到」和「标题是空串」在下游长得一样。
   */
  resolveObjects(ids: readonly string[]): Promise<Map<string, AuditObjectRef>>

  /** 单场会议的元数据。查不到返回 null——此时会议历史没有时间下界可用 */
  findMeeting(meetingId: string): Promise<AuditMeetingRef | null>
}

interface MeetingsRow extends RowDataPacket {
  meeting_id: string
  meeting_code: string | null
  subject: string | null
  start_time: number | null
}

interface CacheRow extends RowDataPacket {
  meeting_record_id: string
  meeting_id: string
  meeting_code: string
  subject: string
  start_time: number
}

/** 多场次（周期性会议）里挑一场代表：取开始时间最早的那场，start_time 为空的排最后。
 *  必须是个确定的规则——不定的话同一批数据两次刷新会显示不同的标题。 */
function earlier(a: MeetingsRow, b: MeetingsRow): MeetingsRow {
  if (a.start_time === null) return b
  if (b.start_time === null) return a
  return a.start_time <= b.start_time ? a : b
}

export function createAuditMeetingLookup(pool: Pool): AuditMeetingLookup {
  return {
    async resolveObjects(ids) {
      const unique = [...new Set(ids)].filter((id) => id.length > 0)
      // MySQL 的 `IN ()` 是语法错误，空集合直接短路（也省两次往返）
      if (unique.length === 0) return new Map()
      const placeholders = unique.map(() => '?').join(', ')

      // 两条查询并行：同一批 ID 既可能是会议维度也可能是 record 维度，
      // 事先分不开（`action` 决定语义，但一页里两种 action 都有）。
      const [[meetingRows], [cacheRows]] = await Promise.all([
        pool.execute<MeetingsRow[]>(
          `SELECT meeting_id, meeting_code, subject, start_time
             FROM meetings
            WHERE meeting_id IN (${placeholders})`,
          [...unique],
        ),
        pool.execute<CacheRow[]>(
          `SELECT meeting_record_id, meeting_id, meeting_code, subject, start_time
             FROM meeting_cache
            WHERE meeting_record_id IN (${placeholders})`,
          [...unique],
        ),
      ])

      const byMeetingId = new Map<string, MeetingsRow>()
      for (const row of meetingRows) {
        const prev = byMeetingId.get(row.meeting_id)
        byMeetingId.set(row.meeting_id, prev === undefined ? row : earlier(prev, row))
      }

      const out = new Map<string, AuditObjectRef>()
      // 主表优先（E-a：`meetings` 是控制台主表，`meeting_cache` 是 record 维度的旁路）
      for (const [id, row] of byMeetingId) {
        out.set(id, {
          id,
          idKind: 'meeting',
          meetingId: id,
          title: row.subject,
          code: row.meeting_code,
        })
      }
      for (const row of cacheRows) {
        if (out.has(row.meeting_record_id)) continue
        out.set(row.meeting_record_id, {
          id: row.meeting_record_id,
          idKind: 'meeting_record',
          meetingId: row.meeting_id,
          title: row.subject,
          code: row.meeting_code,
        })
      }
      return out
    },

    async findMeeting(meetingId) {
      const [[meetingRows], [cacheRows]] = await Promise.all([
        pool.execute<MeetingsRow[]>(
          `SELECT meeting_id, meeting_code, subject, start_time
             FROM meetings WHERE meeting_id = ?`,
          [meetingId],
        ),
        pool.execute<CacheRow[]>(
          `SELECT meeting_record_id, meeting_id, meeting_code, subject, start_time
             FROM meeting_cache WHERE meeting_id = ?`,
          [meetingId],
        ),
      ])

      const main = meetingRows.reduce<MeetingsRow | null>(
        (acc, row) => (acc === null ? row : earlier(acc, row)),
        null,
      )
      const cachedStart = cacheRows.reduce<number | null>(
        (acc, row) => (acc === null || row.start_time < acc ? row.start_time : acc),
        null,
      )

      if (main !== null) {
        // `meetings.start_time` 可空（E-a 已点名该表列全 nullable）。为空时退到缓存表
        // 取下界，而不是当成「没有下界」——没有下界就是一次全索引扫。
        const startAt = main.start_time ?? cachedStart
        return {
          id: meetingId,
          title: main.subject,
          code: main.meeting_code,
          startAt,
          source: main.start_time === null && cachedStart !== null ? 'meeting_cache' : 'meetings',
        }
      }
      const cached = cacheRows[0]
      if (cached === undefined) return null
      return {
        id: meetingId,
        title: cached.subject,
        code: cached.meeting_code,
        startAt: cachedStart,
        source: 'meeting_cache',
      }
    },
  }
}

// ---------------------------------------------------------------------------
// query string 解析
// ---------------------------------------------------------------------------

/** 参数不合法时抛它，由两个 handler 统一翻成 400。**在查库之前抛**——
 *  条件构造错了却照样查一次，返回的零行会被读成「这段时间没有操作」 */
class BadParam extends Error {
  constructor(readonly body: Record<string, unknown>) {
    super(String(body.error))
  }
}

/** 整数参数。缺省与空串都视为「没传」；传了但不是整数一律拒绝，不回落到默认值 */
function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) throw new BadParam({ error: 'invalid_param', param: name })
  return n
}

/**
 * 多值参数：`?a=x,y` 与 `?a=x&a=y` 两种写法都收。
 *
 * **拆出来是空集合时拒绝**（`?a=` / `?a=,`）：空数组传给 store 表示「一条都不匹配」
 * （见 `AuditQuery` 的注释），会如实返回零行——而调用方本意多半是「不筛选」。
 * 这两件事在界面上长得一模一样，都是一张空表。
 */
function listParam(url: URL, name: string): string[] | undefined {
  const raw = url.searchParams.getAll(name)
  if (raw.length === 0) return undefined
  const values = raw
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (values.length === 0) {
    throw new BadParam({ error: 'empty_filter', param: name, hint: '不筛选请不要传这个参数' })
  }
  return [...new Set(values)]
}

function parseActorKinds(url: URL): string[] | undefined {
  const kinds = listParam(url, 'actorKind')
  if (kinds === undefined) return undefined
  for (const k of kinds) {
    // `unknown` 也走这一条：它是「不在映射表里的那些 actor_type」，是个补集，
    // 用 `IN (...)` 表达不出来。回 400 说清楚，好过筛出零行让人以为没有这类记录。
    if (!(AUDIT_ACTOR_KINDS as readonly string[]).includes(k)) {
      throw new BadParam({ error: 'invalid_actor_kind', value: k, allowed: AUDIT_ACTOR_KINDS })
    }
  }
  return actorTypesForKinds(kinds as AuditActorKind[])
}

function parseLimit(url: URL, max: number, fallback?: number): number | undefined {
  const limit = intParam(url, 'limit')
  if (limit === undefined) return fallback
  // store 会静默钳制到 max（`safeCount`）。静默钳制的结果是「我要 500 条，
  // 给了我 200 条」，而调用方会以为审计就这么多条——所以自己先比一次。
  if (limit > max) throw new BadParam({ error: 'limit_too_large', max })
  if (limit < 1) throw new BadParam({ error: 'invalid_param', param: 'limit' })
  return limit
}

/** 时间窗口，连同「它是怎么来的」一起返回——后者要回显给管理员 */
interface Window {
  from: number
  to: number | null
  isDefault: boolean
  days: number
  text: string | null
}

function resolveWindow(url: URL, now: number): Window {
  const from = intParam(url, 'from')
  const to = intParam(url, 'to')
  if (from !== undefined && to !== undefined && from >= to) {
    // 半开区间 [from, to)，from >= to 恒为空集。照查会返回零行，读起来跟
    // 「这段时间没有操作」一模一样，所以当场拒绝。
    throw new BadParam({ error: 'invalid_time_range', hint: 'from 必须小于 to（半开区间 [from, to)）' })
  }
  if (from !== undefined) {
    return { from, to: to ?? null, isDefault: false, days: AUDIT_DEFAULT_WINDOW_DAYS, text: null }
  }
  // 只给了 to 时，默认窗口以 to 为锚点往回推。以 now 为锚点的话，from 会大于 to，
  // 查任何一段历史都恒为空——而那正是「看不见的默认窗口」能造成的最坏结果。
  const anchor = to ?? now
  return {
    from: anchor - AUDIT_DEFAULT_WINDOW_DAYS * DAY_SEC,
    to: to ?? null,
    isDefault: true,
    days: AUDIT_DEFAULT_WINDOW_DAYS,
    text: `未指定时间范围，默认只查最近 ${AUDIT_DEFAULT_WINDOW_DAYS} 天的记录；` +
      `更早的操作不在本次结果里，要看请传 from / to（unix 秒）。`,
  }
}

// ---------------------------------------------------------------------------
// 行的映射
// ---------------------------------------------------------------------------

interface AuditRowJson {
  id: number
  /** unix 秒 */
  at: number
  actor: { kind: AuditActorKind | 'unknown'; type: string; id: string }
  action: string
  actionLabel: string | null
  object: AuditObjectRef | null
  asset: { id: string; type: string | null } | null
  /** `asset_type` 列被复用去装的那点东西，见 `assetOf` */
  detail: string | null
  result: { decision: string; kind: 'allow' | 'deny' | 'unknown'; reason: string | null }
  matchedRuleId: number | null
  clientKind: string | null
}

/**
 * `audit_log.asset_type` 这一列被复用了：`recordLogin` 往里塞失败原因、
 * `recordListing` 往里塞会议条数（见 `audit/recorder.ts`）。
 *
 * 判据取 `asset_id` 而不是列一张 action 白名单：只有真正涉及某份资产的记录才有
 * `asset_id`，这个性质不随将来新增动作而失效。按 action 白名单判的话，T6–T8 新加的
 * 管理员动作会默认掉进「有资产」那一支，界面上就会出现「资产类型：rule_updated」。
 */
function assetOf(r: AuditRecord): { asset: AuditRowJson['asset']; detail: string | null } {
  if (r.assetId !== null) return { asset: { id: r.assetId, type: r.assetType }, detail: null }
  return { asset: null, detail: r.assetType }
}

function resultOf(r: AuditRecord, detail: string | null): AuditRowJson['result'] {
  if (r.decision === 'allow') return { decision: r.decision, kind: 'allow', reason: null }
  if (r.decision !== 'deny') {
    // 库里那一列是 VARCHAR，读侧故意不归一化（见 store/audit.ts）。归进 allow 是
    // 静默放行，归进 deny 是冤枉一次真发生过的放行——所以在这里单开一档，
    // 让界面能把它标成「存疑」而不是二选一。
    return {
      decision: r.decision,
      kind: 'unknown',
      reason: `审计记录里的结果值无法识别：${r.decision}`,
    }
  }
  // 拒绝原因只有两个真实出处，没有第三个（见文件头第三条）
  if (r.action === 'login' && detail !== null) {
    return { decision: r.decision, kind: 'deny', reason: detail }
  }
  if (r.matchedRuleId !== null) {
    return { decision: r.decision, kind: 'deny', reason: `命中规则 #${r.matchedRuleId}` }
  }
  return { decision: r.decision, kind: 'deny', reason: null }
}

function toRowJson(r: AuditRecord, objects: Map<string, AuditObjectRef>): AuditRowJson {
  const { asset, detail } = assetOf(r)
  return {
    id: r.id,
    at: r.occurredAt,
    actor: { kind: actorKindOf(r.actorType), type: r.actorType, id: r.actorId },
    action: r.action,
    actionLabel: AUDIT_ACTION_LABELS[r.action] ?? null,
    object:
      r.meetingId === null
        ? null
        : // 补不齐标题时只给 ID，不拿 ID 冒充标题：界面上一个看着像标题的 ID
          // 会让管理员以为这场会议就叫这个名字
          (objects.get(r.meetingId) ?? {
            id: r.meetingId,
            idKind: 'unknown' as const,
            meetingId: null,
            title: null,
            code: null,
          }),
    asset,
    detail,
    result: resultOf(r, detail),
    matchedRuleId: r.matchedRuleId,
    clientKind: r.clientKind,
  }
}

/**
 * 会议历史那一行的一句话。
 *
 * 前端契约（`console/src/api/types.ts`）里详情抽屉的历史是
 * `Array<{ at: number; text: string }>`——一句现成的话，不是五个字段。
 * 所以历史端点的行**在完整字段之外另带一个 `text`**，两种消费方式都成立：
 * 想按列渲染就用字段，想照契约直接渲染就用 `text`。
 * 用同一份映射表拼，不会与列表页说的话不一致。
 */
function describeRow(row: AuditRowJson): string {
  const what = row.actionLabel ?? row.action
  const asset = row.asset?.type != null ? `（${row.asset.type}）` : ''
  const result =
    row.result.kind === 'allow'
      ? '准许'
      : row.result.kind === 'unknown'
        ? '结果存疑'
        : row.result.reason === null
          ? '拒绝'
          : `拒绝 · ${row.result.reason}`
  return `${row.actor.id} · ${what}${asset} · ${result}`
}

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

/** GET /api/v1/admin/audit */
export async function listAudit(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  let query: AuditQuery
  let window: Window
  try {
    window = resolveWindow(url, ctx.deps.now())
    const actorId = url.searchParams.get('actorId')?.trim()
    const decision = url.searchParams.get('decision')
    if (decision !== null && decision !== 'allow' && decision !== 'deny') {
      throw new BadParam({ error: 'invalid_decision', allowed: ['allow', 'deny'] })
    }
    const offset = intParam(url, 'offset')
    if (offset !== undefined && offset < 0) {
      throw new BadParam({ error: 'invalid_param', param: 'offset' })
    }
    const actorTypes = parseActorKinds(url)
    const actions = listParam(url, 'action')
    query = {
      ...(actorId !== undefined && actorId.length > 0 ? { actorId } : {}),
      // 三个可选筛选条件一律「没传就整个字段不给」，绝不传 undefined 之外的空值：
      // 空数组在 store 里的含义是「一条都不匹配」，不是「不筛选」
      ...(actorTypes !== undefined ? { actorTypes } : {}),
      ...(actions !== undefined ? { actions } : {}),
      ...(decision !== null ? { decision } : {}),
      from: window.from,
      ...(window.to !== null ? { to: window.to } : {}),
      limit: parseLimit(url, AUDIT_MAX_LIMIT, AUDIT_DEFAULT_LIMIT) ?? AUDIT_DEFAULT_LIMIT,
      offset: offset ?? 0,
    }
  } catch (err) {
    if (err instanceof BadParam) return json(400, err.body)
    throw err
  }

  const page = await ctx.deps.auditQuery.query(query)
  const objects = await ctx.deps.auditMeetings.resolveObjects(
    page.rows.map((r) => r.meetingId).filter((id): id is string => id !== null),
  )

  return json(200, {
    rows: page.rows.map((r) => toRowJson(r, objects)),
    total: page.total,
    limit: query.limit,
    offset: query.offset,
    window,
  })
}

/** GET /api/v1/admin/meetings/:meetingId/history */
export async function meetingHistory(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  let limit: number | undefined
  try {
    limit = parseLimit(url, AUDIT_MEETING_HISTORY_LIMIT, undefined)
  } catch (err) {
    if (err instanceof BadParam) return json(400, err.body)
    throw err
  }

  const meetingId = ctx.params.meetingId!
  const meeting = await ctx.deps.auditMeetings.findMeeting(meetingId)

  // `audit_log` 上没有 meeting_id 索引（只有 idx_audit_time / idx_audit_actor），
  // 不给时间下界这条查询就是一次全索引扫；给了就退化成 idx_audit_time 上的一段
  // range。会议的 start_time 是天然的下界——这场会议的操作不可能发生在它开始之前。
  const since = meeting?.startAt ?? undefined
  const rows = await ctx.deps.auditQuery.listForMeeting(meetingId, {
    ...(since !== undefined ? { since } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })

  const objects = await ctx.deps.auditMeetings.resolveObjects(
    rows.map((r) => r.meetingId).filter((id): id is string => id !== null),
  )

  return json(200, {
    // 元数据查不到不代表这场会议没有操作记录，所以是 200 + meeting: null，不是 404。
    // 反过来做的话，一场元数据丢了的会议，它的审计历史会连同元数据一起消失——
    // 而「记录还在不在」正是审计要回答的问题。
    meeting,
    rows: rows.map((r) => {
      const row = toRowJson(r, objects)
      return { ...row, text: describeRow(row) }
    }),
    window: {
      since: since ?? null,
      sinceSource: meeting?.source ?? 'none',
      text:
        since === undefined
          ? '查不到这场会议的开始时间，本次没有设时间下界（会扫描全部审计记录）。'
          : null,
    },
  })
}
