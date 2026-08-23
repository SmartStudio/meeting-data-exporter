import { describe, expect, test } from 'bun:test'
import { parseAssetId } from '../../src/domain/assetid'

describe('parseAssetId', () => {
  test('解析出四段字段', () => {
    expect(parseAssetId('rec1:f1:video:0')).toEqual({
      meetingRecordId: 'rec1',
      recordFileId: 'f1',
      assetType: 'video',
      selector: '0',
    })
  })

  test('末段是 file_type 字符串（不要求数字）——多格式资产的定位键', () => {
    expect(parseAssetId('rec1:f1:ai_minutes:docx')).toEqual({
      meetingRecordId: 'rec1',
      recordFileId: 'f1',
      assetType: 'ai_minutes',
      selector: 'docx',
    })
    expect(parseAssetId('rec1:f1:ai_minutes:pdf')).toEqual({
      meetingRecordId: 'rec1',
      recordFileId: 'f1',
      assetType: 'ai_minutes',
      selector: 'pdf',
    })
  })

  test('末段是 idx<n> 回退形式', () => {
    expect(parseAssetId('rec1:f1:meeting_summary:idx2')).toEqual({
      meetingRecordId: 'rec1',
      recordFileId: 'f1',
      assetType: 'meeting_summary',
      selector: 'idx2',
    })
  })

  test('段数不足时返回 null', () => {
    expect(parseAssetId('f1:video')).toBeNull()
    expect(parseAssetId('rec1:f1:video')).toBeNull()
    expect(parseAssetId('garbage')).toBeNull()
  })

  test('空段时返回 null', () => {
    expect(parseAssetId(':f1:video:0')).toBeNull()
    expect(parseAssetId('rec1::video:0')).toBeNull()
    expect(parseAssetId('rec1:f1::0')).toBeNull()
    expect(parseAssetId('rec1:f1:video:')).toBeNull()
  })

  test('未知 assetType 时返回 null', () => {
    expect(parseAssetId('rec1:f1:not_a_real_type:0')).toBeNull()
  })

  test('selector 含非法字符时返回 null', () => {
    expect(parseAssetId('rec1:f1:video:a/b')).toBeNull()
    expect(parseAssetId('rec1:f1:video:a b')).toBeNull()
  })

  test('多出的段落被忽略，仍按前四段解析', () => {
    expect(parseAssetId('rec1:f1:video:0:extra')).toEqual({
      meetingRecordId: 'rec1',
      recordFileId: 'f1',
      assetType: 'video',
      selector: '0',
    })
  })
})
