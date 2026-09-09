import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTestDb } from '../helpers/testdb'
import { parseArgs, planSplits } from '../../scripts/split-recurring-meetings'
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
