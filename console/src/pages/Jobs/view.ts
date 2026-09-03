/**
 * 定时任务页的呈现口径。**页面上每一句话的措辞都定在这里**，组件只管摆位置。
 *
 * 抽出来的理由是这一页最容易出的错不在布局，在措辞：
 * 「还没跑完」被说成「用了 3 分钟」、「从没跑过」被说成「正常」、
 * 「显示 100 条」被说成「一共 100 条」——三种都是把不知道的事说成知道。
 * 纯函数才测得住这些，组件测不住。
 *
 * ## 为什么相对时间的格式化在这里，不在 `lib/format.ts`
 *
 * 按全局约束，展示格式该收在 `lib/format.ts`。但 `lib/` 不在本任务的独占区里
 * （阶段 5 有七个页面任务同时在跑，`lib/format.ts` 是个汇聚点），所以这一轮先
 * 落在这里，跟着它唯一的消费者走——与新类型跟着消费者走（G-b）是同一个取舍。
 * `fmtSpan` / `fmtGap` / `fmtAfter` / `fmtAgo` 四个函数没有一点定时任务的味道，
 * 第二个页面要用它们的时候，就该把它们搬进 `lib/format.ts`。**报告里记了这一条。**
 */

import { FETCH_JOB_NAME, TENCENT_DOWN_STREAK, countConsecutiveFailures, fetchStreakText } from '@/api/admin/health'
import type { JobFailure, JobItem, JobRun, JobsOverview } from '@/api/admin/jobs'
import { fmtBytes, fmtDateTime } from '@/lib/format'
import type { PillTone } from '@/ui/Pill'

/* ══════════════════════════════════════════════════════════════════
   时长与相对时间
   ══════════════════════════════════════════════════════════════════ */

/**
 * 一段时长（秒）。三档：秒 / 分秒 / 时分。
 *
 * 负数夹到 0：调用方拿到负的时长只可能是两边的钟对不齐，显示「负 3 秒」
 * 只会让人怀疑自己看错了。
 */
export function fmtSpan(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s} 秒`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rest = s % 60
    return rest === 0 ? `${m} 分` : `${m} 分 ${rest} 秒`
  }
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/**
 * 一段间隔的**粗粒度**说法（"6 分钟" / "3 小时 12 分钟" / "2 天 2 小时"）。
 *
 * 与 `fmtSpan` 分开是因为两者回答的问题不同：耗时问的是"跑了多久"，精确到秒
 * 有意义；"还有多久到点"精确到秒只会让屏幕上多一个每秒都在变的数字。
 */
export function fmtGap(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return '不到 1 分钟'
  if (s < 3600) return `${Math.round(s / 60)} 分钟`
  if (s < 86_400) {
    let h = Math.floor(s / 3600)
    let m = Math.round((s % 3600) / 60)
    if (m === 60) {
      h += 1
      m = 0
    }
    return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`
  }
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  return h === 0 ? `${d} 天` : `${d} 天 ${h} 小时`
}

/** 距离某个未来时刻还有多久。已经过了就是「已经到点」，不显示负数倒计时。 */
export function fmtAfter(targetSec: number, nowSec: number): string {
  const diff = targetSec - nowSec
  return diff <= 0 ? '已经到点' : `${fmtGap(diff)}后`
}

/** 某个过去时刻离现在多久。一分钟以内是「刚刚」。 */
export function fmtAgo(pastSec: number, nowSec: number): string {
  const diff = nowSec - pastSec
  return diff < 60 ? '刚刚' : `${fmtGap(diff)}前`
}

/* ══════════════════════════════════════════════════════════════════
   健康状态
   ══════════════════════════════════════════════════════════════════ */

export interface HealthView {
  label: string
  tone: PillTone
  /**
   * 这个状态到底意味着什么。**空串表示不需要额外解释**，而四个已知取值现在
   * 全都是空串——见下面 `healthView` 的注释：徽标的字与颜色已经把它们说完了。
   */
  note: string
  /** 是不是"该有人管一下"级别。只有 overdue 是 —— 它的意思是调度器多半挂了 */
  alarm: boolean
}

/**
 * `jobs[].health` 的四个取值各有各的呈现。
 *
 * 两条不能含糊：
 *
 * - **`never_ran` 不是故障**。一个刚部署的实例本来就没跑过，把它画成红的会让
 *   每次部署后都亮一片红，真正的故障就淹死在里面。
 * - **`overdue` 的意思是"调度器多半挂了"**，不是"这次晚了一点"。后端的阈值是
 *   两个周期（一个周期会被正常的 tick 抖动误判），所以它一旦出现就是真的。
 *   这一条要显眼——「界面上一切正常、实际调度器已经死了三天」正是它存在的理由。
 *
 * 认不出的取值给「未知」并把原值带出来。**不给「正常」**：把没见过的状态映成
 * 已知的任何一个都是编造，而映成"正常"是其中最糟的那一种。
 *
 * ## 四个已知取值的 `note` 现在都是空串
 *
 * 它们原来各带一句解释，于是**同一句话会在四张卡片上出现四遍**——刚部署的实例
 * 四个任务全是 `never_ran`，屏幕上就有四行一模一样的「一次都没跑过。刚部署的
 * 实例就是这样，和调度器停了不是一回事。」
 *
 * 这两件事本来就由别的东西说：
 *
 * - **`never_ran` 与「调度器停了」分得开**，靠的是它们是两个不同的徽标、
 *   两种不同的颜色（中性 vs `fail`），不是靠一句「不是一回事」。
 * - **`overdue` 意味着什么**，页面顶上那条 `jobs-overdue` 横幅逐字说着，
 *   而那条横幅只在有任务落后时出现——正好是卡片会带这句解释的同一时刻。
 *
 * 认不出的取值仍留一句：那时徽标只说得出「这个值我不认识」，说不出该怎么办。
 */
export function healthView(health: string): HealthView {
  switch (health) {
    case 'never_ran':
      return { label: '从没跑过', tone: 'neutral', note: '', alarm: false }
    case 'running':
      return { label: '正在跑', tone: 'brand', note: '', alarm: false }
    case 'overdue':
      return { label: '已经落后', tone: 'fail', note: '', alarm: true }
    case 'ok':
      return { label: '正常', tone: 'neutral', note: '', alarm: false }
    default:
      return {
        label: `未知状态「${health}」`,
        tone: 'warn',
        note: '这个取值这里认不出，没有被映成任何一个已知状态——请把它报给维护者。',
        alarm: false,
      }
  }
}

/**
 * 点完「立即运行」之后卡片上那一句。
 *
 * ## 为什么不照抄后端那句话
 *
 * 后端回的 `message` 是写给**没有界面的调用方**的（curl、另一个服务）：屏幕上
 * 没有别的东西，所以它得在一个字符串里把整套执行模型解释完——「定时任务由
 * worker 进程的调度器执行（网关是多实例的，不能在这里跑），它会在下一个 tick
 * 认领这一次触发——刷新本页看运行记录。」73 个字。
 *
 * 这一页有卡片。触发之后 `retry()` 会重取一遍，卡片自己那行随即写着「最近一次
 * 触发（排队中）还没被调度器认领」——同一个事实，20 个字。照抄等于把它说第二遍、
 * 而且长 3.6 倍；四个任务都点一遍，屏幕上就是四段一模一样的 73 字。
 *
 * 更要紧的是那句话的末尾**在控制台里是错的**：「刷新本页看运行记录」——`retry()`
 * 已经刷过了。照做不会有任何变化。一条让人白做一次动作的指示，比啰嗦更糟。
 *
 * ## 那留下什么
 *
 * 卡片说不出来的那件事：**你刚才那一下被接受了**，以及它的编号。
 *
 * 这一句不能省。调度器停着的时候——正是最想点这颗按钮的时候——四张卡片本来就
 * 都写着「排队中，还没被认领」，点下去屏幕上什么都不变，看起来像按钮坏了。
 *
 * 编号不是装饰：审计里那一行记的就是 `run #<id>`，它是把「我刚才点的那一下」
 * 和事后翻出来的那条记录对上的唯一凭据。
 */
export function runQueuedNote(runId: number): string {
  return `已排队 #${runId}，等调度器下一轮认领。`
}

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '正在跑',
  succeeded: '成功',
  failed: '失败',
  interrupted: '被中断',
  skipped: '跳过',
}

/** 一次运行的状态。认不出的原样带出来，不映成任何一个已知状态。 */
export function runStatusText(status: string): string {
  return RUN_STATUS_LABEL[status] ?? `未知状态「${status}」`
}

/* ══════════════════════════════════════════════════════════════════
   sparkline
   ══════════════════════════════════════════════════════════════════ */

/**
 * 柱子的最矮高度（百分比）。耗时为 0 的一轮也是一轮真的运行，塌成 0 就等于
 * 在图上把它删掉了。
 */
export const SPARK_MIN_PCT = 12

export interface SparkBar {
  runId: number
  /** 柱高百分比，`SPARK_MIN_PCT`..100 */
  heightPct: number
  /**
   * 这一轮还没跑完（`durationSec === null`）。**高度不表示耗时**——
   * 拿"到现在为止"去算会让它每刷新一次就长高一点，看起来像已经跑完了。
   */
  unfinished: boolean
  tone: 'ok' | 'fail' | 'other'
  /** 悬浮提示与读屏文本 */
  title: string
}

/**
 * 把 `recentRuns` 变成一排柱子。**从旧到新**：`recentRuns[0]` 是最近一次，
 * 而时间轴上最近的一次该在最右边。
 *
 * 高度按窗口内最长耗时归一。`durationSec` 为 null 的那几轮不参与归一，也不
 * 给高度——它们用 `unfinished` 单独表示。
 *
 * 返回空数组时**不要画一条空的 sparkline**：调用方该显示「从没跑过」。
 * 一条空的折线看起来像"跑了但什么都没有"，那是另一回事。
 */
export function sparkBars(runs: readonly JobRun[], nowSec: number): SparkBar[] {
  const base = new Date(nowSec * 1000)
  const durations = runs.map((r) => r.durationSec).filter((d): d is number => d !== null)
  const max = durations.length === 0 ? 0 : Math.max(...durations)

  return [...runs].reverse().map((r) => {
    const unfinished = r.durationSec === null
    const heightPct =
      unfinished || max <= 0
        ? SPARK_MIN_PCT
        : Math.max(SPARK_MIN_PCT, Math.round((r.durationSec! / max) * 100))

    const tone: SparkBar['tone'] =
      r.status === 'failed' ? 'fail' : r.status === 'succeeded' ? 'ok' : 'other'

    const when = r.startedAt === null ? '还没开跑' : fmtDateTime(r.startedAt, base)
    const took = unfinished ? '还没跑完' : fmtSpan(r.durationSec!)
    const title =
      r.startedAt === null
        ? `${when} · ${runStatusText(r.status)}`
        : `${when} · ${runStatusText(r.status)} · ${took}`

    return { runId: r.id, heightPct, unfinished, tone, title }
  })
}

/** 整条 sparkline 的读屏文本。颜色不是唯一的信息载体。 */
export function sparkSummaryText(runs: readonly JobRun[]): string {
  const failed = runs.filter((r) => r.status === 'failed').length
  const unfinished = runs.filter((r) => r.durationSec === null).length
  const parts = [`最近 ${runs.length} 次运行`, `失败 ${failed} 次`]
  if (unfinished > 0) parts.push(`还没跑完 ${unfinished} 次`)
  return parts.join('，')
}

/* ══════════════════════════════════════════════════════════════════
   运行摘要（job_runs.summary）
   ══════════════════════════════════════════════════════════════════ */

/**
 * `summary` 里各个键的中文。来源是 `src/worker/scheduler.ts` 的
 * `createJobRunners`——五个任务各自 return 的那个对象。
 *
 * **认不出的键原样显示**，不丢。后端加一个字段时界面上会出现一个英文键名，
 * 那是一个看得见的提醒；悄悄丢掉才是问题。
 */
const SUMMARY_LABEL: Record<string, string> = {
  // fetch_recordings
  meetings: '会议',
  discovered: '发现资产',
  completed: '下载完成',
  probes: '探测',
  manifests: '清单',
  // archive_nas
  newlyArchived: '新归档',
  verificationFailed: '校验不通过',
  sidecarFailed: '旁挂文件失败',
  undecidable: '判不出来',
  // cleanup_expired
  purged: '已清理',
  purgedBytes: '释放空间',
  paused: '被暂停',
  // refresh_inventory
  programs: '采集程序',
  fetchable: '可采集',
  blocked: '被挡下',
  failedPrograms: '算不出的程序',
  // auto_grant（`programs` / `failedPrograms` 与上一条共用）
  candidates: '规则放行',
  granted: '新授权',
  // 「人工撤销过」是这一条的全部意思：人的决定压过开关，不会被自动补回来
  skippedRevoked: '人工撤销过，跳过',
  // 多个任务共用
  failed: '失败',
  skipped: '跳过',
}

export interface SummaryPair {
  key: string
  label: string
  value: string
}

export type SummaryView =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'pairs'; pairs: SummaryPair[] }

/**
 * 把一次运行的摘要变成可显示的东西。形状是任意 JSON（见 `api/admin/jobs.ts`
 * 文件头），所以这里对每种取值都有明确的处置，**没有一个分支是"显示 [object Object]"**：
 *
 * - 数字：直接显示；键名以 `Bytes` 结尾的走 `fmtBytes`
 * - 布尔：是 / 否（`paused: false` 报成空白会让人以为清理跑过了）
 * - 字符串：原样
 * - 数组：给条数（`programs` 是逐程序的明细，摘要行里只需要"几个"）
 * - 其它（嵌套对象 / null）：跳过。摘要行不是 JSON 查看器
 */
export function summaryView(summary: unknown): SummaryView {
  if (summary === null || summary === undefined) return { kind: 'none' }
  if (typeof summary === 'string') {
    return summary === '' ? { kind: 'none' } : { kind: 'text', text: summary }
  }
  if (typeof summary === 'number' || typeof summary === 'boolean') {
    return { kind: 'text', text: String(summary) }
  }
  if (typeof summary !== 'object' || Array.isArray(summary)) return { kind: 'none' }

  const pairs: SummaryPair[] = []
  for (const [key, value] of Object.entries(summary as Record<string, unknown>)) {
    const label = SUMMARY_LABEL[key] ?? key
    if (typeof value === 'number') {
      pairs.push({ key, label, value: key.endsWith('Bytes') ? fmtBytes(value) : String(value) })
      continue
    }
    if (typeof value === 'boolean') {
      pairs.push({ key, label, value: value ? '是' : '否' })
      continue
    }
    if (typeof value === 'string') {
      pairs.push({ key, label, value })
      continue
    }
    if (Array.isArray(value)) {
      pairs.push({ key, label, value: `${value.length} 项` })
    }
  }
  return pairs.length === 0 ? { kind: 'none' } : { kind: 'pairs', pairs }
}

/* ══════════════════════════════════════════════════════════════════
   失败项
   ══════════════════════════════════════════════════════════════════ */

/** 已重试次数。spec §4.8 逐字给的是分数形式（`2 / 5`），不是"重试了 2 次"。 */
export function attemptsText(f: Pick<JobFailure, 'attempts' | 'maxAttempts'>): string {
  return `${f.attempts} / ${f.maxAttempts}`
}

/**
 * 被 `FAILURES_PAGE_LIMIT` 截掉了多少条。
 *
 * `failuresTotal` 是全量总数、`failures` 最多 100 条，两者一减就是没列出来的
 * 条数。差值为正时界面上必须说出来——否则「显示 100 条」与「一共就 100 条」
 * 在屏幕上长得一模一样，而后者会让人以为已经看完了。
 */
export function hiddenFailureCount(o: Pick<JobsOverview, 'failures' | 'failuresTotal'>): number {
  return Math.max(0, o.failuresTotal - o.failures.length)
}

/* ══════════════════════════════════════════════════════════════════
   跨任务的判断
   ══════════════════════════════════════════════════════════════════ */

/** 哪些任务已经落后。它们意味着调度器多半挂了，值得一条页面级的横幅。 */
export function overdueJobs(jobs: readonly JobItem[]): JobItem[] {
  return jobs.filter((j) => healthView(j.health).alarm)
}

export interface FetchStall {
  streak: number
  label: string
  /** **唯一出处是 `api/admin/health.ts` 的 `fetchStreakText()`**，见下 */
  text: string
  /**
   * 这一段连续失败里**最新那一次 failed 运行**的 id ——「这是哪一段故障」的身份。
   *
   * 它存在的理由只有一个：横幅可以关（`./dismiss.ts`），而"关掉"必须只对
   * 眼前这一段故障生效。id 会随着又失败一轮而变大，那时横幅重新出现。
   */
  latestFailedRunId: number
}

/**
 * 「拉取连续失败」的推断（计划 G-d）。
 *
 * 后端**没有**探测腾讯会议连通性的端点，有的只是"拉取任务最近几轮都失败了"
 * 这个观察。所以措辞必须是观察（"最近 N 轮拉取连续失败"），不能是结论
 * （"腾讯会议不可达"）——那是在替一个我们没有的探测下结论。
 *
 * 这句话本页与顶栏的系统状态条两处都要显示，**所以它只能有一个出处**：
 * `fetchStreakText()`。这里 import 它，不另写一句；连续失败的数法也直接用
 * `countConsecutiveFailures()`（排队 / 正在跑 / 跳过跨过去，成功与被中断打断计数），
 * 两处口径差一点，界面上就会出现"状态条说连续失败、任务页说正常"。
 *
 * ## `latestFailedRunId` 为什么是「第一条 failed」，而不是另走一遍跳过规则
 *
 * 跳过规则只能有一份，就在 `countConsecutiveFailures()` 里。这里**不复制**它：
 * `streak ≥ 1` 已经保证了 `recentRuns` 的开头是"若干条 queued/running/skipped
 * 再接一条 failed"——在那条 failed 之前不可能出现另一条 failed。所以整个数组里
 * **第一条 `status === 'failed'`** 与"沿着连续失败往回数够到的最新那一条"是同一条，
 * 一个 `find` 就够了，不需要第二套跳过规则跟着第一套一起漂。
 */
export function fetchStall(jobs: readonly JobItem[]): FetchStall | null {
  const job = jobs.find((j) => j.name === FETCH_JOB_NAME)
  if (job === undefined) return null
  const streak = countConsecutiveFailures(job.recentRuns.map((r) => r.status))
  if (streak < TENCENT_DOWN_STREAK) return null
  // streak ≥ TENCENT_DOWN_STREAK ≥ 1 ⇒ 这一条一定找得到（理由见上）。
  // 万一将来阈值被改成 0，这里宁可不报也不编一个 id——身份错了比没有更糟：
  // 关掉一次就会把一段根本不同的故障也一起藏掉。
  const latestFailed = job.recentRuns.find((r) => r.status === 'failed')
  if (latestFailed === undefined) return null
  return {
    streak,
    label: job.label,
    text: fetchStreakText(streak),
    latestFailedRunId: latestFailed.id,
  }
}

/** spec §4.8 的表把五个任务排成一到五——它们串起的是一整条链路。 */
const CN_ORDINALS = ['一', '二', '三', '四', '五']

export function jobOrdinal(index: number): string {
  return CN_ORDINALS[index] ?? String(index + 1)
}

/* ══════════════════════════════════════════════════════════════════
   链上每一段自己的关键数（D-jobs-storage brief）
   ══════════════════════════════════════════════════════════════════ */

/**
 * 五个内置任务各自在 `lastRun.summary` 里最该被单独摆出来的那一个键。
 *
 * 不是"摘要里第一个数字"这种通用规则——那要求后端按重要性排列对象键，
 * 是一个没人保证过的隐含约定。这里按任务语义显式指定，键名与 `SUMMARY_LABEL`
 * 共用同一份中文，不另造一套叫法。
 */
const KEY_METRIC_FIELD: Record<string, string> = {
  fetch_recordings: 'discovered',
  archive_nas: 'newlyArchived',
  cleanup_expired: 'purged',
  refresh_inventory: 'fetchable',
  // 「这一轮真的写进 meeting_grants 几条」——candidates 是分母，granted 才是发生的事
  auto_grant: 'granted',
}

export interface KeyMetric {
  /** 认不出的任务名给空串——调用方据此不画这一行 */
  label: string
  /** 摘要里没有这个键、或压根没有摘要时是 null，不编一个数出来 */
  value: string | null
}

/**
 * 一个任务这一次运行里，那个只属于它自己的数。**没有就是没有**：
 * `lastRun` 为 null、`summary` 为 null、或摘要里没有这个键，一律返回
 * `value: null`——调用方（`JobCard`）据此不画这一格，不是显示一个 0 或 `—`
 * 冒充"探测过了"。
 */
export function keyMetric(job: Pick<JobItem, 'name' | 'lastRun'>): KeyMetric {
  const field = KEY_METRIC_FIELD[job.name]
  if (field === undefined) return { label: '', value: null }
  const label = SUMMARY_LABEL[field] ?? field
  if (job.lastRun === null) return { label, value: null }
  const sum = summaryView(job.lastRun.summary)
  if (sum.kind !== 'pairs') return { label, value: null }
  const pair = sum.pairs.find((p) => p.key === field)
  return { label, value: pair === undefined ? null : pair.value }
}
