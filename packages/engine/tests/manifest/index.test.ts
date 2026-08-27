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

/**
 * 假存储。**readMeta 与 writeMeta 是同一份状态**——写进去的读得回来，没写过的读回
 * null——否则「内容没变就不重写」这条根本测不出来（读永远是空的话每轮都会写）。
 * 两端都走一次 JSON 序列化，与真实的 local.ts / nas.ts 同形。
 */
function fakeStorage() {
  const writes = new Map<string, unknown>()
  let writeCount = 0
  const clone = (d: unknown) => JSON.parse(JSON.stringify(d)) as unknown
  return {
    writes,
    /** 累计写入次数——`writes.size` 看不出「同一个路径被重写了一遍」 */
    writeCount: () => writeCount,
    writeMeta: async (rel: string, data: unknown) => { writeCount++; writes.set(rel, clone(data)) },
    readMeta: async (rel: string) => (writes.has(rel) ? clone(writes.get(rel)) : null),
  }
}

/** 假下载报回的「磁盘上的真实字节数」，按扩展名区分——每一条各自对上才算验过 */
const REAL_BYTES: Record<string, number> = { mp4: 205_818_547, txt: 4_096, m4a: 7_777, docx: 33 }
function realBytesOf(relPath: string): number {
  return REAL_BYTES[relPath.slice(relPath.lastIndexOf('.') + 1)] ?? 1
}

/** 真 store + 真 runExecutor + 假下载：让 target_path 由**真实的**拼路径逻辑产生 */
async function downloadAll(store: Store, bytesOf: (relPath: string) => number = realBytesOf): Promise<string[]> {
  const meetingsById = await store.meetingsForPaths()
  const relPaths: string[] = []
  const deps = {
    store, gw: {}, meetingsById,
    storage: { ensureFreeSpace: async () => true, writeMeta: async () => {} },
    // 与真 downloader 同规则：文本类算整文件 sha256，视频/音频不算（会吃爆内存）；
    // bytesWritten 是下载器完成那一刻的累加值 = 盘上的真实大小
    download: async (t: { relPath: string; isText: boolean }) => {
      relPaths.push(t.relPath)
      return { status: 'completed' as const, contentHash: t.isText ? TEXT_SHA : null, bytesWritten: bytesOf(t.relPath) }
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
    const storage = { readMeta: async () => null, writeMeta: async () => { throw new Error('nas gone') } }
    const meetingsById = await store.meetingsForPaths()

    const r = await writeMeetingManifests({ store, storage, generatedBy: 'mde-worker' }, meetingsById, () => 5000)

    expect(r).toEqual({ written: 0, unchanged: 0, skipped: 0, failed: 1 })   // 整轮正常返回，没有抛出
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

  expect(r).toEqual({ written: 1, unchanged: 0, skipped: 1, failed: 0 })   // m1 有资产、m2 没有
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

// ---------------------------------------------------------------------------
// bytes 字段：平台不给 bytes_expected 是**真实环境的常态**，不是边角情况。
// 2026-08-26 联调实测（docs/m3.5-stage8-9-plan.md §0.1 第 2 条）：腾讯对这批资产
// 一个 bytes_expected 都没返回，于是清单里的 bytes 全场为 null，字段形同虚设。
// ---------------------------------------------------------------------------

/** 与 seeded() 同形，但**一个 bytesExpected 都不给**——这才是真实环境的形态 */
async function seededWithoutExpectedBytes(): Promise<Store> {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting(MEETING, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'f-video-1', fileType: 'mp4' }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'f-sum-1', fileType: 'txt' }, 1)
  return store
}

test('平台不给 bytes_expected 时，bytes 回落到 completed 资产落盘的真实大小', async () => {
  const store = await seededWithoutExpectedBytes()
  await downloadAll(store)
  const storage = fakeStorage()

  await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  const manifest = storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile
  const byType = new Map(manifest.assets.map((a) => [a.assetType, a]))
  expect(byType.get('video')!.bytes).toBe(REAL_BYTES.mp4)             // 205,818,547：联调里那个录像的真实大小
  expect(byType.get('meeting_summary')!.bytes).toBe(REAL_BYTES.txt)
})

test('平台给了 bytes_expected 就仍然用它——它是被 downloader 校验过的那一个', async () => {
  const store = await seeded()          // bytesExpected = 1234 / 42
  await downloadAll(store)              // 而"落盘真实大小"是 205818547 / 4096
  const storage = fakeStorage()

  await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  const manifest = storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile
  const byType = new Map(manifest.assets.map((a) => [a.assetType, a]))
  expect(byType.get('video')!.bytes).toBe(1234)
  expect(byType.get('meeting_summary')!.bytes).toBe(42)
})

test('completed 但 bytes_written 是 0（本次改动之前完成的旧行）→ 如实写 null，不写「0 字节」这个谎', async () => {
  const store = await seededWithoutExpectedBytes()
  await downloadAll(store, () => 0)     // 旧行的形态：进度检查点一次都没触发过，列里留着默认值 0
  const storage = fakeStorage()

  await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  const manifest = storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile
  expect(manifest.assets.map((a) => a.bytes)).toEqual([null, null])
})

// ---------------------------------------------------------------------------
// 「内容没变就不重写」——2026-08-26 联调的第 4 条实测事实：资产一个都没重下，
// 但两个 JSON 每轮都被重写，`generatedAt` 每轮都变，于是文件哈希每轮都变、
// mtime 天天跳，同步到 NAS 时每轮重传。
// ---------------------------------------------------------------------------

test('第二轮内容一个字没变 → unchanged，一次都不写（generatedAt 也不许动）', async () => {
  const store = await seeded()
  await downloadAll(store)
  const storage = fakeStorage()

  expect(await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)).toBe('written')
  const afterFirst = storage.writeCount()

  expect(await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 9999)).toBe('unchanged')

  expect(storage.writeCount()).toBe(afterFirst)                 // 一次新的写都没发生
  // 盘上留着的仍是第一轮那份：generatedAt 还是 5000，文件哈希因此不变
  expect((storage.writes.get(`${DIR}/meeting.json`) as MeetingMetaFile).generatedAt).toBe(5000)
  expect((storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile).generatedAt).toBe(5000)
})

test('内容真的变了就写，且只写变了的那个文件', async () => {
  const store = await seeded()
  await downloadAll(store)
  const storage = fakeStorage()
  await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)
  const afterFirst = storage.writeCount()

  // 新下完一个资产：_manifest.json 的 assets 多一条，meeting.json 一个字没变
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', remoteId: 'f-audio-1', fileType: 'm4a' }, 1)
  await downloadAll(store)

  expect(await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 9999)).toBe('written')

  expect(storage.writeCount()).toBe(afterFirst + 1)             // 只多了一次写
  expect((storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile).generatedAt).toBe(9999)
  expect((storage.writes.get(`${DIR}/meeting.json`) as MeetingMetaFile).generatedAt).toBe(5000)   // 没被顺手重写
  expect((storage.writes.get(`${DIR}/_manifest.json`) as ManifestFile).assets).toHaveLength(3)
})

test('生成方换了（mde-engine → mde-worker）算内容变了，要重写', async () => {
  const store = await seeded()
  await downloadAll(store)
  const storage = fakeStorage()
  await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

  expect(await writeMeetingManifest({ store, storage, generatedBy: 'mde-worker' }, 'm1', '', 9999)).toBe('written')
  expect((storage.writes.get(`${DIR}/meeting.json`) as MeetingMetaFile).generatedBy).toBe('mde-worker')
})

test('读不回已有文件（存储抛错）→ 落到"要写"这一侧，并留下带原因的 warn', async () => {
  const store = await seeded()
  await downloadAll(store)
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const base = fakeStorage()
    const storage = { ...base, readMeta: async () => { throw new Error('EACCES: permission denied') } }

    const r = await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)

    expect(r).toBe('written')                                   // 判断不了 → 写，不是跳过
    expect(base.writeCount()).toBe(2)
    const said = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(said).toContain('_manifest.json')                    // 是哪个文件
    expect(said).toContain('EACCES: permission denied')         // 因为什么——可回溯，不是静默吞掉
  } finally {
    warnSpy.mockRestore()
  }
})

test('文件还不存在（首写）不是异常：照写，且不 warn', async () => {
  const store = await seeded()
  await downloadAll(store)
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const storage = fakeStorage()
    expect(await writeMeetingManifest({ store, storage, generatedBy: 'mde-engine' }, 'm1', '', 5000)).toBe('written')
    expect(warnSpy).not.toHaveBeenCalled()
  } finally {
    warnSpy.mockRestore()
  }
})

test('一轮收尾：unchanged 单独计数，不混进 written', async () => {
  const store = await seeded()
  await store.upsertMeeting({ ...MEETING, meetingId: 'm2', meetingCode: '882-000-00', subject: '没下过东西的会' }, 1)
  await downloadAll(store)
  const storage = fakeStorage()
  const meetings = await store.meetingsForPaths()

  const first = await writeMeetingManifests({ store, storage, generatedBy: 'mde-worker' }, meetings, () => 5000)
  const second = await writeMeetingManifests({ store, storage, generatedBy: 'mde-worker' }, meetings, () => 9999)

  expect(first).toEqual({ written: 1, unchanged: 0, skipped: 1, failed: 0 })
  expect(second).toEqual({ written: 0, unchanged: 1, skipped: 1, failed: 0 })
})
