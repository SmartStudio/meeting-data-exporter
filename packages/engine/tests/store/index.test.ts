import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'

function fresh() { return createStore(openDb(':memory:')) }
const M = { meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }

test('upsertAsset 去重：同键第二次不新增行、更新字段', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'rf1', bytesExpected: 10 }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'rf1', bytesExpected: 20 }, 2)
  expect((await s.counts()).pending).toBe(1)
})
test('claimNext 原子领租约：pending→running，attempts+1，第二次领不到', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'a', remoteId: 'r', bytesExpected: 1 }, 1)
  const claimed = (await s.claimNext(100, 300))!
  expect(claimed.status).toBe('running')
  expect(claimed.attempts).toBe(1)
  expect(await s.claimNext(100, 300)).toBeNull()          // 租约未过期，领不到
})
test('崩溃恢复：running 租约过期后可被重领', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'a', remoteId: 'r', bytesExpected: 1 }, 1)
  await s.claimNext(100, 300)                              // 租约到 400
  expect((await s.claimNext(401, 300))!.attempts).toBe(2)    // 过期后重领，attempts 递增
})
test('探测：upsert/due/resolve', async () => {
  const s = fresh()
  await s.upsertProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes', deadlineAt: 9999, probeAfter: 0 })
  expect((await s.dueProbes(100)).length).toBe(1)
  await s.resolveProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes' })
  expect((await s.dueProbes(100)).length).toBe(0)
})
test('upsertAsset 存网关 assetId，claimNext 原样取回；二次 upsert 不传时 COALESCE 保留', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'rf1', assetId: 'mrec1:rf1:video:0', bytesExpected: 10 }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'rf1', bytesExpected: 20 }, 2)  // 不传 assetId
  const row = (await s.claimNext(100, 300))!
  expect(row.asset_id).toBe('mrec1:rf1:video:0')   // 原样取回且未被二次 upsert 抹掉
})
test('markSkippedByKey 不回退已完成的同类资产，只跳过未完成的', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'seg1', bytesExpected: 1 }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'seg2', bytesExpected: 1 }, 1)
  const c1 = (await s.claimNext(100, 300))!          // 领到 seg1（id 最小）
  await s.markCompleted(c1.id, 'hash', 100)        // seg1 → completed
  await s.markSkippedByKey({ meetingId: 'm1', subMeetingId: '', assetType: 'video' }, 'download_not_allowed', 200)
  const cnt = await s.counts()
  expect(cnt.completed).toBe(1)              // seg1 未被回退
  expect(cnt.skipped).toBe(1)               // seg2 被跳过
})
test('siblingRank：同类多段按 id 升序给 1-based 序号', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'rf1' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'rf2' }, 1)
  const a = (await s.claimNext(100, 300))!   // id 较小者
  const b = (await s.claimNext(100, 300))!
  expect(await s.siblingRank(a)).toEqual({ ordinal: 1, total: 2 })
  expect(await s.siblingRank(b)).toEqual({ ordinal: 2, total: 2 })
})

// ---------------------------------------------------------------------------
// 多格式去重（M3.5：唯一键加入 file_type）
// 腾讯对同一份录制会同时给出 txt/docx/pdf 多种导出格式，它们**共享同一个
// record_file_id**。旧唯一键 (meeting, sub, asset_type, remote_id) 区分不了，
// 三条折叠成一条；又因平台返回顺序不稳定，同一条命令重复执行会拿到不同格式。
// ---------------------------------------------------------------------------

test('同一 remote_id 的多种格式各建一行，不再互相折叠', async () => {
  const store = createStore(openDb(':memory:'))
  for (const ft of ['txt', 'docx', 'pdf']) {
    await store.upsertAsset(
      { meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'rf1', fileType: ft },
      1,
    )
  }
  const claimed = [await store.claimNext(1, 60), await store.claimNext(1, 60), await store.claimNext(1, 60)]
  expect(claimed.every((r) => r !== null)).toBe(true)
  expect(claimed.map((r) => r!.file_type).sort()).toEqual(['docx', 'pdf', 'txt'])
  expect(await store.claimNext(1, 60)).toBeNull()
})

test('重复 upsert 同一 (remote_id, file_type) 仍然幂等，不产生第二行', async () => {
  const store = createStore(openDb(':memory:'))
  const a = { meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'rf1', fileType: 'pdf' }
  await store.upsertAsset(a, 1)
  await store.upsertAsset(a, 2)
  expect(await store.claimNext(1, 60)).not.toBeNull()
  expect(await store.claimNext(1, 60)).toBeNull()
})

test('siblingRank 按 file_type 分组：多格式不加序号', async () => {
  const store = createStore(openDb(':memory:'))
  for (const ft of ['txt', 'docx', 'pdf']) {
    await store.upsertAsset(
      { meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'rf1', fileType: ft },
      1,
    )
  }
  for (let i = 0; i < 3; i++) {
    const row = (await store.claimNext(1, 60))!
    // 每种格式在自己的 file_type 分组里都是「唯一一份」→ total=1，文件名不该带序号
    expect(await store.siblingRank(row)).toEqual({ ordinal: 1, total: 1 })
  }
})

test('siblingRank 对同格式的多段录制仍然给出序号', async () => {
  const store = createStore(openDb(':memory:'))
  for (const rid of ['rf1', 'rf2']) {
    await store.upsertAsset(
      { meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: rid, fileType: 'pdf' },
      1,
    )
  }
  const first = (await store.claimNext(1, 60))!
  const second = (await store.claimNext(1, 60))!
  expect(await store.siblingRank(first)).toEqual({ ordinal: 1, total: 2 })
  expect(await store.siblingRank(second)).toEqual({ ordinal: 2, total: 2 })
})

// ---------------------------------------------------------------------------
// sidecar（meeting.json / _manifest.json）要的两个读方法。两者都按**精确的
// (meeting_id, sub_meeting_id)** 取，与归档流水线的 listCompletedAssets 同口径：
// meetingsForPaths 那种按 meeting_id 去重的形状只适合拼路径，当枚举源会丢场次。
// ---------------------------------------------------------------------------

test('getMeeting 按精确 (meeting_id, sub_meeting_id) 取回，不存在给 null', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertMeeting({ ...M, subMeetingId: 'sub2', subject: '第二场', startTime: 300 }, 1)
  expect(await s.getMeeting('m1', '')).toEqual(M)
  expect((await s.getMeeting('m1', 'sub2'))!.subject).toBe('第二场')   // 不被同 meeting_id 的兄弟场次盖掉
  expect(await s.getMeeting('m1', 'nope')).toBeNull()
  expect(await s.getMeeting('nope', '')).toBeNull()
})

test('assetsForMeeting 只给本场次的行、按 id 升序，各状态一并给出', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', remoteId: 'r2' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 'sub2', assetType: 'video', remoteId: 'r3' }, 1)
  await s.upsertAsset({ meetingId: 'm2', subMeetingId: '', assetType: 'video', remoteId: 'r4' }, 1)
  const first = (await s.claimNext(100, 300))!
  await s.markCompleted(first.id, 'h', 100)

  const rows = await s.assetsForMeeting('m1', '')
  expect(rows.map((r) => r.remote_id)).toEqual(['r1', 'r2'])            // 兄弟场次与别的会议都不在内
  expect(rows.map((r) => r.status)).toEqual(['completed', 'pending'])   // 状态不过滤，交给调用方分类
  expect(await s.assetsForMeeting('m1', 'sub2')).toHaveLength(1)
})
