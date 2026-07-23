export type AssetKey =
  | 'video' | 'audio' | 'transcript' | 'ai_transcript'
  | 'ai_minutes' | 'ai_topic_minutes' | 'ai_speaker_minutes' | 'ai_ds_minutes'

export const ALL_ASSET_KEYS: AssetKey[] = [
  'video', 'audio', 'transcript', 'ai_transcript',
  'ai_minutes', 'ai_topic_minutes', 'ai_speaker_minutes', 'ai_ds_minutes',
]
export const DEFAULT_ASSET_KEYS: AssetKey[] = ['video', 'audio', 'transcript', 'ai_transcript']

export const ASSET_KEY_TO_FIELD: Record<AssetKey, string> = {
  video: 'download_address', audio: 'audio_address', transcript: 'meeting_summary',
  ai_transcript: 'ai_meeting_transcripts', ai_minutes: 'ai_minutes',
  ai_topic_minutes: 'ai_topic_minutes', ai_speaker_minutes: 'ai_speaker_minutes',
  ai_ds_minutes: 'ai_ds_minutes',
}
export const FIELD_TO_ASSET_KEY: Record<string, AssetKey> = Object.fromEntries(
  (Object.entries(ASSET_KEY_TO_FIELD) as [AssetKey, string][]).map(([k, f]) => [f, k]),
) as Record<string, AssetKey>

const H6 = 6 * 3600
const H48 = 48 * 3600
export const ASSET_WAIT_CAP_SEC: Record<AssetKey, number> = {
  video: H6, audio: H6, transcript: H6,
  ai_transcript: H48, ai_minutes: H48, ai_topic_minutes: H48,
  ai_speaker_minutes: H48, ai_ds_minutes: H48,
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
    if (!Object.hasOwn(ASSET_KEY_TO_FIELD, k)) throw new UnknownAssetKeyError(k)
    out.push(k as AssetKey)
  }
  return out
}

/** 文件名基（不含扩展名派生规则见 §11）：video/audio 用 remoteId，文本类固定名 */
const FILENAME_BASE: Record<AssetKey, (remoteId: string) => string> = {
  video: (r) => `recording_${r}`, audio: (r) => `recording_${r}`,
  transcript: () => 'transcript', ai_transcript: () => 'ai_transcript',
  ai_minutes: () => 'ai_minutes', ai_topic_minutes: () => 'ai_topic_minutes',
  ai_speaker_minutes: () => 'ai_speaker_minutes', ai_ds_minutes: () => 'ai_ds_minutes',
}
export function assetKeyToFilename(key: AssetKey, remoteId: string, ext: string): string {
  return `${FILENAME_BASE[key](remoteId)}.${ext}`
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
