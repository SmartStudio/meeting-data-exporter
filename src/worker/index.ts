import {
  DEFAULT_ASSET_KEYS,
  createLocalStorage,
  discover,
  downloadAsset,
  parseAssetKeys,
  runExecutor,
  runProbes,
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

  return { ...found, probes, ...ran }
}

// ---------------------------------------------------------------------------
// 进程入口
// ---------------------------------------------------------------------------

/**
 * 默认执行体数量。**上限是连接池给的，不是拍脑袋定的**：
 * `claimNext` 在事务期间独占一条连接，而每个执行体在最坏交错下还可能同时压着
 * 一条未 await 的 `touchProgress`（进度回写是 fire-and-forget），
 * 所以峰值连接需求约等于 `concurrency × 2`。
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
 * 所以：**`claimNext` 的池耗尽仍然会无限期静默挂起**——`assertConcurrencyFitsPool`
 * 已经把同时发起的取连接请求卡在 `2 × 并发度 ≤ 10`，worker 自己**永远排不出**
 * 一条很长的队，一道高高在上的闸门根本够不着。这道防线不覆盖 `claimNext`。
 *
 * 它真正兜住的是**另一件事**：大文件下载中每 8MB 发一条、fire-and-forget 的
 * `touchProgress`。那条路径不受并发度约束——连接被占住时它会一条接一条地堆进
 * 队列，堆到内存里去。闸门定在 `2 × 并发度 + 2`（稳态之上一点点）才够得着：
 * 稳态最多 `2 × 并发度` 个等待者，队列深度正常是 0，一旦堆积立刻撞线报错。
 * 定成 16 那种够不着的值等于没有这道闸门。
 *
 * 代价要一并写明：`touchProgress` 的错误处理是 `.catch(console.warn)`，所以撞线
 * 的表现是**每 8MB 一行 warn**，而真正阻塞推进的 `claimNext` 仍然静默等。
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
 * 没有报错、没有日志（`poolQueueLimitFor` 的注释讲了为什么 queueLimit 救不了
 * 这一条）。既然运行期兜不住，就必须挡在启动期，让配错的人当场看到原因，
 * 而不是对着一台没有任何输出的机器排查。
 *
 * 这里给的是**硬上限**（`2 × concurrency ≤ 10`，即 concurrency ≤ 5，5 时余量为零），
 * 与 `DEFAULT_CONCURRENCY = 4` 是两件事：上限是「不会立刻出事」，默认值是
 * 「还留了余量」。
 */
export function assertConcurrencyFitsPool(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`worker concurrency must be a positive integer, got: ${concurrency}`)
  }
  // ×2：claimNext 的事务连接 + 同一执行体可能仍在途的 touchProgress
  if (concurrency * 2 > POOL_CONNECTION_LIMIT) {
    throw new Error(
      `worker concurrency ${concurrency} needs up to ${concurrency * 2} pooled connections ` +
        `but the pool caps at ${POOL_CONNECTION_LIMIT} (claimNext holds one for the whole transaction)`,
    )
  }
}

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
 * 可写性用一次真实的写探针判定，不看权限位：只读挂载、磁盘满、NAS 掉线时
 * 权限位可能仍然好看，而写会失败。探针文件带 pid，避免多实例互踩，用完即删。
 */
export async function assertArchiveRootUsable(root: string | undefined): Promise<string> {
  if (root === undefined || root === '') {
    throw new Error('missing required config: MDE_ARCHIVE_ROOT')
  }
  let st: Stats
  try {
    st = await stat(root)
  } catch {
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
    await writeFile(probe, '')
  } catch (err) {
    throw new Error(
      `MDE_ARCHIVE_ROOT is not writable: ${root} (${err instanceof Error ? err.message : String(err)})`,
    )
  } finally {
    await rm(probe, { force: true })
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

  const now = (): number => Math.floor(Date.now() / 1000)

  const pool = createPool(config.databaseUrl, { queueLimit: poolQueueLimitFor(args.concurrency) })
  try {
    await runMigrations(pool)
    const store = createMysqlStore(pool)

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
      { store, source, storage, concurrency: args.concurrency, leaseSec: LEASE_SEC },
      args.sel,
      args.keys,
      now,
    )
    console.log(`discovered meetings=${res.meetings} tasks=${res.tasks}`)
    console.log(
      `probes resolved=${res.probes.resolved} abandoned=${res.probes.abandoned} new=${res.probes.newTasks}`,
    )
    console.log(`completed=${res.completed} failed=${res.failed} skipped=${res.skipped}`)
    return res.failed > 0 ? 1 : 0
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
