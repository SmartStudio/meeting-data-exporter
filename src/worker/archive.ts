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
import { meetingFacts } from '../policy/access'
import type { MeetingFacts } from '../policy/conds'
import { resolveArchiveDir, type ArchiveDirOutcome } from '../policy/archive-dir'
import { applyOverride, type MeetingOverride } from '../policy/override'
import { evaluateArchiveStack, type StackRule } from '../policy/stacks'

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
 * 求值器要的事实。**事实本身仍由 `policy/access.ts` 的 `meetingFacts` 构造**，
 * 这里只做一次类型归一——仓库里有两个 `Meeting`：
 *
 * - 引擎那个（`@yaowu/mde-engine`，`ArchiveDeps.getMeeting` 给的）字段可空，
 *   它是"拼落盘路径用的那点信息"的视角；
 * - 网关那个（`src/domain/types`，`meetingFacts` 收的）字段非空，还多
 *   `meetingRecordId` / `state`。
 *
 * 所以不能把前者直接递给 `meetingFacts`。**但也不能顺手在这里另写一个事实构造器**：
 * `meetingFacts` 里那条「`endTime <= startTime` 视为没有结束时间数据」的回落识别是
 * 有教训的（照直算会让 `dur lt 30` 静默命中所有缺 `record_end_time` 的会议），
 * 这种逻辑只能有一份实现。于是这里只补空值与两个多出来的字段，事实照旧交给它：
 *
 * - 空值一律按本仓库的约定编码（文本 `''`、时间 `0`），与 DB 里 NOT NULL 列的口径一致；
 * - `meetingRecordId` 引擎侧根本没有这个概念，`meetingFacts` 也不读它，填 `''`；
 * - `state` 填 `'completed'` 不是随手填的：能走到归档的会议，其录制早已转码完成、
 *   资产也已经下载完毕（`archiveMeeting` 只处理有 completed 资产的会议）。
 */
function factsFor(meeting: Meeting, archived: boolean): MeetingFacts {
  return meetingFacts(
    {
      meetingId: meeting.meetingId,
      subMeetingId: meeting.subMeetingId,
      meetingRecordId: '',
      meetingCode: meeting.meetingCode ?? '',
      subject: meeting.subject ?? '',
      hostUserId: meeting.hostUserId ?? '',
      startTime: meeting.startTime ?? 0,
      endTime: meeting.endTime ?? 0,
      state: 'completed',
    },
    archived,
  )
}

/**
 * 这场会议归档到 NAS 的哪个目录，或者为什么这一轮不归档（阶段 3 · T9）。
 *
 * ## 这里替换掉了什么
 *
 * 阶段 2 用的是一条固定规则 `<归档时刻的年>/<月>/<meetingId>[_<subMeetingId>]`，
 * 那段代码的注释自己写着「等 R1/R4 落地后这里要接一个真正的规则求值」。R1 已经落地
 * （`src/policy/stacks.ts` 的 `evaluateArchiveStack`），这里就是那次接线：目录由
 * archive 栈判出来的**目录模板**渲染而成，模板求值的全部规矩在
 * `src/policy/archive-dir.ts`（含四个占位符、坏模板一律判不归档的理由）。
 *
 * ## 顺带修掉的那个 bug：年月取会议 startTime，不是归档时刻
 *
 * 旧实现用 `archivedAtSec` 算 `{年}/{月}`。**七月的会议在八月被归档，就会落进
 * `2026/08/`**，而本地归档区（`packages/engine/src/domain/filename.ts` 的
 * `meetingDirPath`）用的是**会议的 startTime**。同一场会议在两处的年月目录不一致，
 * 人去 NAS 上按月份找会议就会找不到——而这件事没有任何地方会报错。
 *
 * **改变算法是安全的，已核实**：`archived_assets.nas_path` 与
 * `meeting_archives.nas_dir` 都是**存进库里的**，`src/worker/retention.ts` 读的是
 * 记录里的值（`asset.nasPath` / `asset.localPath`）而不是重算路径。所以已经归档过的
 * 文件不会因为算法变了而失联——它们仍按老路径被找到、被校验、被清理。
 * 记在这里，下一个人不必再查一遍。
 *
 * （旧注释里「为什么不复用 cleanDirName」那段随之作废：它的前提是「这里的输入是
 * meetingId / subMeetingId 这种结构化 ID，没有自由文本」。模板的 `{标题}` 就是自由
 * 文本，所以它现在**必须**过与本地目录同一套清洗——那段清洗已经从 `cleanDirName`
 * 里提成了 `cleanSubjectSegment`，两处共用一份，不许各写一份。）
 *
 * `getMeeting` 拿不到元数据时**不归档**：归档规则的条件求值与 `{年}/{月}/{标题}`
 * 都要会议字段，没有字段就是「判断不出来」，按全局约束落到安全侧并留下理由。
 * 「用一个默认目录归档」不是更宽容的选择——它会把这场会议静静写进 `1970/01/untitled`。
 */
async function decideArchiveDir(
  deps: ArchiveDeps,
  meetingId: string,
  subMeetingId: string,
  meeting: Meeting | null,
  rules: readonly StackRule[],
  override: MeetingOverride | null,
  now: number,
): Promise<ArchiveDirOutcome> {
  if (meeting === null) {
    return {
      archive: false,
      // undecidable：这不是「规则说不归档」，是 meeting_assets 里有资产而 meetings
      // 表里没有对应行——采集侧的数据不一致。它不会自己好转，也不该和正常的
      // skip 装在同一个计数里
      undecidable: true,
      reason:
        `读不到会议 ${meetingId}/${subMeetingId || '-'} 的元数据（meetings 表里没有这一行，或查库失败）；` +
        '归档规则的条件与目录模板都要会议字段，判不出该归档到哪里，按不归档处理',
    }
  }

  // `archived` 是 `arch`（isarch / notarch）条件的数据源，**查出来传，不猜**：
  // 随手填 false 会让一条 `arch notarch → 归档到 X` 的规则对已归档的会议也成立。
  // 这一轮进到这里的会议数量很小（listMeetingsNeedingArchive 只给「有未归档完成
  // 资产」的那些），一次查询换一个正确的事实是划算的。
  const archived = (await deps.archives.findMeetingArchive(meetingId, subMeetingId)) !== null

  // 人工改写优先于**所有**规则（spec §5.4）。套在求值**外面**而不是混进
  // evaluateArchiveStack：规则求值是纯函数、可预览、可回放，把「某场会议的人工
  // 决定」混进去，影响预览（T5）就再也算不准了——它算的是「规则改了会怎样」，
  // 而被改写的会议根本不受规则支配。
  //
  // 套完仍然是一个同形状的 ArchiveDecision，所以下面渲染目录那一段原样复用，
  // 改写不需要自己一条路径。
  const decision = applyOverride(
    evaluateArchiveStack(rules, { facts: factsFor(meeting, archived), now }),
    override,
  )

  return resolveArchiveDir(decision, {
    nasRoot: deps.nasRoot,
    meeting,
    // 会议号缺失时顶 meeting_id——与本地归档区（meetingDirPath 的 fallbackCode）同口径
    fallbackCode: meetingId,
  })
}

/**
 * 两个 id 拼成一场会议的键。用 NUL 分隔而不是 `/`——会议 id 是外部系统给的，
 * 拿可打印分隔符去赌它不出现在 id 里，撞上一次就是两场会议共用一条改写。
 * 与 `policy/override.ts` 的 `targetKey`、`access.ts` 的 `overrideKey` 同一个理由。
 */
function overrideKey(meetingId: string, subMeetingId: string): string {
  return `${meetingId}\u0000${subMeetingId}`
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
   * 这批会议的 archive 人工改写（spec §5.4）。同 `listArchiveRules`：
   * **每轮取一次**，在 `archivePendingMeetings` 的循环外。
   *
   * 传一批键而不是逐场问，理由与 `listArchivedMeetingKeys` 那条注释一样——
   * 一轮几十上百场会议逐场往返一次是白花的查询。
   */
  listArchiveOverrides: (
    keys: { meetingId: string; subMeetingId: string }[],
  ) => Promise<readonly MeetingOverride[]>
  /**
   * 归档栈的规则来源（阶段 3 · T9）。
   *
   * **为什么又是一个函数而不是 `PolicyStore`**：同 `getMeeting` 的先例——本文件顶部
   * 的三表边界注释解释了这里为什么对依赖吝啬。归档流水线需要的只是「archive 这一栈
   * 当前启用的规则」，把整个 store 递进来会让它顺手够得着 `policy_rules` 之外的东西。
   *
   * **每轮取一次，不是每场会议取一次**：`archivePendingMeetings` 在循环**外**调它
   * 一次，把结果当参数传给每场会议的 `archiveMeeting`。一轮可能有几十上百场会议，
   * 每场重查一遍既是白花的查询，又会让同一轮里前后两场会议按不同的规则集判——
   * 同一轮内不该有两套口径。`archiveMeeting` 的 `rules` 是显式参数正是为了这一点：
   * 规则从哪来不是它能自己决定的事。
   */
  listArchiveRules: () => Promise<readonly StackRule[]>
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
  /**
   * **归档规则判为不归档**（阶段 3 · T9）：兜底 skip、规则 skip、目录模板渲染不出
   * 合法路径、会议元数据取不到，四种情况都是它。为 true 时这一轮一个字节都没搬，
   * `newlyArchived` 恒为 0，`fullyArchived` 恒为 false（没算过，不是「算出来是 false」）。
   *
   * 与 `verificationFailed` / 抛出的 `failed` **不是一回事**：那两个是「想归档但没归成」，
   * 这个是「按规则本来就不该归」。合并成一个数字会让真正的故障被正常的 skip 淹没。
   */
  skipped: boolean
  /**
   * `skipped` 为 true 时，是**判不出来**（模板写坏了、元数据取不到）还是
   * **规则就是这么定的**（命中 skip、走兜底）。`skipped` 为 false 时恒为 false。
   *
   * 分开是因为两者在运维上完全不同：后者是正常运转（归档栈的兜底本来就是 skip），
   * 前者是一条规则的意图没能被执行、命中它的会议一场都归不了档、而且不会自己好转。
   * 合在一个数字里的话，一条写坏的规则在轮末汇总里与「今天没有会议需要归档」
   * 长得一模一样。
   */
  undecidable: boolean
  /**
   * 判定理由，一句人话，**归不归档都有**。
   *
   * 归档时是命中规则的那句话（「归档规则 #3「财务部」决定：归档到 …」），不归档时是
   * 兜底/规则/坏模板各自的理由。一场会议悄悄没被归档是这个系统里最难排查的一类现象，
   * 所以任何「判断不出来」的路径都必须带着这句话回来——它同时进日志与返回值，
   * 阶段 4 的会议详情抽屉直接展示它。
   */
  reason: string
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
  // 元数据由调用方读好传进来：T9 之后归档目录本身就要用它（判定 + 模板渲染），
  // 同一轮里再查一次库只会多一次查询，还可能读到两个不同的值。
  meeting: Meeting | null,
  completed: CompletedAssetRow[],
  nasDir: string,
  retentionDays: number,
  now: number,
): Promise<void> {
  const timeoutMs = deps.nasWriteTimeoutMs ?? NAS_WRITE_TIMEOUT_MS
  const nasStorage = createNasStorage(deps.nasRoot, timeoutMs)
  const write = deps.writeMeta ?? nasStorage.writeMeta.bind(nasStorage)

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
    // T9 之前归档目录按**归档时刻**的年/月分，一场跨月才归档齐的会议因此会把早先那批
    // 资产留在上个月的目录里，而 meeting_archives.nas_dir 只记得最后一次。现在目录由
    // 规则模板算、`{年}/{月}` 取会议 startTime，这个成因没有了；但**换成规则之后
    // 又多了一个新成因**：管理员中途改了目录模板（或改了规则优先级），同一场会议前后
    // 两轮判出不同的目录。清单照实写每个文件的真实 nasPath（找得到），但错位本身要留痕。
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
 * 取会议元数据；**读失败不抛出**，返回 null 由调用方决定后果。
 *
 * 抛出与"表里没这一行"都按"取不到"处理，但 warn 话术分开——"表里没这一行"和
 * "查库炸了"是两件要查的不同的事。
 *
 * T9 之后取不到元数据的后果变了：从前只是 `meeting.json` 里几个字段写 null、归档照常，
 * 现在**整场会议这一轮不归档**（归档目录要靠会议字段判，判不出来就落安全侧，
 * 见 `decideArchiveDir`）。这行 warn 因此是"为什么这场会议没归档"的第一现场，
 * 措辞不再提 sidecar。
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
        `archive: meeting=${meetingId} subMeeting=${subMeetingId} 在 meetings 表里没有元数据`,
      )
    }
    return m
  } catch (err) {
    console.warn(
      `archive: meeting=${meetingId} subMeeting=${subMeetingId} 读会议元数据失败（${err}）`,
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

/**
 * 归档一场会议。
 *
 * `rules` 是**显式参数**而不是从 `deps` 里现取的（阶段 3 · T9）：规则每轮取一次，
 * 由 `archivePendingMeetings` 在循环外取好传进来。见 `ArchiveDeps.listArchiveRules`。
 */
export async function archiveMeeting(
  deps: ArchiveDeps,
  meetingId: string,
  subMeetingId: string,
  now: number,
  rules: readonly StackRule[],
  /**
   * 这场会议的 archive 改写，没有就传 `null`。
   *
   * **和 `rules` 一样做成必填参数**：`archivePendingMeetings` 在循环外一次取清
   * 整批，这里只负责用。做成可选参数的话，漏传就是静默按规则判——而管理员按下
   * 「这场归到别处」不生效，和没按一样，没有任何痕迹。
   */
  override: MeetingOverride | null,
): Promise<ArchiveOutcome> {
  // 先判、再搬。判定要用会议元数据，元数据同时也是 sidecar 要写的东西，一并读在这里。
  const meeting = await loadMeetingMeta(deps, meetingId, subMeetingId)
  const dir = await decideArchiveDir(deps, meetingId, subMeetingId, meeting, rules, override, now)
  if (!dir.archive) {
    // 判为不归档：**一个字节都不搬**，也不写任何记录。理由带回去（调用方记进日志与
    // 计数），这是这场会议"为什么不在 NAS 上"的唯一线索。
    return {
      meetingId,
      subMeetingId,
      newlyArchived: 0,
      verificationFailed: 0,
      // 没有算过"是不是全归档完了"——不归档的会议问这个问题没有意义
      fullyArchived: false,
      sidecar: 'skipped',
      skipped: true,
      undecidable: dir.undecidable,
      reason: dir.reason,
    }
  }
  const nasDir = dir.nasDir

  const completed = await deps.archives.listCompletedAssets(meetingId, subMeetingId)

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
      await writeNasSidecars(deps, meetingId, subMeetingId, meeting, completed, nasDir, retentionDays, now)
      sidecar = 'written'
    } catch (err) {
      sidecar = 'failed'
      console.warn(
        `archive sidecar write failed for meeting=${meetingId} subMeeting=${subMeetingId}: ${err}`,
      )
    }
  }

  return {
    meetingId, subMeetingId, newlyArchived, verificationFailed, fullyArchived, sidecar,
    skipped: false,
    undecidable: false,
    reason: dir.reason,
  }
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
  /** **归档规则判为不归档**的会议数（阶段 3 · T9）：兜底 skip、规则 skip、坏模板、
   *  元数据取不到。**不是故障**，所以既不进退出码也不并进 failed——规则没配就什么
   *  都不归档是设计如此（spec §4.6 兜底 skip）。但它也不能只是一个数字：每一场都
   *  带着一句理由 console.warn，见 archivePendingMeetings 里的说明。 */
  skipped: number
  /** 上面那 `skipped` 里**判不出来**的那部分（阶段 3 · T9 之后拆出来）：模板写坏了、
   *  元数据取不到。**这个数字非零就是有事要办**——一条写坏的规则会让命中它的会议
   *  一场都归不了档，而且不会自己好转。它仍然不进退出码：让它进的话，一场永远
   *  匹配不上的会议会把退出码永久钉成非零，那种警报很快就没人看了。 */
  undecidable: number
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
  const result: ArchiveRoundOutcome = {
    newlyArchived: 0, verificationFailed: 0, failed: 0, sidecarFailed: 0, skipped: 0, undecidable: 0,
  }
  // 没有待办就不必查规则——与 listMeetingsNeedingArchive 自带的那个早退同一个道理
  if (pending.length === 0) return result

  // **规则每轮取一次**，在循环外。一轮可能有几十上百场会议：每场重查一遍既是白花的
  // 查询，又会让同一轮里前后两场会议按不同的规则集判（管理员正好在这一轮中间改了
  // 规则）——同一轮内不该有两套口径。取好之后按值传给每场会议。
  const rules = await deps.listArchiveRules()

  // 改写同样每轮取一次。按会议索引起来，`kind !== 'archive'` 的丢掉——
  // 一条 allow 改写（effect 是 'allow'/'deny'）若被当成归档模板，
  // 'allow' 会被 normalizeEffect('archive', …) 认成一段合法的目录名
  const overrides = await deps.listArchiveOverrides(pending)
  const overrideOf = new Map<string, MeetingOverride>()
  for (const o of overrides) {
    if (o.kind !== 'archive') continue
    overrideOf.set(overrideKey(o.meetingId, o.subMeetingId), o)
  }

  for (const { meetingId, subMeetingId } of pending) {
    try {
      const outcome = await archiveMeeting(
        deps, meetingId, subMeetingId, now(), rules,
        overrideOf.get(overrideKey(meetingId, subMeetingId)) ?? null,
      )
      result.newlyArchived += outcome.newlyArchived
      result.verificationFailed += outcome.verificationFailed
      if (outcome.sidecar === 'failed') result.sidecarFailed++
      if (outcome.skipped) {
        result.skipped++
        if (outcome.undecidable) result.undecidable++
        // 判为不归档必须留痕，哪怕它是正常的。**一场会议悄悄没被归档，是这个系统里
        // 最难排查的一类现象**：库里没有记录、NAS 上没有目录、日志里没有一行，
        // 唯一的线索就是这句理由。
        //
        // 已知代价：一场永远匹配不上规则的会议会**每一轮**都出现在
        // listMeetingsNeedingArchive 里，于是每轮都重复这一行。这是刻意接受的——
        // 重复的一行能被看见，沉默不能。阶段 4 的分诊条会把它变成界面上的一格，
        // 那时这行日志才是纯粹的兜底。
        console.warn(
          `archive skipped for meeting=${meetingId} subMeeting=${subMeetingId}: ${outcome.reason}`,
        )
      }
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
