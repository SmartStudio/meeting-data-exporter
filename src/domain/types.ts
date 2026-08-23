/** 八类资产，取值来自腾讯会议 API 响应字段名 */
export const ASSET_TYPES = [
  'video',
  'audio',
  'meeting_summary',
  'ai_meeting_transcripts',
  'ai_minutes',
  'ai_topic_minutes',
  'ai_speaker_minutes',
  'ai_ds_minutes',
] as const

export type AssetType = (typeof ASSET_TYPES)[number]

/** 平台 state：1 录制中 / 2 转码中 / 3 转码完成 */
export type RecordState = 'recording' | 'transcoding' | 'completed'

export interface Meeting {
  meetingId: string
  subMeetingId: string
  meetingRecordId: string
  meetingCode: string
  subject: string
  hostUserId: string
  /** unix 秒 UTC */
  startTime: number
  /**
   * unix 秒 UTC——取自 `record_files[].record_end_time` 的最大值
   * （见 tencent/records.ts 的 meetingEndTime）。`record_files` 全部缺该字段时
   * 回落到 `media_start_time`，此时 endTime === startTime、时长算出来是 0。
   *
   * 策略引擎（policy/expr.ts）目前仍未开放 end_time 作为可查询字段——
   * 那是历史决定（当时 endTime 确实是 startTime 的镜像），条件是
   * **M3.5 联调用真实响应确认 record_end_time 存在**，确认后即可开放。
   * 在此之前不要开放：回落路径下「按时长管控」会静默变成恒不匹配。
   */
  endTime: number
  state: RecordState
}

export interface Asset {
  /**
   * 网关生成的稳定 ID：<meetingRecordId>:<recordFileId>:<assetType>:<index>
   *
   * meetingRecordId 编在首段是为了让 assetId 自包含——解析下载地址需要它，
   * 而网关是多实例部署，任何跨请求的进程内缓存都不可靠。
   * 后三段保证六类文本资产（同属一个 record_file，且每类还是数组）互不覆盖。
   */
  assetId: string
  meetingId: string
  subMeetingId: string
  assetType: AssetType
  recordFileId: string
  fileType: string | null
  bytesExpected: number | null
  allowDownload: boolean
}

export type MeetingSelector =
  | { kind: 'range'; from: number; to: number }
  | { kind: 'code'; meetingCode: string; from?: number; to?: number }
  | { kind: 'id'; meetingId: string; from?: number; to?: number }

export interface ActorIdentity {
  kind: 'wecom_user' | 'service_account'
  /** 企微 userid；服务账号为 null */
  wecomUserId: string | null
  /** 腾讯会议 userid，策略判定的依据 */
  tmUserId: string
}
