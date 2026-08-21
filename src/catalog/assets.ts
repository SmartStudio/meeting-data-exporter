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
 * assetId 格式：`<meetingRecordId>:<recordFileId>:<assetType>:<selector>`
 *
 * 前缀把 meetingRecordId 编进去，使 assetId **自包含**——resolveDownloadUrl 所需的
 * meeting_record_id 直接从 assetId 反解，不依赖任何跨请求/跨实例缓存。网关是多实例
 * 部署的服务端组件，`GET /meetings/{id}/assets` 与
 * `POST /assets/{assetId}/download-url` 是两次独立 HTTP 请求，随时可能落到不同实例。
 *
 * **末段 selector 用 file_type，不用数组下标**（M3.5 联调修正）。
 * 六类文本资产同属一个 record_file，必须有第四段才不会在下游唯一约束下被压成一行；
 * 原实现用数组下标，而腾讯返回的数组**顺序每次调用都可能不同**——实测同一个
 * assetId 连续请求两次，解析到的文件分别是 .txt 和 .docx。位置引用在顺序不稳定的
 * 数据源上跨请求必然失效，后果是用户拿到的 `transcript.pdf` 里装着 docx 内容，
 * 文件名与内容不符且完全静默。file_type 在同一数组内唯一，是稳定的定位键。
 *
 * 条目缺 file_type 时回退为 `idx<n>` 形式，仍可解析（见 catalog/index.ts 的
 * pickUrl），只是退回到不稳定的位置语义——聊胜于无，且形式上可辨认。
 */
export function extractAssets(
  meetingId: string,
  subMeetingId: string,
  meetingRecordId: string,
  detail: RawDetail,
  allowDownload: boolean,
): Asset[] {
  const fileId = detail.record_file_id
  const out: Asset[] = []

  const push = (t: AssetType, selector: string, fileType: string | null, allowed: boolean): void => {
    out.push({
      assetId: `${meetingRecordId}:${fileId}:${t}:${selector}`,
      meetingId,
      subMeetingId,
      assetType: t,
      recordFileId: fileId,
      fileType,
      bytesExpected: null,
      allowDownload: allowed,
    })
  }

  // video / audio 是单值字段，不存在数组定位问题；末段固定 '0' 保持格式一致
  if (detail.download_address) {
    push('video', '0', detail.download_address_file_type ?? null, true)
  }
  if (detail.audio_address) {
    push('audio', '0', detail.audio_address_file_type ?? null, true)
  }

  for (const [field, assetType] of ARRAY_FIELDS) {
    const entries = detail[field] as RawFileEntry[] | undefined
    if (!Array.isArray(entries)) continue
    entries.forEach((e, i) => {
      if (!e.download_address) return
      // ai_* 系列在 allow_download=false 时平台返回空，此处显式标记
      const allowed = assetType.startsWith('ai_') ? allowDownload : true
      push(assetType, e.file_type ?? `idx${i}`, e.file_type ?? null, allowed)
    })
  }

  return out
}
