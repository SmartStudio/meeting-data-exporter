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
 * ⚠️ 本文件目前只有**规划**这一遍（`planSplits`）。执行（`applyOne` / `main`）是下一
 * 个任务，`ApplyOutcome` 这套词汇先在这里定下来，两遍共用同一份类型。
 */
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import {
  ASSET_KEY_TO_GATEWAY_TYPE,
  GATEWAY_TYPE_TO_ASSET_KEY,
  assetKeyToFilename,
  assignDirOrdinals,
  meetingDirPath,
  meetingPathKey,
  type AssetKey,
} from '@yaowu/mde-engine'
import type { Pool } from '../src/store/db'
import { NAS_BASE, cleanBase, mergeBase, resolveNasBase, type DerivedBase } from './rename-archive-dirs'

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
  // 它们的目录已经装着文件，新场次不能跟它们抢同一个目录名（见 planOne 的 ③）。
  // 这种混合状态是真会出现的——上一轮被判 undecidable 跳过的会议留着 '' 行，
  // 而调度器接着又按新代码给它的新场次建了行。
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

/** assignDirOrdinals 要的那几个字段 */
const dirRow = (meetingId: string, subMeetingId: string, createdAt: number, s: {
  subject: string | null; startTime: number | null; meetingCode: string | null
}) => ({ meetingId, subMeetingId, createdAt, subject: s.subject, startTime: s.startTime, meetingCode: s.meetingCode })

function planOne(m: MeetingRow, input: PlanInput): SplitItem {
  const self = { subject: m.subject, startTime: m.start_time, meetingCode: m.meeting_code }
  // 旧行**此刻在盘上的**目录：按库里现有的行（'' 行 + 已经拆好的兄弟行）算一遍序号，
  // 与引擎这一刻算出来的口径一致。绝大多数会议只有 '' 行一行，序号就是 1、没有后缀。
  const oldOrdinals = assignDirOrdinals([
    dirRow(m.meeting_id, '', m.created_at, self),
    ...input.siblings.map((s) =>
      dirRow(s.meeting_id, s.sub_meeting_id, s.created_at, {
        subject: s.subject, startTime: s.start_time, meetingCode: s.meeting_code,
      })),
  ])
  const oldRel = meetingDirPath(self, m.meeting_id, oldOrdinals.get(meetingPathKey(m.meeting_id, '')) ?? 1)
  const bail = (reason: string): SplitItem => ({
    meetingId: m.meeting_id, oldRel, nasDir: input.nas.dir, sessions: [], undecidableReason: reason,
  })

  if (input.nas.reason !== null) return bail(input.nas.reason)

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
      hostUserId: c.host_user_id, startTime: c.start_time, endTime: c.end_time,
    })),
    ...orphans.map((r) => ({
      recordId: r, subject: m.subject, meetingCode: m.meeting_code,
      hostUserId: m.host_userid, startTime: m.start_time, endTime: m.end_time,
    })),
  ]
  if (sessionsMeta.length === 0) {
    return bail('meeting_cache 里没有这个 meeting_id 的任何场次，资产也反推不出 record id')
  }

  // ③ 每个场次的新目录序号。同一分钟的两条录制记录（正常录制 + 「转写_」那条，
  //    本机 84/294 场）算出同名目录，靠 assignDirOrdinals 给第二条加 `_2`——序号
  //    绝不自己另算，脚本与引擎必须是同一份实现（见 domain/dir-ordinal.ts）。
  //
  //    喂进去的是**拆完之后库里会有的那批行**：已经建好的兄弟行带自己的 created_at
  //    （它们的目录已经装着文件，序号按首次发现时间钉住不动），本轮新建的场次行带
  //    同一个 `now`，于是同批之间按 record id 定序——与执行那一遍插完行之后引擎自己
  //    再算一遍的答案逐字一致。
  //
  //    待删的 '' 旧行**不进这个名单**：它在同一个事务里就没了，把它算进去会让与它
  //    同目录的那个场次白白挪到 `_2`，而下一轮引擎（那时 '' 行已不存在）又会说它该在
  //    无后缀的目录里——盘上的文件与库从此各说各话。
  const createdAtOf = new Map(input.siblings.map((s) => [s.sub_meeting_id, s.created_at]))
  const planned = new Set(sessionsMeta.map((s) => s.recordId))
  const dirOrdinals = assignDirOrdinals([
    ...input.siblings
      .filter((s) => !planned.has(s.sub_meeting_id))
      .map((s) => dirRow(s.meeting_id, s.sub_meeting_id, s.created_at, {
        subject: s.subject, startTime: s.start_time, meetingCode: s.meeting_code,
      })),
    ...sessionsMeta.map((s) =>
      dirRow(m.meeting_id, s.recordId, createdAtOf.get(s.recordId) ?? input.now, s)),
  ])

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
