import type { ReactNode } from 'react'
import type { JobItem, JobRun } from '@/api/admin/jobs'
import { readonlyTitle, useReadonly } from '@/app/session'
import { fmtDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import {
  fmtAfter,
  fmtAgo,
  fmtSpan,
  healthView,
  keyMetric,
  runStatusText,
  sparkBars,
  sparkSummaryText,
  summaryView,
} from './view'
import styles from './Jobs.module.css'

/** 一个任务的手动触发处在哪一步。`idle` 用「没有这一项」表示。 */
export type RunState =
  | { phase: 'pending' }
  | { phase: 'done'; text: string }
  | { phase: 'error'; text: string }

/**
 * 状态点 + 一句话。这一轮全站收敛的口径（D-jobs-storage brief）：正常态不进
 * 一个彩色框，颜色只用来标"出问题"——`fail` / `warn` 两档，其余一律中性。
 * `healthView().tone` 里的 `brand`（"正在跑"）不再单独给一个蓝框：视觉上并入
 * 中性，蓝色留给按钮这类主交互，不再兼职当状态色。
 */
function StatusLine({ tone, children }: { tone: 'neutral' | 'warn' | 'fail'; children: ReactNode }) {
  return (
    <p className={styles.status} data-tone={tone}>
      <span className={styles.statusDot} aria-hidden="true" />
      {children}
    </p>
  )
}

/**
 * 近期运行的 sparkline（spec.md §4.8：「失败的那次是红的」）。
 *
 * **一次运行都没有时返回 `null`**，由调用方显示「从没跑过」。画一条空的
 * sparkline 看起来像"跑了，但什么都没发生"——那是另一件事。
 */
function Sparkline({ runs, now }: { runs: JobRun[]; now: number }) {
  const bars = sparkBars(runs, now)
  if (bars.length === 0) return null

  return (
    <div
      className={styles.spark}
      data-testid="job-spark"
      // 颜色不是唯一的信息载体：整条线有一句读屏文本，每根柱子有自己的 title。
      role="img"
      aria-label={sparkSummaryText(runs)}
    >
      {bars.map((b) => (
        <i
          key={b.runId}
          className={styles.bar}
          data-tone={b.tone}
          data-unfinished={b.unfinished ? 'true' : 'false'}
          style={{ height: `${b.heightPct}%` }}
          title={b.title}
        />
      ))}
    </div>
  )
}

/**
 * 「上次」那一行。三条分支各有各的说法，**没有一条会含糊过去**：
 *
 * - 从没跑过 → 说「一条运行记录都没有」
 * - 触发了但还没被认领（`startedAt` 为 null）→ 说清它在排队，不编一个开始时间
 * - 还没跑完（`durationSec` 为 null）→ 说「还没跑完」，不给一个会持续变大的秒数
 *
 * ## 摘要收进「本轮明细」
 *
 * 原来这一行把摘要里的每一个数都摊开写在正文里（「会议 66 · 下载完成 12 ·
 * 失败 0 · 跳过 0 · 发现资产 356」），五张卡各一段，整块读起来是一堵字墙，
 * 而其中真正要每次看一眼的只有一个数——它已经单独摆在下面的「关键数」那一格。
 * 剩下的数**不删**，收进一个默认折叠的 `<details>`：要核对的人一下就展开，
 * 不核对的人不用先读完它。上一轮的报错**不折叠**——它是这个任务此刻最要紧的
 * 一句话，藏起来就等于没说。
 */
function LastRun({ job, now }: { job: JobItem; now: number }) {
  const r = job.lastRun
  if (r === null) {
    // 「从没跑过」由状态那一行说。这里说的是同一件事的另一面：库里一条记录都没有。
    return (
      <>
        <span className={styles.factKey}>上次</span>
        <span className={styles.factVal} data-testid="job-last">
          还没有任何一条运行记录
        </span>
      </>
    )
  }

  if (r.startedAt === null) {
    return (
      <>
        <span className={styles.factKey}>上次</span>
        <span className={styles.factVal} data-testid="job-last">
          最近一次触发（{runStatusText(r.status)}）<b>还没被调度器认领</b>
        </span>
      </>
    )
  }

  const took = r.durationSec === null ? '还没跑完' : fmtSpan(r.durationSec)
  const sum = summaryView(r.summary)
  const hasError = r.error !== null && r.error !== ''

  return (
    <>
      <span className={styles.factKey}>上次</span>
      <div className={styles.factVal} data-testid="job-last">
        <span className={styles.factTime}>{fmtDateTime(r.startedAt, new Date(now * 1000))}</span>{' '}
        <span className={styles.factSub}>{fmtAgo(r.startedAt, now)}</span> · {runStatusText(r.status)} ·{' '}
        {took}
        {hasError && <span className={styles.lastError}>{r.error}</span>}
        {sum.kind !== 'none' && (
          <details className={styles.more}>
            <summary className={styles.moreHead}>本轮明细</summary>
            <p className={styles.moreBody}>
              {sum.kind === 'text' && sum.text}
              {sum.kind === 'pairs' &&
                sum.pairs.map((p) => (
                  <span key={p.key} className={styles.sumItem}>
                    {p.label} <b className={styles.sumValue}>{p.value}</b>
                  </span>
                ))}
            </p>
          </details>
        )}
      </div>
    </>
  )
}

export interface JobCardProps {
  job: JobItem
  /**
   * 链上第几步的中文序号（「一」「二」「三」）。**独立运行的任务是 null**：
   * 序号说的是"这是链上的第几步"，一个不在链上的任务没有步数可标。
   */
  ordinal: string | null
  /** 服务端的"现在"。相对时间一律拿它算，不用客户端的钟 */
  now: number
  runState: RunState | undefined
  /**
   * `job.impact` 这句话**逐字**已经在下面那张失败项表里了吗。
   *
   * 由调用方算（它才看得见 `o.failures`），判据是文字相同而不是「这个任务有没有
   * 失败行」——失败行的 `impact` 是独立的一列，可以逐条不同。理由写在
   * `index.tsx` 的 `impactShownBelow` 上。
   */
  impactShownBelow: boolean
  /**
   * 这一段与链上下一段之间那个箭头的可读文本；没有下一段（链尾 / 独立任务）
   * 时为 null。箭头本身是纯 CSS（`.job::after`），读屏读不到，所以文字在这里。
   */
  edgeText: string | null
  onRun: (name: string) => void
}

/**
 * 一个任务一张卡。同一个组件在两组里都用（见 `index.tsx`）：
 *
 * - **主链路**那一组是一行连着的几段，段间用箭头把方向画出来（`.cards[data-lane=chain]`）
 * - **独立运行**那一组是普通的等宽卡片，中间没有箭头
 *
 * 两组的列数一样（`--cols`），所以两组的卡片一样宽，横排/竖排只是外层容器的
 * `grid-template-columns` 在切，卡片内部不用跟着分叉。
 *
 * 卡住的那一段（`data-alarm="true"`）整段变红：`--fail-soft` 底 +
 * 顶部一条 `--fail` 色条（`.job[data-alarm]::before`）。
 */
export function JobCard({ job, ordinal, now, runState, impactShownBelow, edgeText, onRun }: JobCardProps) {
  const hv = healthView(job.health)
  const pending = runState?.phase === 'pending'
  const readonly = useReadonly()
  // 这个任务是不是真的出了问题——「影响」那一行只在这时候才现身（见下）。
  const trouble = hv.alarm || job.openFailures > 0
  const statusTone: 'neutral' | 'warn' | 'fail' =
    job.openFailures > 0 || hv.tone === 'fail' ? 'fail' : hv.tone === 'warn' ? 'warn' : 'neutral'
  // 「正常 · 19 项失败」自相矛盾：有失败项时「正常」两个字不说，直接说有几项失败。
  // 别的健康状态（已经落后 / 正在跑）与失败项不矛盾，两句都留。
  const statusText =
    job.openFailures > 0
      ? hv.label === '正常'
        ? `${job.openFailures} 项失败`
        : `${hv.label} · ${job.openFailures} 项失败`
      : hv.label
  const metric = keyMetric(job)

  return (
    <li className={styles.job} data-testid="job-card" data-job={job.name} data-alarm={hv.alarm ? 'true' : 'false'}>
      <div className={styles.head}>
        {ordinal !== null && <span className={styles.ord}>{ordinal}</span>}
        <h3 className={styles.name}>{job.label}</h3>
        <StatusLine tone={statusTone}>{statusText}</StatusLine>
      </div>
      <p className={styles.what}>
        {job.schedule} · {job.what}
      </p>
      {hv.note !== '' && <p className={styles.healthNote}>{hv.note}</p>}

      <div className={styles.facts}>
        <LastRun job={job} now={now} />

        {/* 「下次预计」在任务已经落后时是一句算得出来的空话：调度器停着，
            它到点也不会跑。所以这一格换标签——「按周期应在」说的是一个算出来
            的时刻，本来就不是承诺。 */}
        <span className={styles.factKey}>{hv.alarm ? '按周期应在' : '下次预计'}</span>
        <span className={styles.factVal}>
          <span className={styles.factTime}>{fmtDateTime(job.nextDueAt, new Date(now * 1000))}</span>{' '}
          <span className={styles.factSub}>{fmtAfter(job.nextDueAt, now)}</span>
        </span>

        {/* 这个任务自己的一个关键数——拿不到就不画这两格，不编一个数出来。 */}
        {metric.value !== null && (
          <>
            <span className={styles.factKey}>{metric.label}</span>
            <span className={styles.factVal}>
              <b className={styles.factNum}>{metric.value}</b>
            </span>
          </>
        )}
      </div>

      {/* 一次运行都没有时这里不画：状态行已经说了「从没跑过」，没有柱子本身就是
          "没有运行记录"，画一条空的会被读成"跑了但什么都没发生"。 */}
      {job.recentRuns.length > 0 && <Sparkline runs={job.recentRuns} now={now} />}

      {/* 「影响」是脚注，不是正文，两道闸都得过：

          1. 这个任务真的出了问题（`trouble`）。正常的任务不再各自常驻一行同一句式。
          2. **下面那张失败项表还没替它说过**（`!impactShownBelow`）。那张表的
             「如果不处理」列写的就是同一句 `job.impact`，同屏说两遍、中间
             只隔几行，是这一页「一个错误被摊在好几处」的一半。
             留下的是表说不出来的那一种：任务已经落后、但一条失败项都没有
             （调度器停了，压根没跑到会失败的那一步）——那时表是空的。 */}
      {trouble && !impactShownBelow && <p className={styles.impact}>影响：{job.impact}</p>}

      {/* 只读账号禁用而不是隐藏：藏起来会让人以为这个系统没有手动触发这回事 */}
      <Button size="sm" onClick={() => onRun(job.name)} disabled={pending || readonly} title={readonlyTitle(readonly)}>
        {pending ? '排队中…' : '立即运行'}
      </Button>

      {runState !== undefined && runState.phase !== 'pending' && (
        <p
          className={styles.runNote}
          data-testid="job-run-note"
          data-kind={runState.phase}
          role="status"
        >
          {runState.text}
        </p>
      )}

      {/* 段间箭头是 `.job::after` 画的，读屏读不到；方向这件事用一句看不见的
          文字补上，挂在卡片末尾——读到这里的人刚读完这一段，正好该知道它通向哪。 */}
      {edgeText !== null && <span className={styles.vh}>{edgeText}</span>}
    </li>
  )
}

export default JobCard
