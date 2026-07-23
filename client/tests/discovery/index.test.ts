import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { discover } from '../../src/discovery'
import type { GatewayClient } from '../../src/gateway/client'

function fakeGw(assetsByMeeting: Record<string, any[]>): GatewayClient {
  return {
    listMeetings: async () => ({ meetings: [{ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }], nextCursor: null }),
    listAssets: async (id) => assetsByMeeting[id] ?? [],
    getDownloadUrl: async () => ({ url: '', expiresAt: 0, fileType: null, bytesExpected: null }),
  }
}

test('就绪资产建 pending 任务；不在清单的想要类型建 probing 探测', async () => {
  const store = createStore(openDb(':memory:'))
  const gw = fakeGw({ m1: [
    { assetId: 'm1:rf1:download_address:0', assetType: 'download_address', remoteId: 'rf1', state: 3, allowDownload: true, bytesExpected: 100, fileType: 'mp4' },
  ] })
  // 想要 video + ai_transcript：video 就绪→任务；ai_transcript 不在清单→探测
  const r = await discover({ gw, store, now: () => 1000 }, { kind: 'range', from: 1, to: 2 }, ['video', 'ai_transcript'], 1000)
  expect(r.meetings).toBe(1)
  expect(store.counts().pending).toBe(1)                 // 只有 video 建了任务
  expect(store.dueProbes(1000).length).toBe(1)           // ai_transcript 在探测
})

test('allow_download=false 的想要资产直接 skipped，不建任务不留探测', async () => {
  const store = createStore(openDb(':memory:'))
  const gw = fakeGw({ m1: [
    { assetId: 'm1:rf1:ai_meeting_transcripts:0', assetType: 'ai_meeting_transcripts', remoteId: 'rf1', state: 3, allowDownload: false },
  ] })
  await discover({ gw, store, now: () => 1000 }, { kind: 'range', from: 1, to: 2 }, ['ai_transcript'], 1000)
  expect(store.counts().skipped).toBe(1)
})
