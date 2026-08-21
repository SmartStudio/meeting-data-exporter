import { expect, test } from 'bun:test'
import { createCatalog } from '../../src/catalog/index'

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
        ai_minutes: call++ % 2 === 0 ? entries : [...entries].reverse(),
      }),
    } as never,
    stsManager: { getToken: async () => 'sts' } as never,
    now: () => 1_700_000_000,
  })

  const asset = {
    assetId: 'rec1:f1:ai_minutes:pdf',
    meetingId: 'm1',
    subMeetingId: '',
    assetType: 'ai_minutes' as const,
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
        ai_minutes: [{ download_address: 'https://cos/a', file_type: 'txt' }, { download_address: 'https://cos/b', file_type: 'pdf' }],
      }),
    } as never,
    stsManager: { getToken: async () => 'sts' } as never,
    now: () => 1_700_000_000,
  })
  const res = await catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:ai_minutes:1', meetingId: 'm1', subMeetingId: '',
    assetType: 'ai_minutes' as const, recordFileId: 'f1', fileType: null,
    bytesExpected: null, allowDownload: true,
  })
  expect(res.url).toBe('https://cos/b')
})
