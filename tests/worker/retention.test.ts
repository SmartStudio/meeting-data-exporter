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
    archivedAt = ARCHIVED_AT,
    retentionDays = 30,
    extendDays = 0,
  } = input
  const nasDir = join(rig.nasRoot, 'archive', subMeetingId ? `${meetingId}_${subMeetingId}` : meetingId)
  const seeded: SeededAsset[] = []

  for (const [i, a] of assets.entries()) {
    const assetType = a.assetType ?? 'video'
    const remoteId = a.remoteId ?? `r-${i + 1}`
    const fileType = a.fileType ?? 'mp4'
    const localPath = join(rig.localRoot, a.targetPath)
    const nasPath = join(nasDir, a.targetPath)
    const bytes = Buffer.byteLength(a.content)

    await writeFileAt(localPath, a.content)
    await writeFileAt(nasPath, a.content)
    await rig.pool.execute(
      `INSERT INTO meeting_assets
         (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, bytes_written, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      [meetingId, subMeetingId, assetType, remoteId, fileType, a.targetPath, bytes, archivedAt, archivedAt],
    )
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

  await rig.archives.upsertMeetingArchive({ meetingId, subMeetingId, nasDir, archivedAt, retentionDays, now: archivedAt })
  if (extendDays > 0) await rig.archives.extendRetention(meetingId, subMeetingId, extendDays, archivedAt)

  return { nasDir, assets: seeded, totalBytes: seeded.reduce((sum, a) => sum + a.bytes, 0) }
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

    expect(paused).toEqual({ dryRun: false, paused: true, purged: [], verificationFailed: [] })
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
      expect(result).toEqual({ dryRun: false, paused: true, purged: [], verificationFailed: [] })
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
        // 资产按主键序 (asset_type, remote_id, file_type) 排，meeting_summary 排在
        // video 前面：让"没问题的那个"先被校验到，一个"边校验边删"的实现会在这里
        // 把它删掉，被下面"整场都不许删"的断言抓住
        { targetPath: 't/notes.txt', content: 'notes stay intact', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' },
        { targetPath: 't/video.mp4', content: 'original video bytes', assetType: 'video', remoteId: 'r-2', fileType: 'mp4' },
      ],
    })
    const now = ARCHIVED_AT + 40 * DAY
    const tampered = m.assets[1]!

    // 改的是 NAS 上那份文件的字节，库里的 archived_assets.nas_hash 一个字都不动——
    // 这就是"归档时校验过一次"与"现在还一致"之间那几十天里可能发生的事
    await writeFile(tampered.nasPath, 'externally modified on the NAS long after archiving')
    const recorded = (await rig.archives.listArchivedAssetsForMeeting('m-tampered', '')).find(
      (a) => a.nasPath === tampered.nasPath,
    )!
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
    const missing = m.assets[1]!
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
