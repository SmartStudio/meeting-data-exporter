import type { Asset, AssetType } from '../domain/types'

export interface RawFileEntry {
  download_address?: string
  file_type?: string
}

export interface RawDetail {
  record_file_id: string
  download_address?: string
  download_address_file_type?: string
  audio_address?: string
  audio_address_file_type?: string
  meeting_summary?: RawFileEntry[]
  ai_meeting_transcripts?: RawFileEntry[]
  ai_minutes?: RawFileEntry[]
  ai_topic_minutes?: RawFileEntry[]
  ai_speaker_minutes?: RawFileEntry[]
  ai_ds_minutes?: RawFileEntry[]
}

/** 数组型字段 → 资产类型。从字段名派生，新增纪要引擎时只需加一行 */
const ARRAY_FIELDS: Array<[keyof RawDetail, AssetType]> = [
  ['meeting_summary', 'meeting_summary'],
  ['ai_meeting_transcripts', 'ai_meeting_transcripts'],
  ['ai_minutes', 'ai_minutes'],
  ['ai_topic_minutes', 'ai_topic_minutes'],
  ['ai_speaker_minutes', 'ai_speaker_minutes'],
  ['ai_ds_minutes', 'ai_ds_minutes'],
]

/**
 * assetId 必须含字段名与索引：六类文本资产同属一个 record_file，
 * 若只用 record_file_id 作标识，它们会在下游的唯一约束下被压成一行。
 */
export function extractAssets(
  meetingId: string,
  subMeetingId: string,
  detail: RawDetail,
  allowDownload: boolean,
): Asset[] {
  const fileId = detail.record_file_id
  const out: Asset[] = []

  const push = (t: AssetType, idx: number, fileType: string | null, allowed: boolean): void => {
    out.push({
      assetId: `${fileId}:${t}:${idx}`,
      meetingId,
      subMeetingId,
      assetType: t,
      recordFileId: fileId,
      fileType,
      bytesExpected: null,
      allowDownload: allowed,
    })
  }

  if (detail.download_address) {
    push('video', 0, detail.download_address_file_type ?? null, true)
  }
  if (detail.audio_address) {
    push('audio', 0, detail.audio_address_file_type ?? null, true)
  }

  for (const [field, assetType] of ARRAY_FIELDS) {
    const entries = detail[field] as RawFileEntry[] | undefined
    if (!Array.isArray(entries)) continue
    entries.forEach((e, i) => {
      if (!e.download_address) return
      // ai_* 系列在 allow_download=false 时平台返回空，此处显式标记
      const allowed = assetType.startsWith('ai_') ? allowDownload : true
      push(assetType, i, e.file_type ?? null, allowed)
    })
  }

  return out
}
