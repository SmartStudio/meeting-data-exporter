import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { withTestDb } from '../helpers/testdb'
import { applyOne, parseArgs, planSplits } from '../../scripts/split-recurring-meetings'
import type { Pool } from '../../src/store/db'

/**
 * 与改名脚本同一条约定：不 mock 数据库。这个脚本的全部风险都在「文件搬到哪」与
 * 「六张表一起改成」这两件事必须一起成/一起不成上，而后者是事务语义，mock 掉等于没测。
 * 唯一 mock 掉的是「写库炸了」那一条（Task 6 的 brokenTxPool）。
 */
async function withDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try { await fn(pool) } finally { await cleanup() }
}

async function withDirs(fn: (localRoot: string, nasRoot: string) => Promise<void>): Promise<void> {
  const localRoot = await mkdtemp(join(tmpdir(), 'mde-split-local-'))
  const nasRoot = await mkdtemp(join(tmpdir(), 'mde-split-nas-'))
  try { await fn(localRoot, nasRoot) } finally {
    await rm(localRoot, { recursive: true, force: true })
    await rm(nasRoot, { recursive: true, force: true })
  }
}

/** 2026-09-02 01:27 UTC 与它的次日——两个场次的 start_time */
const DAY1 = Date.UTC(2026, 8, 2, 1, 27) / 1000
const DAY2 = DAY1 + 86400
const REL1 = '2026/09/2026-09-02_0127_881'
const REL2 = '2026/09/2026-09-03_0127_881'

/** 一场没拆过的会议：meetings 里一行空 sub，meeting_cache 里两个场次 */
async function seedMeeting(
  pool: Pool,
  opts: { records?: Array<{ id: string; start: number; subject?: string }> } = {},
) {
  const records = opts.records ?? [{ id: 'rec-1', start: DAY1 }, { id: 'rec-2', start: DAY2 }]
  // meetings 那一行描述的是**最新的**一场（upsertMeeting 每轮把 start_time 覆盖成
  // 最后拉到的那场），所以取最后一条；一条都没有时用 DAY2，与默认的最新那场一致
  const start = records.at(-1)?.start ?? DAY2
  await pool.execute(
    `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
     VALUES ('m1', '', '881', '销售日会', 'u1', ?, ?, 1, 1)`,
    [start, start + 1800],
  )
  for (const r of records) {
    await pool.execute(
      `INSERT INTO meeting_cache (meeting_record_id, meeting_id, sub_meeting_id, meeting_code, subject, host_user_id, start_time, end_time, state, updated_at)
       VALUES (?, 'm1', ?, '881', ?, 'u1', ?, ?, 'completed', 1)`,
      [r.id, r.id, r.subject ?? '销售日会', r.start, r.start + 1800],
    )
  }
}

/** 一个资产：asset_id 的第一段就是它属于哪个场次 */
async function seedAsset(
  pool: Pool, recordId: string, remoteId: string, targetPath: string, fileType = 'txt',
) {
  await pool.execute(
    `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, asset_id, file_type, status, target_path, created_at, updated_at)
     VALUES ('m1', '', 'meeting_summary', ?, ?, ?, 'completed', ?, 1, 1)`,
    [remoteId, `${recordId}:${remoteId}:meeting_summary:txt`, fileType, targetPath],
  )
}

/** 一条归档记录：local_path 必须与 target_path 同值（archiveOneAsset 就是这么写的） */
async function seedArchived(
  pool: Pool, remoteId: string, localPath: string, nasPath: string, fileType = 'txt',
) {
  await pool.execute(
    `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
     VALUES ('m1', '', 'meeting_summary', ?, ?, ?, ?, 'h', 1)`,
    [remoteId, fileType, localPath, nasPath],
  )
}

test('parseArgs：默认 dry-run，--apply 才动手', () => {
  expect(parseArgs([])).toEqual({ apply: false })
  expect(parseArgs(['--apply'])).toEqual({ apply: true })
})

test('按 meeting_cache 拆成两个场次，各自算出自己的目录；文件名不再带序号后缀', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      // 拆之前两段转写挤在同一个目录里，第二段被 siblingRank 加了 _2
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedAsset(pool, 'rec-2', 'f2', `${REL2}/transcript_2.txt`)

      const plan = await planSplits(pool, localRoot)
      expect(plan).toHaveLength(1)
      const item = plan[0]!
      expect(item.undecidableReason).toBeNull()
      expect(item.sessions.map((s) => s.recordId)).toEqual(['rec-1', 'rec-2'])
      expect(item.sessions.map((s) => s.newRel)).toEqual([REL1, REL2])
      // 分组变小之后各自都是组里唯一一个，序号后缀没了
      expect(item.sessions[0]!.assets.map((a) => a.newTargetPath)).toEqual([`${REL1}/transcript.txt`])
      expect(item.sessions[1]!.assets.map((a) => a.newTargetPath)).toEqual([`${REL2}/transcript.txt`])
      // 本地搬运：从旧目录搬到各自的新目录，路径都在归档区里
      expect(item.sessions[0]!.assets[0]!.local).toEqual({
        from: join(localRoot, `${REL2}/transcript.txt`),
        to: join(localRoot, `${REL1}/transcript.txt`),
      })
      // 没有 archived_assets 行 → NAS 上什么都没有
      expect(item.nasDir).toBeNull()
      expect(item.sessions.every((s) => s.archived === false)).toBe(true)
    })
  })
})

test('资产指向的 record id 不在 meeting_cache 里、只有一个时，用 meetings 行自己的元数据顶上', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool, { records: [] })          // 缓存里一条都没有
      await seedAsset(pool, 'rec-orphan', 'f1', `${REL2}/transcript.txt`)

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toBeNull()
      expect(item.sessions.map((s) => s.recordId)).toEqual(['rec-orphan'])
      expect(item.sessions[0]!.subject).toBe('销售日会')   // 来自 meetings 行本身
      expect(item.sessions[0]!.newRel).toBe(REL2)
    })
  })
})

test('两个 record id 都不在 meeting_cache 里 → undecidable，整场跳过', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool, { records: [] })
      await seedAsset(pool, 'rec-x', 'f1', `${REL2}/transcript.txt`)
      await seedAsset(pool, 'rec-y', 'f2', `${REL2}/transcript_2.txt`)

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toContain('meeting_cache')
      expect(item.sessions).toHaveLength(0)
    })
  })
})

test('asset_id 为空的资产行 → undecidable：说不出它属于哪一场，不许猜', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await pool.execute(
        `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, asset_id, file_type, status, target_path, created_at, updated_at)
         VALUES ('m1', '', 'meeting_summary', 'f9', NULL, 'txt', 'completed', ?, 1, 1)`,
        [`${REL2}/transcript.txt`],
      )
      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toContain('asset_id')
    })
  })
})

test('没有资产的会议只拆 meetings 行本身，按 meeting_cache 的场次', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toBeNull()
      expect(item.sessions.map((s) => s.recordId)).toEqual(['rec-1', 'rec-2'])
      expect(item.sessions.every((s) => s.assets.length === 0)).toBe(true)
    })
  })
})

test('已经拆过的会议不再进计划（脚本自消耗、可重复跑）', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await pool.execute(
        `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
         VALUES ('m1', 'rec-1', '881', '销售日会', 'u1', ?, ?, 1, 1)`,
        [DAY1, DAY1 + 1800],
      )
      expect(await planSplits(pool, localRoot)).toHaveLength(0)
    })
  })
})

test('同一分钟的两个场次（转写记录）：第二场的目录加 _2，序号来自 assignDirOrdinals', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      // 腾讯给同一场会议两条 record：正常录制 + 主题带「转写_」前缀的转写记录，
      // media_start_time 完全相同，而主题不进目录名 → 两场争同一个目录
      await seedMeeting(pool, {
        records: [
          { id: 'rec-a', start: DAY1 },
          { id: 'rec-b', start: DAY1, subject: '转写_销售日会' },
        ],
      })
      await seedAsset(pool, 'rec-a', 'f1', `${REL1}/transcript.txt`)
      await seedAsset(pool, 'rec-b', 'f2', `${REL1}/transcript_2.txt`)

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toBeNull()
      // 两场都是脚本这一轮新建的行（created_at 相同），次序由 sub_meeting_id 定；
      // 待删的 '' 旧行不参与编号，所以先到的那场保住无后缀目录
      expect(item.sessions.map((s) => s.newRel)).toEqual([REL1, `${REL1}_2`])
      expect(item.sessions[1]!.assets.map((a) => a.newTargetPath)).toEqual([`${REL1}_2/transcript.txt`])
    })
  })
})

test('这个 meeting_id 已经有按场次的行 → 混合状态，整场 undecidable，不在两套序号之间猜', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool, {
        records: [{ id: 'rec-a', start: DAY1 }, { id: 'rec-z', start: DAY1 }],
      })
      await seedAsset(pool, 'rec-a', 'f1', `${REL1}/transcript.txt`)
      // rec-z 上一轮就被新代码建成了独立会议行：眼下引擎把 '' 旧行也算进序号，
      // 于是 rec-z 的文件躺在 `…_2/` 里；'' 行一被删掉，引擎又会说它该在无后缀的
      // 目录里。脚本此刻正要往 `…_2/` 里搬旧行的文件——搬过去就是覆盖
      await pool.execute(
        `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
         VALUES ('m1', 'rec-z', '881', '销售日会', 'u1', ?, ?, 5, 5)`,
        [DAY1, DAY1 + 1800],
      )

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toContain('已有按场次的行')
      expect(item.sessions).toHaveLength(0)
    })
  })
})

test('别的会议已经拆过不碍事：兄弟行只看同一个 meeting_id', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await pool.execute(
        `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
         VALUES ('m2', 'rec-9', '882', '别的会', 'u1', ?, ?, 5, 5)`,
        [DAY1, DAY1 + 1800],
      )

      const plan = await planSplits(pool, localRoot)
      expect(plan.map((i) => i.meetingId)).toEqual(['m1'])
      expect(plan[0]!.undecidableReason).toBeNull()
      expect(plan[0]!.sessions.map((s) => s.newRel)).toEqual([REL1, REL2])
    })
  })
})

test('同一场次里两段同类资产：文件名的 _2 保留（分组只按新场次收窄）', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool, { records: [{ id: 'rec-1', start: DAY1 }] })
      await seedAsset(pool, 'rec-1', 'f1', `${REL1}/transcript.txt`)
      await seedAsset(pool, 'rec-1', 'f2', `${REL1}/transcript_2.txt`)

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.sessions[0]!.assets.map((a) => a.newTargetPath)).toEqual([
        `${REL1}/transcript.txt`, `${REL1}/transcript_2.txt`,
      ])
    })
  })
})

test('NAS 基准目录从 nas_path 反推（归档半途中断的会议没有 meeting_archives 行）', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedAsset(pool, 'rec-2', 'f2', `${REL2}/transcript_2.txt`)
      await seedArchived(pool, 'f1', `${REL2}/transcript.txt`, `${nasRoot}/${REL2}/transcript.txt`)

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toBeNull()
      expect(item.nasDir).toBe(nasRoot)
      expect(item.sessions[0]!.assets[0]!.nas).toEqual({
        from: `${nasRoot}/${REL2}/transcript.txt`,
        to: join(nasRoot, `${REL1}/transcript.txt`),
      })
      expect(item.sessions.map((s) => s.archived)).toEqual([true, false])
    })
  })
})

test('meeting_archives.nas_dir 与 nas_path 反推的基准目录不一致 → undecidable', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedArchived(pool, 'f1', `${REL2}/transcript.txt`, `${nasRoot}/${REL2}/transcript.txt`)
      await pool.execute(
        `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, created_at, updated_at)
         VALUES ('m1', '', '/mnt/somewhere-else', 1, 30, 1, 1)`,
      )

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toContain('/mnt/somewhere-else')
      expect(item.sessions).toHaveLength(0)
    })
  })
})

test('archived_assets.local_path 与 meeting_assets.target_path 不一致 → undecidable', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedArchived(pool, 'f1', `${REL1}/transcript.txt`, `${nasRoot}/${REL1}/transcript.txt`)

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toContain('local_path')
    })
  })
})

// ── 执行这一遍 ────────────────────────────────────────────────────────────────

/** 一个**已归档**的资产：archived_assets 行 + 本地文件 + NAS 文件都落到盘上 */
async function seedArchivedFiles(
  pool: Pool, localRoot: string, nasDir: string, remoteId: string, targetPath: string,
): Promise<void> {
  await seedArchived(pool, remoteId, targetPath, join(nasDir, targetPath))
  await mkdir(join(localRoot, dirname(targetPath)), { recursive: true })
  await writeFile(join(localRoot, targetPath), remoteId)
  await mkdir(join(nasDir, dirname(targetPath)), { recursive: true })
  await writeFile(join(nasDir, targetPath), remoteId)
}

async function seedMeetingArchive(pool: Pool, nasDir: string): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, created_at, updated_at)
     VALUES ('m1', '', ?, 100, 30, 1, 1)`,
    [nasDir],
  )
}

/** UPDATE 与 rollback 一起失败的连接池——断掉的连接就是这个样子（同改名脚本的测试） */
function brokenTxPool(): Pool {
  return {
    getConnection: async () => ({
      beginTransaction: async (): Promise<void> => {},
      execute: async (): Promise<never> => { throw new Error('boom: connection lost') },
      query: async (): Promise<never> => { throw new Error('boom: connection lost') },
      commit: async (): Promise<void> => {},
      rollback: async (): Promise<never> => { throw new Error('rollback also failed') },
      release: (): void => {},
    }),
  } as unknown as Pool
}

const subsOf = async (pool: Pool, table: string): Promise<string[]> => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT sub_meeting_id FROM ${table} WHERE meeting_id = 'm1' ORDER BY sub_meeting_id`,
  )
  return rows.map((r) => r.sub_meeting_id as string)
}

test('端到端：文件按场次搬走、七张表跟着改、旧行没了、旧目录删掉、NAS 侧车重写', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      const now = 5000
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedAsset(pool, 'rec-2', 'f2', `${REL2}/transcript_2.txt`)
      await seedArchivedFiles(pool, localRoot, nasDir, 'f1', `${REL2}/transcript.txt`)
      await seedArchivedFiles(pool, localRoot, nasDir, 'f2', `${REL2}/transcript_2.txt`)
      await seedMeetingArchive(pool, nasDir)
      await pool.execute(
        `INSERT INTO asset_contents (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, content, content_hash, bytes, parsed_at)
         VALUES ('m1', '', 'meeting_summary', 'f1', 'txt', 'parsed', '正文', 'h', 6, 1)`,
      )
      await pool.execute(
        `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
         VALUES ('m1', '', 'prog-1', NULL, 10, 0), ('m1', '', 'prog-2', NULL, 10, 50)`,
      )
      await pool.execute(
        `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
         VALUES ('m1', '', 'allow', 'deny', NULL, '法务要求', 10, 0)`,
      )
      await pool.execute(
        `INSERT INTO meeting_asset_probes (meeting_id, sub_meeting_id, asset_type, state, deadline_at)
         VALUES ('m1', '', 'video', 'probing', 999)`,
      )
      await pool.execute(
        `INSERT INTO job_failures (job_name, target, target_label, meeting_id, sub_meeting_id, reason, impact, first_failed_at, last_failed_at)
         VALUES ('archive', 'm1|', '销售日会', 'm1', '', '归不上', '未归档', 1, 1)`,
      )

      const item = (await planSplits(pool, localRoot, now))[0]!
      const res = await applyOne(pool, item, { localRoot, now })
      expect(res.outcome).toBe('renamed')
      expect(res.leftOver).toEqual([])

      // 文件各就各位，旧目录空了被删掉
      await stat(join(localRoot, REL1, 'transcript.txt'))
      await stat(join(localRoot, REL2, 'transcript.txt'))
      await stat(join(nasDir, REL1, 'transcript.txt'))
      expect(await readFile(join(localRoot, REL1, 'transcript.txt'), 'utf8')).toBe('f1')
      expect(await readFile(join(localRoot, REL2, 'transcript.txt'), 'utf8')).toBe('f2')
      await expect(stat(join(localRoot, REL2, 'transcript_2.txt'))).rejects.toThrow()

      // 七张表
      expect(await subsOf(pool, 'meetings')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'meeting_assets')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'archived_assets')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'asset_contents')).toEqual(['rec-1'])
      expect(await subsOf(pool, 'meeting_archives')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'meeting_grants')).toEqual(['rec-1', 'rec-1', 'rec-2', 'rec-2'])
      expect(await subsOf(pool, 'meeting_overrides')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'meeting_asset_probes')).toEqual([])   // 过程量，下一轮重建

      // 新建的场次行 created_at 就是规划用的那个 now——目录序号按它排，两遍必须同值
      const [created] = await pool.execute<RowDataPacket[]>(
        `SELECT created_at FROM meetings WHERE meeting_id='m1' AND sub_meeting_id='rec-1'`,
      )
      expect(Number(created[0]!.created_at)).toBe(now)

      const [assets] = await pool.execute<RowDataPacket[]>(
        `SELECT sub_meeting_id, target_path FROM meeting_assets WHERE meeting_id='m1' ORDER BY sub_meeting_id`,
      )
      expect(assets[0]!.target_path).toBe(`${REL1}/transcript.txt`)
      expect(assets[1]!.target_path).toBe(`${REL2}/transcript.txt`)
      const [arch] = await pool.execute<RowDataPacket[]>(
        `SELECT local_path, nas_path FROM archived_assets WHERE meeting_id='m1' AND sub_meeting_id='rec-1'`,
      )
      expect(arch[0]!.local_path).toBe(`${REL1}/transcript.txt`)
      expect(arch[0]!.nas_path).toBe(join(nasDir, REL1, 'transcript.txt'))
      // meeting_archives 的保留窗口原样复制过去，不是从 now 重新开始计时
      const [archives] = await pool.execute<RowDataPacket[]>(
        `SELECT archived_at, retention_days FROM meeting_archives WHERE meeting_id='m1' AND sub_meeting_id='rec-1'`,
      )
      expect(Number(archives[0]!.archived_at)).toBe(100)
      expect(Number(archives[0]!.retention_days)).toBe(30)

      // 失败项标为已恢复（dead 资产下一轮由调度器按场次重新登记）
      const [fails] = await pool.execute<RowDataPacket[]>(
        `SELECT resolved_at FROM job_failures WHERE target = 'm1|'`,
      )
      expect(Number(fails[0]!.resolved_at)).toBe(now)

      // NAS 侧车重写过（nas_dir 根上那一份，spec §2.4 步骤 4）
      const manifest = JSON.parse(await readFile(join(nasDir, '_manifest.json'), 'utf8'))
      expect(['rec-1', 'rec-2']).toContain(manifest.subMeetingId)
      expect(await readFile(join(nasDir, 'meeting.json'), 'utf8')).toContain('"subMeetingId"')

      // 幂等：跑完之后计划就空了
      expect(await planSplits(pool, localRoot, now)).toHaveLength(0)
    })
  })
})

test('目标文件已存在（且不是同一个文件）→ conflict，一个文件都不动、库一列没改', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await mkdir(join(localRoot, REL2), { recursive: true })
      await writeFile(join(localRoot, REL2, 'transcript.txt'), 'f1')
      // 别人已经在新目录里放了一个同名文件
      await mkdir(join(localRoot, REL1), { recursive: true })
      await writeFile(join(localRoot, REL1, 'transcript.txt'), '别的东西')

      const item = (await planSplits(pool, localRoot, 5000))[0]!
      expect((await applyOne(pool, item, { localRoot, now: 5000 })).outcome).toBe('conflict')

      expect(await readFile(join(localRoot, REL2, 'transcript.txt'), 'utf8')).toBe('f1')
      expect(await readFile(join(localRoot, REL1, 'transcript.txt'), 'utf8')).toBe('别的东西')
      expect(await subsOf(pool, 'meetings')).toEqual([''])
    })
  })
})

test('改 sub_meeting_id 撞上 uk_asset → conflict，文件搬回原位、库一列没改', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool, { records: [{ id: 'rec-1', start: DAY1 }] })
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await mkdir(join(localRoot, REL2), { recursive: true })
      await writeFile(join(localRoot, REL2, 'transcript.txt'), 'f1')
      // 目标自然键 (m1, rec-1, meeting_summary, f1, txt) 上已经有一行。规划这一遍
      // 拦掉的是有 meetings 兄弟行的混合状态，拦不住只有资产行的这一种——
      // 撞唯一键必须落成 conflict，不许冒成未捕获异常
      await pool.execute(
        `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, asset_id, file_type, status, target_path, created_at, updated_at)
         VALUES ('m1', 'rec-1', 'meeting_summary', 'f1', 'rec-1:f1:meeting_summary:txt', 'txt', 'completed', ?, 1, 1)`,
        [`${REL1}/transcript.txt`],
      )

      const item = (await planSplits(pool, localRoot, 5000))[0]!
      expect(item.undecidableReason).toBeNull()
      expect((await applyOne(pool, item, { localRoot, now: 5000 })).outcome).toBe('conflict')

      // 文件搬回了原位，库一列没改
      expect(await readFile(join(localRoot, REL2, 'transcript.txt'), 'utf8')).toBe('f1')
      await expect(stat(join(localRoot, REL1, 'transcript.txt'))).rejects.toThrow()
      expect(await subsOf(pool, 'meetings')).toEqual([''])
    })
  })
})

test('写库失败（连回滚都失败）时文件搬回原位、库一列没动，原始错误照抛', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedArchivedFiles(pool, localRoot, nasDir, 'f1', `${REL2}/transcript.txt`)
      await seedMeetingArchive(pool, nasDir)

      const item = (await planSplits(pool, localRoot, 5000))[0]!
      // 抛的必须是 UPDATE 那个错，不是 rollback 那个——被盖掉的话原因就查不出来了
      await expect(applyOne(brokenTxPool(), item, { localRoot, now: 5000 }))
        .rejects.toThrow('boom: connection lost')

      await stat(join(localRoot, REL2, 'transcript.txt'))
      await stat(join(nasDir, REL2, 'transcript.txt'))
      await expect(stat(join(localRoot, REL1, 'transcript.txt'))).rejects.toThrow()
      expect(await subsOf(pool, 'meetings')).toEqual([''])

      // 回滚干净了，重跑照样能拆
      const retry = (await planSplits(pool, localRoot, 5000))[0]!
      expect((await applyOne(pool, retry, { localRoot, now: 5000 })).outcome).toBe('renamed')
    })
  })
})

test('旧文件与新文件都不在 → not_found，什么都不动（多半是 MDE_ARCHIVE_ROOT 指错了）', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)   // 盘上什么都没有

      const item = (await planSplits(pool, localRoot, 5000))[0]!
      expect((await applyOne(pool, item, { localRoot, now: 5000 })).outcome).toBe('not_found')
      expect(await subsOf(pool, 'meetings')).toEqual([''])
    })
  })
})

test('文件已经在新位置（上一次跑在事务之前断掉）→ already_done，库这一次补上', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      // 只有一个场次：断言 meetings 只剩 rec-1 这一行，才说得清"库补上了"
      await seedMeeting(pool, { records: [{ id: 'rec-1', start: DAY1 }] })
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await mkdir(join(localRoot, REL1), { recursive: true })
      await writeFile(join(localRoot, REL1, 'transcript.txt'), 'f1')   // 已经在新位置

      const item = (await planSplits(pool, localRoot, 5000))[0]!
      expect((await applyOne(pool, item, { localRoot, now: 5000 })).outcome).toBe('already_done')
      expect(await subsOf(pool, 'meetings')).toEqual(['rec-1'])        // 库补上了
    })
  })
})

test('旧目录里还有不认识的文件时保留目录并记 left_over，绝不删非空目录', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await mkdir(join(localRoot, REL2), { recursive: true })
      await writeFile(join(localRoot, REL2, 'transcript.txt'), 'f1')
      await writeFile(join(localRoot, REL2, '不认识的东西.bin'), 'x')
      // 旧目录里的本地侧车是描述一个已经搬空了的地方的，收尾时要删掉
      await writeFile(join(localRoot, REL2, '_manifest.json'), '{}')
      await writeFile(join(localRoot, REL2, 'meeting.json'), '{}')

      const item = (await planSplits(pool, localRoot, 5000))[0]!
      const res = await applyOne(pool, item, { localRoot, now: 5000 })
      expect(res.outcome).toBe('renamed')
      expect(res.leftOver).toEqual([join(localRoot, REL2)])
      await stat(join(localRoot, REL2, '不认识的东西.bin'))            // 还在
      await expect(stat(join(localRoot, REL2, '_manifest.json'))).rejects.toThrow()
      await expect(stat(join(localRoot, REL2, 'meeting.json'))).rejects.toThrow()
    })
  })
})

test('undecidable 的计划项 applyOne 一步都不做', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool, { records: [] })
      await seedAsset(pool, 'rec-x', 'f1', `${REL2}/transcript.txt`)
      await seedAsset(pool, 'rec-y', 'f2', `${REL2}/transcript_2.txt`)
      await mkdir(join(localRoot, REL2), { recursive: true })
      await writeFile(join(localRoot, REL2, 'transcript.txt'), 'f1')

      const item = (await planSplits(pool, localRoot, 5000))[0]!
      const res = await applyOne(pool, item, { localRoot, now: 5000 })
      expect(res).toEqual({ outcome: 'undecidable', leftOver: [] })
      await stat(join(localRoot, REL2, 'transcript.txt'))
      expect(await subsOf(pool, 'meetings')).toEqual([''])
    })
  })
})

test('没有资产的会议：盘上没有东西要搬，库照样拆成两个场次（结局 already_done）', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)                                   // meeting_cache 两场，零资产

      const item = (await planSplits(pool, localRoot, 5000))[0]!
      const res = await applyOne(pool, item, { localRoot, now: 5000 })
      // 一个文件都没搬动，但库总归要改——所以是 already_done 而不是 not_found
      expect(res).toEqual({ outcome: 'already_done', leftOver: [] })
      expect(await subsOf(pool, 'meetings')).toEqual(['rec-1', 'rec-2'])
    })
  })
})
