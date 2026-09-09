import type { AssetRow, Store } from '../store'
import type { Storage } from '../storage/types'
import { GATEWAY_TYPE_TO_ASSET_KEY } from '../domain/types'
import { meetingDirPath } from '../domain/filename'
import {
  MANIFEST_SCHEMA_VERSION,
  type ManifestAssetEntry,
  type ManifestGenerator,
  type ManifestFile,
  type ManifestMissingEntry,
  type MeetingMetaFile,
} from '../domain/manifest'

/**
 * 会议目录的两个 sidecar（`meeting.json` / `_manifest.json`）的写入。
 *
 * **为什么是一个独立的收尾步骤，而不是塞进 executor**：`runExecutor` 是**逐资产**的
 * 并发执行体，它内部没有「这场会议的资产全下完了」这个判定——只有跨 worker 的聚合
 * 计数器。想在 `handleOne` 里凑出这个判定，就得引入 worker 之间的协调，而那是为了
 * 一个本来就不需要实时性的动作付的代价：sidecar 描述的是「此刻这个目录里有什么」，
 * 一轮结束后写一次即可，重跑再覆盖一次也完全正确。
 *
 * 所以它由**宿主**（服务端 worker 与 mde CLI）在一轮执行结束后按会议调用一次，
 * 两个宿主共用这一份实现，行为不分叉。
 */
export interface ManifestDeps {
  store: Pick<Store, 'getMeeting' | 'assetsForMeeting'>
  /** `readMeta` 是为了「内容没变就别重写」——写之前先把已有的那份读回来比一比，
   *  理由见 writeMeetingManifest 的注释 */
  storage: Pick<Storage, 'writeMeta' | 'readMeta'>
  /** 写进两个文件的 `generatedBy`：CLI 宿主 `mde-engine`，服务端 worker `mde-worker`。
   *  收窄成联合类型而不是 string，是为了让「两个宿主写的值必须能区分开」这件事由编译器
   *  盯着——写错一个下划线不会有任何运行期症状，只会在数年后的清单里留下一个查不出来处的名字。 */
  generatedBy: ManifestGenerator
}

/**
 * 给一场会议写出 `meeting.json` 与 `_manifest.json`，返回这一次到底做了什么。
 *
 * **可重复调用**：同一场会议再跑一次会覆盖出同样的内容（`generatedAt` 除外）——
 * 归档流水线是持续跑的，「重跑安全」不是加分项而是前提。内容的稳定性靠两点保证：
 * 资产按 id 升序枚举（顺序不抖），字段全部取自库里的既成事实（不掺入本次运行的偶然值）。
 *
 * **内容没变就一个字节都不写**（返回 `'unchanged'`）。宿主每一轮都会对每场已知会议
 * 调一次这个函数，而绝大多数轮次里这场会议什么都没发生。只有 `generatedAt` 在变的
 * 情况下照写不误，代价是实打实的：文件哈希每轮都变、mtime 天天跳，往 NAS 同步时
 * 每轮重传两个 JSON（2026-08-26 联调实测到的第 4 条事实，见
 * docs/m3.5-stage8-9-plan.md §0.1）。所以写之前先把盘上那份读回来比一比，
 * 除 `generatedAt` 外一字不差就跳过。两个文件**各比各的**：加了一个资产时
 * `meeting.json` 并没有变，没道理跟着被重写一遍。
 *
 * 「读不回来」一律当作**要写**处理（判断不了就落到安全的一侧：写一遍最多是多写，
 * 不写才可能让一份错清单永远留在盘上），并且**每一次都留下带原因的 warn**——
 * 唯一不出声的是「文件还不存在」，那是首写，是正常情况不是异常。
 *
 * 一个 completed 资产都没有时返回 `'skipped'` 且不写任何文件：那意味着这个目录还不
 * 存在（或至少不是我们放的东西），凭空写一份空清单等于声称「这里什么都没有」，
 * 而事实是「这里还没轮到」。
 */
export async function writeMeetingManifest(
  deps: ManifestDeps,
  meetingId: string,
  subMeetingId: string,
  now: number,
): Promise<'written' | 'unchanged' | 'skipped'> {
  const meeting = await deps.store.getMeeting(meetingId, subMeetingId)
  if (meeting === null) return 'skipped'   // 会议元数据都没有就算不出目录，与 executor 的 meeting_meta_missing 同一处境

  // 目录必须与资产落盘的目录**完全一致**，所以走的是 executor 拼 target_path 时
  // 用的同一个 meetingDirPath（fallbackCode 同样传 meeting_id）。
  const dir = meetingDirPath(meeting, meetingId)
  const rows = await deps.store.assetsForMeeting(meetingId, subMeetingId)

  const assets: ManifestAssetEntry[] = []
  let elsewhere = 0
  for (const row of rows) {
    if (row.status !== 'completed') continue
    // 清单声称的是「这个目录里有什么」，所以只列**确实落在这个目录里**的文件。
    // 正常情况下这个判断永远为真（两边同一个 meetingDirPath）；不为真只有一种来路：
    // 会议主题/开始时间在两轮之间被上游改过，早先的资产留在了旧目录里。那些文件属于
    // 旧目录的清单，不属于这一份——但也不能一声不吭地丢掉，所以下面 warn 一次。
    if (row.target_path === null || dirOf(row.target_path) !== dir) { elsewhere++; continue }
    assets.push(toAssetEntry(row, row.target_path))
  }
  if (elsewhere > 0) {
    console.warn(
      `manifest: meeting=${meetingId} subMeeting=${subMeetingId} 有 ${elsewhere} 个已完成资产不在目录 ${dir} 内（会议元数据变更过？），未列入本目录清单`,
    )
  }
  if (assets.length === 0) return 'skipped'

  // `failed` 与两个终态一起写进 missing：它还会重试，但 `status` 这一列本身就把这件事
  // 说清楚了（见 ManifestMissingEntry）。这份清单每轮重写，宁可说一件还会变的事，
  // 也不让一个反复失败的资产在清单里长得像"从来没有过"。
  const missing: ManifestMissingEntry[] = rows
    .filter(
      (r): r is AssetRow & { status: 'skipped' | 'dead' | 'failed' } =>
        r.status === 'skipped' || r.status === 'dead' || r.status === 'failed',
    )
    .map((r) => ({
      assetType: r.asset_type,
      assetKey: manifestAssetKey(r.asset_type),
      remoteId: emptyToNull(r.remote_id),
      status: r.status,
      reason: r.last_error ?? 'unknown',
    }))

  const meta: MeetingMetaFile = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    meeting: {
      meetingId: meeting.meetingId,
      subMeetingId: meeting.subMeetingId,
      meetingCode: meeting.meetingCode,
      subject: meeting.subject,
      hostUserId: meeting.hostUserId,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
    },
    generatedAt: now,
    generatedBy: deps.generatedBy,
  }
  const manifest: ManifestFile = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    meetingId, subMeetingId, assets, missing,
    generatedAt: now,
    generatedBy: deps.generatedBy,
  }

  let wrote = 0
  for (const [path, data] of [[`${dir}/meeting.json`, meta], [`${dir}/_manifest.json`, manifest]] as const) {
    if (await alreadyOnDisk(deps.storage, path, data)) continue
    await deps.storage.writeMeta(path, data)
    wrote++
  }
  return wrote > 0 ? 'written' : 'unchanged'
}

/**
 * 盘上那份与要写的这份除 `generatedAt` 外是否一字不差。
 *
 * 读不回来时返回 false（= 去写），**且必须说出是哪个文件、因为什么**：这条路上
 * 的失败（权限、坏 JSON、NAS 挂起）都不影响清单本身的正确性，所以不该中断一轮；
 * 但静默吞掉就等于把「这个目录读不了」这件事彻底抹掉，而它恰恰是要人看的。
 * 文件不存在（`null`）是首写，不是异常，不出声。
 */
async function alreadyOnDisk(
  storage: Pick<Storage, 'readMeta'>,
  path: string,
  data: unknown,
): Promise<boolean> {
  let existing: unknown
  try {
    existing = await storage.readMeta(path)
  } catch (err) {
    console.warn(`manifest: 读不回已有的 ${path}（${err}），按「内容可能变了」处理，照写`)
    return false
  }
  if (existing === null) return false
  return withoutGeneratedAt(existing) === withoutGeneratedAt(data)
}

/**
 * 比较用的规范形式：把 `generatedAt` 归零之后序列化。
 *
 * 用 JSON 字符串比而不是逐字段比，是因为「内容变没变」问的就是**将要落盘的那串字节**
 * 变没变；新增字段、去掉字段都会被自动算作变了，不需要谁记得来这里补一笔。
 * 键序不是问题：盘上那份是同一段代码 `JSON.stringify` 出来的，读回来键序照旧，
 * 而 `generatedAt` 是就地覆盖（不是追加），不影响顺序。
 */
function withoutGeneratedAt(v: unknown): string {
  return JSON.stringify({ ...(v as object), generatedAt: 0 })
}

export interface ManifestRoundOutcome {
  written: number
  /** 内容与盘上那份一字不差、因此一个字节都没写的场次。
   *  **与 written 分开数**：稳定状态下的一轮应该是清一色的 unchanged，
   *  把它算进 written 就等于把「什么都没发生」报成「又写了一遍」，
   *  而后者正是本字段要盯住的那个毛病。 */
  unchanged: number
  /** 还没有任何已完成资产（或会议元数据缺失）而没写的场次——正常情况，不是错误 */
  skipped: number
  /** 写入本身抛出的场次。**不让整轮挂掉，但也不静默**，每一次都会 console.warn */
  failed: number
}

/**
 * 一轮的收尾：对给定的每场会议写一次 sidecar，逐会议做错误隔离。
 *
 * `meetings` 直接收 `Store.meetingsForPaths()` 的返回值——**刻意与 executor 拼落盘
 * 路径时用的是同一张 Map**：目录由它算出，清单也就该按它枚举，两边同源才谈得上
 * 「sidecar 和资产在同一个目录」。那张 Map 现在按 `(meeting_id, sub_meeting_id)`
 * 建键，所以周期会议的每个场次各拿到自己的 sidecar（2026-09-09 之前只有胜出的
 * 那个场次有，那是与 executor 一起的同一个洞，已经补掉）。
 *
 * 遍历的是 **values**，两段主键从值里取：键是 `meetingPathKey` 拼出来的，拆键还原
 * 等于把编码规则又实现一遍。
 *
 * 写 sidecar 失败**不能让整轮挂掉**：资产已经落盘了，一份没写出来的清单不该把一轮
 * 成功的下载变成失败。但也**不许静默吞掉**——照 executor 里进度回写失败的先例，
 * 留一行 warn，并把次数计进返回值让宿主打出来。
 */
export async function writeMeetingManifests(
  deps: ManifestDeps,
  meetings: ReadonlyMap<string, { meetingId: string; subMeetingId: string }>,
  now: () => number,
): Promise<ManifestRoundOutcome> {
  const out: ManifestRoundOutcome = { written: 0, unchanged: 0, skipped: 0, failed: 0 }
  for (const m of meetings.values()) {
    try {
      const r = await writeMeetingManifest(deps, m.meetingId, m.subMeetingId, now())
      out[r]++
    } catch (err) {
      out.failed++
      console.warn(`manifest write failed for meeting=${m.meetingId} subMeeting=${m.subMeetingId}: ${err}`)
    }
  }
  return out
}

function toAssetEntry(row: AssetRow, targetPath: string): ManifestAssetEntry {
  return {
    assetType: row.asset_type,
    assetKey: manifestAssetKey(row.asset_type),
    remoteId: emptyToNull(row.remote_id),
    fileType: emptyToNull(row.file_type),
    fileName: targetPath.slice(targetPath.lastIndexOf('/') + 1),
    bytes: manifestBytes(row.bytes_expected, row.bytes_written),
    sha256: row.content_hash,
  }
}

/**
 * 清单里 `bytes` 字段的取值规则。**完整推理见 domain/manifest.ts 的字段注释**，
 * 这里只写结论：平台声明的大小优先；没有就用这个 completed 行落盘的真实字节数；
 * 那也是 0（说不清是空文件还是本条回落上线之前完成的旧行）就写 null。
 *
 * 导出成一个函数而不是在两处各写一遍同样的 `??`：本地清单（本文件）与 NAS 清单
 * （src/worker/archive.ts）写的是**同一个字段**，字段含义必须逐字相同。
 * 「取不到时怎么办」是这个字段的语义决定，只该有一处——与 manifestAssetKey 同理。
 *
 * **只对 completed 的行调用**。非终态行的 bytes_written 是进度检查点，不是大小；
 * 两个调用点也确实都只枚举 completed 行。
 */
export function manifestBytes(bytesExpected: number | null, bytesWritten: number): number | null {
  if (bytesExpected !== null) return bytesExpected
  return bytesWritten > 0 ? bytesWritten : null
}

/**
 * 网关 asset_type → 引擎 AssetKey；映射不认识的新类型原样透出（网关将来会 emit 新的）。
 *
 * 导出而不是留成模块私有：服务端归档链路要给 NAS 那份清单算同一个 `assetKey` 字段
 * （`src/worker/archive.ts`）。两处各写一遍 `GATEWAY_TYPE_TO_ASSET_KEY[t] ?? t` 看着
 * 一样，但「映射不到时怎么办」是这个字段的语义决定，只该有一处。
 */
export function manifestAssetKey(assetType: string): string {
  return GATEWAY_TYPE_TO_ASSET_KEY[assetType] ?? assetType
}

/** DB 里 NOT NULL 的文本列用空串编码「没有」（见 store/db.ts 的 file_type 注释），清单里如实写 null */
function emptyToNull(v: string | null): string | null {
  return v === null || v === '' ? null : v
}

function dirOf(relPath: string): string {
  return relPath.slice(0, relPath.lastIndexOf('/'))
}
