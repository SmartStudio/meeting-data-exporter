import {
  DEFAULT_ASSET_KEYS,
  FsTimeoutError,
  createLocalStorage,
  discover,
  downloadAsset,
  parseAssetKeys,
  runExecutor,
  runProbes,
  withFsTimeout,
  writeMeetingManifests,
  type AssetKey,
  type AssetSource,
  type DownloadTask,
  type MeetingSelector,
  type Storage,
  type Store,
} from '@yaowu/mde-engine'
import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stats } from 'node:fs'
import { loadConfig } from '../config'
import { createCatalog } from '../catalog/index'
import { POOL_CONNECTION_LIMIT, createPool, runMigrations } from '../store/db'
import { createStsStore } from '../store/sts'
import { createStsManager } from '../sts/manager'
import { createTokenCipher } from '../sts/cipher'
import { decryptCheckStr, decryptEvent, verifySignature } from '../sts/crypto'
import { createAddressesApi } from '../tencent/addresses'
import { createTencentClient } from '../tencent/client'
import { createRecordsApi } from '../tencent/records'
import { createArchivesStore, type ArchivesStore } from '../store/archives'
import { createPolicyStore, type PolicyStore } from '../store/policy'
import { archivePendingMeetings, type ArchiveDeps } from './archive'
import { createInProcSource } from './source-inproc'
import { createMysqlStore } from './store-mysql'

export interface WorkerDeps {
  store: Store
  source: AssetSource
  storage: Storage
  /** 同时在跑的执行体数量。上限受连接池约束，见 assertConcurrencyFitsPool */
  concurrency: number
  /** 领取任务时写进 lease_expires_at 的租约时长（秒） */
  leaseSec: number
  /** 归档流水线（P2）依赖：归档记录存取 */
  archives: ArchivesStore
  /** 规则存取。worker 只用它的 archive 一栈（**往 NAS 的哪个目录归档**，spec §4.6）：
   *  fetch 栈的接线是另一件事，allow 栈是网关的活（见 src/policy/access.ts 的文件头）。
   *  这里持有整个读接口、只在下面把 archive 那一栈收成一个函数递给 archiveDeps，
   *  是刻意的分层：WorkerDeps 是宿主、本来就握着各个 store，ArchiveDeps 才是那个
   *  要对依赖吝啬的地方。 */
  policy: Pick<PolicyStore, 'listEnabledStackRules'>
  /** 本地归档区根目录（MDE_ARCHIVE_ROOT）——与 storage 指向同一棵目录树。
   *  Storage 接口本身不暴露自己的根路径，archiveMeeting 拼本地源文件路径
   *  （join(localRoot, target_path)）需要单独拿到它，所以在这里另传一份。 */
  localRoot: string
  /** 归档目的地根目录（MDE_NAS_ROOT，NAS 挂载点） */
  nasRoot: string
}

export interface WorkerRound {
  /** 本轮发现的会议数 */
  meetings: number
  /** 本轮发现的**就绪资产**条数——不是"新增的活"，已 completed 的行照样计入 */
  tasks: number
  probes: { resolved: number; abandoned: number; newTasks: number }
  completed: number
  failed: number
  skipped: number
  /** 本轮 sidecar（meeting.json / _manifest.json）收尾的汇总。failed 是写入抛出的场次数——
   *  它**不进退出码**：资产已经落盘了，一份没写出来的清单不该把一轮成功的下载判成失败。
   *  但每一次都会 console.warn，不是静默吞掉。 */
  manifests: { written: number; skipped: number; failed: number }
  /** 本轮归档流水线（P2）的汇总：对 ArchivesStore.listMeetingsNeedingArchive() 给出的
   *  每场"有未归档完成资产"的会议累加。failed 是逐会议错误隔离之后没能正常归档完的
   *  会议数（archiveMeeting 本身抛出，不是可以放心忽略的数字，见 archive.ts 的
   *  ArchiveRoundOutcome 注释）。sidecarFailed 是 NAS 上那两个自解释 JSON 没写出来的
   *  会议数——与 failed 分开、且不进退出码，理由同 manifests.failed。 */
  archived: {
    newlyArchived: number
    verificationFailed: number
    failed: number
    sidecarFailed: number
    /** 归档规则判为不归档的会议数（阶段 3 · T9）。**不是故障、不进退出码**：
     *  归档栈的兜底就是 skip，规则没配就什么都不归档是设计如此（spec §4.6）。
     *  每一场都带着理由 warn 过，见 archive.ts 的 archivePendingMeetings。 */
    skipped: number
  }
}

/**
 * 一轮完整的拉取：发现 → 补探测 → 执行下载。
 *
 * 与 mde CLI 的 `run` 命令是**同一套调用序列**（client/src/cli/commands/run.ts），
 * 区别只在 store 与 source 的实现：CLI 那边是 SQLite + HTTP 网关客户端，
 * 这边是 MySQL + 进程内 catalog。这正是引擎抽包的目的——两个宿主共用一条代码
 * 路径，行为不会分叉。
 *
 * `now` 取**函数**而不是一个冻结的时间戳，这一条不是风格问题：
 * `claimNext` / `touchProgress` 写进 `lease_expires_at` 的是 `now() + leaseSec`，
 * 租约的全部意义就是"这个任务还有人在干"。时钟一旦冻结在本轮开始时刻，
 * 一轮跑得比 leaseSec 久（几 GB 的录制很正常）之后，别的实例按自己的活时钟
 * 一看就判定租约过期，把还在下载中的任务抢走——两个进程同时写同一个 `.part`。
 * CLI 宿主传的也是活时钟，两边必须一致。
 */
export async function runWorkerOnce(
  deps: WorkerDeps,
  sel: MeetingSelector,
  keys: AssetKey[],
  now: () => number,
): Promise<WorkerRound> {
  const found = await discover({ gw: deps.source, store: deps.store }, sel, keys, now())

  // 必须在 discover 之后才建：拼落盘路径要用刚写进 meetings 表的会议元数据。
  // 走 Store.meetingsForPaths() 而不是自己拿 pool 查一遍——CLI 那边正是因为绕过
  // Store 直连 db，才长出过三份逐字重复的 loadMeetings（T3 已删）。
  const meetingsById = await deps.store.meetingsForPaths()

  const execDeps = {
    store: deps.store,
    storage: deps.storage,
    gw: deps.source,
    meetingsById,
    download: (task: DownloadTask, onProgress: (b: number) => void) =>
      downloadAsset({ storage: deps.storage, gw: deps.source, onProgress }, task, now),
  }

  const probes = await runProbes(execDeps, now)
  const ran = await runExecutor(
    execDeps,
    { concurrency: deps.concurrency, leaseSec: deps.leaseSec },
    now,
  )

  // 一轮下载的收尾：给每场会议写 meeting.json / _manifest.json（US-6.2「归档结果可脱离
  // 系统理解」）。放在这里而不是 executor 里边下边写，是因为 runExecutor 是逐资产的并发
  // 执行体，内部根本没有「这场会议下完了」这个判定——详见 packages/engine/src/manifest。
  //
  // 枚举源用 meetingsById 而不是归档那边的 listMeetingsNeedingArchive()：sidecar 描述的是
  // **本地归档区里那个目录**，而那个目录正是 meetingsById 算出来的；两边必须同源，否则
  // 清单会落到一个没有资产的目录里。这也意味着它继承了 meetingsById 按 meeting_id 去重的
  // 已知窟窿（见下方 archive 段落的说明）——在那个洞被修好之前，与资产落盘保持同一种行为，
  // 好过在这里自作主张地分叉。
  //
  // 这一段写的是**本地归档区**那一份（deps.storage 指向 MDE_ARCHIVE_ROOT）。
  // NAS 上那一份由归档链路**独立生成**（archiveMeeting → writeNasSidecars），
  // 不是把这两个文件搬过去——NAS 那份要多带归档特有的信息（nasPath / nasHash /
  // archivedAt / retentionDays / nasDir），而且本地这份 30 天后会被到期清理删掉，
  // 长期活下来的是 NAS 那一份。两份共用 packages/engine/src/domain/manifest.ts
  // 的同一套类型（NAS 版是本地版的 extends），格式不分叉。
  const manifests = await writeMeetingManifests(
    { store: deps.store, storage: deps.storage, generatedBy: 'mde-worker' },
    meetingsById,
    now,
  )

  // 归档：把（本轮以及此前遗留、这一轮才终于补齐的）已完成下载的资产搬到 NAS。
  //
  // 枚举源是 ArchivesStore.listMeetingsNeedingArchive()，不是上面的 meetingsById——
  // meetingsById 是 Store.meetingsForPaths() 给的，按 meeting_id 去重，专为本地落盘
  // 路径命名设计（一次只需要一个"代表"元数据的场次）。周期性会议同一 meeting_id 下
  // 还有其它 sub_meeting_id 时，去重会把它们静默丢掉，永远不会被传给 archiveMeeting，
  // 对应场次因此永远不会归档、永远进不了 meeting_archives（这个去重行为本身是对的，
  // 被 tests/worker/store-mysql.test.ts:393 的既有回归测试钉住了；错的是把它复用成
  // 归档流水线的枚举源）。listMeetingsNeedingArchive() 直接按 (meeting_id,
  // sub_meeting_id) 这个真实主键枚举，不丢会议；它还只返回"completed 数量 > 已归档
  // 数量"的那些，顺带给出"没有待办事项就不必再查"的早退，不会对早就归档完的会议
  // 每轮都重新查一遍。
  //
  // 逐会议错误隔离（一场会议的 archiveMeeting 抛出不连累其它会议）与
  // "archived_at 不被空转重跑推着走"的守卫都在 archivePendingMeetings /
  // archiveMeeting 内部，见 archive.ts 的注释。
  // getMeeting 是**注入的函数**而不是整个 store：ArchivesStore 刻意不读 meetings 表
  // （三张表边界之外的第四张），但 NAS 上的 meeting.json 必须有 subject / 会议号 /
  // 起止时间，否则那个目录里只剩一串 ID。这里的 deps.store 本来就有这个读法，
  // 直接把它当依赖递进去，边界不破、来源单一。
  //
  // 归档到**哪个目录**由 archive 规则栈判（阶段 3 · T9，src/policy/archive-dir.ts）：
  // 阶段 2 那条「按归档时刻的年/月 + 会议 ID」的固定规则已经作废。listArchiveRules
  // 同样是**注入的函数**而不是整个 PolicyStore，理由与 getMeeting 一样；
  // 它每轮只会被调一次（archivePendingMeetings 在循环外调），不是每场会议一次。
  const archiveDeps: ArchiveDeps = {
    archives: deps.archives,
    localRoot: deps.localRoot,
    nasRoot: deps.nasRoot,
    getMeeting: (meetingId, subMeetingId) => deps.store.getMeeting(meetingId, subMeetingId),
    listArchiveRules: () => deps.policy.listEnabledStackRules('archive'),
  }
  const archived = await archivePendingMeetings(archiveDeps, now)

  return { ...found, probes, ...ran, manifests, archived }
}

// ---------------------------------------------------------------------------
// 进程入口
// ---------------------------------------------------------------------------

/**
 * 默认执行体数量。**上限是连接池给的，不是拍脑袋定的**：
 * `claimNext` 在事务期间独占一条连接，而每个执行体在下载期间还会压着一条
 * 未 await 的 `touchProgress`（进度回写是 fire-and-forget），
 * 所以稳态的峰值连接需求约等于 `concurrency × 2`。
 *
 * ⚠️ **`×2` 是稳态的典型值，不是最坏值。** 真正的最坏是**无界**：`touchProgress`
 * 不被 await，写库一慢就会一条接一条地堆起来（见 `poolQueueLimitFor`）。
 * 也就是说 `assertConcurrencyFitsPool` 挡的是「稳态就已经配过头」这一类配置错误，
 * 它**挡不住在途堆积**——后者是 `queueLimit` 的活。别把这两道闸门读成一件事。
 *
 * `assertConcurrencyFitsPool` 把**硬上限**卡在 `2 × concurrency ≤ 10`，也就是
 * concurrency ≤ 5（5 时余量恰好为零）。默认取 4 是**刻意站在硬上限之下**，
 * 给发现阶段与收尾写库留两条连接——上限是「不会立刻出事」，默认值是「留了余量」，
 * 两者不是同一个数。
 */
const DEFAULT_CONCURRENCY = 4

/** 租约时长，与 mde CLI 的 run 命令一致（client/src/cli/commands/run.ts） */
const LEASE_SEC = 900

/**
 * 排队等连接的上限 = `2 × 并发度 + 2`。
 *
 * **先说清楚它挡不住什么，因为这一点很容易被读反。**
 * `queueLimit` 限的是**队列长度，不是等待时长**，而 mysql2 没有取连接超时。
 * 队列还没满时，排在上面的请求（包括真正阻塞推进的 `claimNext`）照样无限期
 * 静默等下去，与默认配置**没有任何区别**。这道闸门只在**队列满的那一刻**才起作用。
 *
 * 它真正兜住的是 fire-and-forget 的 `touchProgress`：`downloader` 每 8MB
 * **同步**触发一次 `onProgress`（packages/engine/src/downloader/index.ts），
 * 而 executor 的回调**不 await** `touchProgress`
 * （packages/engine/src/executor/index.ts）。所以在途的 `touchProgress` 数量
 * **无界**——一个 2GB 的录制能排出 ~250 个等待者。连接被慢查询占住时，
 * 这些请求会一条接一条地堆进队列，堆到内存里去。这才是这道闸门存在的理由。
 *
 * **稳态的等待者是 0，任何等待者都已经是异常。** `discover` /
 * `meetingsForPaths` / `runProbes` 都在 `runExecutor` 之前串行跑完，执行期每个
 * 执行体的 await 链严格串行，所以并发的取连接请求 = 并发度（awaited）
 * + ≤ 并发度（在途 touchProgress）= `2 × 并发度` ≤ 10 = 池上限，全都能拿到连接，
 * 根本排不出队。`2 × 并发度 + 2` 里的 `+2` 只是给抖动留的一点余量，
 * 不是「稳态队列深度」。
 *
 * 换掉原先硬编码的 16，理由是**随并发度缩放、撞线更早**（并发度 1 时闸门是 4，
 * 而不是一个与配置无关的 16），不是「16 够不着」——16 在 `touchProgress`
 * 这条无界路径上完全够得着。
 *
 * ⚠️ **撞线的表现，别读错**：mysql2 的 `getConnection` 在队列满时对**所有**调用方
 * 一律 `cb(new Error('Queue limit reached.'))`，不区分是谁
 * （node_modules/mysql2/lib/base/pool.js）。而 `claimNext` / `markCompleted` /
 * `setTargetPath` 都没有被 try/catch 包住，`runExecutor` 的 `Promise.all` 也不 catch。
 * 所以撞线的真实表现是：**整轮当场抛出、退出码 1、已领取的行卡在 `running`
 * 直到租约过期**，而不是「进程还在跑、只是每 8MB 多一行 warn」。
 * （`touchProgress` 自己的那条 `.catch(console.warn)` 只吞掉它自己那次拒绝；
 * 同一时刻打到 `claimNext` 上的那次没人接。）
 *
 * 根治要的是「取连接超时」，mysql2 不提供，需要另开任务（见 task-7-report §4）。
 */
export function poolQueueLimitFor(concurrency: number): number {
  return concurrency * 2 + 2
}

export interface WorkerArgs {
  sel: MeetingSelector
  keys: AssetKey[]
  concurrency: number
}

/** `YYYY-MM-DD`（按 UTC 零点）或直接给 unix 秒——与 mde CLI 的 parseDate 同规则 */
function parseDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m === null) {
    const n = Number(s)
    if (Number.isFinite(n)) return n
    throw new Error(`bad date: ${s}`)
  }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000
}

/**
 * 选会议的旗标沿用 mde CLI 的词汇（`--code` / `--meeting-id`），不合并成一个
 * `--meeting`：**会议号（meeting_code，形如 881-123-40）与 meeting_id 是两个不同的
 * 东西**，一个旗标表达不了，猜错了拉回来的是另一场会。两个宿主的词汇也不该分叉。
 */
export function parseWorkerArgs(argv: string[], defaultConcurrency: number): WorkerArgs {
  let from: number | undefined
  let to: number | undefined
  let code: string | undefined
  let meetingId: string | undefined
  let keys: AssetKey[] = DEFAULT_ASSET_KEYS
  let concurrency = defaultConcurrency

  /**
   * 取旗标的值，缺值时**指着那个旗标**报错。
   *
   * 不做这一步的话，缺值会被后面的逻辑翻译成一句指向别处的错误话：
   * `--code`（没带值）会落进 range 分支报「requires --from and --to」，运维会以为
   * 自己忘了给 `--code`，其实是给了没带值；`--assets`（没带值）会以
   * `undefined.trim()` 抛 TypeError 而不是 UnknownAssetKeyError。
   *
   * 以 `--` 开头一律当作「下一个旗标」而不是值：本命令的合法值（日期、会议号、
   * meeting_id、资产 csv、数字）没有一个长这样。
   */
  const value = (i: number, flag: string): string => {
    const v = argv[i]
    if (v === undefined || v.startsWith('--')) throw new Error(`flag ${flag} requires a value`)
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--from') from = parseDate(value(++i, a))
    else if (a === '--to') to = parseDate(value(++i, a))
    else if (a === '--code') code = value(++i, a)
    else if (a === '--meeting-id') meetingId = value(++i, a)
    else if (a === '--assets') keys = parseAssetKeys(value(++i, a))
    else if (a === '--concurrency') concurrency = Number(value(++i, a))
    else throw new Error(`unknown flag: ${a}`)
  }

  if (code !== undefined && meetingId !== undefined) {
    throw new Error('--code and --meeting-id are mutually exclusive')
  }
  const sel: MeetingSelector =
    code !== undefined
      ? { kind: 'code', meetingCode: code, from, to }
      : meetingId !== undefined
        ? { kind: 'id', meetingId, from, to }
        : (() => {
            if (from === undefined || to === undefined) {
              throw new Error('worker requires --from and --to, or --code / --meeting-id')
            }
            return { kind: 'range', from, to } as const
          })()

  return { sel, keys, concurrency }
}

/**
 * 并发度必须对着连接池的上限定。不校验的后果不是变慢，是**无限期静默挂起**：
 * mysql2 没有取连接超时，排在队列上的 `claimNext` 会一直等下去，没有超时、
 * 没有报错、没有日志。`queueLimit` 救不了这一条：配成 8 时会稳定排出 6 个等待者，
 * 而闸门在 `2 × 8 + 2 = 18`，**永远撞不到**，于是那 6 个就那么静默地等
 * （`poolQueueLimitFor` 的注释讲了这道闸门的射程）。既然运行期兜不住，
 * 就必须挡在启动期，让配错的人当场看到原因，而不是对着一台没有任何输出的机器排查。
 *
 * 这里给的是**硬上限**（`2 × concurrency ≤ 10`，即 concurrency ≤ 5，5 时余量为零），
 * 与 `DEFAULT_CONCURRENCY = 4` 是两件事：上限是「不会立刻出事」，默认值是
 * 「还留了余量」。
 */
export function assertConcurrencyFitsPool(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`worker concurrency must be a positive integer, got: ${concurrency}`)
  }
  // ×2：claimNext 的事务连接 + 同一执行体稳态下仍在途的那一条 touchProgress。
  // （在途 touchProgress 的真实上界是无界的，那部分由 queueLimit 兜，不在这里。）
  if (concurrency * 2 > POOL_CONNECTION_LIMIT) {
    throw new Error(
      `worker concurrency ${concurrency} needs up to ${concurrency * 2} pooled connections ` +
        `but the pool caps at ${POOL_CONNECTION_LIMIT} (claimNext holds one for the whole transaction)`,
    )
  }
}

/**
 * 归档区校验里每次 fs 调用的超时。
 *
 * 有它的唯一理由：归档根目录在部署上是**网络挂载**，而硬挂载（NFS `hard` /
 * SMB 默认）掉线时 `stat` 与 `writeFile` 是**挂住**，不是报错。没有超时的话，
 * 这个「防止 worker 静默挂起」的启动期校验，自己就成了一次无限期的静默挂起
 * ——正是本任务反复在消灭的那个失效形态。
 *
 * 5s 对一次空文件写来说宽到离谱（健康的本地盘与 NAS 都在毫秒级），
 * 所以它只会在真的挂住时触发，不会误伤慢盘。
 *
 * ⚠️ 超时只能让**校验**喊出来并退出，它**不能**把已经卡在内核里的那次
 * 系统调用取消（fs 调用跑在线程池上，AbortSignal 也救不了已经进入 D 状态的线程）。
 * 这里靠的是「报错 → 进程退出 → 线程随进程一起没」。
 */
/**
 * 探针超时。**做成可注入的第二参数不是为了配置，是为了可测**：挂死的挂载在本地
 * 造不出来，但用一个没有读者的 FIFO 可以——`writeFile` 以 `O_WRONLY` 打开它会
 * 永久阻塞在 open，超时必赢，不存在竞速。没有注入口，这条分支就只能靠嘴说。
 */
const ARCHIVE_PROBE_TIMEOUT_MS = 5_000

/**
 * 归档区根目录的启动期校验：**必须已经存在、是目录、且真的可写**。
 *
 * 只查非空是不够的，而**用 `mkdir -p` 把它建出来更糟**——那恰好会放过这里要挡的
 * 那个错误：`MDE_ARCHIVE_ROOT=/mnt/archiv`（少一个 e）会被静默造出一棵新目录树，
 * 整场会议归档进去，退出码 0。而本系统的产品模型是「NAS 是主存储、本地 30 天后
 * 删」，归档到了错的地方且没人知道，一个月后就是永久丢失。
 *
 * 归档根目录在部署上是一个**挂载点**，本来就该先于 worker 存在。所以这里要求它
 * 预先存在（打错的路径不存在 → 当场报错），只有它下面的年/月/会议子目录才由
 * `createLocalStorage` 按需创建。
 *
 * **写探针能证明什么、不能证明什么**（别把它读大了）：
 * - 能：**只读挂载**与**权限错配**——这两种情况下权限位可能仍然好看，
 *   只有真写一次才看得出来（`chmod 0o500` 的用例钉的就是后者）。
 * - **不能：磁盘满。** 探针写的是**空文件**，多数文件系统只要还有一个 inode
 *   和一个目录项就能建出来，盘满了照样成功。磁盘空间是下载时逐个资产判的
 *   （引擎的 `ensureFreeSpace` → `skipped`），不归这里管。
 * - **不能：把挂死的 NAS 变成一个错误。** 硬挂载掉线时 fs 调用是挂住而不是
 *   报错，这里靠 `ARCHIVE_PROBE_TIMEOUT_MS` 把它变成一句超时错误。
 *
 * 探针文件带 pid，避免多实例互踩，用完即删。
 */
export async function assertArchiveRootUsable(
  root: string | undefined,
  timeoutMs: number = ARCHIVE_PROBE_TIMEOUT_MS,
): Promise<string> {
  if (root === undefined || root === '') {
    throw new Error('missing required config: MDE_ARCHIVE_ROOT')
  }
  let st: Stats
  try {
    // stat 一样要包超时：挂死的网络挂载上它和 writeFile 一样会挂住。
    st = await withFsTimeout(stat(root), `stat(${root})`, timeoutMs)
  } catch (err) {
    // 超时与「不存在」是两件不同的故障，错误话必须分开，否则值班的人会去
    // 检查一个其实存在、只是挂死了的挂载点的拼写。
    if (err instanceof FsTimeoutError) throw err
    throw new Error(
      `MDE_ARCHIVE_ROOT does not exist: ${root}. ` +
        'It must already exist (it is normally a mount point) — the worker will not create it, ' +
        'because auto-creating a mistyped path would silently archive into the wrong place.',
    )
  }
  if (!st.isDirectory()) {
    throw new Error(`MDE_ARCHIVE_ROOT is not a directory: ${root}`)
  }
  const probe = join(root, `.mde-worker-write-probe-${process.pid}`)
  try {
    await withFsTimeout(writeFile(probe, ''), `write probe in MDE_ARCHIVE_ROOT ${root}`, timeoutMs)
  } catch (err) {
    if (err instanceof FsTimeoutError) throw err
    throw new Error(
      `MDE_ARCHIVE_ROOT is not writable: ${root} (${err instanceof Error ? err.message : String(err)})`,
    )
  } finally {
    // 清理是尽力而为：它自己也可能在挂死的挂载上超时，而一个从 finally 里抛出的
    // 次生错误会盖掉上面那个真正的根因。留一个空探针文件远比丢掉根因划算。
    await withFsTimeout(
      rm(probe, { force: true }),
      `cleanup write probe in ${root}`,
      timeoutMs,
    ).catch(() => {})
  }
  return root
}

async function main(): Promise<number> {
  // 先把配置与参数校验完再开任何资源：配错时不该留下半开的连接池。
  // 复用网关的 loadConfig 而不是另建一套——worker 与网关同机同 .env 部署，
  // 共享腾讯凭据、DATABASE_URL 与 STS_ENC_KEY（STS-Token 就存在同一张表里）。
  const config = loadConfig(process.env)
  // 空串必须与未设置等价：.env.example 里这类可选项写作 `MDE_WORKER_CONCURRENCY=`，
  // 而 Bun 把它读成空串而不是 undefined，`?? DEFAULT` 只挡 undefined，
  // 于是 Number('') = 0 会一路穿到并发度上（见 src/config.ts 的 optional 注释）。
  const rawConcurrency = process.env.MDE_WORKER_CONCURRENCY
  const args = parseWorkerArgs(
    process.argv.slice(2),
    rawConcurrency === undefined || rawConcurrency === ''
      ? DEFAULT_CONCURRENCY
      : Number(rawConcurrency),
  )
  assertConcurrencyFitsPool(args.concurrency)

  // 归档区根目录走 process.env 而非 loadConfig：它是 worker 独有的进程编排参数
  // （由 systemd / 容器挂载决定），网关进程不需要它，塞进 loadConfig 会让网关
  // 也被迫配一个用不到的变量。与 src/index.ts 处理 PORT / HOST 的口径一致。
  const archiveRoot = await assertArchiveRootUsable(process.env.MDE_ARCHIVE_ROOT)

  // NAS 根目录（归档流水线 P2 的搬运目的地）同样是 worker 独有的进程编排参数，
  // 与 archiveRoot 相同的理由不塞进 loadConfig。这里只做"必须已配置"的最小校验，
  // 不做 assertArchiveRootUsable 那一整套存在性/目录/可写性 + 超时探测——那一整套
  // 运行期可重复调用的版本是 Task 4 的 probeNas（src/worker/nas-probe.ts），
  // 服务的是控制台"归档存储"页；本任务的 Step 5 只负责把归档流水线接进主循环，
  // 不重新实现一遍 NAS 侧的启动期硬校验。真正把 probeNas 接到这里（或做一次等价的
  // 启动期强校验）留给消费 probeNas 的那个后续任务。空着不配的后果与 MDE_ARCHIVE_ROOT
  // 打错一样是"静默用一个不存在/错误的路径"，所以至少必须显式配置，不能悄悄回落成
  // undefined 一路穿到 join(undefined, ...) 才在很远的地方炸出一个不知所云的错误。
  const nasRoot = process.env.MDE_NAS_ROOT
  if (nasRoot === undefined || nasRoot === '') {
    throw new Error('missing required config: MDE_NAS_ROOT')
  }

  const now = (): number => Math.floor(Date.now() / 1000)

  const pool = createPool(config.databaseUrl, { queueLimit: poolQueueLimitFor(args.concurrency) })
  try {
    await runMigrations(pool)
    const store = createMysqlStore(pool)
    const archives = createArchivesStore(pool)
    const policy = createPolicyStore(pool)

    const tencentClient = createTencentClient(config.tencent, {
      fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // 毫秒时钟：项目里通用的 now() 是秒级，喂给令牌桶会让补充速率慢 1000 倍
      nowMs: Date.now,
    })
    const recordsApi = createRecordsApi(tencentClient, config.tencent.operatorId)
    const addressesApi = createAddressesApi(tencentClient, config.tencent.operatorId)

    // STS-Token 的**续期是网关的活**：平台异步回调，落点是网关的 webhook 路由。
    // worker 只读同一张表里当前有效的那一枚（getToken 内部解密），不调 ensureFresh
    // ——它发出的申请只有网关能收到回调，worker 自己等不到。因此 worker 依赖
    // 网关进程在跑；表里没有有效 token 时 AI 纪要类下载会以
    // StsTokenUnavailableError 显式失败，而不是静默跳过。
    const tokenCipher = createTokenCipher(config.stsEncKey)
    const stsManager = createStsManager({
      store: createStsStore(pool),
      client: tencentClient,
      operatorId: config.tencent.operatorId,
      webhookToken: config.webhook.token,
      aesKey: config.webhook.aesKey,
      encrypt: tokenCipher.encrypt,
      decrypt: tokenCipher.decrypt,
      verify: verifySignature,
      decryptEvent,
      decryptCheckStr,
    })
    const catalog = createCatalog({ addressesApi, stsManager, now })

    const source = createInProcSource({ recordsApi, catalog, now })
    const storage = createLocalStorage(archiveRoot)

    const res = await runWorkerOnce(
      {
        store, source, storage, concurrency: args.concurrency, leaseSec: LEASE_SEC,
        archives, policy, localRoot: archiveRoot, nasRoot,
      },
      args.sel,
      args.keys,
      now,
    )
    console.log(`discovered meetings=${res.meetings} tasks=${res.tasks}`)
    console.log(
      `probes resolved=${res.probes.resolved} abandoned=${res.probes.abandoned} new=${res.probes.newTasks}`,
    )
    console.log(`completed=${res.completed} failed=${res.failed} skipped=${res.skipped}`)
    console.log(
      `manifests written=${res.manifests.written} skipped=${res.manifests.skipped} ` +
        `failed=${res.manifests.failed}`,
    )
    console.log(
      `archived newlyArchived=${res.archived.newlyArchived} ` +
        `verificationFailed=${res.archived.verificationFailed} failed=${res.archived.failed} ` +
        `sidecarFailed=${res.archived.sidecarFailed} skipped=${res.archived.skipped}`,
    )
    // 归档失败（archiveMeeting 本身抛出）与下载失败一样必须让退出码变非零——
    // dev-plan.md 的全局约束把"归档失败"列为最高级别告警，一个盯着 cron/systemd
    // 退出码的监控系统如果只看 res.failed，会把"某场会议归档不了"误判成本轮成功。
    return res.failed > 0 || res.archived.failed > 0 ? 1 : 0
  } finally {
    // 关停顺序：一轮跑完（或抛出）→ 关连接池 → 进程退出。
    // 进度回写是 fire-and-forget，池关掉时可能还有一两条在途，它们会被
    // executor 里的 .catch 记成一行 warn——那正是当初不肯用 void 吞掉它的原因。
    await pool.end()
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('worker run failed', err)
      process.exit(1)
    })
}
