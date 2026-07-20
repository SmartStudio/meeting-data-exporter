import { expect, test } from 'bun:test'
import { extractAssets } from '../../src/catalog/assets'

const detail = {
  record_file_id: 'f1',
  download_address: 'https://cos/video.mp4',
  download_address_file_type: 'mp4',
  audio_address: 'https://cos/audio.m4a',
  audio_address_file_type: 'm4a',
  meeting_summary: [{ download_address: 'https://cos/s.txt', file_type: 'txt' }],
  ai_meeting_transcripts: [{ download_address: 'https://cos/t.txt', file_type: 'txt' }],
  ai_minutes: [{ download_address: 'https://cos/m.txt', file_type: 'txt' }],
  ai_topic_minutes: [{ download_address: 'https://cos/tm.htm', file_type: 'htm' }],
  ai_speaker_minutes: [{ download_address: 'https://cos/sm.htm', file_type: 'htm' }],
  ai_ds_minutes: [{ download_address: 'https://cos/ds.htm', file_type: 'htm' }],
}

test('提取全部八类资产', () => {
  const assets = extractAssets('m1', '', detail, true)
  expect(assets.map((a) => a.assetType).sort()).toEqual([
    'ai_ds_minutes', 'ai_meeting_transcripts', 'ai_minutes', 'ai_speaker_minutes',
    'ai_topic_minutes', 'audio', 'meeting_summary', 'video',
  ])
})

test('assetId 唯一且含字段名与索引（防六类纪要被压成一行）', () => {
  const assets = extractAssets('m1', '', detail, true)
  const ids = assets.map((a) => a.assetId)
    expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toContain('f1:ai_minutes:0')
})

test('同一字段的数组含多项时各自成为独立资产', () => {
  const multi = { ...detail, ai_minutes: [
    { download_address: 'a', file_type: 'txt' },
    { download_address: 'b', file_type: 'pdf' },
  ] }
  const assets = extractAssets('m1', '', multi, true).filter((a) => a.assetType === 'ai_minutes')
  expect(assets).toHaveLength(2)
  expect(assets[1]!.fileType).toBe('pdf')
})

test('fileType 来自平台，不写死扩展名', () => {
  const assets = extractAssets('m1', '', detail, true)
  expect(assets.find((a) => a.assetType === 'ai_topic_minutes')!.fileType).toBe('htm')
  expect(assets.find((a) => a.assetType === 'video')!.fileType).toBe('mp4')
})

test('allowDownload=false 时 ai_* 资产被标记不可下载', () => {
  const assets = extractAssets('m1', '', detail, false)
  const ai = assets.filter((a) => a.assetType.startsWith('ai_'))
  expect(ai.every((a) => a.allowDownload === false)).toBe(true)
  expect(assets.find((a) => a.assetType === 'video')!.allowDownload).toBe(true)
})

test('字段缺失时不产生该资产（而非产生空资产）', () => {
  const partial = { record_file_id: 'f1', download_address: 'u', download_address_file_type: 'mp4' }
  const assets = extractAssets('m1', '', partial, true)
  expect(assets).toHaveLength(1)
  expect(assets[0]!.assetType).toBe('video')
})

test('空数组字段不产生资产', () => {
  const empty = { ...detail, ai_minutes: [] }
  expect(extractAssets('m1', '', empty, true).some((a) => a.assetType === 'ai_minutes')).toBe(false)
})
