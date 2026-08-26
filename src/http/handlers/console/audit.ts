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
 * 拒绝原因**全部来自库里真有的列**，这一层一个字都不加工。出处按优先级：
 *
 * 1. `audit_log.detail` 的第一行（migrations/008 加的列，写侧见阶段 4 · T15）。
 *    写入方放在那里的是判定引擎自己给的原话——`allowsAsset().reason`、
 *    规则校验的逐条 issues、清理校验的失败原因。这是 spec §4.10 那个例子
 *    （「拒绝 · 本地已到期，请去 NAS 取」）第一次真的有地方可放。
 * 2. `matched_rule`：答得出「命中了第几条」，答不出「为什么这条不放行」，
 *    所以排在 detail 后面。
 * 3. 两处都没有 → `reason: null`，界面显示成不带原因的「拒绝」。
 *
 * 编一句「按兜底拒绝」看着更完整，但它对不回任何一条真实跑过的判定
 * （计划 §1 约束 3），而那正是本项目最不能接受的一类假象。
 *
 * `detail` 列出现之前，多数拒绝只能报 `reason: null`；**那批既有记录仍然是
 * `detail IS NULL`**，读侧因此保留了一条回退（见 `detailOf`）。
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
import { auditActionLabel, unlabeledActions } from '../../../audit/actions'

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

/*
 * `audit_log.action` → 界面上的「动作」的映射表**已挪到 `src/audit/actions.ts`**
 * （阶段 5 · A9）。
 *
 * 挪的理由：它从前长在读侧这里，而动作名是写侧各个 handler 各写各的字面量，
 * 两侧之间没有任何东西把它们钉在一起——到阶段 5 为止库里会出现 28 种动作，
 * 而这张表只有 3 行，于是「动作」那一列有 25 种记录显示成英文 snake_case。
 * 现在写侧从登记表取常量、读侧从登记表取标签，加动作时漏掉标签会编译不过。
 *
 * 读侧对没登记的动作**仍然不回退成原值**：`actionLabel` 是 null，
 * 另由响应顶层的 `unlabeledActions` 点名（见 `listAudit`）。
 */

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
  /**
   * 这次操作的明细全文，见 `detailOf`。
   *
   * **第一行是一句人话，其余是紧凑 JSON 附文**（`buildAuditDetail` 的约定）。
   * 原样下发，不在这里拆——前端要能展开看规则快照的全文。
   */
  detail: string | null
  result: { decision: string; kind: 'allow' | 'deny' | 'unknown'; reason: string | null }
  matchedRuleId: number | null
  clientKind: string | null
}

/** 这条记录涉及的那份资产。`asset_id` 为空 = 这次动作的对象不是某一份资产 */
function assetOf(r: AuditRecord): AuditRowJson['asset'] {
  return r.assetId === null ? null : { id: r.assetId, type: r.assetType }
}

/**
 * 这条记录的明细。
 *
 * 新记录读 `detail` 列（migrations/008，写侧见阶段 4 · T15）。
 *
 * **`detail IS NULL` 时的那条回退不是历史包袱，是必需品**：库里已经有真实数据，
 * 那些记录写下时 `detail` 列还不存在，明细被塞在 `asset_type` 上
 * （`recordLogin` 塞失败原因、`recordListing` 塞会议条数、几个管理员 handler
 * 塞一句话明细）。掉了这条回退，阶段 4 之前的审计明细会在界面上凭空消失。
 *
 * 回退的判据仍取 `asset_id` 而不是列一张 action 白名单：只有真正涉及某份资产的
 * 记录才有 `asset_id`，这个性质不随将来新增动作而失效。老记录里 `asset_id` 非空的
 * 那些（下载记录），`asset_type` 是真的资产类型，不能当明细读——否则界面上
 * 「明细：video」。
 */
function detailOf(r: AuditRecord): string | null {
  if (r.detail !== null) return r.detail
  return r.assetId === null ? r.assetType : null
}

/**
 * 明细里那句给人看的话：**第一行**（`buildAuditDetail` 保证的形状）。
 *
 * 只取第一行，是因为附文那一行是紧凑 JSON——把它当拒绝原因显示给管理员，
 * 等于在「为什么被拒」这一栏里甩一段代码。
 */
function detailText(detail: string | null): string | null {
  if (detail === null) return null
  const first = detail.split('\n')[0]?.trim() ?? ''
  return first === '' ? null : first
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
  // 拒绝原因的第一出处是明细的那句人话——写入方把判定引擎给的原话放在那里
  // （`allowsAsset().reason`、规则校验的逐条 issues、清理校验的失败原因）。
  // 这里**不做任何加工**：加工过的理由对不回那条真跑过的判定。
  const reason = detailText(detail)
  if (reason !== null) return { decision: r.decision, kind: 'deny', reason }
  // 明细里没有话时退到「命中了第几条」。它答不出「为什么这条不放行」，
  // 但它是一条真实的线索，比 null 强
  if (r.matchedRuleId !== null) {
    return { decision: r.decision, kind: 'deny', reason: `命中规则 #${r.matchedRuleId}` }
  }
  // 两处都没有就是没有。编一句「按兜底拒绝」看着更完整，但它对不回任何一条
  // 真实跑过的判定（计划 §1 约束 3）
  return { decision: r.decision, kind: 'deny', reason: null }
}

function toRowJson(r: AuditRecord, objects: Map<string, AuditObjectRef>): AuditRowJson {
  const asset = assetOf(r)
  const detail = detailOf(r)
  return {
    id: r.id,
    at: r.occurredAt,
    actor: { kind: actorKindOf(r.actorType), type: r.actorType, id: r.actorId },
    action: r.action,
    actionLabel: auditActionLabel(r.action),
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
  // 没登记标签时**不回退成裸原值**：那句话读起来与一个真的叫这个名字的动作
  // 一模一样，于是漏登记永远不会被人发现（阶段 5 · A9）。带上「未登记标签」
  // 四个字，代价是一句话长了一点，换来的是它自己会喊。
  const what = row.actionLabel ?? `${row.action}（未登记标签）`
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
    // 这一页里有哪几种动作后端没有登记中文名（阶段 5 · A9）。
    // 逐行的 `actionLabel` 是 null 已经把这件事说了一半，但那一半只有在有人
    // 盯着某一行发呆时才看得见；这里按动作汇总一次，界面上可以显示成一句
    // 「这一页有 N 种动作后端还没登记名字」。全部登记过时是空数组。
    unlabeledActions: unlabeledActions(page.rows.map((r) => r.action)),
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
    // 与列表端点同一个口径：这段历史里有哪几种动作后端没有登记中文名。
    // 详情抽屉直接渲染 `text` 时，那句话里已经带着「未登记标签」四个字
    // （见 `describeRow`），这里另给结构化的一份，好让界面汇总成一句提示
    unlabeledActions: unlabeledActions(rows.map((r) => r.action)),
  })
}
