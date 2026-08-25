/**
 * 会议目录的两个 sidecar（meeting.json / _manifest.json）——US-6.2「归档结果可脱离
 * 系统理解」。
 *
 * 这些用例里的 `DIR` 是**手算**的（见常量注释），不是从实现里抄回来的；最后一条
 * 用例更进一步，直接拿 runExecutor 真实算出来的资产落盘路径与 sidecar 的落点做
 * 逐字节比对——「sidecar 与资产同目录」这条不该靠肉眼核对。
 */
import { expect, test, spyOn } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore, type Store } from '../../src/store'
import { runExecutor } from '../../src/executor'
import { writeMeetingManifest, writeMeetingManifests } from '../../src/manifest'
import { MANIFEST_SCHEMA_VERSION, type ManifestFile, type MeetingMetaFile } from '../../src/domain/manifest'

// 2026-08-20T09:30:00Z。目录里的 year/month/date/hhmm 全由它派生。
const START = 1787218200
const MEETING = {
  meetingId: 'm1', subMeetingId: '', meetingCode: '881-123-40',
  subject: '周会 / Q3 复盘', hostUserId: 'u-host', startTime: START, endTime: START + 3600,
}
/** 手算：2026 / 08 / 2026-08-20_0930_<主题里的 `/` 清成 `-`>_<会议号> */
const DIR = '2026/08/2026-08-20_0930_周会 - Q3 复盘_881-123-40'
/** sha256("test")，只要是个像样的定值即可——本文件不验证哈希算法本身 */
const TEXT_SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'

function fakeStorage() {
  const writes = new Map<string, unknown>()
  return { writes, writeMeta: async (rel: string, data: unknown) => { writes.set(rel, data) } }
}

/** 真 store + 真 runExecutor + 假下载：让 target_path 由**真实的**拼路径逻辑产生 */
async function downloadAll(store: Store): Promise<string[]> {
  const meetingsById = await store.meetingsForPaths()
  const relPaths: string[] = []
  const deps = {
    store, gw: {}, meetingsById,
    storage: { ensureFreeSpace: async () => true, writeMeta: async () => {} },
    // 与真 downloader 同规则：文本类算整文件 sha256，视频/音频不算（会吃爆内存）
    download: async (t: { relPath: string; isText: boolean }) => {
      relPaths.push(t.relPath)
      return { status: 'completed' as const, contentHash: t.isText ? TEXT_SHA : null }
    },
  }
  await runExecutor(deps as never, { concurrency: 2, leaseSec: 300 }, () => 1000)
  return relPaths
}

async function seeded(): Promise<Store> {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting(MEETING, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'f-video-1', fileType: 'mp4', bytesExpected: 1234 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'f-sum-1', fileType: 'txt', bytesExpected: 42 }, 1)
  return store
}

test('一场会议下完资产后写出 meeting.json 与 _manifest.json，落在与资产同一个目录', async () => {
  const store = await seeded()
  await downloadAll(store)
  const storage = fakeStorage()

  const r = await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  expect(r).toBe('written')
  expect([...storage.writes.keys()].sort()).toEqual([`${DIR}/_manifest.json`, `${DIR}/meeting.json`])

  const meta = storage.writes.get(`${DIR}/meeting.json`) as MeetingMetaFile
  expect(meta).toEqual({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    meeting: {
      meetingId: 'm1', subMeetingId: '', meetingCode: '881-123-40',
      subject: '周会 / Q3 复盘', hostUserId: 'u-host', startTime: START, endTime: START + 3600,
    },
    generatedAt: 5000,
    generatedBy: 'mde-engine',
  })

  const manifest = storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile
  expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION)
  expect(manifest.meetingId).toBe('m1')
  expect(manifest.subMeetingId).toBe('')
  expect(manifest.generatedAt).toBe(5000)
  expect(manifest.generatedBy).toBe('mde-engine')
  expect(manifest.missing).toEqual([])
  expect(manifest.assets).toEqual([
    {
      assetType: 'video', assetKey: 'video', remoteId: 'f-video-1', fileType: 'mp4',
      fileName: 'recording_f-video-1.mp4', bytes: 1234, sha256: null,
    },
    {
      assetType: 'meeting_summary', assetKey: 'transcript', remoteId: 'f-sum-1', fileType: 'txt',
      fileName: 'transcript.txt', bytes: 42, sha256: TEXT_SHA,
    },
  ])
})

test('视频/音频的 sha256 如实写 null（不做整文件哈希），文本类有值', async () => {
  const store = await seeded()
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', remoteId: 'f-audio-1', fileType: 'm4a', bytesExpected: 99 }, 1)
  await downloadAll(store)
  const storage = fakeStorage()

  await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  const manifest = storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile
  const byType = new Map(manifest.assets.map((a) => [a.assetType, a]))
  expect(byType.get('video')!.sha256).toBeNull()
  expect(byType.get('audio')!.sha256).toBeNull()
  expect(byType.get('meeting_summary')!.sha256).toBe(TEXT_SHA)
})

test('一个 completed 资产都没有 → skipped，不写空清单', async () => {
  const store = await seeded()                       // 只 upsert，不跑 executor：全是 pending
  const storage = fakeStorage()

  const r = await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  expect(r).toBe('skipped')
  expect(storage.writes.size).toBe(0)
})

test('会议在库里不存在 → skipped，不写文件', async () => {
  const store = createStore(openDb(':memory:'))
  const storage = fakeStorage()
  expect(await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'nope', '', 5000)).toBe('skipped')
  expect(storage.writes.size).toBe(0)
})

test('终态失败的资产进 missing 并带原因——「确认缺失」与「不知有无」是两种状态', async () => {
  const store = await seeded()
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes', remoteId: 'f-ai-1', fileType: 'docx' }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'ai_topic_minutes', remoteId: 'f-ai-2', fileType: 'docx' }, 1)
  await downloadAll(store)                              // 四个都 completed
  // 再把两个 AI 纪要打回终态：一个 skipped（平台明说不给），一个 dead（重试用尽）
  const rows = await store.assetsForMeeting('m1', '')
  const ai1 = rows.find((r) => r.asset_type === 'ai_minutes')!
  const ai2 = rows.find((r) => r.asset_type === 'ai_topic_minutes')!
  await store.markSkipped(ai1.id, 'download_not_allowed', 2000)
  await store.markDead(ai2.id, 'http 500', 2000)
  const storage = fakeStorage()

  await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  const manifest = storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile
  expect(manifest.assets.map((a) => a.assetType).sort()).toEqual(['meeting_summary', 'video'])
  expect(manifest.missing).toEqual([
    { assetType: 'ai_minutes', assetKey: 'ai_minutes', remoteId: 'f-ai-1', status: 'skipped', reason: 'download_not_allowed' },
    { assetType: 'ai_topic_minutes', assetKey: 'ai_topic_minutes', remoteId: 'f-ai-2', status: 'dead', reason: 'http 500' },
  ])
})

test('重复调用幂等：除 generatedAt 外内容逐字节一致', async () => {
  const store = await seeded()
  await downloadAll(store)
  const a = fakeStorage(); const b = fakeStorage()

  await writeMeetingManifest({ store, storage: a, generatedBy: 'mde-engine' }, 'm1', '', 5000)
  await writeMeetingManifest({ store, storage: b, generatedBy: 'mde-engine' }, 'm1', '', 9999)

  for (const name of ['meeting.json', '_manifest.json']) {
    const strip = (d: unknown) => JSON.stringify({ ...(d as object), generatedAt: 0 })
    expect(strip(b.writes.get(`${DIR}/${name}`))).toBe(strip(a.writes.get(`${DIR}/${name}`)))
  }
  expect((a.writes.get(`${DIR}/meeting.json`) as MeetingMetaFile).generatedAt).toBe(5000)
  expect((b.writes.get(`${DIR}/meeting.json`) as MeetingMetaFile).generatedAt).toBe(9999)
})

test('writeMeta 抛错不让整轮挂掉，但必须留下 warn 痕迹（不是静默吞掉）', async () => {
  const store = await seeded()
  await downloadAll(store)
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const storage = { writeMeta: async () => { throw new Error('nas gone') } }
    const meetingsById = await store.meetingsForPaths()

    const r = await writeMeetingManifests({ store, storage, generatedBy: 'mde-worker' }, meetingsById, () => 5000)

    expect(r).toEqual({ written: 0, skipped: 0, failed: 1 })   // 整轮正常返回，没有抛出
    expect(warnSpy).toHaveBeenCalled()                          // 但错误留下了痕迹
  } finally {
    warnSpy.mockRestore()
  }
})

test('一轮收尾对每场会议各写一次，计数分 written/skipped', async () => {
  const store = await seeded()
  await store.upsertMeeting({ ...MEETING, meetingId: 'm2', meetingCode: '882-000-00', subject: '没下过东西的会' }, 1)
  await downloadAll(store)
  const storage = fakeStorage()

  const r = await writeMeetingManifests({ store, storage, generatedBy: 'mde-worker' }, await store.meetingsForPaths(), () => 5000)

  expect(r).toEqual({ written: 1, skipped: 1, failed: 0 })     // m1 有资产、m2 没有
  expect((storage.writes.get(`${DIR}/meeting.json`) as MeetingMetaFile).generatedBy).toBe('mde-worker')
})

test('sidecar 的目录与 runExecutor 算出的资产目录逐字节一致', async () => {
  const store = await seeded()
  const relPaths = await downloadAll(store)
  const storage = fakeStorage()

  await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const assetDirs = new Set(relPaths.map(dirOf))
  const sidecarDirs = new Set([...storage.writes.keys()].map(dirOf))
  expect(relPaths.length).toBeGreaterThan(0)
  expect(sidecarDirs.size).toBe(1)
  expect([...sidecarDirs]).toEqual([...assetDirs])              // 同一个目录，逐字节
})
