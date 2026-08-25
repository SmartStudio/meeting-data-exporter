import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, dirname, relative } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  MANIFEST_SCHEMA_VERSION,
  createNasStorage,
  manifestAssetKey,
  sha256File,
  withFsTimeout,
  type ArchivedManifestAssetEntry,
  type ArchivedManifestFile,
  type ManifestMissingEntry,
  type Meeting,
  type MeetingMetaFile,
} from '@yaowu/mde-engine'
import type { ArchivedAssetRecord, ArchivesStore, CompletedAssetRow } from '../store/archives'

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
const NAS_WRITE_TIMEOUT_MS = 10 * 60_000
const DEFAULT_RETENTION_DAYS = 30

/**
 * 本阶段（阶段 2）用"按年/月 + 会议 ID"的固定目录规则，不是规则驱动的。
 * spec.md §4.6 描述的"归档规则决定进 NAS 的哪个目录"要到阶段 3（R1 三栈规则
 * 引擎）才有配置入口——在那之前用一个确定性的默认规则，不阻塞归档能力本身
 * 上线。等 R1/R4 落地后这里要接一个真正的规则求值，不是最终形态，这里显式记着。
 *
 * 为什么不复用 packages/engine/src/domain/filename.ts 的 cleanDirName（Step 0 核实过）：
 * cleanDirName(date, hhmm, subject, code) 清洗的是**会议主题这段自由文本**（非法字符
 * 替换、字素簇截断到 60、空主题兜底），服务于本地下载路径里那段人类可读的目录名
 * （packages/engine/src/executor/index.ts 的 buildRelPath）。这里的输入是 meetingId /
 * subMeetingId——腾讯会议 API 给的结构化 ID（VARCHAR(64)），不是用户可编辑的自由文本，
 * 整个代码库里也没有任何地方对 meeting_id 做过这类清洗。用 cleanDirName 反而需要额外
 * 拉 meeting 的 subject/meetingCode/startTime 进来（现有 archiveMeeting(deps, meetingId,
 * subMeetingId, now) 签名里没有，ArchivesStore 也刻意不读 meetings 表——那是三张表边界
 * 之外的第四张表），并不是在补一个真正缺失的"清洗"步骤，只是在拼没有非法字符风险的
 * 两个 ID。按年/月 + 会议 ID 是本阶段独立于本地目录命名规则的一套目的地布局，
 * 不是同一份逻辑的第二份实现。
 */
function nasDirFor(nasRoot: string, meetingId: string, subMeetingId: string, archivedAtSec: number): string {
  const d = new Date(archivedAtSec * 1000)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dirName = subMeetingId ? `${meetingId}_${subMeetingId}` : meetingId
  return join(nasRoot, String(year), month, dirName)
}

export interface ArchiveDeps {
  archives: ArchivesStore
  localRoot: string
  nasRoot: string
  /** 默认 sha256File；测试用来注入一个会返回不匹配哈希的假实现，
   *  制造"NAS 写入内容与本地不一致"这个场景——不这样做的话，Step 4 的
   *  用例 3（校验失败分支）在真实文件系统上无法确定性地构造出来
   *  （复制操作本身是正确的，没有天然会失败的路径）。 */
  hashFile?: (path: string) => Promise<string>
  /** 单个 NAS 文件写入/读回的超时，缺省用 NAS_WRITE_TIMEOUT_MS。开成可注入的理由与
   *  src/worker/retention.ts 的 nasReadTimeoutMs 一样：默认值要对生产上几个 GB 的
   *  资产现实（10 分钟），测试要能传一个小值来验证"NAS 挂住了就不算归档成功"这条
   *  分支，而不是让一条用例真的跑上 10 分钟。 */
  nasWriteTimeoutMs?: number
  /**
   * 会议元数据的来源。
   *
   * **为什么是一个函数而不是整个 Store**：`ArchivesStore` 刻意不读 `meetings` 表
   * ——那是三张表边界之外的第四张表（见本文件开头 nasDirFor 的注释与
   * `src/store/archives.ts` 的表头）。但 NAS 上的 `meeting.json` 必须有
   * subject / meetingCode / startTime / endTime，否则那个目录里只剩一串 ID，
   * US-6.2 那句「无需本工具即可知道内容」就没兑现。收成一个注入的函数：
   * 三表边界不破，元数据来源由宿主（`src/worker/index.ts`，那里本来就有完整的
   * MySQL `Store`）说了算，测试也不必为了造一条元数据去搭半个 Store。
   *
   * **必填，不是可选的测试缝**：忘了接线的后果不是报错，而是 NAS 上静静躺着一份
   * 只有 ID 的 sidecar——正是这条故事要消灭的那个失效形态。让编译器盯着。
   */
  getMeeting: (meetingId: string, subMeetingId: string) => Promise<Meeting | null>
  /**
   * 写 NAS sidecar 的落点，路径**相对 nasRoot**；缺省 `createNasStorage(nasRoot).writeMeta`。
   *
   * 复用引擎那个 Storage 实现而不是自己再拼一遍 `mkdir` + `JSON.stringify`：两个宿主
   * 写出来的 JSON 缩进、建目录行为必须一致，不然「同一份格式」立刻分叉成两种。
   * （这与本文件末尾"为什么资产复制不走 createNasStorage"不矛盾：那条说的是
   * `appendChunk`/`finalize` 那套边下边写的接口不适合"整文件搬运"，而 `writeMeta`
   * 恰好就是"一次性写一个小 JSON"，正是它该干的活。）
   *
   * 开成可注入的是为了造出"NAS 写不进去/挂住了"这两条分支——真实文件系统上
   * 一次正确的小文件写入没有天然会失败的路径，与 hashFile 同一个理由。
   */
  writeMeta?: (relPath: string, data: unknown) => Promise<void>
}

export interface ArchiveOutcome {
  meetingId: string
  subMeetingId: string
  /** 本轮新归档成功的资产数（不含此前已归档过的） */
  newlyArchived: number
  /** 哈希校验不一致、本轮跳过的资产数——不是致命错误，下一轮会重试 */
  verificationFailed: number
  /** completed 资产是否已全部归档完——meeting_archives 是否真的被写入还要看这一轮
   *  是否真有新资产归档，见 archiveMeeting 内 `fullyArchived && newlyArchived > 0` 的判断 */
  fullyArchived: boolean
  /**
   * NAS 那份自解释 sidecar（`meeting.json` / `_manifest.json`）这一轮的结果。
   *
   * `'skipped'` 是**正常情况**，不是错误：这一轮没有让这场会议从"没归完"变成
   * "归完了"（部分归档、或纯粹的空转重跑），那就没有该写的新内容。
   * `'failed'` 才是要盯的——它不让归档判为失败（见 archiveMeeting 里的理由），
   * 但每一次都会 console.warn，并被 archivePendingMeetings 计进 sidecarFailed。
   */
  sidecar: 'written' | 'skipped' | 'failed'
}

async function archiveOneAsset(
  deps: ArchiveDeps,
  asset: CompletedAssetRow,
  nasDir: string,
  now: number,
): Promise<'archived' | 'verification_failed'> {
  const localPath = join(deps.localRoot, asset.targetPath)
  const nasPath = join(nasDir, asset.targetPath) // 沿用与本地一致的相对结构，方便人工按路径核对

  const doHash = deps.hashFile ?? sha256File
  const timeoutMs = deps.nasWriteTimeoutMs ?? NAS_WRITE_TIMEOUT_MS
  const localHash = await doHash(localPath)

  await withFsTimeout(mkdir(dirname(nasPath), { recursive: true }), `mkdir(${dirname(nasPath)})`, timeoutMs)
  await withFsTimeout(
    pipeline(createReadStream(localPath), createWriteStream(nasPath)),
    `copy to ${nasPath}`,
    timeoutMs,
  )
  // 重新读回 NAS 上刚写的文件算哈希，不信任"写操作没抛异常"——这是 dev-plan.md
  // §6 对不可逆删除那条硬要求（重新校验，不查记录）的同一种精神在归档侧的体现：
  // 校验永远针对"实际在 NAS 上的字节"，不针对"我们以为发生了什么"。
  const nasHash = await withFsTimeout(doHash(nasPath), `hash ${nasPath}`, timeoutMs)

  if (localHash !== nasHash) {
    return 'verification_failed'
  }

  await deps.archives.recordArchivedAsset({
    meetingId: asset.meetingId,
    subMeetingId: asset.subMeetingId,
    assetType: asset.assetType,
    remoteId: asset.remoteId,
    fileType: asset.fileType,
    localPath: asset.targetPath,
    nasPath,
    nasHash,
    archivedAt: now,
  })
  return 'archived'
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
 * 抛出的错误由调用方接住——**写不出 sidecar 绝不能让归档判为失败**，理由见调用处。
 */
async function writeNasSidecars(
  deps: ArchiveDeps,
  meetingId: string,
  subMeetingId: string,
  completed: CompletedAssetRow[],
  nasDir: string,
  retentionDays: number,
  now: number,
): Promise<void> {
  const timeoutMs = deps.nasWriteTimeoutMs ?? NAS_WRITE_TIMEOUT_MS
  const nasStorage = createNasStorage(deps.nasRoot, timeoutMs)
  const write = deps.writeMeta ?? nasStorage.writeMeta.bind(nasStorage)

  const meeting = await loadMeetingMeta(deps, meetingId, subMeetingId)
  const archived = await deps.archives.listArchivedAssetsForMeeting(meetingId, subMeetingId)
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
      // 只在 fullyArchived 时才走到这里，理论上不该发生（archived 计数与 completed
      // 计数相等，且 archived 行只能由 completed 行产生）。真发生了也不能编一个
      // NAS 路径出来——清单宁可少一条，也不能撒谎。
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
      // bytes 取 bytes_expected 而不是 bytes_written，理由见 domain/manifest.ts 的字段注释
      bytes: row.bytesExpected,
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
    // 归档目录按**归档时刻**的年/月分（nasDirFor），所以一场跨月才归档齐的会议，
    // 早先那批资产留在上个月的目录里，而 meeting_archives.nas_dir 只记得最后一次。
    // 清单照实写每个文件的真实 nasPath（找得到），但这个错位本身要留痕。
    console.warn(
      `archive sidecar: meeting=${meetingId} subMeeting=${subMeetingId} 有 ${elsewhere} 个已归档资产不在 ${nasDir} 内（跨月归档？），清单按各自真实的 nasPath 记录`,
    )
  }

  const missing: ManifestMissingEntry[] = (
    await deps.archives.listMissingAssets(meetingId, subMeetingId)
  ).map((r) => ({
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
      // 是已知事实，而 US-6.2 第二条验收标准要的"原始 ID"正是它们。
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
    missing,
    archive: { archivedAt: now, retentionDays, nasDir },
    generatedAt: now,
    generatedBy: 'mde-worker',
  }

  // 路径相对 nasRoot（Storage 接口的口径），落点仍然是 nasDir 本身。
  const relDir = relative(deps.nasRoot, nasDir)
  // 超时包装由**这里**持有，不指望 write 的实现自带：NAS 挂起时 fs 调用是挂住而不是
  // 报错，"有限时间内返回"这条保证不能随着换一个实现就消失。缺省的
  // createNasStorage 内部也包了一层同样预算的，重一次无害。
  await withFsTimeout(write(join(relDir, 'meeting.json'), meta), `write ${join(nasDir, 'meeting.json')}`, timeoutMs)
  await withFsTimeout(write(join(relDir, '_manifest.json'), manifest), `write ${join(nasDir, '_manifest.json')}`, timeoutMs)
}

/**
 * 取会议元数据；**取不到不是错误**，返回 null 由调用方如实写进清单。
 *
 * 抛出也一样按"取不到"处理：归档本身是更重要的事，一次读元数据失败不该把一场
 * 已经搬完、已经校验过哈希的归档判成失败。但两种情况的 warn 话术分开——
 * "表里没这一行"和"查库炸了"是两件要查的不同的事。
 */
async function loadMeetingMeta(
  deps: ArchiveDeps,
  meetingId: string,
  subMeetingId: string,
): Promise<Meeting | null> {
  try {
    const m = await deps.getMeeting(meetingId, subMeetingId)
    if (m === null) {
      console.warn(
        `archive sidecar: meeting=${meetingId} subMeeting=${subMeetingId} 在 meetings 表里没有元数据，NAS 上的 meeting.json 相应字段如实写 null`,
      )
    }
    return m
  } catch (err) {
    console.warn(
      `archive sidecar: meeting=${meetingId} subMeeting=${subMeetingId} 读会议元数据失败（${err}），NAS 上的 meeting.json 相应字段如实写 null`,
    )
    return null
  }
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

export async function archiveMeeting(
  deps: ArchiveDeps,
  meetingId: string,
  subMeetingId: string,
  now: number,
): Promise<ArchiveOutcome> {
  const completed = await deps.archives.listCompletedAssets(meetingId, subMeetingId)
  const nasDir = nasDirFor(deps.nasRoot, meetingId, subMeetingId, now)

  let newlyArchived = 0
  let verificationFailed = 0
  for (const asset of completed) {
    if (await deps.archives.isAssetArchived(asset)) continue // 已归档过，跳过（支持安全重跑）
    const outcome = await archiveOneAsset(deps, asset, nasDir, now)
    if (outcome === 'archived') newlyArchived++
    else verificationFailed++
  }

  const totalCompleted = await deps.archives.countCompletedAssets(meetingId, subMeetingId)
  const totalArchived = await deps.archives.countArchivedAssets(meetingId, subMeetingId)
  const fullyArchived = totalCompleted > 0 && totalCompleted === totalArchived

  // 只在"这次调用真的让某个资产从未归档变成已归档"时才落 meeting_archives，
  // 不是每次 fullyArchived 求值为 true 就重新 upsert。
  //
  // 这条守卫是必要的，不是防御性冗余：Step 5 接入 worker 主循环之后，
  // archiveMeeting 会在每一轮对每场已知会议都被调用一遍（引擎的 runExecutor 只给
  // 聚合计数，没有"这一轮具体碰过哪些会议"这个列表可用，见 src/worker/index.ts）。
  // 也就是说，对一场早就归档完的会议，"再调一次 archiveMeeting 但这次什么都没有
  // 新归档"是常态，不是例外。若没有这条守卫，upsertMeetingArchive 会在这种
  // "什么都没变"的重跑里也把 archived_at 悄悄推到"现在"——保留窗口的起点永远追不上
  // 时钟，Task 8 的到期清理会永远找不到任何到期的会议。
  //
  // newlyArchived > 0 精确刻画"这次确实有新东西被归档"：无论是第一次凑齐全部资产，
  // 还是全部归档完之后又有一个新资产类型（比如迟到的 AI 纪要）事后才归档进来，
  // 只要这次真归档了至少一个资产，重新 upsert（刷新 archived_at/nas_dir/
  // retention_days）都合理；纯粹的空转重跑（没有新资产）则原样跳过，已有记录
  // （含它的 archived_at 与只能由 extendRetention 修改的 extended_days）保持不动。
  //
  // NAS sidecar 跟着同一条守卫走，理由完全相同：空转重跑没有任何新内容可写，
  // 每轮重写一遍只会让 NAS 上的 mtime 和 generatedAt 天天跳，而清单内容一个字没变。
  let sidecar: ArchiveOutcome['sidecar'] = 'skipped'
  if (fullyArchived && newlyArchived > 0) {
    const retentionSetting = await deps.archives.getSetting('default_retention_days')
    const retentionDays = retentionSetting ? Number(retentionSetting) : DEFAULT_RETENTION_DAYS
    await deps.archives.upsertMeetingArchive({ meetingId, subMeetingId, nasDir, archivedAt: now, retentionDays, now })

    // 顺序不能反，也不能合并进一个 try：upsertMeetingArchive 那一行是**保留窗口
    // 开始计时的地方**（meeting_archives.archived_at 是到期公式的起点）。要是把它
    // 排在 sidecar 之后、或者让 sidecar 的失败连坐它，一次写不出清单就会让这场会议
    // 永远拿不到归档记录，于是 listMeetingsNeedingArchive 每轮都把它捞回来重新归档，
    // 而每次 recordArchivedAsset 都已经写过了——归档流水线原地打转。
    //
    // 所以这里是"先把不可丢的事实落库，再尽力写那份自解释的清单"。清单写不出来
    // 是**降级**（NAS 上少了两个 JSON，文件本身和哈希都在库里），不是归档失败。
    // 但按 packages/engine/src/executor/index.ts:38-41 立的规矩，降级要留痕，
    // 不许静默 .catch(() => {})。
    try {
      await writeNasSidecars(deps, meetingId, subMeetingId, completed, nasDir, retentionDays, now)
      sidecar = 'written'
    } catch (err) {
      sidecar = 'failed'
      console.warn(
        `archive sidecar write failed for meeting=${meetingId} subMeeting=${subMeetingId}: ${err}`,
      )
    }
  }

  return { meetingId, subMeetingId, newlyArchived, verificationFailed, fullyArchived, sidecar }
}

export interface ArchiveRoundOutcome {
  newlyArchived: number
  verificationFailed: number
  /** archiveMeeting 本身抛出（NAS 挂起触发的 FsTimeoutError、本地文件意外缺失触发的
   *  ENOENT 之类）而没能正常返回结果的会议数——这些不是 archiveOneAsset 内部已经
   *  优雅处理的"哈希校验不一致"（那种走 verificationFailed，不计入这里）。
   *  dev-plan.md 的全局约束把"归档失败"列为最高级别告警，这个计数就是那条告警
   *  的数据来源，不是可以放心忽略的数字。 */
  failed: number
  /** NAS sidecar 没写出来的会议数。**刻意与 failed 分开、也刻意不进退出码**：
   *  资产已经在 NAS 上、哈希已经校验过、meeting_archives 已经落库，少两个 JSON 是
   *  可解释性降级，不是"归档失败"那条最高级别告警。合并成一个数字会让真正的归档
   *  故障被 sidecar 的噪音稀释。与 WorkerRound.manifests.failed 同一口径。 */
  sidecarFailed: number
}

/**
 * 对 listMeetingsNeedingArchive() 给出的每一场"有未归档完成资产"的会议调用一次
 * archiveMeeting，逐会议做错误隔离：一场会议的 archiveMeeting 抛出不能连累排在
 * 后面的会议——不隔离的话，例如某场会议的本地文件被人手误删触发 ENOENT，会让
 * 同一轮里排在它后面的所有会议都归档不了，即便它们与那场会议毫无关系。
 *
 * 这与 archiveOneAsset 内部"哈希校验不一致就地跳过、不重试、不抛出"是两层不同的
 * 容错：那一层处理的是"归档动作本身完成了，但结果不可信"，这一层处理的是
 * "归档动作根本没能跑完"。两者都不应该中止整批会议的归档，但含义不同，所以
 * 分别计入 verificationFailed 与 failed，不合并成一个数字。
 */
export async function archivePendingMeetings(
  deps: ArchiveDeps,
  now: () => number,
): Promise<ArchiveRoundOutcome> {
  const pending = await deps.archives.listMeetingsNeedingArchive()
  const result: ArchiveRoundOutcome = { newlyArchived: 0, verificationFailed: 0, failed: 0, sidecarFailed: 0 }
  for (const { meetingId, subMeetingId } of pending) {
    try {
      const outcome = await archiveMeeting(deps, meetingId, subMeetingId, now())
      result.newlyArchived += outcome.newlyArchived
      result.verificationFailed += outcome.verificationFailed
      if (outcome.sidecar === 'failed') result.sidecarFailed++
    } catch (err) {
      result.failed++
      console.error(`archiveMeeting failed for meeting=${meetingId} subMeeting=${subMeetingId}:`, err)
    }
  }
  return result
}

// 为什么这里不用 Task 2 的 createNasStorage，明明它就是为归档准备的：Storage 接口是
// 按"边下载边写、可断点续传"设计的（appendChunk + finalize），服务的是"数据从网络进来、
// 逐块落盘"这个场景。这里是相反的场景——本地已经有一个完整的文件，要一次性搬到 NAS 上，
// 用途是"流式拷贝 + 拷贝后整体求哈希"，用 appendChunk 反而要么把整个文件读进内存当一个
// 大 chunk（违反上面"不能一次性载入内存"的约束），要么手工切块调用多次（重新实现一遍
// 流式拷贝，还是绕不开自己写 pipeline）。所以这里直接用 node:fs 的
// pipeline(createReadStream, createWriteStream)，只借 Task 2 抽出来的 withFsTimeout
// 防止 NAS 那一端挂起。createNasStorage 本身仍然是有效交付物——它满足的是 dev-plan.md
// 明确要的"实现同一个 Storage 接口"，为将来可能出现的"直接下载到 NAS"路径或其他消费者
// 留着，不是本任务白造了一个用不上的东西。

// 为什么 verificationFailed 不让整场会议的归档失败、也不重试同一个哈希不一致的资产而是
// 就地跳过：跳过之后 isAssetArchived 仍会在下一轮返回 false（因为没写 archived_assets），
// 所以下一轮 worker 循环会自动重试这个资产——不需要专门的重试计数字段。哪些资产在
// "重试但一直失败"，这是阶段 4 才有的展示能力（分诊条的"归档失败"格），本任务只需要
// 保证正确性（不会把校验失败的资产错误地标记为已归档），不需要在这里实现展示。
