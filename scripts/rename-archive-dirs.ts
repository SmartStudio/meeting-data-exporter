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
 * 计划分两遍出（见 `planRenames`）：
 *   A. **会议驱动**：`meetings` 每一行按它自己的 subject / start_time / meeting_code 算旧目录。
 *   B. **路径驱动**：从 `meeting_assets.target_path`、`archived_assets.local_path` / `nas_path`
 *      里把长得像旧格式的三段式目录前缀捞出来，去掉 A 已经排到的，剩下的每个前缀也排一条。
 *
 * 为什么必须有 B：**周期性会议**（同一个 meeting_id、sub_meeting_id 为空串）每轮拉取都被
 * `upsertMeeting` 把 start_time 覆盖成最新那一场，所以 `meetings` 那一行**只描述最新实例**。
 * 「硬件早会」这种日会在磁盘上有 09-02、09-03、09-04 三个目录，而行里只剩 09-04——
 * 光靠 A，前两个目录一辈子进不了计划，它们的 target_path / local_path / nas_path 就永远
 * 停在旧前缀上（真实数据上是 16 个目录 ×（本地 + NAS）、92 行 meeting_assets、100 行
 * archived_assets）。日会正是生产数据的大头，所以 B 不是补丁是主路径。
 *
 * 反过来，A 里那一场的目录**可能从来没下载过**（行是拉会议列表建的，资产没落过盘），
 * 这时它报 `not_found` 是对的，不是错误。
 *
 * 对计划里的每一条（一个目录，不一定等于一场会议）：
 *   1. 本地归档区：<localRoot>/<旧> → <localRoot>/<新>
 *   2. NAS：<基准目录>/<旧> → <基准目录>/<新>（没归档过、NAS 上什么都没有的会议没有这一步）
 *   3. 同一事务改 meeting_assets.target_path、archived_assets.local_path / nas_path 的前缀
 *   4. 重写 `_manifest.json` 里 assets[].nasPath 的前缀
 * 目录改名先于写库；写库失败把目录改回去。目标目录已存在一律 conflict、什么都不动。
 *
 * `meeting_archives.nas_dir` 是**每场会议的 NAS 基准目录**（归档规则模板渲染出来的），
 * 会议目录是它下面那一层，所以 nas_dir 这一列本身不动。
 *
 * 但**不能只认这一列**：真实数据上有会议只有 `archived_assets` 行、没有 `meeting_archives`
 * 行——归档那一轮把文件都拷过去了，`upsertMeetingArchive` 之前断掉（进程被杀、NAS 掉线）。
 * 光看归档行的话这种会议 `nas` 是 null，于是本地改名、库里的 local/target 也改了，
 * **NAS 目录却原地不动、nas_path 也跟着留在旧名下**：看起来一切正常（库与磁盘仍然一致），
 * 只是这几场永远改不过来。所以基准目录还从 `nas_path` 自己身上反推：每条 nas_path 都是
 * `<基准目录>/<yyyy>/<mm>/<会议目录>/<文件名>`（`archiveOneAsset` 就是
 * `join(nasDir, targetPath)` 拼的），砍掉末尾四段剩下的就是基准目录。
 * 两个来源都在时以 `meeting_archives.nas_dir` 为准；**两者不一致、或同一场会议的行之间
 * 反推出不同的基准目录**，一律 conflict 不动手——行说一个地方、归档行说另一个地方，
 * 该由人去看这场会议到底归到哪儿了。
 *
 * ⚠️ **`_manifest.json` 不在会议目录里，在 `nas_dir` 根上**（`writeNasSidecars`，
 * src/worker/archive.ts）。多场会议渲染到同一个 nas_dir 时它们共用同一份 manifest，
 * 所以这里只按「这场会议的旧 NAS 目录前缀」逐条替换 `assets[].nasPath`，
 * 不整份重写、也不碰别的会议那几条。
 *
 * 可重复跑：旧目录不存在的按新目录在不在分成 already_done / not_found。B 那一遍是**自消耗**的
 * ——库里的前缀改成新格式之后它就再也匹配不上，第二次跑只剩 A 的那些条目。
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

/** 这一条 RenameItem 是哪一遍排出来的，见文件头 A / B */
export type RenameSource = 'meeting' | 'path'

export interface RenameItem {
  meetingId: string
  subMeetingId: string
  oldRel: string
  newRel: string
  local: { from: string; to: string; exists: boolean }
  /**
   * `dir` 是这场会议的 NAS 基准目录（manifest 就在它根上），from/to 是它下面那一层会议目录。
   * 来源优先 `meeting_archives.nas_dir`，没有那一行时从 `archived_assets.nas_path` 反推。
   */
  nas: { dir: string; from: string; to: string; exists: boolean } | null
  /**
   * 另有会议算出了同一个 `oldRel`（subject / start_time / meeting_code 三者全同）。
   * 这种会议共用一个目录，改名只能移动一次，先动的那场会把后面几场的行留在旧路径上。
   * 一律不动、报 conflict，交给人去看这几场到底是什么关系。
   */
  duplicate: boolean
  /**
   * 非 null = 这一条不动手（applyOne 直接返回 conflict），字符串是给人看的理由。
   * 目前只有一种：NAS 基准目录说不清楚——`meeting_archives.nas_dir` 与 `nas_path` 反推出来的
   * 对不上，或者同一场会议的 `archived_assets` 行反推出了不止一个基准目录。这时候「改哪个
   * 目录」本身就是错的问题，猜一个改下去只会把两处都弄乱。
   */
  conflictReason: string | null
  /**
   * 这一条是哪一遍排出来的：`meeting` = `meetings` 行算出来的，`path` = 从三列路径里
   * 捞出来的旧格式目录前缀。dry-run 把它打出来，操作员一眼能看出「这场会议的行里没有
   * 的那些目录」是从哪儿冒出来的——周期性会议的旧实例全部落在 `path` 这一类。
   */
  source: RenameSource
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
export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw err
  }
}

/**
 * 旧格式的三段式目录前缀：`<yyyy>/<mm>/<日期>_<时分>_<主题>_<会议号>`。
 *
 * `$2`（主题段）用**贪婪**的 `.+`，`$3`（会议号）是最后一段且不含 `_`：主题本身允许带
 * 下划线（`转写_即服务项目开发日会`），贪婪匹配保证切在**最后**一个下划线上，会议号完整。
 *
 * 新格式 `<日期>_<时分>_<会议号>` 在 `$1` 之后只剩一段，凑不出 `_(.+)_(...)` 两段，
 * 所以匹配不上——这正是要的：跑第二次时库里已经是新前缀，不能再被切一刀。
 */
const LEGACY_REL = /^(\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}_\d{4})_(.+)_([^_/]+)$/

/** 旧格式目录前缀 → 新格式；不是旧格式（含已经是新格式的）返回 null */
export function newRelFromLegacyRel(rel: string): string | null {
  const m = LEGACY_REL.exec(rel)
  return m === null ? null : `${m[1]}_${m[3]}`
}

interface PrefixRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  rel: string
  /** 只有 nas_path 那一条来源有值：从这条 nas_path 反推出来的 NAS 基准目录 */
  base: string | null
}

interface ArchiveRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  nas_dir: string
}

interface BaseRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  base: string | null
}

/**
 * 从一条绝对 `nas_path` 里切出「基准目录」与「相对的三段式目录前缀」的 SQL 片段。
 *
 * nas_path 长成 `<基准目录>/<yyyy>/<mm>/<会议目录>/<文件名>`——资产文件**直接躺在会议目录里**
 * （`archiveOneAsset` 是 `join(nasDir, asset.targetPath)`，而 targetPath 就是
 * `<yyyy>/<mm>/<会议目录>/<文件名>`），所以末尾恰好四段，倒着数就能把两截分开：
 *   相对前缀 = 末四段里的前三段
 *   基准目录 = 整串砍掉「末四段 + 那个 `/`」
 * 长度一律用 MySQL 的 CHAR_LENGTH，理由同 PREFIX_SWAP 那一段（主题里可能有 emoji）。
 *
 * 这么切就**不必 join `meeting_archives`**：归档半途中断的会议根本没有那一行，
 * join 会把它整场漏掉（见文件头 nas_dir 那一段）。
 */
const NAS_REL = `SUBSTRING_INDEX(SUBSTRING_INDEX(nas_path, '/', -4), '/', 3)`
export const NAS_BASE = `LEFT(nas_path, CHAR_LENGTH(nas_path) - CHAR_LENGTH(SUBSTRING_INDEX(nas_path, '/', -4)) - 1)`

/**
 * 三列路径里的**目录前缀**（前三段）各来一条 DISTINCT。
 *
 * `target_path` / `local_path` 是相对路径，前三段就是 `<yyyy>/<mm>/<会议目录>`，
 * 直接 `SUBSTRING_INDEX(列, '/', 3)`；它们身上没有基准目录，`base` 一律 NULL。
 *
 * `nas_path` 是**绝对**路径，按上面 NAS_REL / NAS_BASE 一刀切成两截：前缀进 `rel`、
 * 基准目录进 `base`，谁说了算由 resolveNasBase 定。
 */
const PREFIX_SOURCES: readonly string[] = [
  `SELECT DISTINCT meeting_id, sub_meeting_id, SUBSTRING_INDEX(target_path, '/', 3) AS rel, NULL AS base
     FROM meeting_assets
    WHERE target_path IS NOT NULL`,
  `SELECT DISTINCT meeting_id, sub_meeting_id, SUBSTRING_INDEX(local_path, '/', 3) AS rel, NULL AS base
     FROM archived_assets`,
  `SELECT DISTINCT meeting_id, sub_meeting_id, ${NAS_REL} AS rel, ${NAS_BASE} AS base
     FROM archived_assets`,
]

/** 每场会议的 archived_assets 行反推出来的 NAS 基准目录（正常只有一个，多于一个就是 conflict） */
const NAS_BASE_BY_MEETING = `SELECT DISTINCT meeting_id, sub_meeting_id, ${NAS_BASE} AS base
     FROM archived_assets`

/** 空串（nas_path 不够四段、切完什么都不剩）当没反推出来处理 */
export const cleanBase = (b: string | null | undefined): string | null =>
  b === null || b === undefined || b === '' ? null : b

/** 一场会议（或一条路径）反推出来的基准目录：`conflict` = 反推出了不止一个 */
export interface DerivedBase {
  base: string | null
  conflict: boolean
}

/**
 * 归档行的 nas_dir 与反推出来的基准目录合成一个：有归档行以它为准，没有就用反推的；
 * 两者都有且不一样、或反推本身就自相矛盾 → 这场会议的 NAS 位置讲不清楚，交给人看。
 */
export function resolveNasBase(
  archiveDir: string | null,
  derived: DerivedBase | undefined,
): { dir: string | null; reason: string | null } {
  const d = derived?.base ?? null
  if (derived?.conflict === true) {
    return {
      dir: archiveDir ?? d,
      reason: 'archived_assets.nas_path 反推出了不止一个 NAS 基准目录，说不清这场会议归到哪儿',
    }
  }
  if (archiveDir !== null && d !== null && archiveDir !== d) {
    return {
      dir: archiveDir,
      reason: `meeting_archives.nas_dir 是 ${archiveDir}，archived_assets.nas_path 却指向 ${d}`,
    }
  }
  return { dir: archiveDir ?? d, reason: null }
}

/** 把一条反推结果并进 map：先到的留着，后到的不一样就标 conflict */
export function mergeBase(map: Map<string, DerivedBase>, key: string, base: string | null): void {
  const prev = map.get(key)
  if (prev === undefined) {
    map.set(key, { base, conflict: false })
    return
  }
  if (base === null) return
  if (prev.base === null) prev.base = base
  else if (prev.base !== base) prev.conflict = true
}

const keyOf = (meetingId: string, subMeetingId: string): string => `${meetingId}\u0000${subMeetingId}`

export async function planRenames(pool: Pool, localRoot: string): Promise<RenameItem[]> {
  const [rows] = await pool.execute<MeetingRow[]>(
    `SELECT m.meeting_id, m.sub_meeting_id, m.meeting_code, m.subject, m.start_time, a.nas_dir
       FROM meetings m
       LEFT JOIN meeting_archives a ON a.meeting_id = m.meeting_id AND a.sub_meeting_id = m.sub_meeting_id
      ORDER BY m.meeting_id, m.sub_meeting_id`,
  )
  // 每场会议从 archived_assets.nas_path 反推出来的 NAS 基准目录。归档半途中断的会议
  // （assets 拷完了、meeting_archives 那一行还没写）只能靠它，否则 NAS 那边一辈子改不了名。
  const [baseRows] = await pool.execute<BaseRow[]>(NAS_BASE_BY_MEETING)
  const derivedBaseOf = new Map<string, DerivedBase>()
  for (const b of baseRows) {
    mergeBase(derivedBaseOf, keyOf(b.meeting_id, b.sub_meeting_id), cleanBase(b.base))
  }

  const out: RenameItem[] = []
  for (const r of rows) {
    const m: DirMeeting = { subject: r.subject, startTime: r.start_time, meetingCode: r.meeting_code }
    const oldRel = legacyMeetingDirPath(m, r.meeting_id)
    const newRel = meetingDirPath(m, r.meeting_id)
    const localFrom = join(localRoot, oldRel)
    const localTo = join(localRoot, newRel)
    const { dir: nasDir, reason } = resolveNasBase(
      r.nas_dir,
      derivedBaseOf.get(keyOf(r.meeting_id, r.sub_meeting_id)),
    )
    const nas =
      nasDir === null
        ? null
        : {
            dir: nasDir,
            from: join(nasDir, oldRel),
            to: join(nasDir, newRel),
            exists: await exists(join(nasDir, oldRel)),
          }
    out.push({
      meetingId: r.meeting_id,
      subMeetingId: r.sub_meeting_id,
      oldRel,
      newRel,
      local: { from: localFrom, to: localTo, exists: await exists(localFrom) },
      nas,
      duplicate: false,
      conflictReason: reason,
      source: 'meeting',
    })
  }

  // ——— 第二遍：路径驱动 ———
  // meetings 行只描述周期性会议的最新一场（upsertMeeting 每轮覆盖 start_time），
  // 旧实例的目录只在这三列路径里留下过痕迹。这一遍就是把它们捞回来。
  const [archiveRows] = await pool.execute<ArchiveRow[]>(
    `SELECT meeting_id, sub_meeting_id, nas_dir FROM meeting_archives`,
  )
  const nasDirOf = new Map<string, string>()
  for (const a of archiveRows) nasDirOf.set(keyOf(a.meeting_id, a.sub_meeting_id), a.nas_dir)

  // 第一遍已经排到的旧目录不再排第二条：同一个目录出现两条会被 duplicate 判成 conflict，
  // 而它们本来就是同一件事
  const planned = new Set(out.map((i) => i.oldRel))
  // 每条前缀自己的基准目录：nas_path 那一条来源直接反推出来，另外两条只有 rel、base 是 null。
  // 同一个 (会议, 前缀) 在多条来源里都出现时按 mergeBase 并——两条 nas_path 反推出不同基准目录
  // 就地标 conflict。
  const foundBase = new Map<string, DerivedBase>()
  const found = new Map<string, { meetingId: string; subMeetingId: string; oldRel: string }>()
  for (const sql of PREFIX_SOURCES) {
    const [rows] = await pool.execute<PrefixRow[]>(sql)
    for (const r of rows) {
      if (r.rel === null || planned.has(r.rel)) continue
      if (newRelFromLegacyRel(r.rel) === null) continue
      const k = `${keyOf(r.meeting_id, r.sub_meeting_id)}\u0000${r.rel}`
      mergeBase(foundBase, k, cleanBase(r.base))
      found.set(k, {
        meetingId: r.meeting_id,
        subMeetingId: r.sub_meeting_id,
        oldRel: r.rel,
      })
    }
  }
  for (const k of [...found.keys()].sort()) {
    const { meetingId, subMeetingId, oldRel } = found.get(k)!
    const newRel = newRelFromLegacyRel(oldRel)!
    // 归档行没有时用这条路径自己反推出来的基准目录——半途中断的那几场全靠它
    const { dir: nasDir, reason } = resolveNasBase(
      nasDirOf.get(keyOf(meetingId, subMeetingId)) ?? null,
      foundBase.get(k),
    )
    out.push({
      meetingId,
      subMeetingId,
      oldRel,
      newRel,
      local: {
        from: join(localRoot, oldRel),
        to: join(localRoot, newRel),
        exists: await exists(join(localRoot, oldRel)),
      },
      nas:
        nasDir === null
          ? null
          : {
              dir: nasDir,
              from: join(nasDir, oldRel),
              to: join(nasDir, newRel),
              exists: await exists(join(nasDir, oldRel)),
            },
      duplicate: false,
      conflictReason: reason,
      source: 'path',
    })
  }

  // 同一个旧目录被多场会议算出来 → 全体标记（两遍合起来一起判）。第一场改完之后其余几场的旧目录就不见了，
  // 它们的库行会安静地留在旧路径上，而目录已经不在那儿——这一步就是不让那件事发生。
  const seen = new Map<string, number>()
  for (const it of out) seen.set(it.oldRel, (seen.get(it.oldRel) ?? 0) + 1)
  for (const it of out) if ((seen.get(it.oldRel) ?? 0) > 1) it.duplicate = true

  return out
}

/**
 * 只按前缀改 assets[].nasPath；manifest 可能被多场会议共用，别的条目一个不碰。
 *
 * **先写 .tmp 再 rename 盖过去**，不原地 writeFile：这一份 `_manifest.json` 是
 * `nas_dir` 根上那一份，同一条归档规则渲染出的**所有**会议共用它。原地写到一半
 * 断掉（NAS 掉线是这个脚本最常见的故障），留下的是一份被截断的 JSON——不是这一场
 * 会议的条目没改成，是整份 manifest 连同其余几百场一起读不出来了。rename 在同一个
 * 目录里是原子的，读的人要么看到旧的完整版、要么看到新的完整版。
 */
async function rewriteManifest(dir: string, oldPrefix: string, newPrefix: string): Promise<void> {
  const p = join(dir, '_manifest.json')
  if (!(await exists(p))) return
  const doc = JSON.parse(await readFile(p, 'utf8')) as { assets?: Array<{ nasPath?: string }> }
  for (const a of doc.assets ?? []) {
    if (typeof a.nasPath === 'string' && a.nasPath.startsWith(oldPrefix)) {
      a.nasPath = newPrefix + a.nasPath.slice(oldPrefix.length)
    }
  }
  // .tmp 与目标同目录：跨设备的 rename 会 EXDEV，而 NAS 挂载点与本地临时目录
  // 恰好就是两个设备
  const tmp = `${p}.tmp`
  await writeFile(tmp, JSON.stringify(doc, null, 2))
  await rename(tmp, p)
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
export async function undoRename(from: string, to: string, what: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    console.error(
      `‼ ${what} 回滚失败：${from} 改不回 ${to}（${err}）。` +
        '目录停在新名字上、库里还是旧路径，两边对不上了，请手工把目录改回去再重跑本脚本',
    )
  }
}

/**
 * 「目录与库都已经改完了，只有 manifest 没写成」。
 *
 * 这一场会被计成 failed，而 failed 的默认读法是「这一场原地没动，重跑一次就好」——
 * 在这里那是错的：重跑会把它判成 already_done，manifest 再也没人回来改。所以这个
 * 错误单开一类，让 main 把「已经做完了什么」原样说出来。
 */
class ManifestOnlyError extends Error {
  constructor(
    readonly item: RenameItem,
    readonly cause: unknown,
  ) {
    super(`manifest 重写失败：${cause}`)
    this.name = 'ManifestOnlyError'
  }
}

export async function applyOne(pool: Pool, item: RenameItem): Promise<ApplyOutcome> {
  const doLocal = item.local.exists
  const doNas = item.nas !== null && item.nas.exists

  // 重复目录、以及 NAS 基准目录说不清楚：先判，判在任何 stat / rename 之前
  if (item.duplicate || item.conflictReason !== null) return 'conflict'

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
  // already_done），所以这一步的异常照旧往上抛，让人看见——但要**说清楚已经做完了
  // 什么**，否则操作员看到 failed 只会以为这一场整个没动。这就是 ManifestOnlyError
  // 的用途，main 认得它，打出来的那一行会写明只剩 manifest 要人工收尾。
  if (doNas) {
    try {
      await rewriteManifest(item.nas!.dir, `${item.nas!.from}/`, `${item.nas!.to}/`)
    } catch (err) {
      throw new ManifestOnlyError(item, err)
    }
  }
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
      // 基准目录说不清楚的先判，判在 already_done / not_found 之前：这一条的 nas.exists
      // 本来就问错了目录，让它掉进 already_done 等于把「没人动过 NAS」说成「上次跑成功了」
      if (item.conflictReason !== null) {
        conflict++
        console.error(
          `⚠ ${who} ${item.oldRel} conflict：${item.conflictReason}——这一条不动，请人工确认 NAS 基准目录`,
        )
        continue
      }
      if (!todo) {
        // 目录一个都不在：分清「上次跑成功了」与「压根没找到」
        const done =
          (await exists(item.local.to)) || (item.nas !== null && (await exists(item.nas.to)))
        if (done) alreadyDone++
        else {
          notFound++
          console.error(
            `⚠ ${who} ${item.oldRel}（来自${item.source === 'meeting' ? ' meetings 行' : '路径列'}）` +
              '旧目录与新目录都不在，本地/NAS 上找不到这个目录' +
              (item.source === 'meeting' ? '——meetings 行描述的那一场从没落过盘时这是正常的' : ''),
          )
        }
        continue
      }
      console.log(
        `${who}\n  ${item.oldRel}\n  → ${item.newRel}\n` +
          `  local=${item.local.exists} nas=${item.nas?.exists ?? 'n/a'} 来自=${item.source === 'meeting' ? 'meetings 行' : '路径列'}`,
      )
      if (item.duplicate) {
        conflict++
        console.error('  conflict：另有会议算出同一个目录，这几场一律不动')
        continue
      }
      if (!args.apply) {
        // dry-run 也把「目标目录已存在」说出来。不说的话操作员看到的是一份
        // 全绿的计划，`--apply` 跑完才知道有几场原地没动——dry-run 存在的意义
        // 就是别让人带着这种意外去执行。
        //
        // 这一条只打印、不计 conflict，所以退出码不受它影响；而上面**重复目录**
        // 那一条计了 conflict，dry-run 因此会以退出码 1 结束——这是有意的：重复目录
        // 是计划本身有问题，不该让 CI 或 `&&` 串起来的下一条命令当成「计划没问题」
        // 接着往下走。
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
        if (err instanceof ManifestOnlyError) {
          // 改名与三张表都已经提交，重跑会判 already_done——说清楚，别让人白跑一趟
          console.error(
            `  failed：${err.cause}\n` +
              `    目录改名与三张表已经改完并提交了，只差 ${join(item.nas!.dir, '_manifest.json')} 这一份没写成。\n` +
              `    重跑本脚本修不了它（旧目录已经不在，这一场会被判 already_done）：\n` +
              `    手工把这份 manifest 里前缀为 ${item.nas!.from}/ 的 nasPath 改成 ${item.nas!.to}/ 即可。`,
          )
        } else {
          console.error(`  failed：${err}`)
        }
      }
    }
    console.log(
      args.apply
        ? `renamed=${renamed} already_done=${alreadyDone} not_found=${notFound} conflict=${conflict} failed=${failed}`
        : `dry-run：${plan.length} 个目录（meetings 行 ${plan.filter((i) => i.source === 'meeting').length} + 路径列 ${plan.filter((i) => i.source === 'path').length}），` +
          `其中 ${plan.length - alreadyDone - notFound} 个需要改名（加 --apply 执行）`,
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
