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
  jobOrdinal,
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
 * 「上次运行」那一行。三条分支各有各的说法，**没有一条会含糊过去**：
 *
 * - 从没跑过 → 说「一条运行记录都没有」
 * - 触发了但还没被认领（`startedAt` 为 null）→ 说清它在排队，不编一个开始时间
 * - 还没跑完（`durationSec` 为 null）→ 说「还没跑完」，不给一个会持续变大的秒数
 */
function LastRun({ job, now }: { job: JobItem; now: number }) {
  const r = job.lastRun
  if (r === null) {
    // 「从没跑过」由健康徽标说。这里说的是同一件事的另一面：库里一条记录都没有。
    return (
      <p className={styles.last} data-testid="job-last">
        还没有任何一条运行记录。
      </p>
    )
  }

  if (r.startedAt === null) {
    return (
      <p className={styles.last} data-testid="job-last">
        最近一次触发（{runStatusText(r.status)}）<b>还没被调度器认领</b>。
      </p>
    )
  }

  const took = r.durationSec === null ? '还没跑完' : `耗时 ${fmtSpan(r.durationSec)}`
  const sum = summaryView(r.summary)

  return (
    <p className={styles.last} data-testid="job-last">
      上次 {fmtDateTime(r.startedAt, new Date(now * 1000))}（{fmtAgo(r.startedAt, now)}） ·{' '}
      {runStatusText(r.status)} · {took}
      {sum.kind === 'text' && <span className={styles.sumItem}>{sum.text}</span>}
      {sum.kind === 'pairs' &&
        sum.pairs.map((p) => (
          <span key={p.key} className={styles.sumItem}>
            {p.label} <b className={styles.sumValue}>{p.value}</b>
          </span>
        ))}
      {r.error !== null && r.error !== '' && (
        <span className={styles.lastError}>{r.error}</span>
      )}
    </p>
  )
}

export interface JobCardProps {
  job: JobItem
  index: number
  /** 服务端的"现在"。相对时间一律拿它算，不用客户端的钟 */
  now: number
  runState: RunState | undefined
  onRun: (name: string) => void
}

/**
 * 链上的一段（原「竖排卡片」，现在四段横向并排成一条流水——D-jobs-storage
 * brief）。四个任务是**串起来的一条链**：第一步不跑，后三步就没有输入。
 * 容器（`ul.chain`，见 `index.tsx`）在 1440 宽是一行四段，段间用一个箭头把
 * 方向画出来（纯 CSS `::after`，不额外起 DOM）；窄屏（1050 / 375）退回竖排
 * （见 `Jobs.module.css` 里那条按宽度收窄的媒体查询）——每一段内部本来就是
 * 单列纵向排布，横排/竖排只是外层容器的 `grid-template-columns` 在切，
 * 段内布局不用跟着分叉。
 *
 * 卡住的那一段（`data-alarm="true"`）整段变红：`--fail-soft` 底 +
 * 顶部一条 `--fail` 色条（`.job[data-alarm]::before`）。
 */
export function JobCard({ job, index, now, runState, onRun }: JobCardProps) {
  const hv = healthView(job.health)
  const pending = runState?.phase === 'pending'
  const readonly = useReadonly()
  // 这个任务是不是真的出了问题——「没跑成的后果」只在这时候才现身（见下）。
  const trouble = hv.alarm || job.openFailures > 0
  const statusTone: 'neutral' | 'warn' | 'fail' =
    job.openFailures > 0 || hv.tone === 'fail' ? 'fail' : hv.tone === 'warn' ? 'warn' : 'neutral'
  const metric = keyMetric(job)

  return (
    <li className={styles.job} data-testid="job-card" data-job={job.name} data-alarm={hv.alarm ? 'true' : 'false'}>
      <div className={styles.head}>
        <span className={styles.ord}>{jobOrdinal(index)}</span>
        <h3 className={styles.name}>{job.label}</h3>
      </div>
      <p className={styles.what}>
        {job.schedule} · {job.what}
      </p>

      <StatusLine tone={statusTone}>
        {hv.label}
        {job.openFailures > 0 && ` · ${job.openFailures} 项失败`}
      </StatusLine>
      {hv.note !== '' && <p className={styles.healthNote}>{hv.note}</p>}

      <LastRun job={job} now={now} />

      {/* 一次运行都没有时这里不画：徽标已经说了「从没跑过」，没有柱子本身就是
          "没有运行记录"，画一条空的会被读成"跑了但什么都没发生"。 */}
      {job.recentRuns.length > 0 && <Sparkline runs={job.recentRuns} now={now} />}

      <div className={styles.next}>
        {/* 「下次预计」在任务已经落后时是一句算得出来的空话：调度器停着，
            它到点也不会跑。所以这一格换标签——「按周期应在」说的是一个算出来
            的时刻，本来就不是承诺。 */}
        <span className={styles.nextKey}>{hv.alarm ? '按周期应在' : '下次预计'}</span>
        <b className={styles.nextAt}>{fmtDateTime(job.nextDueAt, new Date(now * 1000))}</b>
        <span className={styles.nextGap}>{fmtAfter(job.nextDueAt, now)}</span>
        {/* 这个任务自己的一个关键数——拿不到就不画这两行，不编一个数出来。 */}
        {metric.value !== null && (
          <>
            <span className={styles.nextKey}>{metric.label}</span>
            <b className={styles.nextAt}>{metric.value}</b>
          </>
        )}
      </div>

      {/* 「没跑成的后果」是脚注，不是正文：只在这个任务真的出问题时才现身。
          正常的三个任务不再各自常驻一行一模一样句式的「没跑成的后果：……」；
          真正失败的那几项，后果已经在下面「失败项 · 需要处理」表的
          「如果不处理」列里逐条写过一次，这里只补它自己那一句。 */}
      {trouble && <p className={styles.impact}>没跑成的后果：{job.impact}</p>}

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
    </li>
  )
}

export default JobCard
