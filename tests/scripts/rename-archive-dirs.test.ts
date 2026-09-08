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
 * （CHAR_LENGTH 的字符口径、LEFT 前缀匹配、事务回滚），mock 掉等于没测。
 *
 * 唯一 mock 掉的是「写库炸了」那一条：要的是 UPDATE 与 rollback **同时**失败
 * （断连接的真实表现），这个用真库造不出来，见 brokenTxPool。
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

async function withDirs(fn: (localRoot: string, nasRoot: string) => Promise<void>): Promise<void> {
  const localRoot = await mkdtemp(join(tmpdir(), 'mde-local-'))
  const nasRoot = await mkdtemp(join(tmpdir(), 'mde-nas-'))
  try {
    await fn(localRoot, nasRoot)
  } finally {
    await rm(localRoot, { recursive: true, force: true })
    await rm(nasRoot, { recursive: true, force: true })
  }
}

const legacyRel = (subject: string, code: string): string =>
  `2026/09/2026-09-02_0127_${subject}_${code}`
const modernRel = (code: string): string => `2026/09/2026-09-02_0127_${code}`

async function insertMeeting(
  pool: Pool,
  meetingId: string,
  code: string,
  subject: string,
): Promise<void> {
  await pool.execute(
    `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
     VALUES (?, '', ?, ?, 'u', ?, ?, 1, 1)`,
    [meetingId, code, subject, START, START + 1800],
  )
}

async function insertAsset(
  pool: Pool,
  meetingId: string,
  remoteId: string,
  targetPath: string,
): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, created_at, updated_at)
     VALUES (?, '', 'meeting_summary', ?, 'txt', 'completed', ?, 1, 1)`,
    [meetingId, remoteId, targetPath],
  )
}

/** 只有本地目录、从没归档过的会议（meeting_archives 里没有行 → RenameItem.nas 是 null） */
async function seedLocalOnly(
  pool: Pool,
  localRoot: string,
  meetingId: string,
  code: string,
  subject: string,
): Promise<string> {
  const oldRel = legacyRel(subject, code)
  await insertMeeting(pool, meetingId, code, subject)
  await insertAsset(pool, meetingId, 'r1', `${oldRel}/transcript.txt`)
  await mkdir(join(localRoot, oldRel), { recursive: true })
  await writeFile(join(localRoot, oldRel, 'transcript.txt'), 'hello')
  return oldRel
}

/**
 * 完整的一场已归档会议：本地目录 + NAS 目录 + 三张表 + nas_dir 根上的 `_manifest.json`。
 *
 * manifest **不在会议目录里**，在 nas_dir 根上（src/worker/archive.ts 的
 * writeNasSidecars），而且多场会议渲染到同一个 nas_dir 时共用同一份——
 * `otherNasPath` 就是塞进去的「别的会议那一条」，用来钉住「只按前缀改自己那几条」。
 */
async function seed(
  pool: Pool,
  localRoot: string,
  nasDir: string,
  opts: { meetingId?: string; code?: string; subject?: string; otherNasPath?: string } = {},
): Promise<string> {
  const meetingId = opts.meetingId ?? 'm1'
  const code = opts.code ?? '42677674068'
  const subject = opts.subject ?? '硬件早会'
  const oldRel = legacyRel(subject, code)

  await insertMeeting(pool, meetingId, code, subject)
  await insertAsset(pool, meetingId, 'r1', `${oldRel}/transcript.txt`)
  await pool.execute(
    `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
     VALUES (?, '', 'meeting_summary', 'r1', 'txt', ?, ?, ?, 1)`,
    [meetingId, `${oldRel}/transcript.txt`, join(nasDir, oldRel, 'transcript.txt'), 'a'.repeat(64)],
  )
  await pool.execute(
    `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, created_at, updated_at)
     VALUES (?, '', ?, 1, 30, 1, 1)`,
    [meetingId, nasDir],
  )

  await mkdir(join(localRoot, oldRel), { recursive: true })
  await writeFile(join(localRoot, oldRel, 'transcript.txt'), 'hello')
  await mkdir(join(nasDir, oldRel), { recursive: true })
  await writeFile(join(nasDir, oldRel, 'transcript.txt'), 'hello')

  const assets: Array<Record<string, unknown>> = [
    {
      assetType: 'meeting_summary',
      fileName: 'transcript.txt',
      nasPath: join(nasDir, oldRel, 'transcript.txt'),
      nasHash: 'a'.repeat(64),
    },
  ]
  if (opts.otherNasPath !== undefined) {
    assets.push({
      assetType: 'meeting_summary',
      fileName: 'transcript.txt',
      nasPath: opts.otherNasPath,
      nasHash: 'b'.repeat(64),
    })
  }
  await writeFile(
    join(nasDir, '_manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        meetingId,
        subMeetingId: '',
        assets,
        archive: { archivedAt: 1, retentionDays: 30, nasDir },
      },
      null,
      2,
    ),
  )
  return oldRel
}

async function targetPath(pool: Pool, meetingId: string, remoteId: string): Promise<string> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT target_path FROM meeting_assets WHERE meeting_id = ? AND remote_id = ?`,
    [meetingId, remoteId],
  )
  return rows[0]!.target_path
}

/**
 * UPDATE 与 rollback **一起**失败的连接池。断掉的连接就是这个样子：语句发不出去，
 * 回滚同样发不出去。这一条是 applyOne 那段错误处理的全部理由——rollback 抛出去的话，
 * 目录回滚一步都跑不到。
 */
function brokenTxPool(): Pool {
  return {
    getConnection: async () => ({
      beginTransaction: async (): Promise<void> => {},
      execute: async (): Promise<never> => {
        throw new Error('boom: connection lost')
      },
      commit: async (): Promise<void> => {},
      rollback: async (): Promise<never> => {
        throw new Error('rollback also failed')
      },
      release: (): void => {},
    }),
  } as unknown as Pool
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

test('plan + apply：本地与 NAS 目录改名，三张表的路径同步，nas_dir 根上的 manifest 只改自己那一条；再跑一次是 already_done', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      // 同一份 manifest 里还躺着另一场会议的条目，改名不该碰它
      const otherNasPath = join(nasDir, '2026/09/2026-09-02_0900_别的会_99999999999/x.txt')
      const oldRel = await seed(pool, localRoot, nasDir, { otherNasPath })
      const newRel = modernRel('42677674068')

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(1)
      expect(plan[0]!.oldRel).toBe(oldRel)
      expect(plan[0]!.newRel).toBe(newRel)
      expect(plan[0]!.local.exists).toBe(true)
      expect(plan[0]!.nas!.exists).toBe(true)
      expect(plan[0]!.nas!.dir).toBe(nasDir)
      expect(plan[0]!.duplicate).toBe(false)

      expect(await applyOne(pool, plan[0]!)).toBe('renamed')

      await stat(join(localRoot, newRel, 'transcript.txt'))
      await stat(join(nasDir, newRel, 'transcript.txt'))
      await expect(stat(join(localRoot, oldRel))).rejects.toThrow()

      expect(await targetPath(pool, 'm1', 'r1')).toBe(`${newRel}/transcript.txt`)
      const [aa] = await pool.execute<RowDataPacket[]>(
        `SELECT local_path, nas_path FROM archived_assets WHERE meeting_id='m1'`,
      )
      expect(aa[0]!.local_path).toBe(`${newRel}/transcript.txt`)
      expect(aa[0]!.nas_path).toBe(join(nasDir, newRel, 'transcript.txt'))

      // manifest 在 nas_dir 根上，不在会议目录里
      const manifest = JSON.parse(await readFile(join(nasDir, '_manifest.json'), 'utf8'))
      expect(manifest.assets[0].nasPath).toBe(join(nasDir, newRel, 'transcript.txt'))
      expect(manifest.assets[1].nasPath).toBe(otherNasPath)
      // 写的是 .tmp 再 rename 盖过去（写到一半断掉不会留下一份被截断的 JSON——
      // 这一份是几百场会议共用的）。跑完 .tmp 必须不在了，别在 NAS 根上留垃圾
      await expect(stat(join(nasDir, '_manifest.json.tmp'))).rejects.toThrow()

      const again = await planRenames(pool, localRoot)
      expect(again[0]!.local.exists).toBe(false)
      expect(again[0]!.nas!.exists).toBe(false)
      expect(await applyOne(pool, again[0]!)).toBe('already_done')
    })
  })
})

test('目标目录已存在时报 conflict，不动任何东西', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const oldRel = await seed(pool, localRoot, join(nasRoot, 'all'))
      await mkdir(join(localRoot, modernRel('42677674068')), { recursive: true })
      const plan = await planRenames(pool, localRoot)
      expect(await applyOne(pool, plan[0]!)).toBe('conflict')
      await stat(join(localRoot, oldRel, 'transcript.txt'))
      expect(await targetPath(pool, 'm1', 'r1')).toBe(`${oldRel}/transcript.txt`)
    })
  })
})

test('写库失败（连回滚都失败）时目录改回旧名、库里一列没动，原始错误照抛', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      const oldRel = await seed(pool, localRoot, nasDir)
      const newRel = modernRel('42677674068')

      const plan = await planRenames(pool, localRoot)
      // 抛的必须是 UPDATE 那个错，不是 rollback 那个——被盖掉的话原因就查不出来了
      await expect(applyOne(brokenTxPool(), plan[0]!)).rejects.toThrow('boom: connection lost')

      // 两边目录都回到旧名字
      await stat(join(localRoot, oldRel, 'transcript.txt'))
      await stat(join(nasDir, oldRel, 'transcript.txt'))
      await expect(stat(join(localRoot, newRel))).rejects.toThrow()
      await expect(stat(join(nasDir, newRel))).rejects.toThrow()

      // 库里一列没动
      expect(await targetPath(pool, 'm1', 'r1')).toBe(`${oldRel}/transcript.txt`)
      const [aa] = await pool.execute<RowDataPacket[]>(
        `SELECT local_path, nas_path FROM archived_assets WHERE meeting_id='m1'`,
      )
      expect(aa[0]!.local_path).toBe(`${oldRel}/transcript.txt`)
      expect(aa[0]!.nas_path).toBe(join(nasDir, oldRel, 'transcript.txt'))

      // 回滚干净了，重跑照样能改
      const retry = await planRenames(pool, localRoot)
      expect(await applyOne(pool, retry[0]!)).toBe('renamed')
    })
  })
})

test('两场会议算出同一个旧目录时全体 conflict，一个都不动', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      // subject / start_time / meeting_code 三者全同 → 同一个 oldRel
      const oldRel = await seedLocalOnly(pool, localRoot, 'm1', '42677674068', '硬件早会')
      await insertMeeting(pool, 'm2', '42677674068', '硬件早会')
      await insertAsset(pool, 'm2', 'r1', `${oldRel}/notes.txt`)

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(2)
      expect(plan.every((i) => i.duplicate)).toBe(true)
      expect(await applyOne(pool, plan[0]!)).toBe('conflict')
      expect(await applyOne(pool, plan[1]!)).toBe('conflict')

      await stat(join(localRoot, oldRel, 'transcript.txt'))
      await expect(stat(join(localRoot, modernRel('42677674068')))).rejects.toThrow()
      expect(await targetPath(pool, 'm1', 'r1')).toBe(`${oldRel}/transcript.txt`)
      expect(await targetPath(pool, 'm2', 'r1')).toBe(`${oldRel}/notes.txt`)
    })
  })
})

test('前缀替换按 MySQL 字符数算（emoji 主题），且下划线不当 LIKE 通配符用', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      // (a) emoji：JS 里 2 个码元、MySQL 里 1 个字符。拿 JS 长度当 SUBSTRING 起点
      //     会把 transcript.txt 切成 ranscript.txt
      const emojiOld = await seedLocalOnly(pool, localRoot, 'm2', '42677674069', '早会🚀')

      // (b) 下划线：这一行落在另一个目录下，但在 LIKE 语义里会被 `…_0127_硬件早会_…/%` 匹上
      const decoyOld = await seedLocalOnly(pool, localRoot, 'm1', '42677674068', '硬件早会')
      const decoyPath = '2026/09/2026-09-02X0127X硬件早会X42677674068/notes.txt'
      expect(decoyPath.length).toBe(`${decoyOld}/notes.txt`.length) // 长度相同才谈得上被通配符匹上
      await insertAsset(pool, 'm1', 'r2', decoyPath)

      const plan = await planRenames(pool, localRoot)
      for (const item of plan) expect(await applyOne(pool, item)).toBe('renamed')

      expect(await targetPath(pool, 'm2', 'r1')).toBe(`${modernRel('42677674069')}/transcript.txt`)
      expect(await targetPath(pool, 'm1', 'r1')).toBe(`${modernRel('42677674068')}/transcript.txt`)
      expect(await targetPath(pool, 'm1', 'r2')).toBe(decoyPath) // 一个字都没变
      await stat(join(localRoot, modernRel('42677674069'), 'transcript.txt'))
      expect(emojiOld).toBe('2026/09/2026-09-02_0127_早会🚀_42677674069')
    })
  })
})

test('从没归档过的会议只改本地与 meeting_assets；本地与 NAS 上都找不到时报 not_found', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedLocalOnly(pool, localRoot, 'm1', '42677674068', '硬件早会')
      // m2 只有库里一行，磁盘上什么都没有
      await insertMeeting(pool, 'm2', '42677674069', '早会二')

      const plan = await planRenames(pool, localRoot)
      const [never, gone] = plan
      expect(never!.nas).toBeNull()
      expect(gone!.nas).toBeNull()

      expect(await applyOne(pool, never!)).toBe('renamed')
      await stat(join(localRoot, modernRel('42677674068'), 'transcript.txt'))
      expect(await targetPath(pool, 'm1', 'r1')).toBe(`${modernRel('42677674068')}/transcript.txt`)

      expect(await applyOne(pool, gone!)).toBe('not_found')
    })
  })
})
