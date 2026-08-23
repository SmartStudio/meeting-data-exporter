import { expect, test, spyOn } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { runExecutor } from '../../src/executor'
// 用真实 store + 假 downloadAsset（注入）+ 临时目录

test('并发池领任务并下载，全部 completed；幂等重跑零下载', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  for (const rid of ['r1', 'r2', 'r3']) await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: rid, bytesExpected: 10, fileType: 'mp4' }, 1)
  let downloads = 0
  const fakeDownload = async () => { downloads++; return { status: 'completed' as const, contentHash: null } }
  const deps: any = { store, download: fakeDownload, gw: {}, storage: { ensureFreeSpace: async () => true }, meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]) }
  const r1 = await runExecutor(deps, { concurrency: 2, leaseSec: 300 }, () => 1000)
  expect(r1.completed).toBe(3)
  expect(downloads).toBe(3)
  const r2 = await runExecutor(deps, { concurrency: 2, leaseSec: 300 }, () => 2000)  // 幂等
  expect(r2.completed).toBe(0)
  expect(downloads).toBe(3)   // 第二次零下载
})

test('磁盘不足 → 该任务 skipped(disk_full)，不写半截', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)
  const deps: any = { store, download: async () => ({ status: 'completed', contentHash: null }), gw: {}, storage: { ensureFreeSpace: async () => false }, meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]) }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r.skipped).toBe(1)
})

test('同一会议同类多段文本 → 输出路径不碰撞', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  for (const rid of ['rf1', 'rf2']) await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: rid, fileType: 'pdf' }, 1)
  const paths: string[] = []
  const deps: any = { store, download: async (t: any) => { paths.push(t.relPath); return { status: 'completed', contentHash: null } }, gw: {}, storage: { ensureFreeSpace: async () => true }, meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]) }
  const r = await runExecutor(deps, { concurrency: 2, leaseSec: 300 }, () => 1000)
  expect(r.completed).toBe(2)
  expect(new Set(paths).size).toBe(2)                        // 两个路径不同 —— 不碰撞
  expect(paths.some((p) => p.endsWith('transcript_2.pdf'))).toBe(true)
})

// ---------------------------------------------------------------------------
// 回归：touchProgress 写库失败不该吞错——Task 3 code review 发现的问题
// （见 packages/engine/src/executor/index.ts 的 onProgress 回调注释）：
// 早期实现用 `void deps.store.touchProgress(...)` 丢弃了这个 Promise，写库失败
// 时错误被彻底吞掉，MySQL 宿主下这条路是按下载块高频触发的池化连接 UPDATE，
// deadlock / connection reset 都很现实。修复后改成 `.catch(e => console.warn(...))`：
// 下载仍然完成（进度回写是尽力而为，不该中断下载），但错误必须留下痕迹。
// ---------------------------------------------------------------------------
test('touchProgress 写库失败不中断下载，但错误会被 console.warn 记录，不是静默吞掉', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)

  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    // 其余方法透传真实 store，只让 touchProgress 强制失败，模拟写库出错（如连接池超时）
    const flakyStore = { ...store, async touchProgress() { throw new Error('boom') } }
    const deps: any = {
      store: flakyStore,
      download: async (_task: any, onProgress: any) => {
        onProgress(5)               // 触发 touchProgress，其 rejection 由 .catch 接住
        await Promise.resolve()     // 让上面那个 microtask（console.warn）先跑完，再往下断言
        return { status: 'completed', contentHash: null }
      },
      gw: {},
      storage: { ensureFreeSpace: async () => true },
      meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]),
    }
    const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
    expect(r.completed).toBe(1)        // 下载仍然完成，没被进度写库失败打断
    expect(warnSpy).toHaveBeenCalled() // 但错误留下了痕迹，没被静默吞掉
  } finally {
    warnSpy.mockRestore()
  }
})

