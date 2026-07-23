import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { runExecutor } from '../../src/executor'
// 用真实 store + 假 downloadAsset（注入）+ 临时目录

test('并发池领任务并下载，全部 completed；幂等重跑零下载', async () => {
  const store = createStore(openDb(':memory:'))
  store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  for (const rid of ['r1', 'r2', 'r3']) store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'download_address', remoteId: rid, bytesExpected: 10, fileType: 'mp4' }, 1)
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
  store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'download_address', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)
  const deps: any = { store, download: async () => ({ status: 'completed', contentHash: null }), gw: {}, storage: { ensureFreeSpace: async () => false }, meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]) }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r.skipped).toBe(1)
})
