/**
 * 「定时任务」页（spec.md §4.8）的 API —— 阶段 4 · T11（A4）。
 *
 * 两个端点，都要管理员会话：
 *   GET  /api/v1/admin/jobs                五个任务 + 各自的 sparkline + 失败项表
 *   POST /api/v1/admin/jobs/:name/run      手动触发（**只排队，不执行**）
 *
 * ## 这个 handler 为什么不 import `src/worker/scheduler.ts`
 *
 * 验收判据 5：**调度器不进网关进程**。网关是多实例的，把五个任务各跑 N 份意味着
 * N 个实例同时往同一个 NAS 目录搬同一批文件、同时对同一批本地文件执行不可逆删除。
 *
 * 所以「立即运行」在这里只能落一行 `job_runs.status='queued'`，由 worker 侧的调度器
 * 在下一个 tick 认领并执行。响应因此是 **202 Accepted** 而不是 200——这一刻任务还没跑。
 * 回 200 会让界面显示「已完成」，而一轮归档可能几十分钟后才真正开始。
 *
 * 任务目录与时间片算术都在 `src/store/jobs.ts`：那是网关与调度器**都能安全 import**
 * 的地方（只依赖 mysql2 类型）。放进 scheduler.ts 再 import 过来也能编译，但那会把
 * 引擎、腾讯客户端、NAS 这一整条依赖链拖进网关的模块图。
 *
 * ## 三件不编的事
 *
 * 1. **从没跑过的任务不编 lastRun**：`health: 'never_ran'`。一个刚部署的实例本来
 *    就没跑过，这与「调度器死了」不是一回事，混成一个状态就没法排查
 * 2. **还在跑的一轮不给时长**：填一个「到现在为止」的秒数会让它每刷新一次就变大，
 *    看起来像已经跑完了
 * 3. **`nextDueAt` 是预测，不是承诺**：调度器停了它照样算得出下一个整点。所以同时
 *    给出 `health`——上一次运行离现在超过两个周期就报 `overdue`，让「界面上一切正常、
 *    实际调度器已经死了三天」这件事自己现形
 */
import type { RouteCtx } from '../../router'
import { json } from '../../respond'
import { requireAdminAuth, requireAdminWrite } from '../../middleware'
import { buildAuditDetail, type AuditEntry, type AuditStore } from '../../../store/audit'
import { AUDIT_ACTION } from '../../../audit/actions'
import {
  JOB_CATALOG,
  JOB_RUNS_SPARKLINE_LIMIT,
  describeSchedule,
  jobSpec,
  nextDueAt,
  type JobFailureRecord,
  type JobRunRecord,
  type JobSchedule,
  type JobsStore,
} from '../../../store/jobs'

export interface JobsDeps {
  jobs: JobsStore
  /**
   * 审计写侧。与 `storage.ts` 同一个取舍：管理员写操作这一族直接用 `AuditStore.record`，
   * 不往 `audit/recorder.ts` 上加方法——那个文件现在的三个方法都是「网关替某个程序
   * 取数据」那一族，而本阶段有好几个并行任务都要写管理员审计。
   */
  audit: Pick<AuditStore, 'record'>
  /**
   * **必须与调度器进程用的是同一个值**（`SchedulerConfig.tzOffsetSec`）。
   *
   * 它只影响「每天 03:00」那一个任务的 `nextDueAt`。两边配得不一样的后果是界面上
   * 显示的「下次运行」比真实时刻差 8 小时——而这种错不会报任何异常，只会让人在
   * 一个错误的时间点守在屏幕前等清理。装配处（`src/index.ts` 与调度器的入口）
   * 读的是同一个环境变量，就是为了让这两处只有一个来源。
   */
  tzOffsetSec: number
}

/** 失败项表一次最多带回多少行。§4.8 那是一段列表，不分页 */
const FAILURES_PAGE_LIMIT = 100

// 这里曾有一个 clipDetail（同 storage.ts）：自由文本被裁到 64 字符塞进
// audit_log.asset_type。migrations/008 的 detail TEXT 之后不再需要它——
// 明细走 buildAuditDetail，上限与超限留痕收在 src/store/audit.ts 一处。

/** 这个 schedule 一个周期多长（秒）。只给 `health` 判「落后多久算落后」用 */
function periodSecOf(s: JobSchedule): number {
  switch (s.kind) {
    case 'everyMinutes':
      return s.minutes * 60
    case 'hourly':
      return 3600
    case 'daily':
      return 86_400
  }
}

/**
 * 一次运行的耗时。**没跑完就是 null**，不拿 `now` 去减开始时刻凑一个数——
 * 那个数每刷新一次就变大，界面上与「跑完了，用了这么久」长得一模一样。
 * `skipped` 的行 `started_at` 本来就是 NULL（它没有开跑），同样落到 null。
 */
function durationOf(r: JobRunRecord): number | null {
  if (r.startedAt === null || r.finishedAt === null) return null
  return r.finishedAt - r.startedAt
}

/**
 * 这个任务此刻的状态。四个取值都是**事实**，没有一个是「大概吧」：
 *
 *   never_ran  一次都没跑过。新部署的实例就是这样，与「调度器死了」不是一回事
 *   running    上一轮还在跑
 *   overdue    上一次开跑离现在超过两个周期。调度器多半没在跑，或者被什么卡住了
 *   ok         其余
 *
 * 阈值取两个周期而不是一个：一个周期时正常的 tick 抖动（tick 间隔 30 秒、上一轮
 * 跑了几分钟）就会时不时地把它判成 overdue，而一条天天报警的告警等于没有告警。
 */
function healthOf(runs: readonly JobRunRecord[], schedule: JobSchedule, now: number): string {
  // **判据是「最近一次真的开跑过的运行」，不是「最近一行」。**
  // `started_at` 为 null 的行有两种：queued（手动触发在排队，还没被认领）与
  // skipped（到点了但上一轮还在跑）。拿它们当"最近一次运行"会开一个洞——
  // 在一个已经死掉的调度器上按一下「立即运行」，最新一行就变成 queued，
  // 于是页面从「overdue」翻回「正常」，而实际上那次触发永远不会被认领。
  const last = runs.find((r) => r.startedAt !== null)
  if (last === undefined) return 'never_ran'
  if (last.status === 'running') return 'running'
  const at = last.startedAt
  if (at === null) return 'ok'
  return now - at > 2 * periodSecOf(schedule) ? 'overdue' : 'ok'
}

function runView(r: JobRunRecord): Record<string, unknown> {
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    requestedBy: r.requestedBy,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationSec: durationOf(r),
    summary: r.summary,
    error: r.error,
  }
}

function failureView(f: JobFailureRecord): Record<string, unknown> {
  return {
    id: f.id,
    jobName: f.jobName,
    target: f.target,
    // 拿不到人读的名字时是空串，前端照 target 显示。**这里不去补一个标题**：
    // 补标题要按会议批量查一次，而失败项表里还有程序维度与整轮维度的行，
    // 那次查询对它们没有意义。真要补，该由 A2 的会议查询那一侧统一做
    targetLabel: f.targetLabel,
    meetingId: f.meetingId,
    subMeetingId: f.subMeetingId,
    reason: f.reason,
    impact: f.impact,
    attempts: f.attempts,
    maxAttempts: f.maxAttempts,
    /**
     * 重试次数已经到阈值 = **该找人了**，不是「系统放弃了」。
     * 五个任务的重试都由各自的枚举源结构性地驱动，没有一个会因为这个数字停下来
     * ——见 `store/jobs.ts` 的 `JobSpec.maxAttempts`。
     */
    escalated: f.attempts >= f.maxAttempts,
    firstFailedAt: f.firstFailedAt,
    lastFailedAt: f.lastFailedAt,
  }
}

// ────────────────────────────────────────────────────────────────
// GET /api/v1/admin/jobs
// ────────────────────────────────────────────────────────────────

export async function listJobs(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const d = ctx.deps.jobs
  const now = ctx.deps.now()

  // 每个任务一次查询取回 sparkline，最近一次就是它的第一行——不再单发一次
  // "取最后一次运行"。五个任务五次查询，与任务数同阶，不随运行历史增长。
  const [runsPerJob, openFailures, failures] = await Promise.all([
    Promise.all(JOB_CATALOG.map((s) => d.jobs.listRuns(s.name, JOB_RUNS_SPARKLINE_LIMIT))),
    d.jobs.countOpenFailures(),
    d.jobs.listFailures({ limit: FAILURES_PAGE_LIMIT }),
  ])

  const jobs = JOB_CATALOG.map((spec, i) => {
    const runs = runsPerJob[i] ?? []
    const last = runs[0]
    return {
      name: spec.name,
      label: spec.label,
      what: spec.what,
      schedule: describeSchedule(spec.schedule),
      // 预测，不是承诺。调度器停了它照样算得出，所以 health 与它一起看
      nextDueAt: nextDueAt(spec.schedule, now, d.tzOffsetSec),
      impact: spec.impact,
      maxAttempts: spec.maxAttempts,
      openFailures: openFailures[spec.name] ?? 0,
      health: healthOf(runs, spec.schedule, now),
      lastRun: last === undefined ? null : runView(last),
      recentRuns: runs.map(runView),
    }
  })

  return json(200, {
    now,
    timezoneOffsetSec: d.tzOffsetSec,
    jobs,
    // §4.8 下方那张「失败项 · 需要处理」。总数单列一个字段：列表被 limit 截断时，
    // 界面上"显示 100 条"与"一共就 100 条"必须分得开
    failuresTotal: Object.values(openFailures).reduce((a, b) => a + b, 0),
    failures: failures.map(failureView),
  })
}

// ────────────────────────────────────────────────────────────────
// POST /api/v1/admin/jobs/:name/run
// ────────────────────────────────────────────────────────────────

/**
 * 「立即运行」。**只排队**，理由见文件头。
 *
 * 任务名认不出来一律 404，绝不回退到某个默认任务——路径参数是外部输入，
 * 回退意味着管理员按下「拉取新录制」却跑了一次不可逆的到期清理。
 */
export async function runJob(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const name = ctx.params.name ?? ''
  const spec = jobSpec(name)
  if (spec === null) {
    return json(404, {
      error: 'unknown_job',
      name,
      knownJobs: JOB_CATALOG.map((j) => j.name),
    })
  }

  const d = ctx.deps.jobs
  const now = ctx.deps.now()

  // 顺序是"先做事、再记账"：审计是对已发生事实的记录。先记后做一旦中间失败，
  // 审计里就留下了一件没发生过的事（同 storage.ts）。
  const runId = await d.jobs.enqueueManualRun({
    jobName: spec.name,
    requestedBy: auth.identity.adminId,
    now,
  })

  const entry: AuditEntry = {
    occurredAt: now,
    actorType: 'admin',
    actorId: auth.identity.adminId,
    action: AUDIT_ACTION.runJob,
    meetingId: null,
    // audit_log 没有"对象类型"这一列，asset_id 在管理员这一族里当对象键用。
    // 带上 job: 前缀，免得与会议维度的记录（`sub:` 前缀、或裸 assetId）混在一起
    assetId: `job:${spec.name}`,
    // 任务不是一份资产，这一列没有值可填（从前它装着下面那句明细）
    assetType: null,
    decision: 'allow',
    matchedRuleId: null,
    clientKind: 'console',
    detail: buildAuditDetail({
      text: `手动触发「${spec.label}」，排队等调度器认领（run #${runId}）`,
      // runId 另留一份结构化的：事后要把这条审计与 job_runs 里那一行对上，
      // 靠正则从一句中文里抠 `#123` 是最容易出错的那种做法
      data: { jobName: spec.name, runId },
    }),
  }
  await d.audit.record(entry)

  // 202：**接受了，还没执行**。这一刻只有一行 queued，调度器在 worker 进程里，
  // 下一个 tick（默认 30 秒内）才会认领它。
  return json(202, {
    runId,
    jobName: spec.name,
    label: spec.label,
    status: 'queued',
    message:
      '已排队。定时任务由 worker 进程的调度器执行（网关是多实例的，不能在这里跑），' +
      '它会在下一个 tick 认领这一次触发——刷新本页看运行记录。',
  })
}
