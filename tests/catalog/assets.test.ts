import { expect, test } from 'bun:test'
import { extractAssets } from '../../src/catalog/assets'

const detail = {
  record_file_id: 'f1',
  download_address: 'https://cos/video.mp4',
  download_address_file_type: 'mp4',
  audio_address: 'https://cos/audio.m4a',
  audio_address_file_type: 'm4a',
  meeting_summary: [{ download_address: 'https://cos/s.txt', file_type: 'txt' }],
}

const NONE = { minutes: false, chapters: false }
const BOTH = { minutes: true, chapters: true }

test('提取五类资产：三类来自 addresses 详情，纪要与时间轴由 smart 探测结果决定', () => {
  const assets = extractAssets('m1', '', 'rec-1', detail, true, BOTH)
  expect(assets.map((a) => a.assetType).sort()).toEqual([
    'ai_minutes', 'audio', 'chapters', 'meeting_summary', 'video',
  ])
})

test('smart 探测为否时不产生纪要 / 时间轴', () => {
  const types = extractAssets('m1', '', 'rec-1', detail, true, NONE).map((a) => a.assetType)
  expect(types).not.toContain('ai_minutes')
  expect(types).not.toContain('chapters')
})

test('纪要与时间轴的 assetId 末段固定为 md / json，file_type 同值', () => {
  const assets = extractAssets('m1', '', 'rec-1', detail, true, BOTH)
  const minutes = assets.find((a) => a.assetType === 'ai_minutes')!
  const chapters = assets.find((a) => a.assetType === 'chapters')!
  expect(minutes.assetId).toBe('rec-1:f1:ai_minutes:md')
  expect(minutes.fileType).toBe('md')
  expect(minutes.bytesExpected).toBeNull()
  expect(chapters.assetId).toBe('rec-1:f1:chapters:json')
  expect(chapters.fileType).toBe('json')
})

test('assetId 唯一且含字段名与定位键（防同一 record_file 的多类文本被压成一行）', () => {
  const assets = extractAssets('m1', '', 'rec-1', detail, true, BOTH)
  const ids = assets.map((a) => a.assetId)
  expect(new Set(ids).size).toBe(ids.length)
  // 末段是 file_type 而非数组下标：平台返回的数组顺序每次调用都可能不同，
  // 用下标定位会在「列资产」与「签发下载地址」两次独立请求之间错位。
  expect(ids).toContain('rec-1:f1:meeting_summary:txt')
})

test('数组条目缺 file_type 时回退为 idx<n>，形式上可辨认', () => {
  const noType = { ...detail, meeting_summary: [{ download_address: 'a' }] }
  const ids = extractAssets('m1', '', 'rec-1', noType, true, NONE).map((a) => a.assetId)
  expect(ids).toContain('rec-1:f1:meeting_summary:idx0')
})

test('assetId 以 meetingRecordId 为前缀（自包含，支持无状态解析）', () => {
  const assets = extractAssets('m1', '', 'rec-1', detail, true, BOTH)
  expect(assets.every((a) => a.assetId.startsWith('rec-1:f1:'))).toBe(true)
})

test('同一字段的数组含多项时各自成为独立资产', () => {
  const multi = { ...detail, meeting_summary: [
    { download_address: 'a', file_type: 'txt' },
    { download_address: 'b', file_type: 'pdf' },
  ] }
  const assets = extractAssets('m1', '', 'rec-1', multi, true, NONE)
    .filter((a) => a.assetType === 'meeting_summary')
  expect(assets).toHaveLength(2)
  expect(assets[1]!.fileType).toBe('pdf')
})

test('fileType 来自平台，不写死扩展名', () => {
  const htm = { ...detail, meeting_summary: [{ download_address: 'https://cos/s.htm', file_type: 'htm' }] }
  const assets = extractAssets('m1', '', 'rec-1', htm, true, NONE)
  expect(assets.find((a) => a.assetType === 'meeting_summary')!.fileType).toBe('htm')
  expect(assets.find((a) => a.assetType === 'video')!.fileType).toBe('mp4')
})

test('字段缺失时不产生该资产（而非产生空资产）', () => {
  const partial = { record_file_id: 'f1', download_address: 'u', download_address_file_type: 'mp4' }
  const assets = extractAssets('m1', '', 'rec-1', partial, true, NONE)
  expect(assets).toHaveLength(1)
  expect(assets[0]!.assetType).toBe('video')
})

test('空数组字段不产生资产', () => {
  const empty = { ...detail, meeting_summary: [] }
  expect(
    extractAssets('m1', '', 'rec-1', empty, true, NONE).some((a) => a.assetType === 'meeting_summary'),
  ).toBe(false)
})
