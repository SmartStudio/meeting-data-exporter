import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { withTestDb } from '../helpers/testdb'
import {
  applyOne,
  legacyMeetingDirPath,
  parseArgs,
  planRenames,
} from '../../scripts/rename-archive-dirs'
import type { Pool } from '../../src/store/db'

/**
 * 与 store 层同一条约定：不 mock 数据库。这个脚本的全部风险都在「目录改名」与
 * 「三列路径前缀替换」这两件事**必须一起成/一起不成**上，而后者是 SQL 语义
 * （CHAR_LENGTH 的字符口径、事务回滚），mock 掉等于没测。
 */

const START = Date.UTC(2026, 8, 2, 1, 27) / 1000 // 2026-09-02 01:27 UTC

/** 与 tests/store/contents.test.ts 同款：withTestDb() 返回 { pool, cleanup }，不吃回调 */
async function withDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try {
    await fn(pool)
  } finally {
    await cleanup()
  }
}

async function seed(pool: Pool, localRoot: string, nasDir: string): Promise<string> {
  await pool.execute(
    `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
     VALUES ('m1', '', '42677674068', '硬件早会', 'u', ?, ?, 1, 1)`,
    [START, START + 1800],
  )
  const oldRel = '2026/09/2026-09-02_0127_硬件早会_42677674068'
  await pool.execute(
    `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, created_at, updated_at)
     VALUES ('m1', '', 'meeting_summary', 'r1', 'txt', 'completed', ?, 1, 1)`,
    [`${oldRel}/transcript.txt`],
  )
  await pool.execute(
    `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
     VALUES ('m1', '', 'meeting_summary', 'r1', 'txt', ?, ?, ?, 1)`,
    [`${oldRel}/transcript.txt`, join(nasDir, oldRel, 'transcript.txt'), 'a'.repeat(64)],
  )
  await pool.execute(
    `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, created_at, updated_at)
     VALUES ('m1', '', ?, 1, 30, 1, 1)`,
    [nasDir],
  )
  await mkdir(join(localRoot, oldRel), { recursive: true })
  await writeFile(join(localRoot, oldRel, 'transcript.txt'), 'hello')
  await mkdir(join(nasDir, oldRel), { recursive: true })
  await writeFile(join(nasDir, oldRel, 'transcript.txt'), 'hello')
  await writeFile(
    join(nasDir, oldRel, '_manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        meetingId: 'm1',
        subMeetingId: '',
        assets: [
          {
            assetType: 'meeting_summary',
            fileName: 'transcript.txt',
            nasPath: join(nasDir, oldRel, 'transcript.txt'),
            nasHash: 'a'.repeat(64),
          },
        ],
        archive: { archivedAt: 1, retentionDays: 30, nasDir },
      },
      null,
      2,
    ),
  )
  return oldRel
}

test('parseArgs：默认 dry-run，--apply 才动手', () => {
  expect(parseArgs([])).toEqual({ apply: false })
  expect(parseArgs(['--apply'])).toEqual({ apply: true })
})

test('legacyMeetingDirPath 复现 2026-09-08 之前的目录名', () => {
  expect(
    legacyMeetingDirPath(
      { subject: '硬件早会', startTime: START, meetingCode: '42677674068' },
      'm1',
    ),
  ).toBe('2026/09/2026-09-02_0127_硬件早会_42677674068')
})

test('plan + apply：本地与 NAS 目录改名，三张表的路径同步，manifest 的 nasPath 重写；再跑一次无事可做', async () => {
  await withDb(async (pool) => {
    const localRoot = await mkdtemp(join(tmpdir(), 'mde-local-'))
    const nasRoot = await mkdtemp(join(tmpdir(), 'mde-nas-'))
    const nasDir = join(nasRoot, 'all')
    try {
      const oldRel = await seed(pool, localRoot, nasDir)
      const newRel = '2026/09/2026-09-02_0127_42677674068'

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(1)
      expect(plan[0]!.oldRel).toBe(oldRel)
      expect(plan[0]!.newRel).toBe(newRel)
      expect(plan[0]!.local.exists).toBe(true)
      expect(plan[0]!.nas!.exists).toBe(true)

      expect(await applyOne(pool, plan[0]!)).toBe('renamed')

      await stat(join(localRoot, newRel, 'transcript.txt'))
      await stat(join(nasDir, newRel, 'transcript.txt'))
      await expect(stat(join(localRoot, oldRel))).rejects.toThrow()

      const [ma] = await pool.execute<RowDataPacket[]>(
        `SELECT target_path FROM meeting_assets WHERE meeting_id='m1'`,
      )
      expect(ma[0]!.target_path).toBe(`${newRel}/transcript.txt`)
      const [aa] = await pool.execute<RowDataPacket[]>(
        `SELECT local_path, nas_path FROM archived_assets WHERE meeting_id='m1'`,
      )
      expect(aa[0]!.local_path).toBe(`${newRel}/transcript.txt`)
      expect(aa[0]!.nas_path).toBe(join(nasDir, newRel, 'transcript.txt'))

      const manifest = JSON.parse(await readFile(join(nasDir, newRel, '_manifest.json'), 'utf8'))
      expect(manifest.assets[0].nasPath).toBe(join(nasDir, newRel, 'transcript.txt'))

      const again = await planRenames(pool, localRoot)
      expect(again[0]!.local.exists).toBe(false)
      expect(again[0]!.nas!.exists).toBe(false)
      expect(await applyOne(pool, again[0]!)).toBe('skipped_nothing_to_do')
    } finally {
      await rm(localRoot, { recursive: true, force: true })
      await rm(nasRoot, { recursive: true, force: true })
    }
  })
})

test('目标目录已存在时报 conflict，不动任何东西', async () => {
  await withDb(async (pool) => {
    const localRoot = await mkdtemp(join(tmpdir(), 'mde-local-'))
    const nasRoot = await mkdtemp(join(tmpdir(), 'mde-nas-'))
    try {
      const oldRel = await seed(pool, localRoot, join(nasRoot, 'all'))
      await mkdir(join(localRoot, '2026/09/2026-09-02_0127_42677674068'), { recursive: true })
      const plan = await planRenames(pool, localRoot)
      expect(await applyOne(pool, plan[0]!)).toBe('conflict')
      await stat(join(localRoot, oldRel, 'transcript.txt'))
      const [ma] = await pool.execute<RowDataPacket[]>(
        `SELECT target_path FROM meeting_assets WHERE meeting_id='m1'`,
      )
      expect(ma[0]!.target_path).toBe(`${oldRel}/transcript.txt`)
    } finally {
      await rm(localRoot, { recursive: true, force: true })
      await rm(nasRoot, { recursive: true, force: true })
    }
  })
})
