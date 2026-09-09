#!/usr/bin/env bun
/**
 * 周期会议按录制记录拆场次的一次性脚本（spec 2026-09-09 §2.4）。
 *
 *   旧：一个 meeting_id 一行 meetings（sub_meeting_id 是空串），六个场次的资产
 *       全挤在一行会议下、文件全落进最新那一场的目录里
 *   新：一个 meeting_record_id 一行 meetings，各自的目录、各自的授权与归档记录
 *
 * 用法：
 *   DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/split-recurring-meetings.ts           # dry-run
 *   DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/split-recurring-meetings.ts --apply   # 真改
 *
 * 跑之前**停掉网关与调度器**：搬文件与归档流水线并发，会让一半文件写到旧目录。
 * 建议 `2>&1 | tee split-$(date +%s).log`。
 *
 * 可重复跑：只处理 `sub_meeting_id = ''` 的 meetings 行，跑成功之后那些行就没了，
 * 第二次跑计划是空的。
 *
 * 与 scripts/rename-archive-dirs.ts 共用「什么算存在」（exists）、「NAS 基准目录怎么
 * 反推」（NAS_BASE / resolveNasBase / mergeBase / cleanBase）、「回滚不许抛」
 * （undoRename）这几件事——各写一遍就会漂移，而漂移的表现是「NAS 掉线被当成目录不
 * 存在，于是只改库不改盘」这种查不出来的事。
 *
 * 两遍：`planSplits` 只读、算出每场会议要拆成什么样；`applyOne` 按计划动手
 * （先搬文件、再一个事务改七张表、最后重写 NAS 侧车并清空旧目录）。**事务里不碰文件、
 * 事务外不碰库**——文件系统没有回滚，库有。
 *
 * ⚠️ **规划与执行必须用同一个 `now`**：目录序号按 `meetings.created_at` 排，而那一列
 * 写进去的就是执行这一遍的 `now`。`main` 只取一次，两遍共用。
 */
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  ASSET_KEY_TO_GATEWAY_TYPE,
  GATEWAY_TYPE_TO_ASSET_KEY,
  assetKeyToFilename,
  assignDirOrdinals,
  meetingDirPath,
  meetingPathKey,
  type AssetKey,
} from '@yaowu/mde-engine'
import { createPool, runMigrations, type Pool } from '../src/store/db'
import { createArchivesStore } from '../src/store/archives'
import { jobFailureTarget } from '../src/store/jobs'
import { writeNasSidecars } from '../src/worker/nas-sidecars'
import {
  NAS_BASE, cleanBase, exists, mergeBase, resolveNasBase, undoRename, type DerivedBase,
} from './rename-archive-dirs'

export interface SplitArgs { apply: boolean }

export function parseArgs(argv: string[]): SplitArgs {
  return { apply: argv.includes('--apply') }
}

/**
 * `applyOne` 的五种结局，词汇与改名脚本同一套（spec §2.4「输出」）。
 *
 * `renamed` 沿用改名脚本的说法：这一场**动过了**（文件搬了、库改了）。
 * `already_done` 在这里特指「文件早就在新位置上了（上一次跑在事务之前断掉），
 * 这一次只补库」——不是「什么都没做」，因为 sub_meeting_id 还是空串时库总归要改。
 */
export type ApplyOutcome = 'renamed' | 'already_done' | 'not_found' | 'conflict' | 'undecidable'

export interface SplitFile { from: string; to: string }

export interface SplitAsset {
  /** meeting_assets.id——改这一行走主键，不做前缀匹配 */
  id: number
  assetType: string
  remoteId: string
  fileType: string
  /** 从 asset_id 第一段切出来的 meeting_record_id */
  recordId: string
  oldTargetPath: string | null
  newTargetPath: string
  /** 本地归档区里的绝对路径；target_path 为空（从没落过盘）时是 null */
  local: SplitFile | null
  /** NAS 上的绝对路径；没有 archived_assets 行、或反推不出基准目录时是 null */
  nas: SplitFile | null
}

export interface SplitSession {
  recordId: string
  subject: string | null
  meetingCode: string | null
  hostUserId: string | null
  startTime: number | null
  endTime: number | null
  /** meetingDirPath 算出来的新目录（相对） */
  newRel: string
  assets: SplitAsset[]
  /**
   * 这一场有没有**搬得动的** NAS 归档（有 archived_assets 行、且这场会议反推得出
   * NAS 基准目录）——决定要不要给它复制一行 meeting_archives。
   */
  archived: boolean
}

export interface SplitItem {
  meetingId: string
  /** 旧 '' 行按自己的 subject/start_time/code 算出来的目录，用来收尾时清空目录 */
  oldRel: string
  /** NAS 基准目录；这场会议在 NAS 上什么都没有时是 null */
  nasDir: string | null
  sessions: SplitSession[]
  /**
   * 非 null = 这一条不动手（`applyOne` 直接返回 undecidable），字符串是给人看的理由。
   * 五种来路：资产的 record id 在 meeting_cache 里查不到且不止一个、asset_id 说不出
   * 场次、asset_type 不在引擎词汇表里、归档行与资产行对同一个文件说了两个本地路径、
   * NAS 基准目录讲不清楚。
   */
  undecidableReason: string | null
}

interface MeetingRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  meeting_code: string | null
  subject: string | null
  host_userid: string | null
  start_time: number | null
  end_time: number | null
  created_at: number
}

interface CacheRow extends RowDataPacket {
  meeting_id: string
  meeting_record_id: string
  meeting_code: string
  subject: string
  host_user_id: string
  start_time: number
  end_time: number
}

interface AssetRow extends RowDataPacket {
  id: number
  meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  record_id: string | null
  target_path: string | null
}

interface ArchivedRow extends RowDataPacket {
  meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  local_path: string
  nas_path: string
}

interface BaseRow extends RowDataPacket { meeting_id: string; base: string | null }
interface NasDirRow extends RowDataPacket { meeting_id: string; nas_dir: string }

/** meeting_assets 与 archived_assets 共用的自然键，与 archive.ts 的 naturalKey 同一形状 */
const naturalKey = (r: { asset_type: string; remote_id: string; file_type: string }): string =>
  `${r.asset_type}\u0000${r.remote_id}\u0000${r.file_type}`

/**
 * 一个资产在**新的**分组 `(meeting_id, record_id, asset_type, file_type)` 里的序号。
 *
 * 与 `Store.siblingRank` 逐字同一个分组与同一个排序（按 id 升序），因为文件名要由
 * `assetKeyToFilename` 按同一个 ordinal 算出来——两处不一致的表现是脚本把文件搬到
 * 一个名字上，而下一轮 worker 又按另一个名字去写。
 */
function assignOrdinals(assets: AssetRow[]): Map<number, number> {
  const groups = new Map<string, AssetRow[]>()
  for (const a of [...assets].sort((x, y) => x.id - y.id)) {
    const k = `${a.record_id}\u0000${a.asset_type}\u0000${a.file_type}`
    const g = groups.get(k)
    if (g === undefined) groups.set(k, [a])
    else g.push(a)
  }
  const out = new Map<number, number>()
  for (const g of groups.values()) g.forEach((a, i) => out.set(a.id, i + 1))
  return out
}

/**
 * @param now 脚本这一轮插入场次行时要写进 `meetings.created_at` 的秒数。目录序号按
 *   `created_at` 排（见 `assignDirOrdinals`），所以规划与执行必须用**同一个** now，
 *   否则算出来的目录名和插进去的行对不上。执行那一遍把自己的 now 传进来。
 */
export async function planSplits(
  pool: Pool,
  localRoot: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SplitItem[]> {
  // 要拆的是 '' 行，但**同一个 meeting_id 下已经按场次建好的兄弟行也要读出来**：
  // 有兄弟行 = 这场会议已经处在「一半旧一半新」的混合状态里，整场判 undecidable
  // 不动手（planOne 的 ⓪ 写着为什么不试着修）。这种状态是真会出现的——上一轮被判
  // undecidable 跳过的会议留着 '' 行，而调度器接着又按新代码给它的新场次建了行。
  const [meetingRows] = await pool.execute<MeetingRow[]>(
    `SELECT meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at
       FROM meetings ORDER BY meeting_id, sub_meeting_id`,
  )
  const legacy = meetingRows.filter((r) => r.sub_meeting_id === '')
  if (legacy.length === 0) return []
  const siblingsOf = new Map<string, MeetingRow[]>()
  for (const r of meetingRows) {
    if (r.sub_meeting_id === '') continue
    const g = siblingsOf.get(r.meeting_id)
    if (g === undefined) siblingsOf.set(r.meeting_id, [r])
    else g.push(r)
  }

  // 场次清单的来源。meeting_cache 的主键就是 meeting_record_id，它一直是按场次存的
  const [cacheRows] = await pool.execute<CacheRow[]>(
    `SELECT meeting_id, meeting_record_id, meeting_code, subject, host_user_id, start_time, end_time
       FROM meeting_cache ORDER BY meeting_id, meeting_record_id`,
  )
  const cacheOf = new Map<string, CacheRow[]>()
  for (const c of cacheRows) {
    const g = cacheOf.get(c.meeting_id)
    if (g === undefined) cacheOf.set(c.meeting_id, [c])
    else g.push(c)
  }

  // 每一行资产带着自己场次的 record id：asset_id 是
  // `<meetingRecordId>:<recordFileId>:<assetType>:<selector>`，第一段就是它
  const [assetRows] = await pool.execute<AssetRow[]>(
    `SELECT id, meeting_id, asset_type, remote_id, file_type, target_path,
            SUBSTRING_INDEX(asset_id, ':', 1) AS record_id
       FROM meeting_assets WHERE sub_meeting_id = '' ORDER BY meeting_id, id`,
  )
  const assetsOf = new Map<string, AssetRow[]>()
  for (const a of assetRows) {
    const g = assetsOf.get(a.meeting_id)
    if (g === undefined) assetsOf.set(a.meeting_id, [a])
    else g.push(a)
  }

  const [archivedRows] = await pool.execute<ArchivedRow[]>(
    `SELECT meeting_id, asset_type, remote_id, file_type, local_path, nas_path
       FROM archived_assets WHERE sub_meeting_id = ''`,
  )
  const archivedOf = new Map<string, Map<string, ArchivedRow>>()
  for (const r of archivedRows) {
    const g = archivedOf.get(r.meeting_id) ?? new Map<string, ArchivedRow>()
    g.set(naturalKey(r), r)
    archivedOf.set(r.meeting_id, g)
  }

  // NAS 基准目录：有 meeting_archives 行以它为准，没有就从 nas_path 反推
  // （归档半途中断的会议只有 archived_assets 行，见 rename-archive-dirs.ts 的文件头）
  const [baseRows] = await pool.execute<BaseRow[]>(
    `SELECT DISTINCT meeting_id, ${NAS_BASE} AS base FROM archived_assets WHERE sub_meeting_id = ''`,
  )
  const derivedBaseOf = new Map<string, DerivedBase>()
  for (const b of baseRows) mergeBase(derivedBaseOf, b.meeting_id, cleanBase(b.base))
  const [dirRows] = await pool.execute<NasDirRow[]>(
    `SELECT meeting_id, nas_dir FROM meeting_archives WHERE sub_meeting_id = ''`,
  )
  const nasDirOf = new Map<string, string>()
  for (const d of dirRows) nasDirOf.set(d.meeting_id, d.nas_dir)

  const out: SplitItem[] = []
  for (const m of legacy) {
    out.push(
      planOne(m, {
        localRoot,
        now,
        siblings: siblingsOf.get(m.meeting_id) ?? [],
        cache: cacheOf.get(m.meeting_id) ?? [],
        assets: assetsOf.get(m.meeting_id) ?? [],
        archived: archivedOf.get(m.meeting_id) ?? new Map(),
        nas: resolveNasBase(nasDirOf.get(m.meeting_id) ?? null, derivedBaseOf.get(m.meeting_id)),
      }),
    )
  }
  return out
}

interface PlanInput {
  localRoot: string
  now: number
  siblings: MeetingRow[]
  cache: CacheRow[]
  assets: AssetRow[]
  archived: Map<string, ArchivedRow>
  nas: { dir: string | null; reason: string | null }
}

/** 一个场次的元数据：来自 meeting_cache，或（孤儿 record id）来自 meetings 行自己 */
interface SessionMeta {
  recordId: string
  subject: string | null
  meetingCode: string | null
  hostUserId: string | null
  startTime: number | null
  endTime: number | null
}

/**
 * BIGINT 列显式 Number 化，与 `src/worker/store-mysql.ts` 的 `meetingsForPaths` 同一条理由：
 * `created_at` 是目录序号的主序、`start_time` 进目录名，混进一个字符串会让比较规则取决于
 * 驱动怎么返回 BIGINT，而序号定的是盘上的目录名——脚本与引擎必须给出同一个答案。
 */
const num = (v: number | null): number | null => (v === null ? null : Number(v))

/** assignDirOrdinals 要的那几个字段 */
const dirRow = (meetingId: string, subMeetingId: string, createdAt: number, s: {
  subject: string | null; startTime: number | null; meetingCode: string | null
}) => ({ meetingId, subMeetingId, createdAt, subject: s.subject, startTime: s.startTime, meetingCode: s.meetingCode })

function planOne(m: MeetingRow, input: PlanInput): SplitItem {
  const self = { subject: m.subject, startTime: num(m.start_time), meetingCode: m.meeting_code }
  // 旧行**此刻在盘上的**目录：按库里现有的行（'' 行 + 已经拆好的兄弟行）算一遍序号，
  // 与引擎这一刻算出来的口径一致。绝大多数会议只有 '' 行一行，序号就是 1、没有后缀。
  const oldOrdinals = assignDirOrdinals([
    dirRow(m.meeting_id, '', Number(m.created_at), self),
    ...input.siblings.map((s) =>
      dirRow(s.meeting_id, s.sub_meeting_id, Number(s.created_at), {
        subject: s.subject, startTime: num(s.start_time), meetingCode: s.meeting_code,
      })),
  ])
  const oldRel = meetingDirPath(self, m.meeting_id, oldOrdinals.get(meetingPathKey(m.meeting_id, '')) ?? 1)
  const bail = (reason: string): SplitItem => ({
    meetingId: m.meeting_id, oldRel, nasDir: input.nas.dir, sessions: [], undecidableReason: reason,
  })

  // ⓪ 混合状态：这个 meeting_id 下已经有按场次建好的行了。不修、不猜，整场不动。
  //
  //    这种库同时被两套目录序号解释：眼下引擎把 '' 旧行也算进去（它 created_at 最早、
  //    占着序号 1），于是与它同分钟的那个兄弟场次的文件躺在 `…_2/` 里；而 '' 行一旦被
  //    这个脚本删掉，引擎下一轮就会说那个兄弟该在无后缀的目录里。也就是说**在脚本动手
  //    之前，盘上的位置就已经和拆完之后的库对不上了**，而脚本正要把旧行的文件往那个
  //    `…_2/` 里搬——搬过去就是覆盖。
  //
  //    要修得动它，脚本得反过来给兄弟行的文件也改名、连带 meeting_assets 的文件名序号
  //    （assignOrdinals 只看得见 '' 行的资产，兄弟行的资产不在计划里，改完还会撞
  //    uk_asset）。那是另一个脚本的活。**正确做法是别让这种状态出现**：拆分脚本要在
  //    新代码首轮拉取之前跑（spec §2.5 的上线顺序）。
  if (input.siblings.length > 0) {
    return bail(
      `会议 ${m.meeting_id} 已有按场次的行（${input.siblings.length} 条），` +
        '拆分脚本必须在新代码首轮拉取之前跑；请按 runbook 先停服务，删掉这些场次行及其下载文件后重跑',
    )
  }

  if (input.nas.reason !== null) return bail(input.nas.reason)

  // 有归档行、却讲不出 NAS 基准目录（没有 meeting_archives 行，nas_path 又短到
  // 反推不出来）。这时每个资产的 `nas` 都是 null，于是 archived_assets 那几行的
  // sub_meeting_id 一列都不会改——而 meetings 的 '' 行同一个事务里就删掉了，
  // 它们从此挂在一个不存在的会议上，谁也扫不出来。宁可整场不动
  if (input.archived.size > 0 && input.nas.dir === null) {
    return bail(
      `这场会议有 ${input.archived.size} 行 archived_assets，却反推不出 NAS 基准目录` +
        '（没有 meeting_archives 行，nas_path 也短到砍不出前四段）——' +
        '拆了会把这些归档行留在空 sub_meeting_id 上，成为无主行',
    )
  }

  // ① 每个资产属于哪个场次
  for (const a of input.assets) {
    if (a.record_id === null || a.record_id === '') {
      return bail(`meeting_assets.id=${a.id} 的 asset_id 是空的，说不出它属于哪个场次——不许猜`)
    }
    const key = GATEWAY_TYPE_TO_ASSET_KEY[a.asset_type]
    if (key === undefined || !Object.hasOwn(ASSET_KEY_TO_GATEWAY_TYPE, key)) {
      return bail(`meeting_assets.id=${a.id} 的 asset_type=${a.asset_type} 不在引擎的资产词汇表里，算不出新文件名`)
    }
    const arch = input.archived.get(naturalKey(a))
    if (arch !== undefined && a.target_path !== null && arch.local_path !== a.target_path) {
      return bail(
        `archived_assets.local_path（${arch.local_path}）与 meeting_assets.target_path（${a.target_path}）不一致，` +
          '这两列本该是同一个值的副本，不一致时说不清该按哪个搬文件',
      )
    }
  }

  // ①bis 归档行必须都有主。`archived_assets` 的 sub_meeting_id 是**跟着资产行**改的
  //      （`splitRows` 逐个 `a.nas` 发 UPDATE），所以一条对不上任何 meeting_assets
  //      自然键的归档行谁也认领不了：它会留在空 sub_meeting_id 上，而 meetings 的
  //      '' 行同一个事务里就删掉了——又是一条谁也扫不出来的无主行（与上面那条
  //      「有归档行却反推不出 NAS 基准目录」是同一种损失的两个来路）。
  //      真出现的来路：资产行被手工删过、或归档写完之后 remote_id 变了。
  const claimed = new Set(input.assets.map((a) => naturalKey(a)))
  const unclaimed = [...input.archived.values()].filter((r) => !claimed.has(naturalKey(r)))
  if (unclaimed.length > 0) {
    return bail(
      `${unclaimed.length} 行 archived_assets 对不上任何 meeting_assets 行` +
        `（${unclaimed.map((r) => `${r.asset_type}/${r.remote_id}/${r.file_type}`).join('、')}）——` +
        '这些行的 sub_meeting_id 是跟着资产行改的，没有资产行认领就会留在空 sub_meeting_id 上，成为无主行',
    )
  }

  // ② 场次清单 = meeting_cache 的行 + 至多一个「缓存里没有」的孤儿 record id
  const known = new Set(input.cache.map((c) => c.meeting_record_id))
  const orphans = [...new Set(input.assets.map((a) => a.record_id!))].filter((r) => !known.has(r))
  if (orphans.length > 1) {
    return bail(
      `${orphans.length} 个 record id（${orphans.join(', ')}）在 meeting_cache 里查不到，` +
        '拿不到它们各自的 start_time 就算不出目录——只有单场次会议的老数据允许有一个',
    )
  }
  const sessionsMeta: SessionMeta[] = [
    ...input.cache.map((c) => ({
      recordId: c.meeting_record_id, subject: c.subject, meetingCode: c.meeting_code,
      hostUserId: c.host_user_id, startTime: Number(c.start_time), endTime: Number(c.end_time),
    })),
    ...orphans.map((r) => ({
      recordId: r, subject: m.subject, meetingCode: m.meeting_code,
      hostUserId: m.host_userid, startTime: num(m.start_time), endTime: num(m.end_time),
    })),
  ]
  if (sessionsMeta.length === 0) {
    return bail('meeting_cache 里没有这个 meeting_id 的任何场次，资产也反推不出 record id')
  }

  // ③ 每个场次的新目录序号。同一分钟的两条录制记录（正常录制 + 「转写_」那条，
  //    本机 84/294 场）算出同名目录，靠 assignDirOrdinals 给第二条加 `_2`——序号
  //    绝不自己另算，脚本与引擎必须是同一份实现（见 domain/dir-ordinal.ts）。
  //
  //    喂进去的就是**拆完之后这个 meeting_id 下会有的全部行**：本轮新建的这批场次，
  //    `created_at` 全是同一个 `now`，于是定序的是 record id 那一档——与执行那一遍插完行
  //    之后引擎自己再算一遍的答案逐字一致。
  //
  //    名单里没有别人：待删的 '' 旧行同一个事务里就没了（算进去会让与它同目录的那个
  //    场次白白挪到 `_2`，而下一轮引擎又说它该在无后缀的目录里），已经按场次建好的
  //    兄弟行在上面 ⓪ 就整场 bail 掉了。
  const dirOrdinals = assignDirOrdinals(
    sessionsMeta.map((s) => dirRow(m.meeting_id, s.recordId, input.now, s)),
  )

  // ④ 每个资产的新路径
  const ordinalOf = assignOrdinals(input.assets)
  const sessions: SplitSession[] = sessionsMeta.map((s) => {
    const newRel = meetingDirPath(
      { subject: s.subject, startTime: s.startTime, meetingCode: s.meetingCode }, m.meeting_id,
      dirOrdinals.get(meetingPathKey(m.meeting_id, s.recordId)) ?? 1,
    )
    const assets: SplitAsset[] = input.assets
      .filter((a) => a.record_id === s.recordId)
      .map((a) => {
        const key = GATEWAY_TYPE_TO_ASSET_KEY[a.asset_type] as AssetKey
        const fname = assetKeyToFilename(key, a.remote_id, a.file_type, ordinalOf.get(a.id) ?? 1)
        const newTargetPath = `${newRel}/${fname}`
        const arch = input.archived.get(naturalKey(a))
        return {
          id: a.id, assetType: a.asset_type, remoteId: a.remote_id, fileType: a.file_type,
          recordId: s.recordId, oldTargetPath: a.target_path, newTargetPath,
          local: a.target_path === null ? null : {
            from: join(input.localRoot, a.target_path), to: join(input.localRoot, newTargetPath),
          },
          nas: arch === undefined || input.nas.dir === null ? null : {
            from: arch.nas_path, to: join(input.nas.dir, newTargetPath),
          },
        }
      })
    return {
      ...s, newRel, assets,
      archived: assets.some((a) => a.nas !== null),
    }
  })

  // ⑤ 最后一道闸：序号本该保证两个场次落进不同目录、两个资产落进不同文件名。真撞上了
  //    说明序号算错了——改一次只能搬一次，先动的那场会把后面几场的行留在旧路径上，
  //    宁可整场不动。（同名文件名是真会有的：video 与 audio 的文件名都是
  //    `recording_<remoteId>`，同一段录制的两路导出撞同一个扩展名就重名。）
  const rels = sessions.map((s) => s.newRel)
  if (new Set(rels).size !== rels.length) {
    return bail(`两个场次算出同一个目录（${rels.join(', ')}），它们会争同一批文件名`)
  }
  const targets = sessions.flatMap((s) => s.assets.map((a) => a.newTargetPath))
  if (new Set(targets).size !== targets.length) {
    return bail('两个资产算出同一个新路径，搬过去会互相覆盖')
  }

  return { meetingId: m.meeting_id, oldRel, nasDir: input.nas.dir, sessions, undecidableReason: null }
}

export interface ApplyResult {
  outcome: ApplyOutcome
  /** 搬空之后**没有**删掉的旧目录：里面还有不认识的东西。绝不删非空目录 */
  leftOver: string[]
}

/** 一次文件搬运的三种处境 */
type MoveState = 'move' | 'done' | 'gone'

interface PlannedMove extends SplitFile { state: MoveState }

/**
 * 两阶段搬运的临时后缀。加在**源文件原地**（同目录），所以那一步改名是原子的、
 * 也不会碰上 NAS 挂载点与本地盘之间的 EXDEV。
 */
const TMP_SUFFIX = '.mde-split-tmp'

/**
 * 两个路径是不是同一个文件。**不能只比字符串**：macOS 的默认文件系统大小写不敏感，
 * 而「同一个文件的两个写法」被判成 conflict 会让整场会议白白停下。
 */
async function sameFile(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  try {
    const [x, y] = [await stat(a), await stat(b)]
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/**
 * 一条搬运的处境；目标被**外人**占了返回 null（调用方按 conflict 处理）。
 *
 * `sources` 是这一场会议自己要搬走的全部源路径。目标被占、而占着它的正是我们自己
 * 要搬走的另一个文件时**不算冲突**——拆场次天然会出现这种交换：
 * 第一场的 `transcript.txt` 要搬到自己的新目录去，而第二场的 `transcript_2.txt`
 * 要改名成 `transcript.txt` 顶上它的位置。两阶段搬运（先全部让位到 .tmp，再各就各位）
 * 处理的就是这种交换，包括首尾相接的环。
 */
async function classify(f: SplitFile, sources: ReadonlySet<string>): Promise<PlannedMove | null> {
  if (await sameFile(f.from, f.to)) return { ...f, state: 'done' }
  if (await exists(f.from)) {
    if ((await exists(f.to)) && !sources.has(f.to)) return null
    return { ...f, state: 'move' }
  }
  return { ...f, state: (await exists(f.to)) ? 'done' : 'gone' }
}

/**
 * 撞唯一键。`meeting_assets.uk_asset`、`archived_assets` / `asset_contents` 的主键都是
 * `(meeting_id, sub_meeting_id, asset_type, remote_id, file_type)`，把 `sub_meeting_id`
 * 从空串改成 record id 时，目标那一行已经有人占着就是这个错。
 */
function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; errno?: unknown }
  return e.code === 'ER_DUP_ENTRY' || e.errno === 1062
}

/**
 * 拆一场会议。顺序固定（spec §2.4「执行」）：本地文件 → NAS 文件 → 一个事务 →
 * 侧车与空目录。事务失败把已经搬动的文件原样搬回去。
 *
 * **事务里不碰文件、事务外不碰库**：文件系统没有回滚，库有。所以先做能撤销的
 * （搬文件，撤销 = 搬回来），再做原子的（一个事务改七张表）；反过来的话事务提交了
 * 而文件搬到一半，库与盘的对应关系就再也说不清了。
 *
 * @param opts.now 必须与算出这份 `item` 的 `planSplits(pool, root, now)` 是**同一个**值：
 *   它会被写进每一行新建的 `meetings.created_at`，而目录序号正是按那一列排的。
 */
export async function applyOne(
  pool: Pool,
  item: SplitItem,
  opts: { localRoot: string; now: number },
): Promise<ApplyResult> {
  if (item.undecidableReason !== null) return { outcome: 'undecidable', leftOver: [] }

  // ── 分类 ────────────────────────────────────────────────────────────
  const files: SplitFile[] = []
  for (const s of item.sessions) {
    for (const a of s.assets) {
      if (a.local !== null) files.push(a.local)
      if (a.nas !== null) files.push(a.nas)
    }
  }
  const sources = new Set(files.map((f) => f.from))
  const planned: PlannedMove[] = []
  for (const f of files) {
    const c = await classify(f, sources)
    if (c === null) return { outcome: 'conflict', leftOver: [] }
    planned.push(c)
  }
  // 暂存路径已经被占着：上一次跑在两阶段之间被杀掉，文件停在 .tmp 上。
  // 直接搬会**静默覆盖**那个文件（rename(2) 不问目标在不在），而它是上一轮唯一的副本。
  // 这一场整场不动，让人先把 .tmp 收拾了。
  //
  // **每一条计划都要查，不只是 state==='move' 的那些**：第一阶段之后被杀掉时源路径
  // 已经空了（文件正躺在 .tmp 上），新位置又还没建出来，于是 classify 把这一条判成
  // `gone`——而全 gone 是 `not_found`，退出码都不变，这一场就悄悄溜过去了，
  // 下一轮 worker 照着库里的旧路径重新下载，那份唯一的副本永远晾在 .tmp 上没人认领。
  // 所以这道闸必须排在下面「全 gone → not_found」**之前**。
  for (const p of planned) {
    if (await exists(p.from + TMP_SUFFIX)) {
      console.error(
        `⚠ ${item.meetingId} conflict：${p.from + TMP_SUFFIX} 已经存在——` +
          '上一次跑多半在两阶段搬运之间被杀掉了，文件还停在这个暂存名上。' +
          '先手工去掉 .mde-split-tmp 后缀把它改回去，再重跑本脚本',
      )
      return { outcome: 'conflict', leftOver: [] }
    }
  }

  // 一个文件都没找到（新旧位置都不在）：多半是根目录指错了，或者归档区被清理过。
  // 这时候改库等于把库指到一堆并不存在的路径上，宁可什么都不做、让人看见
  if (planned.length > 0 && planned.every((p) => p.state === 'gone')) {
    return { outcome: 'not_found', leftOver: [] }
  }
  // 单个找不到的文件不拦整场（本地文件被到期清理删过是正常的），但要逐条说出来：
  // 「这一条的文件哪儿都不在」是操作员该看见的事实（spec §2.4 执行 1 的 not_found）
  for (const p of planned) {
    if (p.state === 'gone') console.warn(`⚠ ${item.meetingId} not_found：${p.from} 新旧位置都不在`)
  }

  // ── 搬文件：两阶段 ──────────────────────────────────────────────────
  // ① 全部源文件先改名到同目录下的 .tmp，② 再从 .tmp 各就各位。
  // 一阶段直接 from→to 不行：拆场次天然有「A 的目标就是 B 的源」这种交换，
  // 顺序怎么排都可能撞上，环状的更是排不出来。同目录内改名是原子的，也不会 EXDEV。
  // 两阶段之间进程被杀的话，文件停在 .tmp 上，重跑会把它判成 not_found——
  // 那时按输出里的路径找 `*.mde-split-tmp` 手工改回去即可。
  const staged: PlannedMove[] = []
  const moved = new Set<PlannedMove>()
  /**
   * 回滚搬运。**必须与搬运一样分两阶段**：先把已经就位的文件退回**各自源路径的 .tmp**，
   * 全退完了再从 .tmp 落回源路径。
   *
   * 单阶段（逐条直接 `to → from`）是错的，而且是**真的会少文件**：`rename(2)` 静默覆盖
   * 目标，而两阶段搬完之后「旧路径」上往往正躺着另一个场次的文件——A→B、B→A 这种交换，
   * 或 A→B、B→C 这种链，是拆场次的常态（第二场的 `transcript_2.txt` 改名顶上第一场
   * `transcript.txt` 的位置）。逐条往回搬会把它盖掉，于是一次「只是想回滚」的失败真的
   * 抹掉了一个文件，而操作员看到的是「文件已搬回原位」。
   *
   * 反过来走两阶段就没有这个问题：第一阶段的目标全是 `<源路径>.mde-split-tmp`，
   * 那些路径此刻一定是空的（搬运的第二阶段刚把它们腾空）；第二阶段的目标全是源路径，
   * 而源路径此刻也一定是空的（每个源路径只有它自己那一条 .tmp 会落回来）。
   */
  const undoAll = async (): Promise<void> => {
    for (const p of [...staged].reverse()) {
      if (moved.has(p)) await undoRename(p.to, p.from + TMP_SUFFIX, '拆场次搬运')
    }
    for (const p of [...staged].reverse()) {
      await undoRename(p.from + TMP_SUFFIX, p.from, '拆场次暂存')
    }
  }
  try {
    for (const p of planned) {
      if (p.state !== 'move') continue
      await rename(p.from, p.from + TMP_SUFFIX)
      staged.push(p)
    }
    for (const p of staged) {
      await mkdir(dirname(p.to), { recursive: true })
      await rename(p.from + TMP_SUFFIX, p.to)
      moved.add(p)
    }
  } catch (err) {
    await undoAll()
    throw err
  }

  // ── 一个事务 ────────────────────────────────────────────────────────
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await splitRows(conn, item, opts.now)
    await conn.commit()
  } catch (err) {
    // rollback 自己也可能抛（UPDATE 失败最常见的原因就是连接断了，而断了的连接
    // 回滚同样会炸）。它抛出去的话下面的文件回滚一步都跑不到，于是文件在新位置、
    // 库还是旧的——而重跑会把这些文件判成 already_done，再也没人回来看它。
    // 所以：回滚失败只记一行，文件一定要搬回去，最后抛的是**最初那个**错误。
    try { await conn.rollback() } catch (rollbackErr) {
      console.error(`‼ ${item.meetingId} 事务回滚失败：${rollbackErr}`)
    }
    await undoAll()
    // 撞唯一键 = 目标那一行已经被别人占着，与「目标文件被外人占着」是同一件事的两半，
    // 所以落成 conflict 而不是往上抛。抛出去只会变成一行 failed，而 failed 的默认读法
    // 是「重跑一次就好」——重跑还会撞同一行，那是要人来看的事。
    // （规划这一遍已经把有兄弟 meetings 行的混合状态整场判掉了，但只有资产行、
    //   没有会议行的半拉子状态它看不见。）
    if (isDuplicateKey(err)) {
      console.error(`⚠ ${item.meetingId} conflict：改 sub_meeting_id 撞上唯一键（${err}），已回滚、文件搬回原位`)
      return { outcome: 'conflict', leftOver: [] }
    }
    throw err
  } finally {
    conn.release()
  }

  // ── 收尾：侧车与空目录（都在事务之后，失败不回滚已经一致的库与盘）────────
  // 这里往后炸的事**一律包成 FinishError**：事务已经提交、文件已经搬好，
  // 报成 failed 会让操作员按 failed 的默认读法去重跑，而重跑什么也修不了
  try {
    await rewriteNasSidecars(pool, item, opts.now)
    const leftOver = await cleanupOldDirs(item, planned, opts.localRoot)
    // 一个文件都没搬动、但库刚刚才改成：上一次跑在事务之前断掉了，这一次把库补上。
    // 这不是「什么都没做」，所以它与 not_found / conflict 分得开
    return { outcome: moved.size === 0 ? 'already_done' : 'renamed', leftOver }
  } catch (err) {
    throw new FinishError(item, err)
  }
}

/**
 * 收尾（NAS 侧车 / 清空旧目录）失败，而**库已经提交、文件已经搬好**。
 *
 * 与 `scripts/rename-archive-dirs.ts` 的 `ManifestOnlyError` 同一形状、同一用途：
 * 「已经提交了什么」必须说出来。报成一行 failed 的话，操作员会按 failed 的默认读法
 * （「修掉原因重跑」）去重跑——而这一场的 `''` 行已经没了，重跑一步都不会走到它，
 * 于是那份没写成的侧车、那个没清掉的旧目录永远留在盘上，而日志说它「失败了」。
 */
class FinishError extends Error {
  constructor(
    readonly item: SplitItem,
    readonly cause: unknown,
  ) {
    super(`收尾失败：${cause}`)
    this.name = 'FinishError'
  }
}

/** 七张表的改写与三张表的删除，全在调用方的事务里 */
async function splitRows(conn: PoolConnection, item: SplitItem, now: number): Promise<void> {
  const mid = item.meetingId

  // ① meetings：每个场次一行。created_at 用 now——目录序号按它排，规划那一遍算目录名
  //    时喂给 assignDirOrdinals 的就是这个值
  for (const s of item.sessions) {
    await conn.execute(
      `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [mid, s.recordId, s.meetingCode, s.subject, s.hostUserId, s.startTime, s.endTime, now, now],
    )
  }

  // ② meeting_assets / archived_assets / asset_contents：逐行改，走主键与自然键，
  //    不做前缀匹配（要做的话见 rename-archive-dirs.ts 的 PREFIX_SWAP，绝不用 LIKE）
  for (const s of item.sessions) {
    for (const a of s.assets) {
      await conn.execute(
        `UPDATE meeting_assets SET sub_meeting_id = ?, target_path = ?, updated_at = ? WHERE id = ?`,
        [s.recordId, a.newTargetPath, now, a.id],
      )
      if (a.nas !== null) {
        await conn.execute(
          `UPDATE archived_assets SET sub_meeting_id = ?, local_path = ?, nas_path = ?
            WHERE meeting_id = ? AND sub_meeting_id = '' AND asset_type = ? AND remote_id = ? AND file_type = ?`,
          [s.recordId, a.newTargetPath, a.nas.to, mid, a.assetType, a.remoteId, a.fileType],
        )
      }
      await conn.execute(
        `UPDATE asset_contents SET sub_meeting_id = ?
          WHERE meeting_id = ? AND sub_meeting_id = '' AND asset_type = ? AND remote_id = ? AND file_type = ?`,
        [s.recordId, mid, a.assetType, a.remoteId, a.fileType],
      )
    }
  }

  // ③④ 这三张表整行复制，一律走 `INSERT … SELECT`，**不把行读进 JS 再插回去**。
  //     `meeting_grants.asset_types` / `meeting_overrides.asset_types` 是 JSON 列，
  //     mysql2 通常已经替我们解析成数组，但驱动版本差异下也可能返回**字符串**
  //     （`src/store/grants.ts` 的 parseAssetTypes 就明确在处理这一种）。读回来的值
  //     再 `JSON.stringify` 一遍，那一档就成了二次编码：库里存的是 JSON 字符串
  //     `"[\"video\"]"` 而不是数组，而 `''` 那些行同一个事务里就删掉了，
  //     谁也回不去。SQL 里整列搬则一个字节都不经过驱动的类型转换。
  //
  // ③ meeting_archives：复制给**有 archived_assets 行的**场次。没归档过的场次不该
  //    凭空拿到一个归档记录——那会让它的保留窗口从别人的 archived_at 开始计时
  for (const s of item.sessions) {
    if (!s.archived) continue
    await conn.execute(
      `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, extended_days, local_purged_at, created_at, updated_at)
       SELECT meeting_id, ?, nas_dir, archived_at, retention_days, extended_days, local_purged_at, created_at, ?
         FROM meeting_archives WHERE meeting_id = ? AND sub_meeting_id = ''`,
      [s.recordId, now, mid],
    )
  }
  await conn.execute(`DELETE FROM meeting_archives WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid])

  // ④ meeting_grants / meeting_overrides：复制给**每一个**场次（含已撤销的行，
  //    revoked_at 原样）——一场会议上的授权与改写，对它的每个场次都成立
  for (const s of item.sessions) {
    await conn.execute(
      `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
       SELECT meeting_id, ?, program_id, asset_types, granted_at, revoked_at
         FROM meeting_grants WHERE meeting_id = ? AND sub_meeting_id = ''`,
      [s.recordId, mid],
    )
  }
  await conn.execute(`DELETE FROM meeting_grants WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid])

  for (const s of item.sessions) {
    await conn.execute(
      `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
       SELECT meeting_id, ?, kind, effect, asset_types, reason, created_at, revoked_at
         FROM meeting_overrides WHERE meeting_id = ? AND sub_meeting_id = ''`,
      [s.recordId, mid],
    )
  }
  await conn.execute(`DELETE FROM meeting_overrides WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid])

  // ⑤ 探测行删掉：它是过程量，下一轮发现会按场次重建。复制过去反而会让每个场次
  //    继承同一个 deadline_at 与 attempts，看着像真的、其实是编的
  await conn.execute(
    `DELETE FROM meeting_asset_probes WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid],
  )

  // ⑥ 会议维度的失败项标为已恢复：它的 target 编的是 `<meeting_id>|`，拆完之后
  //    再也不会有任何一轮往这个 target 上写。dead 资产下一轮由调度器按场次重新登记
  await conn.execute(
    `UPDATE job_failures SET resolved_at = ? WHERE target = ? AND resolved_at IS NULL`,
    [now, jobFailureTarget(mid, '')],
  )

  // ⑦ audit_log **不动**：它没有 sub 列，延长保留期的历史挂在 meeting_id 上。
  //    已知损失，写在上线 runbook 里

  await conn.execute(`DELETE FROM meetings WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid])
}

/**
 * 按新场次把 NAS 侧车重写一遍。
 *
 * **侧车在 `nas_dir` 根上，不在会议目录里**（`writeNasSidecars` 落的是
 * `<nasDir>/meeting.json`），同一条归档规则渲染出的所有会议共用那一份，归档流水线
 * 每轮也是这么覆盖的。这里逐场次写一遍，最后一场留在盘上——与流水线现有行为一致，
 * 不在一次性脚本里另发明一套。所以 NAS 那边**没有**「旧目录里的侧车」要删。
 *
 * 写不出来不算失败：文件与库已经一致了，侧车下一轮归档还会再写。但要留痕。
 */
async function rewriteNasSidecars(pool: Pool, item: SplitItem, now: number): Promise<void> {
  if (item.nasDir === null) return
  const archives = createArchivesStore(pool)
  for (const s of item.sessions) {
    if (!s.archived) continue
    try {
      const rec = await archives.findMeetingArchive(item.meetingId, s.recordId)
      await writeNasSidecars({
        meetingId: item.meetingId,
        subMeetingId: s.recordId,
        meeting: {
          meetingId: item.meetingId, subMeetingId: s.recordId, meetingCode: s.meetingCode,
          subject: s.subject, hostUserId: s.hostUserId, startTime: s.startTime, endTime: s.endTime,
        },
        completed: await archives.listCompletedAssets(item.meetingId, s.recordId),
        archived: await archives.listArchivedAssetsForMeeting(item.meetingId, s.recordId),
        missing: await archives.listMissingAssets(item.meetingId, s.recordId),
        // 侧车落在 nas_dir 根上，所以 root 与 dir 是同一个：relative(root, dir) = ''
        nasRoot: item.nasDir,
        nasDir: item.nasDir,
        retentionDays: rec?.retentionDays ?? 30,
        // 归档时刻取**这一场自己那行 meeting_archives 的 archived_at**（刚刚由
        // `splitRows` 从 '' 行原样复制过来）。写成 now 就是把保留窗口的起点说成了
        // 拆分时刻——库里明明还是原来那个数，数年后翻到这份清单的人会以为它晚归了
        // N 天。取不到行时（理论上不会：archived 为真才走到这里）退回 now
        archivedAt: rec?.archivedAt,
        now,
      })
    } catch (err) {
      console.warn(`⚠ ${item.meetingId}/${s.recordId} NAS 侧车没写成（文件与库已经一致，下一轮归档会补）：${err}`)
    }
  }
}

/**
 * 旧目录的收尾：先删掉旧目录里的 `_manifest.json` / `meeting.json`（本地那两份是
 * 按目录写的，留在旧目录里只会描述一个已经搬空了的地方，下一轮 worker 会按场次
 * 重新写出来），然后**空了才删目录**。
 *
 * 不空一律保留并记 left_over：里面躺着我们不认识的东西，删掉就再也找不回来了。
 */
async function cleanupOldDirs(
  item: SplitItem, planned: PlannedMove[], localRoot: string,
): Promise<string[]> {
  // 某个场次的**新**目录不在清理范围里：它刚刚才收到文件，本来就该有东西。
  // 周期会议里有一场的新目录恰好就是旧目录（start_time 最新的那一场，旧 meetings 行
  // 描述的正是它），不排除的话它会被当成「没搬干净的旧目录」报进 left_over
  const keep = new Set(planned.filter((p) => p.state !== 'gone').map((p) => dirname(p.to)))
  const dirs = new Set(planned.filter((p) => p.state === 'move').map((p) => dirname(p.from)))
  dirs.add(join(localRoot, item.oldRel))
  const leftOver: string[] = []
  for (const d of [...dirs].sort()) {
    if (keep.has(d)) continue
    if (!(await exists(d))) continue
    for (const f of ['_manifest.json', 'meeting.json']) {
      await rm(join(d, f), { force: true })
    }
    const rest = await readdir(d)
    // rmdir 而不是 rm：rm 对目录必须带 recursive，而带上它就成了「连里面的东西一起删」
    // ——这里要的恰恰是「只删空目录」，非空一律保留
    if (rest.length === 0) await rmdir(d)
    else leftOver.push(d)
  }
  return leftOver
}

/**
 * 一整轮的规划 + 执行，收一个已经跑过迁移的池。返回**退出码**。
 *
 * 与 `main` 分开是为了让「跑完之后库里还剩几行没拆」「收尾失败怎么报」这些
 * 只在整轮层面才成立的判断测得到——它们的现场是一份计划跑完之后的库，
 * 而不是某一场 `applyOne` 的返回值。
 *
 * @param opts.now 规划与执行共用的秒数（见文件头）；不给就取此刻。
 */
export async function runSplit(
  pool: Pool,
  opts: { localRoot: string; apply: boolean; now?: number },
): Promise<number> {
  const { localRoot, apply } = opts
  // 规划与执行**共用这一个 now**：它会被写进每一行新建的 meetings.created_at，
  // 而新目录的序号正是按那一列排的。两遍各取一次的话，算出来的目录名与插进去的行
  // 在跨秒的那一瞬间就会对不上
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const plan = await planSplits(pool, localRoot, now)

  // NAS 基准目录先各 stat 一次：挂载点没挂上时全部文件都会被判成「不在」，
  // 整份计划安静地退化成 not_found——这种半拉子结果比直接不跑坏得多
  const nasDirs = [...new Set(plan.flatMap((i) => (i.nasDir === null ? [] : [i.nasDir])))]
  const missing: string[] = []
  for (const d of nasDirs) if (!(await exists(d))) missing.push(d)
  if (missing.length > 0) {
    for (const d of missing) console.error(`‼ NAS 基准目录不存在：${d}`)
    console.error('NAS 多半没挂上。挂好再跑——现在跑一场都动不了')
    if (apply) return 2
  }

  const counts = { renamed: 0, already_done: 0, not_found: 0, conflict: 0, undecidable: 0 }
  let failed = 0
  let finishFailed = 0
  const leftOver: string[] = []
  for (const item of plan) {
    const who = item.meetingId
    if (item.undecidableReason !== null) {
      counts.undecidable++
      console.error(`⚠ ${who} undecidable：${item.undecidableReason}——这一场不动，请人工确认`)
      continue
    }
    const sessions = item.sessions.map((s) => `${s.recordId}→${s.newRel}（${s.assets.length} 个资产）`)
    console.log(`${who}\n  ${item.oldRel}\n  → ${sessions.join('\n  → ')}`)
    if (!apply) continue
    try {
      const r = await applyOne(pool, item, { localRoot, now })
      counts[r.outcome]++
      leftOver.push(...r.leftOver)
      if (r.outcome === 'conflict') console.error('  conflict：目标已被别的东西占着，未动')
      else if (r.outcome === 'not_found') console.error('  not_found：新旧位置都找不到这些文件')
      else console.log(`  ok（${r.outcome}）`)
    } catch (err) {
      if (err instanceof FinishError) {
        // 库已经提交、文件已经搬好，只有收尾没做完。**不算 failed**：failed 的
        // 读法是「修掉原因重跑」，而这一场的 '' 行已经没了，重跑一步都走不到它
        finishFailed++
        console.error(
          `  已提交，收尾失败：${err.cause}（不会重跑，按日志手工收尾）\n` +
            '    库改完并提交了、文件也各就各位了；重跑本脚本会跳过这一场。\n' +
            `    人工要做的两件事：清掉搬空的旧目录 ${join(localRoot, item.oldRel)}；` +
            `NAS 侧车 ${item.nasDir === null ? '（这场没有 NAS 归档，不用管）' : join(item.nasDir, '_manifest.json')} ` +
            '下一轮归档会自己重写，等一轮即可',
        )
      } else {
        // 一场炸了不该把剩下几百场一起停掉——已经回滚干净了，接着跑
        failed++
        console.error(`  failed：${err}`)
      }
    }
  }
  for (const d of leftOver) {
    console.error(`⚠ 旧目录里还有不认识的文件，已保留：${d}`)
  }
  console.log(
    apply
      ? `renamed=${counts.renamed} already_done=${counts.already_done} not_found=${counts.not_found} ` +
        `conflict=${counts.conflict} undecidable=${counts.undecidable} finish_failed=${finishFailed} ` +
        `failed=${failed} left_over=${leftOver.length}`
      : `dry-run：${plan.length} 场会议待拆（其中 ${counts.undecidable} 场说不清），加 --apply 执行`,
  )

  // 最后再问一遍库：**还剩几行没拆**。这一问覆盖了所有「这一场没拆成」的来路
  // （not_found / conflict / undecidable / failed），而且问的是库本身，不是这一轮
  // 数出来的账——起服务的前提是这个数为 0（'' 行还在时，引擎会给这场会议再建一套
  // 按场次的行，库就进了混合状态，见 runbook §0.1）
  const [leftRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM meetings WHERE sub_meeting_id = ''`,
  )
  const remaining = Number(leftRows[0]?.n ?? 0)
  console.log(`剩余未拆的会议：${remaining}（起服务前必须为 0）`)

  // conflict / undecidable / 收尾失败是「要人来看」的结局，退出码 2（spec §2.4）；
  // failed 是「跑炸了」，退出码 1。两者分开，好让 CI 与 `&&` 串起来的下一条命令分得清。
  // 「跑完还剩 '' 行」同样是 2：not_found 自己不进退出码（本地文件到期被清是正常的），
  // 但它留下的那一行会让下一轮拉取进混合状态——那是必须停下来看的事
  if (counts.conflict > 0 || counts.undecidable > 0 || finishFailed > 0) return 2
  if (apply && remaining > 0) return 2
  return failed > 0 ? 1 : 0
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  const localRoot = process.env.MDE_ARCHIVE_ROOT
  if (!databaseUrl || !localRoot) {
    console.error('需要 DATABASE_URL 与 MDE_ARCHIVE_ROOT')
    return 2
  }
  console.log('提示：把输出留下来——`… 2>&1 | tee split-$(date +%s).log`')
  const pool = createPool(databaseUrl)
  try {
    await runMigrations(pool)
    if (!(await exists(localRoot))) {
      console.error(`‼ MDE_ARCHIVE_ROOT 不存在：${localRoot}`)
      return 2
    }
    return await runSplit(pool, { localRoot, apply: args.apply })
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
