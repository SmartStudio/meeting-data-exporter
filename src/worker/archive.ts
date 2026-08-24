import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { withFsTimeout, sha256File } from '@yaowu/mde-engine'
import type { ArchivesStore, CompletedAssetRow } from '../store/archives'

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
  if (fullyArchived && newlyArchived > 0) {
    const retentionSetting = await deps.archives.getSetting('default_retention_days')
    const retentionDays = retentionSetting ? Number(retentionSetting) : DEFAULT_RETENTION_DAYS
    await deps.archives.upsertMeetingArchive({ meetingId, subMeetingId, nasDir, archivedAt: now, retentionDays, now })
  }

  return { meetingId, subMeetingId, newlyArchived, verificationFailed, fullyArchived }
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
  const result: ArchiveRoundOutcome = { newlyArchived: 0, verificationFailed: 0, failed: 0 }
  for (const { meetingId, subMeetingId } of pending) {
    try {
      const outcome = await archiveMeeting(deps, meetingId, subMeetingId, now())
      result.newlyArchived += outcome.newlyArchived
      result.verificationFailed += outcome.verificationFailed
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
