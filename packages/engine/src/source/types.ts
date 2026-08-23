import type { Meeting, MeetingSelector } from '../domain/types'

/** 一份可下载的资产。`remoteId` 是平台侧的 record_file_id。 */
export interface SourceAsset {
  assetId: string
  assetType: string
  remoteId: string
  /**
   * 平台转码状态。网关的 assets 响应**不包含此字段**（见
   * src/http/handlers/meetings.ts 的 toWire），所以两个宿主下它都恒为
   * undefined，judgeReadiness 会走「无状态信息」分支。保留字段是为了将来
   * 网关补上时不用改接口。
   */
  state?: number
  allowDownload?: boolean
  fileType?: string | null
  bytesExpected?: number | null
}

export interface DownloadUrl {
  url: string
  expiresAt: number
  fileType: string | null
  bytesExpected: number | null
}

/**
 * 引擎取数的唯一出口。两个实现：
 * - `client/src/gateway/client.ts`  —— HTTP，管理员机器上的 CLI 用
 * - `src/worker/source-inproc.ts`   —— 进程内直连 catalog + records，服务端用
 */
export interface AssetSource {
  listMeetings(sel: MeetingSelector, cursor?: string, limit?: number): Promise<{ meetings: Meeting[]; nextCursor: string | null }>
  listAssets(meetingId: string, from?: number, to?: number): Promise<SourceAsset[]>
  getDownloadUrl(assetId: string): Promise<DownloadUrl>
}
