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
  | 'ai_transcript'
  | 'ai_minutes'
  | 'ai_topic_minutes'
  | 'ai_speaker_minutes'
  | 'ai_ds_minutes'

export type FetchState = 'done' | 'running' | 'blocked' | 'none'
export type ArchiveState = 'done' | 'running' | 'failed' | 'off' | 'blocked'
export type AllowState = 'allow' | 'deny'

/**
 * 判定理由的来源。呈现样式由它决定：
 * rule 中性 · hand 琥珀 · fail 红 · expired/wait/na 是生命周期原因，
 * 优先级高于权限原因（详见 spec.md §6.1）。
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
  /** 被人工延长过几次 */
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

export interface Consumer {
  id: string
  name: string
  scope: string
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
