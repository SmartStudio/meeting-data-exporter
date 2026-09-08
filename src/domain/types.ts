/** 六类资产。前四类取值来自腾讯 /v1/addresses 响应字段名；后两类是网关自己的名字，
 *  来自 /v1/smart/minutes 与 /v1/smart/chapters（src/tencent/smart.ts） */
export const ASSET_TYPES = [
  'video',
  'audio',
  'meeting_summary',
  'ai_meeting_transcripts',
  'ai_minutes',
  'chapters',
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
  /**
   * 主持人（会议创建者）的企业成员 id。
   *
   * **空串表示平台没有给主持人**：设备账号发起的快速会议就是这样（`/v1/corp/records`
   * 的 `userid` 为 `""`，见 tencent/records.ts）。它是一场真实的、要照常拉取归档的会议，
   * 只是规则里的「主持人」条件对它永远不成立。不要用 null：拉取、归档两处把 null
   * 当「元数据没取到」处理（`missingFacts`），而这里的事实是「取到了，就是没有」。
   */
  hostUserId: string
  /** unix 秒 UTC */
  startTime: number
  /**
   * unix 秒 UTC——取自 `record_files[].record_end_time` 的最大值
   * （见 tencent/records.ts 的 meetingEndTime）。`record_files` 全部缺该字段时
   * 回落到 `media_start_time`，此时 endTime === startTime、时长算出来是 0。
   *
   * 规则引擎的 `dur` / `age` 两个字段就是按它算的（`policy/conds.ts`）。
   * **回落路径必须显式识别出来**：`endTime <= startTime` 一律判成「这场会议没有
   * 结束时间数据」，两个 op 都不匹配。照直算成「时长 0 分钟」的话，
   * `dur lt 30` 会把所有缺 record_end_time 的会议静默命中——这正是
   * 旧 `policy/expr.ts` 当年**故意拒绝 end_time 字段**要防的那件事
   * （`d191f5b` 之后有了真实数据源，字段开放了，教训搬进了 conds.ts）。
   */
  endTime: number
  state: RecordState
}

export interface Asset {
  /**
   * 网关生成的稳定 ID：<meetingRecordId>:<recordFileId>:<assetType>:<selector>
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
  /**
   * 腾讯会议 userid。**这不再是策略判定的依据**——阶段 3 之后，采集权限规则
   * （allow 栈）的主体是采集程序（见下面的 `programId`），不是人。这里保留它
   * 是因为审计留痕按它归集，且调用腾讯 API 时要带操作者身份。
   */
  tmUserId: string
  /**
   * 采集程序 id，对应 `service_accounts.id`——**采集权限栈（allow 栈）的主体**
   * （计划 §2.2 · `policy/stacks.ts` 的 `checkSubject`）。
   *
   * 企微用户走设备授权流程登录的是**人**，没有采集程序身份，恒为 `null`；
   * 这类身份走到 allow 栈时被显式拒绝（`policy/access.ts`），不是「恰好匹配不上」。
   */
  programId: string | null
}
