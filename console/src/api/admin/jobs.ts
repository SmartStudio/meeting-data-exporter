/**
 * 定时任务页（spec.md §4.8）的两条端点。
 *
 * ## 这个文件的边界
 *
 * 类型定义在这里、也只从这里导出（计划 G-b）：`JobItem` / `JobRun` / `JobFailure`
 * 只有定时任务页一个消费者，塞进 `api/types.ts` 只会让七个并行任务在同一个文件上
 * 打架，换不来任何复用。
 *
 * `api/admin/health.ts` 也读 `GET /api/v1/admin/jobs`，但它只取系统状态条要的
 * 那三个事实（`fetch_recordings` 的连续失败轮数、`health`、`failuresTotal`），
 * **不是这条端点的完整建模**。两处各读各的，不要把这个文件的类型倒灌回去——
 * 那会让全局状态条依赖一份它用不上的形状。
 *
 * 反过来，**"最近 N 轮拉取连续失败"这句话只有一个出处**：`health.ts` 的
 * `fetchStreakText()`。本页显示同一件事时 import 它（计划 §7 与 G-d），
 * 不在这里另写一句——两处说法不一致就等于给了两个不同的事实。
 *
 * ## 三件读侧不收窄的事
 *
 * 1. **`health` 放宽成 `string`**。契约里是四个取值（`never_ran` / `running` /
 *    `overdue` / `ok`），但后端将来多一个取值不该让前端整页红。收窄成联合类型
 *    的代价是"认不出的值"只能被映成某一个已知状态——那就是在编造。
 *    呈现层（`pages/Jobs/view.ts`）对认不出的值给「未知」，不给「正常」。
 * 2. **`status` 同理**（后端 `store/jobs.ts` 的 `JobRunRecord.status` 自己就是
 *    `string`，理由与 `store/audit.ts` 对 `decision` 的口径相同）。
 * 3. **`summary` 是 `unknown`**。它是 `job_runs.summary` 这个 JSON 列的回读，
 *    每个任务各写各的形状（`{newlyArchived, failed, …}` / `{purged, paused, …}`,
 *    见 `src/worker/scheduler.ts` 的 `createJobRunners`）。在这里给它一个联合类型
 *    就是把 worker 的内部形状钉进前端契约，加一个字段两边都要改。
 */

import { apiGet, apiSend } from '../client'
import { reader, type FieldReader } from '../validate'

const BASE = '/api/v1/admin'

/**
 * 失败项列表一次最多带回多少条（后端 `FAILURES_PAGE_LIMIT`，`jobs.ts` handler）。
 *
 * 这个数在前端只有一个用途：**说清"被截断了"**。`failuresTotal` 永远是全量总数，
 * 不受这个上限影响，所以 `failures.length < failuresTotal` 时界面上必须写明
 * 还有多少条没列出来——否则"显示 100 条"与"一共就 100 条"在屏幕上长得一模一样。
 */
export const FAILURES_PAGE_LIMIT = 100

/** 一次运行。`recentRuns` 的第 0 个是最近一次。 */
export interface JobRun {
  id: number
  /** queued / running / succeeded / failed / interrupted / skipped。放宽成 string，见文件头 */
  status: string
  /** schedule / manual */
  trigger: string
  /** 手动触发时是那个管理员的 id；调度器触发时是 null */
  requestedBy: string | null
  /** unix 秒。`queued` / `skipped` 的行没有开跑过，是 null */
  startedAt: number | null
  finishedAt: number | null
  /** **还没跑完就是 null**。后端刻意不拿当前时刻凑一个会持续变大的数 */
  durationSec: number | null
  /** `job_runs.summary`（JSON 列）的回读，形状随任务而变。见文件头第 3 条 */
  summary: unknown
  error: string | null
}

/** 五个内置任务之一（`JOB_CATALOG`，`src/store/jobs.ts`）。 */
export interface JobItem {
  /** fetch_recordings / archive_nas / cleanup_expired / refresh_inventory */
  name: string
  /** 后端下发的中文名。不要在前端另起一个叫法 */
  label: string
  /** 这个任务干什么，一句话 */
  what: string
  /** 人读的频率描述（"每 15 分钟" / "每小时整点" / "每天 03:00"），后端拼好 */
  schedule: string
  /**
   * 下一次该跑的时刻（unix 秒）。**这是预测不是承诺**——调度器停了它照样算得出，
   * 所以永远和 `health` 一起看，不能单独当"一切正常"的证据。
   */
  nextDueAt: number
  /** 这个任务没跑成的影响（卡片上那行「影响：…」）。spec §4.8 要求明写。
   *  文案在后端的 `JOB_CATALOG`，三处一致由 `tests/store/jobs-copy.test.ts` 钉住。 */
  impact: string
  maxAttempts: number
  /** 这个任务还有几个没处理的失败项 */
  openFailures: number
  /** never_ran / running / overdue / ok。放宽成 string，见文件头 */
  health: string
  /** 最近一次运行；从没跑过时为 null */
  lastRun: JobRun | null
  /** 最多 20 条（后端 `JOB_RUNS_SPARKLINE_LIMIT`），最近一次在第 0 个 */
  recentRuns: JobRun[]
}

/** 「失败项 · 需要处理」表里的一行。 */
export interface JobFailure {
  id: number
  jobName: string
  /** 规范化键：会议维度是 `meetingId|subMeetingId`，程序维度是程序 id */
  target: string
  /** 人读的名字；拿不到时是空串，这时照 `target` 显示 */
  targetLabel: string
  /** 程序维度与整轮维度的失败项没有会议，是 null */
  meetingId: string | null
  subMeetingId: string
  reason: string
  /** 影响。spec §4.8 写死要显示这一列 */
  impact: string
  attempts: number
  maxAttempts: number
  /**
   * 重试次数已经到阈值。**含义是"该找人了"，不是"系统放弃了"**——每个任务的
   * 重试都由各自的枚举源结构性地驱动，没有一个会因为这个数字停下来。
   */
  escalated: boolean
  firstFailedAt: number
  lastFailedAt: number
}

export interface JobsOverview {
  /** 服务端的"现在"（unix 秒）。相对时间一律拿它算，不用客户端的钟 */
  now: number
  timezoneOffsetSec: number
  jobs: JobItem[]
  /** 需要人处理的失败项**全量总数**，不受 `failures` 那 100 条上限截断 */
  failuresTotal: number
  /**
   * 调度器每轮往回看几个小时（`MDE_SCHEDULER_FETCH_LOOKBACK_HOURS`，网关与调度器读的是
   * 同一个环境变量、同一份定义）。在前端只有一个用途：把「连续失败超过多少小时要人工补拉」
   * 那句说准。控制台不自己写 24——运维改了这个数，硬编码的横幅就会说谎，而且不报错。
   */
  fetchLookbackHours: number
  /** 最多 `FAILURES_PAGE_LIMIT` 条，按最近失败时间倒序 */
  failures: JobFailure[]
}

/** `POST /api/v1/admin/jobs/:name/run` 的 202 响应。 */
export interface RunJobAccepted {
  runId: number
  jobName: string
  label: string
  /** 恒为 `queued`——这一刻任务还没跑，界面上不许说成"已完成" */
  status: string
  /** 后端写好的那句解释（调度器在 worker 进程里，下一个 tick 才认领）。原样显示 */
  message: string
}

function readRun(r: FieldReader, o: Record<string, unknown>, where: string): JobRun {
  return {
    id: r.num(o, 'id', where),
    status: r.str(o, 'status', where),
    trigger: r.str(o, 'trigger', where),
    requestedBy: r.strOrNull(o, 'requestedBy', where),
    startedAt: r.numOrNull(o, 'startedAt', where),
    finishedAt: r.numOrNull(o, 'finishedAt', where),
    durationSec: r.numOrNull(o, 'durationSec', where),
    // 形状不校验（见文件头第 3 条），但 `undefined` 收敛成 `null`：
    // 呈现层只需要判一次"有没有摘要"。
    summary: o.summary === undefined ? null : o.summary,
    error: r.strOrNull(o, 'error', where),
  }
}

function readJob(r: FieldReader, o: Record<string, unknown>, where: string): JobItem {
  const lastRaw = r.objOrNull(o, 'lastRun', where)
  return {
    name: r.str(o, 'name', where),
    label: r.str(o, 'label', where),
    what: r.str(o, 'what', where),
    schedule: r.str(o, 'schedule', where),
    nextDueAt: r.num(o, 'nextDueAt', where),
    impact: r.str(o, 'impact', where),
    maxAttempts: r.num(o, 'maxAttempts', where),
    openFailures: r.num(o, 'openFailures', where),
    health: r.str(o, 'health', where),
    lastRun: lastRaw === null ? null : readRun(r, lastRaw, `${where}.lastRun`),
    recentRuns: r
      .objList(o, 'recentRuns', where)
      .map((x, i) => readRun(r, x, `${where}.recentRuns[${i}]`)),
  }
}

function readFailure(r: FieldReader, o: Record<string, unknown>, where: string): JobFailure {
  return {
    id: r.num(o, 'id', where),
    jobName: r.str(o, 'jobName', where),
    target: r.str(o, 'target', where),
    targetLabel: r.str(o, 'targetLabel', where),
    meetingId: r.strOrNull(o, 'meetingId', where),
    subMeetingId: r.str(o, 'subMeetingId', where),
    reason: r.str(o, 'reason', where),
    impact: r.str(o, 'impact', where),
    attempts: r.num(o, 'attempts', where),
    maxAttempts: r.num(o, 'maxAttempts', where),
    escalated: r.bool(o, 'escalated', where),
    firstFailedAt: r.num(o, 'firstFailedAt', where),
    lastFailedAt: r.num(o, 'lastFailedAt', where),
  }
}

export async function fetchJobs(): Promise<JobsOverview> {
  const raw = await apiGet<unknown>(`${BASE}/jobs`)
  const r = reader(`GET ${BASE}/jobs`)
  const o = r.object(raw, '')
  return {
    now: r.num(o, 'now', ''),
    timezoneOffsetSec: r.num(o, 'timezoneOffsetSec', ''),
    jobs: r.objList(o, 'jobs', '').map((x, i) => readJob(r, x, `jobs[${i}]`)),
    failuresTotal: r.num(o, 'failuresTotal', ''),
    fetchLookbackHours: r.num(o, 'fetchLookbackHours', ''),
    failures: r.objList(o, 'failures', '').map((x, i) => readFailure(r, x, `failures[${i}]`)),
  }
}

/**
 * 手动触发。**只排队，不执行**——调度器在 worker 进程里（网关是多实例的，
 * 在网关里跑意味着 N 个实例同时往同一个 NAS 目录搬同一批文件）。
 *
 * 任务名进路径前先 `encodeURIComponent`：它是外部输入，一个没转义的 `/`
 * 会把请求打到另一条路由上去。
 */
export async function runJob(name: string): Promise<RunJobAccepted> {
  const path = `${BASE}/jobs/${encodeURIComponent(name)}/run`
  const raw = await apiSend<unknown>('POST', path)
  const r = reader(`POST ${path}`)
  const o = r.object(raw, '')
  return {
    runId: r.num(o, 'runId', ''),
    jobName: r.str(o, 'jobName', ''),
    label: r.str(o, 'label', ''),
    status: r.str(o, 'status', ''),
    message: r.str(o, 'message', ''),
  }
}

/**
 * 失败项里**最近一次失败发生的时间**（`lastFailedAt` 的最大值）；没有失败项是 `null`。
 *
 * 左栏「定时任务」旁那颗红点靠它判断"有没有你还没看过的失败"（`app/failuresSeen.ts`）：
 * 看过的那一刻记住这个数，之后出现比它更新的失败就再亮。**按时间不按条数**：
 * 条数会先降后升回同一个值，看起来像什么都没发生。
 *
 * 列表最多 `FAILURES_PAGE_LIMIT` 条、后端按最近失败时间倒序，所以被截断时最新的
 * 那条也一定在返回的这一页里——这个最大值就是全量的最大值。顶栏那一路
 * （`api/admin/health.ts`）读的是同一条端点，用同一个函数，不另写一遍。
 */
export function newestFailedAt(failures: ReadonlyArray<Pick<JobFailure, 'lastFailedAt'>>): number | null {
  let newest: number | null = null
  for (const f of failures) {
    if (newest === null || f.lastFailedAt > newest) newest = f.lastFailedAt
  }
  return newest
}
