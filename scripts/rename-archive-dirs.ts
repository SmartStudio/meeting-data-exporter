#!/usr/bin/env bun
/**
 * 会议目录去掉主题段的一次性改名（spec 2.4，2026-09-08）。
 *
 *   旧：<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<清洗主题>_<会议号>
 *   新：<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<会议号>
 *
 * 用法：
 *   DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts            # dry-run，只打印
 *   DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts --apply    # 真改
 *
 * 对每场会议（`meetings` 表一行）：
 *   1. 本地归档区：<localRoot>/<旧> → <localRoot>/<新>
 *   2. NAS：<meeting_archives.nas_dir>/<旧> → <nas_dir>/<新>（没归档过的会议没有这一步）
 *   3. 同一事务改 meeting_assets.target_path、archived_assets.local_path / nas_path 的前缀
 *   4. 重写 NAS 新目录里 _manifest.json 的 assets[].nasPath
 * 目录改名先于写库；写库失败把目录改回去。目标目录已存在一律 conflict、什么都不动。
 *
 * `meeting_archives.nas_dir` 是**每场会议的 NAS 基准目录**（归档规则模板渲染出来的），
 * 改名改的是它下面那一层会议目录，所以 nas_dir 这一列本身不动。
 *
 * 可重复跑：旧目录不存在（本地、NAS 都是）的会议直接 skipped。
 *
 * 跑之前**停掉定时任务与网关**：改名与归档流水线并发，会让一半文件写到旧目录。
 */
import { rename, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { cleanSubjectSegment, meetingDirPath } from '@yaowu/mde-engine'
import { createPool, runMigrations, type Pool } from '../src/store/db'

export interface RenameArgs {
  apply: boolean
}

export function parseArgs(argv: string[]): RenameArgs {
  return { apply: argv.includes('--apply') }
}

interface DirMeeting {
  subject: string | null
  startTime: number | null
  meetingCode: string | null
}

/** 2026-09-08 之前 packages/engine/src/domain/filename.ts 的 meetingDirPath，逐字复刻 */
export function legacyMeetingDirPath(m: DirMeeting, fallbackCode: string): string {
  const d = new Date((m.startTime ?? 0) * 1000)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hhmm = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}/${mm}/${yyyy}-${mm}-${dd}_${hhmm}_${cleanSubjectSegment(m.subject ?? '')}_${m.meetingCode ?? fallbackCode}`
}

export interface RenameItem {
  meetingId: string
  subMeetingId: string
  oldRel: string
  newRel: string
  local: { from: string; to: string; exists: boolean }
  nas: { from: string; to: string; exists: boolean } | null
}

interface MeetingRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  meeting_code: string | null
  subject: string | null
  start_time: number | null
  nas_dir: string | null
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function planRenames(pool: Pool, localRoot: string): Promise<RenameItem[]> {
  const [rows] = await pool.execute<MeetingRow[]>(
    `SELECT m.meeting_id, m.sub_meeting_id, m.meeting_code, m.subject, m.start_time, a.nas_dir
       FROM meetings m
       LEFT JOIN meeting_archives a ON a.meeting_id = m.meeting_id AND a.sub_meeting_id = m.sub_meeting_id
      ORDER BY m.meeting_id, m.sub_meeting_id`,
  )
  const out: RenameItem[] = []
  for (const r of rows) {
    const m: DirMeeting = { subject: r.subject, startTime: r.start_time, meetingCode: r.meeting_code }
    const oldRel = legacyMeetingDirPath(m, r.meeting_id)
    const newRel = meetingDirPath(m, r.meeting_id)
    const localFrom = join(localRoot, oldRel)
    const localTo = join(localRoot, newRel)
    const nas =
      r.nas_dir === null
        ? null
        : {
            from: join(r.nas_dir, oldRel),
            to: join(r.nas_dir, newRel),
            exists: await exists(join(r.nas_dir, oldRel)),
          }
    out.push({
      meetingId: r.meeting_id,
      subMeetingId: r.sub_meeting_id,
      oldRel,
      newRel,
      local: { from: localFrom, to: localTo, exists: await exists(localFrom) },
      nas,
    })
  }
  return out
}

async function rewriteManifest(dir: string, oldPrefix: string, newPrefix: string): Promise<void> {
  const p = join(dir, '_manifest.json')
  if (!(await exists(p))) return
  const doc = JSON.parse(await readFile(p, 'utf8')) as { assets?: Array<{ nasPath?: string }> }
  for (const a of doc.assets ?? []) {
    if (typeof a.nasPath === 'string' && a.nasPath.startsWith(oldPrefix)) {
      a.nasPath = newPrefix + a.nasPath.slice(oldPrefix.length)
    }
  }
  await writeFile(p, JSON.stringify(doc, null, 2))
}

/**
 * 前缀替换的 SQL：`LEFT(列, CHAR_LENGTH(旧)) = 旧` 判前缀、`SUBSTRING(列, CHAR_LENGTH(旧)+1)` 取后缀。
 *
 * 两处都用 **MySQL 侧的 CHAR_LENGTH**，不是 JS 的 `String.length`：主题段允许出现 emoji
 * （连接池显式设 utf8mb4 就是为它，见 src/store/db.ts），而 emoji 在 JS 里是 2 个 UTF-16
 * 码元、在 MySQL 里是 1 个字符。拿 JS 长度当 SUBSTRING 的起点，带 emoji 的主题会把
 * 后缀多切掉几个字符，切出来的路径还长得像模像样——最难查的那一种。
 *
 * 判前缀用 `LEFT(...) =` 而不是 `LIKE '前缀%'`，是因为旧目录名里**必然**有下划线
 * （`日期_时分_主题_会议号`），而 `_` 是 LIKE 的单字符通配符。同一场会议下越界匹配的
 * 概率极低，但这里不需要为省一个函数调用去赌它。
 */
const PREFIX_SWAP = (col: string): string =>
  `${col} = CONCAT(?, SUBSTRING(${col}, CHAR_LENGTH(?) + 1))`
const PREFIX_MATCH = (col: string): string => `LEFT(${col}, CHAR_LENGTH(?)) = ?`

export async function applyOne(
  pool: Pool,
  item: RenameItem,
): Promise<'renamed' | 'skipped_nothing_to_do' | 'conflict'> {
  const doLocal = item.local.exists
  const doNas = item.nas !== null && item.nas.exists
  if (!doLocal && !doNas) return 'skipped_nothing_to_do'
  if ((doLocal && (await exists(item.local.to))) || (doNas && (await exists(item.nas!.to)))) {
    return 'conflict'
  }

  // 两次改名之间也可能炸（NAS 掉线最常见）。半边改完半边没改会留下
  // 「本地已是新名、NAS 还是旧名、库里还是旧路径」的中间态，虽然重跑能自愈，
  // 但让这一步整体成/整体不成，出事时人看到的现场才是干净的。
  if (doLocal) await rename(item.local.from, item.local.to)
  if (doNas) {
    try {
      await rename(item.nas!.from, item.nas!.to)
    } catch (err) {
      if (doLocal) await rename(item.local.to, item.local.from)
      throw err
    }
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const oldPrefix = `${item.oldRel}/`
    const newPrefix = `${item.newRel}/`
    await conn.execute(
      `UPDATE meeting_assets SET ${PREFIX_SWAP('target_path')}
        WHERE meeting_id = ? AND sub_meeting_id = ? AND ${PREFIX_MATCH('target_path')}`,
      [newPrefix, oldPrefix, item.meetingId, item.subMeetingId, oldPrefix, oldPrefix],
    )
    await conn.execute(
      `UPDATE archived_assets SET ${PREFIX_SWAP('local_path')}
        WHERE meeting_id = ? AND sub_meeting_id = ? AND ${PREFIX_MATCH('local_path')}`,
      [newPrefix, oldPrefix, item.meetingId, item.subMeetingId, oldPrefix, oldPrefix],
    )
    if (item.nas !== null) {
      const nasOld = `${item.nas.from}/`
      const nasNew = `${item.nas.to}/`
      await conn.execute(
        `UPDATE archived_assets SET ${PREFIX_SWAP('nas_path')}
          WHERE meeting_id = ? AND sub_meeting_id = ? AND ${PREFIX_MATCH('nas_path')}`,
        [nasNew, nasOld, item.meetingId, item.subMeetingId, nasOld, nasOld],
      )
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    if (doLocal) await rename(item.local.to, item.local.from)
    if (doNas) await rename(item.nas!.to, item.nas!.from)
    throw err
  } finally {
    conn.release()
  }

  // manifest 放在事务之后：它是 NAS 上那份副本的自描述，重写失败不该把已经一致的
  // 目录与库再翻回去。真失败了重跑一次也修不了它（那时旧目录已经不在，会被 skip），
  // 所以这一步的异常照旧往上抛，让人看见。
  if (doNas) await rewriteManifest(item.nas!.to, `${item.nas!.from}/`, `${item.nas!.to}/`)
  return 'renamed'
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  const localRoot = process.env.MDE_ARCHIVE_ROOT
  if (!databaseUrl || !localRoot) {
    console.error('需要 DATABASE_URL 与 MDE_ARCHIVE_ROOT')
    return 2
  }
  const pool = createPool(databaseUrl)
  try {
    await runMigrations(pool)
    const plan = await planRenames(pool, localRoot)
    let renamed = 0
    let skipped = 0
    let conflict = 0
    for (const item of plan) {
      const todo = item.local.exists || (item.nas?.exists ?? false)
      if (!todo) {
        skipped++
        continue
      }
      console.log(
        `${item.meetingId}/${item.subMeetingId || '-'}\n  ${item.oldRel}\n  → ${item.newRel}\n  local=${item.local.exists} nas=${item.nas?.exists ?? 'n/a'}`,
      )
      if (!args.apply) {
        // dry-run 也把「目标目录已存在」说出来。不说的话操作员看到的是一份
        // 全绿的计划，`--apply` 跑完才知道有几场原地没动——dry-run 存在的意义
        // 就是别让人带着这种意外去执行。退出码仍只由 --apply 那一路决定。
        const taken =
          (item.local.exists && (await exists(item.local.to))) ||
          (item.nas !== null && item.nas.exists && (await exists(item.nas.to)))
        if (taken) console.error('  ⚠ 目标目录已存在，--apply 时这场会 conflict、不会动')
        continue
      }
      const r = await applyOne(pool, item)
      if (r === 'renamed') renamed++
      else if (r === 'conflict') {
        conflict++
        console.error('  conflict：目标目录已存在，未动')
      } else skipped++
    }
    console.log(
      args.apply
        ? `renamed=${renamed} skipped=${skipped} conflict=${conflict}`
        : `dry-run：${plan.length} 场会议，其中 ${plan.length - skipped} 场需要改名（加 --apply 执行）`,
    )
    return conflict > 0 ? 1 : 0
  } finally {
    await pool.end()
  }
}

// 被 import 时（测试）不自动执行
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
