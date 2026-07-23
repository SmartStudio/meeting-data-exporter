import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'

function fresh() { return createStore(openDb(':memory:')) }
const M = { meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }

test('upsertAsset 去重：同键第二次不新增行、更新字段', () => {
  const s = fresh(); s.upsertMeeting(M, 1)
  s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'download_address', remoteId: 'rf1', bytesExpected: 10 }, 1)
  s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'download_address', remoteId: 'rf1', bytesExpected: 20 }, 2)
  expect(s.counts().pending).toBe(1)
})
test('claimNext 原子领租约：pending→running，attempts+1，第二次领不到', () => {
  const s = fresh(); s.upsertMeeting(M, 1)
  s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'a', remoteId: 'r', bytesExpected: 1 }, 1)
  const claimed = s.claimNext(100, 300)!
  expect(claimed.status).toBe('running')
  expect(claimed.attempts).toBe(1)
  expect(s.claimNext(100, 300)).toBeNull()          // 租约未过期，领不到
})
test('崩溃恢复：running 租约过期后可被重领', () => {
  const s = fresh(); s.upsertMeeting(M, 1)
  s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'a', remoteId: 'r', bytesExpected: 1 }, 1)
  s.claimNext(100, 300)                              // 租约到 400
  expect(s.claimNext(401, 300)!.attempts).toBe(2)    // 过期后重领，attempts 递增
})
test('探测：upsert/due/resolve', () => {
  const s = fresh()
  s.upsertProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes', deadlineAt: 9999, probeAfter: 0 })
  expect(s.dueProbes(100).length).toBe(1)
  s.resolveProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes' })
  expect(s.dueProbes(100).length).toBe(0)
})
