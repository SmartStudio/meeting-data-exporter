import { expect, test } from 'bun:test'
import {
  assetTypeLabel,
  deadAssetsDetail,
  deadAssetsReason,
  describeDownloadError,
} from '../../src/worker/failure-text'

/**
 * 失败项的 `reason` 那一列是给**运维**看的第一眼。它从前是原始报错直接拼的：
 *
 *   下载重试用尽，已放弃：video（ENOENT: no such file or directory, open
 *   '/Users/…/transcript_3.txt.part'）
 *
 * 三个毛病：一句英文 errno 说不出「该找谁」；路径还是改名前的旧路径（误导）；
 * 每一条的路径都不一样，于是归并键（任务 + 原因 + 影响）失效，23 场同一件事
 * 变成 23 行。这个模块把它翻成一句人话，原文进 `detail`。
 */

test('404 = 平台没有这个文件——它不是"我们这边出了错"', () => {
  expect(describeDownloadError('http 404')).toBe('腾讯那边没有这个文件')
})

test('5xx 与换链换到头都是上游的下载服务出错', () => {
  expect(describeDownloadError('http 500')).toBe('腾讯下载服务出错')
  expect(describeDownloadError('http 503')).toBe('腾讯下载服务出错')
  expect(describeDownloadError('too many link renewals')).toBe('腾讯下载服务出错')
})

test('本地文件系统的三个 errno 归成一句：该去看盘和权限', () => {
  expect(describeDownloadError("ENOENT: no such file or directory, open '/x/y.part'")).toBe('本地写入失败')
  expect(describeDownloadError('EACCES: permission denied')).toBe('本地写入失败')
  expect(describeDownloadError('ENOSPC: no space left on device')).toBe('本地写入失败')
})

test('字节数对不上是"下载不完整"，不是"下载失败"——那是两种处理', () => {
  expect(describeDownloadError('size mismatch: 100 != 200')).toBe('下载不完整')
})

test('认不出的错与没有错误信息都回一句最弱的话，不编一个原因', () => {
  expect(describeDownloadError('connect ETIMEDOUT 10.0.0.1:443')).toBe('下载失败')
  expect(describeDownloadError(null)).toBe('下载失败')
  expect(describeDownloadError('')).toBe('下载失败')
})

// 404 那条要排在 5xx 之前判：`http 404` 不以 `http 5` 开头，两条不会打架，
// 但顺序写反时 `http 500` 会被 startsWith('http 4') 之类的手滑写法捞走。
test('判定顺序：含 ENOENT 的 404 仍然算「腾讯那边没有这个文件」', () => {
  expect(describeDownloadError("http 404 (ENOENT: open '/x/y.part')")).toBe('腾讯那边没有这个文件')
})

test('资产名用全项目那一份中文；认不出的类型原样带出，不映成任何一个已知的', () => {
  expect(assetTypeLabel('video')).toBe('录像')
  expect(assetTypeLabel('meeting_summary')).toBe('逐字稿')
  expect(assetTypeLabel('ai_minutes')).toBe('纪要')
  expect(assetTypeLabel('chapters')).toBe('时间轴')
  expect(assetTypeLabel('brand_new_thing')).toBe('brand_new_thing')
})

test('一场会议一句话：<中文资产名>：<人话>，用「；」连接', () => {
  const reason = deadAssetsReason([
    { assetType: 'video', remoteId: 'r1', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'meeting_summary', remoteId: 'r2', fileType: 'txt', lastError: 'ENOENT: open x' },
  ])
  expect(reason).toBe('录像：腾讯那边没有这个文件；逐字稿：本地写入失败')
})

// 归并是这句话存在的全部理由：同一场会议的三段录像同样 404 时，写三遍
// 「录像：腾讯那边没有这个文件」既没多说什么，又把这一行撑长。
test('同类同因的多条压成一句', () => {
  const reason = deadAssetsReason([
    { assetType: 'video', remoteId: 'r1', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'video', remoteId: 'r2', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'video', remoteId: 'r3', fileType: 'mp4', lastError: 'http 404' },
  ])
  expect(reason).toBe('录像：腾讯那边没有这个文件')
})

// 但**同类不同因**必须两句都在：一段录像 404、另一段磁盘满，是两件事、两种处置。
test('同类不同因不压：两句都在', () => {
  const reason = deadAssetsReason([
    { assetType: 'video', remoteId: 'r1', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'video', remoteId: 'r2', fileType: 'mp4', lastError: 'ENOSPC' },
  ])
  expect(reason).toBe('录像：腾讯那边没有这个文件；录像：本地写入失败')
})

test('detail 一条一行，带资产类型 / remote_id / 格式与错误原文', () => {
  const detail = deadAssetsDetail([
    { assetType: 'video', remoteId: 'r1', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'meeting_summary', remoteId: 'r2', fileType: null, lastError: null },
  ])
  expect(detail).toBe('video/r1/mp4: http 404\nmeeting_summary/r2/: 无错误信息')
})
