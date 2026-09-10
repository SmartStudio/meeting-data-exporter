/**
 * 网关 API 的形状。所有时间字段都是 unix 秒（网关侧全部时间列是 BIGINT 存
 * unix 秒，见仓库根 `migrations/002_worker_queue.sql`）。所有数量字段都是数字。
 *
 * 组件里需要的展示串（"8-21 14:00" / "1:52" / "22.8 MB" / "8 月 21 日"）
 * 一律由 `lib/format.ts` 从这里的原始值现算，不在这层预先格式化——
 * 否则 F6 换真 API 时每个组件都要重写。
 */

/**
 * 与网关的 AssetKey 逐字一致。不要引入 summary / aitr / digest 那套短名——
 * 同一批资产已经有过三套叫法，M3.5 为此吃过一次亏（见 dev-plan.md §5 C7）。
 */
export type AssetKey =
  | 'video'
  | 'audio'
  | 'transcript'
  | 'ai_minutes'
  | 'chapters'

/**
 * 拉取阶段的状态。
 *
 * `'off'` 是 F1 Task 6 补上的：拉取的圆点本身就是开关（spec.md §4.2「圆点即开关，
 * 点一下就能重跑该阶段」），把一个已完成的拉取人工关掉之后，这个阶段就既不是
 * `'blocked'`（那是规则做出的决定）也不是 `'none'`（那是压根没有录制），必须有
 * 自己的取值——原型的 `toggleStage()` 正是把 `m.fetch` 置成 `'off'`，它的
 * `STAGE_LABEL` 也是 fetch/archive 两阶段共用、`off = '未执行'`。
 * spec.md §6.1 的类型声明漏收了它，与 T2 当初给 `ArchiveState` 补 `'none'` 是
 * 同一类缺口（见 task-2-report §6.2）。
 */
export type FetchState = 'done' | 'running' | 'blocked' | 'off' | 'none'
export type ArchiveState = 'done' | 'running' | 'failed' | 'off' | 'blocked' | 'none'
export type AllowState = 'allow' | 'deny'

/**
 * 判定理由的来源。呈现样式由它决定：
 * rule 中性 · hand 琥珀 · fail 红 · expired/wait/na 是生命周期原因，
 * 优先级高于权限原因（详见 spec.md §6.1）。
 *
 * deny 专指「有一条规则明确拒绝」，只能配 allow: 'deny' 用。
 * 状态说准许、理由却标 deny 会渲染成「被拒绝」的样式，与状态自相矛盾——
 * 「规则允许但还没授权给任何程序」属于 rule，不属于 deny。
 */
export type WhyKind = 'rule' | 'hand' | 'fail' | 'expired' | 'wait' | 'na' | 'deny'
export interface Why {
  by: WhyKind
  text: string
}

export interface KeepWindow {
  /** unix 秒。归档成功的那一刻——保留窗口从这里起算，不是从会议日 */
  archivedAt: number | null
  /** unix 秒。archivedAt + keepDays，由后端算好下发 */
  expiresAt: number | null
  /**
   * 被人工延长过几次。网关数的是 `audit_log` 里这场会议的「延长保留」条数。
   *
   * **有一种情况它只是下界**：审计从阶段 4 · T8 才开始记延长操作，在那之前
   * 延长过的会议数不出真实次数，网关报 1（报 0 等于说「从没延长过」，
   * 而它明明被延长过）。网关同时下发一个 `extendedSource` 字段说明这个数
   * 是不是下界（`'floor'` = 是），契约里没有它，要区分「已延长 1 次」和
   * 「至少延长过 1 次」时读它。
   *
   * **「延长了多少天」不要拿这个数乘保留天数**——一次延长几天是可以指定的，
   * 真实天数在网关下发的 `extendedDays` 里。
   */
  extended: number
  /** 本地文件是否已被到期清理删掉（记录与 NAS 路径仍在） */
  filesGone: boolean
}

export interface Meeting {
  id: string
  title: string
  code: string
  /** unix 秒 */
  startAt: number
  /** 秒。endAt - startAt，后端算好下发 */
  durationSec: number
  host: string
  /** 各类资产已拿到 / 应有。null 表示该类不适用 */
  assets: Partial<Record<AssetKey, { got: number; total: number }>>
  fetch: FetchState
  archive: ArchiveState
  allow: AllowState
  /** 已授权的采集程序 id。只有 allow 且在保留期内才有意义 */
  grants: string[]
  /** 被人工改写过的阶段 */
  hand: Array<'fetch' | 'archive' | 'allow'>
  keep: KeepWindow
  nasPath: string | null
  /** 字节 */
  sizeBytes: number | null
  why: { fetch: Why; archive: Why; allow: Why }
  history: Array<{ at: number; text: string }>
}

/**
 * 采集程序在会议记录页里需要的那一小块（授权面板要列出"授权给谁"）。
 * 采集授权页用的是完整的 `ServiceProgram`（`api/admin/grants.ts`）。
 *
 * **`scope` 已经删掉，不要再加回来**（阶段 5 · F4，2026-08-26）：它在 mock 里是
 * 一个配置串（'AI 纪要 + 完整转写'），而真实的 `GET /api/v1/admin/programs`
 * 根本不下发这个字段。spec.md §4.5 明说采集授权页那句话「**是三个「与」求交
 * 之后的实际结果，不是配置值**」——下发一个未经求交的配置串，等于把它伪装成
 * 一次实际结果。要说"这个程序能取到什么"，唯一的来源是
 * `GET /api/v1/admin/programs/:id/inventory` 的 `assetTypes`。
 */
export interface Consumer {
  id: string
  name: string
}

/** 分诊条五格。每格可点即筛选 */
export interface Triage {
  archiveFailed: number
  expiringIn7d: number
  awaitingGrant: number
  inProgress: number
  nasOnly: number
}

/**
 * 系统状态。五种形态是规格的一部分（spec.md §7、§8），不是彩蛋——
 * 每种的告警等级和给出的操作都不一样。
 */
export type SystemState = 'ok' | 'loading' | 'load-failed' | 'empty' | 'nas-down' | 'tencent-down'
