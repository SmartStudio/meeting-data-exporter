import type { AssetSource, DownloadUrl, Meeting as EngineMeeting, SourceAsset } from '@yaowu/mde-engine'
import { InvalidAssetIdError, type Catalog } from '../catalog'
import { parseAssetId } from '../domain/assetid'
import type { Asset, Meeting as GatewayMeeting } from '../domain/types'
import type { RecordsApi } from '../tencent/records'

export interface InProcSourceDeps {
  recordsApi: RecordsApi
  catalog: Catalog
  now: () => number
}

/**
 * AssetSource 的进程内实现——归档 worker 用，直接调 catalog 与 recordsApi，
 * 不经过 HTTP。
 *
 * ⚠️ 它**绕过 policy/engine.ts，这是对的，不是漏洞**。
 *
 *   ① 拉取      受「拉取规则」管        ← 本文件走这条
 *   ③ 采集权限  受「采集权限规则」管    ← 外部程序取数据时走，由策略引擎判
 *
 * spec §1.4 说「采集权限规则是数据离开企业边界的唯一闸门」。worker 把数据从腾讯
 * 拉进**企业内部**的归档区，没有跨企业边界，所以不该过那道闸门。
 * **闸门在出口，不在入口。** 不要把 policyEngine.decide 加回来。
 */
export function createInProcSource(deps: InProcSourceDeps): AssetSource {
  /** 网关 Meeting → 引擎 Meeting：丢掉 meetingRecordId 与 state，引擎两者都不用 */
  function toEngineMeeting(m: GatewayMeeting): EngineMeeting {
    return {
      meetingId: m.meetingId,
      subMeetingId: m.subMeetingId,
      meetingCode: m.meetingCode,
      subject: m.subject,
      hostUserId: m.hostUserId,
      startTime: m.startTime,
      endTime: m.endTime,
    }
  }

  /**
   * 网关 Asset → 引擎 SourceAsset。字段映射与 HTTP 的 wire 格式逐字一致
   * （见 src/http/handlers/meetings.ts 的 assetToJson）——两个宿主必须看到同一份
   * 数据，否则引擎在两边的行为会分叉。
   *
   * 注意 state 不设：wire 格式本来就没有这个字段，设了反而会让
   * judgeReadiness 在服务端走与 CLI 不同的分支。
   */
  function toSourceAsset(a: Asset): SourceAsset {
    return {
      assetId: a.assetId,
      assetType: a.assetType,
      remoteId: a.recordFileId,
      allowDownload: a.allowDownload,
      fileType: a.fileType,
      bytesExpected: a.bytesExpected,
    }
  }

  /**
   * 按 meetingId 反查网关 Meeting。catalog.listAssets 需要完整的 Meeting（含
   * meetingRecordId），而引擎只握着 meetingId——与 HTTP 网关的做法一致
   * （handlers/meetings.ts 也是重新 listMeetings 一次），不引入任何跨调用缓存。
   *
   * 同一个 meetingId 在时间窗内可能命中多条记录（周期性会议的多次实例复用同一
   * meeting_id）；这里全部返回，由 listAssets 逐条聚合资产，不像 HTTP 网关的
   * getMeeting/listAssets 那样只取时间最新的一条——worker 的职责是把数据完整
   * 归档，不是只展示"当前"这一场。
   */
  async function meetingsById(meetingId: string, from?: number, to?: number): Promise<GatewayMeeting[]> {
    return deps.recordsApi.listMeetings({ kind: 'id', meetingId, from, to }, deps.now())
  }

  return {
    async listMeetings(sel) {
      // recordsApi 内部已按时间窗分页拉完，进程内不存在游标概念
      const meetings = await deps.recordsApi.listMeetings(sel, deps.now())
      return { meetings: meetings.map(toEngineMeeting), nextCursor: null }
    },

    async listAssets(meetingId, from, to) {
      const out: SourceAsset[] = []
      for (const m of await meetingsById(meetingId, from, to)) {
        for (const a of await deps.catalog.listAssets(m)) out.push(toSourceAsset(a))
      }
      return out
    },

    /**
     * 不需要反查资产。`catalog.resolveDownloadUrl` 只读 asset 的三个字段
     * ——`assetType`、`recordFileId`、`assetId`——而这三个全都编码在 assetId 里
     * （`<meetingRecordId>:<recordFileId>:<assetType>:<selector>`）。
     *
     * 所以这里造一个**合成 Asset**，与 HTTP 网关的做法逐字一致
     * （src/http/handlers/meetings.ts 的 downloadUrl 也是这么造的，
     * fileType/bytesExpected 同样填 null）。两个宿主行为一致，且不必多打一趟
     * listAssets。
     */
    async getDownloadUrl(assetId): Promise<DownloadUrl> {
      const parsed = parseAssetId(assetId)
      if (parsed === null) throw new InvalidAssetIdError(assetId)
      const asset: Asset = {
        assetId,
        meetingId: '',
        subMeetingId: '', // resolveDownloadUrl 不读这两个
        assetType: parsed.assetType,
        recordFileId: parsed.recordFileId,
        fileType: null,
        bytesExpected: null,
        allowDownload: true,
      }
      const { url, expiresAt } = await deps.catalog.resolveDownloadUrl(asset)
      // fileType / bytesExpected 恒为 null——HTTP 网关的 download-url 响应体
      // 本来就只有 {url, expires_at}，客户端那两个字段一直是 null。保持一致。
      return { url, expiresAt, fileType: null, bytesExpected: null }
    },
  }
}
