import { expect, test } from 'bun:test'
import {
  DEFAULT_ASSET_KEYS, ALL_ASSET_KEYS, ASSET_KEY_TO_GATEWAY_TYPE, GATEWAY_TYPE_TO_ASSET_KEY, isTextAssetType,
  parseAssetKeys, UnknownAssetKeyError, assetKeyToFilename,
} from '../../src/domain/types'

test('默认集为四类', () => {
  expect(DEFAULT_ASSET_KEYS).toEqual(['video', 'audio', 'transcript', 'ai_transcript'])
})
test('键↔字段双向映射一致', () => {
  for (const k of ALL_ASSET_KEYS) expect(GATEWAY_TYPE_TO_ASSET_KEY[ASSET_KEY_TO_GATEWAY_TYPE[k]]).toBe(k)
  expect(ASSET_KEY_TO_GATEWAY_TYPE.video).toBe('video')
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

/**
 * 与**真网关词汇表**的硬绑定（M3.5 联调核实，2026-08-21）。
 *
 * 网关 `src/domain/types.ts` 的 ASSET_TYPES 是：
 *   video / audio / meeting_summary / ai_meeting_transcripts /
 *   ai_minutes / ai_topic_minutes / ai_speaker_minutes / ai_ds_minutes
 *
 * 客户端原先按 spec §17 的推断，把这里映射成腾讯的**平台字段名**
 * （download_address / audio_address …）。只有 video 与 audio 两项不同，
 * 而这种部分重合让故障伪装成「视频资产没产出」：转写照常下载、视频音频
 * 永远匹配不上，最后按 deadline 静默放弃，全程无一处报错。
 *
 * 这条用例把两侧词汇表逐字钉在一起——它不是自己和自己对账，改错任一侧都会红。
 */
test('映射值必须逐字等于网关 ASSET_TYPES 的取值', () => {
  const GATEWAY_ASSET_TYPES = [
    'video', 'audio', 'meeting_summary', 'ai_meeting_transcripts',
    'ai_minutes', 'ai_topic_minutes', 'ai_speaker_minutes', 'ai_ds_minutes',
  ]
  const mapped = ALL_ASSET_KEYS.map((k) => ASSET_KEY_TO_GATEWAY_TYPE[k])
  expect([...mapped].sort()).toEqual([...GATEWAY_ASSET_TYPES].sort())
})

test('video / audio 映射到网关领域名，而非腾讯平台字段名', () => {
  expect(ASSET_KEY_TO_GATEWAY_TYPE.video).toBe('video')
  expect(ASSET_KEY_TO_GATEWAY_TYPE.audio).toBe('audio')
  expect(ASSET_KEY_TO_GATEWAY_TYPE.video).not.toBe('download_address')
  expect(ASSET_KEY_TO_GATEWAY_TYPE.audio).not.toBe('audio_address')
})

test('isTextAssetType：视频音频不整读，文本与 AI 纪要整读', () => {
  expect(isTextAssetType('video')).toBe(false)
  expect(isTextAssetType('audio')).toBe(false)
  expect(isTextAssetType('meeting_summary')).toBe(true)
  expect(isTextAssetType('ai_meeting_transcripts')).toBe(true)
  expect(isTextAssetType('ai_ds_minutes')).toBe(true)
})

test('isTextAssetType：未知类型按二进制处理（不把未知大文件整读进内存）', () => {
  expect(isTextAssetType('some_future_engine_minutes')).toBe(false)
  // 旧的平台字段名现在也属于「未知」——保证不会因为残留写法而误判成文本
  expect(isTextAssetType('download_address')).toBe(false)
})
