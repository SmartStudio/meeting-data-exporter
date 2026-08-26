/**
 * 定时任务调度器（阶段 4 · T11，A4）—— spec.md §4.8 的四个任务。
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ **调度器只属于 worker 侧，绝不许装进 `src/index.ts` 的网关进程。**        ║
 * ║                                                                          ║
 * ║ 网关是**多实例**的（同一份镜像跑 N 份，前面挂负载均衡）。把调度器塞进去， ║
 * ║ 四个任务就会各跑 N 份：归档流水线 N 个实例同时往同一个 NAS 目录搬同一批   ║
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
 */
import { DEFAULT_ASSET_KEYS, discover, type MeetingSelector } from '@yaowu/mde-engine'
import {
  JOB_CATALOG,
  createJobsStore,
  jobFailureTarget,
  schedulerTzOffsetSec,
  slotOf,
  type JobName,
  type JobSpec,
  type JobTrigger,
  type JobsStore,
} from '../store/jobs'
import { loadConfig } from '../config'
import { createPool, runMigrations } from '../store/db'
import { createArchivesStore } from '../store/archives'
import { createPolicyStore } from '../store/policy'
import { createGrantsStore } from '../store/grants'
import { createProgramsStore } from '../store/programs'
import { createContentsStore } from '../store/contents'
import { createConsoleMeetingsStore } from '../store/console-meetings'
import { createStsStore } from '../store/sts'
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
import { createInProcSource } from './source-inproc'
import { createMysqlStore } from './store-mysql'
import { assertArchiveRootUsable } from './index'
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
 * 四个任务体各自需要的东西。**全部是注入的函数，不是 store**：
 * 与 `ArchiveDeps.getMeeting` / `listArchiveRules` 同一个先例——调度这一层
 * 不该够得着它用不到的表，读代码的人也不必去猜某个任务到底会碰什么。
 */
export interface JobBodyDeps {
  /** 任务一：发现新录制并入队。时间窗由装配处定（见 main 里的 lookback） */
  discoverRecordings: (now: number) => Promise<{ meetings: number; tasks: number }>
  /** 任务二：`archivePendingMeetings`。收活时钟，理由见 `JobRunContext.clock` */
  archiveRound: (now: () => number) => Promise<ArchiveRoundOutcome>
  /** 任务三：`retention.ts` 的 `executeCleanup`。`confirm: true` 由装配处写死 */
  cleanup: (now: number) => Promise<CleanupExecuted>
  /** 任务四要遍历的采集程序 */
  listPrograms: () => Promise<readonly ServiceProgram[]>
  /** 任务四：`computeProgramInventory`。**写摘要不写缓存**（计划 E-e） */
  inventory: (programId: string, now: number) => Promise<ProgramInventory>
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * spec §4.8 的四个任务体。
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
      const r = await deps.discoverRecordings(ctx.now)
      return { meetings: r.meetings, tasks: r.tasks }
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
  /** 认领了排队中的手动触发并起了一轮的任务 */
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
    // Bun/Node 上直接把进程带走，而调度器进程死掉意味着四个任务全停。
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

      // ① 手动触发优先于定时。一个人明确按下的按钮比一个到点的闹钟更该被执行，
      //    而且两者在同一个 tick 里撞上时只该跑一次（下面顺手把这一片标成已触发）。
      if (!running.has(name)) {
        const ids = await cfg.jobs.claimQueued(name, now)
        const primary = ids[0]
        if (primary !== undefined) {
          // 连按三次是常事。合并成一轮，另外两行标明合并去向——直接跑三轮
          // 意味着三次完整的归档，而管理员想要的只是"现在就跑一次"。
          if (ids.length > 1) await cfg.jobs.coalesceRuns(ids.slice(1), primary, now)
          lastSlot.set(name, slotOf(spec.schedule, now, tz))
          launch(spec, 'manual', primary, now)
          out.claimed.push(name)
          continue
        }
      }
      // 任务正在跑时**不认领**排队中的手动触发：认领了就得当场跑（重叠保护不让跑），
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
        // 四个任务全停，而数据库通常几秒后就回来了。记一行，下一个 tick 重试。
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
//   bun run scheduler   常驻，spec §4.8 的四个任务
//
// **下载执行体（runExecutor）不在这四个任务里**，这是 spec §4.8 本身的形状：
// 任务一只负责 discover + 入队。真正把队列里的资产下下来仍然是 `bun run worker`
// 的活。写在这里免得有人以为「跑了 scheduler 就什么都有了」——那会让资产一直排在
// 队列里没人取，而四个任务的运行记录全是绿的。
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
 */
const DEFAULT_FETCH_LOOKBACK_HOURS = 24

function envInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  // 空串必须与未设置等价：.env.example 里可选项写作 `X=`，Bun 把它读成空串，
  // 而 `Number('')` 是 0——一个 0 秒的 tick 间隔会把 CPU 烧满
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got: ${raw}`)
  }
  return n
}

/** 归档任务的定义。落失败项时要它的「影响」与阈值，取一次即可 */
const ARCHIVE_SPEC = JOB_CATALOG.find((j) => j.name === 'archive_nas')!

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
  const lookbackSec =
    envInt(process.env, 'MDE_SCHEDULER_FETCH_LOOKBACK_HOURS', DEFAULT_FETCH_LOOKBACK_HOURS) * 3600
  const tzOffsetSec = schedulerTzOffsetSec(process.env)

  const now = (): number => Math.floor(Date.now() / 1000)

  // 池不设 queueLimit（跟随网关的默认）：一次性 worker 那边收紧它是为了兜住
  // executor 里 fire-and-forget 的 touchProgress 无界堆积，而调度器**不跑 executor**，
  // 它的每一次库调用都被 await 着，稳态等待者是 0。
  const pool = createPool(config.databaseUrl)
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
    const recordsApi = createRecordsApi(tencentClient, config.tencent.operatorId)
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

    const scheduler = createScheduler({
      jobs,
      now,
      tzOffsetSec,
      tickIntervalMs: tickSec * 1000,
      runners: createJobRunners({
        discoverRecordings: (at) =>
          discover(
            { gw: source, store },
            // 滚动时间窗。**不带 --code / --meeting-id**：那两种选择器是人工补跑用的
            { kind: 'range', from: at - lookbackSec, to: at } satisfies MeetingSelector,
            DEFAULT_ASSET_KEYS,
            at,
          ),
        archiveRound: (clock) => archivePendingMeetings(archiveDeps, clock),
        // confirm 的字面量 true 写死在这里，不由任务体拼——executeCleanup 逼着
        // 每一个调用点写明白「这次是真删」，那道栅栏就该落在装配处这一层
        cleanup: (at) => executeCleanup({ archives, localRoot: archiveRoot }, at, true),
        listPrograms: () => programs.list(),
        inventory: (programId, at) => computeProgramInventory(visibility, { programId, now: at }),
      }),
    })

    await scheduler.bootstrap()
    scheduler.start()
    console.log(
      `scheduler started: tick=${tickSec}s tz=${tzOffsetSec}s lookback=${lookbackSec}s ` +
        `jobs=${JOB_CATALOG.map((j) => j.name).join(',')}`,
    )

    // 收到信号先停闹钟、再等在跑的那一轮自己跑完。**不中断在跑的任务**：
    // 归档搬到一半被砍掉会在 NAS 上留下半个文件，清理删到一半会让 local_purged_at
    // 与实际文件状态对不上。跑完之前进程不退，由编排层的超时决定要不要强杀。
    await new Promise<void>((resolve) => {
      const shutdown = (sig: string): void => {
        console.log(`scheduler: 收到 ${sig}，停止调度，等在跑的任务收尾`)
        void scheduler.stop().then(resolve)
      }
      process.once('SIGINT', () => shutdown('SIGINT'))
      process.once('SIGTERM', () => shutdown('SIGTERM'))
    })
    return 0
  } finally {
    await pool.end()
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
