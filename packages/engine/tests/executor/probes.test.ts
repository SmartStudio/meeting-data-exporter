import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { runProbes } from '../../src/executor'

// ---------------------------------------------------------------------------
// 同源产物（src/domain/sibling.ts）在探测循环里的那一半。
//
// discovery 只在下一次扫到这场会议时才会走同一条规则，而存量探测行等不到那一次
// ——上线之前建的 89 条 audio 探测就是这么一路探到 deadline、落成假的 upstream_timeout 的。
// 所以 runProbes 自己也要认这条规则。
// ---------------------------------------------------------------------------

function gwWith(assets: any[]) {
  return { listAssets: async () => assets }
}
function depsWith(store: any, assets: any[]) {
  return { store, gw: gwWith(assets), download: async () => ({ status: 'completed', contentHash: null, bytesWritten: 1 }), storage: { ensureFreeSpace: async () => true }, meetingsByPathKey: new Map() } as any
}
const readyVideo = { assetId: 'm1:rf1:video:0', assetType: 'video', remoteId: 'rf1', state: 3, allowDownload: true, bytesExpected: 1, fileType: 'mp4' }

test('audio 探测：video 已就绪而 audio 缺席 → abandoned(not_generated)，不再空等到 deadline', async () => {
  const db = openDb(':memory:')
  const store = createStore(db)
  await store.upsertProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', deadlineAt: 99999, probeAfter: 0 })

  const r = await runProbes(depsWith(store, [readyVideo]), () => 1000)
  expect(r.abandoned).toBe(1)
  expect(r.resolved).toBe(0)
  expect(r.newTasks).toBe(0)
  const row = db.query(`SELECT state, last_reason, attempts FROM asset_probes WHERE asset_type='audio'`).get() as any
  expect(row.state).toBe('abandoned')
  expect(row.last_reason).toBe('not_generated')
  expect(row.attempts).toBe(0)                                  // 直接了结，不再退避重探
  expect((await store.dueProbes(999999)).length).toBe(0)
})

test('video 还在转码 / 根本不在清单 → audio 探测照旧退避重探（回归）', async () => {
  for (const assets of [[{ ...readyVideo, state: 1 }], [] as any[]]) {
    const store = createStore(openDb(':memory:'))
    await store.upsertProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', deadlineAt: 99999, probeAfter: 0 })
    const r = await runProbes(depsWith(store, assets), () => 1000)
    expect(r.abandoned).toBe(0)
    expect((await store.dueProbes(999999)).length).toBe(1)       // 还在 probing，只是往后排了
  }
})

test('audio 真的出现了 → 照常 resolved 并补建任务（规则不误伤）', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', deadlineAt: 99999, probeAfter: 0 })
  const audio = { assetId: 'm1:rf1:audio:0', assetType: 'audio', remoteId: 'rf1', state: 3, allowDownload: true, bytesExpected: 2, fileType: 'm4a' }
  const r = await runProbes(depsWith(store, [readyVideo, audio]), () => 1000)
  expect(r.resolved).toBe(1)
  expect((await store.counts()).pending).toBe(1)
})

test('智能产物不受牵连：video 就绪也不能把 ai_minutes / chapters 探测判死', async () => {
  for (const t of ['ai_minutes', 'chapters']) {
    const store = createStore(openDb(':memory:'))
    await store.upsertProbe({ meetingId: 'm1', subMeetingId: '', assetType: t, deadlineAt: 99999, probeAfter: 0 })
    const r = await runProbes(depsWith(store, [readyVideo]), () => 1000)
    expect(r.abandoned).toBe(0)                                  // 生成时机与录制转码各走各的，继续等
    expect((await store.dueProbes(999999)).length).toBe(1)
  }
})

test('超 deadline 的 audio 探测仍报 upstream_timeout —— video 也没出来时原因没变', async () => {
  const db = openDb(':memory:')
  const store = createStore(db)
  await store.upsertProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', deadlineAt: 500, probeAfter: 0 })
  const r = await runProbes(depsWith(store, []), () => 1000)
  expect(r.abandoned).toBe(1)
  const row = db.query(`SELECT last_reason FROM asset_probes WHERE asset_type='audio'`).get() as any
  expect(row.last_reason).toBe('upstream_timeout')
})
