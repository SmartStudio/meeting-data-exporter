import { parseAssetId } from '../domain/assetid'
import type { Asset, AssetType, Meeting } from '../domain/types'
import type { StsManager } from '../sts/manager'
import { StsTokenUnavailableError } from '../sts/manager'
import type { AddressesApi, RawAddressFile } from '../tencent/addresses'
import { extractAssets, type RawDetail, type RawFileEntry } from './assets'

/** /v1/addresses（批量）链接时效：6 小时 */
const BATCH_URL_TTL_SEC = 6 * 3600
/** /v1/addresses/{record_file_id}（详情）链接时效：5 分钟 */
const DETAIL_URL_TTL_SEC = 5 * 60

const AI_TYPES: ReadonlySet<AssetType> = new Set([
  'ai_meeting_transcripts',
  'ai_minutes',
  'ai_topic_minutes',
  'ai_speaker_minutes',
  'ai_ds_minutes',
])

export interface CatalogDeps {
  addressesApi: AddressesApi
  stsManager: StsManager
  now: () => number
}

export interface Catalog {
  listAssets(meeting: Meeting): Promise<Asset[]>
  resolveDownloadUrl(asset: Asset): Promise<{ url: string; expiresAt: number }>
}

/**
 * assetId 不符合 <meetingRecordId>:<recordFileId>:<assetType>:<index> 格式时抛出。
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
        '<meetingRecordId>:<recordFileId>:<assetType>:<index>',
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
  ai_minutes?: RawFileEntry[]
  ai_topic_minutes?: RawFileEntry[]
  ai_speaker_minutes?: RawFileEntry[]
  ai_ds_minutes?: RawFileEntry[]
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
      ai_minutes: aiDetail?.ai_minutes,
      ai_topic_minutes: aiDetail?.ai_topic_minutes,
      ai_speaker_minutes: aiDetail?.ai_speaker_minutes,
      ai_ds_minutes: aiDetail?.ai_ds_minutes,
    }
  }

  return {
    async listAssets(meeting) {
      const now = deps.now()
      const files = await deps.addressesApi.listByRecordId(meeting.meetingRecordId)
      const out: Asset[] = []

      // STS-Token 不可用时 token 为 null；merge 后 ai_* 字段缺失，extractAssets 按
      // “字段缺失不产生该资产”的既有约定跳过它们——video/audio/meeting_summary
      // 不受影响，也不会让 listAssets 整体失败。
      const token = await tryGetToken(now)

      for (const file of files) {
        const aiDetail =
          token !== null ? await deps.addressesApi.detailByFileId(file.record_file_id, token) : null
        const merged = mergeDetail(file, aiDetail)

        out.push(
          ...extractAssets(
            meeting.meetingId,
            meeting.subMeetingId,
            meeting.meetingRecordId,
            merged,
            file.allow_download ?? true,
          ),
        )
      }

      return out
    },

    async resolveDownloadUrl(asset) {
      const now = deps.now()

      if (AI_TYPES.has(asset.assetType)) {
        // AI 纪要只能来自详情接口，STS 不可用时让 StsTokenUnavailableError 原样抛出
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
