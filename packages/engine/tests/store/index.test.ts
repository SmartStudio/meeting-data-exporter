import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { meetingPathKey } from '../../src/domain/types'

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
  await s.markCompleted(c1.id, 'hash', 1, 100)     // seg1 → completed
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

test('meetingsForPaths 按 (meeting_id, sub_meeting_id) 建键：周期会议每个场次各一项', async () => {
  const s = fresh()
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-1', subject: '第一场', startTime: 1000 }, 1)
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-2', subject: '第二场', startTime: 2000 }, 1)

  const map = await s.meetingsForPaths()
  expect(map.size).toBe(2)                       // 不再塌成一条
  expect(map.get(meetingPathKey('m1', 'rec-1'))).toEqual({
    meetingId: 'm1', subMeetingId: 'rec-1', subject: '第一场',
    startTime: 1000, meetingCode: '88', endTime: 200, dirOrdinal: 1,
  })
  expect(map.get(meetingPathKey('m1', 'rec-2'))!.startTime).toBe(2000)
})

/**
 * 同一分钟的第二条录制记录：目录名要加序号，否则两场会议争同一个目录。
 * 序号本身由 `assignDirOrdinals` 算（domain/dir-ordinal.ts 有完整理由与实测数据），
 * 这里钉的是「meetingsForPaths 确实把它算上了」——两个宿主各钉一份，逐条对齐。
 */
test('meetingsForPaths 同 meeting 同一分钟的两个场次：dirOrdinal 按 sub 升序给 1 与 2', async () => {
  const s = fresh()
  // 逆序插入：序号只能由 sub_meeting_id 决定，不能由插入顺序决定
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-2', subject: '转写_第一场', startTime: 1010 }, 1)   // 与 1000 同一分钟
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-1', subject: '第一场', startTime: 1000 }, 1)

  const map = await s.meetingsForPaths()
  expect(map.get(meetingPathKey('m1', 'rec-1'))!.dirOrdinal).toBe(1)
  expect(map.get(meetingPathKey('m1', 'rec-2'))!.dirOrdinal).toBe(2)
})

test('meetingsForPaths 起始分钟不同的两个场次：目录本就不同名，dirOrdinal 都是 1', async () => {
  const s = fresh()
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-1', startTime: 1000 }, 1)
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-2', startTime: 1000 + 3600 }, 1)

  const map = await s.meetingsForPaths()
  expect(map.get(meetingPathKey('m1', 'rec-1'))!.dirOrdinal).toBe(1)
  expect(map.get(meetingPathKey('m1', 'rec-2'))!.dirOrdinal).toBe(1)
})

test('meetingsForPaths 存量空串行排最前：dirOrdinal=1，目录名保持原样', async () => {
  const s = fresh()
  await s.upsertMeeting(M, 1)                                       // subMeetingId ''
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-9', startTime: 100 }, 1)

  const map = await s.meetingsForPaths()
  expect(map.get(meetingPathKey('m1', ''))!.dirOrdinal).toBe(1)
  expect(map.get(meetingPathKey('m1', 'rec-9'))!.dirOrdinal).toBe(2)
})

test('meetingsForPaths 仍认得空 sub_meeting_id 的旧行（旧 SQLite 库的兼容口径）', async () => {
  const s = fresh()
  await s.upsertMeeting(M, 1)                    // M.subMeetingId === ''
  const map = await s.meetingsForPaths()
  expect(map.get(meetingPathKey('m1', ''))!.meetingId).toBe('m1')
})

// ---------------------------------------------------------------------------
// sidecar（meeting.json / _manifest.json）要的两个读方法。两者都按**精确的
// (meeting_id, sub_meeting_id)** 取，与归档流水线的 listCompletedAssets 同口径：
// meetingsForPaths 虽然也按两段主键建键，却只带拼路径用得上的几列，替代不了它们。
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
  await s.markCompleted(first.id, 'h', 11, 100)

  const rows = await s.assetsForMeeting('m1', '')
  expect(rows.map((r) => r.remote_id)).toEqual(['r1', 'r2'])            // 兄弟场次与别的会议都不在内
  expect(rows.map((r) => r.status)).toEqual(['completed', 'pending'])   // 状态不过滤，交给调用方分类
  expect(await s.assetsForMeeting('m1', 'sub2')).toHaveLength(1)
})

// 进度回写是**不 await 的**（executor 的 onProgress），所以一次慢的 touchProgress
// 完全可能落在 markCompleted 之后。在 bytes_written 只是进度检查点的年代那只是脏数据；
// 现在这一列是 completed 行的文件大小、并且会被写进永久留在 NAS 上的清单，
// 一次迟到的回写就是一份撒谎的清单。终态行一律不接受进度回写。
test('touchProgress 不回写终态的行：迟到的检查点不许盖掉真实文件大小', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 1)
  const row = (await s.claimNext(100, 300))!
  await s.markCompleted(row.id, 'h', 12_345, 120)
  await s.touchProgress(row.id, 8 * 1024 * 1024, 130, 300)    // 迟到的那一次

  const done = (await s.assetsForMeeting('m1', ''))[0]!
  expect(done.bytes_written).toBe(12_345)
  expect(done.status).toBe('completed')
  expect(done.lease_expires_at).toBeNull()                     // 也没有把租约续回来
})

test('markCompleted 用真实文件大小覆盖 touchProgress 留下的进度检查点', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 1)
  const row = (await s.claimNext(100, 300))!
  await s.touchProgress(row.id, 8 * 1024 * 1024, 110, 300)   // 最后一次 8MB 检查点
  await s.markCompleted(row.id, 'h', 8 * 1024 * 1024 + 4242, 120)

  const done = (await s.assetsForMeeting('m1', ''))[0]!
  expect(done.status).toBe('completed')
  expect(done.bytes_written).toBe(8 * 1024 * 1024 + 4242)    // completed 行上这一列是真实大小
})

// ── 失败重试：failed 行按退避重新入队 ────────────────────────────
//
// 修复之前 `failed` 是事实上的终态：claim 只看 pending 与过期的 running，
// upsertAsset 不重置 status，resetFailed 只有 CLI 的 retry 命令会调。一条资产
// 只要网络抖一次失败，attempts 就永远停在 1，MAX_ATTEMPTS=5 那道门走不到。

test('markFailed 写下最早可再领取时间：没到点领不到，到点了领得到且 attempts 递增', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 1)
  const first = (await s.claimNext(100, 300))!
  expect(first.attempts).toBe(1)

  const retryAt = 100 + 300                                   // executor 的 downloadBackoff(1)
  await s.markFailed(first.id, 'HTTP 500', 110, retryAt)
  expect((await s.assetsForMeeting('m1', ''))[0]!.lease_expires_at).toBe(retryAt)

  expect(await s.claimNext(retryAt - 1, 300)).toBeNull()       // 还在退避里
  // 边界与租约那条**严格同款**（`lease_expires_at < now` 才算可领），所以卡在
  // retryAt 这一秒上还不行。两类行同形是 MySQL 宿主加锁足迹的前提，不值得为一秒
  // 把它们拆成两种写法。
  expect(await s.claimNext(retryAt, 300)).toBeNull()
  const again = (await s.claimNext(retryAt + 1, 300))!
  expect(again.id).toBe(first.id)
  expect(again.status).toBe('running')
  expect(again.attempts).toBe(2)
  expect(again.last_error).toBe('HTTP 500')                    // 上次的错留着，转 dead 时要用
})

test('领取顺序仍是"全局 id 最小"：到点的 failed 排在 id 更大的 pending 前面', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'old' }, 1)
  const old = (await s.claimNext(100, 300))!
  await s.markFailed(old.id, 'boom', 110, 400)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'new' }, 200)  // id 更大

  const got = (await s.claimNext(401, 300))!
  expect(got.id).toBe(old.id)
  expect(got.remote_id).toBe('old')
})

test('resetFailed 把 failed/dead 打回 pending，并清掉那个"最早可再领取时间"', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 1)
  const row = (await s.claimNext(100, 300))!
  await s.markFailed(row.id, 'boom', 110, 9_999_999)          // 退避到很久以后

  expect(await s.resetFailed(120)).toBe(1)
  const back = (await s.assetsForMeeting('m1', ''))[0]!
  expect(back.status).toBe('pending')
  expect(back.last_error).toBeNull()
  // 留着的话，一条 pending 行上会挂着一个没有任何含义的时间戳
  expect(back.lease_expires_at).toBeNull()
  expect((await s.claimNext(130, 300))!.id).toBe(row.id)      // 逃生口的意义：立刻能再领
})
