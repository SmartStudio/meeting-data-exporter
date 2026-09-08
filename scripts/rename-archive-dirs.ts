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
 *   4. 重写 `_manifest.json` 里 assets[].nasPath 的前缀
 * 目录改名先于写库；写库失败把目录改回去。目标目录已存在一律 conflict、什么都不动。
 *
 * `meeting_archives.nas_dir` 是**每场会议的 NAS 基准目录**（归档规则模板渲染出来的），
 * 会议目录是它下面那一层，所以 nas_dir 这一列本身不动。
 *
 * ⚠️ **`_manifest.json` 不在会议目录里，在 `nas_dir` 根上**（`writeNasSidecars`，
 * src/worker/archive.ts）。多场会议渲染到同一个 nas_dir 时它们共用同一份 manifest，
 * 所以这里只按「这场会议的旧 NAS 目录前缀」逐条替换 `assets[].nasPath`，
 * 不整份重写、也不碰别的会议那几条。
 *
 * 可重复跑：旧目录不存在的会议按新目录在不在分成 already_done / not_found。
 *
 * 跑之前**停掉定时任务与网关**：改名与归档流水线并发，会让一半文件写到旧目录。
 * 建议 `2>&1 | tee rename-$(date +%s).log`：出事时要查的第一现场就是这份输出。
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

/**
 * `applyOne` 的四种结局。
 *
 * `already_done` 与 `not_found` 都是「这一场没动」，但要分开说：前者是**上一次跑成功了**
 * （新目录在那儿），后者是**这场会议的目录从来就不在本地/NAS 上**——多半是归档区被清理过、
 * 或者 MDE_ARCHIVE_ROOT 指错了地方。合成一个 skipped 的话，「根目录打错一个字母」
 * 会表现为「全部跳过、退出码 0」，也就是一次看起来很成功的空跑。
 */
export type ApplyOutcome = 'renamed' | 'already_done' | 'not_found' | 'conflict'

export interface RenameItem {
  meetingId: string
  subMeetingId: string
  oldRel: string
  newRel: string
  local: { from: string; to: string; exists: boolean }
  /** `dir` 是 meeting_archives.nas_dir 本身（manifest 就在它根上），from/to 是它下面那一层会议目录 */
  nas: { dir: string; from: string; to: string; exists: boolean } | null
  /**
   * 另有会议算出了同一个 `oldRel`（subject / start_time / meeting_code 三者全同）。
   * 这种会议共用一个目录，改名只能移动一次，先动的那场会把后面几场的行留在旧路径上。
   * 一律不动、报 conflict，交给人去看这几场到底是什么关系。
   */
  duplicate: boolean
}

interface MeetingRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  meeting_code: string | null
  subject: string | null
  start_time: number | null
  nas_dir: string | null
}

/**
 * 路径在不在。
 *
 * **只有 ENOENT / ENOTDIR 算「不在」，别的 errno 一律抛。** NAS 掉线时 stat 报的是
 * EIO / EHOSTDOWN / EACCES，把它们一并吞成 false 的后果是：这场会议被判成
 * 「NAS 上没有旧目录」，于是不改 NAS 目录、却照样改库里的 nas_path——
 * 库指向一个根本没建出来的路径，而 NAS 一挂回来，文件还在旧名下。
 */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw err
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
            dir: r.nas_dir,
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
      duplicate: false,
    })
  }

  // 同一个旧目录被多场会议算出来 → 全体标记。第一场改完之后其余几场的旧目录就不见了，
  // 它们的库行会安静地留在旧路径上，而目录已经不在那儿——这一步就是不让那件事发生。
  const seen = new Map<string, number>()
  for (const it of out) seen.set(it.oldRel, (seen.get(it.oldRel) ?? 0) + 1)
  for (const it of out) if ((seen.get(it.oldRel) ?? 0) > 1) it.duplicate = true

  return out
}

/** 只按前缀改 assets[].nasPath；manifest 可能被多场会议共用，别的条目一个不碰 */
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
 * （`日期_时分_主题_会议号`），而 `_` 是 LIKE 的单字符通配符：一行落在
 * `…-02X0127X主题X42677674068/` 下的路径会被 `…-02_0127_主题_42677674068/%` 匹上，
 * 然后被改成一个从来不存在的路径。
 */
const PREFIX_SWAP = (col: string): string =>
  `${col} = CONCAT(?, SUBSTRING(${col}, CHAR_LENGTH(?) + 1))`
const PREFIX_MATCH = (col: string): string => `LEFT(${col}, CHAR_LENGTH(?)) = ?`

/**
 * 把目录改回去。**自己不抛**——它跑在错误处理路径上，再抛一次就会把真正的原因盖掉，
 * 而那个原因才是要查的东西。改不回去只能喊出来，人工收尾。
 */
async function undoRename(from: string, to: string, what: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    console.error(
      `‼ ${what} 回滚失败：${from} 改不回 ${to}（${err}）。` +
        '目录停在新名字上、库里还是旧路径，两边对不上了，请手工把目录改回去再重跑本脚本',
    )
  }
}

export async function applyOne(pool: Pool, item: RenameItem): Promise<ApplyOutcome> {
  const doLocal = item.local.exists
  const doNas = item.nas !== null && item.nas.exists

  // 重复目录：先判，判在任何 stat / rename 之前
  if (item.duplicate) return 'conflict'

  if (!doLocal && !doNas) {
    const doneLocal = await exists(item.local.to)
    const doneNas = item.nas !== null && (await exists(item.nas.to))
    return doneLocal || doneNas ? 'already_done' : 'not_found'
  }
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
      if (doLocal) await undoRename(item.local.to, item.local.from, '本地目录')
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
    // 条件是 doNas 而不是「有 nas 记录」：NAS 目录这一轮没改名（不可达、或旧目录不在）
    // 却照样改 nas_path，等于把库指到一个没有建出来的路径上。
    if (doNas) {
      const nasOld = `${item.nas!.from}/`
      const nasNew = `${item.nas!.to}/`
      await conn.execute(
        `UPDATE archived_assets SET ${PREFIX_SWAP('nas_path')}
          WHERE meeting_id = ? AND sub_meeting_id = ? AND ${PREFIX_MATCH('nas_path')}`,
        [nasNew, nasOld, item.meetingId, item.subMeetingId, nasOld, nasOld],
      )
    }
    await conn.commit()
  } catch (err) {
    // rollback 自己也可能抛（UPDATE 失败最常见的原因就是连接断了，而断了的连接
    // 回滚同样会炸）。它抛出去的话下面两行改名回滚就一步都跑不到，目录停在新名字上、
    // 库里还是旧路径——而重跑会把这场会议判成 already_done，再也没人回来看它。
    // 所以：回滚失败只记一行，改名一定要回，最后抛的是**最初那个**错误。
    try {
      await conn.rollback()
    } catch (rollbackErr) {
      console.error(`‼ ${item.meetingId}/${item.subMeetingId || '-'} 事务回滚失败：${rollbackErr}`)
    }
    if (doLocal) await undoRename(item.local.to, item.local.from, '本地目录')
    if (doNas) await undoRename(item.nas!.to, item.nas!.from, 'NAS 目录')
    throw err
  } finally {
    conn.release()
  }

  // manifest 放在事务之后：它是 NAS 上那份副本的自描述，重写失败不该把已经一致的
  // 目录与库再翻回去。真失败了重跑一次也修不了它（那时旧目录已经不在，会被判
  // already_done），所以这一步的异常照旧往上抛，让人看见。
  if (doNas) await rewriteManifest(item.nas!.dir, `${item.nas!.from}/`, `${item.nas!.to}/`)
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
  console.log('提示：把输出留下来——`… 2>&1 | tee rename-$(date +%s).log`')
  const pool = createPool(databaseUrl)
  try {
    await runMigrations(pool)
    const plan = await planRenames(pool, localRoot)

    // NAS 基准目录先各 stat 一次。挂载点没挂上时 planRenames 里那些 exists() 全是
    // false，整份计划会安静地退化成「只改本地」，而库里的 nas_path 一列都不该动——
    // 这种半拉子结果比直接不跑坏得多。
    const nasDirs = [...new Set(plan.flatMap((i) => (i.nas === null ? [] : [i.nas.dir])))]
    const missing: string[] = []
    for (const d of nasDirs) if (!(await exists(d))) missing.push(d)
    if (missing.length > 0) {
      for (const d of missing) console.error(`‼ NAS 基准目录不存在：${d}`)
      console.error('NAS 多半没挂上。挂好再跑——现在跑只会改本地，NAS 那边一场都动不了')
      if (args.apply) return 2
    }

    let renamed = 0
    let alreadyDone = 0
    let notFound = 0
    let conflict = 0
    let failed = 0
    for (const item of plan) {
      const who = `${item.meetingId}/${item.subMeetingId || '-'}`
      const todo = item.local.exists || (item.nas?.exists ?? false)
      if (!todo) {
        // 目录一个都不在：分清「上次跑成功了」与「压根没找到」
        const done =
          (await exists(item.local.to)) || (item.nas !== null && (await exists(item.nas.to)))
        if (done) alreadyDone++
        else {
          notFound++
          console.error(`⚠ ${who} ${item.oldRel} 旧目录与新目录都不在，本地/NAS 上找不到这场会议`)
        }
        continue
      }
      console.log(
        `${who}\n  ${item.oldRel}\n  → ${item.newRel}\n  local=${item.local.exists} nas=${item.nas?.exists ?? 'n/a'}`,
      )
      if (item.duplicate) {
        conflict++
        console.error('  conflict：另有会议算出同一个目录，这几场一律不动')
        continue
      }
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
      // 一场炸了不该把剩下几百场一起停掉——已经回滚干净了，接着跑，最后按 failed 计数退出
      try {
        const r = await applyOne(pool, item)
        if (r === 'renamed') {
          renamed++
          console.log('  ok')
        } else if (r === 'conflict') {
          conflict++
          console.error('  conflict：目标目录已存在，未动')
        } else if (r === 'already_done') alreadyDone++
        else notFound++
      } catch (err) {
        failed++
        console.error(`  failed：${err}`)
      }
    }
    console.log(
      args.apply
        ? `renamed=${renamed} already_done=${alreadyDone} not_found=${notFound} conflict=${conflict} failed=${failed}`
        : `dry-run：${plan.length} 场会议，其中 ${plan.length - alreadyDone - notFound} 场需要改名（加 --apply 执行）`,
    )
    return conflict > 0 || failed > 0 ? 1 : 0
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
