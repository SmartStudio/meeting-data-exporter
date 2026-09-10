import { describe, expect, test } from 'bun:test'
import { createCatalog } from '../../src/catalog/index'
import type { Asset, Meeting } from '../../src/domain/types'
import type { SmartApi } from '../../src/tencent/smart'
import { createInProcSource } from '../../src/worker/source-inproc'

const GW_MEETING: Meeting = {
  meetingId: 'm1',
  subMeetingId: 's1',
  meetingRecordId: 's1',
  recordType: 0,
  meetingCode: '881-123-40',
  subject: '周会',
  hostUserId: 'u1',
  startTime: 1000,
  endTime: 5000,
  state: 'completed',
}
const GW_ASSET: Asset = {
  assetId: 'rec1:f1:video:0',
  meetingId: 'm1',
  subMeetingId: 's1',
  assetType: 'video',
  recordFileId: 'f1',
  fileType: 'mp4',
  bytesExpected: 12345,
  allowDownload: true,
}

function make(over: Partial<Parameters<typeof createInProcSource>[0]> = {}) {
  return createInProcSource({
    recordsApi: { listMeetings: async () => [GW_MEETING] },
    catalog: {
      listAssets: async () => [GW_ASSET],
      resolveDownloadUrl: async () => ({ url: 'https://x/f', expiresAt: 9999 }),
    },
    now: () => 1234,
    ...over,
  } as any)
}

describe('createInProcSource', () => {
  test('listMeetings 把网关 Meeting 映射成引擎 Meeting，丢掉 meetingRecordId/state', async () => {
    const src = make()
    const { meetings, nextCursor } = await src.listMeetings({ kind: 'range', from: 0, to: 9999 })
    expect(meetings).toEqual([
      {
        meetingId: 'm1',
        subMeetingId: 's1',
        meetingCode: '881-123-40',
        subject: '周会',
        recordType: 0,
        hostUserId: 'u1',
        startTime: 1000,
        endTime: 5000,
      },
    ])
    // recordsApi 内部已分页拉完，进程内没有游标
    expect(nextCursor).toBeNull()
  })

  test('listMeetings 透传 selector 给 recordsApi，并以 now() 为准', async () => {
    let seenSel: unknown = null
    let seenNow: unknown = null
    const src = make({
      recordsApi: {
        listMeetings: async (sel: unknown, now: unknown) => {
          seenSel = sel
          seenNow = now
          return [GW_MEETING]
        },
      },
      now: () => 4321,
    } as any)
    await src.listMeetings({ kind: 'code', meetingCode: '888' })
    expect(seenSel).toEqual({ kind: 'code', meetingCode: '888' })
    expect(seenNow).toBe(4321)
  })

  test('listAssets 把 recordFileId 映射成 remoteId', async () => {
    const src = make()
    const assets = await src.listAssets('m1', '', 0, 9999)
    expect(assets).toEqual([
      {
        assetId: 'rec1:f1:video:0',
        assetType: 'video',
        remoteId: 'f1',
        allowDownload: true,
        fileType: 'mp4',
        bytesExpected: 12345,
      },
    ])
  })

  test('listAssets 不产出 state 字段——网关的 wire 格式本来就没有它', async () => {
    const src = make()
    const [a] = await src.listAssets('m1', '')
    expect('state' in a!).toBe(false)
  })

  test('一个 meetingId 下多个 sub_meeting 的资产会被合并', async () => {
    const second = { ...GW_MEETING, subMeetingId: 's2', meetingRecordId: 's2' }
    const src = make({
      recordsApi: { listMeetings: async () => [GW_MEETING, second] },
      catalog: {
        listAssets: async (m: Meeting) => [
          { ...GW_ASSET, subMeetingId: m.subMeetingId, recordFileId: `f-${m.subMeetingId}` },
        ],
        resolveDownloadUrl: async () => ({ url: 'https://x/f', expiresAt: 9999 }),
      },
    } as any)
    const assets = await src.listAssets('m1', '')
    expect(assets.map((a) => a.remoteId)).toEqual(['f-s1', 'f-s2'])
  })

  test('listAssets 按场次收窄：只要 meetingRecordId 等于 subMeetingId 的那一条记录', async () => {
    const second = { ...GW_MEETING, subMeetingId: 'rec2', meetingRecordId: 'rec2' }
    const src = make({
      recordsApi: { listMeetings: async () => [GW_MEETING, second] },
      catalog: {
        listAssets: async (m: Meeting) => [
          { ...GW_ASSET, subMeetingId: m.subMeetingId, recordFileId: `f-${m.subMeetingId}` },
        ],
        resolveDownloadUrl: async () => ({ url: 'https://x/f', expiresAt: 9999 }),
      },
    } as any)

    const only = await src.listAssets('m1', 'rec2')
    expect(only.map((a) => a.remoteId)).toEqual(['f-rec2'])
  })

  test('listAssets 的 subMeetingId 为空串时保留全部记录（旧库与旧探测行的兼容口径）', async () => {
    const second = { ...GW_MEETING, subMeetingId: 'rec2', meetingRecordId: 'rec2' }
    const src = make({
      recordsApi: { listMeetings: async () => [GW_MEETING, second] },
      catalog: {
        listAssets: async (m: Meeting) => [
          { ...GW_ASSET, subMeetingId: m.subMeetingId, recordFileId: `f-${m.subMeetingId}` },
        ],
        resolveDownloadUrl: async () => ({ url: 'https://x/f', expiresAt: 9999 }),
      },
    } as any)

    expect((await src.listAssets('m1', '')).map((a) => a.remoteId)).toHaveLength(2)
  })

  test('getDownloadUrl 从 assetId 合成 Asset 的三个字段（assetId/recordFileId/assetType），不额外打 listAssets', async () => {
    let listCalls = 0
    let seen: Asset | null = null
    const src = make({
      catalog: {
        listAssets: async () => {
          listCalls++
          return [GW_ASSET]
        },
        resolveDownloadUrl: async (a: Asset) => {
          seen = a
          return { url: 'https://x/f', expiresAt: 9999 }
        },
      },
    } as any)
    const r = await src.getDownloadUrl('recX:fY:ai_minutes:2')
    expect(listCalls).toBe(0) // 没有多余的往返
    expect(seen!.assetId).toBe('recX:fY:ai_minutes:2')
    expect(seen!.recordFileId).toBe('fY')
    expect(seen!.assetType).toBe('ai_minutes')
    // 与 HTTP 网关的响应体一致：只有 url 与 expiresAt 是真的
    expect(r).toEqual({ url: 'https://x/f', expiresAt: 9999, fileType: null, bytesExpected: null })
  })

  test('assetId 格式非法时抛 InvalidAssetIdError', async () => {
    const src = make()
    await expect(src.getDownloadUrl('garbage')).rejects.toThrow('malformed assetId')
  })

  test('assetId 末段 selector 是非数字的 file_type 字符串时同样能正确解析（不当成数组下标）', async () => {
    let seen: Asset | null = null
    const src = make({
      catalog: {
        listAssets: async () => [GW_ASSET],
        resolveDownloadUrl: async (a: Asset) => {
          seen = a
          return { url: 'https://x/f', expiresAt: 9999 }
        },
      },
    } as any)
    await src.getDownloadUrl('rec1:f1:ai_minutes:docx')
    expect(seen!.recordFileId).toBe('f1')
    expect(seen!.assetType).toBe('ai_minutes')
  })
})

/**
 * 下面这组测试**不打桩 catalog**，直接用真实的 createCatalog——只有这样才能验证
 * 「assetId 解析 → 合成 Asset → 调 catalog」这条链路本身是否正确，而不是验证
 * 「打桩被调用了」这件事。
 *
 * 场景取自 catalog/index.ts 与 tests/catalog/index.test.ts 里同样描述过的真实
 * 故障：同一个 record_file 下 meeting_summary 这类文本资产是数组，腾讯返回的
 * 数组顺序每次调用都可能不同，assetId 末段必须按 file_type 定位，而不是数组
 * 下标——否则用户会拿到文件名与内容不符的下载结果（例如 transcript.pdf 里装
 * 着 docx）。
 */
describe('createInProcSource + 真实 catalog：多格式资产按 file_type 定位', () => {
  /** 智能接口默认「这一类不存在」——多格式定位那两条用例不该被它影响 */
  const NO_SMART: SmartApi = { getMinutes: async () => null, getChapters: async () => null }

  function buildRealSource() {
    const catalog = createCatalog({
      addressesApi: {
        listByRecordId: async () => [{
          record_file_id: 'f1',
          // 还是多格式数组的那一类：转写。纪要与时间轴走智能接口，不从这里来。
          meeting_summary: [
            { download_address: 'https://cos/m.docx', file_type: 'docx' },
            { download_address: 'https://cos/m.pdf', file_type: 'pdf' },
          ],
        }],
      } as any,
      smartApi: NO_SMART,
      now: () => 1_700_000_000,
    })
    return createInProcSource({
      recordsApi: { listMeetings: async () => [GW_MEETING] },
      catalog,
      now: () => 1_700_000_000,
    })
  }

  /**
   * `buildRealSource` 的变体：addressesApi 这次**真的返回一个文件**（f1，
   * allow_download），这样 listAssets 才会去探智能接口；smart 由用例给。
   */
  function makeWithSmart(smart: SmartApi) {
    const catalog = createCatalog({
      addressesApi: {
        listByRecordId: async () => [{ record_file_id: 'f1', allow_download: true }],
      } as any,
      smartApi: smart,
      now: () => 1_700_000_000,
    })
    return createInProcSource({
      recordsApi: { listMeetings: async () => [GW_MEETING] },
      catalog,
      now: () => 1_700_000_000,
    })
  }

  test('同一 recordFileId 下不同 file_type 的 assetId 解析到各自正确的下载地址', async () => {
    const src = buildRealSource()
    const docx = await src.getDownloadUrl('rec1:f1:meeting_summary:docx')
    const pdf = await src.getDownloadUrl('rec1:f1:meeting_summary:pdf')
    expect(docx.url).toBe('https://cos/m.docx')
    expect(pdf.url).toBe('https://cos/m.pdf')
  })

  test('纪要走 smart 接口：listAssets 列出 ai_minutes，getDownloadUrl 给 data: URL', async () => {
    const source = makeWithSmart({
      getMinutes: async () => '# 纪要\n',
      getChapters: async () => null,
    })
    const assets = await source.listAssets('m1', '')
    const minutes = assets.find((a) => a.assetType === 'ai_minutes')!
    expect(minutes.assetId.endsWith(':ai_minutes:md')).toBe(true)
    const link = await source.getDownloadUrl(minutes.assetId)
    expect(await (await fetch(link.url)).text()).toBe('# 纪要\n')
  })

  test('assetId 里 meetingRecordId 错误时，真实 catalog 找不到文件而抛错（不是静默返回错误文件）', async () => {
    const src = buildRealSource()
    // meetingRecordId 与 addressesApi 里实际能查到的记录不匹配——但因为
    // listByRecordId 返回空数组，file 匹配不到，应抛 AssetUrlMissingError
    await expect(src.getDownloadUrl('rec-nonexistent:f1:video:0')).rejects.toThrow()
  })
})
