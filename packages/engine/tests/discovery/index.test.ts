import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { discover } from '../../src/discovery'
import type { AssetSource } from '../../src/source/types'

function fakeGw(assetsByMeeting: Record<string, any[]>): AssetSource {
  return {
    listMeetings: async () => ({ meetings: [{ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }], nextCursor: null }),
    listAssets: async (id) => assetsByMeeting[id] ?? [],
    getDownloadUrl: async () => ({ url: '', expiresAt: 0, fileType: null, bytesExpected: null }),
  }
}

test('discovery 把会议的场次一起交给 listAssets——同 meeting_id 的多个场次各要各的资产', async () => {
  const store = createStore(openDb(':memory:'))
  const seen: Array<[string, string]> = []
  const gw: AssetSource = {
    listMeetings: async () => ({ meetings: [
      { meetingId: 'm1', subMeetingId: 'rec-1', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 },
      { meetingId: 'm1', subMeetingId: 'rec-2', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 300, endTime: 400 },
    ], nextCursor: null }),
    listAssets: async (id, sub) => {
      seen.push([id, sub])
      return [{ assetId: `m1:${sub}:video:0`, assetType: 'video', remoteId: `rf-${sub}`, state: 3, allowDownload: true, bytesExpected: 1, fileType: 'mp4' }]
    },
    getDownloadUrl: async () => ({ url: '', expiresAt: 0, fileType: null, bytesExpected: null }),
  }
  await discover({ gw, store }, { kind: 'range', from: 1, to: 2 }, ['video'], 1000)
  expect(seen).toEqual([['m1', 'rec-1'], ['m1', 'rec-2']])
})

test('就绪资产建 pending 任务；不在清单的想要类型建 probing 探测', async () => {
  const store = createStore(openDb(':memory:'))
  const gw = fakeGw({ m1: [
    { assetId: 'm1:rf1:video:0', assetType: 'video', remoteId: 'rf1', state: 3, allowDownload: true, bytesExpected: 100, fileType: 'mp4' },
  ] })
  // 想要 video + ai_transcript：video 就绪→任务；ai_transcript 不在清单→探测
  const r = await discover({ gw, store }, { kind: 'range', from: 1, to: 2 }, ['video', 'ai_transcript'], 1000)
  expect(r.meetings).toBe(1)
  expect((await store.counts()).pending).toBe(1)                 // 只有 video 建了任务
  expect((await store.dueProbes(1000)).length).toBe(1)           // ai_transcript 在探测
})

test('allow_download=false 的想要资产直接 skipped，不建任务不留探测', async () => {
  const store = createStore(openDb(':memory:'))
  const gw = fakeGw({ m1: [
    { assetId: 'm1:rf1:ai_meeting_transcripts:0', assetType: 'ai_meeting_transcripts', remoteId: 'rf1', state: 3, allowDownload: false },
  ] })
  await discover({ gw, store }, { kind: 'range', from: 1, to: 2 }, ['ai_transcript'], 1000)
  expect((await store.counts()).skipped).toBe(1)
})

test('discovery 存网关下发的 assetId，不自行重构', async () => {
  const store = createStore(openDb(':memory:'))
  const gw = fakeGw({ m1: [
    { assetId: 'mrec9:rf1:video:0', assetType: 'video', remoteId: 'rf1', state: 3, allowDownload: true, bytesExpected: 100, fileType: 'mp4' },
  ] })
  await discover({ gw, store }, { kind: 'range', from: 1, to: 2 }, ['video'], 1000)
  const row = (await store.claimNext(2000, 300))!
  expect(row.asset_id).toBe('mrec9:rf1:video:0')
})

test('同类型多段录制 → 每段各建一个任务（不塌缩为一个）', async () => {
  const store = createStore(openDb(':memory:'))
  const gw = fakeGw({ m1: [
    { assetId: 'm1:rf1:video:0', assetType: 'video', remoteId: 'rf1', state: 3, allowDownload: true, bytesExpected: 100, fileType: 'mp4' },
    { assetId: 'm1:rf2:video:1', assetType: 'video', remoteId: 'rf2', state: 3, allowDownload: true, bytesExpected: 200, fileType: 'mp4' },
  ] })
  await discover({ gw, store }, { kind: 'range', from: 1, to: 2 }, ['video'], 1000)
  expect((await store.counts()).pending).toBe(2)   // 两段各一任务，不塌缩
})
