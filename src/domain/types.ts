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
  endTime: number
  state: RecordState
}

export interface Asset {
  /** 网关生成的稳定 ID：<recordFileId>:<assetType>:<index> */
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
