import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFsTimeout } from '@yaowu/mde-engine'
import type {
  ArchivesStore,
  ArchivedAssetRecord,
  CompletedAssetRow,
  MeetingArchiveRecord,
} from '../store/archives'

/**
 * 本文件是全系统唯一执行不可逆删除的代码（dev-plan.md §6 点名的最高风险项）。
 * 三条硬要求逐字生效，改这个文件之前先读一遍：
 *
 *   1. 删之前**当场重新校验** NAS 上那份文件的哈希——重新读一遍、重新算一遍，
 *      不是查 archived_assets.nas_hash 那个归档当时记下的值就算数
 *   2. "暂停到期清理"开关持久化在 system_settings，**不能**是内存标志：NAS 断连
 *      通常伴随重启或切换，内存标志会在最需要它的时候消失。同样地也不能"一轮只读
 *      一次"——一轮的耗时是无界的，理由见 executeCleanup 里的说明
 *   3. 默认 dry-run，真删必须显式二次确认
 */

/**
 * 单个 NAS 文件重新算一遍哈希的超时上限。
 *
 * 这是"挂住了"的探测器，不是性能指标：网络挂载出问题时 fs 调用会静静地挂着而不是
 * 报错，这个值回答的是"等到什么时候就断定它挂了"。所以它必须比"最大的那个资产在
 * 健康 NAS 上读完"还宽得多——录像资产可以有几个 GB，按到 NAS 的现实读取速率
 * （几十 MB/s）算，一个几 GB 的文件读完就要好几分钟。
 *
 * 沿用 Task 2 给 stat/mkdir 那种小调用定的 5s 是错的口径：那样所有大文件必然超时，
 * 对应的会议永远进 verificationFailed、永远清理不掉，而且"需要人工介入"这条告警会
 * 被这种超时噪音淹没，真正的篡改信号反而被埋在里面。
 */
const NAS_READ_TIMEOUT_MS = 10 * 60_000

async function sha256File(path: string): Promise<string> {
  // 流式读取，理由同 src/worker/archive.ts：录像资产可以有几个 GB，
  // 一次性读进内存会把 worker 打爆。
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export interface RetentionDeps {
  archives: ArchivesStore
  localRoot: string
  /** 单个 NAS 文件重算哈希的超时，缺省用 NAS_READ_TIMEOUT_MS。开成可注入的理由与
   *  Task 2 的 createNasStorage(root, timeoutMs) 一样：默认值要对生产上几个 GB 的
   *  资产现实，测试要能传一个小值来验证"读得太久就不许删"这条分支。 */
  nasReadTimeoutMs?: number
}

export interface CleanupItem {
  meetingId: string
  subMeetingId: string
  /** 该会议本轮清理能腾出的本地字节数，来自 meeting_assets.bytes_written 之和——
   *  只数真的会被删的那些资产，口径见 localBytesOf */
  localBytes: number
  /** 本轮会被删掉本地文件的资产数（= archived_assets 里这场会议的行数），
   *  与 localBytes 描述的是同一批资产 */
  assetCount: number
}

export interface CleanupPreview {
  dryRun: true
  items: CleanupItem[]
  totalBytes: number
}

export interface CleanupExecuted {
  dryRun: false
  /** 本轮是否被暂停开关中止。两种情形：开轮之前就已经是暂停状态（purged 必为空）；
   *  或者轮次跑到一半被按下暂停（purged 是暂停生效之前已经删掉的那些）。 */
  paused: boolean
  /** 本轮真的删掉了本地文件、并写了 local_purged_at 的会议。
   *  paused=true 时它**未必为空**：删除已经发生的事实不会因为随后按下暂停而收回，
   *  调用方要照它显示"本轮删了这些"，没轮到的候选留给下一轮。 */
  purged: CleanupItem[]
  /** 哈希重新校验不一致（或 NAS 侧读不到）、本轮拒绝删除的会议——需要人工介入，
   *  不是静默跳过 */
  verificationFailed: Array<{ meetingId: string; subMeetingId: string; reason: string }>
  /** 处理过程本身抛出（本地盘 EACCES、markLocalPurged 撞上数据库故障之类）而没能
   *  跑完的会议。与 verificationFailed 是两层不同的容错：那一层是"校验做完了、
   *  但结果不可信"，这一层是"这场会议根本没处理完"。两者含义不同，所以分两个桶，
   *  不合并成一个数字——与 ArchiveRoundOutcome 里 failed / verificationFailed
   *  的分法一致。 */
  failed: Array<{ meetingId: string; subMeetingId: string; reason: string }>
}

function expiresAt(rec: MeetingArchiveRecord): number {
  return rec.archivedAt + (rec.retentionDays + rec.extendedDays) * 86400
}

/**
 * 硬要求 2：暂停状态只认 system_settings.cleanup_paused，不缓存、不进内存。
 *
 * 极性刻意是"除了明确说没暂停，一律算暂停"：这是全系统唯一能拦下不可逆删除的开关，
 * 读到一个不认识的值（被别的工具写坏、写成了 'true'、多了个空格）时，当成"没暂停"
 * 继续删是不可逆的错，当成"暂停"最多晚一天清理。键还没被写过（null）不算"不认识"
 * ——那是这个系统的出厂状态，就是没暂停。
 */
async function isPaused(archives: ArchivesStore): Promise<boolean> {
  const raw = await archives.getSetting('cleanup_paused')
  return !(raw === null || raw === '0')
}

/**
 * 本轮真正到期的会议。SQL 侧已经按 local_purged_at IS NULL + archived_at <= now
 * 粗筛过（见 ArchivesStore.listExpiredUnpurged 的注释：三列算术组合用不上索引，
 * 所以精确的到期公式放在这里算）。
 *
 * 边界取"严格过期"：now 必须严格大于到期时刻，正好走到到期那一秒还不删，下一轮
 * 才删。对不可逆删除来说，边界上偏晚一秒是对的那一侧。
 */
async function expiredCandidates(deps: RetentionDeps, now: number): Promise<MeetingArchiveRecord[]> {
  return (await deps.archives.listExpiredUnpurged(now)).filter((r) => expiresAt(r) < now)
}

/** archived_assets 与 meeting_assets 共用的自然键。两个列表都已经按会议筛过，
 *  所以只需要后三段。用 JSON 数组当键而不是拼分隔符，免得挑一个"值里一定不会出现"
 *  的分隔符去赌。 */
function assetKey(a: { assetType: string; remoteId: string; fileType: string }): string {
  return JSON.stringify([a.assetType, a.remoteId, a.fileType])
}

/**
 * 这场会议本轮清理能腾出的字节数：只数**真的会被删的那些**——既在 archived_assets
 * 里有记录（清理正是照它逐个删），又在 meeting_assets 里找得到对应的 completed 行
 * （bytes_written 这个下载事实记在那边）。
 *
 * 为什么要做这次交集，而不是把 completed 全加起来：两张表在一种中间态下并不重合——
 * 归档完成之后又有新资产下载完、但还没归档成功（迟到的 AI 纪要，或者某个资产的
 * 哈希一直对不上在一轮轮重试）。那种会议里没进 archived_assets 的资产不会被删、
 * 本地文件还在，把它的字节数算进"能腾出多少空间"就是虚报，assetCount 与 localBytes
 * 也会各自描述不同的一批资产。交集用两个已经拿在手里的数组算，不多发一次查询。
 *
 * 不去 stat 本地文件：这个数在文件删掉之后仍然要报得出来。
 */
function localBytesOf(completed: CompletedAssetRow[], archived: ArchivedAssetRecord[]): number {
  const willDelete = new Set(archived.map(assetKey))
  return completed.filter((a) => willDelete.has(assetKey(a))).reduce((sum, a) => sum + a.bytesWritten, 0)
}

/**
 * 硬要求 1：删之前把 NAS 上每个文件重新读一遍、重新算一遍哈希，与 archived_assets
 * 里记的值比对。不信任那个记录值本身——Task 7 归档时确实校验过一次，但从归档到到期
 * 之间隔着几十天，这期间 NAS 上的文件可能被外部因素改动过或干脆不见了，
 * "上次校验过"不等于"现在还一致"。
 *
 * 返回 null 表示全部一致；返回字符串表示本轮拒绝删除的原因。任何一个资产校验不过，
 * 整场会议本轮都不删——不做"部分删"，否则库里的 local_purged_at 语义会变得含糊
 * （到底是"全删了"还是"删了一半"）。
 *
 * 原因里带上具体的 nas_path：这条信息的用途是"需要人工介入"，只说"有文件对不上"
 * 的话，人工得自己把整场会议的资产挨个重算一遍才知道从哪查起。
 */
async function verifyNasCopies(assets: ArchivedAssetRecord[], timeoutMs: number): Promise<string | null> {
  for (const asset of assets) {
    let currentHash: string
    try {
      // 触达 NAS 的 fs 调用一律包超时：网络挂载可能挂住而不是报错，
      // 不包的话清理任务会静静地卡在某个 read 上，看起来像"今天没有到期文件"。
      currentHash = await withFsTimeout(sha256File(asset.nasPath), `hash ${asset.nasPath}`, timeoutMs)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return `NAS 上的归档文件读取失败：${asset.nasPath}（${detail}）——已跳过，不删除该会议任何本地文件`
    }
    if (currentHash !== asset.nasHash) {
      return `NAS 上的归档文件哈希与归档记录不一致：${asset.nasPath}——已跳过，不删除该会议任何本地文件`
    }
  }
  return null
}

/**
 * 预览：只读，永远安全，不需要检查暂停开关（暂停开关管的是"删不删"，
 * 预览不删任何东西）。
 */
export async function previewCleanup(deps: RetentionDeps, now: number): Promise<CleanupPreview> {
  const candidates = await expiredCandidates(deps, now)
  const items: CleanupItem[] = []
  let totalBytes = 0
  for (const rec of candidates) {
    // 预览阶段不读文件、不算哈希——那是"真删"才需要付出的代价（可能触达几十个
    // NAS 文件），预览只需要知道"有哪些、大概多大"，字节数来自已经落库的记录。
    const archived = await deps.archives.listArchivedAssetsForMeeting(rec.meetingId, rec.subMeetingId)
    const completed = await deps.archives.listCompletedAssets(rec.meetingId, rec.subMeetingId)
    const localBytes = localBytesOf(completed, archived)
    items.push({
      meetingId: rec.meetingId,
      subMeetingId: rec.subMeetingId,
      assetCount: archived.length,
      localBytes,
    })
    totalBytes += localBytes
  }
  return { dryRun: true, items, totalBytes }
}

type MeetingOutcome =
  | { kind: 'purged'; item: CleanupItem }
  | { kind: 'verification_failed'; reason: string }
  /** 校验做完了、还没动手删的时候开关被按下：这场会议原样留给下一轮 */
  | { kind: 'paused' }

async function cleanupOneMeeting(
  deps: RetentionDeps,
  rec: MeetingArchiveRecord,
  now: number,
): Promise<MeetingOutcome> {
  const archived = await deps.archives.listArchivedAssetsForMeeting(rec.meetingId, rec.subMeetingId)

  const failure = await verifyNasCopies(archived, deps.nasReadTimeoutMs ?? NAS_READ_TIMEOUT_MS)
  if (failure !== null) return { kind: 'verification_failed', reason: failure }

  // 校验一场会议可能要跑很久——每个资产都是一次几 GB 的流式哈希，一场会议可以有
  // 好几个。这段时间里操作员完全可能已经按下暂停。删是不可逆的，动手之前再确认
  // 一次；不然"按下暂停"到"真的不再删"之间就隔着一整场会议的校验时间。
  if (await isPaused(deps.archives)) return { kind: 'paused' }

  // 校验全部通过——只删本地文件，NAS 副本与数据库记录永久保留（spec.md §4.9）。
  // asset.localPath 是 Task 7 归档时复制进 archived_assets 的本地相对路径副本，
  // 不需要跨表回查 meeting_assets。
  const completed = await deps.archives.listCompletedAssets(rec.meetingId, rec.subMeetingId)
  const localBytes = localBytesOf(completed, archived)

  // force: true 让"文件已经不在了"不算错误，这一条顺带保证了重跑安全：万一删到
  // 一半抛出（本地盘 EACCES 之类），markLocalPurged 不会执行，下一轮重新走一遍
  // 校验与删除时，已经删掉的那些不会再报错。库里因此不会出现"半删"状态——
  // local_purged_at 只在整场会议全部删完之后才写。
  for (const asset of archived) {
    await rm(join(deps.localRoot, asset.localPath), { force: true })
  }
  await deps.archives.markLocalPurged(rec.meetingId, rec.subMeetingId, now)

  // 【阶段 3 R3 才接得上的调用点，不是遗漏】spec §7.2 描述的到期动作里还有一条
  // "撤下授权"：本地文件删掉之后，这场会议此前发给采集程序的授权应当同步失效，
  // 再来取要走 NAS（对应审计里那句"拒绝 · 本地已到期，请去 NAS 取"）。它依赖
  // meeting_grants 这张表——阶段 3 的 R3 才建，本阶段没有可调用的东西。位置就在
  // 这里，紧跟 markLocalPurged：
  //     await deps.grants.revokeForMeeting(rec.meetingId, rec.subMeetingId, now)
  // 现在提前把这个 dep 开进 RetentionDeps，只会造出一个没人实现的接口和一个空实现。

  return {
    kind: 'purged',
    item: {
      meetingId: rec.meetingId,
      subMeetingId: rec.subMeetingId,
      assetCount: archived.length,
      localBytes,
    },
  }
}

/**
 * 真删。confirm 必须显式为 true——调用方（未来 A3 的 API）不给默认值，
 * 逼着每一次调用点都写明白"这次是真删"，不能靠参数省略意外触发。
 */
export async function executeCleanup(deps: RetentionDeps, now: number, confirm: true): Promise<CleanupExecuted> {
  // 类型上 confirm 只能是字面量 true，这一行是给类型系统管不到的调用方兜底
  // （`as true` 强转、从没有类型检查的地方调进来）。为全系统唯一的不可逆删除
  // 多加一道运行期栅栏，代价是一行。
  if (confirm !== true) {
    throw new Error('executeCleanup 需要显式的 confirm === true —— 这是不可逆删除，不接受省略或强制转换')
  }

  const result: CleanupExecuted = {
    dryRun: false,
    paused: false,
    purged: [],
    verificationFailed: [],
    failed: [],
  }

  if (await isPaused(deps.archives)) {
    // 在枚举候选之前就返回：暂停期间连"哪些会议到期了"都不必去问，
    // 更不会有任何一次 fs 调用落到 NAS 或本地文件上。
    result.paused = true
    return result
  }

  const candidates = await expiredCandidates(deps, now)

  for (const rec of candidates) {
    // 每处理一个候选之前重新读一次开关，而不是整轮只在开头读一次：一轮的耗时是
    // 无界的（候选数 × 每场会议全部资产的流式哈希，单个资产可以有几个 GB），
    // "整轮只查一次"与"把开关缓存起来"是同一类问题，只是单位从秒变成了轮次。
    // 操作员按下暂停要的效果就是"从现在起别再删了"，最典型的场景还不是 NAS 故障
    // （那本来就会校验失败），而是"保留配置错了 / 时钟错了 / 这些还不能删"。
    //
    // 这里读不到开关（数据库故障）会抛出、整轮中止，那也是对的那一侧：
    // 确认不了是否暂停，就不许再删下一场。
    if (await isPaused(deps.archives)) {
      result.paused = true
      break
    }

    try {
      const outcome = await cleanupOneMeeting(deps, rec, now)
      if (outcome.kind === 'purged') {
        result.purged.push(outcome.item)
      } else if (outcome.kind === 'verification_failed') {
        result.verificationFailed.push({
          meetingId: rec.meetingId,
          subMeetingId: rec.subMeetingId,
          reason: outcome.reason,
        })
      } else {
        result.paused = true
        break
      }
    } catch (err) {
      // 逐会议错误隔离。候选是按 archived_at ASC 排的，所以"一次失败中止整轮"
      // 不等于"下一轮重试"：持续失败的那场会议永远卡在队首，排在它后面的会议
      // 永远轮不到——下一轮还是死在同一场上。与 archivePendingMeetings 的
      // 逐会议隔离同一个道理。
      result.failed.push({
        meetingId: rec.meetingId,
        subMeetingId: rec.subMeetingId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}
