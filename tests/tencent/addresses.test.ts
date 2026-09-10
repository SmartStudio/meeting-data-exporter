import { expect, test } from 'bun:test'
import { createAddressesApi } from '../../src/tencent/addresses'
import {
  createCatalog,
  InvalidAssetIdError,
  type CatalogDeps,
} from '../../src/catalog/index'
import type { QueryParams } from '../../src/tencent/url'
import type { RequestOptions, TencentClient } from '../../src/tencent/client'
import type { Meeting } from '../../src/domain/types'
import type { SmartApi } from '../../src/tencent/smart'

const NOW = 1_800_000_000

/** 智能接口一律回「没有」：这些用例钉的是 /v1/addresses 这一个接口本身的编排 */
const NO_SMART: SmartApi = { getMinutes: async () => null, getChapters: async () => null }
/** 纪要与时间轴都探测到：用于验证 listAssets 合并两个接口的行为 */
const BOTH_SMART: SmartApi = {
  getMinutes: async () => '# 纪要\n',
  getChapters: async () => [{ chapterId: 'c1', name: '开场', startMs: 0 }],
}

interface Call {
  path: string
  query: QueryParams
  opts?: RequestOptions
}

/** 目录层不再有详情接口，这里只需要按 /v1/addresses（批量）分派 */
function stubClient(handlers: {
  list?: (query: QueryParams) => unknown
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

// ---------- Catalog：orchestration across addresses + smart ----------

const meeting: Meeting = {
  meetingId: 'm1',
  subMeetingId: '',
  meetingRecordId: 'rec-1',
  recordType: 0,
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

function buildCatalogDeps(smart: SmartApi = NO_SMART): CatalogDeps {
  const { client } = stubClient({ list: () => listResponse })
  return {
    addressesApi: createAddressesApi(client, 'admin'),
    smartApi: smart,
    now: () => NOW,
  }
}

test('listAssets 合并批量接口与智能接口，返回五类资产', async () => {
  const catalog = createCatalog(buildCatalogDeps(BOTH_SMART))
  const assets = await catalog.listAssets(meeting)
  expect(assets.map((a) => a.assetType).sort()).toEqual([
    'ai_minutes', 'audio', 'chapters', 'meeting_summary', 'video',
  ])
})

test('智能接口探测为否时 listAssets 只返回 addresses 侧的三类', async () => {
  const catalog = createCatalog(buildCatalogDeps(NO_SMART))
  const assets = await catalog.listAssets(meeting)
  expect(assets.map((a) => a.assetType).sort()).toEqual(['audio', 'meeting_summary', 'video'])
})

test('resolveDownloadUrl：video 走批量接口，expiresAt = now + 6*3600', async () => {
  const catalog = createCatalog(buildCatalogDeps())
  const assets = await catalog.listAssets(meeting)
  const video = assets.find((a) => a.assetType === 'video')!
  const { url, expiresAt } = await catalog.resolveDownloadUrl(video)
  expect(url).toBe('https://cos/video.mp4')
  expect(expiresAt).toBe(NOW + 6 * 3600)
})

test('resolveDownloadUrl：ai_minutes 走智能接口，expiresAt = now + 300', async () => {
  const catalog = createCatalog(buildCatalogDeps(BOTH_SMART))
  const assets = await catalog.listAssets(meeting)
  const minutes = assets.find((a) => a.assetType === 'ai_minutes')!
  const { url, expiresAt } = await catalog.resolveDownloadUrl(minutes)
  expect(url.startsWith('data:text/markdown;charset=utf-8;base64,')).toBe(true)
  expect(expiresAt).toBe(NOW + 300)
})

test('两个接口的 expiresAt 相差 6*3600 - 300 秒', async () => {
  const catalog = createCatalog(buildCatalogDeps(BOTH_SMART))
  const assets = await catalog.listAssets(meeting)
  const video = assets.find((a) => a.assetType === 'video')!
  const minutes = assets.find((a) => a.assetType === 'ai_minutes')!
  const videoResult = await catalog.resolveDownloadUrl(video)
  const minutesResult = await catalog.resolveDownloadUrl(minutes)
  expect(videoResult.expiresAt - minutesResult.expiresAt).toBe(6 * 3600 - 300)
})

test('resolveDownloadUrl：assetId 自包含 meetingRecordId，无需先调用 listAssets 即可解析（多实例安全）', async () => {
  // 新建一个从未调用过 listAssets 的 catalog 实例，模拟请求被负载均衡到另一台实例，
  // 直接用一个手工构造的 assetId（往返验证：meetingRecordId 能从中正确解析回来）
  // 调用 resolveDownloadUrl，验证其不依赖任何跨请求缓存也能成功。
  const catalog = createCatalog(buildCatalogDeps())
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
  const catalog = createCatalog(buildCatalogDeps())
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
