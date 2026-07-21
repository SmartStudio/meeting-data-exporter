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
   * unix 秒 UTC——当前恒等于 startTime，不是真实的会议结束时间。
   *
   * 平台 /v1/records 只返回 media_start_time，没有结束时间字段（见
   * tencent/records.ts）；真实 endTime 需要从 record_files 聚合，是另一个
   * 需求，本次未做。策略引擎（policy/expr.ts）因此故意不开放 end_time 作为
   * 可查询字段，避免管理员以为按结束时间管控、实际却在按开始时间比对。
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
