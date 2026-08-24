import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { RowDataPacket } from 'mysql2'
import { requireTestDatabaseUrl, withTestDb } from '../helpers/testdb'
import { createArchivesStore, type ArchivesStore } from '../../src/store/archives'
import { createPool, type Pool } from '../../src/store/db'
import { executeCleanup, previewCleanup, type CleanupItem, type RetentionDeps } from '../../src/worker/retention'

/**
 * 这是全系统唯一执行不可逆删除的代码，所以这里不 mock 文件系统、不 mock 哈希：
 * 本地根目录与 NAS 根目录都是真实的临时目录，"篡改 NAS 上的文件"就是真的去改那个
 * 文件的字节。dev-plan.md §6 那三条硬要求要证明的都是运行期的真实行为
 * （文件真的还在不在、哈希真的重新算了没有、开关真的落库了没有），
 * 用替身证明不了其中任何一条。
 */

const DAY = 86_400
/** 2026-06-01T00:00:00Z——手算的整数秒，好让下面每个 now 都能心算复核 */
const ARCHIVED_AT = Date.UTC(2026, 5, 1) / 1000

async function realSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function sha256OfString(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function writeFileAt(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, content)
}

interface Rig {
  pool: Pool
  localRoot: string
  nasRoot: string
  archives: ArchivesStore
  deps: RetentionDeps
}

async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  const localRoot = await mkdtemp(join(tmpdir(), 'mde-retention-local-'))
  const nasRoot = await mkdtemp(join(tmpdir(), 'mde-retention-nas-'))
  const archives = createArchivesStore(pool)
  try {
    await fn({ pool, localRoot, nasRoot, archives, deps: { archives, localRoot } })
  } finally {
    await rm(localRoot, { recursive: true, force: true })
    await rm(nasRoot, { recursive: true, force: true })
    await cleanup()
  }
}

/**
 * 另开一个连接池指向同一个测试库。用例 3 靠它模拟"另一个进程"——新池意味着新连接，
 * 不共享任何会话状态，也不共享调用方手里那个 store 实例。
 */
async function withFreshPool(pool: Pool, fn: (fresh: Pool) => Promise<void>): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT DATABASE() AS db')
  const dbName = String(rows[0]?.db)
  const url = new URL(requireTestDatabaseUrl())
  url.pathname = `/${dbName}`
  const fresh = createPool(url.toString())
  try {
    await fn(fresh)
  } finally {
    await fresh.end()
  }
}

/**
 * 包一层只为数"这场会议的归档资产被列出来过几次"。executeCleanup 里所有会触达
 * 文件的动作（重算哈希、删本地文件）都以这一步为前提，所以计数为 0 等价于
 * "这一轮一个文件都没碰"——用例 2 需要证明的正是这件事。
 */
function countingStore(inner: ArchivesStore): { store: ArchivesStore; listCalls: () => number } {
  let listCalls = 0
  return {
    store: {
      ...inner,
      listArchivedAssetsForMeeting: (meetingId: string, subMeetingId: string) => {
        listCalls++
        return inner.listArchivedAssetsForMeeting(meetingId, subMeetingId)
      },
    },
    listCalls: () => listCalls,
  }
}

interface SeedAsset {
  targetPath: string
  content: string
  assetType?: string
  remoteId?: string
  fileType?: string
}

interface SeedMeeting {
  meetingId: string
  subMeetingId?: string
  assets: SeedAsset[]
  /** 只写 meeting_assets（completed）与本地文件，**不**写 archived_assets——
   *  模拟"整场会议归档完之后又有资产下载完、但还没归档成功"的中间态 */
  completedOnly?: SeedAsset[]
  archivedAt?: number
  retentionDays?: number
  extendDays?: number
}

interface SeededAsset {
  localPath: string
  nasPath: string
  content: string
  bytes: number
}

interface SeededMeeting {
  nasDir: string
  assets: SeededAsset[]
  /** 与 SeedMeeting.completedOnly 对应，只有本地那一份 */
  completedOnly: Array<{ localPath: string; content: string; bytes: number }>
  totalBytes: number
}

/**
 * 造出"Task 7 已经归档完、还在本地保留期里"的完整现场：本地一份文件、NAS 一份
 * 同样内容的文件、meeting_assets 里一行 completed（带真实 bytes_written）、
 * archived_assets 里一行（nas_hash 是真的去读 NAS 那份文件算出来的，不是抄本地
 * 内容凑的）、meeting_archives 里一行保留窗口。
 *
 * 用 store 的公开方法写而不是手写 INSERT（meeting_assets 除外——那张表不归
 * ArchivesStore 写），是为了让"延长保留"这类动作走的是真实代码路径：用例 7 里的
 * extended_days 就是 extendRetention 累加出来的，不是测试直接塞进去的数。
 */
async function seedArchivedMeeting(rig: Rig, input: SeedMeeting): Promise<SeededMeeting> {
  const {
    meetingId,
    subMeetingId = '',
    assets,
    completedOnly = [],
    archivedAt = ARCHIVED_AT,
    retentionDays = 30,
    extendDays = 0,
  } = input
  const nasDir = join(rig.nasRoot, 'archive', subMeetingId ? `${meetingId}_${subMeetingId}` : meetingId)
  const seeded: SeededAsset[] = []

  const insertCompleted = async (a: SeedAsset, assetType: string, remoteId: string, fileType: string, bytes: number) =>
    rig.pool.execute(
      `INSERT INTO meeting_assets
         (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, bytes_written, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      [meetingId, subMeetingId, assetType, remoteId, fileType, a.targetPath, bytes, archivedAt, archivedAt],
    )

  for (const [i, a] of assets.entries()) {
    const assetType = a.assetType ?? 'video'
    const remoteId = a.remoteId ?? `r-${i + 1}`
    const fileType = a.fileType ?? 'mp4'
    const localPath = join(rig.localRoot, a.targetPath)
    const nasPath = join(nasDir, a.targetPath)
    const bytes = Buffer.byteLength(a.content)

    await writeFileAt(localPath, a.content)
    await writeFileAt(nasPath, a.content)
    await insertCompleted(a, assetType, remoteId, fileType, bytes)
    await rig.archives.recordArchivedAsset({
      meetingId,
      subMeetingId,
      assetType,
      remoteId,
      fileType,
      localPath: a.targetPath,
      nasPath,
      nasHash: await realSha256(nasPath),
      archivedAt,
    })
    seeded.push({ localPath, nasPath, content: a.content, bytes })
  }

  const seededCompletedOnly: SeededMeeting['completedOnly'] = []
  for (const [i, a] of completedOnly.entries()) {
    const localPath = join(rig.localRoot, a.targetPath)
    const bytes = Buffer.byteLength(a.content)
    await writeFileAt(localPath, a.content)
    await insertCompleted(a, a.assetType ?? 'chat', a.remoteId ?? `late-${i + 1}`, a.fileType ?? 'txt', bytes)
    seededCompletedOnly.push({ localPath, content: a.content, bytes })
  }

  await rig.archives.upsertMeetingArchive({ meetingId, subMeetingId, nasDir, archivedAt, retentionDays, now: archivedAt })
  if (extendDays > 0) await rig.archives.extendRetention(meetingId, subMeetingId, extendDays, archivedAt)

  return {
    nasDir,
    assets: seeded,
    completedOnly: seededCompletedOnly,
    totalBytes: seeded.reduce((sum, a) => sum + a.bytes, 0),
  }
}

function byMeetingId(items: CleanupItem[]): CleanupItem[] {
  return [...items].sort((a, b) => a.meetingId.localeCompare(b.meetingId))
}

async function expectIntact(assets: SeededAsset[]): Promise<void> {
  for (const a of assets) {
    expect(await readFile(a.localPath, 'utf8')).toBe(a.content)
    expect(await readFile(a.nasPath, 'utf8')).toBe(a.content)
  }
}

test('用例1：previewCleanup 是纯预览——报得出候选与真实字节数，但一个文件、一行记录都不动', async () => {
  await withRig(async (rig) => {
    const a = await seedArchivedMeeting(rig, {
      meetingId: 'm-expired-a',
      archivedAt: ARCHIVED_AT,
      retentionDays: 30,
      assets: [
        { targetPath: 'a/video.mp4', content: 'a-video-bytes', assetType: 'video', remoteId: 'r-a1', fileType: 'mp4' },
        { targetPath: 'a/summary.txt', content: 'a-summary', assetType: 'meeting_summary', remoteId: 'r-a2', fileType: 'txt' },
      ],
    })
    const b = await seedArchivedMeeting(rig, {
      meetingId: 'm-expired-b',
      archivedAt: ARCHIVED_AT + DAY,
      retentionDays: 30,
      assets: [
        { targetPath: 'b/video.mp4', content: 'b-video-bytes-noticeably-longer', assetType: 'video', remoteId: 'r-b1', fileType: 'mp4' },
      ],
    })
    const now = ARCHIVED_AT + 40 * DAY // 两场都过了 30 天保留期

    const preview = await previewCleanup(rig.deps, now)

    expect(preview.dryRun).toBe(true)
    expect(byMeetingId(preview.items)).toEqual([
      { meetingId: 'm-expired-a', subMeetingId: '', assetCount: 2, localBytes: a.totalBytes },
      { meetingId: 'm-expired-b', subMeetingId: '', assetCount: 1, localBytes: b.totalBytes },
    ])
    expect(preview.totalBytes).toBe(a.totalBytes + b.totalBytes)
    // 上面两条断言若拿 0 去比 0 也会通过，所以这里钉住"被比较的是真实字节数"：
    // localBytes 报的是 meeting_assets.bytes_written 之和，两场会议数值还不一样。
    expect(a.totalBytes).toBeGreaterThan(0)
    expect(b.totalBytes).not.toBe(a.totalBytes)

    // 预览之后：本地文件、NAS 文件、archived_assets、local_purged_at 全部原样
    await expectIntact([...a.assets, ...b.assets])
    expect((await rig.archives.listArchivedAssetsForMeeting('m-expired-a', '')).length).toBe(2)
    expect((await rig.archives.listArchivedAssetsForMeeting('m-expired-b', '')).length).toBe(1)
    expect((await rig.archives.findMeetingArchive('m-expired-a', ''))?.localPurgedAt).toBeNull()
    expect((await rig.archives.findMeetingArchive('m-expired-b', ''))?.localPurgedAt).toBeNull()
  })
})

test('用例2：cleanup_paused=1 时 executeCleanup 直接返回 paused，连资产列表都不查；改回 0 才真删', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-paused',
      assets: [{ targetPath: 'p/video.mp4', content: 'paused-meeting-bytes' }],
    })
    const now = ARCHIVED_AT + 40 * DAY
    await rig.archives.setSetting('cleanup_paused', '1', now)

    const spy = countingStore(rig.archives)
    const paused = await executeCleanup({ archives: spy.store, localRoot: rig.localRoot }, now, true)

    expect(paused).toEqual({ dryRun: false, paused: true, purged: [], verificationFailed: [], failed: [] })
    // 删文件、重算哈希都要先列出这场会议的归档资产——这一步压根没发生
    expect(spy.listCalls()).toBe(0)
    await expectIntact(m.assets)
    expect((await rig.archives.findMeetingArchive('m-paused', ''))?.localPurgedAt).toBeNull()

    // 把开关改回 '0'（不是删掉这一行）之后才恢复清理——证明挡住删除的确实是开关，
    // 而不是这场会议本来就不该被删
    await rig.archives.setSetting('cleanup_paused', '0', now)
    const resumed = await executeCleanup(rig.deps, now, true)

    expect(resumed.paused).toBe(false)
    expect(resumed.purged.map((i) => i.meetingId)).toEqual(['m-paused'])
    expect(await exists(m.assets[0]!.localPath)).toBe(false)
    expect((await rig.archives.findMeetingArchive('m-paused', ''))?.localPurgedAt).toBe(now)
  })
})

test('用例3：暂停开关持久化在 system_settings——一个连接池写、另一个全新连接池 + 全新 store 读，仍然是暂停', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-restart',
      assets: [{ targetPath: 'r/video.mp4', content: 'restart-meeting-bytes' }],
    })
    const now = ARCHIVED_AT + 40 * DAY

    // 先在"未暂停"状态下完整跑一遍真删路径（此刻还没到期，没有候选，不会删任何东西）。
    // 若暂停状态被缓存在进程内（模块级变量、store 实例上的字段），这一轮会把
    // "未暂停"记住，后面那轮就看不到别的进程刚写下的暂停——这条用例要的就是让
    // 那种实现红掉，而不是只证明"我刚写的值我自己读得到"。
    const beforePause = await executeCleanup(rig.deps, ARCHIVED_AT + DAY, true)
    expect(beforePause.paused).toBe(false)
    expect(beforePause.purged).toEqual([])

    // 暂停开关由另一个连接池写入——现实里按下开关的是控制台 API 那个进程，
    // 不是 worker 自己
    await withFreshPool(rig.pool, async (writer) => {
      await createArchivesStore(writer).setSetting('cleanup_paused', '1', now)
    })

    // worker 侧"重启"：全新连接池、全新 store，没有任何进程内状态可继承
    await withFreshPool(rig.pool, async (restarted) => {
      const store = createArchivesStore(restarted)
      expect(await store.getSetting('cleanup_paused')).toBe('1')
      const result = await executeCleanup({ archives: store, localRoot: rig.localRoot }, now, true)
      expect(result).toEqual({ dryRun: false, paused: true, purged: [], verificationFailed: [], failed: [] })
    })

    // 那个从头到尾没换过的 store 同样看得到——开关不在任何一个实例里
    expect((await executeCleanup(rig.deps, now, true)).paused).toBe(true)

    // 已经到期的会议，两轮下来一个文件都没被删
    await expectIntact(m.assets)
    expect((await rig.archives.findMeetingArchive('m-restart', ''))?.localPurgedAt).toBeNull()
  })
})

test('用例4：删前当场重新校验哈希——NAS 上文件被外部改过（nas_hash 记录仍是旧值）时整场会议拒删', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-tampered',
      assets: [
        { targetPath: 't/notes.txt', content: 'notes stay intact', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' },
        { targetPath: 't/video.mp4', content: 'original video bytes', assetType: 'video', remoteId: 'r-2', fileType: 'mp4' },
      ],
    })
    const now = ARCHIVED_AT + 40 * DAY

    // 挑 executeCleanup 会**最后**校验到的那个资产下手，这样一个"边校验边删"的实现
    // 必然已经把排在前面的那个本地文件删掉了，会被下面"整场都不许删"的断言抓住
    // （变异验证过）。顺序照 store 实际返回的来问，不假设 listArchivedAssetsForMeeting
    // 没有 ORDER BY 时的隐式顺序——那不是这条查询的契约。
    const ordered = await rig.archives.listArchivedAssetsForMeeting('m-tampered', '')
    expect(ordered.length).toBe(2)
    const tampered = m.assets.find((a) => a.nasPath === ordered[ordered.length - 1]!.nasPath)!

    // 改的是 NAS 上那份文件的字节，库里的 archived_assets.nas_hash 一个字都不动——
    // 这就是"归档时校验过一次"与"现在还一致"之间那几十天里可能发生的事
    await writeFile(tampered.nasPath, 'externally modified on the NAS long after archiving')
    const recorded = ordered.find((a) => a.nasPath === tampered.nasPath)!
    expect(recorded.nasHash).toBe(sha256OfString(tampered.content)) // 记录还是归档当时的旧值
    expect(await realSha256(tampered.nasPath)).not.toBe(recorded.nasHash) // 文件已经不是那一份了

    const result = await executeCleanup(rig.deps, now, true)

    expect(result.purged).toEqual([])
    expect(result.verificationFailed.length).toBe(1)
    expect(result.verificationFailed[0]!.meetingId).toBe('m-tampered')
    expect(result.verificationFailed[0]!.subMeetingId).toBe('')
    // 原因要指得出是哪个文件，否则"需要人工介入"无从下手
    expect(result.verificationFailed[0]!.reason).toContain(tampered.nasPath)

    // 整场会议一个本地文件都不许删——包括哈希本来没问题的那个
    for (const a of m.assets) expect(await readFile(a.localPath, 'utf8')).toBe(a.content)
    expect((await rig.archives.findMeetingArchive('m-tampered', ''))?.localPurgedAt).toBeNull()
    expect((await rig.archives.listArchivedAssetsForMeeting('m-tampered', '')).length).toBe(2)
  })
})

test('用例4b：NAS 上那份文件读不到（被移走 / 挂载掉线）时同样拒删，不是"读不到就当它没问题"', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-nas-gone',
      assets: [
        { targetPath: 'g/notes.txt', content: 'notes on nas', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' },
        { targetPath: 'g/video.mp4', content: 'video on nas', assetType: 'video', remoteId: 'r-2', fileType: 'mp4' },
      ],
    })
    const now = ARCHIVED_AT + 40 * DAY
    const ordered = await rig.archives.listArchivedAssetsForMeeting('m-nas-gone', '')
    const missing = m.assets.find((a) => a.nasPath === ordered[ordered.length - 1]!.nasPath)!
    await rm(missing.nasPath)

    const result = await executeCleanup(rig.deps, now, true)

    expect(result.purged).toEqual([])
    expect(result.verificationFailed.length).toBe(1)
    expect(result.verificationFailed[0]!.meetingId).toBe('m-nas-gone')
    expect(result.verificationFailed[0]!.reason).toContain(missing.nasPath)

    // NAS 上少了一份，本地这两份就更不能删——本地是它现在仅剩的副本
    for (const a of m.assets) expect(await readFile(a.localPath, 'utf8')).toBe(a.content)
    expect((await rig.archives.findMeetingArchive('m-nas-gone', ''))?.localPurgedAt).toBeNull()
  })
})

test('用例5：哈希一致时正常清理——只删本地文件，NAS 文件与数据库记录都留着', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-purge',
      archivedAt: ARCHIVED_AT,
      retentionDays: 30,
      assets: [
        { targetPath: 'q/video.mp4', content: 'purge-me-video-bytes', assetType: 'video', remoteId: 'r-1', fileType: 'mp4' },
        { targetPath: 'q/notes.txt', content: 'purge-me-notes', assetType: 'meeting_summary', remoteId: 'r-2', fileType: 'txt' },
      ],
    })
    const now = ARCHIVED_AT + 40 * DAY
    const archiveBefore = await rig.archives.findMeetingArchive('m-purge', '')
    const assetsBefore = await rig.archives.listArchivedAssetsForMeeting('m-purge', '')
    const completedBefore = await rig.archives.listCompletedAssets('m-purge', '')

    const result = await executeCleanup(rig.deps, now, true)

    expect(result.dryRun).toBe(false)
    expect(result.paused).toBe(false)
    expect(result.verificationFailed).toEqual([])
    expect(result.purged).toEqual([{ meetingId: 'm-purge', subMeetingId: '', assetCount: 2, localBytes: m.totalBytes }])
    expect(m.totalBytes).toBeGreaterThan(0)

    // 本地：删干净
    for (const a of m.assets) expect(await exists(a.localPath)).toBe(false)
    // NAS：一个字节都没动（本地删了之后，NAS 那份就是唯一副本）
    for (const a of m.assets) expect(await readFile(a.nasPath, 'utf8')).toBe(a.content)
    // 数据库记录永久保留（spec §4.9）：meeting_archives 这一行还在，且只多了
    // local_purged_at 一个变化——nas_dir / archived_at / retention_days /
    // extended_days 都得原样，不能被清理动作顺手改掉
    expect(await rig.archives.findMeetingArchive('m-purge', '')).toEqual({ ...archiveBefore!, localPurgedAt: now })
    // archived_assets 里的 NAS 路径与哈希也都还在（历史会议要靠它去 NAS 取）
    expect(await rig.archives.listArchivedAssetsForMeeting('m-purge', '')).toEqual(assetsBefore)
    // meeting_assets 是只读历史事实，清理不许碰
    expect(await rig.archives.listCompletedAssets('m-purge', '')).toEqual(completedBefore)

    // 清理过的会议不会被下一轮再处理一遍（local_purged_at 已经非 NULL）
    const second = await executeCleanup(rig.deps, now + DAY, true)
    expect(second.purged).toEqual([])
    expect(second.verificationFailed).toEqual([])
  })
})

test('用例6：还没到期的会议不进候选——预览列不出、真删也不碰；过了到期那一刻同一场才出现', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-fresh',
      archivedAt: ARCHIVED_AT,
      retentionDays: 30,
      assets: [{ targetPath: 'f/video.mp4', content: 'still-within-retention' }],
    })
    const expiry = ARCHIVED_AT + 30 * DAY

    // 还差 10 天
    expect((await previewCleanup(rig.deps, expiry - 10 * DAY)).items).toEqual([])
    // 边界：正好走到到期那一秒还不算"已过期"。不可逆删除在边界上偏晚一秒，
    // 不偏早一秒。
    expect((await previewCleanup(rig.deps, expiry)).items).toEqual([])
    const atExpiry = await executeCleanup(rig.deps, expiry, true)
    expect(atExpiry.purged).toEqual([])
    expect(atExpiry.verificationFailed).toEqual([])
    await expectIntact(m.assets)
    expect((await rig.archives.findMeetingArchive('m-fresh', ''))?.localPurgedAt).toBeNull()

    // 过了这一秒就该出现在候选里——否则上面那几条"空列表"也可能只是因为这场会议
    // 压根没被查出来（比如查询条件写错），空得毫无意义
    expect((await previewCleanup(rig.deps, expiry + 1)).items.map((i) => i.meetingId)).toEqual(['m-fresh'])
  })
})

test('用例7：extendedDays 把到期日往后推——延长过的会议不进候选，到了延长后的日子才进', async () => {
  await withRig(async (rig) => {
    const extended = await seedArchivedMeeting(rig, {
      meetingId: 'm-extended',
      archivedAt: ARCHIVED_AT,
      retentionDays: 30,
      extendDays: 30, // 走 extendRetention 真实累加出来的 extended_days
      assets: [{ targetPath: 'e/video.mp4', content: 'extended-by-30-days' }],
    })
    // 对照组：同一天归档、同样 30 天保留期，没有延长过
    const plain = await seedArchivedMeeting(rig, {
      meetingId: 'm-not-extended',
      archivedAt: ARCHIVED_AT,
      retentionDays: 30,
      assets: [{ targetPath: 'n/video.mp4', content: 'no-extension' }],
    })
    const now = ARCHIVED_AT + 45 * DAY // 只按 retentionDays 算，两场都该到期了

    expect((await previewCleanup(rig.deps, now)).items.map((i) => i.meetingId)).toEqual(['m-not-extended'])

    const result = await executeCleanup(rig.deps, now, true)
    expect(result.purged.map((i) => i.meetingId)).toEqual(['m-not-extended'])
    expect(result.verificationFailed).toEqual([])
    expect(await exists(plain.assets[0]!.localPath)).toBe(false)

    // 延长的那一场：本地文件与保留窗口都原样
    await expectIntact(extended.assets)
    expect((await rig.archives.findMeetingArchive('m-extended', ''))?.localPurgedAt).toBeNull()

    // 延长只是把日子往后推，不是永久豁免——60 天之后它同样到期
    expect((await previewCleanup(rig.deps, ARCHIVED_AT + 61 * DAY)).items.map((i) => i.meetingId)).toEqual([
      'm-extended',
    ])
  })
})

test('用例4c：NAS 读得太久（注入一个小超时模拟挂住的挂载）时拒删——超时不等于"文件没问题"', async () => {
  await withRig(async (rig) => {
    // 16MB：流式 sha256 至少要十几毫秒，对着 1ms 的超时必然先超时。用真实的大文件
    // 而不是 0 字节配 0ms，是为了让这条用例不依赖"定时器和第一个 I/O 回调谁先跑"
    // 这种没有保证的竞速。
    const big = 'x'.repeat(16 * 1024 * 1024)
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-slow-nas',
      assets: [{ targetPath: 's/video.mp4', content: big }],
    })
    const now = ARCHIVED_AT + 40 * DAY

    const result = await executeCleanup({ ...rig.deps, nasReadTimeoutMs: 1 }, now, true)

    expect(result.purged).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.verificationFailed.length).toBe(1)
    expect(result.verificationFailed[0]!.meetingId).toBe('m-slow-nas')
    expect(result.verificationFailed[0]!.reason).toContain('timed out')
    expect(result.verificationFailed[0]!.reason).toContain(m.assets[0]!.nasPath)
    await expectIntact(m.assets)
    expect((await rig.archives.findMeetingArchive('m-slow-nas', ''))?.localPurgedAt).toBeNull()

    // 同一场会议，超时给够就正常删得掉——证明上面拒删的原因确实是"读得太久"，
    // 而不是这条数据本身有问题
    const ok = await executeCleanup(rig.deps, now, true)
    expect(ok.verificationFailed).toEqual([])
    expect(ok.purged.map((i) => i.meetingId)).toEqual(['m-slow-nas'])
  })
}, 30_000)

test('用例8：轮次跑到一半被按下暂停——立刻停止处理后续候选，已经删掉的那些如实留在 purged 里', async () => {
  await withRig(async (rig) => {
    // 两场都到期，listExpiredUnpurged 按 archived_at ASC 排（那条查询显式写了
    // ORDER BY），所以 m-first 先被处理
    const first = await seedArchivedMeeting(rig, {
      meetingId: 'm-first',
      archivedAt: ARCHIVED_AT,
      assets: [{ targetPath: 'i/first.mp4', content: 'first meeting bytes' }],
    })
    const second = await seedArchivedMeeting(rig, {
      meetingId: 'm-second',
      archivedAt: ARCHIVED_AT + DAY,
      assets: [{ targetPath: 'i/second.mp4', content: 'second meeting bytes' }],
    })
    const now = ARCHIVED_AT + 40 * DAY

    // 操作员在第一场刚清理完的那一刻按下暂停：包一层 store，在 markLocalPurged
    // 落库之后把开关写成 '1'。这模拟的是"一轮跑了很久，中途有人按了暂停"，
    // 而不是"开轮之前就是暂停"。
    let listCalls = 0
    const flipping: ArchivesStore = {
      ...rig.archives,
      listArchivedAssetsForMeeting: (meetingId: string, subMeetingId: string) => {
        listCalls++
        return rig.archives.listArchivedAssetsForMeeting(meetingId, subMeetingId)
      },
      markLocalPurged: async (meetingId: string, subMeetingId: string, ts: number) => {
        await rig.archives.markLocalPurged(meetingId, subMeetingId, ts)
        if (meetingId === 'm-first') await rig.archives.setSetting('cleanup_paused', '1', ts)
      },
    }

    const result = await executeCleanup({ archives: flipping, localRoot: rig.localRoot }, now, true)

    expect(result.paused).toBe(true)
    // 后续候选是"没被处理"，不是"处理到一半才发现暂停"：开关是在每个候选**之前**
    // 查的，所以第二场连资产清单都没去列，更不会为它重算一遍 NAS 哈希——那正是
    // 让一轮耗时无界的那部分工作。只查了一次 = 只处理了 m-first。
    expect(listCalls).toBe(1)
    // 已经发生的删除如实上报，不因为随后按下暂停就说成没发生
    expect(result.purged.map((i) => i.meetingId)).toEqual(['m-first'])
    expect(result.verificationFailed).toEqual([])
    expect(result.failed).toEqual([])

    // 第一场：删了、记了
    expect(await exists(first.assets[0]!.localPath)).toBe(false)
    expect((await rig.archives.findMeetingArchive('m-first', ''))?.localPurgedAt).toBe(now)
    // 第二场：一个文件都没碰，也没被标记——它留给下一轮
    await expectIntact(second.assets)
    expect((await rig.archives.findMeetingArchive('m-second', ''))?.localPurgedAt).toBeNull()
    expect((await previewCleanup(rig.deps, now)).items.map((i) => i.meetingId)).toEqual(['m-second'])
  })
})

test('用例8b：开关在某场会议的哈希校验期间被按下——这场会议校验白跑也不删，留给下一轮', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-mid-verify',
      assets: [{ targetPath: 'v/video.mp4', content: 'bytes being verified when pause is pressed' }],
    })
    const now = ARCHIVED_AT + 40 * DAY

    // 在这场会议刚被取出资产清单、还没校验完的时候按下暂停：listArchivedAssetsForMeeting
    // 是 cleanupOneMeeting 的第一步，紧接着才是那串可能跑很久的流式哈希。
    const flipping: ArchivesStore = {
      ...rig.archives,
      listArchivedAssetsForMeeting: async (meetingId: string, subMeetingId: string) => {
        const rows = await rig.archives.listArchivedAssetsForMeeting(meetingId, subMeetingId)
        await rig.archives.setSetting('cleanup_paused', '1', now)
        return rows
      },
    }

    const result = await executeCleanup({ archives: flipping, localRoot: rig.localRoot }, now, true)

    expect(result.paused).toBe(true)
    expect(result.purged).toEqual([])
    // 既不算校验失败，也不算处理失败——它只是没轮到删
    expect(result.verificationFailed).toEqual([])
    expect(result.failed).toEqual([])
    await expectIntact(m.assets)
    expect((await rig.archives.findMeetingArchive('m-mid-verify', ''))?.localPurgedAt).toBeNull()
  })
})

test('用例9：一场会议删除时抛出，不连累同一轮里排在它后面的会议，且计入 failed', async () => {
  await withRig(async (rig) => {
    // 会抛出的那场排在最前（archived_at 最早）——正是"卡住队首"的形状：
    // 不做隔离的话，后面两场不是"下一轮重试"，是永远轮不到
    const bad = await seedArchivedMeeting(rig, {
      meetingId: 'm-rm-throws',
      archivedAt: ARCHIVED_AT,
      assets: [{ targetPath: 'x/video.mp4', content: 'cannot be removed' }],
    })
    const ok1 = await seedArchivedMeeting(rig, {
      meetingId: 'm-after-1',
      archivedAt: ARCHIVED_AT + DAY,
      assets: [{ targetPath: 'y/video.mp4', content: 'after one' }],
    })
    const ok2 = await seedArchivedMeeting(rig, {
      meetingId: 'm-after-2',
      archivedAt: ARCHIVED_AT + 2 * DAY,
      assets: [{ targetPath: 'z/video.mp4', content: 'after two' }],
    })
    const now = ARCHIVED_AT + 40 * DAY

    // 把第一场的本地路径换成一个目录：rm(path, { force: true }) 对目录会抛
    // （force 只吃 ENOENT，不吃"这是个目录"），于是删除真的失败——不需要往生产
    // 代码里开一个只为测试存在的注入点。具体 errno 各平台/运行时不一样，所以
    // 下面只断言"这场会议进了 failed 且带了原因"，不断言错误文本。
    await rm(bad.assets[0]!.localPath)
    await mkdir(bad.assets[0]!.localPath, { recursive: true })

    const result = await executeCleanup(rig.deps, now, true)

    expect(result.paused).toBe(false)
    expect(result.verificationFailed).toEqual([])
    expect(result.failed.length).toBe(1)
    expect(result.failed[0]!.meetingId).toBe('m-rm-throws')
    expect(result.failed[0]!.reason.length).toBeGreaterThan(0)

    // 排在它后面的两场照常清理完毕
    expect(result.purged.map((i) => i.meetingId)).toEqual(['m-after-1', 'm-after-2'])
    expect(await exists(ok1.assets[0]!.localPath)).toBe(false)
    expect(await exists(ok2.assets[0]!.localPath)).toBe(false)
    expect((await rig.archives.findMeetingArchive('m-after-1', ''))?.localPurgedAt).toBe(now)
    expect((await rig.archives.findMeetingArchive('m-after-2', ''))?.localPurgedAt).toBe(now)

    // 失败的那场没有被标记成已清理——下一轮还会重新处理它
    expect((await rig.archives.findMeetingArchive('m-rm-throws', ''))?.localPurgedAt).toBeNull()
    expect(await readFile(bad.assets[0]!.nasPath, 'utf8')).toBe(bad.assets[0]!.content)
  })
})

test('用例10：confirm 不是 true 时当场抛出，一个文件都不碰（类型系统之外的运行期栅栏）', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-no-confirm',
      assets: [{ targetPath: 'c/video.mp4', content: 'must not be deleted without confirm' }],
    })
    const now = ARCHIVED_AT + 40 * DAY

    // `as unknown as true` 模拟的是类型检查被绕过（强转、或者从没有类型的地方调进来）
    await expect(executeCleanup(rig.deps, now, false as unknown as true)).rejects.toThrow(/confirm/)
    await expect(executeCleanup(rig.deps, now, undefined as unknown as true)).rejects.toThrow(/confirm/)

    await expectIntact(m.assets)
    expect((await rig.archives.findMeetingArchive('m-no-confirm', ''))?.localPurgedAt).toBeNull()

    // 同样这场会议，confirm 给对了就删得掉——证明上面拦下来的是 confirm，不是别的
    expect((await executeCleanup(rig.deps, now, true)).purged.map((i) => i.meetingId)).toEqual(['m-no-confirm'])
  })
})

test('用例11：cleanup_paused 里出现认不出来的值时按"暂停"处理，不是按"没暂停"继续删', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-garbled-flag',
      assets: [{ targetPath: 'w/video.mp4', content: 'flag says something unparseable' }],
    })
    const now = ARCHIVED_AT + 40 * DAY

    // 不是 '1' 也不是 '0'——可能是别的工具写坏的，也可能是有人手写了 'true'
    await rig.archives.setSetting('cleanup_paused', 'true', now)
    const garbled = await executeCleanup(rig.deps, now, true)
    expect(garbled.paused).toBe(true)
    expect(garbled.purged).toEqual([])
    await expectIntact(m.assets)

    // 写成明确的 '0' 才真删——上面那条不是"任何值都暂停"的哑实现
    await rig.archives.setSetting('cleanup_paused', '0', now)
    expect((await executeCleanup(rig.deps, now, true)).purged.map((i) => i.meetingId)).toEqual(['m-garbled-flag'])
  })
})

test('用例12：还没归档成功的资产不算进 localBytes，也不会被清理删掉（两张表不重合的那种中间态）', async () => {
  await withRig(async (rig) => {
    const m = await seedArchivedMeeting(rig, {
      meetingId: 'm-late-asset',
      assets: [{ targetPath: 'l/video.mp4', content: 'archived and will be purged', assetType: 'video', remoteId: 'r-1', fileType: 'mp4' }],
      // 迟到的 AI 纪要：下载完了、meeting_assets 里是 completed，但还没进
      // archived_assets（还没归档成功）。它的本地文件不归本轮清理管。
      completedOnly: [
        { targetPath: 'l/late-summary.txt', content: 'downloaded later, not archived yet — noticeably longer than the other one', assetType: 'meeting_summary', remoteId: 'r-late', fileType: 'txt' },
      ],
    })
    const now = ARCHIVED_AT + 40 * DAY
    const late = m.completedOnly[0]!
    expect(late.bytes).toBeGreaterThan(0)

    // 预览报的"能腾出多少空间"只数真会被删的那一个，不把迟到那个的字节数虚报进来
    const preview = await previewCleanup(rig.deps, now)
    expect(preview.items).toEqual([
      { meetingId: 'm-late-asset', subMeetingId: '', assetCount: 1, localBytes: m.totalBytes },
    ])
    expect(preview.totalBytes).toBe(m.totalBytes)
    expect(preview.totalBytes).not.toBe(m.totalBytes + late.bytes) // 把 completed 全加起来会得到这个数

    const result = await executeCleanup(rig.deps, now, true)
    expect(result.purged).toEqual([
      { meetingId: 'm-late-asset', subMeetingId: '', assetCount: 1, localBytes: m.totalBytes },
    ])

    // 归档过的那个本地文件删了；没归档成功的那个还在——清理只删 archived_assets
    // 里有记录的资产，这也是为什么它的字节数不能算进"腾出的空间"
    expect(await exists(m.assets[0]!.localPath)).toBe(false)
    expect(await readFile(late.localPath, 'utf8')).toBe(late.content)
  })
})
