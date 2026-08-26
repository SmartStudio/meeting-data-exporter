import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { MANIFEST_SCHEMA_VERSION, type ArchivedManifestFile, type Meeting, type MeetingMetaFile } from '@yaowu/mde-engine'
import { withTestDb } from '../helpers/testdb'
import { createArchivesStore, type ArchivesStore } from '../../src/store/archives'
import { createContentsStore } from '../../src/store/contents'
import { archiveMeeting, archivePendingMeetings, type ArchiveDeps } from '../../src/worker/archive'
import type { StackRule } from '../../src/policy/stacks'
import type { Pool } from '../../src/store/db'

/**
 * 用真实的本地文件系统当 localRoot 与 nasRoot（不 mock NAS）——本地文件系统语义
 * 已经足够验证 archiveMeeting 的逻辑正确性；NAS 特有的挂起/超时场景已经在
 * Task 2 的 nas.test.ts 覆盖过，这里不重复。
 */

async function realSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

interface SeedAssetInput {
  meetingId: string
  subMeetingId?: string
  assetType?: string
  remoteId?: string
  fileType?: string
  targetPath: string
  /** 平台声明的大小——NAS sidecar 的 `bytes` 取的就是这一列（不是 bytes_written） */
  bytesExpected?: number | null
  /** 下载器在本地算的整文件 sha256；视频/音频那一栏本来就是 null */
  contentHash?: string | null
}

/** 直接写 meeting_assets：这张表不归 ArchivesStore/archiveMeeting 写，只读用途 */
async function seedCompletedAsset(pool: Pool, input: SeedAssetInput): Promise<void> {
  const {
    meetingId,
    subMeetingId = '',
    assetType = 'video',
    remoteId = 'remote-1',
    fileType = 'mp4',
    targetPath,
    bytesExpected = null,
    contentHash = null,
  } = input
  await pool.execute(
    `INSERT INTO meeting_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path,
        bytes_written, bytes_expected, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?, 0, ?, ?, 1000, 1000)`,
    [meetingId, subMeetingId, assetType, remoteId, fileType, targetPath, bytesExpected, contentHash],
  )
}

/** 直接写一行**终态但没拿到**的资产（skipped / dead）——US-6.2 第三条验收标准的输入 */
async function seedMissingAsset(
  pool: Pool,
  input: { meetingId: string; assetType: string; remoteId: string; fileType?: string; status: 'skipped' | 'dead'; lastError: string },
): Promise<void> {
  const { meetingId, assetType, remoteId, fileType = '', status, lastError } = input
  await pool.execute(
    `INSERT INTO meeting_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, last_error, created_at, updated_at)
     VALUES (?, '', ?, ?, ?, ?, ?, 1000, 1000)`,
    [meetingId, assetType, remoteId, fileType, status, lastError],
  )
}

// 2026-08-20T09:30:00Z——手算的整数秒，好让 sidecar 里的期望值可以手算复核
const MEETING_START = Date.UTC(2026, 7, 20, 9, 30) / 1000

// ---------------------------------------------------------------------------
// 归档规则（T9：归档目录不再是固定规则，由 archive 栈判出来）
//
// 每条用例都要显式给一套规则，这不是样板：**兜底是 skip**，规则数组为空就是
// 「一场都不归档」。给规则这件事本身是被测行为的一部分，所以没有缺省值可用。
// ---------------------------------------------------------------------------

/** 会议号进模板，各场会议因此有各自的目录（同一个 rig 里跑多场会议时不会互相盖） */
const DIR_TEMPLATE = 'meetings/{年}/{月}/{会议号}'

/** 一条无条件命中的归档规则（`conds: []` 在求值器里就是「匹配一切」） */
function archiveRule(effect: string, over: Partial<StackRule> = {}): StackRule {
  return {
    id: 1,
    kind: 'archive',
    priority: 100,
    enabled: true,
    effect,
    conds: [],
    assetTypes: [],
    subjectType: null,
    subjectValue: null,
    note: '全部归档',
    ...over,
  }
}

const RULES: StackRule[] = [archiveRule(DIR_TEMPLATE)]

const listArchiveRules = async (): Promise<StackRule[]> => RULES

/** 没有人工改写。要验改写的用例各自造自己的 */
const noOverrides = async () => []

/**
 * 默认的会议元数据来源。`ArchiveDeps.getMeeting` 是**必填**的（不是可选的测试缝）：
 * 忘了接线的后果不是报错而是 NAS 上留下一串只有 ID 的 sidecar——正是 US-6.2 要消灭的
 * 那个失效形态，所以让编译器盯着，不留缺省值。
 */
function stubMeeting(meetingId: string, subMeetingId: string): Promise<Meeting | null> {
  return Promise.resolve({
    meetingId,
    subMeetingId,
    // 会议号按 meetingId 派生，好让 `{会议号}` 模板给每场会议一个各自的目录
    meetingCode: `88-${meetingId}`,
    subject: '周会 / Q3 复盘',
    hostUserId: 'u-host',
    startTime: MEETING_START,
    endTime: MEETING_START + 3600,
  })
}

/**
 * 手算 DIR_TEMPLATE 的渲染结果：`meetings/{年}/{月}/{会议号}`。
 *
 * **年月取的是会议的 startTime（MEETING_START），不是归档时刻**——这正是 T9 一并修掉
 * 的那个 bug，所以这个函数**不接归档时间**：接了就还能写出「按归档时刻算」的期望值。
 */
function expectedNasDir(nasRoot: string, meetingId: string): string {
  const d = new Date(MEETING_START * 1000)
  return join(
    nasRoot,
    'meetings',
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    `88-${meetingId}`,
  )
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function writeLocalFile(localRoot: string, targetPath: string, content: string): Promise<void> {
  const abs = join(localRoot, targetPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
}

/** 每个用例一套独立的库 + 本地根目录 + NAS 根目录，跑完全部拆掉 */
async function withRig(
  fn: (rig: { pool: Pool; localRoot: string; nasRoot: string; archives: ArchivesStore }) => Promise<void>,
): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  const localRoot = await mkdtemp(join(tmpdir(), 'mde-archive-local-'))
  const nasRoot = await mkdtemp(join(tmpdir(), 'mde-archive-nas-'))
  try {
    await fn({ pool, localRoot, nasRoot, archives: createArchivesStore(pool) })
  } finally {
    await rm(localRoot, { recursive: true, force: true })
    await rm(nasRoot, { recursive: true, force: true })
    await cleanup()
  }
}

test('用例1：单个资产归档成功——archived_assets 有记录、哈希与本地文件一致、newlyArchived===1', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-1', targetPath: '2026/08/dir/note.txt' })
    await writeLocalFile(localRoot, '2026/08/dir/note.txt', 'hello world')

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-1', '', 5000, RULES, null)

    expect(outcome).toEqual({
      meetingId: 'm-1',
      subMeetingId: '',
      newlyArchived: 1,
      verificationFailed: 0,
      fullyArchived: true,
      // 整场归档完成的同一处判定里顺带写出 NAS 那份自解释 sidecar（US-6.2）
      sidecar: 'written',
      // 归档栈判的：规则命中、判了一个目录模板
      skipped: false,
      undecidable: false,
      reason: expect.stringContaining('归档规则 #1「全部归档」决定：归档到'),
      // T4：正文入库的三个计数。这条用例没接 ArchiveDeps.contents，所以三个都是 0
      // （没接线本身会 warn 一句，见 T4⑥），归档结果不受影响
      contents: { ingested: 0, unparsed: 0, failed: 0 },
    })

    const assets = await archives.listArchivedAssetsForMeeting('m-1', '')
    expect(assets.length).toBe(1)
    const rec = assets[0]!
    expect(rec.localPath).toBe('2026/08/dir/note.txt')
    expect(rec.archivedAt).toBe(5000)

    // NAS 上真的有这份文件，内容与本地一致，且记的哈希确实是内容的 sha256
    // （不是随便什么字符串——直接用本地文件独立算一遍哈希核对）
    const nasContent = await readFile(rec.nasPath, 'utf8')
    expect(nasContent).toBe('hello world')
    expect(rec.nasHash).toBe(await realSha256(join(localRoot, '2026/08/dir/note.txt')))
    expect(rec.nasPath.startsWith(nasRoot)).toBe(true)
    // 落点由模板渲染出来，不再是写死的 <年>/<月>/<meetingId>
    expect(rec.nasPath).toBe(join(expectedNasDir(nasRoot, 'm-1'), '2026/08/dir/note.txt'))
  })
})

test('用例2：会议的全部 completed 资产都归档成功 → meeting_archives 被创建，fullyArchived===true', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-2', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'video.mp4' })
    await seedCompletedAsset(pool, { meetingId: 'm-2', assetType: 'meeting_summary', remoteId: 'r-2', fileType: 'txt', targetPath: 'summary.txt' })
    await writeLocalFile(localRoot, 'video.mp4', 'binary-ish-content')
    await writeLocalFile(localRoot, 'summary.txt', 'summary text')

    // 2026-08-24T00:00:00Z——手算的整数秒时间戳，好让下面的 nasDir 期望值可以
    // 手算复核，而不是从实现里抄回来的（跟 tests/worker/e2e.test.ts 的做法一致）。
    const ARCHIVED_AT = Date.UTC(2026, 7, 24) / 1000

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-2', '', ARCHIVED_AT, RULES, null)

    expect(outcome.newlyArchived).toBe(2)
    expect(outcome.verificationFailed).toBe(0)
    expect(outcome.fullyArchived).toBe(true)

    const rec = await archives.findMeetingArchive('m-2', '')
    expect(rec).not.toBeNull()
    expect(rec?.archivedAt).toBe(ARCHIVED_AT)
    // system_settings 里没配过 default_retention_days，退回 DEFAULT_RETENTION_DAYS=30
    expect(rec?.retentionDays).toBe(30)
    expect(rec?.extendedDays).toBe(0)
    expect(rec?.localPurgedAt).toBeNull()
    expect(rec?.nasDir).toBe(expectedNasDir(nasRoot, 'm-2'))
  })
})

test('用例2b：default_retention_days 设置后，新归档的会议采用该设置而不是硬编码默认值', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await archives.setSetting('default_retention_days', '90', 1000)
    await seedCompletedAsset(pool, { meetingId: 'm-2b', targetPath: 'a.txt' })
    await writeLocalFile(localRoot, 'a.txt', 'x')

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    await archiveMeeting(deps, 'm-2b', '', 6000, RULES, null)

    expect((await archives.findMeetingArchive('m-2b', ''))?.retentionDays).toBe(90)
  })
})

test('用例3：一个资产哈希校验失败（NAS 写入内容与本地不一致）→ 该资产不进 archived_assets，meeting_archives 不被创建', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-3', assetType: 'video', remoteId: 'r-good', fileType: 'mp4', targetPath: 'good.bin' })
    await seedCompletedAsset(pool, { meetingId: 'm-3', assetType: 'chat', remoteId: 'r-bad', fileType: 'txt', targetPath: 'bad.bin' })
    await writeLocalFile(localRoot, 'good.bin', 'good content')
    await writeLocalFile(localRoot, 'bad.bin', 'bad content')

    // 真实文件系统上一次正确的复制没有天然会失败的路径（这正是 ArchiveDeps.hashFile
    // 的注释解释的问题），所以用注入点人为制造"NAS 上 bad.bin 那份内容与本地不一致"：
    // 本地哈希照常算真实值，NAS 侧对 bad.bin 撒谎返回一个绝对对不上的常量；
    // good.bin 的本地/NAS 两次调用都走真实哈希，正常匹配、正常归档，用来证明
    // "只归档了部分资产"而不是整场会议一起失败。
    const hashFile = async (path: string): Promise<string> => {
      if (path.startsWith(nasRoot) && path.endsWith('bad.bin')) return 'tampered-hash-does-not-match-local'
      return realSha256(path)
    }

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, hashFile, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-3', '', 7000, RULES, null)

    expect(outcome.newlyArchived).toBe(1)
    expect(outcome.verificationFailed).toBe(1)
    expect(outcome.fullyArchived).toBe(false)

    expect(
      await archives.isAssetArchived({ meetingId: 'm-3', subMeetingId: '', assetType: 'video', remoteId: 'r-good', fileType: 'mp4' }),
    ).toBe(true)
    expect(
      await archives.isAssetArchived({ meetingId: 'm-3', subMeetingId: '', assetType: 'chat', remoteId: 'r-bad', fileType: 'txt' }),
    ).toBe(false)
    expect((await archives.listArchivedAssetsForMeeting('m-3', '')).length).toBe(1)

    // 不是 fullyArchived，meeting_archives 不该被创建
    expect(await archives.findMeetingArchive('m-3', '')).toBeNull()
  })
})

test('用例4：对已经全部归档过的会议重跑一次 → newlyArchived===0，不重复写 archived_assets，且 archived_at 不会被空转重跑推着往前走', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-4', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'video.mp4' })
    await writeLocalFile(localRoot, 'video.mp4', 'content-for-rerun-test')

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const first = await archiveMeeting(deps, 'm-4', '', 8000, RULES, null)
    expect(first.newlyArchived).toBe(1)
    expect(first.fullyArchived).toBe(true)
    expect(await archives.countArchivedAssets('m-4', '')).toBe(1)

    const second = await archiveMeeting(deps, 'm-4', '', 8500, RULES, null)
    expect(second.newlyArchived).toBe(0)
    expect(second.verificationFailed).toBe(0)
    expect(second.fullyArchived).toBe(true)

    // 没有重复写：数量还是 1，不是 2。若 isAssetArchived 没挡住重复归档，
    // 第二次 recordArchivedAsset 会撞 archived_assets 的主键直接抛错——
    // 这条用例能正常跑完本身就已经说明第二轮没有尝试过重复插入。
    expect(await archives.countArchivedAssets('m-4', '')).toBe(1)

    // 关键回归断言：第二轮什么新资产都没有归档（newlyArchived===0），
    // meeting_archives.archived_at 必须原样停在第一轮的 8000，不能被这次
    // 空转重跑悄悄推到 8500。若这里退化成 8500，说明 archiveMeeting 又在
    // 每次 fullyArchived 为 true 时无条件重新 upsert 了——那样一来，只要
    // worker 按周期重复调用（Step 5 之后的常态），任何会议的保留窗口起点
    // 永远追不上时钟，Task 8 的到期清理会永远找不到到期的会议。
    const rec = await archives.findMeetingArchive('m-4', '')
    expect(rec?.archivedAt).toBe(8000)
  })
})

test('用例5：分两轮跑——第一轮部分资产完成、第二轮剩余资产完成 → 第二轮之后 fullyArchived===true 且 meeting_archives 被创建', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    // 第一轮：只有 A 就绪（B 还没下载完，这场会议里根本还没有它的 completed 行——
    // 与真实流水线一致，探测/下载是异步就绪的，不要求同一轮里所有资产一起就绪）
    await seedCompletedAsset(pool, { meetingId: 'm-5', assetType: 'video', remoteId: 'r-a', fileType: 'mp4', targetPath: 'a.mp4' })
    await writeLocalFile(localRoot, 'a.mp4', 'asset A content')

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const round1 = await archiveMeeting(deps, 'm-5', '', 9000, RULES, null)
    expect(round1.newlyArchived).toBe(1)
    expect(round1.verificationFailed).toBe(0)

    // 第二轮之前，B 的下载才完成——补上它的 completed 行与本地文件
    await seedCompletedAsset(pool, { meetingId: 'm-5', assetType: 'meeting_summary', remoteId: 'r-b', fileType: 'txt', targetPath: 'b.txt' })
    await writeLocalFile(localRoot, 'b.txt', 'asset B content')

    const round2 = await archiveMeeting(deps, 'm-5', '', 9500, RULES, null)
    expect(round2.newlyArchived).toBe(1) // 只有 B 是新的；A 被 isAssetArchived 挡住不重复归档
    expect(round2.verificationFailed).toBe(0)
    expect(round2.fullyArchived).toBe(true)

    expect(await archives.countArchivedAssets('m-5', '')).toBe(2)
    const rec = await archives.findMeetingArchive('m-5', '')
    expect(rec).not.toBeNull()
    expect(rec?.archivedAt).toBe(9500) // 反映"最终真正凑齐"的那一轮
  })
})

test('NAS 写得太久（注入一个小超时模拟挂住的挂载）时归档失败——且默认超时必须够真实文件用完', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    // 16MB：流式复制至少要十几毫秒，对着 1ms 的超时必然先超时。用真实的大文件而不是
    // 0 字节配 0ms，是为了让这条用例不依赖"定时器和第一个 I/O 回调谁先跑"这种没有
    // 保证的竞速（与 tests/worker/retention.test.ts 的用例 4c 同一手法）。
    const big = 'x'.repeat(16 * 1024 * 1024)
    await seedCompletedAsset(pool, { meetingId: 'm-slow-nas', targetPath: 'slow/video.mp4' })
    await writeLocalFile(localRoot, 'slow/video.mp4', big)

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    await expect(archiveMeeting({ ...deps, nasWriteTimeoutMs: 1 }, 'm-slow-nas', '', 11_000, RULES, null)).rejects.toThrow(
      /timed out/,
    )

    // 超时的资产绝不能被当成已归档——下一轮还要重试它
    expect(await archives.countArchivedAssets('m-slow-nas', '')).toBe(0)
    expect(await archives.findMeetingArchive('m-slow-nas', '')).toBeNull()

    // 同一场会议、同一个 16MB 文件，用生产默认超时（10 分钟）就正常归档得掉。
    // 这一半是这条用例的重点：证明上面失败的原因确实是"注入的超时太小"，
    // 也证明默认值不会把真实大小的文件挡在门外——5s 的旧默认值只够搬 ~550MB，
    // 一场小时级录像每一轮都会死在这里、永远归档不上。
    const ok = await archiveMeeting(deps, 'm-slow-nas', '', 12_000, RULES, null)
    expect(ok.newlyArchived).toBe(1)
    expect(ok.verificationFailed).toBe(0)
    expect(ok.fullyArchived).toBe(true)
  })
}, 30_000)

test('archivePendingMeetings：一场会议的 archiveMeeting 抛出不连累其它会议，且计入 failed（review Important #2 的回归用例）', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    // 两场正常会议 + 一场会在归档时抛出的会议——三场都出现在
    // listMeetingsNeedingArchive() 的结果里（各自都有 completed 但未归档的资产）。
    await seedCompletedAsset(pool, { meetingId: 'm-ok-1', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'ok1.bin' })
    await seedCompletedAsset(pool, { meetingId: 'm-ok-2', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'ok2.bin' })
    await seedCompletedAsset(pool, { meetingId: 'm-throws', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'throws.bin' })
    await writeLocalFile(localRoot, 'ok1.bin', 'ok content 1')
    await writeLocalFile(localRoot, 'ok2.bin', 'ok content 2')
    await writeLocalFile(localRoot, 'throws.bin', 'this local file exists but hashing it will throw')

    // 制造"archiveMeeting 本身抛出"而不是"哈希校验不一致"：hashFile 对 m-throws
    // 的资产直接 throw（localHash = await doHash(localPath) 是 archiveOneAsset
    // 里第一个 await 的操作，在任何 mkdir/复制发生之前就会让整个 archiveMeeting
    // 调用 reject）——模拟 NAS 挂起触发的 FsTimeoutError 或本地文件读取时的
    // 意外 I/O 错误这一类，跟 verificationFailed 那种"复制成功但内容对不上"
    // 是两回事。
    const hashFile = async (path: string): Promise<string> => {
      if (path.endsWith('throws.bin')) throw new Error('simulated archive I/O failure')
      return realSha256(path)
    }

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, hashFile, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const result = await archivePendingMeetings(deps, () => 10_000)

    expect(result.newlyArchived).toBe(2) // m-ok-1、m-ok-2 都正常归档，没有被 m-throws 连累
    expect(result.verificationFailed).toBe(0)
    expect(result.failed).toBe(1) // 只有 m-throws 记为 failed

    expect(await archives.isAssetArchived({ meetingId: 'm-ok-1', subMeetingId: '', assetType: 'video', remoteId: 'r-1', fileType: 'mp4' })).toBe(true)
    expect(await archives.isAssetArchived({ meetingId: 'm-ok-2', subMeetingId: '', assetType: 'video', remoteId: 'r-1', fileType: 'mp4' })).toBe(true)
    expect(await archives.isAssetArchived({ meetingId: 'm-throws', subMeetingId: '', assetType: 'video', remoteId: 'r-1', fileType: 'mp4' })).toBe(false)

    expect(await archives.findMeetingArchive('m-ok-1', '')).not.toBeNull()
    expect(await archives.findMeetingArchive('m-ok-2', '')).not.toBeNull()
    expect(await archives.findMeetingArchive('m-throws', '')).toBeNull()
  })
})

test('归档失败落 job_failures（阶段 4 · T11）：只有真抛出的那一场进去，成功的不进', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-ok', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'ok.bin' })
    await seedCompletedAsset(pool, { meetingId: 'm-bad', subMeetingId: 's-2', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'bad.bin' })
    await writeLocalFile(localRoot, 'ok.bin', 'fine')
    await writeLocalFile(localRoot, 'bad.bin', 'will throw')

    const hashFile = async (path: string): Promise<string> => {
      if (path.endsWith('bad.bin')) throw new Error('NAS 挂住了')
      return realSha256(path)
    }
    const recorded: Array<{ meetingId: string; subMeetingId: string; reason: string }> = []
    const deps: ArchiveDeps = {
      archives, localRoot, nasRoot, hashFile,
      getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides,
      recordFailure: async (input) => { recorded.push(input) },
    }
    const result = await archivePendingMeetings(deps, () => 10_000)

    expect(result.failed).toBe(1)
    // 归档失败在这之前只是本轮内存里的一个计数 + 一行 console.error，进程一退就没了
    // （计划 E-d）。spec §4.8 要求它留在「失败项 · 需要处理」里等重试。
    expect(recorded).toEqual([
      { meetingId: 'm-bad', subMeetingId: 's-2', reason: 'NAS 挂住了' },
    ])
  })
})

test('记账口没接线不影响归档本身，也不静默——只是警告一句', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-bad', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'bad.bin' })
    await writeLocalFile(localRoot, 'bad.bin', 'will throw')
    const hashFile = async (): Promise<string> => { throw new Error('boom') }
    const deps: ArchiveDeps = {
      archives, localRoot, nasRoot, hashFile,
      getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides,
    }
    // recordFailure 缺席时不许抛出：记账是记账，归档轮次不能被它带倒
    const result = await archivePendingMeetings(deps, () => 10_000)
    expect(result.failed).toBe(1)
  })
})

test('记账口自己炸了也不连累归档轮次', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-bad', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'bad.bin' })
    await seedCompletedAsset(pool, { meetingId: 'm-ok', assetType: 'video', remoteId: 'r-1', fileType: 'mp4', targetPath: 'ok.bin' })
    await writeLocalFile(localRoot, 'bad.bin', 'will throw')
    await writeLocalFile(localRoot, 'ok.bin', 'fine')
    const hashFile = async (path: string): Promise<string> => {
      if (path.endsWith('bad.bin')) throw new Error('boom')
      return realSha256(path)
    }
    const deps: ArchiveDeps = {
      archives, localRoot, nasRoot, hashFile,
      getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides,
      recordFailure: async () => { throw new Error('数据库连不上') },
    }
    const result = await archivePendingMeetings(deps, () => 10_000)
    expect(result.failed).toBe(1)
    // 排在失败会议后面的那一场照样归档得掉——记账失败不许升级成归档失败
    expect(result.newlyArchived).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// NAS 上那份自解释 sidecar（US-6.2）
//
// 为什么 NAS 那份要独立生成、而不是把本地那两个文件搬过去：
// ① NAS 那份要带**归档特有**的信息（nasPath / nasHash / archivedAt / retentionDays /
//    nasDir），本地那份根本没有；
// ② 本地那份可能压根不存在（写失败过，或这场会议早于 sidecar 上线就归过档）。
// 更要紧的是**本地那份 30 天后会被到期清理删掉**（src/worker/retention.ts），
// 长期活下来的是 NAS 那一份——US-6.2 那句「数年后在 NAS 上翻到该目录」说的就是它。
// ---------------------------------------------------------------------------

/** sha256("summary text")——用一个像样的定值，本文件不验证哈希算法本身 */
const SUM_SHA = 'a'.repeat(64)

test('sidecar①：整场归档完成后 NAS 目录里出现 meeting.json 与 _manifest.json，字段与库里的事实逐条对得上', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    // 两个已完成资产（文本类有哈希、视频没有）+ 一个确认取不到的资产
    await seedCompletedAsset(pool, {
      meetingId: 'm-side', assetType: 'meeting_summary', remoteId: 'r-sum', fileType: 'txt',
      targetPath: '2026/08/d/summary.txt', bytesExpected: 12, contentHash: SUM_SHA,
    })
    await seedCompletedAsset(pool, {
      meetingId: 'm-side', assetType: 'video', remoteId: 'r-vid', fileType: 'mp4',
      targetPath: '2026/08/d/video.mp4', bytesExpected: 18, contentHash: null,
    })
    await seedMissingAsset(pool, {
      meetingId: 'm-side', assetType: 'ai_minutes', remoteId: 'r-ai',
      status: 'skipped', lastError: 'download_not_allowed',
    })
    await writeLocalFile(localRoot, '2026/08/d/summary.txt', 'summary text')
    await writeLocalFile(localRoot, '2026/08/d/video.mp4', 'binary-ish-content')

    const ARCHIVED_AT = Date.UTC(2026, 7, 24) / 1000
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-side', '', ARCHIVED_AT, RULES, null)

    expect(outcome.fullyArchived).toBe(true)
    expect(outcome.sidecar).toBe('written')

    const nasDir = expectedNasDir(nasRoot, 'm-side')

    // ① meeting.json：这一场会议的完整元数据，generatedBy 必须是 worker 那一侧的名字
    const meta = await readJson<MeetingMetaFile>(join(nasDir, 'meeting.json'))
    expect(meta).toEqual({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      meeting: {
        meetingId: 'm-side', subMeetingId: '', meetingCode: '88-m-side',
        subject: '周会 / Q3 复盘', hostUserId: 'u-host',
        startTime: MEETING_START, endTime: MEETING_START + 3600,
      },
      generatedAt: ARCHIVED_AT,
      generatedBy: 'mde-worker',
    })

    // ② _manifest.json：归档段 + 逐资产的 NAS 事实
    const manifest = await readJson<ArchivedManifestFile>(join(nasDir, '_manifest.json'))
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION)
    expect(manifest.meetingId).toBe('m-side')
    expect(manifest.subMeetingId).toBe('')
    expect(manifest.generatedBy).toBe('mde-worker')
    expect(manifest.generatedAt).toBe(ARCHIVED_AT)

    // 归档段与 meeting_archives 那一行同值——保留窗口的起点在两处必须是同一个数字，
    // 不然拿着清单算"还有几天被清"的人会算出另一个日子
    const archiveRow = (await archives.findMeetingArchive('m-side', ''))!
    expect(manifest.archive).toEqual({
      archivedAt: archiveRow.archivedAt,
      retentionDays: archiveRow.retentionDays,
      nasDir: archiveRow.nasDir,
    })
    expect(manifest.archive.nasDir).toBe(nasDir)

    // 逐资产：nasPath / nasHash 必须与 archived_assets 表里记的一模一样
    const archived = await archives.listArchivedAssetsForMeeting('m-side', '')
    const byRemote = new Map(archived.map((a) => [a.remoteId, a]))
    expect(manifest.assets.length).toBe(2)
    // 顺序按入库顺序（id 升序），与引擎那份本地清单同一种排序
    expect(manifest.assets.map((a) => a.remoteId)).toEqual(['r-sum', 'r-vid'])

    const sum = manifest.assets[0]!
    expect(sum).toEqual({
      assetType: 'meeting_summary',
      assetKey: 'transcript',          // 网关词汇 → 引擎 AssetKey，数年后翻清单的人未必有映射表
      remoteId: 'r-sum',
      fileType: 'txt',
      fileName: 'summary.txt',
      bytes: 12,                        // 取 bytes_expected（被校验过的），不是 bytes_written
      sha256: SUM_SHA,                  // 本地下载时算的整文件哈希
      nasPath: byRemote.get('r-sum')!.nasPath,
      nasHash: byRemote.get('r-sum')!.nasHash,
    })
    // nasHash 是真的重新读回 NAS 那份文件算出来的，不是把本地那个值抄过去
    expect(sum.nasHash).toBe(await realSha256(join(nasDir, '2026/08/d/summary.txt')))
    expect(sum.nasPath).toBe(join(nasDir, '2026/08/d/summary.txt'))

    const vid = manifest.assets[1]!
    // 视频没有本地整文件哈希（如实 null），但 NAS 侧那一份**有**——归档链路本来就要
    // 读回来校验一次，所以拿着这份清单核查 NAS 目录完整性时，视频也核得了
    expect(vid.sha256).toBeNull()
    expect(vid.nasHash).toBe(await realSha256(join(nasDir, '2026/08/d/video.mp4')))
    expect(vid.bytes).toBe(18)
    expect(vid.assetKey).toBe('video')

    // ③ 确认取不到的资产显式标注原因（US-6.2 第三条验收标准）
    expect(manifest.missing).toEqual([
      { assetType: 'ai_minutes', assetKey: 'ai_minutes', remoteId: 'r-ai', status: 'skipped', reason: 'download_not_allowed' },
    ])
  })
})

test('sidecar②：会议元数据取不到 → 判不出归档目录，这一轮不归档，且理由说得清是为什么', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-nometa', targetPath: 'a.mp4', bytesExpected: 1 })
      await writeLocalFile(localRoot, 'a.mp4', 'x')

      const deps: ArchiveDeps = {
        archives, localRoot, nasRoot, listArchiveRules, listArchiveOverrides: noOverrides,
        // meetings 表里没有这一场（历史数据、或上游把行删了）
        getMeeting: async () => null,
      }
      const outcome = await archiveMeeting(deps, 'm-nometa', '', 20_000, RULES, null)

      // T9 之前这场会议会被归档到 <年>/<月>/<meetingId>——固定规则不需要元数据。
      // 接上规则栈之后，条件求值与 {年}/{月}/{标题} 都要会议字段，没有元数据就
      // **判不出来**，于是落到安全侧：不归档，并留下可查的理由。
      // 换成「用默认目录归档」的话，这场会议会静静落进 1970/01/untitled——
      // 那正是「写到管理员没想到的地方」。
      expect(outcome.skipped).toBe(true)
      expect(outcome.newlyArchived).toBe(0)
      expect(outcome.reason).toContain('元数据')
      expect(outcome.sidecar).toBe('skipped')

      // 一个字节都没往 NAS 上写，库里也没有任何归档记录
      expect(await archives.countArchivedAssets('m-nometa', '')).toBe(0)
      expect(await archives.findMeetingArchive('m-nometa', '')).toBeNull()

      // 不静默：拿不到元数据这件事必须留痕
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('m-nometa'))).toBe(true)
    })
  } finally {
    warnSpy.mockRestore()
  }
})

test('sidecar③：写 sidecar 抛错时归档仍然成功，meeting_archives 照样写入，且有 warn 留痕', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-badmeta', targetPath: 'a.mp4', bytesExpected: 1 })
      await writeLocalFile(localRoot, 'a.mp4', 'x')

      const deps: ArchiveDeps = {
        archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides,
        writeMeta: async () => { throw new Error('simulated sidecar write failure') },
      }
      const outcome = await archiveMeeting(deps, 'm-badmeta', '', 21_000, RULES, null)

      // 关键：upsertMeetingArchive 那一行是**保留窗口开始计时的地方**。
      // 写 sidecar 失败就跳过归档记录的话，这场会议每一轮都会被重新归档。
      expect(outcome.fullyArchived).toBe(true)
      expect(outcome.sidecar).toBe('failed')
      const rec = await archives.findMeetingArchive('m-badmeta', '')
      expect(rec).not.toBeNull()
      expect(rec?.archivedAt).toBe(21_000)
      expect(await archives.countArchivedAssets('m-badmeta', '')).toBe(1)

      // 不许静默 .catch(() => {})——失败必须留痕
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('m-badmeta'))).toBe(true)
    })
  } finally {
    warnSpy.mockRestore()
  }
})

test('sidecar④：NAS 写 sidecar 挂住时在有限时间内返回，归档不被卡死', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-hang', targetPath: 'a.mp4', bytesExpected: 1 })
      await writeLocalFile(localRoot, 'a.mp4', 'x')

      const deps: ArchiveDeps = {
        archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides,
        // 永不 resolve = 挂死的网络挂载：fs 调用不报错，就那么挂着。
        // 超时归 archive.ts 自己包，不指望注入进来的实现自带（withFsTimeout 的
        // 保证必须由调用方持有，否则换个实现这条保证就没了）。
        writeMeta: () => new Promise<void>(() => {}),
        // 300ms：够一个 1 字节文件在真实文件系统上复制 + 读回算哈希，
        // 又不至于让这条用例真的等上生产默认的 10 分钟
        nasWriteTimeoutMs: 300,
      }
      const started = Date.now()
      const outcome = await archiveMeeting(deps, 'm-hang', '', 22_000, RULES, null)
      const elapsed = Date.now() - started

      expect(outcome.sidecar).toBe('failed')
      expect(elapsed).toBeLessThan(10_000)      // 有限时间内返回，不是挂死
      // 资产与归档记录都照常落库——挂住的只是 sidecar
      expect(await archives.countArchivedAssets('m-hang', '')).toBe(1)
      expect(await archives.findMeetingArchive('m-hang', '')).not.toBeNull()
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('timed out'))).toBe(true)
    })
  } finally {
    warnSpy.mockRestore()
  }
}, 30_000)

test('sidecar⑤：可重复调用——空转重跑不改动已写出的 sidecar，迟到的资产才触发一次内容正确的重写', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, {
      meetingId: 'm-idem', assetType: 'video', remoteId: 'r-1', fileType: 'mp4',
      targetPath: 'a.mp4', bytesExpected: 3,
    })
    await writeLocalFile(localRoot, 'a.mp4', 'aaa')

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const T1 = Date.UTC(2026, 7, 24) / 1000
    const first = await archiveMeeting(deps, 'm-idem', '', T1, RULES, null)
    expect(first.sidecar).toBe('written')

    const nasDir = expectedNasDir(nasRoot, 'm-idem')
    const metaBytes = await readFile(join(nasDir, 'meeting.json'), 'utf8')
    const manifestBytes = await readFile(join(nasDir, '_manifest.json'), 'utf8')

    // 第二轮：什么都没变。sidecar 不该被重写——generatedAt 若跟着时钟走，
    // 一份"内容一模一样、只有时间戳每轮都变"的清单会让 NAS 上的 mtime 天天跳，
    // 也会让"这份清单是什么时候生成的"这个问题失去意义。
    const second = await archiveMeeting(deps, 'm-idem', '', T1 + 3600, RULES, null)
    expect(second.newlyArchived).toBe(0)
    expect(second.sidecar).toBe('skipped')
    expect(await readFile(join(nasDir, 'meeting.json'), 'utf8')).toBe(metaBytes)
    expect(await readFile(join(nasDir, '_manifest.json'), 'utf8')).toBe(manifestBytes)

    // 第三轮：一个迟到的资产（比如事后才产出的 AI 纪要）真的归档进来了 → 重写一次，
    // 内容跟着库里的新事实走，而不是在旧清单上追加
    await seedCompletedAsset(pool, {
      meetingId: 'm-idem', assetType: 'ai_minutes', remoteId: 'r-2', fileType: 'txt',
      targetPath: 'b.txt', bytesExpected: 5,
    })
    await writeLocalFile(localRoot, 'b.txt', 'bbbbb')
    const T3 = Date.UTC(2026, 7, 24) / 1000 + 7200
    const third = await archiveMeeting(deps, 'm-idem', '', T3, RULES, null)
    expect(third.newlyArchived).toBe(1)
    expect(third.sidecar).toBe('written')

    const manifest = await readJson<ArchivedManifestFile>(join(nasDir, '_manifest.json'))
    expect(manifest.assets.map((a) => a.remoteId)).toEqual(['r-1', 'r-2'])
    // 先归档的那个资产的 NAS 事实一个字都没变（重写不是重算）
    const before = JSON.parse(manifestBytes) as ArchivedManifestFile
    expect(manifest.assets[0]).toEqual(before.assets[0]!)
    expect(manifest.archive.archivedAt).toBe(T3)
  })
})

test('sidecar⑥：部分归档（fullyArchived===false）时不写 sidecar——目录还没齐，一份声称齐了的清单比没有更糟', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-part', assetType: 'video', remoteId: 'r-good', fileType: 'mp4', targetPath: 'good.bin' })
    await seedCompletedAsset(pool, { meetingId: 'm-part', assetType: 'chat', remoteId: 'r-bad', fileType: 'txt', targetPath: 'bad.bin' })
    await writeLocalFile(localRoot, 'good.bin', 'good content')
    await writeLocalFile(localRoot, 'bad.bin', 'bad content')

    // 与用例3 同一手法：让 bad.bin 在 NAS 侧的哈希对不上，这场会议就归不满
    const hashFile = async (path: string): Promise<string> => {
      if (path.startsWith(nasRoot) && path.endsWith('bad.bin')) return 'tampered-hash-does-not-match-local'
      return realSha256(path)
    }

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, hashFile, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-part', '', 23_000, RULES, null)

    expect(outcome.fullyArchived).toBe(false)
    expect(outcome.sidecar).toBe('skipped')

    const nasDir = expectedNasDir(nasRoot, 'm-part')
    expect(await exists(join(nasDir, 'meeting.json'))).toBe(false)
    expect(await exists(join(nasDir, '_manifest.json'))).toBe(false)
  })
})

test('sidecar⑦：archivePendingMeetings 把 sidecar 失败单独计数，且不算进"归档失败"', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-agg-1', targetPath: 'x1.bin' })
      await seedCompletedAsset(pool, { meetingId: 'm-agg-2', targetPath: 'x2.bin' })
      await writeLocalFile(localRoot, 'x1.bin', 'one')
      await writeLocalFile(localRoot, 'x2.bin', 'two')

      const deps: ArchiveDeps = {
        archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides,
        writeMeta: async () => { throw new Error('nas sidecar unavailable') },
      }
      const result = await archivePendingMeetings(deps, () => 24_000)

      expect(result.newlyArchived).toBe(2)
      expect(result.verificationFailed).toBe(0)
      // "归档失败"是最高级别告警，写不出 sidecar 不是那件事——两个数字不能合并
      expect(result.failed).toBe(0)
      expect(result.sidecarFailed).toBe(2)

      expect(await archives.findMeetingArchive('m-agg-1', '')).not.toBeNull()
      expect(await archives.findMeetingArchive('m-agg-2', '')).not.toBeNull()
    })
  } finally {
    warnSpy.mockRestore()
  }
})

// ---------------------------------------------------------------------------
// T9：归档目录由 archive 规则栈判出来
//
// 上面所有用例给的都是「一条无条件命中、模板合法」的规则，测的是归档动作本身。
// 这一段测的是**判定**：判出目录、判不归档、判不出合法路径，各自会发生什么。
// ---------------------------------------------------------------------------

/** 七月的会议：跨月用例的输入，与 stubMeeting（八月）刻意错开一个月 */
const JULY_START = Date.UTC(2026, 6, 15, 14, 30) / 1000

test('T9 跨月：七月的会议在八月归档，落进 2026/07——年月取会议 startTime，不是归档时刻', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-july', targetPath: 'jul.bin' })
    await writeLocalFile(localRoot, 'jul.bin', 'july content')

    const julyMeeting = async (meetingId: string, subMeetingId: string): Promise<Meeting> => ({
      meetingId, subMeetingId, meetingCode: '88-july', subject: '七月例会',
      hostUserId: 'u-host', startTime: JULY_START, endTime: JULY_START + 3600,
    })

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: julyMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    // 归档发生在 2026-08-24——旧实现按这个时刻算年月，会落进 2026/08
    const ARCHIVED_IN_AUGUST = Date.UTC(2026, 7, 24) / 1000
    const outcome = await archiveMeeting(deps, 'm-july', '', ARCHIVED_IN_AUGUST, RULES, null)

    expect(outcome.fullyArchived).toBe(true)
    const expected = join(nasRoot, 'meetings', '2026', '07', '88-july')
    expect((await archives.findMeetingArchive('m-july', ''))?.nasDir).toBe(expected)
    // 本地归档区（meetingDirPath）也是按 startTime 分年月的，两处这才对得上；
    // 按归档时刻分的话，人去 NAS 上按月份找七月的会议会找不到。
    expect(expected).not.toContain(`${join('2026', '08')}`)
  })
})

test('T9：一条规则都没有 → 兜底 skip，什么都不归档，理由说清是兜底', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-norule', targetPath: 'a.bin' })
    await writeLocalFile(localRoot, 'a.bin', 'x')

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules: async () => [] , listArchiveOverrides: noOverrides}
    const outcome = await archiveMeeting(deps, 'm-norule', '', 30_000, [], null)

    expect(outcome.skipped).toBe(true)
    expect(outcome.newlyArchived).toBe(0)
    expect(outcome.fullyArchived).toBe(false)
    expect(outcome.sidecar).toBe('skipped')
    // 「规则没配就什么都不归档」是设计如此，但绝不能悄悄发生
    expect(outcome.reason).toContain('兜底')
    expect(outcome.reason).toContain('不归档')

    expect(await archives.countArchivedAssets('m-norule', '')).toBe(0)
    expect(await archives.findMeetingArchive('m-norule', '')).toBeNull()
  })
})

test('T9：规则判 skip → 不归档，理由带着是哪条规则判的', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-skip', targetPath: 'a.bin' })
    await writeLocalFile(localRoot, 'a.bin', 'x')

    const skipRules = [archiveRule('skip', { id: 9, note: '外部客户会议不进 NAS' })]
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules: async () => skipRules , listArchiveOverrides: noOverrides}
    const outcome = await archiveMeeting(deps, 'm-skip', '', 31_000, skipRules, null)

    expect(outcome.skipped).toBe(true)
    expect(outcome.reason).toContain('#9')
    expect(outcome.reason).toContain('外部客户会议不进 NAS')
    expect(await archives.countArchivedAssets('m-skip', '')).toBe(0)
  })
})

test('T9：模板渲染不出合法路径（路径穿越）→ 不归档，绝不「尽力而为地拼一个」', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-bad', targetPath: 'a.bin' })
    await writeLocalFile(localRoot, 'a.bin', 'x')

    const badRules = [archiveRule('../../{年}/{月}', { id: 3, note: '模板写坏了' })]
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules: async () => badRules , listArchiveOverrides: noOverrides}
    const outcome = await archiveMeeting(deps, 'm-bad', '', 32_000, badRules, null)

    expect(outcome.skipped).toBe(true)
    expect(outcome.reason).toContain('..')
    expect(outcome.reason).toContain('#3')
    expect(await archives.countArchivedAssets('m-bad', '')).toBe(0)
    // 一个字节都没写出去——尤其没有写到 NAS 根之外
    expect(await archives.findMeetingArchive('m-bad', '')).toBeNull()
  })
})

test('T9：规则**每轮取一次**，不是每场会议取一次', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    // 三场会议，都会出现在 listMeetingsNeedingArchive() 里
    for (const id of ['m-r1', 'm-r2', 'm-r3']) {
      await seedCompletedAsset(pool, { meetingId: id, targetPath: `${id}.bin` })
      await writeLocalFile(localRoot, `${id}.bin`, id)
    }

    let calls = 0
    const counting = async (): Promise<StackRule[]> => {
      calls++
      return RULES
    }
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules: counting , listArchiveOverrides: noOverrides}
    const result = await archivePendingMeetings(deps, () => 33_000)

    expect(result.newlyArchived).toBe(3)
    // 一轮几十上百场会议，规则集每场重查一遍是白花的查询；而且同一轮里
    // 规则若在中途被改，前后两场会议会按不同的规则集判——同一轮内不能有两套口径。
    expect(calls).toBe(1)
  })
})

test('T9：archivePendingMeetings 把「判为不归档」单独计数，且不算进"归档失败"', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-sk-1', targetPath: 's1.bin' })
      await seedCompletedAsset(pool, { meetingId: 'm-sk-2', targetPath: 's2.bin' })
      await writeLocalFile(localRoot, 's1.bin', 'one')
      await writeLocalFile(localRoot, 's2.bin', 'two')

      const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules: async () => [] , listArchiveOverrides: noOverrides}
      const result = await archivePendingMeetings(deps, () => 34_000)

      expect(result.newlyArchived).toBe(0)
      expect(result.skipped).toBe(2)
      // 规则判的「不归档」不是故障，不能进最高级别的「归档失败」告警
      expect(result.failed).toBe(0)
      expect(result.sidecarFailed).toBe(0)

      // 但每一场都要留下一条能查的理由——一场会议悄悄没被归档是最难排查的现象
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('m-sk-1'))).toBe(true)
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('m-sk-2'))).toBe(true)
    })
  } finally {
    warnSpy.mockRestore()
  }
})

/**
 * 「规则就是这么定的」与「判不出来」在轮末汇总里必须分得开。
 *
 * 合成一个 skipped 的话，一条写坏的规则（命中它的会议一场都归不了档，而且不会
 * 自己好转）在汇总行里与「今天没有会议需要归档」长得一模一样。
 */
test('T9：写坏的模板计进 undecidable，规则判 skip 不计', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-bad', targetPath: 'b.bin' })
      await writeLocalFile(localRoot, 'b.bin', 'x')

      // {年份} 不是合法占位符——原样保留会产出一个字面带花括号的目录，看起来像成功了
      const deps: ArchiveDeps = {
        archives, localRoot, nasRoot, getMeeting: stubMeeting,
        listArchiveRules: async () => [archiveRule('{年份}/{月}/{会议号}/')],
        listArchiveOverrides: noOverrides,
      }
      const result = await archivePendingMeetings(deps, () => 35_000)

      expect(result.skipped).toBe(1)
      expect(result.undecidable).toBe(1)
      // 判不出来仍然不是「归档失败」：它不进退出码，理由见 archive.ts
      expect(result.failed).toBe(0)
    })

    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-skip', targetPath: 's.bin' })
      await writeLocalFile(localRoot, 's.bin', 'y')

      // 一条规则都没有 → 走兜底 skip。这是设计如此，不是有事要办
      const deps: ArchiveDeps = {
        archives, localRoot, nasRoot, getMeeting: stubMeeting,
        listArchiveRules: async () => [], listArchiveOverrides: noOverrides,
      }
      const result = await archivePendingMeetings(deps, () => 36_000)

      expect(result.skipped).toBe(1)
      expect(result.undecidable).toBe(0)
    })
  } finally {
    warnSpy.mockRestore()
  }
})

test('T9：会议元数据取不到计进 undecidable——那是采集侧的数据不一致，不是规则的决定', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-nometa', targetPath: 'n.bin' })
      await writeLocalFile(localRoot, 'n.bin', 'z')

      const deps: ArchiveDeps = {
        archives, localRoot, nasRoot,
        getMeeting: async () => null,
        listArchiveRules, listArchiveOverrides: noOverrides,
      }
      const result = await archivePendingMeetings(deps, () => 37_000)

      expect(result.skipped).toBe(1)
      expect(result.undecidable).toBe(1)
      expect(result.newlyArchived).toBe(0)
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('m-nometa'))).toBe(true)
    })
  } finally {
    warnSpy.mockRestore()
  }
})

// ── 人工改写要压过归档规则（spec §5.4）────────────────────────────────────────
//
// 与网关那边同一条规矩：改写套在 evaluateArchiveStack **外面**，而不是混进求值。
// 混进去的话影响预览（T5）就再也算不准——它算的是「规则改了会怎样」，
// 而被改写的会议根本不受规则支配。

const archiveOverride = (o: Record<string, unknown> = {}) => ({
  meetingId: 'm-ovr',
  subMeetingId: '',
  kind: 'archive' as const,
  effect: '法务专区/{年}/{会议号}',
  assetTypes: null,
  reason: '法务要求单独存放',
  createdAt: 1_000,
  ...o,
})

test('T7×T9：archive 改写压过规则，文件落到改写指定的目录', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-ovr', targetPath: 'o.bin' })
    await writeLocalFile(localRoot, 'o.bin', 'secret')

    const deps: ArchiveDeps = {
      archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules,
      listArchiveOverrides: async () => [archiveOverride()],
    }
    const result = await archivePendingMeetings(deps, () => 40_000)

    expect(result.newlyArchived).toBe(1)
    expect(result.skipped).toBe(0)

    // 规则本来会判 meetings/<年>/<月>/88-m-ovr，改写把它挪到了法务专区
    const rec = await archives.findMeetingArchive('m-ovr', '')
    expect(rec!.nasDir).toContain('法务专区')
    expect(rec!.nasDir).not.toContain('meetings/')
  })
})

test('T7×T9：改写判 skip 时一个字节都不搬，哪怕规则说要归档', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedCompletedAsset(pool, { meetingId: 'm-ovr', targetPath: 'o2.bin' })
      await writeLocalFile(localRoot, 'o2.bin', 'x')

      const deps: ArchiveDeps = {
        archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules,
        listArchiveOverrides: async () => [archiveOverride({ effect: 'skip' })],
      }
      const result = await archivePendingMeetings(deps, () => 41_000)

      expect(result.newlyArchived).toBe(0)
      expect(result.skipped).toBe(1)
      // 人工决定不归档不是「判不出来」——管理员就是这么定的
      expect(result.undecidable).toBe(0)
      expect(await archives.findMeetingArchive('m-ovr', '')).toBeNull()
    })
  } finally {
    warnSpy.mockRestore()
  }
})

test('T7×T9：改写只对该场会议生效，别的会议照规则判', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-ovr', targetPath: 'a.bin' })
    await seedCompletedAsset(pool, { meetingId: 'm-plain', targetPath: 'b.bin' })
    await writeLocalFile(localRoot, 'a.bin', 'one')
    await writeLocalFile(localRoot, 'b.bin', 'two')

    const deps: ArchiveDeps = {
      archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules,
      listArchiveOverrides: async () => [archiveOverride()],
    }
    await archivePendingMeetings(deps, () => 42_000)

    expect((await archives.findMeetingArchive('m-ovr', ''))!.nasDir).toContain('法务专区')
    expect((await archives.findMeetingArchive('m-plain', ''))!.nasDir).toContain('meetings/')
  })
})

test('T7×T9：kind 不是 archive 的改写不影响归档目录', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedCompletedAsset(pool, { meetingId: 'm-ovr', targetPath: 'c.bin' })
    await writeLocalFile(localRoot, 'c.bin', 'z')

    // 一条 allow 改写。它的 effect 'allow' 会被 normalizeEffect('archive', …)
    // 当成一段合法的非空目录模板——所以必须在索引时就按 kind 筛掉，
    // 否则这场会议会被归档进一个叫 allow 的目录
    const deps: ArchiveDeps = {
      archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules,
      listArchiveOverrides: async () => [archiveOverride({ kind: 'allow', effect: 'allow' })],
    }
    await archivePendingMeetings(deps, () => 43_000)

    const rec = await archives.findMeetingArchive('m-ovr', '')
    expect(rec!.nasDir).toContain('meetings/')
    expect(rec!.nasDir).not.toContain('allow')
  })
})

// ---------------------------------------------------------------------------
// T4 · 文本类资产正文入库（A6 的写侧）
//
// 归档流水线这一处接线只做一件事：**一个文本类资产刚归档成功之后**，按它在 NAS 上
// 那份副本的哈希把正文读进 asset_contents。断言的重心因此不在返回值上，而在库里
// 那一行——「预览页数年后还查得到这份纪要」这条承诺兑现与否，只看那张表。
// ---------------------------------------------------------------------------

/** 一份文本资产 + 它的本地文件，省掉每条用例都写两行 */
async function seedTextAsset(
  pool: Pool,
  localRoot: string,
  input: { meetingId: string; assetType?: string; remoteId?: string; fileType?: string; targetPath: string; body: string },
): Promise<void> {
  const { meetingId, assetType = 'meeting_summary', remoteId = 'r-1', fileType = 'txt', targetPath, body } = input
  await seedCompletedAsset(pool, { meetingId, assetType, remoteId, fileType, targetPath })
  await writeLocalFile(localRoot, targetPath, body)
}

test('T4①：转写归档成功后正文进库——content 与文件逐字一致，content_hash 就是 archived_assets.nas_hash', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    const body = '主持人：开始。\n甲：同意 🎯\n乙：下周再看。'
    await seedTextAsset(pool, localRoot, { meetingId: 'm-c1', targetPath: 'transcript.txt', body })

    const contents = createContentsStore(pool)
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, contents, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-c1', '', 50_000, RULES, null)

    expect(outcome.contents).toEqual({ ingested: 1, unparsed: 0, failed: 0 })

    const key = { meetingId: 'm-c1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' }
    const row = await contents.get(key)
    expect(row?.status).toBe('parsed')
    expect(row?.content).toBe(body)
    expect(row?.bytes).toBe(Buffer.byteLength(body))
    expect(row?.parsedAt).toBe(50_000)

    // 这一条是 T4 验收判据 1：入了一份和 NAS 上不一致的正文，比没入更糟
    const archived = await archives.listArchivedAssetsForMeeting('m-c1', '')
    expect(row?.contentHash).toBe(archived[0]!.nasHash)
  })
})

test('T4②：录像与音频不入库——它们不是文本，而且单个可以有几个 GB', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedTextAsset(pool, localRoot, { meetingId: 'm-c2', assetType: 'video', remoteId: 'r-v', fileType: 'mp4', targetPath: 'v.mp4', body: 'not-text' })
    await seedTextAsset(pool, localRoot, { meetingId: 'm-c2', assetType: 'audio', remoteId: 'r-a', fileType: 'm4a', targetPath: 'a.m4a', body: 'not-text' })

    const contents = createContentsStore(pool)
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, contents, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-c2', '', 51_000, RULES, null)

    expect(outcome.newlyArchived).toBe(2)
    expect(outcome.contents).toEqual({ ingested: 0, unparsed: 0, failed: 0 })
    expect(await contents.listPending(10)).toEqual([])
  })
})

test('T4③：docx 纪要不解析，但留一行说明原因——静默跳过与「这场会议没有纪要」在界面上分不出来', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedTextAsset(pool, localRoot, { meetingId: 'm-c3', assetType: 'ai_minutes', remoteId: 'r-d', fileType: 'docx', targetPath: 'ai_minutes.docx', body: 'PKfake' })

    const contents = createContentsStore(pool)
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, contents, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-c3', '', 52_000, RULES, null)

    // 未解析不是失败：归档照常完成，这场会议照样进 meeting_archives
    expect(outcome.contents).toEqual({ ingested: 0, unparsed: 1, failed: 0 })
    expect(outcome.fullyArchived).toBe(true)
    expect(await archives.findMeetingArchive('m-c3', '')).not.toBeNull()

    const row = await contents.get({ meetingId: 'm-c3', subMeetingId: '', assetType: 'ai_minutes', remoteId: 'r-d', fileType: 'docx' })
    expect(row?.status).toBe('unsupported_format')
    expect(row?.content).toBeNull()
    expect(row?.reason).toContain('docx')
  })
})

test('T4④：入库炸了不让归档判为失败——与 sidecar 同一口径（正文可以补，归档不可逆）', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedTextAsset(pool, localRoot, { meetingId: 'm-c4', targetPath: 'transcript.txt', body: '正文' })

      const real = createContentsStore(pool)
      const contents = { ...real, put: async () => { throw new Error('库炸了') } }
      const deps: ArchiveDeps = { archives, localRoot, nasRoot, contents, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
      const result = await archivePendingMeetings(deps, () => 53_000)

      // 归档本身是成功的：资产在 NAS 上、哈希校验过、meeting_archives 已落库
      expect(result.newlyArchived).toBe(1)
      expect(result.failed).toBe(0)
      expect(await archives.findMeetingArchive('m-c4', '')).not.toBeNull()
      // 但没有静默：喊了一句，且库里没有那一行（下次回填还能重试）
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('m-c4')
      expect(await real.get({ meetingId: 'm-c4', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' })).toBeNull()
      expect(await real.listPending(10)).toHaveLength(1)
    })
  } finally {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  }
})

test('T4⑤：NAS 上的副本被人动过（哈希对不上）→ 不入库、不写行、喊一句，归档照常', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedTextAsset(pool, localRoot, { meetingId: 'm-c5', targetPath: 'transcript.txt', body: '原始正文' })

      const contents = createContentsStore(pool)
      // 归档校验用注入的哈希（两边都返回同一个假值，所以校验通过、归档成功），
      // 而正文入库自己重新算真哈希——于是记录里的 nas_hash 与正文对不上，
      // 正是「NAS 上那份副本与记录不一致」这个场景
      const hashFile = async () => 'f'.repeat(64)
      const deps: ArchiveDeps = { archives, localRoot, nasRoot, contents, hashFile, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
      const outcome = await archiveMeeting(deps, 'm-c5', '', 54_000, RULES, null)

      expect(outcome.newlyArchived).toBe(1)
      expect(outcome.contents).toEqual({ ingested: 0, unparsed: 0, failed: 1 })
      expect(await contents.get({ meetingId: 'm-c5', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' })).toBeNull()
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('哈希')
    })
  } finally {
    warnSpy.mockRestore()
  }
})

test('T4⑥：ArchiveDeps.contents 没接线时喊出来——正文没入库不能只是「什么都没发生」', async () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
      await seedTextAsset(pool, localRoot, { meetingId: 'm-c6', targetPath: 'transcript.txt', body: '正文' })

      const deps: ArchiveDeps = { archives, localRoot, nasRoot, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
      const outcome = await archiveMeeting(deps, 'm-c6', '', 55_000, RULES, null)

      expect(outcome.newlyArchived).toBe(1)
      expect(outcome.contents).toEqual({ ingested: 0, unparsed: 0, failed: 0 })
      const warned = warnSpy.mock.calls.flat().join(' ')
      expect(warned).toContain('m-c6')
      expect(warned).toContain('正文入库未接线')
    })
  } finally {
    warnSpy.mockRestore()
  }
})

test('T4⑦：空转重跑不重复入库——只有「这一轮真的新归档了」的资产才会被解析一次', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedTextAsset(pool, localRoot, { meetingId: 'm-c7', targetPath: 'transcript.txt', body: '正文' })

    const contents = createContentsStore(pool)
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, contents, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const first = await archiveMeeting(deps, 'm-c7', '', 56_000, RULES, null)
    const second = await archiveMeeting(deps, 'm-c7', '', 57_000, RULES, null)

    expect(first.contents.ingested).toBe(1)
    expect(second.contents).toEqual({ ingested: 0, unparsed: 0, failed: 0 })
    // parsed_at 停在第一轮：空转重跑一个字都不该改
    expect((await contents.get({ meetingId: 'm-c7', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' }))?.parsedAt).toBe(56_000)
  })
})

test('T4⑧：同一场会议的两段转写各入一行，不互相覆盖', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await seedTextAsset(pool, localRoot, { meetingId: 'm-c8', remoteId: 'seg-1', targetPath: 'transcript.txt', body: '第一段' })
    await seedTextAsset(pool, localRoot, { meetingId: 'm-c8', remoteId: 'seg-2', targetPath: 'transcript_2.txt', body: '第二段' })

    const contents = createContentsStore(pool)
    const deps: ArchiveDeps = { archives, localRoot, nasRoot, contents, getMeeting: stubMeeting, listArchiveRules, listArchiveOverrides: noOverrides }
    const outcome = await archiveMeeting(deps, 'm-c8', '', 58_000, RULES, null)

    expect(outcome.contents.ingested).toBe(2)
    const base = { meetingId: 'm-c8', subMeetingId: '', assetType: 'meeting_summary', fileType: 'txt' }
    expect((await contents.get({ ...base, remoteId: 'seg-1' }))?.content).toBe('第一段')
    expect((await contents.get({ ...base, remoteId: 'seg-2' }))?.content).toBe('第二段')
  })
})
