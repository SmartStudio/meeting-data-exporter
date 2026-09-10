import { expect, test, spyOn } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { runExecutor } from '../../src/executor'
import { meetingPathKey } from '../../src/domain/types'

/**
 * 写回前的租约栅栏（2026-09-10 本机实测的故障）：
 *
 * 一条下载连接静默挂住 40 分钟，`.part` 不再增长而连接仍 ESTABLISHED。租约（900 秒）
 * 过期后**同一个进程**的另一个并发槽通过 `claimNext` 把同一行又领了一次，两个槽同时
 * 写同一个 `.part`：先完成的把 `.mp4` finalize 了，后完成的报 ENOENT，`markFailed`
 * 又把行改回 failed——盘上文件其实是完整的，库里却说它失败了，而且再也不会有人去看。
 *
 * 这里把那一幕压缩成一个用例：在下载进行中推进时钟、直接再 `claimNext` 一次，
 * 于是第一次下载结束时手里的租约已经作废。它的写回必须**一个字段都改不动**，
 * 只在 `result.lost` 上留下痕迹——这一行的结论归重新领走它的那一次。
 */
function seed() {
  const store = createStore(openDb(':memory:'))
  return store
}
const MEETINGS = new Map([[meetingPathKey('m1', ''), { meetingId: 'm1', subMeetingId: '', subject: 's', startTime: 100, meetingCode: null, endTime: null, createdAt: 1, dirOrdinal: 1 }]])

test('下载期间租约被别人重领：写回落空，行不被改写，计入 result.lost', async () => {
  const store = seed()
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)

  let clock = 1000
  let stolenAttempts = 0
  const deps: any = {
    store,
    // 下载"期间"租约到期、被另一个并发槽领走：推进时钟再领一次就是那一幕
    download: async () => {
      clock += 400                                   // 越过 claimNext 写下的 1000+300
      const stolen = (await store.claimNext(clock, 300))!
      stolenAttempts = stolen.attempts
      return { status: 'completed' as const, contentHash: 'h', bytesWritten: 10 }
    },
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: MEETINGS,
  }
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => clock)
  const warned = warn.mock.calls.flat().join(' ')     // 先取走：mockRestore 会把记录一并清掉
  warn.mockRestore()

  expect(stolenAttempts).toBe(2)                     // 确实被重领了一次
  expect(r).toEqual({ completed: 0, failed: 0, skipped: 0, lost: 1 })

  const row = (await store.assetsForMeeting('m1', ''))[0]!
  expect(row.status).toBe('running')                 // 仍归重领它的那一次所有
  expect(row.attempts).toBe(2)
  expect(row.content_hash).toBeNull()                // 迟到的 markCompleted 一个字段都没写进去
  expect(row.bytes_written).toBe(0)

  // 落空必须留下认得出的痕迹：只加一个计数器的话，运维在日志里看不到任何东西
  expect(warned).toContain('lease lost')
  expect(warned).toContain(`id=${row.id}`)            // 认得出是哪一条、哪一次领取
  expect(warned).toContain('attempts=1')
})

// 反面：租约全程在自己手里时，写回照常生效、lost 恒为 0（栅栏不该误杀正常路径）
test('租约没被人碰过：写回正常生效，lost 为 0', async () => {
  const store = seed()
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)
  const deps: any = {
    store,
    download: async () => ({ status: 'completed' as const, contentHash: 'h', bytesWritten: 10 }),
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: MEETINGS,
  }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r).toEqual({ completed: 1, failed: 0, skipped: 0, lost: 0 })
  expect((await store.assetsForMeeting('m1', ''))[0]!.status).toBe('completed')
})

// 失败路径也要栅栏：这正是实测里最伤人的那一幕——盘上文件已经被先完成的那一侧
// finalize 好了，后到的这一次却把行改回 failed，于是一份完整的归档被记成失败。
test('下载失败但租约已被重领：markFailed 也落空，行不被改回 failed', async () => {
  const store = seed()
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)

  let clock = 1000
  const deps: any = {
    store,
    download: async () => {
      clock += 400
      await store.claimNext(clock, 300)
      return { status: 'failed' as const, error: 'ENOENT …mp4.part' }
    },
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: MEETINGS,
  }
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => clock)
  warn.mockRestore()

  expect(r.failed).toBe(0)
  expect(r.lost).toBe(1)
  const row = (await store.assetsForMeeting('m1', ''))[0]!
  expect(row.status).toBe('running')
  expect(row.last_error).toBeNull()
})
