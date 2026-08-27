import { ALL_ASSET_KEYS, GATEWAY_TYPE_TO_ASSET_KEY, type AssetKey } from '@yaowu/mde-engine'
import type { RowDataPacket } from 'mysql2'
import { isVisible, meetingFacts, type MeetingMeta } from '../policy/access'
import type { MeetingFactKey } from '../policy/conds'
import {
  applyOverride,
  indexOverrides,
  type MeetingOverride as PolicyOverride,
  type MeetingOverrideSet,
} from '../policy/override'
import { evaluateAllowStack, normalizeEffect, type StackRule } from '../policy/stacks'
// 保留窗口的公式只有一处：到期清理按它挑候选，控制台按它答「还剩几天」。
// 各存一份的话，界面说「还剩 3 天」而清理昨天就把文件删了。
import { expiresAt as retentionExpiresAt } from '../worker/retention'
import { archiveStateKey, type MeetingArchiveRecord } from './archives'
// 「延长保留」在 audit_log 里的 action 与场次编法。**与写侧共用同一份**
// （`http/handlers/console/storage.ts` 的延长端点），各拼各的会让这里一条都数不着
import { ACTION_EXTEND_RETENTION, auditSubMeetingAssetId } from './audit'
import type { Pool } from './db'
import { createGrantsStore, type MeetingKey } from './grants'
import { createPolicyStore, type PolicyStore } from './policy'

/**
 * 控制台会议记录页（spec §4.2）的查询底座（阶段 4 · T1）。
 *
 * ## 读的是 `meetings`，不是 `meeting_cache`（计划 §0 E-a）
 *
 * 仓库里有两张会议表。`meeting_cache`（001）的键是 `meeting_record_id`，是网关列
 * 会议时机会性写的缓存，**和谁都 JOIN 不上**，它现在的唯一用途是 download-url
 * 端点按 record id 反查会议属性做策略判定（见 `src/store/meetings.ts` 的文件头）。
 * 控制台要把会议与资产、归档、授权、改写四张表拼在一起，只有 `meetings`（002）
 * 与它们同键。**两张表不合并、不互相回写**，本文件一个字都不碰 `meeting_cache`。
 *
 * 代价必须写在这里免得以后当 bug 修：`meetings` 的列**全部 nullable**，而且
 * **没有 `state` 列**（录制状态只在 `meeting_cache` 里）。前者的处理见
 * `ConsoleMeetingRow.missing`，后者见 `getMeetings`。
 *
 * ## 这一层给事实，不给判定
 *
 * 契约（`console/src/api/types.ts` 的 `Meeting`）里有三个字段**不由本模块产出**，
 * 它们要么需要求值规则、要么要读 `audit_log`：
 *
 * | 契约字段 | 谁给 | 为什么不在这里 |
 * | --- | --- | --- |
 * | `allow` / `why.allow` | T5，走 `explainMeetingAccess` | 采集权限栈的主体是**采集程序**，一场会议对不同程序的判定不同；两处各判一遍必然分叉，而分叉的表现是「详情抽屉说准许、程序取的时候被拒」 |
 * | `why.fetch` | T5，按 E-c 报 `na` | 拉取规则栈至今零调用点，编一个判定比不说更糟 |
 * | `why.archive` | T5，走 `evaluateArchiveStack` | 同上：与 `src/worker/archive.ts` 同源，不在 store 里再判一遍 |
 * | `history` | T3 的 `audit.ts` | `audit_log.meeting_id` 有两种语义（见 001 的注释），那条读法只该有一份实现 |
 *
 * **本模块确实读一次 `audit_log`，但那不是上面那条读法**（阶段 4 · T17）：
 * `keep.extended` 要数「延长保留」的条数，见 `loadExtendCounts`。它按
 * `action = 'extend_retention'` 精确筛，只碰管理员写的那一类记录，因此完全避开了
 * `meeting_id` 那两种语义的纠缠（record 维度的 ID 只出现在
 * `action = 'issue_download_url'` 的记录里）。会议操作历史仍然只有
 * `AuditQueryStore.listForMeeting` 一份实现。
 *
 * 因此 `fetch` / `archive` 两个阶段状态本模块给的是**库里看得见的那一半**：
 * `'off'`（有人工改写把这一阶段关掉）给得出来，`'blocked'`（规则做的决定）给不出来。
 * 契约对这两个取值的分工是明写的——`off` 是人关的，`blocked` 是规则关的——所以
 * 本模块**永远不会返回 `'blocked'`**，需要它的话由 T5 用同一套 `evaluate*Stack` 叠加。
 *
 * 唯一的例外是分诊条的 `awaitingGrant`：它的定义里就含「采集权限规则判 allow」，
 * 不求值就算不出这个数。见 `awaitingGrantKeys` 的注释。
 *
 * ## 查询数与行数无关
 *
 * 列一页 50 行发出去的查询数与列 3 行**完全相同**：分页 1 次、计数 1 次、
 * 资产聚合 1 次、授权 1 次、改写 1 次，外加延长次数 1 次（只在这一页里真有会议
 * 被延长过时才发，见 `loadExtendCounts`）。测试用一个数查询次数的 pool 代理钉住这条。
 */

// ── 契约形状（与 console/src/api/types.ts 逐字一致）────────────────────────

/**
 * 拉取阶段状态。取值与 `console/src/api/types.ts` 的 `FetchState` 逐字一致——
 * 那份是契约，前端整页已经按它写完了。这里重新声明而不是 import，是因为
 * `console/` 是独立的 npm 工程（见 bunfig.toml 的注释），跨不过去。
 *
 * 本模块不产出 `'blocked'`，理由见文件头。
 */
export type FetchState = 'done' | 'running' | 'blocked' | 'off' | 'none'

/** 归档阶段状态。同上，本模块不产出 `'blocked'` */
export type ArchiveState = 'done' | 'running' | 'failed' | 'off' | 'blocked' | 'none'

/** 被人工改写过的阶段。与 `StackKind` 同一组取值 */
export type HandKind = 'fetch' | 'archive' | 'allow'

/** 分诊条五格（spec §4.2）。每格可点即筛选，所以它同时是 `MeetingQuery.triage` 的取值 */
export type TriageBucket =
  | 'archiveFailed'
  | 'expiringIn7d'
  | 'awaitingGrant'
  | 'inProgress'
  | 'nasOnly'

export interface Triage {
  archiveFailed: number
  expiringIn7d: number
  awaitingGrant: number
  inProgress: number
  nasOnly: number
}

/**
 * `meetings` 表里这一行**哪几列是 NULL**。
 *
 * 契约的 `title` / `code` / `host` 是 `string`、`startAt` 是 `number`，而库里
 * 这几列全部 nullable。把 NULL 直接读成空串是**不许的**：一场 `subject IS NULL`
 * 的会议在列表里显示成空白，和一场标题真的是空串的会议在界面上无法区分，
 * 管理员没法判断是「这场会议没标题」还是「元数据没拉回来」。
 *
 * 所以 NULL 仍然按仓库既有口径补成空串 / 0（契约的字段类型只装得下这个），
 * 但**同时**在这里记一笔——不是悄悄变的，是记了账的。
 *
 * **这一份是给界面看的，判定用的是另一份**（阶段 4 · T13）：`missingFactsOf` 产出
 * `MeetingFactKey[]`，字段名与 `policy/conds.ts` 的 `MeetingFacts` 逐字对齐，
 * 且不含 `code`（会议号不参与任何条件求值）。两份故意不合并——一份要跟着契约走、
 * 一份要跟着求值器走，合并之后任何一边改字段名都会悄悄弄坏另一边。
 */
export type MeetingNullField = 'title' | 'code' | 'host' | 'startAt' | 'endAt'

/**
 * `keep.extended` 那个数**是哪来的**，因此也说明了它准不准（阶段 4 · T17）。
 *
 * - `'none'`：`extended_days` 是 0，这场会议从没被延长过，`extended` 就是 0；
 * - `'audit'`：`audit_log` 里数出来的**真实次数**；
 * - `'floor'`：延长过（`extended_days > 0`）但审计里一条都没有——报的是**下界 1**，
 *   真实次数无从得知。见 `ConsoleKeepWindow.extended` 的说明。
 */
export type ExtendedSource = 'none' | 'audit' | 'floor'

/**
 * 保留窗口。比契约的 `KeepWindow` 多三个字段（`extendedDays` / `extendedSource` /
 * `retentionDays`），前端会忽略多的。
 *
 * ## `extended`：契约问「几次」，库里只有「几天」（T1 的缺口，T17 补上）
 *
 * 契约的 `extended` 问的是「被人工延长过**几次**」（前端渲染成「已延长 N 次」），
 * 而 `meeting_archives` 只有 `extended_days`（累加的**天数**，见 003 的建表）。
 * 两者之间**没有可逆的换算**：延长 60 天可能是一次 60 天，也可能是两次 30 天。
 * 阶段 4 的 T1 因此只能报 `extendedDays > 0 ? 1 : 0` 这个下界。
 *
 * T8 把「延长保留」写进了 `audit_log`（`ACTION_EXTEND_RETENTION`），于是真实次数
 * 现在数得出来了。**判据分两层，顺序不能反**：
 *
 * 1. `extended_days` 说了算「有没有延长过」。它是 `extendRetention` 唯一的累加目标，
 *    是这件事的账本；
 * 2. `audit_log` 说了算「延长过几次」——但只在第 1 层说「延长过」时才去数。
 *
 * 为什么第 2 层不能单独说了算：重复归档会把 `archived_at` 推后而**一个字都不碰
 * `extended_days`**（`archives.ts` 的 upsert 注释写明了这条），于是审计里可能留着
 * 上一轮窗口的记录。让它单独说了算，就会出现「延长了 0 天，却延长过 2 次」——
 * 两个字段在同一个抽屉里自相矛盾。同一个理由，数审计时**必须以 `archived_at`
 * 为时间下界**：那是本轮保留窗口的起点，上一轮的记录不属于这一轮。
 * （下界还有第二个用处，见 `loadExtendCounts`：`audit_log` 上没有 `meeting_id`
 * 索引，不给时间下界那条查询就是全索引扫。）
 *
 * ## 历史数据：审计是从 T8 那天才开始记的
 *
 * 在那之前用 `extendRetention` 延长过的会议，`extended_days > 0` 而审计里没有记录。
 * 这种会议**报 0 是不许的**——那是在说「从没延长过」，与 `extendedDays` 直接打架。
 * 这里仍取下界 1，并且**在 `extendedSource` 上标明它是下界**（`'floor'`），
 * 让界面能把「已延长 1 次」与「至少延长过 1 次」说成两句话。
 *
 * 已知的残余窄边界，写在这里免得以后当 bug 修：一场会议如果 T8 之前延长过一次、
 * 之后又延长过一次，审计只数得到后面那次，`extendedSource` 会报 `'audit'` 而
 * `extended` 是 1（真值 2）。**这个洞不该靠解析补**：延长端点把天数写在展示串
 * `延长 N 天（累计 M 天）` 里，拿它当载荷去解析，谁改一下措辞次数就静默错掉，
 * 而且没有任何东西会报错——比这个偏差更危险。真要补，是让写侧把天数结构化地
 * 记进 008 新加的 `audit_log.detail` 列（那一列至今没有写入方，见 008 的第四节），
 * 读侧才有个不靠措辞的判据。历史记录仍然补不回来。
 */
export interface ConsoleKeepWindow {
  /** unix 秒。归档成功的那一刻——保留窗口从这里起算，不是从会议日 */
  archivedAt: number | null
  /** unix 秒。`retention.ts` 的 `expiresAt()` 算出来的，公式只有那一处 */
  expiresAt: number | null
  /**
   * 被人工延长过**几次**。`extendedSource === 'floor'` 时它只是下界，
   * 见上面的说明。「延长了多少天」永远用 `extendedDays`，不要拿这个乘 30。
   */
  extended: number
  /** `extended` 这个数是哪来的，也就是它准不准 */
  extendedSource: ExtendedSource
  /** 被人工延长的累计天数（`meeting_archives.extended_days`）。这个字段永远准确 */
  extendedDays: number
  /** 这场会议的保留天数。没有归档行时为 null（窗口还没开始计时） */
  retentionDays: number | null
  /** 本地文件是否已被到期清理删掉（记录与 NAS 路径仍在） */
  filesGone: boolean
}

/**
 * 拼装好的一行。字段名与契约的 `Meeting` 对齐（多出来的字段前端会忽略，
 * 少一个字段前端就崩），缺的三个字段由 T5 叠加，见文件头的表。
 */
export interface ConsoleMeetingRow {
  /** 前端只把它当不透明行标识用。`consoleMeetingId` 编的，`parseConsoleMeetingId` 解得回来 */
  id: string
  /** 真实主键的两段。前端用不上，T5 拼路由与调后续 store 要用 */
  meetingId: string
  subMeetingId: string
  title: string
  code: string
  /** unix 秒。`start_time IS NULL` 时是 0，`missing` 里会有 `'startAt'` */
  startAt: number
  /** 秒。`end_time - start_time`；任一为 NULL 或 `end <= start` 时是 0，见下面的注释 */
  durationSec: number
  /**
   * **主持人的 userid，不是姓名**（计划 §0 E-b）。取姓名要走企微通讯录，
   * 而本部署企微未配置。显示一个查不到出处的中文名比显示 userid 更难排查——
   * 管理员会以为那是真名，拿着它去问人，问出来的会是另一个人。
   * 字段仍叫 `host`：将来接上通讯录只换来源、不换形状，前端一行不改。
   */
  host: string
  /** 哪几列在库里是 NULL。空数组表示每一列都有真实值 */
  missing: MeetingNullField[]
  /**
   * 各类资产已拿到 / 应有。**不适用的类不出现在对象里**——`{got:0,total:0}`
   * 在界面上会渲染成「0/0」，看起来像一次失败的拉取，而实际是这场会议压根
   * 没有这一类录制。
   */
  assets: Partial<Record<AssetKey, { got: number; total: number }>>
  /**
   * `meeting_assets.asset_type` 里认不出的取值（网关将来接新纪要引擎时会出现）。
   * **不静默丢掉**：这些行确实占着 `got/total`，只是没法归进契约的八个 `AssetKey`。
   */
  unknownAssetTypes: string[]
  fetch: FetchState
  archive: ArchiveState
  /** 已授权的采集程序 id，按 id 升序（顺序稳定，界面上不会跳） */
  grants: string[]
  /** 被人工改写过的阶段，按 fetch / archive / allow 的固定顺序 */
  hand: HandKind[]
  keep: ConsoleKeepWindow
  nasPath: string | null
  /**
   * 字节。**已下载完成的资产的 `bytes_expected` 之和**，一个 completed 行都没有
   * 声明大小时是 `null`（算不出来，不是 0 字节）。
   *
   * **这里还没跟进 `bytes_written` 的语义变更**：那一列如今在 completed 行上是
   * 落盘的真实大小（`markCompleted` 写的），不再是进度检查点——只有非终态的行才是
   * 检查点（见 `packages/engine/src/domain/manifest.ts` 的 `bytes` 字段注释）。
   * 也就是说这里**可以**像清单和 `console-storage.ts` 那样回落到它，从而不再对着
   * 一场真实会议显示"算不出来"。没有顺手改，是因为这是界面口径的改动：要和
   * `console-storage.ts` 的两个 SUM 一起动、一起定，而不是两个页面各回落各的。
   */
  sizeBytes: number | null
}

export interface MeetingQuery {
  /**
   * unix 秒。**必填**：分诊条筛选（`archiveFailed` / `expiringIn7d` / `awaitingGrant`）
   * 都要一个时刻才算得出来。仓库的惯例是求值层不读时钟——调用方传进来，
   * 测试才能钉住边界，同一次请求里各处也才是同一个「现在」。
   */
  now: number
  /** 模糊搜索：标题 / 会议号 / 主持人。`%` 与 `_` 按字面量处理 */
  search?: string
  /** 点了分诊条哪一格 */
  triage?: TriageBucket
  /** 有 / 没有生效授权 */
  hasGrant?: boolean
  /** 有 / 没有生效的人工改写（任意一栈） */
  hasOverride?: boolean
  /**
   * 在 / 不在保留期内。判据是**本地文件还在没有**，不是窗口算出来到没到期
   * ——spec §1.3 括号里写的就是「本地文件还没被删」，`expiresAt` 只是预告
   * （完整推理见 `src/worker/visibility.ts` 文件头第二节）。于是：
   * 有归档行且 `local_purged_at IS NULL` → 在；
   * 没有归档行但本地有 completed 资产 → 也在（保留窗口只是还没开始计时）。
   */
  inRetention?: boolean
  /** 默认 50，上限 500 */
  limit?: number
  offset?: number
}

export interface ConsoleMeetingsStore {
  /** 分页列表。返回的是拼装好的行，不是四张表的原始行 */
  list(q: MeetingQuery): Promise<{ rows: ConsoleMeetingRow[]; total: number }>
  /** 分诊条五格 */
  triage(now: number): Promise<Triage>
  /** 单场，详情抽屉用。查不到返回 null */
  get(meetingId: string, subMeetingId: string, now: number): Promise<ConsoleMeetingRow | null>
  /**
   * 批量拿会议元数据，给 `src/worker/visibility.ts` 的 `VisibilityDeps.getMeetings` 用。
   *
   * **查不到的会议不造空壳顶上**：返回的数组里就是没有它。理由写在那个依赖上——
   * 空壳会让一条 `title has 财务` 的规则对着空标题判不匹配，看起来一切正常。
   *
   * **查得到但元数据不全的行照样返回**，只是带上 `MeetingMeta.missingFacts`
   * （阶段 4 · T13）。不能像查不到那样把它整行丢掉：那会让清单报「在 meetings 表里
   * 查不到」，而对一行确实存在、只是列是 NULL 的记录，那句话是假的。
   */
  getMeetings(keys: readonly MeetingKey[]): Promise<readonly MeetingMeta[]>
}

// ── 行 id ────────────────────────────────────────────────────────────────

/**
 * 一行的不透明标识。契约的 `Meeting.id` 是一个 `string`，而真实主键是
 * `(meeting_id, sub_meeting_id)` 两段，必须编进去——只用 `meeting_id` 的话，
 * 周期性会议的各场次在列表里会撞成同一行。
 *
 * 编码用 `encodeURIComponent` + 逗号分隔：`encodeURIComponent` 把逗号转成 `%2C`，
 * 所以字符串里出现的**字面逗号只可能是分隔符**，`("a,b", "")` 与 `("a", "b")`
 * 因此编不出同一个 id（这正是 `archiveStateKey` 用 NUL 分隔要防的那件事，
 * 只是这里的结果要能进 URL，NUL 进不去）。`sub_meeting_id` 为空串时省掉分隔符，
 * 主场次的 id 就是会议号本身，日志里读得懂。
 */
export function consoleMeetingId(meetingId: string, subMeetingId: string): string {
  const head = encodeURIComponent(meetingId)
  return subMeetingId === '' ? head : `${head},${encodeURIComponent(subMeetingId)}`
}

/** `consoleMeetingId` 的逆。多余的分段一律忽略——不猜，只认前两段 */
export function parseConsoleMeetingId(id: string): MeetingKey {
  const [head = '', tail = ''] = id.split(',')
  return { meetingId: decodeURIComponent(head), subMeetingId: decodeURIComponent(tail) }
}

// ── 判据常量 ─────────────────────────────────────────────────────────────

/**
 * 归档宽限：最后一个资产下载完成之后多久还没进 `meeting_archives`，就算**归档失败**。
 *
 * **这是分诊条最高级别告警（红格）的全部判据，所以它必须写死在这里、写清楚为什么**：
 *
 * - 归档任务的频率是**每小时整点**（spec §4.8）。6 小时 = 连续 6 轮都没把它归档
 *   进去，已经不是「还没轮到」能解释的了。
 * - 单次归档的上界是 `NAS_WRITE_TIMEOUT_MS`（10 分钟，见 `src/worker/archive.ts`），
 *   一场会议再大也不可能一次跨过 6 小时，所以宽限内不会漏报一场「正在搬」的会议。
 * - 起算点是**最后一个 completed 资产的完成时刻**，不是会议时间：归档要等
 *   全部资产下载完（`meeting_archives` 只在全部资产都归档后才建行），
 *   从会议时间起算会把一场刚拉完的老会议立刻判成失败。
 *
 * 这套判据是**启发式**的：`meeting_archives` 没有行只说明「没归成」，说不出
 * 「为什么没归成」——真正的失败原因要等 A4（T11）建 `job_failures` 才落库
 * （计划 §0 E-d）。在那之前，这里宁可用一个说得清的时间判据，也不用一个
 * 「归档失败数恒为 0」的假太平。
 */
export const ARCHIVE_GRACE_SEC = 6 * 3600

/** 分诊条「7 天内到期」的窗口（spec §4.2） */
const EXPIRING_WINDOW_SEC = 7 * 86400

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

// ── SQL 片段 ─────────────────────────────────────────────────────────────

/**
 * 一场会议的四张表拼在一起。
 *
 * `a` 这个聚合子查询**一次把整张 `meeting_assets` 按会议压成一行**，而不是逐会议
 * 去数——后者对 N 场会议就是 N 条查询。`sk` 同理：它只回答「这场会议的归档被人工
 * 关掉了没有」，用来把被人工关掉的会议从「归档失败」里摘出去。
 *
 * `sk` 的判据（`kind='archive'` 且未撤销且 effect 归一化后是 `skip`）与 JS 侧
 * 算 `archive === 'off'` 的判据**必须一致**，否则分诊条数出来的 0 和列表里显示的
 * 状态会打架。测试里有一条同时断言两侧，就是钉这个。
 */
const FROM_SQL = `
  FROM meetings m
  LEFT JOIN (
    SELECT meeting_id, sub_meeting_id,
           COUNT(*) AS total_cnt,
           SUM(status = 'completed') AS completed_cnt,
           SUM(status IN ('pending', 'running')) AS busy_cnt,
           MAX(CASE WHEN status = 'completed' THEN COALESCE(completed_at, updated_at) END)
             AS last_completed_at
      FROM meeting_assets
     GROUP BY meeting_id, sub_meeting_id
  ) a ON a.meeting_id = m.meeting_id AND a.sub_meeting_id = m.sub_meeting_id
  LEFT JOIN meeting_archives ar
    ON ar.meeting_id = m.meeting_id AND ar.sub_meeting_id = m.sub_meeting_id
  LEFT JOIN (
    SELECT DISTINCT meeting_id, sub_meeting_id
      FROM meeting_overrides
     WHERE kind = 'archive' AND revoked_at = 0 AND effect = 'skip'
  ) sk ON sk.meeting_id = m.meeting_id AND sk.sub_meeting_id = m.sub_meeting_id
`

const ROW_COLUMNS = `
  m.meeting_id, m.sub_meeting_id, m.meeting_code, m.subject, m.host_userid,
  m.start_time, m.end_time,
  ar.nas_dir, ar.archived_at, ar.retention_days, ar.extended_days, ar.local_purged_at,
  COALESCE(a.total_cnt, 0) AS total_cnt,
  COALESCE(a.completed_cnt, 0) AS completed_cnt,
  COALESCE(a.busy_cnt, 0) AS busy_cnt,
  a.last_completed_at
`

/**
 * 开始时间倒序。**必须带确定的第二、第三排序键**：`start_time` 有大量并列
 * （同一场周期性会议的各场次、以及 NULL 那一堆），只按它排的话翻页时行会在
 * 页与页之间来回跳，同一场会议出现两次、另一场一次都不出现。
 *
 * MySQL 的 NULL 在 DESC 里排最后，正是要的——没有开始时间的会议在界面上
 * 没有可读的时间，不该插在中间。
 */
const ORDER_SQL = 'ORDER BY m.start_time DESC, m.meeting_id ASC, m.sub_meeting_id ASC'

interface SqlFragment {
  sql: string
  params: unknown[]
}

/**
 * 分诊条某一格的 SQL 判据。`awaitingGrant` 不在这里——它要求值采集权限规则，
 * SQL 表达不了，见 `awaitingGrantKeys`。
 */
function triageFragment(bucket: Exclude<TriageBucket, 'awaitingGrant'>, now: number): SqlFragment {
  switch (bucket) {
    case 'archiveFailed':
      // 判据见 ARCHIVE_GRACE_SEC 的注释。`sk.meeting_id IS NULL` 把被人工关掉归档的
      // 会议摘出去——最高级别告警不许每天报一次假警。
      //
      // 已知的窄边界：`meeting_assets` 里有资产而 `meetings` 表里没有对应行的会议
      // （采集侧的数据不一致，`src/worker/archive.ts` 的 undecidable 分支处理它）
      // 数不进来，因为整个控制台是从 `meetings` 表枚举的——那种会议在列表里本来
      // 也显示不出来。它由归档流水线自己报，不是这一格的活。
      return {
        sql: `(COALESCE(a.completed_cnt, 0) > 0
               AND ar.meeting_id IS NULL
               AND sk.meeting_id IS NULL
               AND a.last_completed_at IS NOT NULL
               AND a.last_completed_at + ${ARCHIVE_GRACE_SEC} < ?)`,
        params: [now],
      }
    case 'expiringIn7d':
      // 这里的算术**必须与 src/worker/retention.ts 的 expiresAt() 逐字同一个公式**：
      // archivedAt + (retentionDays + extendedDays) * 86400。测试里拿那个函数的
      // 返回值直接对着本查询的计数断言，两边哪天漂了当场红。
      //
      // 差值取 `<=`（含边界），且**不排除已经过期的**：清理被暂停时
      // （system_settings.cleanup_paused）窗口早过了文件还在，那种会议更该提醒，
      // 不是更不该。本地已清理的由 local_purged_at 挡在外面——它已经在「仅存 NAS」那一格。
      return {
        sql: `(ar.meeting_id IS NOT NULL
               AND ar.local_purged_at IS NULL
               AND (ar.archived_at + (ar.retention_days + ar.extended_days) * 86400) - ?
                   <= ${EXPIRING_WINDOW_SEC})`,
        params: [now],
      }
    case 'inProgress':
      // spec §4.2 那格写的是「拉取或归档进行中」，这里只数得出拉取那一半：
      // 归档侧没有任何「正在搬」的状态列（没有租约、没有 running），
      // 库里只有「归了没归」两种可观测状态。编一个「归档进行中」出来，
      // 等于把「归档卡住了」显示成「正在处理」——那正是 archiveFailed 要抓的东西。
      return { sql: '(COALESCE(a.busy_cnt, 0) > 0)', params: [] }
    case 'nasOnly':
      return { sql: '(ar.local_purged_at IS NOT NULL)', params: [] }
  }
}

/** 「在保留期内」的判据，两种形态，推理见 `MeetingQuery.inRetention` */
const IN_RETENTION_SQL = `((ar.meeting_id IS NOT NULL AND ar.local_purged_at IS NULL)
   OR (ar.meeting_id IS NULL AND COALESCE(a.completed_cnt, 0) > 0))`

/**
 * LIKE 的字面量转义。**不转义的话管理员搜 `_` 会匹配任意一个字符**，
 * 搜「进度_周会」搜出来的是「进度X周会」——他会以为搜索坏了，或者更糟，
 * 以为那就是全部结果。反斜杠必须先转，否则会把后面转出来的反斜杠再转一遍。
 */
function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** `(meeting_id, sub_meeting_id) IN ((?,?), …)` —— 行构造器 IN，命中主键，一次往返问清整批 */
function keyInFragment(column: string, keys: readonly MeetingKey[]): SqlFragment {
  return {
    sql: `(${column}) IN (${keys.map(() => '(?, ?)').join(', ')})`,
    params: keys.flatMap((k) => [k.meetingId, k.subMeetingId]),
  }
}

// ── 行类型 ───────────────────────────────────────────────────────────────

interface MeetingSqlRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  meeting_code: string | null
  subject: string | null
  host_userid: string | null
  start_time: number | string | null
  end_time: number | string | null
  nas_dir: string | null
  archived_at: number | string | null
  retention_days: number | string | null
  extended_days: number | string | null
  local_purged_at: number | string | null
  total_cnt: number | string
  completed_cnt: number | string
  busy_cnt: number | string
  last_completed_at: number | string | null
}

interface AssetAggRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  asset_type: string
  total_cnt: number | string
  got_cnt: number | string
  bytes_sum: number | string | null
}

interface GrantKeyRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  program_id: string
}

interface CandidateRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  subject: string | null
  host_userid: string | null
  start_time: number | string | null
  end_time: number | string | null
  archived: number | string
}

interface CountRow extends RowDataPacket {
  cnt: number | string
}

/** `loadExtendCounts` 的一行：一场会议（含场次）延长过几次 */
interface ExtendCountRow extends RowDataPacket {
  meeting_id: string
  asset_id: string | null
  cnt: number | string
}

/**
 * `sub:` 前缀的长度。从 `auditSubMeetingAssetId` 现算，**不写死 4**——
 * 那个函数哪天改了前缀，这里跟着走，而写死的 4 会静默把场次 id 切掉一截，
 * 结果是周期性会议的次数分组错位，而且不报任何错。
 */
const AUDIT_SUB_PREFIX_LEN = auditSubMeetingAssetId('').length

/** `buildExtendCountSql` 的一个查询键：一场会议，加上从哪一刻起算 */
export interface ExtendCountKey extends MeetingKey {
  /** unix 秒。这场会议的 `archived_at`——本轮保留窗口的起点，也是这条查询的时间下界 */
  since: number
}

/**
 * 拼出 `keep.extended` 真正执行的那条 SQL（阶段 4 · T17）。空数组返回 `null`
 * ——没有会议要数，就不该有查询。
 *
 * **单独导出是为了让测试能对真正跑的那条语句做 `EXPLAIN`**，沿用 `audit.ts` 的
 * `buildAuditQuerySql` 那条约定：测试里另抄一条等价 SQL 去 EXPLAIN 是自欺，
 * 改了实现忘了改测试，测试照样绿。这条查询尤其值得钉住，理由见下面第一节。
 *
 * ## 一、为什么每一条 OR 里都带 `occurred_at >= ?`，外面还要再套一个下界
 *
 * `audit_log` 上**只有 `idx_audit_time (occurred_at DESC)` 与
 * `idx_audit_actor (actor_id, occurred_at)` 两个索引，没有 `meeting_id` 索引**
 * （见 001 的建表）。按会议查而不给时间下界，就是把整张审计表扫一遍——
 * 控制台每列一页会议都扫一次。
 *
 * 每场会议自己的下界是它的 `archived_at`（本轮保留窗口的起点，语义上就该从这里
 * 数起，见 `ConsoleKeepWindow`），但那是**逐场不同的值**，MySQL 拿它没法开范围扫。
 * 所以外面再套一条全页统一的 `occurred_at >= min(archived_at)`：它是所有逐场下界
 * 里最松的那个，因此**不会漏掉任何一条本该数进来的记录**，同时给了 `idx_audit_time`
 * 一个能开范围扫的常量。逐场那一层负责精确，全页这一层负责走索引，缺一不可。
 *
 * ## 二、为什么按 `(meeting_id, asset_id)` 分组
 *
 * `audit_log` 没有 `sub_meeting_id` 列，场次编在 `asset_id` 里
 * （`auditSubMeetingAssetId`，与写侧共用同一个函数）。只按 `meeting_id` 分组的话，
 * 周期性会议的各场次会共用同一个次数——一场延长了三次，同一个 meeting_id 下
 * 另一场从没延长过的也会跟着显示三次。
 *
 * ## 三、为什么筛 `decision = 'allow'`
 *
 * 只数**真的做成了的**那些。写侧目前只在成功之后记一条 allow，但那不是结构保证：
 * 将来多出一条 deny（比如「文件已清理，延不了」——那个 409 分支现在压根没记审计），
 * 不加这个条件就会把一次**失败的尝试**数成一次延长。
 */
export function buildExtendCountSql(
  keys: readonly ExtendCountKey[],
): { sql: string; params: unknown[] } | null {
  if (keys.length === 0) return null

  // 全页统一的下界：所有逐场下界里最松的那个（见上面第一节）
  let floor = keys[0]!.since
  for (const k of keys) if (k.since < floor) floor = k.since

  const params: unknown[] = [floor, ACTION_EXTEND_RETENTION]
  const ors: string[] = []
  for (const k of keys) {
    ors.push('(meeting_id = ? AND asset_id = ? AND occurred_at >= ?)')
    params.push(k.meetingId, auditSubMeetingAssetId(k.subMeetingId), k.since)
  }

  return {
    sql: `SELECT meeting_id, asset_id, COUNT(*) AS cnt
            FROM audit_log
           WHERE occurred_at >= ?
             AND action = ?
             AND decision = 'allow'
             AND (${ors.join(' OR ')})
           GROUP BY meeting_id, asset_id`,
    params,
  }
}

/** `meetings` 里做判定事实用的那几列。`MetaSqlRow` 与「待授权」的候选行都长这样 */
interface MeetingMetaColumns {
  meeting_id: string
  sub_meeting_id: string
  meeting_code: string | null
  subject: string | null
  host_userid: string | null
  start_time: number | string | null
  end_time: number | string | null
}

type MetaSqlRow = RowDataPacket & MeetingMetaColumns

/**
 * BIGINT / DECIMAL 列显式 Number 化。
 *
 * mysql2 把 `SUM()` 这类 DECIMAL 结果**按字符串返回**，把 `COUNT()` 的 BIGINT
 * 在超出安全范围时也返回字符串。不转的话 `got + 1` 会拼出 `"11"`，而这个值
 * 最终会进 JSON 响应——前端拿到的是另一种类型，而且是间歇性的（数小才不出事）。
 */
function num(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback
  return typeof value === 'number' ? value : Number(value)
}

function numOrNull(value: number | string | null | undefined): number | null {
  return value === null || value === undefined ? null : num(value)
}

// ── 拼装 ─────────────────────────────────────────────────────────────────

function keyOf(row: { meeting_id: string; sub_meeting_id: string }): string {
  return archiveStateKey(row.meeting_id, row.sub_meeting_id)
}

/** 这场会议每一类资产的 got / total，以及认不出的那些类型 */
interface AssetSummary {
  assets: Partial<Record<AssetKey, { got: number; total: number }>>
  unknown: string[]
  sizeBytes: number | null
}

function summarizeAssets(rows: readonly AssetAggRow[]): AssetSummary {
  const byKey = new Map<AssetKey, { got: number; total: number }>()
  const unknown: string[] = []
  let bytes: number | null = null
  for (const r of rows) {
    const sum = numOrNull(r.bytes_sum)
    if (sum !== null) bytes = (bytes ?? 0) + sum
    const key = GATEWAY_TYPE_TO_ASSET_KEY[r.asset_type]
    if (key === undefined) {
      // 认不出的类型不进 assets（契约那个对象的键是封闭的八个 AssetKey），
      // 但也不静默丢掉——它确实占着这场会议的资产行
      if (!unknown.includes(r.asset_type)) unknown.push(r.asset_type)
      continue
    }
    const cur = byKey.get(key) ?? { got: 0, total: 0 }
    cur.got += num(r.got_cnt)
    cur.total += num(r.total_cnt)
    byKey.set(key, cur)
  }
  // 按 ALL_ASSET_KEYS 的顺序落进对象：顺序稳定，同一场会议两次请求拿到的
  // JSON 键序一致（用不上的类不出现，见 ConsoleMeetingRow.assets 的注释）
  const assets: Partial<Record<AssetKey, { got: number; total: number }>> = {}
  for (const k of ALL_ASSET_KEYS) {
    const v = byKey.get(k)
    if (v !== undefined) assets[k] = v
  }
  return { assets, unknown: unknown.sort(), sizeBytes: bytes }
}

/**
 * 库里的一条改写行是不是「把这一阶段关掉」。
 *
 * 走 `normalizeEffect` 而不是直接比 `effect === 'skip'`：改写的 effect 是自由文本，
 * 认不出的取值在求值器里一律落到本栈的安全侧（fetch/archive 都是「不做」）。
 * 界面必须显示求值器**真正会做的那件事**，否则一条填错了的改写在列表里看起来
 * 什么都没发生，而实际上它已经把这个阶段关掉了。
 */
function isStageOff(kind: 'fetch' | 'archive', override: PolicyOverride | null | undefined): boolean {
  if (override === null || override === undefined) return false
  return normalizeEffect(kind, override.effect).effect === 'skip'
}

const HAND_ORDER: HandKind[] = ['fetch', 'archive', 'allow']

/**
 * 「延长过几次」的两层判据，实现见 `ConsoleKeepWindow` 的说明。
 *
 * `auditCount` 传 0 有两种来源——审计里真的一条都没有，或者压根没去查（
 * `extendedDays === 0` 时不查，见 `assemble`）。两者在这里的结论相同，
 * 所以不必区分：第一层已经把 `extendedDays === 0` 挡在外面了。
 */
function extendedCountOf(
  extendedDays: number,
  auditCount: number,
): { extended: number; source: ExtendedSource } {
  // 第一层：extended_days 说了算「有没有延长过」。审计里的孤儿记录（上一轮
  // 归档窗口留下的）不许把一场没延长过的会议说成延长过
  if (extendedDays <= 0) return { extended: 0, source: 'none' }
  // 第二层：延长过，次数交给审计。数不到就退回下界 1，并标明它是下界——
  // 报 0 等于说「从没延长过」，与 extendedDays > 0 直接打架
  if (auditCount > 0) return { extended: auditCount, source: 'audit' }
  return { extended: 1, source: 'floor' }
}

function assembleRow(
  r: MeetingSqlRow,
  now: number,
  assetRows: readonly AssetAggRow[],
  grantIds: readonly string[],
  overrides: MeetingOverrideSet,
  auditExtendCount: number,
): ConsoleMeetingRow {
  const missing: MeetingNullField[] = []
  if (r.subject === null) missing.push('title')
  if (r.meeting_code === null) missing.push('code')
  if (r.host_userid === null) missing.push('host')
  if (r.start_time === null) missing.push('startAt')
  if (r.end_time === null) missing.push('endAt')

  const startAt = num(r.start_time)
  const endAt = num(r.end_time)
  // `end <= start` 与「没有结束时间」是同一件事：`record_files` 缺 record_end_time
  // 时 endTime 回落成 media_start_time，此时差值是 0 或负数。照直算成负时长会在
  // 界面上显示成「-1:02」，算成 0 与 `domain/types.ts` 对这条回落路径的口径一致。
  const durationSec = r.start_time === null || r.end_time === null || endAt <= startAt ? 0 : endAt - startAt

  const { assets, unknown, sizeBytes } = summarizeAssets(assetRows)

  const totalCnt = num(r.total_cnt)
  const completedCnt = num(r.completed_cnt)
  const busyCnt = num(r.busy_cnt)
  const lastCompletedAt = numOrNull(r.last_completed_at)
  const archived = r.archived_at !== null

  let fetch: FetchState
  if (isStageOff('fetch', overrides.fetch)) {
    // 契约把这个取值说得很明白：拉取的圆点本身就是开关，人工关掉一次已完成的
    // 拉取之后，它既不是 blocked（那是规则做的决定）也不是 none（那是压根没录制）
    fetch = 'off'
  } else if (totalCnt === 0) {
    fetch = 'none'
  } else if (busyCnt > 0) {
    fetch = 'running'
  } else {
    // 全部资产都终结了。**包括一个都没拿到的情况**：契约的 FetchState 没有
    // 'failed' 这个取值，报 'none'（无录制）是错的——明明有录制，只是一个都没
    // 拉下来。这件事由 assets 的 `0/N` 说出来，那也是 spec §4.2 表格列里写的
    // 「`0/19`（部分失败）」的表达方式。
    fetch = 'done'
  }

  let archiveState: ArchiveState
  if (isStageOff('archive', overrides.archive)) {
    archiveState = 'off'
  } else if (completedCnt === 0) {
    // 没有下载完成的资产就没东西可归档。这不是失败，也不是「进行中」
    archiveState = 'none'
  } else if (archived) {
    archiveState = 'done'
  } else if (lastCompletedAt !== null && lastCompletedAt + ARCHIVE_GRACE_SEC < now) {
    archiveState = 'failed'
  } else {
    archiveState = 'running'
  }

  const archiveRecord: MeetingArchiveRecord | null = archived
    ? {
        meetingId: r.meeting_id,
        subMeetingId: r.sub_meeting_id,
        nasDir: r.nas_dir ?? '',
        archivedAt: num(r.archived_at),
        retentionDays: num(r.retention_days),
        extendedDays: num(r.extended_days),
        localPurgedAt: numOrNull(r.local_purged_at),
      }
    : null

  // 没有归档行 = 保留窗口还没开始计时，也就没有「延长过」这回事
  const extendedDays = archiveRecord === null ? 0 : archiveRecord.extendedDays
  const { extended, source: extendedSource } = extendedCountOf(extendedDays, auditExtendCount)

  return {
    id: consoleMeetingId(r.meeting_id, r.sub_meeting_id),
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    title: r.subject ?? '',
    code: r.meeting_code ?? '',
    startAt,
    durationSec,
    host: r.host_userid ?? '',
    missing,
    assets,
    unknownAssetTypes: unknown,
    fetch,
    archive: archiveState,
    grants: [...grantIds],
    hand: HAND_ORDER.filter((k) => overrides[k] !== undefined && overrides[k] !== null),
    keep: {
      archivedAt: archiveRecord === null ? null : archiveRecord.archivedAt,
      // 公式只有一处（retention.ts），这里调它，不重抄
      expiresAt: archiveRecord === null ? null : retentionExpiresAt(archiveRecord),
      extended,
      extendedSource,
      extendedDays,
      retentionDays: archiveRecord === null ? null : archiveRecord.retentionDays,
      filesGone: archiveRecord !== null && archiveRecord.localPurgedAt !== null,
    },
    nasPath: r.nas_dir,
    sizeBytes,
  }
}

/**
 * 这一行**哪几项判定事实在库里是 NULL**（阶段 4 · T13）。
 *
 * 与上面那份给界面看的 `MeetingNullField` 是两套词汇，故意不合并：那份多一个
 * `code`（会议号不参与任何条件求值），少了「事实」这一层的口径；这份要与
 * `policy/conds.ts` 的 `MeetingFacts` 字段名逐字对上，否则求值器那边对不上号。
 * 两处各自的注释都指着对方，改一处时看得见另一处。
 */
function missingFactsOf(r: MeetingMetaColumns): MeetingFactKey[] {
  const missing: MeetingFactKey[] = []
  if (r.subject === null) missing.push('title')
  if (r.host_userid === null) missing.push('hostUserId')
  if (r.start_time === null) missing.push('startTime')
  if (r.end_time === null) missing.push('endTime')
  return missing
}

/**
 * `meetings` 的一行 → 网关的域模型 `Meeting`。空值口径见 `getMeetings` 的注释。
 *
 * **NULL 照旧折成空串 / 0，但同时记一笔账**（阶段 4 · T13）：折完之后一场
 * `subject IS NULL` 的会议与一场标题真的是空串的会议在求值器眼里一模一样，
 * 于是 `title has 财务 → deny` 对前者判「不匹配」、落到放行侧，再被一条低优先级的
 * allow 接手——静默放行。`missingFacts` 就是那笔账，`policy/access.ts` 的
 * `meetingFacts` 会把它转成 `MeetingFacts.missing`。
 *
 * **改回去（不填 missingFacts）会怎样**：判定重新退回「事实齐全」，上面那条路
 * 原样回来；而且没有任何地方会报错，只有生产上被多放出去的会议。
 */
function toDomainMeeting(r: MeetingMetaColumns): MeetingMeta {
  const missingFacts = missingFactsOf(r)
  return {
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    // 空数组一律不带出去，让下游只有「有没有」一种判断形态
    ...(missingFacts.length > 0 ? { missingFacts } : {}),
    // `meetings` 表没有这一列，判定事实（`meetingFacts`）也不读它。
    // 与 `src/worker/archive.ts` 的 factsFor 同一裁定：填空串，不编一个 id。
    meetingRecordId: '',
    meetingCode: r.meeting_code ?? '',
    subject: r.subject ?? '',
    hostUserId: r.host_userid ?? '',
    startTime: num(r.start_time),
    endTime: num(r.end_time),
    // `meetings` 表**没有 state 列**（录制状态只在 meeting_cache 里，见 E-a）。
    // 填 'completed' 与 archive.ts 的 factsFor 同一裁定：能进 `meetings` 表的
    // 会议是 discovery 发现的已结束录制，而且规则条件里没有任何一个字段读
    // `state`（`policy/conds.ts` 的 MeetingFacts 里压根没有它），所以这个值
    // 不参与任何判定。它在这里只是为了满足域模型的类型。
    state: 'completed',
  }
}

// ── 实现 ─────────────────────────────────────────────────────────────────

export function createConsoleMeetingsStore(
  pool: Pool,
  deps: { policy?: PolicyStore } = {},
): ConsoleMeetingsStore {
  const policy = deps.policy ?? createPolicyStore(pool)
  // 改写的批量读法 `grants.ts` 已经有了（`listActiveOverridesForMeetings`），
  // 复用它而不是在这里再写一条同样的 SQL——两份实现对同一张表迟早会分叉。
  const grantsStore = createGrantsStore(pool)

  /** 这一页的资产聚合。一次问清整页，不逐会议查 */
  async function loadAssets(keys: readonly MeetingKey[]): Promise<Map<string, AssetAggRow[]>> {
    const inFrag = keyInFragment('meeting_id, sub_meeting_id', keys)
    const [rows] = await pool.query<AssetAggRow[]>(
      `SELECT meeting_id, sub_meeting_id, asset_type,
              COUNT(*) AS total_cnt,
              SUM(status = 'completed') AS got_cnt,
              SUM(CASE WHEN status = 'completed' THEN bytes_expected ELSE NULL END) AS bytes_sum
         FROM meeting_assets
        WHERE ${inFrag.sql}
        GROUP BY meeting_id, sub_meeting_id, asset_type
        ORDER BY asset_type`,
      inFrag.params,
    )
    const out = new Map<string, AssetAggRow[]>()
    for (const r of rows) {
      const k = keyOf(r)
      const list = out.get(k)
      if (list === undefined) out.set(k, [r])
      else list.push(r)
    }
    return out
  }

  /**
   * 这一页每场会议当前生效的采集程序。
   *
   * `GrantsStore` 只有逐场的 `listActiveGrantsForMeeting`，没有批量版——列一页
   * 50 行就是 50 次往返。这条查询放在本文件是刻意的：它只取 `program_id` 一列
   * （契约的 `Meeting.grants` 要的就是一串 id），不带 `asset_types`，因此
   * **不能**被当成判定路径上的授权读法用。真要判「这个程序取不取得到」
   * 走 `findActiveGrant` / `computeProgramInventory`，那里三态的 asset_types
   * 一个都不能少（005 的表头注释解释了为什么空数组不是「不限制」）。
   */
  async function loadGrants(keys: readonly MeetingKey[]): Promise<Map<string, string[]>> {
    const inFrag = keyInFragment('meeting_id, sub_meeting_id', keys)
    const [rows] = await pool.query<GrantKeyRow[]>(
      `SELECT meeting_id, sub_meeting_id, program_id
         FROM meeting_grants
        WHERE revoked_at = 0 AND ${inFrag.sql}
        ORDER BY program_id`,
      inFrag.params,
    )
    const out = new Map<string, string[]>()
    for (const r of rows) {
      const k = keyOf(r)
      const list = out.get(k)
      if (list === undefined) out.set(k, [r.program_id])
      else list.push(r.program_id)
    }
    return out
  }

  /**
   * 这一页每场会议**被人工延长过几次**（阶段 4 · T17）。
   *
   * SQL 与它的全部推理（时间下界为什么要两层、为什么按 `(meeting_id, asset_id)`
   * 分组、为什么筛 `decision = 'allow'`）在 `buildExtendCountSql`——那条查询单独
   * 导出是为了让测试能对它做 `EXPLAIN`。判据的两层结构见 `ConsoleKeepWindow`。
   *
   * ## 查询数
   *
   * **一条，与行数无关**；而且只在这一页里真有会议延长过时才发（`extended_days > 0`
   * 是延长过的充要条件——`extendRetention` 是唯一的累加者，且每次至少加 1 天）。
   * 一页会议里一场都没延长过是常态，那时这条查询不发，`audit_log` 一次都不碰。
   */
  async function loadExtendCounts(
    keys: readonly ExtendCountKey[],
  ): Promise<Map<string, number>> {
    const built = buildExtendCountSql(keys)
    if (built === null) return new Map()

    const [rows] = await pool.query<ExtendCountRow[]>(built.sql, built.params)

    const out = new Map<string, number>()
    for (const r of rows) {
      // asset_id 一定是 `sub:<subMeetingId>`（`buildExtendCountSql` 的 WHERE
      // 就是按它匹配的），这里把前缀剥回去还原成主键的第二段
      const sub = r.asset_id === null ? '' : r.asset_id.slice(AUDIT_SUB_PREFIX_LEN)
      out.set(archiveStateKey(r.meeting_id, sub), num(r.cnt))
    }
    return out
  }

  async function assemble(rows: readonly MeetingSqlRow[], now: number): Promise<ConsoleMeetingRow[]> {
    if (rows.length === 0) return []
    const keys: MeetingKey[] = rows.map((r) => ({
      meetingId: r.meeting_id,
      subMeetingId: r.sub_meeting_id,
    }))
    // 只有「归了档、而且延长过」的会议才需要去数审计：`extended_days === 0` 的
    // 会议结论已经确定（见 extendedCountOf 的第一层），去查一趟纯属白花钱；
    // 而没有归档行的会议连时间下界都没有，那条查询会退化成全表扫。
    const extendKeys = rows
      .filter((r) => r.archived_at !== null && num(r.extended_days) > 0)
      .map((r) => ({
        meetingId: r.meeting_id,
        subMeetingId: r.sub_meeting_id,
        since: num(r.archived_at),
      }))

    // 四条查询并发发出去，且**每条都是整页一次**——这是「N+1 不许有」那条验收
    // 的落点。想知道列一页发了几次查询，数这里就够了：分页 1 + 计数 1 + 这里 3，
    // 外加这一页真有会议被延长过时的第 4 条（延长次数，见 loadExtendCounts）。
    const [assetsByKey, grantsByKey, overrideRows, extendCounts] = await Promise.all([
      loadAssets(keys),
      loadGrants(keys),
      grantsStore.listActiveOverridesForMeetings([...keys]),
      loadExtendCounts(extendKeys),
    ])

    const overridesByKey = new Map<string, PolicyOverride[]>()
    for (const o of overrideRows) {
      const k = archiveStateKey(o.meetingId, o.subMeetingId)
      const list = overridesByKey.get(k)
      if (list === undefined) overridesByKey.set(k, [o])
      else list.push(o)
    }

    return rows.map((r) => {
      const k = keyOf(r)
      return assembleRow(
        r,
        now,
        assetsByKey.get(k) ?? [],
        grantsByKey.get(k) ?? [],
        // 同一栈上有多条改写时由 indexOverrides 挑最新的那条——库里有唯一键管着，
        // 但读出来的顺序不该决定谁说了算
        indexOverrides(overridesByKey.get(k) ?? []),
        // 没去数（extended_days === 0）与数出来是 0 在这里同义，见 extendedCountOf
        extendCounts.get(k) ?? 0,
      )
    })
  }

  /**
   * 「待授权」那一格的会议键。
   *
   * spec §4.2 的定义是「**准许采集**但没给程序」，验收判据写成「采集权限规则判
   * allow、但 `meeting_grants` 里一条生效授权都没有」。**这个数算不出纯 SQL 版**：
   * 采集权限栈（allow）的主体是**采集程序**，一条规则只对 `subject_value` 那个
   * 程序生效（`policy/stacks.ts` 的 `checkSubject`），所以「规则判 allow」这句话
   * 离开程序就没有意义。
   *
   * 于是这里的裁定是：**「准许采集」= 至少有一个采集程序会被判 allow**。
   * 候选程序取「启用的 allow 规则上出现过的 `subject_value`」——没有规则指向的
   * 程序永远走兜底 deny，把它算进来也不会改变任何一场会议的结论。
   *
   * 为什么不退回「有东西可取但没授权」这种纯 SQL 的近似：现在这个部署的
   * `policy_rules` 是空的（004 把旧规则备份后清空了），近似版会报出「全部会议
   * 待授权」，而实际上管理员就算真去授权了，allow 栈照样兜底 deny、程序还是
   * 取不到。**那不是一个偏大的数，那是一个方向就错的数。**
   *
   * 规模：与计划 §0 E-e「不开缓存表、A2/A3 现算」同一笔账——查询数固定
   * （规则 1 次、改写 1 次、候选会议 1 次），求值是纯函数、几百场会议 ×
   * 1–3 个程序在内存里跑完是毫秒级。真慢了再优化是纯增量改动，
   * 先开缓存表才是不可逆的那个方向。
   */
  async function awaitingGrantKeys(now: number): Promise<MeetingKey[]> {
    const rules = await policy.listEnabledStackRules('allow')
    const programs: string[] = []
    for (const r of rules) {
      const v = r.subjectValue ?? ''
      if (r.subjectType === 'program' && v !== '' && !programs.includes(v)) programs.push(v)
    }

    // 人工改写**优先于所有规则**（spec §5.4），它不需要任何规则存在就能把一场
    // 会议翻成 allow。所以「没有规则就早退」不能把改写一起早退掉：两边都空才是真的空。
    const [overrideRows] = await pool.query<RowDataPacket[]>(
      `SELECT meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at
         FROM meeting_overrides
        WHERE kind = 'allow' AND revoked_at = 0
        ORDER BY id`,
    )
    if (programs.length === 0 && overrideRows.length === 0) return []

    const [candidates] = await pool.query<CandidateRow[]>(
      `SELECT m.meeting_id, m.sub_meeting_id, m.subject, m.host_userid, m.start_time, m.end_time,
              (ar.meeting_id IS NOT NULL) AS archived
         FROM meetings m
         LEFT JOIN meeting_archives ar
           ON ar.meeting_id = m.meeting_id AND ar.sub_meeting_id = m.sub_meeting_id
        WHERE NOT EXISTS (
                SELECT 1 FROM meeting_grants g
                 WHERE g.meeting_id = m.meeting_id
                   AND g.sub_meeting_id = m.sub_meeting_id
                   AND g.revoked_at = 0)
        ORDER BY m.meeting_id, m.sub_meeting_id`,
    )
    if (candidates.length === 0) return []

    const overridesByKey = new Map<string, PolicyOverride[]>()
    for (const raw of overrideRows) {
      const o = raw as RowDataPacket & {
        meeting_id: string
        sub_meeting_id: string
        kind: string
        effect: string
        asset_types: unknown
        reason: string | null
        created_at: number | string
      }
      const parsed: PolicyOverride = {
        meetingId: o.meeting_id,
        subMeetingId: o.sub_meeting_id,
        kind: o.kind as PolicyOverride['kind'],
        effect: o.effect,
        assetTypes: parseAssetTypes(o.asset_types),
        reason: o.reason,
        createdAt: num(o.created_at),
      }
      const k = archiveStateKey(o.meeting_id, o.sub_meeting_id)
      const list = overridesByKey.get(k)
      if (list === undefined) overridesByKey.set(k, [parsed])
      else list.push(parsed)
    }

    // 一条规则都没有、只有改写时也要跑一轮：空 programId 让规则侧全部判不适用，
    // 改写照样套得上去（applyOverride 是替换语义）
    const passes = programs.length > 0 ? programs : ['']
    const out: MeetingKey[] = []
    for (const c of candidates) {
      // 候选行只取了求值事实用得上的四列（`meetingFacts` 读 subject / host_userid /
      // start_time / end_time，见 policy/conds.ts 的 MeetingFacts），meeting_code
      // 不参与任何条件，所以不查也不填——这里传 null 也**不会**被记成缺失事实
      // （`missingFactsOf` 只认那四列），否则每一行都会平白判成「元数据不全」。
      const facts = meetingFacts(
        toDomainMeeting({
          meeting_id: c.meeting_id,
          sub_meeting_id: c.sub_meeting_id,
          meeting_code: null,
          subject: c.subject,
          host_userid: c.host_userid,
          start_time: c.start_time,
          end_time: c.end_time,
        }),
        num(c.archived) !== 0,
      )
      const set = indexOverrides(overridesByKey.get(keyOf(c)) ?? [])
      let allowed = false
      for (const programId of passes) {
        const base = evaluateAllowStack(rules, { facts, now, programId })
        // isVisible 而不是 `effect === 'allow'`：一条 effect=allow 但 asset_types
        // 里一个合法资产键都没有的规则，判定是 allow 而实际一类都取不到。
        // 把这种会议算进「待授权」，管理员照着去授权，授完还是取不到。
        if (isVisible(applyOverride(base, set.allow))) {
          allowed = true
          break
        }
      }
      if (allowed) out.push({ meetingId: c.meeting_id, subMeetingId: c.sub_meeting_id })
    }
    return out
  }

  /** 组装 WHERE。返回 null 表示「筛选条件已经确定结果是空集」，不必再查库 */
  async function buildWhere(q: MeetingQuery): Promise<SqlFragment | null> {
    const parts: string[] = []
    const params: unknown[] = []

    if (q.search !== undefined && q.search !== '') {
      const like = `%${escapeLike(q.search)}%`
      parts.push('(m.subject LIKE ? OR m.meeting_code LIKE ? OR m.host_userid LIKE ?)')
      params.push(like, like, like)
    }
    if (q.hasGrant !== undefined) {
      const exists = `EXISTS (SELECT 1 FROM meeting_grants g
                               WHERE g.meeting_id = m.meeting_id
                                 AND g.sub_meeting_id = m.sub_meeting_id
                                 AND g.revoked_at = 0)`
      parts.push(q.hasGrant ? exists : `NOT ${exists}`)
    }
    if (q.hasOverride !== undefined) {
      const exists = `EXISTS (SELECT 1 FROM meeting_overrides o
                               WHERE o.meeting_id = m.meeting_id
                                 AND o.sub_meeting_id = m.sub_meeting_id
                                 AND o.revoked_at = 0)`
      parts.push(q.hasOverride ? exists : `NOT ${exists}`)
    }
    if (q.inRetention !== undefined) {
      parts.push(q.inRetention ? IN_RETENTION_SQL : `NOT ${IN_RETENTION_SQL}`)
    }
    if (q.triage === 'awaitingGrant') {
      // 这一格筛不出纯 SQL 条件，只能先把键集算出来再 IN 进去（理由见 awaitingGrantKeys）
      const keys = await awaitingGrantKeys(q.now)
      if (keys.length === 0) return null
      const frag = keyInFragment('m.meeting_id, m.sub_meeting_id', keys)
      parts.push(frag.sql)
      params.push(...frag.params)
    } else if (q.triage !== undefined) {
      const frag = triageFragment(q.triage, q.now)
      parts.push(frag.sql)
      params.push(...frag.params)
    }

    return {
      sql: parts.length === 0 ? '' : `WHERE ${parts.join(' AND ')}`,
      params,
    }
  }

  return {
    async list(q) {
      const where = await buildWhere(q)
      if (where === null) return { rows: [], total: 0 }

      // LIMIT / OFFSET 拼进 SQL 而不是走占位符：先收敛成整数再拼，避免依赖
      // mysql2 对 `LIMIT ?` 的参数类型处理（它把参数当字符串发过一次，历史上
      // 各版本行为不一致）。收敛本身也是必需的——上限挡住「一次拉全表」。
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Number.isFinite(q.limit) ? Math.trunc(q.limit as number) : DEFAULT_LIMIT),
      )
      const offset = Math.max(0, Number.isFinite(q.offset) ? Math.trunc(q.offset as number) : 0)

      const [countRows] = await pool.query<CountRow[]>(
        `SELECT COUNT(*) AS cnt ${FROM_SQL} ${where.sql}`,
        where.params,
      )
      const [rows] = await pool.query<MeetingSqlRow[]>(
        `SELECT ${ROW_COLUMNS} ${FROM_SQL} ${where.sql} ${ORDER_SQL} LIMIT ${limit} OFFSET ${offset}`,
        where.params,
      )
      return { rows: await assemble(rows, q.now), total: num(countRows[0]?.cnt) }
    },

    async triage(now) {
      // 四格一条查询算完（每格一个 SUM(CASE …)）。第五格 awaitingGrant 要求值
      // 采集权限规则，SQL 表达不了，与这条并发跑。
      const failed = triageFragment('archiveFailed', now)
      const expiring = triageFragment('expiringIn7d', now)
      const inProgress = triageFragment('inProgress', now)
      const nasOnly = triageFragment('nasOnly', now)
      const [[counts], waiting] = await Promise.all([
        pool.query<CountRow[]>(
          `SELECT
             COALESCE(SUM(CASE WHEN ${failed.sql} THEN 1 ELSE 0 END), 0) AS archive_failed,
             COALESCE(SUM(CASE WHEN ${expiring.sql} THEN 1 ELSE 0 END), 0) AS expiring_7d,
             COALESCE(SUM(CASE WHEN ${inProgress.sql} THEN 1 ELSE 0 END), 0) AS in_progress,
             COALESCE(SUM(CASE WHEN ${nasOnly.sql} THEN 1 ELSE 0 END), 0) AS nas_only
           ${FROM_SQL}`,
          [...failed.params, ...expiring.params, ...inProgress.params, ...nasOnly.params],
        ),
        awaitingGrantKeys(now),
      ])
      const row = counts[0] as (CountRow & Record<string, number | string>) | undefined
      return {
        archiveFailed: num(row?.archive_failed),
        expiringIn7d: num(row?.expiring_7d),
        awaitingGrant: waiting.length,
        inProgress: num(row?.in_progress),
        nasOnly: num(row?.nas_only),
      }
    },

    async get(meetingId, subMeetingId, now) {
      // 按**真实主键**取，两段都要：只按 meeting_id 取的话，周期性会议会被
      // 另一个场次顶替（`src/worker/store-mysql.ts` 的 meetingsForPaths 就踩过
      // 「按 meeting_id 去重」这个坑，那里已经记着教训）。
      const [rows] = await pool.query<MeetingSqlRow[]>(
        `SELECT ${ROW_COLUMNS} ${FROM_SQL} WHERE m.meeting_id = ? AND m.sub_meeting_id = ?`,
        [meetingId, subMeetingId],
      )
      const assembled = await assemble(rows, now)
      return assembled[0] ?? null
    },

    async getMeetings(keys) {
      // 传空数组时不查库，直接返回空数组——与 archives.ts 那一族批量读法同一约定
      if (keys.length === 0) return []
      const inFrag = keyInFragment('meeting_id, sub_meeting_id', keys)
      const [rows] = await pool.query<MetaSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time
           FROM meetings
          WHERE ${inFrag.sql}`,
        inFrag.params,
      )
      // 查不到的会议**不出现在结果里**，不造空壳顶上（`VisibilityDeps.getMeetings`
      // 的注释写明了原因）。查得到但列是 NULL 的行照样返回：那场会议真的存在，
      // 只是元数据不全，按仓库既有口径补成空串 / 0 交给求值器——
      // 与「这场会议不在库里」是两回事，不许混成一件。
      // 补空串的同时 `toDomainMeeting` 会记一笔 `missingFacts`（阶段 4 · T13），
      // 求值器据此把这场会议判成「判不出来」而不是「不匹配」。
      return rows.map(toDomainMeeting)
    },
  }
}

/**
 * `meeting_overrides.asset_types` 的三态解析。**空数组不是「不限制」**
 * （005 的表头注释）：`null` = 不另行指定、非空数组 = 白名单、`[]` = 一类都不放行。
 * 三者在读侧也不许合并——在授权中枢里让空集合意外等价于全集，正是
 * 「不许静默放行」要防的事故。
 *
 * 解析不出来时回 `null`（沿用被改写掉的那个判定的范围），与 `grants.ts` 同口径。
 */
function parseAssetTypes(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as string[]) : null
    } catch {
      return null
    }
  }
  return null
}
