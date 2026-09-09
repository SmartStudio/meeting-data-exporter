import { join, relative } from 'node:path'
import {
  MANIFEST_SCHEMA_VERSION,
  createNasStorage,
  manifestAssetKey,
  manifestBytes,
  withFsTimeout,
  type ArchivedManifestAssetEntry,
  type ArchivedManifestFile,
  type ManifestMissingEntry,
  type Meeting,
  type MeetingMetaFile,
} from '@yaowu/mde-engine'
import type { ArchivedAssetRecord, CompletedAssetRow, MissingAssetRow } from '../store/archives'

/**
 * 触达 NAS 的单个 fs 操作的超时上限（整段耗时，不是"多久没进展"）。
 *
 * 这是"挂住了"的探测器，不是性能指标：网络挂载出问题时 fs 调用会静静地挂着而不是
 * 报错，这个值回答的是"等到什么时候就断定它挂了"。所以它必须比"最大的那个资产在
 * 健康 NAS 上整份写完 / 读完"还宽得多——录像资产可以有几个 GB，按到 NAS 的现实
 * 速率（1GbE 上百来 MB/s）算，一个几 GB 的文件光复制就要好几分钟，读回来重算哈希
 * 还要再来一遍。
 *
 * 沿用 Task 2 给 stat/mkdir 那种小调用定的 5s 是错的口径：5s 只够搬 ~550MB，
 * 一场小时级录像必然超时，于是那场会议每一轮都在同一个地方失败、永远归档不上，
 * 而"归档失败"又是最高级别告警——真正的故障信号会被这种必然的超时噪音淹没。
 * 与 src/worker/retention.ts 的 NAS_READ_TIMEOUT_MS 同一口径、同一个理由。
 *
 * mkdir 那种小调用也共用这个预算：它问的是同一个问题（挂载是不是挂住了），
 * 只是断定得晚一些；为它单列一个小超时只会多一个需要各自维护的常量。
 */
export const NAS_WRITE_TIMEOUT_MS = 10 * 60_000

export interface NasSidecarInput {
  meetingId: string
  subMeetingId: string
  /** 元数据由调用方读好传进来；取不到时为 null，两个 ID 照样写得出（US-6.2 要的"原始 ID"） */
  meeting: Meeting | null
  /** meeting_assets 里 status='completed' 的行，按 id 升序 = 入库顺序 */
  completed: readonly CompletedAssetRow[]
  /** archived_assets 里这一场的行，按自然键 join 进来 */
  archived: readonly ArchivedAssetRecord[]
  /** meeting_assets 里没拿到的那些（skipped / dead / failed） */
  missing: readonly MissingAssetRow[]
  nasRoot: string
  nasDir: string
  retentionDays: number
  now: number
  /** 缺省 `createNasStorage(nasRoot, timeoutMs).writeMeta` */
  writeMeta?: (relPath: string, data: unknown) => Promise<void>
  /** 缺省 `NAS_WRITE_TIMEOUT_MS` */
  timeoutMs?: number
}

/**
 * NAS 上那份**自解释** sidecar：`meeting.json`（会议元数据）与 `_manifest.json`
 * （资产清单 + 校验信息 + 归档段）。US-6.2：「数年后在 NAS 上翻到该目录，无需本工具
 * 即可知道内容、完整性与原始 ID」。
 *
 * **为什么在 NAS 上独立生成，而不是把本地那两个文件一并搬过去**（这一条是设计选择，
 * 不是图省事）：
 * 1. NAS 那份必须带**归档特有**的信息——文件在 NAS 上的实际路径、归档时重新读回
 *    NAS 算出的哈希、归档时刻、保留天数、归档目录。本地那份一个都没有，也不该有。
 * 2. 本地那份**可能压根不存在**：写失败过（`writeMeetingManifests` 明确允许失败），
 *    或者这场会议早于 sidecar 上线就已经下载完毕。搬运方案在这两种情况下会静默地
 *    什么都不留下，而这里的独立生成不依赖它。
 * 3. 更要紧的是**本地那份 30 天后会被到期清理删掉**（`src/worker/retention.ts`）。
 *    长期活下来的是 NAS 这一份，US-6.2 说的就是它。
 *
 * 类型直接用 `packages/engine/src/domain/manifest.ts` 的那一套（NAS 版是本地版的
 * `extends`）：两份清单描述的是同一批资产，字段含义必须逐字相同。
 *
 * **为什么收一个纯数据入参、而不是收 ArchiveDeps**：这一份逻辑有两个调用方——
 * 归档流水线（`src/worker/archive.ts`）和拆场次脚本
 * （`scripts/split-recurring-meetings.ts`，它拆完之后要按新场次把清单重写一遍）。
 * 脚本手上没有 ArchiveDeps，也不该为了写一份 JSON 去搭半个归档流水线；而这两份清单
 * 要是各写一遍，字段含义立刻分叉——NAS 上那一份是**要留数年**的东西。
 *
 * 抛出的错误由调用方接住——**写不出 sidecar 绝不能让归档判为失败**。
 */
export async function writeNasSidecars(input: NasSidecarInput): Promise<void> {
  const { meetingId, subMeetingId, meeting, completed, archived, missing, nasRoot, nasDir, retentionDays, now } = input
  const timeoutMs = input.timeoutMs ?? NAS_WRITE_TIMEOUT_MS
  const write = input.writeMeta ?? createNasStorage(nasRoot, timeoutMs).writeMeta

  const nasByKey = new Map(archived.map((a) => [naturalKey(a), a]))

  // 枚举源是 meeting_assets 的 completed 行（按 id 升序 = 入库顺序），NAS 侧的事实
  // 从 archived_assets 按自然键 join 进来。两张表都要读是因为它们各知道一半：
  // 原始 ID / 平台声明的大小 / 本地下载时算的哈希只在 meeting_assets 里，
  // NAS 路径与 NAS 侧哈希只在 archived_assets 里。用 completed 当枚举源而不是
  // archived_assets，是为了顺序与引擎那份本地清单一致（archived_assets 没有 id 列，
  // 主键是自然键，给不出"入库顺序"）。
  const assets: ArchivedManifestAssetEntry[] = []
  let unrecorded = 0
  let elsewhere = 0
  for (const row of completed) {
    const nas = nasByKey.get(naturalKey(row))
    if (nas === undefined) {
      // 理论上不该发生。真发生了也不能编一个 NAS 路径出来——清单宁可少一条，也不能撒谎
      unrecorded++
      continue
    }
    if (!isUnder(nasDir, nas.nasPath)) elsewhere++
    assets.push({
      assetType: row.assetType,
      assetKey: manifestAssetKey(row.assetType),
      remoteId: emptyToNull(row.remoteId),
      fileType: emptyToNull(row.fileType),
      fileName: baseNameOf(nas.nasPath),
      // 与本地那份清单共用同一条取值规则（平台声明值优先、否则用落盘真实大小）
      bytes: manifestBytes(row.bytesExpected, row.bytesWritten),
      sha256: row.contentHash,
      nasPath: nas.nasPath,
      nasHash: nas.nasHash,
    })
  }
  if (unrecorded > 0) {
    console.warn(
      `archive sidecar: meeting=${meetingId} subMeeting=${subMeetingId} 有 ${unrecorded} 个已完成资产在 archived_assets 里找不到对应记录，未列入 NAS 清单`,
    )
  }
  if (elsewhere > 0) {
    // 目录模板中途被改过时，同一场会议前后两轮会判出不同的目录。清单照实写每个文件的
    // 真实 nasPath（找得到），但错位本身要留痕
    console.warn(
      `archive sidecar: meeting=${meetingId} subMeeting=${subMeetingId} 有 ${elsewhere} 个已归档资产不在 ${nasDir} 内（跨月归档？），清单按各自真实的 nasPath 记录`,
    )
  }

  const missingEntries: ManifestMissingEntry[] = missing.map((r) => ({
    assetType: r.assetType,
    assetKey: manifestAssetKey(r.assetType),
    remoteId: emptyToNull(r.remoteId),
    status: r.status,
    reason: r.lastError ?? 'unknown',
  }))

  const meta: MeetingMetaFile = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    meeting: {
      // 这两个是**调用方给的主键**，不是从 meeting 里取的：元数据取不到时它们照样
      // 是已知事实，而 US-6.2 第二条验收标准要的"原始 ID"正是它们
      meetingId,
      subMeetingId,
      meetingCode: meeting?.meetingCode ?? null,
      subject: meeting?.subject ?? null,
      hostUserId: meeting?.hostUserId ?? null,
      startTime: meeting?.startTime ?? null,
      endTime: meeting?.endTime ?? null,
    },
    generatedAt: now,
    generatedBy: 'mde-worker',
  }
  const manifest: ArchivedManifestFile = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    meetingId,
    subMeetingId,
    assets,
    missing: missingEntries,
    archive: { archivedAt: now, retentionDays, nasDir },
    generatedAt: now,
    generatedBy: 'mde-worker',
  }

  // 路径相对 nasRoot（Storage 接口的口径），落点仍然是 nasDir 本身
  const relDir = relative(nasRoot, nasDir)
  // 超时包装由**这里**持有，不指望 write 的实现自带：NAS 挂起时 fs 调用是挂住而不是
  // 报错，"有限时间内返回"这条保证不能随着换一个实现就消失
  await withFsTimeout(write(join(relDir, 'meeting.json'), meta), `write ${join(nasDir, 'meeting.json')}`, timeoutMs)
  await withFsTimeout(write(join(relDir, '_manifest.json'), manifest), `write ${join(nasDir, '_manifest.json')}`, timeoutMs)
}

/** meeting_assets 与 archived_assets 共用的自然键；\u0000 当分隔符，任何一段里都不会出现 */
function naturalKey(r: { assetType: string; remoteId: string; fileType: string }): string {
  return `${r.assetType}\u0000${r.remoteId}\u0000${r.fileType}`
}

/** DB 里 NOT NULL 的文本列用空串编码「没有」，清单里如实写 null（与引擎那份同一口径） */
function emptyToNull(v: string): string | null {
  return v === '' ? null : v
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function isUnder(dir: string, path: string): boolean {
  return path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)
}
