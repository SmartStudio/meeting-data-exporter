import { expect, test } from 'bun:test'
import { AssetUrlMissingError, createCatalog } from '../../src/catalog/index'
import { StsTokenUnavailableError } from '../../src/sts/manager'
import type { SmartApi } from '../../src/tencent/smart'

const NO_SMART: SmartApi = { getMinutes: async () => null, getChapters: async () => null }

/**
 * assetId 必须在**平台数组顺序变化**时依然解析到同一个文件。
 *
 * M3.5 联调实测：同一个 assetId（末段是数组下标 0）连续两次请求 download-url，
 * 网关分别返回了 .txt 和 .docx 的地址——腾讯返回的数组顺序每次调用都可能不同，
 * 而「列资产」与「签发下载地址」是两次独立 HTTP 请求（多实例部署下还可能落到
 * 不同实例）。位置引用在顺序不稳定的数据源上跨请求必然失效。
 *
 * 后果极其隐蔽：用户拿到的 transcript.pdf 里装着 docx 的内容，文件名与内容不符，
 * 全程无一处报错。改用 file_type 作定位键后，顺序怎么变都不影响解析结果。
 */
test('平台数组顺序变化时，同一 assetId 仍解析到同一个文件', async () => {
  const entries = [
    { download_address: 'https://cos/x.txt', file_type: 'txt' },
    { download_address: 'https://cos/x.docx', file_type: 'docx' },
    { download_address: 'https://cos/x.pdf', file_type: 'pdf' },
  ]
  let call = 0
  const catalog = createCatalog({
    addressesApi: {
      listByRecordId: async () => [],
      // 每次调用返回不同的数组顺序，模拟平台的真实行为
      detailByFileId: async () => ({
        record_file_id: 'f1',
        ai_meeting_transcripts: call++ % 2 === 0 ? entries : [...entries].reverse(),
      }),
    } as never,
    smartApi: NO_SMART,
    stsManager: { getToken: async () => 'sts' } as never,
    now: () => 1_700_000_000,
  })

  const asset = {
    assetId: 'rec1:f1:ai_meeting_transcripts:pdf',
    meetingId: 'm1',
    subMeetingId: '',
    assetType: 'ai_meeting_transcripts' as const,
    recordFileId: 'f1',
    fileType: 'pdf',
    bytesExpected: null,
    allowDownload: true,
  }

  const first = await catalog.resolveDownloadUrl(asset)
  const second = await catalog.resolveDownloadUrl(asset)
  expect(first.url).toBe('https://cos/x.pdf')
  expect(second.url).toBe('https://cos/x.pdf')
})

test('历史 assetId（纯数字末段）仍按下标解析，保持兼容', async () => {
  const catalog = createCatalog({
    addressesApi: {
      listByRecordId: async () => [],
      detailByFileId: async () => ({
        record_file_id: 'f1',
        ai_meeting_transcripts: [{ download_address: 'https://cos/a', file_type: 'txt' }, { download_address: 'https://cos/b', file_type: 'pdf' }],
      }),
    } as never,
    smartApi: NO_SMART,
    stsManager: { getToken: async () => 'sts' } as never,
    now: () => 1_700_000_000,
  })
  const res = await catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:ai_meeting_transcripts:1', meetingId: 'm1', subMeetingId: '',
    assetType: 'ai_meeting_transcripts' as const, recordFileId: 'f1', fileType: null,
    bytesExpected: null, allowDownload: true,
  })
  expect(res.url).toBe('https://cos/b')
})

test('listAssets：allow_download 时探测 smart 两类，探测结果决定是否列出', async () => {
  const calls: string[] = []
  const catalog = createCatalog({
    addressesApi: {
      listByRecordId: async () => [{ record_file_id: 'f1', download_address: 'https://cos/v.mp4', download_address_file_type: 'mp4', allow_download: true }],
      detailByFileId: async () => ({ record_file_id: 'f1' }),
    } as never,
    smartApi: {
      getMinutes: async (id) => { calls.push(`minutes:${id}`); return '# 纪要\n' },
      getChapters: async (id) => { calls.push(`chapters:${id}`); return null },
    },
    stsManager: { getToken: async () => { throw new StsTokenUnavailableError() } } as never,
    now: () => 1_700_000_000,
  })
  const assets = await catalog.listAssets({ meetingId: 'm1', subMeetingId: '', meetingRecordId: 'rec1' } as never)
  expect(calls).toEqual(['minutes:f1', 'chapters:f1'])
  expect(assets.map((a) => a.assetType).sort()).toEqual(['ai_minutes', 'video'])
})

test('listAssets：allow_download=false 时不探测 smart', async () => {
  let called = 0
  const catalog = createCatalog({
    addressesApi: {
      listByRecordId: async () => [{ record_file_id: 'f1', download_address: 'https://cos/v.mp4', allow_download: false }],
      detailByFileId: async () => ({ record_file_id: 'f1' }),
    } as never,
    smartApi: { getMinutes: async () => { called++; return 'x' }, getChapters: async () => { called++; return null } },
    stsManager: { getToken: async () => { throw new StsTokenUnavailableError() } } as never,
    now: () => 1_700_000_000,
  })
  const assets = await catalog.listAssets({ meetingId: 'm1', subMeetingId: '', meetingRecordId: 'rec1' } as never)
  expect(called).toBe(0)
  expect(assets.map((a) => a.assetType)).toEqual(['video'])
})

test('resolveDownloadUrl：纪要返回 data: URL，正文 base64 可还原', async () => {
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [], detailByFileId: async () => ({ record_file_id: 'f1' }) } as never,
    smartApi: { getMinutes: async () => '## 会议摘要\n\n正文\n', getChapters: async () => null },
    stsManager: { getToken: async () => { throw new StsTokenUnavailableError() } } as never,
    now: () => 1_700_000_000,
  })
  const { url, expiresAt } = await catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:ai_minutes:md', meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes',
    recordFileId: 'f1', fileType: 'md', bytesExpected: null, allowDownload: true,
  })
  expect(url.startsWith('data:text/markdown;charset=utf-8;base64,')).toBe(true)
  expect(await (await fetch(url)).text()).toBe('## 会议摘要\n\n正文\n')
  expect(expiresAt).toBe(1_700_000_000 + 300)
})

test('resolveDownloadUrl：时间轴返回 chapters.json 的 data: URL', async () => {
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [], detailByFileId: async () => ({ record_file_id: 'f1' }) } as never,
    smartApi: { getMinutes: async () => null, getChapters: async () => [{ chapterId: 'C1', name: '开场', startMs: 7837 }] },
    stsManager: { getToken: async () => { throw new StsTokenUnavailableError() } } as never,
    now: () => 1_700_000_000,
  })
  const { url } = await catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:chapters:json', meetingId: 'm1', subMeetingId: '', assetType: 'chapters',
    recordFileId: 'f1', fileType: 'json', bytesExpected: null, allowDownload: true,
  })
  expect(url.startsWith('data:application/json;charset=utf-8;base64,')).toBe(true)
  expect(JSON.parse(await (await fetch(url)).text())).toEqual({ schemaVersion: 1, recordFileId: 'f1', chapters: [{ chapterId: 'C1', name: '开场', startMs: 7837 }] })
})

test('resolveDownloadUrl：smart 说没有时抛 AssetUrlMissingError，不碰 STS', async () => {
  let sts = 0
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [], detailByFileId: async () => ({ record_file_id: 'f1' }) } as never,
    smartApi: { getMinutes: async () => null, getChapters: async () => null },
    stsManager: { getToken: async () => { sts++; return 't' } } as never,
    now: () => 1_700_000_000,
  })
  await expect(catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:ai_minutes:md', meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes',
    recordFileId: 'f1', fileType: 'md', bytesExpected: null, allowDownload: true,
  })).rejects.toBeInstanceOf(AssetUrlMissingError)
  expect(sts).toBe(0)
})
