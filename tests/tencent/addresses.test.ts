import { expect, test } from 'bun:test'
import { createAddressesApi } from '../../src/tencent/addresses'
import {
  createCatalog,
  InvalidAssetIdError,
  type CatalogDeps,
} from '../../src/catalog/index'
import { StsTokenUnavailableError, type StsManager } from '../../src/sts/manager'
import type { QueryParams } from '../../src/tencent/url'
import type { RequestOptions, TencentClient } from '../../src/tencent/client'
import type { Meeting } from '../../src/domain/types'

const NOW = 1_800_000_000

interface Call {
  path: string
  query: QueryParams
  opts?: RequestOptions
}

/** 依据路径分派：/v1/addresses（批量）与 /v1/addresses/{id}（详情） */
function stubClient(handlers: {
  list?: (query: QueryParams) => unknown
  detail?: (recordFileId: string, opts: RequestOptions | undefined) => unknown
}): { client: TencentClient; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    client: {
      get: async <T,>(path: string, query: QueryParams, opts?: RequestOptions) => {
        calls.push({ path, query, opts })
        if (path === '/v1/addresses') {
          return (handlers.list?.(query) ?? {}) as T
        }
        const m = /^\/v1\/addresses\/(.+)$/.exec(path)
        if (m) {
          return (handlers.detail?.(m[1]!, opts) ?? {}) as T
        }
        throw new Error(`unexpected path: ${path}`)
      },
      post: async <T,>() => ({}) as T,
      currentQps: () => 5,
    },
  }
}

// ---------- AddressesApi ----------

test('listByRecordId 携带 operator_id / operator_id_type=1 / meeting_record_id', async () => {
  const { client, calls } = stubClient({ list: () => ({ total_page: 1, record_files: [] }) })
  const api = createAddressesApi(client, 'admin-uid')
  await api.listByRecordId('rec-1')
  expect(calls[0]!.query.operator_id).toBe('admin-uid')
  expect(calls[0]!.query.operator_id_type).toBe(1)
  expect(calls[0]!.query.meeting_record_id).toBe('rec-1')
})

test('listByRecordId 的 page_size 不超过 50', async () => {
  const { client, calls } = stubClient({ list: () => ({ total_page: 1, record_files: [] }) })
  const api = createAddressesApi(client, 'admin')
  await api.listByRecordId('rec-1')
  expect(Number(calls[0]!.query.page_size)).toBeLessThanOrEqual(50)
})

test('listByRecordId 多页时自动翻页并聚合 record_files', async () => {
  let call = 0
  const { client, calls } = stubClient({
    list: () => {
      call++
      return call === 1
        ? { total_page: 2, record_files: [{ record_file_id: 'f1' }] }
        : { total_page: 2, record_files: [{ record_file_id: 'f2' }] }
    },
  })
  const api = createAddressesApi(client, 'admin')
  const files = await api.listByRecordId('rec-1')
  expect(calls).toHaveLength(2)
  expect(files.map((f) => f.record_file_id)).toEqual(['f1', 'f2'])
})

test('detailByFileId 请求路径含 record_file_id 且携带 stsToken', async () => {
  const { client, calls } = stubClient({
    detail: (id) => ({ record_file_id: id }),
  })
  const api = createAddressesApi(client, 'admin')
  await api.detailByFileId('f9', 'sts-tok-x')
  expect(calls[0]!.path).toBe('/v1/addresses/f9')
  expect(calls[0]!.opts?.stsToken).toBe('sts-tok-x')
  expect(calls[0]!.query.operator_id).toBe('admin')
  expect(calls[0]!.query.operator_id_type).toBe(1)
})

// ---------- Catalog：orchestration across both endpoints ----------

const meeting: Meeting = {
  meetingId: 'm1',
  subMeetingId: '',
  meetingRecordId: 'rec-1',
  meetingCode: '88123456',
  subject: '评审',
  hostUserId: 'tm-alice',
  startTime: 0,
  endTime: 0,
  state: 'completed',
}

const listResponse = {
  total_page: 1,
  record_files: [
    {
      record_file_id: 'f1',
      download_address: 'https://cos/video.mp4',
      download_address_file_type: 'mp4',
      audio_address: 'https://cos/audio.m4a',
      audio_address_file_type: 'm4a',
      meeting_summary: [{ download_address: 'https://cos/s.txt', file_type: 'txt' }],
      allow_download: true,
    },
  ],
}

const detailResponse = {
  record_file_id: 'f1',
  ai_meeting_transcripts: [{ download_address: 'https://cos/t.txt', file_type: 'txt' }],
  ai_minutes: [{ download_address: 'https://cos/m.txt', file_type: 'txt' }],
  ai_topic_minutes: [{ download_address: 'https://cos/tm.htm', file_type: 'htm' }],
  ai_speaker_minutes: [{ download_address: 'https://cos/sm.htm', file_type: 'htm' }],
  ai_ds_minutes: [{ download_address: 'https://cos/ds.htm', file_type: 'htm' }],
}

function stsAvailable(token = 'sts-tok'): StsManager {
  return {
    async ensureFresh() {},
    async pruneStale() { return 0 },
    async getToken() { return token },
    async handleWebhook() {},
  }
}

function stsUnavailable(): StsManager {
  return {
    async ensureFresh() {},
    async pruneStale() { return 0 },
    async getToken(): Promise<string> { throw new StsTokenUnavailableError() },
    async handleWebhook() {},
  }
}

function buildCatalogDeps(sts: StsManager): CatalogDeps {
  const { client } = stubClient({
    list: () => listResponse,
    detail: () => detailResponse,
  })
  return {
    addressesApi: createAddressesApi(client, 'admin'),
    stsManager: sts,
    now: () => NOW,
  }
}

test('STS-Token 可用时 listAssets 合并两接口，返回全部八类', async () => {
  const catalog = createCatalog(buildCatalogDeps(stsAvailable()))
  const assets = await catalog.listAssets(meeting)
  expect(assets.map((a) => a.assetType).sort()).toEqual([
    'ai_ds_minutes', 'ai_meeting_transcripts', 'ai_minutes', 'ai_speaker_minutes',
    'ai_topic_minutes', 'audio', 'meeting_summary', 'video',
  ])
})

test('STS-Token 缺失时 ai_* 降级为不可得，但 video/audio/逐字稿仍可用，且不抛错', async () => {
  const catalog = createCatalog(buildCatalogDeps(stsUnavailable()))
  const assets = await catalog.listAssets(meeting)
  const types = assets.map((a) => a.assetType)
  expect(types).toContain('video')
  expect(types).toContain('audio')
  expect(types).toContain('meeting_summary')
  expect(types.some((t) => t.startsWith('ai_'))).toBe(false)
})

test('resolveDownloadUrl：video 走批量接口，expiresAt = now + 6*3600', async () => {
  const catalog = createCatalog(buildCatalogDeps(stsAvailable()))
  const assets = await catalog.listAssets(meeting)
  const video = assets.find((a) => a.assetType === 'video')!
  const { url, expiresAt } = await catalog.resolveDownloadUrl(video)
  expect(url).toBe('https://cos/video.mp4')
  expect(expiresAt).toBe(NOW + 6 * 3600)
})

test('resolveDownloadUrl：ai_minutes 走详情接口，expiresAt = now + 300', async () => {
  const catalog = createCatalog(buildCatalogDeps(stsAvailable()))
  const assets = await catalog.listAssets(meeting)
  const aiMinutes = assets.find((a) => a.assetType === 'ai_minutes')!
  const { url, expiresAt } = await catalog.resolveDownloadUrl(aiMinutes)
  expect(url).toBe('https://cos/m.txt')
  expect(expiresAt).toBe(NOW + 300)
})

test('两个接口的 expiresAt 相差 6*3600 - 300 秒', async () => {
  const catalog = createCatalog(buildCatalogDeps(stsAvailable()))
  const assets = await catalog.listAssets(meeting)
  const video = assets.find((a) => a.assetType === 'video')!
  const aiMinutes = assets.find((a) => a.assetType === 'ai_minutes')!
  const videoResult = await catalog.resolveDownloadUrl(video)
  const aiResult = await catalog.resolveDownloadUrl(aiMinutes)
  expect(videoResult.expiresAt - aiResult.expiresAt).toBe(6 * 3600 - 300)
})

test('resolveDownloadUrl：assetId 自包含 meetingRecordId，无需先调用 listAssets 即可解析（多实例安全）', async () => {
  // 新建一个从未调用过 listAssets 的 catalog 实例，模拟请求被负载均衡到另一台实例，
  // 直接用一个手工构造的 assetId（往返验证：meetingRecordId 能从中正确解析回来）
  // 调用 resolveDownloadUrl，验证其不依赖任何跨请求缓存也能成功。
  const catalog = createCatalog(buildCatalogDeps(stsAvailable()))
  const video = {
    assetId: 'rec-1:f1:video:0',
    meetingId: 'm1',
    subMeetingId: '',
    assetType: 'video' as const,
    recordFileId: 'f1',
    fileType: 'mp4',
    bytesExpected: null,
    allowDownload: true,
  }
  const { url, expiresAt } = await catalog.resolveDownloadUrl(video)
  expect(url).toBe('https://cos/video.mp4')
  expect(expiresAt).toBe(NOW + 6 * 3600)
})

test('resolveDownloadUrl：assetId 段数不足（非法格式）时抛出明确错误', async () => {
  const catalog = createCatalog(buildCatalogDeps(stsAvailable()))
  const malformed = {
    assetId: 'f1:video',
    meetingId: 'm1',
    subMeetingId: '',
    assetType: 'video' as const,
    recordFileId: 'f1',
    fileType: 'mp4',
    bytesExpected: null,
    allowDownload: true,
  }
  await expect(catalog.resolveDownloadUrl(malformed)).rejects.toThrow(InvalidAssetIdError)
})

test('resolveDownloadUrl：ai_* 资产在 STS 不可用时抛出 StsTokenUnavailableError', async () => {
  const catalog = createCatalog(buildCatalogDeps(stsAvailable()))
  const assets = await catalog.listAssets(meeting)
  const aiMinutes = assets.find((a) => a.assetType === 'ai_minutes')!

  const degraded = createCatalog(buildCatalogDeps(stsUnavailable()))
  await expect(degraded.resolveDownloadUrl(aiMinutes)).rejects.toThrow(StsTokenUnavailableError)
})
