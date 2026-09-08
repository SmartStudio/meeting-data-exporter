import { parseAssetId } from '../domain/assetid'
import type { Asset, AssetType, Meeting } from '../domain/types'
import type { StsManager } from '../sts/manager'
import { StsTokenUnavailableError } from '../sts/manager'
import type { AddressesApi, RawAddressFile } from '../tencent/addresses'
import { serializeChapters, type SmartApi } from '../tencent/smart'
import { extractAssets, type RawDetail, type RawFileEntry, type SmartPresence } from './assets'

/** /v1/addresses（批量）链接时效：6 小时 */
const BATCH_URL_TTL_SEC = 6 * 3600
/** /v1/addresses/{record_file_id}（详情）链接时效：5 分钟 */
const DETAIL_URL_TTL_SEC = 5 * 60
/**
 * 智能接口两类资产的 `data:` URL 时效。`data:` URL 里正文是内嵌的，没有真实时效；
 * 给一个与详情链接同量级的数，让引擎的续签逻辑有个明确的到期点。
 */
const SMART_URL_TTL_SEC = 5 * 60

/** 走 51180 详情接口（要 STS-Token）的资产类型：只剩优化版逐字稿 */
const STS_TYPES: ReadonlySet<AssetType> = new Set<AssetType>(['ai_meeting_transcripts'])

export interface CatalogDeps {
  addressesApi: AddressesApi
  smartApi: SmartApi
  stsManager: StsManager
  now: () => number
}

export interface Catalog {
  listAssets(meeting: Meeting): Promise<Asset[]>
  /**
   * 返回可直接下载的地址。多数类型是平台签发的 https 链接，
   * **纪要（ai_minutes）与时间轴（chapters）返回的是 `data:` URL**——正文由智能
   * 接口取回后内嵌在 URL 里（`data:text/markdown;…;base64,` /
   * `data:application/json;…;base64,`），引擎 downloader 与 CLI 对它做普通
   * `fetch` 即可（Bun 的 fetch 支持 `data:`）。
   *
   * `data:` 不支持 Range：downloader 断点续传时收到 200 会丢弃 `.part` 重下，
   * 正文只有几 KB，无害。
   */
  resolveDownloadUrl(asset: Asset): Promise<{ url: string; expiresAt: number }>
}

/**
 * assetId 不符合 <meetingRecordId>:<recordFileId>:<assetType>:<selector> 格式时抛出。
 *
 * 网关是多实例部署的服务端组件，`GET /meetings/{id}/assets` 与
 * `POST /assets/{assetId}/download-url` 是两次独立的 HTTP 请求，可能落到不同实例，
 * 因此 resolveDownloadUrl 不能依赖任何进程内缓存来反查 meeting_record_id，只能从
 * assetId 本身解析。解析失败说明 assetId 不是本网关签发的（或已损坏），必须显式报错，
 * 不能静默跳过。
 */
export class InvalidAssetIdError extends Error {
  constructor(readonly assetId: string) {
    super(
      `malformed assetId ${JSON.stringify(assetId)}: expected ` +
        '<meetingRecordId>:<recordFileId>:<assetType>:<selector>',
    )
    this.name = 'InvalidAssetIdError'
  }
}

/** 平台响应中未包含该资产对应的下载地址（数据不一致或资产已被清理） */
export class AssetUrlMissingError extends Error {
  constructor(readonly assetId: string) {
    super(`platform response did not include a download URL for asset ${assetId}`)
    this.name = 'AssetUrlMissingError'
  }
}

interface UrlSource {
  download_address?: string
  audio_address?: string
  meeting_summary?: RawFileEntry[]
  ai_meeting_transcripts?: RawFileEntry[]
}

/**
 * assetId 形如 `<meetingRecordId>:<recordFileId>:<assetType>:<selector>`，
 * 末段是数组型字段的定位键（见 catalog/assets.ts 的说明）。
 *
 * 定位优先按 **file_type 匹配**：腾讯返回的数组顺序每次调用都可能不同，用下标
 * 定位会在「列资产」与「签发下载地址」这两次独立请求之间错位——实测同一个
 * assetId 连续请求两次分别解析到 .txt 和 .docx。file_type 在同一数组内唯一，
 * 是唯一稳定的定位键。
 *
 * `idx<n>` 形式是条目本身缺 file_type 时的回退，仍按下标解析（不稳定，但那种
 * 条目本来也无从稳定定位）。纯数字末段是 M3.5 之前签发的历史 assetId，同样按
 * 下标解析以保持兼容——客户端里可能还存着它们。
 */
function pickUrl(source: UrlSource, asset: Asset): string | undefined {
  if (asset.assetType === 'video') return source.download_address
  if (asset.assetType === 'audio') return source.audio_address

  // 纪要与时间轴不走这里：它们的正文由智能接口取回、内嵌成 data: URL，
  // resolveDownloadUrl 在调用 pickUrl 之前就已返回。
  if (asset.assetType !== 'meeting_summary' && asset.assetType !== 'ai_meeting_transcripts') {
    return undefined
  }

  const entries = source[asset.assetType]
  if (!Array.isArray(entries)) return undefined

  const selector = asset.assetId.split(':').at(-1) ?? ''

  const byFileType = entries.find((e) => e.file_type !== undefined && e.file_type === selector)
  if (byFileType?.download_address !== undefined) return byFileType.download_address

  // 回退：`idx<n>` 或历史遗留的纯数字末段
  const idx = Number(selector.startsWith('idx') ? selector.slice(3) : selector)
  if (!Number.isInteger(idx) || idx < 0) return undefined
  return entries[idx]?.download_address
}

function dataUrl(mime: string, text: string): string {
  return `data:${mime};charset=utf-8;base64,${Buffer.from(text, 'utf8').toString('base64')}`
}

/** 每个 record_file 两次调用；allow_download=false 时平台对所有智能内容一律回空，不白打 */
async function probeSmart(api: SmartApi, recordFileId: string, allowDownload: boolean): Promise<SmartPresence> {
  if (!allowDownload) return { minutes: false, chapters: false }
  const minutes = (await api.getMinutes(recordFileId)) !== null
  const chapters = (await api.getChapters(recordFileId)) !== null
  return { minutes, chapters }
}

export function createCatalog(deps: CatalogDeps): Catalog {
  /** 一次 listAssets 调用内只判断一次 STS 可用性，避免每个 record_file 重复取一次 token */
  async function tryGetToken(now: number): Promise<string | null> {
    try {
      return await deps.stsManager.getToken(now)
    } catch (err) {
      if (err instanceof StsTokenUnavailableError) return null
      throw err
    }
  }

  function mergeDetail(file: RawAddressFile, aiDetail: RawDetail | null): RawDetail {
    return {
      record_file_id: file.record_file_id,
      download_address: file.download_address,
      download_address_file_type: file.download_address_file_type,
      audio_address: file.audio_address,
      audio_address_file_type: file.audio_address_file_type,
      meeting_summary: file.meeting_summary,
      ai_meeting_transcripts: aiDetail?.ai_meeting_transcripts,
    }
  }

  return {
    async listAssets(meeting) {
      const now = deps.now()
      const files = await deps.addressesApi.listByRecordId(meeting.meetingRecordId)
      const out: Asset[] = []

      // STS-Token 不可用时 token 为 null；merge 后 ai_meeting_transcripts 字段缺失，extractAssets 按
      // “字段缺失不产生该资产”的既有约定跳过它——video/audio/meeting_summary
      // 与智能接口两类都不受影响，也不会让 listAssets 整体失败。
      const token = await tryGetToken(now)

      for (const file of files) {
        const aiDetail =
          token !== null ? await deps.addressesApi.detailByFileId(file.record_file_id, token) : null
        const merged = mergeDetail(file, aiDetail)

        const allowDownload = file.allow_download ?? true
        const smart = await probeSmart(deps.smartApi, file.record_file_id, allowDownload)

        out.push(
          ...extractAssets(
            meeting.meetingId,
            meeting.subMeetingId,
            meeting.meetingRecordId,
            merged,
            allowDownload,
            smart,
          ),
        )
      }

      return out
    },

    async resolveDownloadUrl(asset) {
      const now = deps.now()

      // 智能接口两类：正文当场取回、内嵌成 data: URL，完全不碰 STS
      if (asset.assetType === 'ai_minutes') {
        const md = await deps.smartApi.getMinutes(asset.recordFileId)
        if (md === null) throw new AssetUrlMissingError(asset.assetId)
        return { url: dataUrl('text/markdown', md), expiresAt: now + SMART_URL_TTL_SEC }
      }
      if (asset.assetType === 'chapters') {
        const chapters = await deps.smartApi.getChapters(asset.recordFileId)
        if (chapters === null) throw new AssetUrlMissingError(asset.assetId)
        return {
          url: dataUrl('application/json', serializeChapters(asset.recordFileId, chapters)),
          expiresAt: now + SMART_URL_TTL_SEC,
        }
      }

      if (STS_TYPES.has(asset.assetType)) {
        // 优化版逐字稿只能来自详情接口，STS 不可用时让 StsTokenUnavailableError 原样抛出
        const token = await deps.stsManager.getToken(now)
        const detail = await deps.addressesApi.detailByFileId(asset.recordFileId, token)
        const url = pickUrl(detail, asset)
        if (url === undefined) throw new AssetUrlMissingError(asset.assetId)
        return { url, expiresAt: now + DETAIL_URL_TTL_SEC }
      }

      // 无状态解析：meetingRecordId 直接从 assetId 反解，不依赖任何跨请求缓存，
      // 因此本实例即便从未处理过该会议的 listAssets 也能正确解析下载地址。
      // parseAssetId 格式不合法时返回 null（不抛异常）——本函数在这里补上
      // InvalidAssetIdError 语义，与文档注释一致。
      const parsed = parseAssetId(asset.assetId)
      if (parsed === null) throw new InvalidAssetIdError(asset.assetId)
      const { meetingRecordId } = parsed

      const files = await deps.addressesApi.listByRecordId(meetingRecordId)
      const file = files.find((f) => f.record_file_id === asset.recordFileId)
      const url = file !== undefined ? pickUrl(file, asset) : undefined
      if (url === undefined) throw new AssetUrlMissingError(asset.assetId)
      return { url, expiresAt: now + BATCH_URL_TTL_SEC }
    },
  }
}
