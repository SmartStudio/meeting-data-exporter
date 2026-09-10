import { expect, test } from 'bun:test'
import { AssetUrlMissingError, createCatalog } from '../../src/catalog/index'
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
      // 每次调用返回不同的数组顺序，模拟平台的真实行为
      listByRecordId: async () => [{
        record_file_id: 'f1',
        meeting_summary: call++ % 2 === 0 ? entries : [...entries].reverse(),
      }],
    } as never,
    smartApi: NO_SMART,
    now: () => 1_700_000_000,
  })

  const asset = {
    assetId: 'rec1:f1:meeting_summary:pdf',
    meetingId: 'm1',
    subMeetingId: '',
    assetType: 'meeting_summary' as const,
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
      listByRecordId: async () => [{
        record_file_id: 'f1',
        meeting_summary: [{ download_address: 'https://cos/a', file_type: 'txt' }, { download_address: 'https://cos/b', file_type: 'pdf' }],
      }],
    } as never,
    smartApi: NO_SMART,
    now: () => 1_700_000_000,
  })
  const res = await catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:meeting_summary:1', meetingId: 'm1', subMeetingId: '',
    assetType: 'meeting_summary' as const, recordFileId: 'f1', fileType: null,
    bytesExpected: null, allowDownload: true,
  })
  expect(res.url).toBe('https://cos/b')
})

test('listAssets：allow_download 时探测 smart 两类，探测结果决定是否列出', async () => {
  const calls: string[] = []
  const catalog = createCatalog({
    addressesApi: {
      listByRecordId: async () => [{ record_file_id: 'f1', download_address: 'https://cos/v.mp4', download_address_file_type: 'mp4', allow_download: true }],
    } as never,
    smartApi: {
      getMinutes: async (id) => { calls.push(`minutes:${id}`); return '# 纪要\n' },
      getChapters: async (id) => { calls.push(`chapters:${id}`); return null },
    },
    now: () => 1_700_000_000,
  })
  const assets = await catalog.listAssets({ meetingId: 'm1', subMeetingId: '', meetingRecordId: 'rec1' } as never)
  expect(calls).toEqual(['minutes:f1', 'chapters:f1'])
  expect(assets.map((a) => a.assetType).sort()).toEqual(['ai_minutes', 'video'])
})

/**
 * 转写记录（record_type 3）：平台在 /v1/addresses 里照样给 download_address 的 mp4，
 * 但对象存储对它一律 404 NoSuchKey（2026-09-10 实测 105 条无一例外），audio 从未出现。
 * 目录层把这两个字段抹掉，只留逐字稿与智能产物。
 */
test('listAssets：转写记录丢掉 video / audio，只列逐字稿与智能产物', async () => {
  const file = {
    record_file_id: 'f1',
    download_address: 'https://cos/v.mp4', download_address_file_type: 'mp4',
    audio_address: 'https://cos/a.m4a', audio_address_file_type: 'm4a',
    meeting_summary: [{ download_address: 'https://cos/t.txt', file_type: 'txt' }],
    allow_download: true,
  }
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [file] } as never,
    smartApi: { getMinutes: async () => '# 纪要', getChapters: async () => null },
    now: () => 1_700_000_000,
  })
  const zx = await catalog.listAssets({ meetingId: 'm1', subMeetingId: 'r1', meetingRecordId: 'r1', recordType: 3 } as never)
  expect(zx.map((a) => a.assetType).sort()).toEqual(['ai_minutes', 'meeting_summary'])
  // 对照：普通云录制同一份响应照常列出 video / audio
  const plain = await catalog.listAssets({ meetingId: 'm1', subMeetingId: 'r2', meetingRecordId: 'r2', recordType: 0 } as never)
  expect(plain.map((a) => a.assetType).sort()).toEqual(['ai_minutes', 'audio', 'meeting_summary', 'video'])
})

test('listAssets：allow_download=false 时不探测 smart', async () => {
  let called = 0
  const catalog = createCatalog({
    addressesApi: {
      listByRecordId: async () => [{ record_file_id: 'f1', download_address: 'https://cos/v.mp4', allow_download: false }],
    } as never,
    smartApi: { getMinutes: async () => { called++; return 'x' }, getChapters: async () => { called++; return null } },
    now: () => 1_700_000_000,
  })
  const assets = await catalog.listAssets({ meetingId: 'm1', subMeetingId: '', meetingRecordId: 'rec1' } as never)
  expect(called).toBe(0)
  expect(assets.map((a) => a.assetType)).toEqual(['video'])
})

test('resolveDownloadUrl：纪要返回 data: URL，正文 base64 可还原', async () => {
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [] } as never,
    smartApi: { getMinutes: async () => '## 会议摘要\n\n正文\n', getChapters: async () => null },
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
    addressesApi: { listByRecordId: async () => [] } as never,
    smartApi: { getMinutes: async () => null, getChapters: async () => [{ chapterId: 'C1', name: '开场', startMs: 7837 }] },
    now: () => 1_700_000_000,
  })
  const { url } = await catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:chapters:json', meetingId: 'm1', subMeetingId: '', assetType: 'chapters',
    recordFileId: 'f1', fileType: 'json', bytesExpected: null, allowDownload: true,
  })
  expect(url.startsWith('data:application/json;charset=utf-8;base64,')).toBe(true)
  expect(JSON.parse(await (await fetch(url)).text())).toEqual({ schemaVersion: 1, recordFileId: 'f1', chapters: [{ chapterId: 'C1', name: '开场', startMs: 7837 }] })
})

test('resolveDownloadUrl：smart 说没有时抛 AssetUrlMissingError', async () => {
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [] } as never,
    smartApi: { getMinutes: async () => null, getChapters: async () => null },
    now: () => 1_700_000_000,
  })
  await expect(catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:ai_minutes:md', meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes',
    recordFileId: 'f1', fileType: 'md', bytesExpected: null, allowDownload: true,
  })).rejects.toBeInstanceOf(AssetUrlMissingError)
})
