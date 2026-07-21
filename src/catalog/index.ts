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
 * assetId 形如 <meetingRecordId>:<recordFileId>:<assetType>:<index>，末段恒为 index，
 * 仅数组型字段需要取出它。
 */
function pickUrl(source: UrlSource, asset: Asset): string | undefined {
  if (asset.assetType === 'video') return source.download_address
  if (asset.assetType === 'audio') return source.audio_address
  const idx = Number(asset.assetId.split(':').at(-1))
  return source[asset.assetType]?.[idx]?.download_address
}

/**
 * 从 assetId 反解出 meetingRecordId，供 resolveDownloadUrl 无状态地调用批量接口——
 * 不假设 assetId 正好四段（meetingRecordId / recordFileId 理论上不含冒号，但不依赖
 * 这个假设去做精确匹配）：只要求至少四段，取前两段分别作为 meetingRecordId 与
 * recordFileId，其余留给 assetType/index。段数不足即视为非法格式。
 */
function parseAssetId(assetId: string): { meetingRecordId: string; recordFileId: string } {
  const parts = assetId.split(':')
  const [meetingRecordId, recordFileId] = parts
  if (parts.length < 4 || !meetingRecordId || !recordFileId) {
    throw new InvalidAssetIdError(assetId)
  }
  return { meetingRecordId, recordFileId }
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
      const { meetingRecordId } = parseAssetId(asset.assetId)

      const files = await deps.addressesApi.listByRecordId(meetingRecordId)
      const file = files.find((f) => f.record_file_id === asset.recordFileId)
      const url = file !== undefined ? pickUrl(file, asset) : undefined
      if (url === undefined) throw new AssetUrlMissingError(asset.assetId)
      return { url, expiresAt: now + BATCH_URL_TTL_SEC }
    },
  }
}
