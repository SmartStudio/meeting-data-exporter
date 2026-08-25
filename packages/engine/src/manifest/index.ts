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
  storage: Pick<Storage, 'writeMeta'>
  /** 写进两个文件的 `generatedBy`：CLI 宿主 `mde-engine`，服务端 worker `mde-worker`。
   *  收窄成联合类型而不是 string，是为了让「两个宿主写的值必须能区分开」这件事由编译器
   *  盯着——写错一个下划线不会有任何运行期症状，只会在数年后的清单里留下一个查不出来处的名字。 */
  generatedBy: ManifestGenerator
}

/**
 * 给一场会议写出 `meeting.json` 与 `_manifest.json`，返回是否真的写了。
 *
 * **可重复调用**：同一场会议再跑一次会覆盖出同样的内容（`generatedAt` 除外）——
 * 归档流水线是持续跑的，「重跑安全」不是加分项而是前提。内容的稳定性靠两点保证：
 * 资产按 id 升序枚举（顺序不抖），字段全部取自库里的既成事实（不掺入本次运行的偶然值）。
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
): Promise<'written' | 'skipped'> {
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

  const missing: ManifestMissingEntry[] = rows
    .filter((r): r is AssetRow & { status: 'skipped' | 'dead' } => r.status === 'skipped' || r.status === 'dead')
    .map((r) => ({
      assetType: r.asset_type,
      assetKey: assetKeyOf(r.asset_type),
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

  await deps.storage.writeMeta(`${dir}/meeting.json`, meta)
  await deps.storage.writeMeta(`${dir}/_manifest.json`, manifest)
  return 'written'
}

export interface ManifestRoundOutcome {
  written: number
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
 * 「sidecar 和资产在同一个目录」。（这也意味着它继承了那张 Map 按 meeting_id 去重的
 * 已知窟窿：周期性会议同一 meeting_id 下只有胜出的那个场次会拿到 sidecar。修那个洞
 * 是另一件事，见 src/worker/store-mysql.ts 里 meetingsForPaths 的注释；在它被修好
 * 之前，与资产落盘保持同一种（哪怕是错的）行为，好过在这里自作主张地分叉。）
 *
 * 写 sidecar 失败**不能让整轮挂掉**：资产已经落盘了，一份没写出来的清单不该把一轮
 * 成功的下载变成失败。但也**不许静默吞掉**——照 executor 里进度回写失败的先例，
 * 留一行 warn，并把次数计进返回值让宿主打出来。
 */
export async function writeMeetingManifests(
  deps: ManifestDeps,
  meetings: ReadonlyMap<string, { subMeetingId: string }>,
  now: () => number,
): Promise<ManifestRoundOutcome> {
  const out: ManifestRoundOutcome = { written: 0, skipped: 0, failed: 0 }
  for (const [meetingId, m] of meetings) {
    try {
      const r = await writeMeetingManifest(deps, meetingId, m.subMeetingId, now())
      if (r === 'written') out.written++
      else out.skipped++
    } catch (err) {
      out.failed++
      console.warn(`manifest write failed for meeting=${meetingId} subMeeting=${m.subMeetingId}: ${err}`)
    }
  }
  return out
}

function toAssetEntry(row: AssetRow, targetPath: string): ManifestAssetEntry {
  return {
    assetType: row.asset_type,
    assetKey: assetKeyOf(row.asset_type),
    remoteId: emptyToNull(row.remote_id),
    fileType: emptyToNull(row.file_type),
    fileName: targetPath.slice(targetPath.lastIndexOf('/') + 1),
    // bytes 取 bytes_expected 而不是 bytes_written，理由见 domain/manifest.ts 的字段注释
    bytes: row.bytes_expected,
    sha256: row.content_hash,
  }
}

/** 网关 asset_type → 引擎 AssetKey；映射不认识的新类型原样透出（网关将来会 emit 新的） */
function assetKeyOf(assetType: string): string {
  return GATEWAY_TYPE_TO_ASSET_KEY[assetType] ?? assetType
}

/** DB 里 NOT NULL 的文本列用空串编码「没有」（见 store/db.ts 的 file_type 注释），清单里如实写 null */
function emptyToNull(v: string | null): string | null {
  return v === null || v === '' ? null : v
}

function dirOf(relPath: string): string {
  return relPath.slice(0, relPath.lastIndexOf('/'))
}
