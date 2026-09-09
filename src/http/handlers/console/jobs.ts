/**
 * 「定时任务」页（spec.md §4.8）的 API —— 阶段 4 · T11（A4）。
 *
 * 四个端点，都要管理员会话：
 *   GET  /api/v1/admin/jobs                    五个任务 + 各自的 sparkline + 失败项表
 *   POST /api/v1/admin/jobs/:name/run          手动触发（**只排队，不执行**）
 *   POST /api/v1/admin/jobs/failures/retry     把一条失败项对应会议的资产打回下载队列
 *   POST /api/v1/admin/jobs/failures/ignore    把它的 dead 资产判成不用管了
 *
 * 后两个与「立即运行」的差别（为什么它们能在网关里当场执行）写在 `actOnFailures`。
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
import { json, readJson } from '../../respond'
import { requireAdminAuth, requireAdminWrite } from '../../middleware'
import { buildAuditDetail, type AuditEntry, type AuditStore } from '../../../store/audit'
import { AUDIT_ACTION } from '../../../audit/actions'
import type { Store } from '@yaowu/mde-engine'
import {
  JOB_CATALOG,
  JOB_FETCH_RECORDINGS,
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
   * 资产队列的写侧，**收窄到失败项动作要用的那两个方法**。
   *
   * 装配处给的是 `createMysqlStore(pool)`（`src/worker/store-mysql.ts`）。它住在
   * `worker/` 目录下，但它是一个 **store**，不是调度器：运行时只依赖 mysql2 与
   * `@yaowu/mde-engine`（网关本来就在 rules/meetings/policy 几处 import 着后者），
   * 一行 `src/worker/scheduler.ts` 都没有——与「调度器不进网关进程」那条约束不冲突。
   *
   * 收窄成 Pick 而不是整个 `Store`：这个 handler 不该够得着 `claimNext`。网关是
   * 多实例的，一个能领任务的网关就是五个任务各跑 N 份的第一步。
   */
  assets: Pick<Store, 'retryMeetingAssets' | 'ignoreDeadAssets'>
  /**
   * **必须与调度器进程用的是同一个值**（`SchedulerConfig.tzOffsetSec`）。
   *
   * 它只影响「每天 03:00」那一个任务的 `nextDueAt`。两边配得不一样的后果是界面上
   * 显示的「下次运行」比真实时刻差 8 小时——而这种错不会报任何异常，只会让人在
   * 一个错误的时间点守在屏幕前等清理。装配处（`src/index.ts` 与调度器的入口）
   * 读的是同一个环境变量，就是为了让这两处只有一个来源。
   */
  tzOffsetSec: number
  /**
   * 任务一（拉取新录制）的回看窗口，小时数。**必须与调度器进程用的是同一个值、
   * 读的是同一个环境变量**（`MDE_SCHEDULER_FETCH_LOOKBACK_HOURS`，调度器那边用它
   * 算 `lookbackSec`，见 `src/worker/scheduler.ts` 的 `main`）——与 `tzOffsetSec`
   * 同一个先例，同一个 `store/jobs.ts` 里的共享定义（`schedulerFetchLookbackHours`）。
   *
   * 控制台「定时任务」页的「最近 N 轮拉取连续失败」横幅要用它讲清楚管理员真正能
   * 做的事：调度器会自动重试；但连续失败超过这个小时数之后，中断期间结束的会议
   * 会落在拉取窗口之外，修好后需要人工用 `bun run worker --from/--to` 补拉。
   * 配错这里的后果与 `tzOffsetSec` 一样——**不报任何错**，界面上只会说错小时数，
   * 让人以为补拉窗口比实际的更宽或更窄。
   */
  fetchLookbackHours: number
}

/** 失败项表一次最多带回多少行。§4.8 那是一段列表，不分页 */
const FAILURES_PAGE_LIMIT = 100

/** 一次批量动作最多多少个 id（规格 §2.3）。上限与 `FAILURES_PAGE_LIMIT` 同值不是巧合：
 *  屏幕上一次最多就这么多条，「全部重试」永远塞不满这个上限 */
const FAILURE_ACTION_MAX_IDS = 100

/**
 * 请求体里的 ids。**任何一处不合规就整条拒绝**，不做「挑出合法的那几个继续」——
 * 那会让一次手滑（多打一个字符串）变成一次只做了一半的批量操作，而调用方
 * 从 200 响应里看不出自己少做了什么。
 */
function parseFailureIds(body: unknown): number[] | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = (body as { ids?: unknown }).ids
  if (!Array.isArray(raw)) return null
  if (raw.length < 1 || raw.length > FAILURE_ACTION_MAX_IDS) return null
  const out: number[] = []
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return null
    // 同一个 id 报两次是同一件事，做两遍没有意义（第二遍的 affected 还会撒谎）
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/**
 * 可操作的失败项只有一种（规格 §2.3）：调度器任务一按 dead 资产登记的、
 * 会议维度的、还没恢复的那种。
 *
 * 其余任务的失败项每轮由各自的枚举源重新判定、`resolveStaleFailures` 自动关掉
 * ——对它们「重试」没有对应的动作可做（下一轮本来就会再试一次），「忽略」更是
 * 一个假承诺（它下一轮还会回来）。端点对它们返回 skipped，界面上也不给按钮。
 */
function isActionableFailure(f: JobFailureRecord): boolean {
  return f.jobName === JOB_FETCH_RECORDINGS && f.meetingId !== null && f.resolvedAt === null
}

/** 两个动作各自的那个动词，只进审计明细里那句人话 */
const FAILURE_ACTION_TEXT = { retry: '重试', ignore: '忽略' } as const
type FailureActionKind = keyof typeof FAILURE_ACTION_TEXT

/**
 * 动作 → `audit_log.action`。查表而不是在赋值处写三目，是为了让
 * `tests/audit/actions.test.ts` 那条绊线还能看懂这里：它扫的是
 * 「同一行里既有 `action:` 又有字符串字面量」，而 `action: k === 'retry' ? …`
 * 会被它读成一个绕过登记表的动作名。绊线宁可误报也不该被放宽——它挡的是
 * 「新加的写操作忘了登记标签」，那种漏只在有人去读审计页的时候才会被发现。
 */
const FAILURE_ACTION_AUDIT = {
  retry: AUDIT_ACTION.jobFailureRetry,
  ignore: AUDIT_ACTION.jobFailureIgnore,
} as const

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
    /**
     * 原始技术信息。`reason` 是人话、这一列是原文，控制台里它是一个默认收起的
     * 「技术详情」折叠——归并键（任务 + 原因 + 影响）不含它，所以 23 场同样
     * 404 的会议仍然归成一组，而每一场自己的 remote_id 一个都没丢。
     */
    detail: f.detail,
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
    // 「最近 N 轮拉取连续失败」横幅要的那个小时数——不许前端硬编码 24，
    // 见 JobsDeps.fetchLookbackHours 与 store/jobs.ts 的 schedulerFetchLookbackHours
    fetchLookbackHours: d.fetchLookbackHours,
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

// ────────────────────────────────────────────────────────────────
// POST /api/v1/admin/jobs/failures/{retry,ignore}
// ────────────────────────────────────────────────────────────────

/**
 * 失败项上的两个动作（规格 §2.3）。
 *
 * ## 为什么这两个动作能在网关里真的执行，而「立即运行」只能排队
 *
 * 「立即运行」要跑一整轮任务体（归档要搬文件、清理要删文件），网关是多实例的，
 * 跑起来就是 N 份同时对同一批文件动手。这两个动作是**两条 UPDATE**：把一场
 * 会议的资产行改个状态。幂等、无副作用、跑几遍结果一样，没有理由绕一圈去排队
 * ——排队的话管理员点完还要等下一个 tick 才看得见变化。
 *
 * ## 顺序：先改资产、再关失败项、最后记账
 *
 * 失败项是「资产此刻是否 dead」的镜像（见 scheduler.ts 的 recordDeadAssets）。
 * 先关失败项再改资产的话，中间失败会留下一条「已恢复」的记录而资产还是 dead
 * ——下一轮它又被重新登记，运维看到的是一条自己关掉又自己回来的失败项。
 * 审计放最后，理由同 runJob：审计是对**已发生事实**的记录。
 */
async function actOnFailures(
  req: Request,
  ctx: RouteCtx,
  // 形参不叫 `action`：`if (action === 'retry')` 会被上面说的那条绊线读成
  // 一个没登记的动作名。名字让给 `audit_log.action` 那一列
  kind: FailureActionKind,
): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const ids = parseFailureIds(await readJson<unknown>(req))
  if (ids === null) {
    return json(400, {
      error: 'invalid_ids',
      message:
        `请求体要 {"ids": [失败项 id, …]}，1–${FAILURE_ACTION_MAX_IDS} 个正整数。` +
        '有一个不合规就整条拒绝——只做一半的批量操作在 200 响应里看不出来。',
    })
  }

  const d = ctx.deps.jobs
  const now = ctx.deps.now()

  const found = await d.jobs.listFailuresById(ids)
  const byId = new Map(found.map((f) => [f.id, f]))
  const doable: JobFailureRecord[] = []
  const skipped: number[] = []
  for (const id of ids) {
    const f = byId.get(id)
    if (f !== undefined && isActionableFailure(f)) doable.push(f)
    else skipped.push(id)   // 找不到、已恢复、或不是可操作的那种——三种都不编一个结果
  }

  // 一条一条走完：改资产 → 关掉它自己那条失败项 → 写它自己那行审计。三步交错，
  // 不是「先全改完、再一起关、最后补一批审计」。
  //
  // 审计行是「这件事真的发生了」的唯一凭据，所以它必须跟在自己那次改动之后。
  // 分三轮写时，一批 20 条里第 12 条炸掉，库里已经有 11 条改动而审计一行都没写
  // ——事后按会议查审计，查到的是「没人动过」。交错之后写下来的每一行审计都对得上
  // 一次已经落库的改动，中途挂掉最多差最后那一条。
  //
  // 逐条一行审计（与 purge_local 同一个先例）：这一列要答得出「是谁把哪一场
  // 会议的资产打回了队列」。一批一条的话，事后按会议查审计就查不到这件事。
  for (const f of doable) {
    const key = { meetingId: f.meetingId!, subMeetingId: f.subMeetingId }
    if (kind === 'retry') await d.assets.retryMeetingAssets(key, now)
    else await d.assets.ignoreDeadAssets(key, now)
    // 批量接口收一个只有一条的数组：语义与逐条一致，也省得为这里另开一个方法
    await d.jobs.resolveFailuresByIds([f.id], now)

    const entry: AuditEntry = {
      occurredAt: now,
      actorType: 'admin',
      actorId: auth.identity.adminId,
      action: FAILURE_ACTION_AUDIT[kind],
      meetingId: f.meetingId,
      // audit_log 没有「对象类型」这一列，assetId 在管理员这一族里当对象键用。
      // `failure:` 前缀免得与会议维度的记录（`sub:` 前缀）混在一起
      assetId: `failure:${f.target}`,
      assetType: null,
      decision: 'allow',
      matchedRuleId: null,
      clientKind: 'console',
      detail: buildAuditDetail({
        text: `${FAILURE_ACTION_TEXT[kind]}失败项 #${f.id}（${f.reason}）`,
        // 结构化的一份：批量里的一条与单点的一条，事后要分得开
        data: { failureId: f.id, jobName: f.jobName, target: f.target, batchSize: ids.length },
      }),
    }
    await d.audit.record(entry)
  }

  return json(200, { affected: doable.length, skipped })
}

/** 打回下载队列：`meeting_assets` 的 failed/dead → pending，attempts 清零 */
export async function retryFailures(req: Request, ctx: RouteCtx): Promise<Response> {
  return actOnFailures(req, ctx, 'retry')
}

/** 判成不用管了：`meeting_assets` 的 dead → skipped/ignored_by_admin */
export async function ignoreFailures(req: Request, ctx: RouteCtx): Promise<Response> {
  return actOnFailures(req, ctx, 'ignore')
}
