import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { withTestDb } from '../helpers/testdb'
import {
  applyOne,
  legacyMeetingDirPath,
  newRelFromLegacyRel,
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

// ─────────────────────────────────────────────────────────────────────────────
// 路径驱动的第二遍：周期性会议的旧实例目录不在 meetings 行里
// ─────────────────────────────────────────────────────────────────────────────

const RECUR_START = Date.UTC(2026, 8, 4, 1, 27) / 1000 // 2026-09-04 01:27 UTC

async function insertMeetingAt(
  pool: Pool,
  meetingId: string,
  code: string,
  subject: string,
  startTime: number,
): Promise<void> {
  await pool.execute(
    `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
     VALUES (?, '', ?, ?, 'u', ?, ?, 1, 1)`,
    [meetingId, code, subject, startTime, startTime + 1800],
  )
}

async function insertArchive(pool: Pool, meetingId: string, nasDir: string): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, created_at, updated_at)
     VALUES (?, '', ?, 1, 30, 1, 1)`,
    [meetingId, nasDir],
  )
}

async function insertArchivedAsset(
  pool: Pool,
  meetingId: string,
  remoteId: string,
  localPath: string,
  nasPath: string,
): Promise<void> {
  await pool.execute(
    `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
     VALUES (?, '', 'meeting_summary', ?, 'txt', ?, ?, ?, 1)`,
    [meetingId, remoteId, localPath, nasPath, 'a'.repeat(64)],
  )
}

async function writeManifest(
  nasDir: string,
  meetingId: string,
  nasPaths: string[],
): Promise<void> {
  await writeFile(
    join(nasDir, '_manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        meetingId,
        subMeetingId: '',
        assets: nasPaths.map((p) => ({
          assetType: 'meeting_summary',
          fileName: 'transcript.txt',
          nasPath: p,
          nasHash: 'a'.repeat(64),
        })),
        archive: { archivedAt: 1, retentionDays: 30, nasDir },
      },
      null,
      2,
    ),
  )
}

async function localPathOf(pool: Pool, meetingId: string, remoteId: string): Promise<string> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT local_path FROM archived_assets WHERE meeting_id = ? AND remote_id = ?`,
    [meetingId, remoteId],
  )
  return rows[0]!.local_path
}

async function nasPathOf(pool: Pool, meetingId: string, remoteId: string): Promise<string> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT nas_path FROM archived_assets WHERE meeting_id = ? AND remote_id = ?`,
    [meetingId, remoteId],
  )
  return rows[0]!.nas_path
}

test('newRelFromLegacyRel：主题段可以带下划线，新格式不匹配', () => {
  expect(newRelFromLegacyRel('2026/09/2026-09-02_0127_硬件早会_42677674068')).toBe(
    '2026/09/2026-09-02_0127_42677674068',
  )
  // 主题里带 `_`：贪婪匹配把最后一段留给会议号
  expect(newRelFromLegacyRel('2026/09/2026-09-05_0900_转写_即服务项目开发日会_42677674070')).toBe(
    '2026/09/2026-09-05_0900_42677674070',
  )
  // 已经是新格式：只有一段尾巴，不该被再改一次
  expect(newRelFromLegacyRel('2026/09/2026-09-02_0127_42677674068')).toBeNull()
  expect(newRelFromLegacyRel('2026/09/2026-09-02_0127_m1')).toBeNull()
  // 不是三段式目录前缀
  expect(newRelFromLegacyRel('2026/09')).toBeNull()
  expect(newRelFromLegacyRel('2026/09/别的东西_x_y')).toBeNull()
})

test('周期性会议：meetings 行只剩最新一场，旧实例目录靠路径列找出来并逐个改名', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      const insts = [
        {
          rid: 'r0902',
          old: '2026/09/2026-09-02_0127_硬件早会_42677674068',
          neu: '2026/09/2026-09-02_0127_42677674068',
        },
        {
          rid: 'r0903',
          old: '2026/09/2026-09-03_0126_硬件早会_42677674068',
          neu: '2026/09/2026-09-03_0126_42677674068',
        },
        {
          rid: 'r0904',
          old: '2026/09/2026-09-04_0127_硬件早会_42677674068',
          neu: '2026/09/2026-09-04_0127_42677674068',
        },
      ]
      // meetings 行被 upsertMeeting 反复覆盖，只描述最新那一场（09-04）
      await insertMeetingAt(pool, 'm1', '42677674068', '硬件早会', RECUR_START)
      await insertArchive(pool, 'm1', nasDir)
      for (const i of insts) {
        await insertAsset(pool, 'm1', i.rid, `${i.old}/transcript.txt`)
        await insertArchivedAsset(
          pool,
          'm1',
          i.rid,
          `${i.old}/transcript.txt`,
          join(nasDir, i.old, 'transcript.txt'),
        )
        await mkdir(join(localRoot, i.old), { recursive: true })
        await writeFile(join(localRoot, i.old, 'transcript.txt'), 'hello')
        await mkdir(join(nasDir, i.old), { recursive: true })
        await writeFile(join(nasDir, i.old, 'transcript.txt'), 'hello')
      }
      const otherNasPath = join(nasDir, '2026/09/2026-09-02_0900_别的会_99999999999/x.txt')
      await writeManifest(nasDir, 'm1', [
        ...insts.map((i) => join(nasDir, i.old, 'transcript.txt')),
        otherNasPath,
      ])

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(3)
      expect(plan.map((i) => i.oldRel).sort()).toEqual(insts.map((i) => i.old).sort())
      // meetings 行只覆盖了 09-04，另外两场是路径驱动那一遍找出来的
      const bySource = new Map(plan.map((i) => [i.oldRel, i.source]))
      expect(bySource.get(insts[2]!.old)).toBe('meeting')
      expect(bySource.get(insts[0]!.old)).toBe('path')
      expect(bySource.get(insts[1]!.old)).toBe('path')
      expect(plan.every((i) => i.duplicate)).toBe(false)
      for (const i of plan) expect(i.nas!.dir).toBe(nasDir)

      // 三场会议 key 完全相同，前缀替换必须按前缀各改各的：先只改第一场
      const first = plan.find((i) => i.oldRel === insts[0]!.old)!
      expect(await applyOne(pool, first)).toBe('renamed')
      expect(await targetPath(pool, 'm1', 'r0902')).toBe(`${insts[0]!.neu}/transcript.txt`)
      expect(await targetPath(pool, 'm1', 'r0903')).toBe(`${insts[1]!.old}/transcript.txt`)
      expect(await targetPath(pool, 'm1', 'r0904')).toBe(`${insts[2]!.old}/transcript.txt`)
      expect(await nasPathOf(pool, 'm1', 'r0903')).toBe(join(nasDir, insts[1]!.old, 'transcript.txt'))

      for (const item of plan) {
        if (item === first) continue
        expect(await applyOne(pool, item)).toBe('renamed')
      }

      for (const i of insts) {
        await stat(join(localRoot, i.neu, 'transcript.txt'))
        await stat(join(nasDir, i.neu, 'transcript.txt'))
        await expect(stat(join(localRoot, i.old))).rejects.toThrow()
        await expect(stat(join(nasDir, i.old))).rejects.toThrow()
        expect(await targetPath(pool, 'm1', i.rid)).toBe(`${i.neu}/transcript.txt`)
        expect(await localPathOf(pool, 'm1', i.rid)).toBe(`${i.neu}/transcript.txt`)
        expect(await nasPathOf(pool, 'm1', i.rid)).toBe(join(nasDir, i.neu, 'transcript.txt'))
      }

      const manifest = JSON.parse(await readFile(join(nasDir, '_manifest.json'), 'utf8'))
      expect(manifest.assets.map((a: { nasPath: string }) => a.nasPath)).toEqual([
        ...insts.map((i) => join(nasDir, i.neu, 'transcript.txt')),
        otherNasPath, // 别的会议那一条一个字没动
      ])

      // 再跑一遍：库里已经全是新前缀，路径驱动那一遍再也找不到东西，
      // 只剩 meetings 行那一场，判 already_done
      const again = await planRenames(pool, localRoot)
      expect(again).toHaveLength(1)
      expect(again[0]!.source).toBe('meeting')
      expect(again[0]!.oldRel).toBe(insts[2]!.old)
      expect(await applyOne(pool, again[0]!)).toBe('already_done')
    })
  })
})

test('路径驱动那一遍：主题段带下划线时新目录名只留会议号', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      const subject = '转写_即服务项目开发日会'
      const code = '42677674070'
      const rowStart = Date.UTC(2026, 8, 5, 9, 0) / 1000
      await insertMeetingAt(pool, 'm1', code, subject, rowStart)
      const rowOld = `2026/09/2026-09-05_0900_${subject}_${code}`
      const orphanOld = `2026/09/2026-09-06_0900_${subject}_${code}`
      for (const [rid, rel] of [
        ['r1', rowOld],
        ['r2', orphanOld],
      ] as const) {
        await insertAsset(pool, 'm1', rid, `${rel}/transcript.txt`)
        await mkdir(join(localRoot, rel), { recursive: true })
        await writeFile(join(localRoot, rel, 'transcript.txt'), 'hello')
      }

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(2)
      const orphan = plan.find((i) => i.oldRel === orphanOld)!
      expect(orphan.source).toBe('path')
      expect(orphan.newRel).toBe(`2026/09/2026-09-06_0900_${code}`)
      expect(orphan.nas).toBeNull() // 没有 meeting_archives 行

      for (const item of plan) expect(await applyOne(pool, item)).toBe('renamed')
      expect(await targetPath(pool, 'm1', 'r1')).toBe(`2026/09/2026-09-05_0900_${code}/transcript.txt`)
      expect(await targetPath(pool, 'm1', 'r2')).toBe(`2026/09/2026-09-06_0900_${code}/transcript.txt`)
      await stat(join(localRoot, `2026/09/2026-09-06_0900_${code}`, 'transcript.txt'))
    })
  })
})

test('已经是新格式的路径不会被路径驱动那一遍再排一次', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      const newRel = modernRel('42677674068')
      await insertMeeting(pool, 'm1', '42677674068', '硬件早会')
      await insertArchive(pool, 'm1', nasDir)
      await insertAsset(pool, 'm1', 'r1', `${newRel}/transcript.txt`)
      await insertArchivedAsset(
        pool,
        'm1',
        'r1',
        `${newRel}/transcript.txt`,
        join(nasDir, newRel, 'transcript.txt'),
      )

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(1) // 只有 meetings 行那一场
      expect(plan[0]!.source).toBe('meeting')
      expect(plan[0]!.oldRel).toBe(legacyRel('硬件早会', '42677674068'))
    })
  })
})

test('本地已清理、只剩 archived_assets 的会议照样被找出来（含只有 nas_path 还是旧前缀的情形）', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      await insertMeetingAt(pool, 'm1', '42677674068', '硬件早会', START)
      await insertArchive(pool, 'm1', nasDir)

      // (a) 本地文件被到期清理掉了：meeting_assets.target_path 为 NULL，
      //     archived_assets 两列都还在旧前缀上，本地目录不在、NAS 目录还在
      const purgedOld = '2026/09/2026-09-01_0127_硬件早会_42677674068'
      const purgedNew = '2026/09/2026-09-01_0127_42677674068'
      await pool.execute(
        `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, created_at, updated_at)
         VALUES (?, '', 'meeting_summary', 'rp', 'txt', 'completed', NULL, 1, 1)`,
        ['m1'],
      )
      await insertArchivedAsset(
        pool,
        'm1',
        'rp',
        `${purgedOld}/transcript.txt`,
        join(nasDir, purgedOld, 'transcript.txt'),
      )
      await mkdir(join(nasDir, purgedOld), { recursive: true })
      await writeFile(join(nasDir, purgedOld, 'transcript.txt'), 'hello')

      // (b) local_path 被人工改过、只剩 nas_path 还是旧前缀：NAS 那一列是独立的一列，
      //     漏掉它的话 NAS 上的目录就没人改了
      const nasOnlyOld = '2026/08/2026-08-31_0800_硬件早会_42677674068'
      const nasOnlyNew = '2026/08/2026-08-31_0800_42677674068'
      await insertArchivedAsset(
        pool,
        'm1',
        'rn',
        `${nasOnlyNew}/transcript.txt`,
        join(nasDir, nasOnlyOld, 'transcript.txt'),
      )
      await mkdir(join(nasDir, nasOnlyOld), { recursive: true })
      await writeFile(join(nasDir, nasOnlyOld, 'transcript.txt'), 'hello')

      const plan = await planRenames(pool, localRoot)
      const purged = plan.find((i) => i.oldRel === purgedOld)!
      expect(purged.source).toBe('path')
      expect(purged.local.exists).toBe(false)
      expect(purged.nas!.exists).toBe(true)
      expect(await applyOne(pool, purged)).toBe('renamed')
      await stat(join(nasDir, purgedNew, 'transcript.txt'))
      expect(await localPathOf(pool, 'm1', 'rp')).toBe(`${purgedNew}/transcript.txt`)
      expect(await nasPathOf(pool, 'm1', 'rp')).toBe(join(nasDir, purgedNew, 'transcript.txt'))

      const nasOnly = plan.find((i) => i.oldRel === nasOnlyOld)!
      expect(nasOnly.source).toBe('path')
      expect(await applyOne(pool, nasOnly)).toBe('renamed')
      await stat(join(nasDir, nasOnlyNew, 'transcript.txt'))
      expect(await nasPathOf(pool, 'm1', 'rn')).toBe(join(nasDir, nasOnlyNew, 'transcript.txt'))
      expect(await localPathOf(pool, 'm1', 'rn')).toBe(`${nasOnlyNew}/transcript.txt`)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 归档半途中断：有 archived_assets 行、没有 meeting_archives 行
// （assets 拷完了、upsertMeetingArchive 之前断掉）。NAS 基准目录只能从 nas_path 反推。
// ─────────────────────────────────────────────────────────────────────────────

test('没有 meeting_archives 行时，路径驱动那一遍从 nas_path 反推 NAS 基准目录', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      // meetings 行只描述最新那一场（09-04），断在半路的是 09-02 那一场
      await insertMeetingAt(pool, 'm1', '42677674068', '硬件早会', RECUR_START)
      const oldRel = '2026/09/2026-09-02_0127_硬件早会_42677674068'
      const newRel = '2026/09/2026-09-02_0127_42677674068'

      // 上一轮跑本脚本时 nas 为 null，本地已经改成新格式、NAS 那边原地没动
      await insertArchivedAsset(
        pool,
        'm1',
        'r1',
        `${newRel}/transcript.txt`,
        join(nasDir, oldRel, 'transcript.txt'),
      )
      await mkdir(join(localRoot, newRel), { recursive: true })
      await writeFile(join(localRoot, newRel, 'transcript.txt'), 'hello')
      await mkdir(join(nasDir, oldRel), { recursive: true })
      await writeFile(join(nasDir, oldRel, 'transcript.txt'), 'hello')
      await writeManifest(nasDir, 'm1', [join(nasDir, oldRel, 'transcript.txt')])

      const plan = await planRenames(pool, localRoot)
      const item = plan.find((i) => i.oldRel === oldRel)!
      expect(item.source).toBe('path')
      expect(item.nas).not.toBeNull()
      expect(item.nas!.dir).toBe(nasDir) // 从 nas_path 反推，不是从 meeting_archives 来的
      expect(item.nas!.exists).toBe(true)
      expect(item.local.exists).toBe(false)

      expect(await applyOne(pool, item)).toBe('renamed')
      await stat(join(nasDir, newRel, 'transcript.txt'))
      await expect(stat(join(nasDir, oldRel))).rejects.toThrow()
      expect(await nasPathOf(pool, 'm1', 'r1')).toBe(join(nasDir, newRel, 'transcript.txt'))
      const manifest = JSON.parse(await readFile(join(nasDir, '_manifest.json'), 'utf8'))
      expect(manifest.assets[0].nasPath).toBe(join(nasDir, newRel, 'transcript.txt'))

      // 自消耗：库里已经是新前缀，再跑一遍这一条不再出现
      const again = await planRenames(pool, localRoot)
      expect(again.find((i) => i.oldRel === oldRel)).toBeUndefined()
    })
  })
})

test('没有 meeting_archives 行时，会议驱动那一遍也用反推出来的基准目录：本地与 NAS 一条搞定', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      const oldRel = legacyRel('硬件早会', '42677674068')
      const newRel = modernRel('42677674068')

      await insertMeeting(pool, 'm1', '42677674068', '硬件早会')
      await insertAsset(pool, 'm1', 'r1', `${oldRel}/transcript.txt`)
      await insertArchivedAsset(
        pool,
        'm1',
        'r1',
        `${oldRel}/transcript.txt`,
        join(nasDir, oldRel, 'transcript.txt'),
      )
      // 注意：故意不插 meeting_archives 行
      await mkdir(join(localRoot, oldRel), { recursive: true })
      await writeFile(join(localRoot, oldRel, 'transcript.txt'), 'hello')
      await mkdir(join(nasDir, oldRel), { recursive: true })
      await writeFile(join(nasDir, oldRel, 'transcript.txt'), 'hello')
      await writeManifest(nasDir, 'm1', [join(nasDir, oldRel, 'transcript.txt')])

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(1)
      expect(plan[0]!.source).toBe('meeting')
      expect(plan[0]!.nas!.dir).toBe(nasDir)
      expect(plan[0]!.local.exists).toBe(true)
      expect(plan[0]!.nas!.exists).toBe(true)

      expect(await applyOne(pool, plan[0]!)).toBe('renamed')
      await stat(join(localRoot, newRel, 'transcript.txt'))
      await stat(join(nasDir, newRel, 'transcript.txt'))
      expect(await targetPath(pool, 'm1', 'r1')).toBe(`${newRel}/transcript.txt`)
      expect(await localPathOf(pool, 'm1', 'r1')).toBe(`${newRel}/transcript.txt`)
      expect(await nasPathOf(pool, 'm1', 'r1')).toBe(join(nasDir, newRel, 'transcript.txt'))
      const manifest = JSON.parse(await readFile(join(nasDir, '_manifest.json'), 'utf8'))
      expect(manifest.assets[0].nasPath).toBe(join(nasDir, newRel, 'transcript.txt'))

      const again = await planRenames(pool, localRoot)
      expect(again).toHaveLength(1)
      expect(await applyOne(pool, again[0]!)).toBe('already_done')
    })
  })
})

test('反推出的基准目录与 meeting_archives.nas_dir 不一致 → conflict，一个字都不动', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      const strayDir = join(nasRoot, 'other')
      await insertMeetingAt(pool, 'm1', '42677674068', '硬件早会', RECUR_START)
      await insertArchive(pool, 'm1', nasDir)

      const oldRel = '2026/09/2026-09-02_0127_硬件早会_42677674068'
      await insertArchivedAsset(
        pool,
        'm1',
        'r1',
        `${oldRel}/transcript.txt`,
        join(strayDir, oldRel, 'transcript.txt'),
      )
      await mkdir(join(localRoot, oldRel), { recursive: true })
      await writeFile(join(localRoot, oldRel, 'transcript.txt'), 'hello')
      await mkdir(join(strayDir, oldRel), { recursive: true })
      await writeFile(join(strayDir, oldRel, 'transcript.txt'), 'hello')

      const plan = await planRenames(pool, localRoot)
      const item = plan.find((i) => i.oldRel === oldRel)!
      expect(item.conflictReason).not.toBeNull()
      expect(await applyOne(pool, item)).toBe('conflict')

      await stat(join(localRoot, oldRel, 'transcript.txt'))
      await stat(join(strayDir, oldRel, 'transcript.txt'))
      await expect(stat(join(localRoot, '2026/09/2026-09-02_0127_42677674068'))).rejects.toThrow()
      expect(await localPathOf(pool, 'm1', 'r1')).toBe(`${oldRel}/transcript.txt`)
      expect(await nasPathOf(pool, 'm1', 'r1')).toBe(join(strayDir, oldRel, 'transcript.txt'))
    })
  })
})

test('同一场会议的 archived_assets 行反推出两个不同的基准目录 → conflict', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const oldRel = legacyRel('硬件早会', '42677674068')
      await insertMeeting(pool, 'm1', '42677674068', '硬件早会')
      await insertAsset(pool, 'm1', 'r1', `${oldRel}/transcript.txt`)
      // 没有 meeting_archives 行，两行 nas_path 分别落在两个基准目录下
      await insertArchivedAsset(
        pool,
        'm1',
        'r1',
        `${oldRel}/transcript.txt`,
        join(nasRoot, 'all', oldRel, 'transcript.txt'),
      )
      await insertArchivedAsset(
        pool,
        'm1',
        'r2',
        `${oldRel}/notes.txt`,
        join(nasRoot, 'other', oldRel, 'notes.txt'),
      )
      await mkdir(join(localRoot, oldRel), { recursive: true })
      await writeFile(join(localRoot, oldRel, 'transcript.txt'), 'hello')

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(1)
      expect(plan[0]!.conflictReason).not.toBeNull()
      expect(await applyOne(pool, plan[0]!)).toBe('conflict')
      await stat(join(localRoot, oldRel, 'transcript.txt'))
      expect(await targetPath(pool, 'm1', 'r1')).toBe(`${oldRel}/transcript.txt`)
    })
  })
})
