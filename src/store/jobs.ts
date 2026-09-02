/**
 * 定时任务的目录、时间片算术与运行记录（阶段 4 · T11，A4）。
 *
 * 表在 `migrations/008_job_runs.sql`，那个文件的表头写了两张表各自的取舍。
 *
 * ## 为什么「任务目录」与「时间片算术」在一个 store 文件里
 *
 * 这两样都是**纯数据/纯函数**，看起来该单开一个模块。不开的理由是硬约束：
 * **网关进程不许 import 调度器**（验收判据 5——网关是多实例的，四个任务各跑一份
 * 是灾难）。而控制台的 `GET /api/v1/admin/jobs` 又必须答得出「这个任务多久跑一次、
 * 下次什么时候跑」。于是这些元数据只能落在一个两边都能安全 import 的地方：
 * 调度器（`src/worker/scheduler.ts`）拿它去挂 `run` 实现，handler 拿它去显示，
 * 两边读的是同一份。
 *
 * 放进 `scheduler.ts` 再让 handler import 也能编译，但那会把引擎、腾讯客户端、
 * NAS 这一整条依赖链拖进网关进程的模块图——一次「只是想读个任务名」的 import，
 * 埋的是「哪天有人在 scheduler.ts 顶层加了一行副作用」这种事故。
 *
 * ## 时间片：调度不记「上次几点跑的」，只记「上次跑的是哪一片」
 *
 * 每个 schedule 把时间轴切成等长的片（每 15 分钟一片 / 每小时一片 / 每天一片），
 * `slotOf(now)` 落在哪一片就是哪一片。调度器每个 tick 比对「此刻这一片」与
 * 「上次触发的那一片」，不同就跑一次。这个表示法一次解决三件事：
 *
 *   - **对齐墙上时钟**：每小时整点就是片的边界，不是「进程启动后每 3600 秒」
 *   - **不补跑错过的**（验收判据 3）：启动时把「上次触发的片」初始化成此刻这一片，
 *     停机期间的那些片根本不会被枚举出来，没有可补的东西
 *   - **一片只跑一次**：tick 频率再高（甚至一秒一次）也不会在同一片里跑第二遍
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { Pool } from './db'

// ── 任务目录 ──────────────────────────────────────────────────

export const JOB_NAMES = [
  'fetch_recordings',
  'archive_nas',
  'cleanup_expired',
  'refresh_inventory',
] as const

export type JobName = (typeof JOB_NAMES)[number]

/**
 * 归档任务的名字，单独导出（阶段 5 · A8）。
 *
 * 它有两个跨模块的消费方：写侧是 worker 的归档轮（往 `job_failures` 落行），
 * 读侧是 `handlers/console/storage.ts` 的「归档失败 N 场」（spec §4.9 的第三个数）。
 * 两处各写一个 `'archive_nas'` 字面量的话，哪天任务改名，写侧照常记账、
 * 读侧照常返回 0——界面上显示「一场都没失败」，没有任何东西会报错。
 * 与 `ACTION_EXTEND_RETENTION`（store/audit.ts）是同一个先例。
 */
export const JOB_ARCHIVE_NAS: JobName = 'archive_nas'

/**
 * 触发频率。三种形状覆盖 spec §4.8 的四个任务，**不做通用 cron 表达式**：
 * cron 的表达力这里一条都用不上，而它换来的是一个要自己写解析器与夏令时语义的东西。
 */
export type JobSchedule =
  | { kind: 'everyMinutes'; minutes: number }
  /** 每小时的第 `minute` 分钟。整点 = 0 */
  | { kind: 'hourly'; minute: number }
  /** 每天的 `hour:minute`，**本地时间**（见 `slotOf` 的 tzOffsetSec） */
  | { kind: 'daily'; hour: number; minute: number }

export interface JobSpec {
  name: JobName
  /** spec §4.8 那张表第一列，逐字 */
  label: string
  /**
   * spec §4.8 那张表「干什么」一列。
   *
   * 任务一那一格是**唯一一处与 spec 不逐字**的：spec 写「发现新录制并入队」，
   * 而 T14 之后它还会把队列下完。裁定的依据是同一张表第一列的名字——那一格叫
   * 「拉取新录制」，管理员的心智模型跟着名字走，不会把它读成「只是登记一下」。
   * 既然实现按名字补齐了，描述就得跟着说实话：名字对了而描述还说只入队，等于把
   * 同一处不一致挪到更靠近用户的地方。**四格仍然是四格**，没有新增任务。
   */
  what: string
  schedule: JobSchedule
  /**
   * 失败项的「该找人了」阈值——**不是「到此为止」的阈值**。
   * 四个任务的重试都由各自的枚举源结构性地驱动（归档只要还有未归档的完成资产就会
   * 被再捞回来），没有一个会因为这个数字停下来。真给它一个停止阈值才是错的：
   * 放弃归档意味着那场会议的录制在上游到期后彻底没有了（spec §1.2）。
   * 取 5 与引擎下载执行体的 MAX_ATTEMPTS 同值，好让界面上两处「N / 5」口径一致。
   */
  maxAttempts: number
  /**
   * 这个任务失败一次的**影响**，一句人话。spec §4.8 明写失败项要写清影响。
   * 它是常量而不是每次失败现拼：同一个任务的失败影响不随失败原因变化，
   * 现拼只会让同一件事在表里出现十几种措辞。
   */
  impact: string
}

/**
 * spec §4.8 的四个任务，顺序即界面顺序（一、二、三、四）。
 *
 * **任务四不落缓存表**（计划 E-e 已裁定）：它逐程序算一遍，把 `fetchable.length` /
 * `blocked.length` 写进 `job_runs.summary`。开缓存表会让「控制台显示的可取清单」
 * 与「网关 AccessGate 的实时判定」变成两份真相，而漂移的方向恰好是 §1.3 要防的
 * 那一件事。先开表才是不可逆的那个方向。
 */
export const JOB_CATALOG: readonly JobSpec[] = [
  {
    name: 'fetch_recordings',
    label: '拉取新录制',
    // 「下载」不能省：T14 之后任务一真的会把队列下完，理由见上面 `what` 的注释。
    // 「从腾讯会议」是这条链的起点，说出来才知道拉不动时该去查谁。
    what: '从腾讯会议下载新录制到本地',
    schedule: { kind: 'everyMinutes', minutes: 15 },
    maxAttempts: 5,
    // 说的是**不可逆**：腾讯会议那边的云录制有保留期，过了就不存在了，
    // 不是"晚点再拉"。不写「上游」——那是我们自己的说法，看这一行的人只知道
    // 录制是从腾讯会议来的。
    impact: '录制在腾讯会议过期后就再也拉不回来了',
  },
  {
    name: 'archive_nas',
    label: '归档到 NAS',
    // 补上主语：原来只说「写入 NAS」，写的是什么没说
    what: '把本地文件写进 NAS 并校验哈希',
    schedule: { kind: 'hourly', minute: 0 },
    maxAttempts: 5,
    // spec §1.2：没有归档成功的会议，本地保留期一到就彻底没有了。
    // 不写「未归档」——任务名就叫「归档到 NAS」，重复一遍不增加信息。
    // 主语写「这场会议」而不是「副本」：丢的是会议，副本是我们的说法。
    impact: '本地文件到期清理后，这场会议就一份都不剩了',
  },
  {
    name: 'cleanup_expired',
    label: '清理到期文件',
    // 看这一行的人真正在问的是「会不会删掉我还要的东西」，所以两个条件都写出来。
    // 「记录保留」是 spec §4.8 特意加粗的那半句，删了会让人以为记录也一起没了。
    what: '删掉已过期且已归档的本地文件，记录保留',
    schedule: { kind: 'daily', hour: 3, minute: 0 },
    maxAttempts: 5,
    // 原来这一句 35 字，后半截讲的是"部分清理留下的账目不一致"——一个很窄的情形。
    // 换成真会撞上的那条连锁：盘满了，新录制就下不来。说「新的录制拉不下来」
    // 而不是「新的拉取失败」——前者是丢了什么，后者是哪个程序报错。
    impact: '本地磁盘会被占满，新的录制拉不下来',
  },
  {
    name: 'refresh_inventory',
    label: '刷新采集清单',
    // 授权是到**资产类型**这一层的（八类），只说「哪些会议可见」丢了一层粒度
    what: '重算每个程序能取走哪些会议的哪些资产',
    schedule: { kind: 'everyMinutes', minutes: 5 },
    maxAttempts: 5,
    // 原来这一句里写着「§4.5」——spec 的章节号漏到了界面上，看见它的人无从查起。
    // 换成这个任务不跑时**别人看得见的那件事**：采集程序那边少了新会议。
    // 先说丢了什么（取不到新会议），再说为什么（清单停在上一轮）——
    // 反过来写的话，读的人得先消化一个内部概念才知道这跟自己有什么关系。
    impact: '采集程序取不到新会议，清单停在上一轮',
  },
]

/**
 * 按名字取任务定义。**认不出来返回 null，绝不回退到第一个**——手动触发端点拿的是
 * 路径参数，回退等于管理员按下「拉取」按钮却跑了清理。
 */
export function jobSpec(name: string): JobSpec | null {
  return JOB_CATALOG.find((j) => j.name === name) ?? null
}

const MINUTE = 60

/**
 * 调度器与控制台**共用**的时区偏移（秒）。
 *
 * `MDE_SCHEDULER_TZ_OFFSET_MIN` 给的是分钟（东八区 = 480），缺省 0 = UTC，
 * 与审计里的时间戳同口径。
 *
 * 为什么读同一个变量的代码只能有一份：它只影响「每天 03:00」那一个任务，而两边
 * 各读各的一旦分叉，界面上显示的「下次运行」会比调度器真实的触发时刻差几个小时
 * ——**不报任何错**，只会让人在一个错误的时间点守在屏幕前等清理。
 *
 * 认不出的值（写成 `+08:00`、带空格、非整数）**回落到 0 并喊一句**，不猜：
 * 猜错的后果是不可逆删除跑在业务高峰上。
 */
export function schedulerTzOffsetSec(env: Record<string, string | undefined>): number {
  const raw = env.MDE_SCHEDULER_TZ_OFFSET_MIN
  // 空串必须与未设置等价：.env.example 里这类可选项写作 `X=`，而 Bun 把它读成空串
  if (raw === undefined || raw === '') return 0
  const n = Number(raw)
  if (!Number.isInteger(n) || Math.abs(n) > 14 * 60) {
    console.warn(
      `MDE_SCHEDULER_TZ_OFFSET_MIN 认不出来（${raw}），按 UTC（0）处理。` +
        '它是**分钟**，东八区填 480。「每天 03:00 清理」会因此跑在 UTC 03:00 上',
    )
    return 0
  }
  return n * MINUTE
}

/** 人读的频率描述，直接进 API 响应。与 `JOB_CATALOG` 同源，前端不必自己拼 */
export function describeSchedule(s: JobSchedule): string {
  switch (s.kind) {
    case 'everyMinutes':
      return `每 ${s.minutes} 分钟`
    case 'hourly':
      return s.minute === 0 ? '每小时整点' : `每小时第 ${s.minute} 分钟`
    case 'daily':
      return `每天 ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`
  }
}

// ── 时间片算术 ────────────────────────────────────────────────

const HOUR = 3600
const DAY = 86_400

/** 这个 schedule 把时间轴切成多长一片（秒） */
function periodOf(s: JobSchedule): number {
  switch (s.kind) {
    case 'everyMinutes':
      return s.minutes * MINUTE
    case 'hourly':
      return HOUR
    case 'daily':
      return DAY
  }
}

/** 片内偏移：片的起点相对整周期边界挪多少秒 */
function phaseOf(s: JobSchedule): number {
  switch (s.kind) {
    case 'everyMinutes':
      return 0
    case 'hourly':
      return s.minute * MINUTE
    case 'daily':
      return s.hour * HOUR + s.minute * MINUTE
  }
}

/**
 * `atSec`（unix 秒，UTC）落在第几片。
 *
 * `tzOffsetSec` 是**本地时间相对 UTC 的偏移**（东八区 = 28800）。它只对
 * 「每天 03:00」这类带墙上钟点的 schedule 有实际意义——03:00 指的是运维眼里的
 * 凌晨三点，不是 UTC 的三点。配成 0（默认）时全系统按 UTC 走，与审计里的时间戳
 * 口径一致；部署在国内的实例应当显式配 28800，否则「清理到期文件」会跑在
 * 北京时间上午 11 点的业务高峰上。
 *
 * 用 `Math.floor` 而不是整除截断：unix 秒在 1970 之前是负数，截断会让负半轴上的
 * 片错位一格。这不是理论问题——测试里造时间戳时很容易写出负值。
 */
export function slotOf(s: JobSchedule, atSec: number, tzOffsetSec: number): number {
  return Math.floor((atSec + tzOffsetSec - phaseOf(s)) / periodOf(s))
}

/** 第 `slot` 片从哪一刻开始（unix 秒，UTC）。`slotOf` 的逆 */
export function slotStartAt(s: JobSchedule, slot: number, tzOffsetSec: number): number {
  return slot * periodOf(s) + phaseOf(s) - tzOffsetSec
}

/** `afterSec` 之后的下一次触发时刻。界面上「下次运行」读它 */
export function nextDueAt(s: JobSchedule, afterSec: number, tzOffsetSec: number): number {
  return slotStartAt(s, slotOf(s, afterSec, tzOffsetSec) + 1, tzOffsetSec)
}

// ── 运行记录 ──────────────────────────────────────────────────

export type JobTrigger = 'schedule' | 'manual'

/**
 * 一次运行的状态。含义见 `migrations/008_job_runs.sql` 的表头第一节。
 *
 * 读出来时放宽成 `string`（见 `JobRunRecord.status`），与 `store/audit.ts` 对
 * `decision` 的口径相同：认不出的值映成任何一个已知状态都是在编造。
 */
export type JobRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'skipped'

export interface JobRunRecord {
  id: number
  jobName: string
  /** 读侧放宽成 string，理由同 `status` */
  trigger: string
  requestedBy: string | null
  status: string
  /** queued 的行还没开跑，为 null */
  startedAt: number | null
  finishedAt: number | null
  summary: unknown
  error: string | null
  createdAt: number
}

export interface JobFailureRecord {
  id: number
  jobName: string
  target: string
  targetLabel: string
  meetingId: string | null
  subMeetingId: string
  reason: string
  impact: string
  attempts: number
  maxAttempts: number
  firstFailedAt: number
  lastFailedAt: number
  resolvedAt: number | null
}

export interface RecordFailureInput {
  jobName: string
  /** 失败对象的规范化键。会议用 `jobFailureTarget()` 拼 */
  target: string
  /** 人读的对象名（会议标题 / 程序名）。拿不到就传空串，不要编一个 */
  targetLabel: string
  meetingId: string | null
  subMeetingId: string
  reason: string
  impact: string
  maxAttempts: number
  now: number
}

export interface ListFailuresOptions {
  jobName?: string
  /** 默认只给没恢复的——「失败项 · 需要处理」问的就是这些 */
  includeResolved?: boolean
  meetingId?: string
  /** 只在给了 `meetingId` 时有意义。单场会议的键是两段，只给前一段会串场 */
  subMeetingId?: string
  /**
   * 一批会议一次问完（阶段 5 · D-4：会议记录页整页反查归档失败的真原因）。
   *
   * 与 `meetingId` 的分工：那一个是「问某一场」，这一个是「问这一页的这几场」。
   * 逐场问也答得出，但那是 N 次查询，而列表端点的验收判据就是**查询数与行数无关**
   * （见 `src/store/console-meetings.ts` 的文件头）。
   *
   * **空数组返回空，不退化成「没有条件」**：退化的表现是抽屉把别的会议的失败原因
   * 安到这一场头上——那正是这一族改动要消灭的那种假话。
   */
  meetings?: readonly { meetingId: string; subMeetingId: string }[]
  limit?: number
}

/** 失败项列表的默认条数上限。§4.8 那张表是一段列表，不分页 */
export const JOB_FAILURES_DEFAULT_LIMIT = 200
/** sparkline 默认取多少次运行 */
export const JOB_RUNS_SPARKLINE_LIMIT = 20

/**
 * 会议维度失败项的规范化键。
 *
 * 用 `|` 拼而不是 JSON：这一列还要进唯一键（VARCHAR(191)），JSON 会白占一截长度。
 * 分隔符的选择在这里是安全的——meeting_id / sub_meeting_id 都来自腾讯会议的 ID
 * 空间（数字与短横），不会含 `|`。**换成用户可控的字段（比如标题）时这条就不成立了**，
 * 那时要改成带长度前缀或哈希。
 */
export function jobFailureTarget(meetingId: string, subMeetingId: string): string {
  return `${meetingId}|${subMeetingId}`
}

export interface JobsStore {
  /** 开跑：插一行 running，返回它的 id */
  startRun(input: {
    jobName: string
    trigger: JobTrigger
    requestedBy?: string | null
    now: number
  }): Promise<number>

  /**
   * 收尾。`status='succeeded'` 时带 summary，`'failed'` 时带 error。
   *
   * 「轮内有几件事失败」（归档轮里几场会议归不上）**不是** failed：那种轮次本身
   * 跑完了，失败项在 `job_failures` 里，summary 里也有数字。failed 专指任务体
   * 自己抛了出来。混成一件事的话，界面上的 sparkline 会因为一场会议归不上就
   * 把整个归档任务标红，而真正「归档任务挂了」的那一次反而淹没在里面。
   */
  finishRun(
    id: number,
    input: { status: 'succeeded' | 'failed'; summary?: unknown; error?: string | null; now: number },
  ): Promise<void>

  /** 重叠保护跳过的一次。留一行 skipped，而不是什么都不发生——见 scheduler.ts */
  recordSkip(input: {
    jobName: string
    now: number
    blockedByRunId: number | null
  }): Promise<number>

  /**
   * 网关侧的手动触发：只排队，不执行（验收判据 5——调度器不进网关进程）。
   * 调度器下一个 tick 用 `claimQueued` 认领。
   */
  enqueueManualRun(input: {
    jobName: string
    requestedBy: string
    now: number
  }): Promise<number>

  /** 认领这个任务全部排队中的手动触发，按 id 升序。已认领的不会被第二次取到 */
  claimQueued(jobName: string, now: number): Promise<number[]>

  /**
   * 把 `ids` 这几行标成「已合并进 `intoRunId`」。
   *
   * 管理员连按三次「立即运行」是常事。三次各跑一轮完整的归档不是他要的——
   * 他要的是「现在就跑一次」。合并成一轮，另外两行留下指向那一轮的痕迹，
   * 而不是悄悄删掉（删掉的话，按下按钮却什么记录都没有，看起来像点丢了）。
   */
  coalesceRuns(ids: readonly number[], intoRunId: number, now: number): Promise<void>

  /**
   * 把残留的 running 行标成 interrupted（验收判据 3：看得出中间断了）。
   * 调度器启动时调一次。返回被标记的行数。
   *
   * ⚠️ **假定同一时刻只有一个调度器实例。** 多开一个的话，后启动的那个会把前一个
   * 正在跑的行误标成 interrupted（数据错，任务不会被中止）。
   */
  markInterrupted(now: number): Promise<number>

  findRun(id: number): Promise<JobRunRecord | null>
  /** 某个任务最近 N 次运行，倒序。§4.8 的 sparkline 读它 */
  listRuns(jobName: string, limit: number): Promise<JobRunRecord[]>

  /** 失败项落库。同一个 (jobName, target) 反复失败是累加 attempts，不是新增行 */
  recordFailure(input: RecordFailureInput): Promise<void>

  /**
   * 把「这一轮没再失败」的项标成已恢复，返回被标记的行数。
   *
   * `before` 传**这一轮的开始时刻**：一轮完整跑完之后，凡是 `last_failed_at` 早于
   * 本轮开始的未恢复项，都说明它这一轮没有再失败——要么成功了，要么已经不在待办
   * 集合里，两种都不该继续挂在「需要处理」上。
   *
   * **只在轮次真的跑完（succeeded）之后调**：轮次自己抛出时，后半截的对象根本没被
   * 处理过，它们「这轮没失败」只是因为没轮到。
   */
  resolveStaleFailures(jobName: string, before: number, now: number): Promise<number>

  listFailures(opts?: ListFailuresOptions): Promise<JobFailureRecord[]>
  /** 每个任务还有几个没处理的失败项。**没有失败项的任务不出现在返回的对象里** */
  countOpenFailures(): Promise<Record<string, number>>
}

interface RunSqlRow extends RowDataPacket {
  id: number
  job_name: string
  trigger_kind: string
  requested_by: string | null
  status: string
  started_at: number | null
  finished_at: number | null
  summary: unknown
  error: string | null
  created_at: number
}

interface FailureSqlRow extends RowDataPacket {
  id: number
  job_name: string
  target: string
  target_label: string
  meeting_id: string | null
  sub_meeting_id: string
  reason: string
  impact: string
  attempts: number
  max_attempts: number
  first_failed_at: number
  last_failed_at: number
  resolved_at: number | null
}

interface IdRow extends RowDataPacket {
  id: number
}

interface CountByJobRow extends RowDataPacket {
  job_name: string
  n: number
}

const RUN_COLS = `id, job_name, trigger_kind, requested_by, status, started_at,
                  finished_at, summary, error, created_at`

const FAILURE_COLS = `id, job_name, target, target_label, meeting_id, sub_meeting_id,
                      reason, impact, attempts, max_attempts, first_failed_at,
                      last_failed_at, resolved_at`

/**
 * BIGINT 在部分驱动配置下回来是字符串，而这些值全都要参与算术（时间差、进度条）。
 * 与 `store/programs.ts` 对 `expires_at` 的处理同一个理由。
 */
function num(v: number | string): number {
  return Number(v)
}

function nullableNum(v: number | string | null): number | null {
  return v === null ? null : Number(v)
}

/**
 * JSON 列的回读。mysql2 会把 JSON 列解析成对象，但**不同版本/配置下也可能给回
 * 字符串**（`typeCast` 被改过、某些代理层）。这里两种都接住——静默返回一个字符串
 * 会让前端拿到 `"{\"newlyArchived\":3}"` 而不是对象，而那种错在界面上表现为
 * 「摘要一片空白」，查起来要绕很远。
 */
function parseSummary(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function mapRun(r: RunSqlRow): JobRunRecord {
  return {
    id: num(r.id),
    jobName: r.job_name,
    trigger: r.trigger_kind,
    requestedBy: r.requested_by,
    status: r.status,
    startedAt: nullableNum(r.started_at),
    finishedAt: nullableNum(r.finished_at),
    summary: parseSummary(r.summary),
    error: r.error,
    createdAt: num(r.created_at),
  }
}

function mapFailure(r: FailureSqlRow): JobFailureRecord {
  return {
    id: num(r.id),
    jobName: r.job_name,
    target: r.target,
    targetLabel: r.target_label,
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    reason: r.reason,
    impact: r.impact,
    attempts: num(r.attempts),
    maxAttempts: num(r.max_attempts),
    firstFailedAt: num(r.first_failed_at),
    lastFailedAt: num(r.last_failed_at),
    resolvedAt: nullableNum(r.resolved_at),
  }
}

export function createJobsStore(pool: Pool): JobsStore {
  return {
    async startRun({ jobName, trigger, requestedBy, now }) {
      const [res] = await pool.execute<ResultSetHeader>(
        `INSERT INTO job_runs
           (job_name, trigger_kind, requested_by, status, started_at, created_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
        [jobName, trigger, requestedBy ?? null, now, now],
      )
      return res.insertId
    },

    async finishRun(id, { status, summary, error, now }) {
      await pool.execute(
        `UPDATE job_runs
            SET status = ?, finished_at = ?, summary = ?, error = ?
          WHERE id = ?`,
        [status, now, summary === undefined ? null : JSON.stringify(summary), error ?? null, id],
      )
    },

    async recordSkip({ jobName, now, blockedByRunId }) {
      // started_at 留 null：这一轮**没有开跑**。填上 now 会让它在时间轴上
      // 长得像一次瞬间跑完的运行。
      const [res] = await pool.execute<ResultSetHeader>(
        `INSERT INTO job_runs
           (job_name, trigger_kind, status, started_at, finished_at, summary, created_at)
         VALUES (?, 'schedule', 'skipped', NULL, ?, ?, ?)`,
        [jobName, now, JSON.stringify({ blockedByRunId }), now],
      )
      return res.insertId
    },

    async enqueueManualRun({ jobName, requestedBy, now }) {
      const [res] = await pool.execute<ResultSetHeader>(
        `INSERT INTO job_runs
           (job_name, trigger_kind, requested_by, status, started_at, created_at)
         VALUES (?, 'manual', ?, 'queued', NULL, ?)`,
        [jobName, requestedBy, now],
      )
      return res.insertId
    },

    async claimQueued(jobName, now) {
      // 先取 id 再按 id 更新，而不是「UPDATE … WHERE status='queued'」之后
      // 反查——那样拿不到究竟改了哪几行。`status = 'queued'` 在 UPDATE 的
      // WHERE 里再写一遍是必要的：两条语句之间调度器自己不会插手，但
      // 万一将来真开了第二个实例，这一条至少让重复认领改不动行。
      const [rows] = await pool.execute<IdRow[]>(
        `SELECT id FROM job_runs WHERE job_name = ? AND status = 'queued' ORDER BY id ASC`,
        [jobName],
      )
      const ids = rows.map((r) => num(r.id))
      if (ids.length === 0) return []
      const placeholders = ids.map(() => '?').join(', ')
      await pool.execute(
        `UPDATE job_runs SET status = 'running', started_at = ?
          WHERE status = 'queued' AND id IN (${placeholders})`,
        [now, ...ids],
      )
      return ids
    },

    async coalesceRuns(ids, intoRunId, now) {
      if (ids.length === 0) return
      const placeholders = ids.map(() => '?').join(', ')
      await pool.execute(
        `UPDATE job_runs
            SET status = 'skipped', finished_at = ?, summary = ?
          WHERE id IN (${placeholders})`,
        [now, JSON.stringify({ coalescedIntoRunId: intoRunId }), ...ids],
      )
    },

    async markInterrupted(now) {
      // 只碰 running。queued 的行**不算中断**——它还没开跑，重启后照样该被认领，
      // 标成 interrupted 等于把管理员按过的那次触发悄悄吞掉。
      const [res] = await pool.execute<ResultSetHeader>(
        `UPDATE job_runs SET status = 'interrupted', finished_at = ?
          WHERE status = 'running'`,
        [now],
      )
      return res.affectedRows
    },

    async findRun(id) {
      const [rows] = await pool.execute<RunSqlRow[]>(
        `SELECT ${RUN_COLS} FROM job_runs WHERE id = ?`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? null : mapRun(row)
    },

    async listRuns(jobName, limit) {
      // LIMIT 走字面量拼接：mysql2 的 execute（预处理协议）在部分 MySQL 版本上
      // 不接受 LIMIT 的占位符。数字先过 Math.trunc + Math.max，不是从外部原样拼进去
      const n = Math.max(1, Math.trunc(limit))
      const [rows] = await pool.execute<RunSqlRow[]>(
        `SELECT ${RUN_COLS} FROM job_runs WHERE job_name = ? ORDER BY id DESC LIMIT ${n}`,
        [jobName],
      )
      return rows.map(mapRun)
    },

    async recordFailure(i) {
      // ON DUPLICATE KEY UPDATE 的赋值**按从左到右求值**，所以引用 `resolved_at`
      // 的那三行必须排在把它清空的那一行之前——否则它们看到的是刚被写成 NULL 的值，
      // 「已恢复的行再次失败要重新计数」这条就永远进不了 else 分支。
      await pool.query(
        `INSERT INTO job_failures
           (job_name, target, target_label, meeting_id, sub_meeting_id, reason, impact,
            attempts, max_attempts, first_failed_at, last_failed_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL) AS new
         ON DUPLICATE KEY UPDATE
           target_label = new.target_label,
           meeting_id = new.meeting_id,
           sub_meeting_id = new.sub_meeting_id,
           reason = new.reason,
           impact = new.impact,
           max_attempts = new.max_attempts,
           attempts = IF(job_failures.resolved_at IS NULL, job_failures.attempts + 1, 1),
           first_failed_at =
             IF(job_failures.resolved_at IS NULL, job_failures.first_failed_at, new.first_failed_at),
           last_failed_at = new.last_failed_at,
           resolved_at = NULL`,
        [
          i.jobName,
          i.target,
          i.targetLabel,
          i.meetingId,
          i.subMeetingId,
          i.reason,
          i.impact,
          i.maxAttempts,
          i.now,
          i.now,
        ],
      )
    },

    async resolveStaleFailures(jobName, before, now) {
      const [res] = await pool.execute<ResultSetHeader>(
        `UPDATE job_failures SET resolved_at = ?
          WHERE job_name = ? AND resolved_at IS NULL AND last_failed_at < ?`,
        [now, jobName, before],
      )
      return res.affectedRows
    },

    async listFailures(opts = {}) {
      const where: string[] = []
      const params: (string | number)[] = []
      if (opts.jobName !== undefined) {
        where.push('job_name = ?')
        params.push(opts.jobName)
      }
      if (opts.includeResolved !== true) where.push('resolved_at IS NULL')
      if (opts.meetingId !== undefined) {
        where.push('meeting_id = ?')
        params.push(opts.meetingId)
        // sub_meeting_id 是 NOT NULL DEFAULT ''，所以「不给」等价于「给空串」，
        // 那正是单场会议的键。周期性会议必须显式给场次，否则会串场。
        where.push('sub_meeting_id = ?')
        params.push(opts.subMeetingId ?? '')
      }
      if (opts.meetings !== undefined) {
        // 空数组不是「不筛选」，是「这一页没有要问的会议」——直接返回空，
        // 一条查询都不发（同 `archives.listMeetingArchives`）
        if (opts.meetings.length === 0) return []
        // 行构造器 IN，走 idx_job_failure_meeting (meeting_id, sub_meeting_id)。
        // 两段一起进条件：只按 meeting_id 筛会把周期性会议的别的场次也捞进来
        const pairs = opts.meetings.map(() => '(?, ?)').join(', ')
        where.push(`(meeting_id, sub_meeting_id) IN (${pairs})`)
        for (const k of opts.meetings) params.push(k.meetingId, k.subMeetingId)
      }
      const n = Math.max(1, Math.trunc(opts.limit ?? JOB_FAILURES_DEFAULT_LIMIT))
      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      const [rows] = await pool.execute<FailureSqlRow[]>(
        `SELECT ${FAILURE_COLS} FROM job_failures ${clause}
          ORDER BY last_failed_at DESC, id DESC LIMIT ${n}`,
        params,
      )
      return rows.map(mapFailure)
    },

    async countOpenFailures() {
      const [rows] = await pool.execute<CountByJobRow[]>(
        `SELECT job_name, COUNT(*) AS n FROM job_failures
          WHERE resolved_at IS NULL GROUP BY job_name`,
      )
      const out: Record<string, number> = {}
      for (const r of rows) out[r.job_name] = num(r.n)
      return out
    },
  }
}
