import { expect, test } from 'bun:test'
import {
  DEFAULT_ASSET_KEYS, ALL_ASSET_KEYS, ASSET_KEY_TO_FIELD, FIELD_TO_ASSET_KEY,
  parseAssetKeys, UnknownAssetKeyError, assetKeyToFilename,
} from '../../src/domain/types'

test('默认集为四类', () => {
  expect(DEFAULT_ASSET_KEYS).toEqual(['video', 'audio', 'transcript', 'ai_transcript'])
})
test('键↔字段双向映射一致', () => {
  for (const k of ALL_ASSET_KEYS) expect(FIELD_TO_ASSET_KEY[ASSET_KEY_TO_FIELD[k]]).toBe(k)
  expect(ASSET_KEY_TO_FIELD.video).toBe('download_address')
})
test('parseAssetKeys：逗号分隔 + all + 未知键报错', () => {
  expect(parseAssetKeys('video,transcript')).toEqual(['video', 'transcript'])
  expect(parseAssetKeys('all')).toEqual(ALL_ASSET_KEYS)
  expect(() => parseAssetKeys('video,bogus')).toThrow(UnknownAssetKeyError)
})
test('parseAssetKeys：原型链成员名不被误判为合法键', () => {
  expect(() => parseAssetKeys('constructor')).toThrow(UnknownAssetKeyError)
  expect(() => parseAssetKeys('__proto__')).toThrow(UnknownAssetKeyError)
  expect(() => parseAssetKeys('video,toString')).toThrow(UnknownAssetKeyError)
})
test('assetKeyToFilename：视频用 remoteId、扩展名由 file_type 决定', () => {
  expect(assetKeyToFilename('video', 'rf-1', 'mp4')).toBe('recording_rf-1.mp4')
  expect(assetKeyToFilename('transcript', 'rf-1', 'pdf')).toBe('transcript.pdf')
})
test('assetKeyToFilename：文本类多段加序号，单段与视频音频不变', () => {
  expect(assetKeyToFilename('transcript', 'rf1', 'pdf')).toBe('transcript.pdf')        // 单段保持干净
  expect(assetKeyToFilename('transcript', 'rf1', 'pdf', 1)).toBe('transcript.pdf')
  expect(assetKeyToFilename('transcript', 'rf2', 'pdf', 2)).toBe('transcript_2.pdf')   // 第二段消歧
  expect(assetKeyToFilename('ai_minutes', 'rf3', 'md', 3)).toBe('ai_minutes_3.md')
  expect(assetKeyToFilename('video', 'rf1', 'mp4', 2)).toBe('recording_rf1.mp4')       // 已含 remoteId，不加序号
})
