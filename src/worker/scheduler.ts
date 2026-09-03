/**
 * 定时任务调度器（阶段 4 · T11，A4）—— spec.md §4.8 的五个任务。
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ **调度器只属于 worker 侧，绝不许装进 `src/index.ts` 的网关进程。**        ║
 * ║                                                                          ║
 * ║ 网关是**多实例**的（同一份镜像跑 N 份，前面挂负载均衡）。把调度器塞进去， ║
 * ║ 五个任务就会各跑 N 份：归档流水线 N 个实例同时往同一个 NAS 目录搬同一批   ║
 * ║ 文件，到期清理 N 个实例同时对同一批本地文件执行**不可逆删除**。           ║
 * ║ 这不是"多花点 CPU"，是数据损坏。                                         ║
 * ║                                                                          ║
 * ║ 网关侧只有**读侧 API 与手动触发的排队**（`http/handlers/console/jobs.ts`）——  ║
 * ║ 那个 handler 只碰 `JobsStore`，它连本文件都不 import。手动触发在网关侧    ║
 * ║ 落一行 `job_runs.status='queued'`，由本文件在下一个 tick 认领并执行。     ║
 * ║                                                                          ║
 * ║ 同理，**本进程自己也只能有一份**：`markInterrupted` 会把它看到的全部残留   ║
 * ║ running 行标成 interrupted，两个调度器互相标记就会给出错误的运行历史。     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ## 调度靠"时间片"，不靠"上次几点跑的"
 *
 * 每个任务的频率把时间轴切成等长的片（每 5 / 15 分钟一片、每小时一片、每天一片），
 * 算术在 `src/store/jobs.ts`（`slotOf` / `nextDueAt`）。每个 tick 比对
 * 「此刻这一片」与「上次触发的那一片」，不同就跑一次。三件事一次解决：
 *
 *   - **对齐墙上时钟**：「每小时整点」是片的边界，不是「进程启动后每 3600 秒」
 *   - **不补跑错过的**（验收判据 3）：`bootstrap()` 把「上次触发的片」钉在**此刻**
 *     这一片，停机期间那些片根本不会被枚举出来，没有可补的东西。补跑一个错过的
 *     「每天 03:00 清理」意味着在早上九点执行一批不可逆删除
 *   - **tick 频率与任务频率解耦**：tick 再密也不会在同一片里跑第二遍
 *
 * 断过的痕迹留在 `job_runs` 里，不在内存里：崩溃时那行 running 没人写
 * `finished_at`，下次 `bootstrap()` 把它改成 interrupted 并填上发现时刻。
 * 时间轴上因此是「…succeeded, interrupted, （一段空白）, succeeded…」，
 * 空白就是停机窗口。
 *
 * ## 重叠保护（验收判据 2）：内存标志 + 一行 skipped
 *
 * 一轮归档可以跑几十分钟，而它每小时到点一次。上一轮没跑完时**不起新的**，
 * 但要**留一行 `status='skipped'`**——什么都不做的话，运维在 sparkline 上看到的是
 * 一个缺口，而缺口既可能是"跳过了"也可能是"调度器死了"，这两件事的处理方式完全相反。
 *
 * 判据用的是**本进程的内存标志**而不是查库里有没有 running 行：库里的 running 行
 * 可能是上一个进程崩掉留下的（`bootstrap` 之前谁都不知道），拿它当锁会让调度器在
 * 一次崩溃之后永远不再起任何一轮。内存标志的射程与"只能有一个调度器实例"这条
 * 部署约束**恰好一致**。
 *
 * ## 任务体不吞异常，但也不让一个对象拖垮整轮
 *
 * 两层，别混：
 *
 *   - **整轮抛出**  → `job_runs.status='failed'` + 一条 `target='__round__'` 的失败项。
 *     腾讯接口 502、数据库连不上属于这一层
 *   - **轮内某个对象失败** → 轮次照样 `succeeded`，那个对象进 `job_failures`。
 *     一场会议归档不上、一个采集程序的清单算不出来属于这一层
 *
 * 混成一件事的后果是：sparkline 会因为一场会议归不上就把整个归档任务标红，
 * 而真正"归档任务挂了"的那一次淹没在里面——告警一旦天天红，就没人看了。
 *
 * ## 接续：一轮拉取真下到了东西，就排一轮归档
 *
 * 归档每小时整点一次，拉取每 15 分钟一次。资产在拉取轮里就已经落了盘，却要再等
 * 最多 60 分钟才被归档——而控制台的「内容预览」只读**已归档**的那一份（正文在归档
 * 那一刻才进 `asset_contents`，录像只从 NAS 播）。那个空档里，界面上这场会议看起来
 * 什么都没有，而实际上文件就在本地。接续要补的就是这一段。
 *
 * 规则声明在 `JOB_CHAINS` 里：某个任务的一轮**成功**结束、且它的摘要满足 `when` 时，
 * 往 `job_runs` 排一行 `status='queued'`、`trigger_kind='chained'`。几处是刻意的：
 *
 *   - **只排队，不自己起**。起任务从头到尾只有 `tick()` 一个入口，接续走的是它第①步
 *     那条现成的认领路径（不在 running 时才认领、多行合并成一轮、顺手把这一片标成
 *     已触发）。自己起的那一版做不到这一点：`tick` 的「查 running → await 认领/写库
 *     → launch」与接续的「查 running → await 写库 → launch」各有一段 await 窗口，
 *     两边一交错就是**两轮归档同时往同一个 NAS 目录搬同一批文件**——正是文件头
 *     那个方框与上面的重叠保护要杜绝的那件事。少一个入口，这个窗口整个消失
 *   - **代价是最多晚一个 tick（30 秒）才起跑**。这一段要消掉的是「最多 60 分钟」，
 *     半分钟的排队时间不在同一个量级上；换来的是并发窗口不存在、且控制台在这半分钟里
 *     显示的是一行诚实的「排队中」，而不是什么都看不见
 *   - **只在 `completed > 0` 时接**。多数拉取轮什么都没下下来，每轮都接一次只是把
 *     归档从每小时一次变成每 15 分钟空跑一次：没有新东西可归，却每一轮都要扫一遍
 *     待归档的会议，还白占着归档那个几十分钟量级的重叠窗口
 *   - **整点那一片照常跑**。接续是补空档的，不是替代：归档还有别的入口（上一轮归不上
 *     的会议、人工补进来的文件），它们不跟着拉取轮走。接续这条路哪天判空了或者被改坏，
 *     整点那一片仍然兜得住
 *   - **下游正在跑时那一行原样留在队里**，不必另设脏标记：`tick()` 本来就只在任务不在
 *     running 时才认领。归档跑了几十分钟、期间接续排进来三行，认领时 `coalesceRuns`
 *     把它们合成一轮（另外两行留下指向那一轮的痕迹）——"新下的这批赶紧归一次"要的
 *     就是一轮，多跑两轮没有任何额外收获。合并这件事也不必再写一遍，手动触发连按三次
 *     用的是同一段代码
 *
 * 排队本身失败（写不进库）只记一行日志，**绝不许冒到 `launch` 外层的 catch 里**：
 * 那个 catch 会把**上游**那一轮记成 failed，而上游明明成功了。
 */
import { DEFAULT_ASSET_KEYS, createLocalStorage, type MeetingSelector } from '@yaowu/mde-engine'
import {
  JOB_CATALOG,
  createJobsStore,
  envInt,
  jobFailureTarget,
  schedulerFetchLookbackHours,
  schedulerTzOffsetSec,
  slotOf,
  type JobName,
  type JobSpec,
  type JobTrigger,
  type JobsStore,
} from '../store/jobs'
import { loadConfig } from '../config'
import { POOL_CONNECTION_LIMIT, closePool, createPool, runMigrations } from '../store/db'
import { createArchivesStore } from '../store/archives'
import { createPolicyStore } from '../store/policy'
import { createGrantsStore } from '../store/grants'
import { createProgramsStore } from '../store/programs'
import { createContentsStore } from '../store/contents'
import { createConsoleMeetingsStore } from '../store/console-meetings'
import { createAuditStore } from '../store/audit'
import { createStsStore } from '../store/sts'
import { createMeetingCacheStore } from '../store/meetings'
import { createStsManager } from '../sts/manager'
import { createTokenCipher } from '../sts/cipher'
import { decryptCheckStr, decryptEvent, verifySignature } from '../sts/crypto'
import { createTencentClient } from '../tencent/client'
import { createRecordsApi } from '../tencent/records'
import { createAddressesApi } from '../tencent/addresses'
import { createCatalog } from '../catalog/index'
import { archivePendingMeetings, type ArchiveDeps, type ArchiveRoundOutcome } from './archive'
import { executeCleanup, type CleanupExecuted } from './retention'
import { computeProgramInventory, type ProgramInventory, type VisibilityDeps } from './visibility'
import { runAutoGrantRound, type AutoGrantDeps, type AutoGrantRound } from './auto-grant'
import { createInProcSource } from './source-inproc'
import { createMysqlStore, type DeadAsset } from './store-mysql'
import {
  DEFAULT_LEASE_SEC,
  assertArchiveRootUsable,
  assertConcurrencyFitsPool,
  poolQueueLimitFor,
  runFetchRound,
  type FetchRound,
  type FetchRoundDeps,
} from './index'
import type { ServiceProgram } from '../store/programs'

/**
 * 「整轮失败」那条失败项的 target。
 *
 * 它与会议维度的 target（`jobFailureTarget()` 拼出来的 `meetingId|subMeetingId`）
 * 共用同一张表的唯一键，所以取一个会议 ID 空间里绝不会出现的形状——腾讯会议的 ID
 * 是数字与短横，不含下划线。
 */
export const ROUND_FAILURE_TARGET = '__round__'

/** 默认 tick 间隔。必须明显小于最短的任务周期（5 分钟），否则会整片整片地错过 */
export const DEFAULT_TICK_INTERVAL_MS = 30_000

// ── 任务体 ────────────────────────────────────────────────────

export interface JobFailInput {
  /** 失败对象的规范化键。会议用 `jobFailureTarget()` 拼 */
  target: string
  /** 人读的对象名。拿不到就别传，**不要编一个** */
  targetLabel?: string
  meetingId?: string | null
  subMeetingId?: string
  reason: string
  /** 绝对计数，不给就累加。只有镜像着别处真实计数器的失败项才该给，见 RecordFailureInput.attempts */
  attempts?: number
}

export interface JobRunContext {
  /** 这次运行在 `job_runs` 里的行 id */
  runId: number
  jobName: JobName
  spec: JobSpec
  trigger: JobTrigger
  /** 本轮开跑的时刻，unix 秒。**任务体内一律用它**，好让同一轮里前后两件事同口径 */
  now: number
  /**
   * 活时钟。**只给那些一轮可以跑很久、且时间参与租约的调用**（归档流水线里
   * `touchProgress` 写的 `lease_expires_at` 就是 `now() + leaseSec`）。
   * 冻结的时间戳会让另一个实例按自己的活时钟判定租约过期、把还在下载中的任务抢走。
   */
  clock: () => number
  /**
   * 落一条失败项。`jobName` / `impact` / `maxAttempts` 由调度器按任务定义补全——
   * 任务体不该有机会给同一个任务写出两种「影响」措辞。
   */
  fail(input: JobFailInput): Promise<void>
}

/** 任务体。返回值原样进 `job_runs.summary`（JSON），所以必须是可序列化的普通对象 */
export type JobRunner = (ctx: JobRunContext) => Promise<unknown>

/**
 * 五个任务体各自需要的东西。**全部是注入的函数，不是 store**：
 * 与 `ArchiveDeps.getMeeting` / `listArchiveRules` 同一个先例——调度这一层
 * 不该够得着它用不到的表，读代码的人也不必去猜某个任务到底会碰什么。
 */
export interface JobBodyDeps {
  /**
   * 任务一：`runFetchRound`——发现 + 入队 + **把队列里的资产下下来**（阶段 4 · T14）。
   * 时间窗由装配处定（见 main 里的 lookback）。
   *
   * **收活时钟**，与任务二同一个理由（见 `JobRunContext.clock`），而且在这里更硬：
   * 执行体领任务时写的 `lease_expires_at = now() + leaseSec`，租约默认 15 分钟，
   * 而一轮下载可以跑得比这久得多。冻结的时间戳会让一轮里后领取的任务拿到一个
   * **开跑那一刻就已经算过期**的租约。
   */
  fetchRound: (now: () => number) => Promise<FetchRound>
  /**
   * 任务一收尾要用：**此刻仍处于放弃状态（dead）的全部资产**——不分轮次。
   *
   * 下载队列自己会重试（失败退避、到 MAX_ATTEMPTS 转 dead），所以逐次失败不必
   * 惊动任何人；但 `dead` 是终态，队列从此不再碰它——那一刻起，这个视频**只有人
   * 才救得回来**。落一条失败项是它在界面上唯一的出口，见下面 `fetch_recordings`。
   * 要全部而不是"本轮新转的"，是因为失败项得跟着资产的状态开与关，见
   * recordDeadAssets 上方的说明。
   */
  deadAssets: () => Promise<readonly DeadAsset[]>
  /** 任务二：`archivePendingMeetings`。收活时钟，理由见 `JobRunContext.clock` */
  archiveRound: (now: () => number) => Promise<ArchiveRoundOutcome>
  /** 任务三：`retention.ts` 的 `executeCleanup`。`confirm: true` 由装配处写死 */
  cleanup: (now: number) => Promise<CleanupExecuted>
  /** 任务四要遍历的采集程序 */
  listPrograms: () => Promise<readonly ServiceProgram[]>
  /** 任务四：`computeProgramInventory`。**写摘要不写缓存**（计划 E-e） */
  inventory: (programId: string, now: number) => Promise<ProgramInventory>
  /**
   * 任务五：`auto-grant.ts` 的 `runAutoGrantRound`（方案 2）。
   *
   * **这是五个任务体里唯一会往授权表写行的那一个**，所以它与任务四刻意分开：
   * 任务四只读（算清单、写摘要），把两件事塞进同一格意味着「刷新一下清单」这个
   * 听起来无害的动作会顺手改变谁能取到什么。
   *
   * 收**冻结的 `ctx.now`** 而不是活时钟：一轮自动授权是秒级的，而 `now` 会同时进
   * 授权行的 `granted_at` 与审计的 `occurred_at`——同一轮里这两个时间戳必须对得上，
   * 不然事后按时间对账时，一场会议的授权行与它的审计记录差着几秒对不上号。
   * 失败项由任务体那边用 `ctx.fail` 落（照 `refresh_inventory` 的做法）。
   */
  autoGrantRound: (now: number) => Promise<AutoGrantRound>
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把本轮新转 dead 的资产落成失败项，**一场会议一条**。
 *
 * ## 为什么必须先按会议合并
 *
 * `job_failures` 的唯一键是 `(job_name, target)`，而 `recordFailure` 是 upsert：
 * 同一个 target 调第二次不是新增一行，是**改写**那一行（reason 被后一次覆盖、
 * attempts +1，见 src/store/jobs.ts 的 recordFailure 与 migrations/008 的第三节）。
 * 一场会议的视频和纪要同一轮双双转 dead 时逐条调用的话，运维看到的是「视频那条
 * 没了、只剩纪要，而且已经失败 2 次」——两个错都不对。所以先合并成一句话。
 *
 * 「一行一个对象」正是那张表的设计：这里的"对象"是会议，不是资产。资产级的细节
 * （哪一类、最后一次错在哪）进 reason 那一句，够运维判断该去查什么。
 *
 * ## 为什么每轮记**全部** dead，而不是只记"本轮新转 dead 的"
 *
 * 因为失败项的开与关都得跟着资产走，而这两个方向只有一条现成的机制：
 * `launch()` 每轮跑完调 `resolveStaleFailures(name, startedAt, …)`，把「这一轮
 * 没再记过」的失败项标成已恢复。归档、清理是"每轮重新判定同一批对象"，还没好
 * 的会再失败一次，那条规则对它们天然成立。`dead` 不是——它是终态，队列不再碰它，
 * 只记一次的话下一轮就被判成"自己好了"，失败项在「需要处理」里只停留一轮。
 *
 * 所以这里每轮把**此刻仍然 dead** 的资产都重记一遍：它还 dead，这一轮就再记一次，
 * `resolveStaleFailures` 就不会关它；哪天运维 `resetFailed` 把它打回队列、它不再
 * 是 dead，就不再被记，下一轮自然关掉。失败项因此是「资产此刻是否 dead」的镜像，
 * 开与关都不需要另写一条路径。
 *
 * 代价是 `attempts` 不能再走 `recordFailure` 默认的累加——那会让它变成轮次计数器，
 * 界面上「N / 5」一天涨 96。所以传绝对值，照抄 `meeting_assets.attempts`（dead 行上
 * 它就是队列的上限），见 recordDeadAssets 里那一行。`last_failed_at` 在这种失败项上的
 * 含义随之变成「截至这一轮仍然没好」，与归档失败项的「这一轮又失败了」略有不同，
 * 但表格里那一列叫「最近失败」，两种读法都对得上。
 *
 * 全量而不是增量的成本：一轮一次 `deadAssets()`，dead 行在健康的库里是个位数；
 * 真的堆到几百条时，那几百条本来就该出现在失败项表里——这正是要它们出现的地方。
 */
async function recordDeadAssets(ctx: JobRunContext, dead: readonly DeadAsset[]): Promise<void> {
  const byMeeting = new Map<string, DeadAsset[]>()
  for (const d of dead) {
    const key = jobFailureTarget(d.meetingId, d.subMeetingId)
    const bucket = byMeeting.get(key)
    if (bucket) bucket.push(d)
    else byMeeting.set(key, [d])
  }
  for (const [target, assets] of byMeeting) {
    const first = assets[0]!
    await ctx.fail({
      target,
      meetingId: first.meetingId,
      subMeetingId: first.subMeetingId,
      // 资产类型与最后一次的错各自带着：只写「3 个资产失败了」的话，运维还得自己
      // 去数据库里翻 last_error 才知道是磁盘满了还是上游 403——那正是这条失败项
      // 想替他省掉的那一步。
      reason:
        '下载重试用尽，已放弃：' +
        assets.map((a) => `${a.assetType}（${a.lastError ?? '无错误信息'}）`).join('；'),
      // 绝对值，照抄资产行：dead 行上 attempts 就是下载队列的上限，与 spec.maxAttempts
      // 相等，界面因此直接显示「已到上限 · 需要人工介入」。**不能走累加**——这个函数
      // 每轮都跑（见上方「为什么每轮记全部 dead」），累加会把它变成轮次计数器。
      // 一场会议几个资产取最大的那个：它们各自都到了上限，取哪个都是同一个数；
      // 万一将来上限按资产类型不同了，取最大保证「已到上限」不会漏报。
      attempts: Math.max(...assets.map((a) => a.attempts)),
    })
  }
}

/**
 * spec §4.8 的五个任务体。
 *
 * 任务四为什么不落缓存表（计划 E-e 已裁定）：开缓存表意味着「控制台显示的可取清单」
 * 与「网关 `AccessGate` 的实时判定」变成**两份真相**，而漂移的方向恰好是 §1.3 要防的
 * 那一件事——控制台说能取、实际取不到，或者反过来。所以它逐程序算一遍，把
 * `fetchable.length` / `blocked.length` 写进 `job_runs.summary`：§4.8 的 sparkline
 * 因此有东西显示，同时是一条巡检（某个程序的 blocked 数突增，在这条记录里看得见），
 * 而清单本身仍由 A2/A3 现算。**先开表才是不可逆的那个方向。**
 */
export function createJobRunners(deps: JobBodyDeps): Record<JobName, JobRunner> {
  return {
    async fetch_recordings(ctx) {
      // 阶段 4 · T14：这一格叫「拉取新录制」，所以它真的要把录制拉下来——
      // 发现 + 入队 + 执行下载队列，一整条。T11 时它只做前两件，队列里的资产
      // 得等运维手动 `bun run worker` 才有人取，而这一格的运行记录一路绿。
      const r = await deps.fetchRound(ctx.clock)
      // 逐次失败**不**落 `job_failures`：下载队列自己会重试——失败按退避（executor
      // 的 `downloadBackoff`：5 / 10 / 20 / 40 分钟）自动重领，到 MAX_ATTEMPTS 才转
      // dead。一次网络抖动不该惊动运维，硬塞进来还会让同一件事有两套重试计数。
      //
      // **转 dead 的那一轮在这里落一条失败项。** `dead` 是终态：队列从此不再领它，
      // 没有任何机制会让它自己好转。不落这一条的话，那个视频的唯一痕迹是
      // `meeting_assets.last_error`——一列没有任何界面读的数据库字段。
      //
      // 这段注释的上一版写的是「到 MAX_ATTEMPTS 才转 dead，下一轮照样被领取」，
      // 并据此认定不必落失败项。那句话当时是假的：`failed` 行三条路都领不到
      // （claim 只看 pending 与过期 running、upsert 不重置 status、resetFailed
      // 零调用方），于是 attempts 永远停在 1，MAX_ATTEMPTS 那道门根本走不到。
      // 现在退避重试是真的了，这条推理才第一次成立——但结论反过来：正因为
      // 「转 dead」现在真的会发生，才更要有人看得见。
      await recordDeadAssets(ctx, await deps.deadAssets())
      // 摘要里必须有下载那几个数：只报「发现了 11 个」的话，一轮全下挂了与一轮
      // 全下成功在运行记录里长得一模一样。`discovered` 这个名字比 `tasks` 说得清
      // ——它数的是本轮发现的就绪资产条数，含已经 completed 的那些。
      return {
        meetings: r.meetings,
        discovered: r.tasks,
        completed: r.completed,
        failed: r.failed,
        skipped: r.skipped,
        probes: r.probes,
        // 清单没写出来不影响资产已经落盘，但它也不该静默——这里是它唯一的留痕处
        // （一次性 worker 那边靠 console 打印，调度器没有那条打印）
        manifests: r.manifests,
      }
    },

    async archive_nas(ctx) {
      // 逐会议的失败项由 `archive.ts` 自己落（它才知道是哪一场、因为什么），
      // 见那个文件里 archivePendingMeetings 的 catch 与 ArchiveDeps.recordFailure。
      // 这里只把一轮的六个数字原样交出去。
      const r = await deps.archiveRound(ctx.clock)
      return {
        newlyArchived: r.newlyArchived,
        verificationFailed: r.verificationFailed,
        failed: r.failed,
        sidecarFailed: r.sidecarFailed,
        skipped: r.skipped,
        undecidable: r.undecidable,
      }
    },

    async cleanup_expired(ctx) {
      const r = await deps.cleanup(ctx.now)
      // 拒删（哈希对不上/读不到）与出错（EACCES、写库炸了）是两层不同的容错，
      // 但对「失败项 · 需要处理」而言都是同一件事：这场会议这一轮没清成，要人看。
      // 原因分别带着各自的话，所以不合并成一个数字。
      for (const f of [...r.verificationFailed, ...r.failed]) {
        await ctx.fail({
          target: jobFailureTarget(f.meetingId, f.subMeetingId),
          meetingId: f.meetingId,
          subMeetingId: f.subMeetingId,
          reason: f.reason,
        })
      }
      return {
        purged: r.purged.length,
        purgedBytes: r.purged.reduce((s, i) => s + i.localBytes, 0),
        verificationFailed: r.verificationFailed.length,
        failed: r.failed.length,
        // 被暂停要如实报。报成「没有可清理的」会让操作员以为清理跑过了
        paused: r.paused,
      }
    },

    async refresh_inventory(ctx) {
      const programs = await deps.listPrograms()
      const rows: Array<{ programId: string; name: string; fetchable: number; blocked: number }> = []
      let fetchable = 0
      let blocked = 0
      let failedPrograms = 0
      for (const p of programs) {
        try {
          const inv = await deps.inventory(p.id, ctx.now)
          rows.push({
            programId: p.id,
            name: p.name,
            fetchable: inv.fetchable.length,
            blocked: inv.blocked.length,
          })
          fetchable += inv.fetchable.length
          blocked += inv.blocked.length
        } catch (err) {
          // 一个程序算不出来不该让整轮 failed：另外几个程序的巡检数据仍然有效，
          // 而把整轮标红会让"这一个程序有问题"变成"清单任务坏了"。
          // 但它必须留痕——这一行进失败项表，不是一句日志。
          failedPrograms++
          await ctx.fail({ target: p.id, targetLabel: p.name, reason: errText(err) })
        }
      }
      return { programs: rows, fetchable, blocked, failedPrograms }
    },

    async auto_grant(ctx) {
      // 判定、候选枚举、逐场写授权与审计全在 `auto-grant.ts` 里。这一格只做两件事：
      // 把「某个程序整个算不出来」逐条落成失败项，再把摘要**显式拼出来**。
      const r = await deps.autoGrantRound(ctx.now)
      // 一个程序算不出来不该让整轮 failed（另外几个程序写出去的授权仍然有效），
      // 但必须留痕——与任务四同一条处理，只是那边在循环里落、这边收完再落
      for (const f of r.failures) {
        await ctx.fail({ target: f.programId, targetLabel: f.name, reason: f.reason })
      }
      // **不 `return r`**：`failures` 是给上面那个循环用的料，不属于摘要。
      // 原样丢进 job_runs.summary 会让每一轮的运行记录里多出一份与失败项表重复的
      // 错误全文，而 sparkline 那一列本来只该是几个数
      return {
        programs: r.programs,
        granted: r.granted,
        skippedRevoked: r.skippedRevoked,
        failedPrograms: r.failedPrograms,
      }
    },
  }
}

// ── 调度器 ────────────────────────────────────────────────────

export interface SchedulerConfig {
  jobs: JobsStore
  runners: Record<JobName, JobRunner>
  /** unix 秒 */
  now: () => number
  /**
   * 本地时间相对 UTC 的偏移（秒），东八区 = 28800。**只影响「每天 03:00」**——
   * 那个 03:00 指的是运维眼里的凌晨三点。缺省 0（UTC，与审计时间戳同口径）；
   * 国内部署应当显式配 28800，否则清理会跑在北京时间上午 11 点的业务高峰上。
   */
  tzOffsetSec?: number
  tickIntervalMs?: number
  log?: (msg: string) => void
}

export interface TickOutcome {
  /** 本 tick 到点并起了一轮的任务 */
  started: JobName[]
  /** 到点了但上一轮还在跑，本轮不起（每个都在 job_runs 里留了一行 skipped） */
  skipped: JobName[]
  /** 认领了队里排着的一行（手动触发或接续）并起了一轮的任务 */
  claimed: JobName[]
}

export interface Scheduler {
  /**
   * 启动期。做两件事，缺一不可：
   *   1. 把上一个进程残留的 running 行标成 interrupted（验收判据 3 的「看得出断了」）
   *   2. 把每个任务「上次触发的片」钉在**此刻**这一片（验收判据 3 的「不补跑」）
   */
  bootstrap(): Promise<void>
  /** 跑一个 tick。**不等任务体跑完**——一轮归档可以跑几十分钟 */
  tick(): Promise<TickOutcome>
  /** 等当前在跑的任务体全部结束。`stop()` 与测试用 */
  drain(): Promise<void>
  /** 此刻正在跑的任务名。重叠保护的可观测面 */
  runningJobs(): JobName[]
  start(): void
  stop(): Promise<void>
}

/**
 * 接续：`after` 的一轮**成功**结束、且 `when(summary)` 为真时，把 `run` 排进队列
 * （`trigger_kind='chained'`），由下一个 tick 认领起跑。整点那一片照常跑，是兜底，
 * 不是替代。见文件头「接续」。
 */
interface JobChain {
  after: JobName
  run: JobName
  when: (summary: unknown) => boolean
  /** 日志里给人看的一句理由 */
  why: (summary: unknown) => string
}

export const JOB_CHAINS: readonly JobChain[] = [
  {
    after: 'fetch_recordings',
    run: 'archive_nas',
    when: (s) => completedOf(s) > 0,
    why: (s) => `这一轮有 ${completedOf(s)} 个资产下载完成，不等整点`,
  },
  // 自动授权（方案 2）接在**两条**产出新会议的路上，理由与上面那条同源：
  // 一场刚拉下来的会议要等最多 5 分钟才被授权出去，而对接方那边看到的是
  // 「新会议没进来」。两条都要，因为「本地文件还在」这个候选判据有两个来源
  // （还没归档但资产下完了 / 已经归档了），少接一条就有一批会议只能等兜底那一片。
  {
    after: 'fetch_recordings',
    run: 'auto_grant',
    when: (s) => completedOf(s) > 0,
    why: (s) => `这一轮有 ${completedOf(s)} 个资产下载完成，顺手把该授权的授权出去`,
  },
  {
    after: 'archive_nas',
    run: 'auto_grant',
    when: (s) => newlyArchivedOf(s) > 0,
    why: (s) => `这一轮新归档了 ${newlyArchivedOf(s)} 场会议，顺手把该授权的授权出去`,
  },
]

/**
 * 安全地从一轮的摘要里取 `completed`。
 *
 * 摘要是任务体的返回值，类型上是 `unknown`——这里宁可判成 0（不接续、等整点兜底）
 * 也不能因为它形状不对就抛出：抛出会顺着 `launch` 的外层 catch 把**上游**那一轮
 * 记成 failed。
 */
function completedOf(s: unknown): number {
  return numberField(s, 'completed')
}

/**
 * 同上，取归档轮的 `newlyArchived`（键名照 `archive_nas` 运行体的 return）。
 *
 * 另写一个取数函数而不是给 `completedOf` 加一个参数：这两个键各自钉着一个具体的
 * 任务体的返回形状，取错了的表现是**接续静默不触发**（判成 0 就是不接），
 * 而那种失效只有在有人盯着运行记录数轮次时才看得出来。
 */
function newlyArchivedOf(s: unknown): number {
  return numberField(s, 'newlyArchived')
}

/** 摘要里取一个数字字段。取不到判成 0，理由见 `completedOf` */
function numberField(s: unknown, key: string): number {
  if (typeof s !== 'object' || s === null) return 0
  const v = (s as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function createScheduler(cfg: SchedulerConfig): Scheduler {
  const tz = cfg.tzOffsetSec ?? 0
  const log = cfg.log ?? ((m: string) => console.log(m))
  /** 任务 → 上次触发的时间片 */
  const lastSlot = new Map<JobName, number>()
  /** 重叠保护的锁。**内存标志，不查库**，理由见文件头 */
  const running = new Set<JobName>()
  /** 正在跑的那一轮在 job_runs 里的行 id，给 skipped 行指路用 */
  const currentRunId = new Map<JobName, number>()
  const inFlight = new Map<JobName, Promise<void>>()
  let timer: ReturnType<typeof setInterval> | null = null

  /**
   * `after` 的一轮成功收尾之后，按 `JOB_CHAINS` 决定要不要**排**一轮别的。
   *
   * 只写一行 queued 就完事：起任务是 `tick()` 的活，这里不碰 `running` 也不碰
   * `launch`。下游此刻正忙也不用管——那一行留在队里，`tick` 本来就只在它不忙时
   * 才认领，同时排进来的几行还会被 `coalesceRuns` 合成一轮。见文件头「接续」。
   *
   * **不抛**：每条链各自 try/catch，排不进去只记一行日志。让它冒出去的话，
   * `launch` 的外层 catch 会把**上游**那一轮记成 failed，而上游明明成功了。
   */
  async function chainAfter(after: JobName, summary: unknown): Promise<void> {
    for (const chain of JOB_CHAINS) {
      if (chain.after !== after) continue
      const run = chain.run
      try {
        if (!chain.when(summary)) continue
        await cfg.jobs.enqueueChainedRun({ jobName: run, now: cfg.now() })
        log(`scheduler: ${chain.why(summary)}，已把 ${run} 排进队列（chained），下一个 tick 起`)
      } catch (err) {
        log(`scheduler: ${after} 跑完想接着排一轮 ${run}，但没排进去：${errText(err)}`)
      }
    }
  }

  function launch(spec: JobSpec, trigger: JobTrigger, runId: number, startedAt: number): void {
    const name = spec.name
    // 先占坑再起协程：`await` 至少让出一个微任务，若等任务体开跑之后再占坑，
    // 同一个 tick 里紧随其后的判断会看到一个空的 running 集合。
    running.add(name)
    currentRunId.set(name, runId)

    const ctx: JobRunContext = {
      runId,
      jobName: name,
      spec,
      trigger,
      now: startedAt,
      clock: cfg.now,
      fail: (input) =>
        cfg.jobs.recordFailure({
          jobName: name,
          target: input.target,
          targetLabel: input.targetLabel ?? '',
          meetingId: input.meetingId ?? null,
          subMeetingId: input.subMeetingId ?? '',
          reason: input.reason,
          attempts: input.attempts,
          impact: spec.impact,
          maxAttempts: spec.maxAttempts,
          now: cfg.now(),
        }),
    }

    const done = (async () => {
      try {
        const summary = await cfg.runners[name](ctx)
        await cfg.jobs.finishRun(runId, { status: 'succeeded', summary, now: cfg.now() })
        // 轮次**跑完了**才 resolve：跑一半抛出的话，后半截的对象根本没被处理过，
        // 它们"这轮没失败"只是因为没轮到。`startedAt` 是分界线——本轮里真的又失败
        // 过一次的对象，`last_failed_at` 一定 >= 它。
        const resolved = await cfg.jobs.resolveStaleFailures(name, startedAt, cfg.now())
        if (resolved > 0) log(`scheduler: ${name} 有 ${resolved} 个失败项这一轮没再失败，已标为已恢复`)
        // 记账都干净了才接续：接续的前提是"这一轮**成功**结束"。chainAfter 只往
        // job_runs 排一行 queued（起它是下一个 tick 的活），而且自己不抛，
        // 所以它既不会把这一轮拖进下面的 catch，也不会与 tick 抢着起任务。
        // 见文件头「接续」。
        await chainAfter(name, summary)
      } catch (err) {
        const text = errText(err)
        log(`scheduler: ${name} 整轮失败：${text}`)
        // 顺序是"先记账、再落失败项"，两件事都要做完才算处理干净。
        // 记账本身再抛出就没救了，只能让它冒到 tick 的 catch 里去——
        // 那时数据库已经不可用，任何补救动作也一样写不进去。
        await cfg.jobs.finishRun(runId, { status: 'failed', error: text, now: cfg.now() })
        await cfg.jobs.recordFailure({
          jobName: name,
          target: ROUND_FAILURE_TARGET,
          targetLabel: spec.label,
          meetingId: null,
          subMeetingId: '',
          reason: text,
          impact: spec.impact,
          maxAttempts: spec.maxAttempts,
          now: cfg.now(),
        })
      } finally {
        running.delete(name)
        currentRunId.delete(name)
        inFlight.delete(name)
      }
    })()

    // 收尾自己再抛出（数据库挂了）时不能变成未处理的 Promise 拒绝——那会在
    // Bun/Node 上直接把进程带走，而调度器进程死掉意味着五个任务全停。
    inFlight.set(
      name,
      done.catch((err: unknown) => {
        log(`scheduler: ${name} 的收尾记账失败：${errText(err)}`)
      }),
    )
  }

  async function tick(): Promise<TickOutcome> {
    const now = cfg.now()
    const out: TickOutcome = { started: [], skipped: [], claimed: [] }

    for (const spec of JOB_CATALOG) {
      const name = spec.name

      // ① 排队中的触发优先于定时。一个人明确按下的按钮比一个到点的闹钟更该被执行，
      //    而且两者在同一个 tick 里撞上时只该跑一次（下面顺手把这一片标成已触发）。
      //    队里除了手动触发还有接续排进来的那些（trigger 'chained'，见文件头），
      //    两者在这里走的是同一条路——**这是全文件唯一起任务的地方**。
      if (!running.has(name)) {
        const claimed = await cfg.jobs.claimQueued(name, now)
        const primary = claimed[0]
        if (primary !== undefined) {
          // 连按三次是常事，接续在下游忙的时候连排几行也是。合并成一轮，另外几行
          // 标明合并去向——直接跑三轮意味着三次完整的归档，而管理员（或接续）
          // 想要的只是"现在就跑一次"。
          if (claimed.length > 1) {
            await cfg.jobs.coalesceRuns(
              claimed.slice(1).map((c) => c.id),
              primary.id,
              now,
            )
          }
          lastSlot.set(name, slotOf(spec.schedule, now, tz))
          // trigger 照那一行原样传，不硬写 'manual'：任务体拿到的 `ctx.trigger`
          // 要跟 job_runs 里那一行说的是同一件事
          launch(spec, primary.trigger, primary.id, now)
          out.claimed.push(name)
          continue
        }
      }
      // 任务正在跑时**不认领**队里的行：认领了就得当场跑（重叠保护不让跑），
      // 于是只能把它标成 skipped——那等于把管理员按过的那次触发悄悄吞掉。
      // 留在队里，下一个 tick 再说。

      // ② 到点没有
      const slot = slotOf(spec.schedule, now, tz)
      if (lastSlot.get(name) === slot) continue
      lastSlot.set(name, slot)

      if (running.has(name)) {
        // 重叠保护。留一行 skipped 而不是什么都不做，理由见文件头
        await cfg.jobs.recordSkip({
          jobName: name,
          now,
          blockedByRunId: currentRunId.get(name) ?? null,
        })
        log(`scheduler: ${name} 到点了，但上一轮还在跑，本轮跳过`)
        out.skipped.push(name)
        continue
      }

      const runId = await cfg.jobs.startRun({ jobName: name, trigger: 'schedule', now })
      launch(spec, 'schedule', runId, now)
      out.started.push(name)
    }

    return out
  }

  return {
    async bootstrap() {
      const now = cfg.now()
      const n = await cfg.jobs.markInterrupted(now)
      if (n > 0) {
        log(
          `scheduler: 上一个进程留下 ${n} 次没跑完的运行，已标为 interrupted。` +
            '错过的轮次**不补跑**——补跑一次错过的到期清理意味着在上班时间执行一批不可逆删除',
        )
      }
      for (const spec of JOB_CATALOG) lastSlot.set(spec.name, slotOf(spec.schedule, now, tz))
    },

    tick,

    async drain() {
      // 循环而不是一次 Promise.all：任务体的收尾里还有几次 await，
      // 期间理论上可以有新的任务被起（测试里连着调 tick 就是这样）。
      while (inFlight.size > 0) {
        await Promise.all([...inFlight.values()])
      }
    },

    runningJobs() {
      return [...running]
    },

    start() {
      if (timer !== null) return
      timer = setInterval(() => {
        // tick 自己抛出（数据库连不上）时**不许让进程死掉**：调度器进程一死，
        // 五个任务全停，而数据库通常几秒后就回来了。记一行，下一个 tick 重试。
        void tick().catch((err: unknown) => {
          log(`scheduler: tick 失败：${errText(err)}`)
        })
      }, cfg.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS)
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      // 在跑的一轮不中断，等它自己跑完：归档搬到一半被砍掉会留下半个文件，
      // 清理删到一半会让 local_purged_at 与实际文件状态对不上。
      await this.drain()
    },
  }
}

// ---------------------------------------------------------------------------
// 进程入口
//
// **这里是调度器的家，`src/index.ts` 不是。** 网关是多实例的，理由见文件头那个方框。
// 也不并进 `src/worker/index.ts`：那个进程是**一次性**的（跑一轮、打印计数、按退出码
// 告诉 cron/systemd 结果如何），而调度器是常驻的。把一个常驻循环塞进一个以退出码
// 说话的进程里，只会让 `--from/--to` 那套参数和「跑完就退」的语义一起失效。
//
// 两个进程分工：
//   bun run worker      一次性补跑（`--from/--to` 指定时间窗），运维手动用
//   bun run scheduler   常驻，spec §4.8 的五个任务
//
// **下载执行体（runExecutor）在任务一里**（阶段 4 · T14）。任务一 = discover + 入队
// + 执行下载队列，共用 `./index.ts` 的 `runFetchRound`，与 `bun run worker` 同一条
// 代码路径。T11 时它只做前两件，于是「跑了 scheduler」= 资产一直排在队列里没人取，
// 而四个任务的运行记录一路全绿——正是本项目最怕的那种失效形态。
//
// 裁定的依据是**这一格的名字**：spec §4.8 那张表里任务一叫「拉取新录制」，
// 管理员的心智模型跟着名字走，界面上写着「拉取新录制」的那一格他不会读成
// 「只是登记一下」。所以补的是任务一的内容，**不新开第五个任务格**——
// 界面上仍然是四格（spec §4.8 逐字）。`JOB_CATALOG` 里那句 `what` 因此跟着改成
// 「发现新录制、入队并下载」：名字对了而描述还说只入队，等于把同一处不一致留在
// 更靠近用户的地方。
//
// **归档仍然只有任务二一个入口**：`runFetchRound` 刻意不含归档段（`runWorkerOnce`
// 才是"拉一轮 + 归一轮"）。两个任务体各起各的归档轮意味着两轮同时往同一个 NAS
// 目录搬同一批文件，与文件头那个方框拦的是同一类事故。
//
// 一个后果要记在这里：**任务一的单轮时长从秒级变成了可能几十分钟**（一个 2GB 的
// 录制就够了），而它每 15 分钟到点一次。重叠保护（内存标志 + 一行 skipped）对此
// 仍然成立——它拦的就是"上一轮没跑完"，与那一轮跑多久无关，跳过的每一片都在
// `job_runs` 里留一行指向挡住它的那次运行。真正需要跟着改的是**时钟**：任务体
// 必须收 `ctx.clock`（活时钟）而不是 `ctx.now`（冻结在开跑时刻），否则一轮里后
// 领取的任务会拿到一个开跑那刻就已算过期的租约，被手动补跑的 worker 抢走。
// ---------------------------------------------------------------------------

/**
 * 任务一往回看多久。
 *
 * 每 15 分钟跑一次，只为了发现「刚结束的会议」，所以窗口不需要大——大窗口意味着
 * 每一轮都对同一批老会议重新 `listAssets`，而那是有配额的腾讯接口调用。
 * 默认 24 小时留的是余量：短暂停机（重启、部署）之后恢复的第一轮仍能把停机期间
 * 结束的会议捞回来。
 *
 * **它不负责补跑长时间停机**：停了三天就用 `bun run worker --from … --to …` 手动补。
 * 让定时任务自己往回看三天，等于每 15 分钟重扫一次三天的会议。
 *
 * 默认值 `DEFAULT_FETCH_LOOKBACK_HOURS` 与解析函数 `schedulerFetchLookbackHours`
 * **不在本文件**，挪去了 `store/jobs.ts`：控制台「定时任务」页的连续失败横幅要
 * 告诉管理员同一个数字（超过多少小时需要人工补拉），而网关进程不许 import 本文件
 * （见 `src/http/handlers/console/jobs.ts` 文件头）。`envInt` 同理搬了过去，好让
 * 两边解析同一个环境变量时走的是同一条规则，不是两份各改各的实现。
 */

/** 归档任务的定义。落失败项时要它的「影响」与阈值，取一次即可 */
const ARCHIVE_SPEC = JOB_CATALOG.find((j) => j.name === 'archive_nas')!

/**
 * 任务一同时下几个资产。**比一次性 worker 的默认值（4）低**，理由是池要分给五个任务。
 *
 * 一次性 worker 独占那个连接池，10 条连接全归它一轮用；调度器不是——五个任务体在
 * 同一个进程、同一个池上并发跑，任务一压着 `2 × 并发度` 条（claimNext 的事务连接 +
 * 同一执行体在途的那条 touchProgress，见 `poolQueueLimitFor`），另外三个任务各自
 * 还要一条。取 2 时稳态峰值 = 2 × 2 + 3 = 7 ≤ 10，留得下余量；取 4 就是 8 + 3 = 11，
 * 已经越过池上限，于是归档/清理/清单三个任务会开始排队等连接——而 mysql2 没有取
 * 连接超时，排上队就是无限期地等。
 */
const DEFAULT_SCHEDULER_FETCH_CONCURRENCY = 2

/**
 * 调度器侧的并发度硬上限：`2 × 并发度 + (任务数 - 1) ≤ 池上限`，即并发度 ≤ 3。
 *
 * 与一次性 worker 的 `assertConcurrencyFitsPool`（并发度 ≤ 5）是同一件事的两个场景，
 * 差在那三条留给其它任务的连接。两道闸门都过：先过 worker 那条（它讲的是 executor
 * 自己的稳态需求），再过这一条。
 */
export function assertSchedulerFetchConcurrencyFitsPool(concurrency: number): void {
  assertConcurrencyFitsPool(concurrency)
  const others = JOB_CATALOG.length - 1
  if (concurrency * 2 + others > POOL_CONNECTION_LIMIT) {
    throw new Error(
      `MDE_SCHEDULER_FETCH_CONCURRENCY ${concurrency} needs up to ${concurrency * 2} pooled ` +
        `connections, and the other ${others} jobs share the same pool of ${POOL_CONNECTION_LIMIT}`,
    )
  }
}

async function main(): Promise<number> {
  // 与网关、一次性 worker 共用同一份 loadConfig 与同一个 .env——三个进程同机部署，
  // 共享腾讯凭据、DATABASE_URL 与 STS_ENC_KEY。
  const config = loadConfig(process.env)
  const archiveRoot = await assertArchiveRootUsable(process.env.MDE_ARCHIVE_ROOT)
  const nasRoot = process.env.MDE_NAS_ROOT
  if (nasRoot === undefined || nasRoot === '') {
    throw new Error('missing required config: MDE_NAS_ROOT')
  }
  const tickSec = envInt(process.env, 'MDE_SCHEDULER_TICK_SEC', DEFAULT_TICK_INTERVAL_MS / 1000)
  // 小时数的解析挪到了 store/jobs.ts（`schedulerFetchLookbackHours`）——
  // 控制台要下发同一个数字，见该函数与 DEFAULT_FETCH_LOOKBACK_HOURS 旁边的注释。
  const lookbackSec = schedulerFetchLookbackHours(process.env) * 3600
  const tzOffsetSec = schedulerTzOffsetSec(process.env)
  const fetchConcurrency = envInt(
    process.env,
    'MDE_SCHEDULER_FETCH_CONCURRENCY',
    DEFAULT_SCHEDULER_FETCH_CONCURRENCY,
  )
  assertSchedulerFetchConcurrencyFitsPool(fetchConcurrency)

  const now = (): number => Math.floor(Date.now() / 1000)

  // 池收紧 queueLimit，理由与一次性 worker 完全相同（见 `poolQueueLimitFor` 的注释）：
  // T14 之后**任务一里跑着 executor**，而 executor 的进度回写是 fire-and-forget，
  // 在途数量无界（一个 2GB 的录制能排出 ~250 个等待者）。写库一慢它们就一条接一条
  // 堆进队列，堆到内存里去。
  //
  // 比 worker 那边多留 `任务数 - 1` 个名额：另外三个任务体在同一个池上跑，它们的
  // 库调用都是被 await 的，撞上一次抖动时该让它们排一下队，而不是把「归档轮」
  // 整轮打成失败。（队列**满了**时 mysql2 对所有调用方一律拒绝，不区分是谁。）
  const pool = createPool(config.databaseUrl, {
    queueLimit: poolQueueLimitFor(fetchConcurrency) + (JOB_CATALOG.length - 1),
  })
  try {
    await runMigrations(pool)

    const store = createMysqlStore(pool)
    const archives = createArchivesStore(pool)
    const policy = createPolicyStore(pool)
    const grants = createGrantsStore(pool)
    const programs = createProgramsStore(pool)
    const contents = createContentsStore(pool)
    const jobs = createJobsStore(pool)
    const consoleMeetings = createConsoleMeetingsStore(pool, { policy })

    const tencentClient = createTencentClient(config.tencent, {
      fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // 毫秒时钟：项目通用的 now() 是秒级，喂给令牌桶会让补充速率慢 1000 倍
      nowMs: Date.now,
    })
    // 与一次性 worker 完全同一个理由：meeting_cache 是「发现一场会议之后凭
    // meetingId 反查完整 Meeting」的唯一低成本路径，缺了它每场会议都要枚举一次
    // 整窗口，撞死 `/v1/corp/records` 的 10次/min 配额（见 tencent/records.ts）。
    const meetingsCache = createMeetingCacheStore(pool)
    const recordsApi = createRecordsApi(tencentClient, config.tencent.operatorId, meetingsCache)
    const addressesApi = createAddressesApi(tencentClient, config.tencent.operatorId)
    const tokenCipher = createTokenCipher(config.stsEncKey)
    // STS-Token 的**续期是网关的活**（平台异步回调，落点是网关的 webhook 路由）。
    // 这里只读同一张表里当前有效的那一枚，与一次性 worker 完全一致。
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

    const archiveDeps: ArchiveDeps = {
      archives,
      localRoot: archiveRoot,
      nasRoot,
      getMeeting: (meetingId, subMeetingId) => store.getMeeting(meetingId, subMeetingId),
      listArchiveRules: () => policy.listEnabledStackRules('archive'),
      listArchiveOverrides: (keys) => grants.listActiveOverridesForMeetings(keys),
      // T4 留下的那个 `?` 在这里接上：文本类纪要的正文随归档入库，
      // 到期清理删掉本地文件之后预览页仍然读得到（spec §4.9 / 计划 E-f）。
      contents,
      // T11 的落库口。**「影响」那句话不在这里**——它属于任务定义（JOB_CATALOG），
      // 由装配处补齐，归档流水线不认识「任务」这个词汇。
      recordFailure: ({ meetingId, subMeetingId, reason }) =>
        jobs.recordFailure({
          jobName: ARCHIVE_SPEC.name,
          target: jobFailureTarget(meetingId, subMeetingId),
          // 会议标题在这里拿不到（归档流水线只给键），留空由界面按 meetingId 反查
          targetLabel: '',
          meetingId,
          subMeetingId,
          reason,
          impact: ARCHIVE_SPEC.impact,
          maxAttempts: ARCHIVE_SPEC.maxAttempts,
          now: now(),
        }),
    }

    const visibility: VisibilityDeps = {
      policy,
      grants,
      archives,
      getMeetings: consoleMeetings.getMeetings,
    }

    /**
     * 任务五（方案 2）。**审计 store 在这里才第一次出现在调度器进程里**：
     * 之前四个任务一条审计都不写（它们都是系统内部动作，痕迹在 `job_runs` 里），
     * 而自动授权写的是**真的授权行**——那属于 spec §1.4 要求留痕的那一类，
     * 而且是唯一一批「没有任何人点过」的授权，事后能不能说清全靠这条审计。
     *
     * 会议元数据与清单重算共用 `consoleMeetings.getMeetings`：两处对「查不到的
     * 会议不要造空壳」这条约定的要求逐字相同，各接一个实现早晚会有一处偷懒填空壳。
     */
    const autoGrant: AutoGrantDeps = {
      programs,
      policy,
      grants,
      archives,
      getMeetings: consoleMeetings.getMeetings,
      audit: createAuditStore(pool),
    }

    /**
     * 任务一的一轮。**与 `bun run worker` 同一个 `runFetchRound`**（阶段 4 · T14）——
     * 发现走拉取规则栈（T12 / A7）、执行体的并发与租约、清单收尾全在那一份里，
     * 这边不另写一套下载循环。两个宿主的行为分叉过一次就再也对不齐了。
     *
     * 注意这里**没有 archiveDeps**：归档是任务二自己那一格，见文件末尾进程入口那段。
     */
    const fetchDeps: FetchRoundDeps = {
      store,
      source,
      storage: createLocalStorage(archiveRoot),
      concurrency: fetchConcurrency,
      leaseSec: DEFAULT_LEASE_SEC,
      archives,
      policy,
      grants,
    }

    const scheduler = createScheduler({
      jobs,
      now,
      tzOffsetSec,
      tickIntervalMs: tickSec * 1000,
      runners: createJobRunners({
        // 发现走**拉取规则栈**（阶段 4 · T12 / A7）。计划把 T12 的落点只写成
        // `src/worker/index.ts`，那是写计划时的现实——本文件是 T11 之后才有的
        // 第二个 discovery 触发源，而且是**生产上真正每 15 分钟跑的那一个**。
        // 只接一次性 worker 那条，等于 A7 在生产环境里依旧没接上，所以两处一起接，
        // 判定逻辑共用 `./fetch-policy.ts` 一份。
        fetchRound: (clock) => {
          // 窗口在**本轮开跑那一刻**定一次就不再动：`clock` 是活时钟（租约要用），
          // 拿它现算 from/to 会让"往回看 24 小时"随下载耗时一起漂。
          const at = clock()
          return runFetchRound(
            fetchDeps,
            // 滚动时间窗。**不带 --code / --meeting-id**：那两种选择器是人工补跑用的
            { kind: 'range', from: at - lookbackSec, to: at } satisfies MeetingSelector,
            [...DEFAULT_ASSET_KEYS],
            clock,
          )
        },
        // 任务一收尾的失败项口。`since` 由任务体传本轮开跑时刻，见 recordDeadAssets
        deadAssets: () => store.deadAssets(),
        archiveRound: (clock) => archivePendingMeetings(archiveDeps, clock),
        // confirm 的字面量 true 写死在这里，不由任务体拼——executeCleanup 逼着
        // 每一个调用点写明白「这次是真删」，那道栅栏就该落在装配处这一层
        cleanup: (at) => executeCleanup({ archives, localRoot: archiveRoot }, at, true),
        listPrograms: () => programs.list(),
        inventory: (programId, at) => computeProgramInventory(visibility, { programId, now: at }),
        // 冻结的 `ctx.now`，不是活时钟：同一轮里授权行的 granted_at 与审计的
        // occurred_at 必须是同一个数，否则事后按时间对账时两者对不上号
        autoGrantRound: (at) => runAutoGrantRound(autoGrant, at),
      }),
    })

    await scheduler.bootstrap()
    scheduler.start()
    console.log(
      `scheduler started: tick=${tickSec}s tz=${tzOffsetSec}s lookback=${lookbackSec}s ` +
        `fetchConcurrency=${fetchConcurrency} lease=${DEFAULT_LEASE_SEC}s ` +
        `jobs=${JOB_CATALOG.map((j) => j.name).join(',')}`,
    )

    // 收到信号先停闹钟、再等在跑的那一轮自己跑完。**不中断在跑的任务**：
    // 归档搬到一半被砍掉会在 NAS 上留下半个文件，清理删到一半会让 local_purged_at
    // 与实际文件状态对不上。跑完之前进程不退，由编排层的超时决定要不要强杀。
    await new Promise<void>((resolve) => {
      const shutdown = (sig: string): void => {
        console.log(`scheduler: 收到 ${sig}，停止调度，等在跑的任务收尾`)
        void scheduler.stop().then(() => {
          // 这一行是给「进程为什么还不退」留的分界线：有它，卡的是下面的关池；
          // 没它，卡的是还没跑完的任务体（那是上面注释里说的、故意不砍的等待）。
          console.log('scheduler: 在跑的任务已全部收尾，关连接池')
          resolve()
        })
      }
      process.once('SIGINT', () => shutdown('SIGINT'))
      process.once('SIGTERM', () => shutdown('SIGTERM'))
    })
    return 0
  } finally {
    // 关池超时就放弃（见 closePool）：这一步只是客气地道别，不值得把
    // 「进程能不能退出」押在它身上。
    await closePool(pool, { log: (msg) => console.warn(`scheduler: ${msg}`) })
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('scheduler failed to start', err)
      process.exit(1)
    })
}
