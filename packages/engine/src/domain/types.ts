export type AssetKey =
  | 'video' | 'audio' | 'transcript' | 'ai_transcript'
  | 'ai_minutes' | 'chapters'

export const ALL_ASSET_KEYS: AssetKey[] = [
  'video', 'audio', 'transcript', 'ai_transcript', 'ai_minutes', 'chapters',
]
/** 纪要与时间轴不再依赖 STS（走 /v1/smart/*，见 src/tencent/smart.ts），默认全要 */
export const DEFAULT_ASSET_KEYS: AssetKey[] = [...ALL_ASSET_KEYS]

/**
 * 客户端资产键 → **网关 `asset_type` 字段的取值**。
 *
 * 名字里写「GATEWAY_TYPE」不是修饰，是契约。这里曾叫 `ASSET_KEY_TO_FIELD`、
 * 值取腾讯的**平台字段名**（`download_address` / `audio_address` …），因为
 * spec §17 当时推断网关会原样透出平台字段名。M3.5 联调对真实响应核实：网关
 * emit 的是它自己的领域词汇 `ASSET_TYPES`（src/domain/types.ts）——
 *
 *   平台字段            网关 asset_type
 *   download_address →  video
 *   audio_address    →  audio
 *   meeting_summary  →  meeting_summary   ← 恰好同名
 *   ai_*             →  ai_*              ← 恰好同名
 *   （智能接口）      →  chapters
 *
 * **只有 video / audio 两项不同**，而这种部分重合让故障伪装成了「视频资产没
 * 产出」：转写照常下载、视频音频永远匹配不上，最后按 deadline 静默放弃。
 * 名字误导了推断，所以连名字一起改。
 *
 * `ai_minutes` 与 `chapters` 来自腾讯智能接口（`src/tencent/smart.ts`），不
 * 经 STS 下载，落盘文件是网关生成的 `minutes.md` / `chapters.json`。
 *
 * 「字段驱动、不硬编码封闭联合」的原始意图仍然成立：网关将来新增纪要引擎时
 * 会 emit 新的 asset_type，`asset_type` 列照存不误。
 */
export const ASSET_KEY_TO_GATEWAY_TYPE: Record<AssetKey, string> = {
  video: 'video', audio: 'audio', transcript: 'meeting_summary',
  ai_transcript: 'ai_meeting_transcripts', ai_minutes: 'ai_minutes',
  chapters: 'chapters',
}
export const GATEWAY_TYPE_TO_ASSET_KEY: Record<string, AssetKey> = Object.fromEntries(
  (Object.entries(ASSET_KEY_TO_GATEWAY_TYPE) as [AssetKey, string][]).map(([k, t]) => [t, k]),
) as Record<string, AssetKey>

/**
 * 大文件资产：视频与音频。它们**不做整文件哈希**——`downloader` 对文本类小文件
 * 会把 `.part` 全量读进内存算 sha256，对一段 2GB 的录制这么做会直接吃爆内存。
 *
 * 判定入参是**网关的 asset_type**，不是客户端的 AssetKey：调用方拿到的是 DB 里
 * 存的原值。未知类型一律按二进制处理（不整读），是这里更安全的默认值。
 */
const BINARY_ASSET_KEYS: ReadonlySet<AssetKey> = new Set<AssetKey>(['video', 'audio'])

export function isTextAssetType(gatewayType: string): boolean {
  const key = GATEWAY_TYPE_TO_ASSET_KEY[gatewayType]
  return key !== undefined && !BINARY_ASSET_KEYS.has(key)
}

const H6 = 6 * 3600
const H48 = 48 * 3600
export const ASSET_WAIT_CAP_SEC: Record<AssetKey, number> = {
  video: H6, audio: H6, transcript: H6,
  ai_transcript: H48, ai_minutes: H48, chapters: H48,
}

export class UnknownAssetKeyError extends Error {
  constructor(readonly key: string) {
    super(`unknown asset key: ${key}. valid keys: ${ALL_ASSET_KEYS.join(',')} | all`)
    this.name = 'UnknownAssetKeyError'
  }
}
export function parseAssetKeys(csv: string): AssetKey[] {
  const trimmed = csv.trim()
  if (trimmed === 'all') return [...ALL_ASSET_KEYS]
  const out: AssetKey[] = []
  for (const raw of trimmed.split(',')) {
    const k = raw.trim()
    // Use Object.hasOwn instead of `in` to avoid prototype chain lookups (constructor, toString, etc.)
    if (!Object.hasOwn(ASSET_KEY_TO_GATEWAY_TYPE, k)) throw new UnknownAssetKeyError(k)
    out.push(k as AssetKey)
  }
  return out
}

/** 文件名基（不含扩展名派生规则见 §11）：video/audio 用 remoteId，文本类固定名 */
const FILENAME_BASE: Record<AssetKey, (remoteId: string) => string> = {
  video: (r) => `recording_${r}`, audio: (r) => `recording_${r}`,
  transcript: () => 'transcript', ai_transcript: () => 'ai_transcript',
  ai_minutes: () => 'minutes', chapters: () => 'chapters',
}
/** 文件名是否已含 remoteId：含则同类多段天然不碰撞，无需序号消歧 */
const FILENAME_HAS_REMOTE_ID: Record<AssetKey, boolean> = {
  video: true, audio: true,
  transcript: false, ai_transcript: false, ai_minutes: false, chapters: false,
}
/**
 * 资产文件名。`ordinal` 是该资产在同 (meeting, sub_meeting, asset_type) 兄弟中的
 * 1-based 序号：仅当文件名不含 remoteId（文本类）且 ordinal>1 时追加 `_<ordinal>` 消歧，
 * 保证单段场景文件名保持干净（transcript.pdf），多段场景不互相覆盖（transcript_2.pdf）。
 */
/**
 * 平台 file_type → 落盘扩展名的归一化。
 *
 * 只做**有明确依据**的修正，不做主观美化：
 * - `docs` → `docx`：腾讯对 AI 纪要给的是 `docs`（同一响应里转写给的却是 `docx`），
 *   而实测文件魔数是 `50 4B 03 04`（ZIP/OOXML），确系标准 docx。`.docs` 不是
 *   任何系统认识的扩展名，双击打不开。
 * - `htm` → `html`：同理，两者是同一格式的新旧写法。
 *
 * 空 file_type 回落 `bin`：DB 里该列是 NOT NULL DEFAULT ''（见 store/db.ts），
 * 未知格式存的是**空串而不是 null**，`?? 'bin'` 这类写法挡不住它，会生成
 * `transcript.` 这种带尾点的文件名。
 *
 * 已知的理论风险：若平台某天对同一资产同时给出 `docs` 与 `docx`，归一化后两者
 * 会争同一个文件名（唯一键按原始 file_type 分组，不会合并成一行）。届时内容
 * 本就相同，覆盖无实质损失；真出现再按 file_type 加后缀消歧。
 */
const EXTENSION_ALIASES: Record<string, string> = { docs: 'docx', htm: 'html' }

export function normalizeExtension(fileType: string | null | undefined): string {
  const raw = (fileType ?? '').trim().toLowerCase()
  if (raw === '') return 'bin'
  return EXTENSION_ALIASES[raw] ?? raw
}

export function assetKeyToFilename(key: AssetKey, remoteId: string, ext: string | null | undefined, ordinal = 1): string {
  const base = FILENAME_BASE[key](remoteId)
  const suffix = !FILENAME_HAS_REMOTE_ID[key] && ordinal > 1 ? `_${ordinal}` : ''
  return `${base}${suffix}.${normalizeExtension(ext)}`
}

export interface Meeting {
  meetingId: string
  subMeetingId: string
  meetingCode: string | null
  subject: string | null
  hostUserId: string | null
  startTime: number | null
  endTime: number | null
}

export type MeetingSelector =
  | { kind: 'range'; from: number; to: number }
  | { kind: 'code'; meetingCode: string; from?: number; to?: number }
  | { kind: 'id'; meetingId: string; from?: number; to?: number }

export type AssetStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'dead'
export type ProbeState = 'probing' | 'resolved' | 'abandoned'

/**
 * 会议目录 Map 的键：`meeting_id` + `\u0000` + `sub_meeting_id`。
 *
 * 分隔符与 `src/store/archives.ts` 的 `archiveStateKey`、`src/worker/archive.ts` 的
 * `overrideKey` 是同一个，理由也同一条：两段都是平台给的字符串，用可打印字符分隔会让
 * `("a:b", "")` 与 `("a", "b")` 撞成同一个键，而 `\u0000` 在任何一段里都不会出现。
 *
 * 它取代的是「只按 meeting_id 建 Map」——周期会议各场次共享 meeting_id、start_time
 * 各不相同，而 start_time 进目录名，于是所有场次的文件会落进某一场次的目录里
 * （2026-09-09 之前的行为，src/worker/store-mysql.ts 的注释承认过这个洞）。
 */
export function meetingPathKey(meetingId: string, subMeetingId: string): string {
  return `${meetingId}\u0000${subMeetingId}`
}
