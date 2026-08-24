import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { withTestDb } from '../helpers/testdb'
import { createArchivesStore, type ArchivesStore } from '../../src/store/archives'
import { archiveMeeting, type ArchiveDeps } from '../../src/worker/archive'
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
  } = input
  await pool.execute(
    `INSERT INTO meeting_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, bytes_written, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?, 0, 1000, 1000)`,
    [meetingId, subMeetingId, assetType, remoteId, fileType, targetPath],
  )
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

    const deps: ArchiveDeps = { archives, localRoot, nasRoot }
    const outcome = await archiveMeeting(deps, 'm-1', '', 5000)

    expect(outcome).toEqual({
      meetingId: 'm-1',
      subMeetingId: '',
      newlyArchived: 1,
      verificationFailed: 0,
      fullyArchived: true,
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

    const deps: ArchiveDeps = { archives, localRoot, nasRoot }
    const outcome = await archiveMeeting(deps, 'm-2', '', ARCHIVED_AT)

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
    expect(rec?.nasDir).toBe(join(nasRoot, '2026', '08', 'm-2'))
  })
})

test('用例2b：default_retention_days 设置后，新归档的会议采用该设置而不是硬编码默认值', async () => {
  await withRig(async ({ pool, localRoot, nasRoot, archives }) => {
    await archives.setSetting('default_retention_days', '90', 1000)
    await seedCompletedAsset(pool, { meetingId: 'm-2b', targetPath: 'a.txt' })
    await writeLocalFile(localRoot, 'a.txt', 'x')

    const deps: ArchiveDeps = { archives, localRoot, nasRoot }
    await archiveMeeting(deps, 'm-2b', '', 6000)

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

    const deps: ArchiveDeps = { archives, localRoot, nasRoot, hashFile }
    const outcome = await archiveMeeting(deps, 'm-3', '', 7000)

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

    const deps: ArchiveDeps = { archives, localRoot, nasRoot }
    const first = await archiveMeeting(deps, 'm-4', '', 8000)
    expect(first.newlyArchived).toBe(1)
    expect(first.fullyArchived).toBe(true)
    expect(await archives.countArchivedAssets('m-4', '')).toBe(1)

    const second = await archiveMeeting(deps, 'm-4', '', 8500)
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

    const deps: ArchiveDeps = { archives, localRoot, nasRoot }
    const round1 = await archiveMeeting(deps, 'm-5', '', 9000)
    expect(round1.newlyArchived).toBe(1)
    expect(round1.verificationFailed).toBe(0)

    // 第二轮之前，B 的下载才完成——补上它的 completed 行与本地文件
    await seedCompletedAsset(pool, { meetingId: 'm-5', assetType: 'meeting_summary', remoteId: 'r-b', fileType: 'txt', targetPath: 'b.txt' })
    await writeLocalFile(localRoot, 'b.txt', 'asset B content')

    const round2 = await archiveMeeting(deps, 'm-5', '', 9500)
    expect(round2.newlyArchived).toBe(1) // 只有 B 是新的；A 被 isAssetArchived 挡住不重复归档
    expect(round2.verificationFailed).toBe(0)
    expect(round2.fullyArchived).toBe(true)

    expect(await archives.countArchivedAssets('m-5', '')).toBe(2)
    const rec = await archives.findMeetingArchive('m-5', '')
    expect(rec).not.toBeNull()
    expect(rec?.archivedAt).toBe(9500) // 反映"最终真正凑齐"的那一轮
  })
})
