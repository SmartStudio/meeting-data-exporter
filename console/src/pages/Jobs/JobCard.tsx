import type { JobItem, JobRun } from '@/api/admin/jobs'
import { readonlyTitle, useReadonly } from '@/app/session'
import { fmtDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import {
  fmtAfter,
  fmtAgo,
  fmtSpan,
  healthView,
  jobOrdinal,
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
 * - 从没跑过 → 说「从没跑过」
 * - 触发了但还没被认领（`startedAt` 为 null）→ 说清它在排队，不编一个开始时间
 * - 还没跑完（`durationSec` 为 null）→ 说「还没跑完」，不给一个会持续变大的秒数
 */
function LastRun({ job, now }: { job: JobItem; now: number }) {
  const r = job.lastRun
  if (r === null) {
    // 「从没跑过」这句话已经在健康徽标和 sparkline 那一格里说过两遍了，
    // 这里换个说法说同一件事的另一面：一条运行记录都没有。
    return (
      <p className={styles.last} data-testid="job-last">
        还没有任何一条运行记录。
      </p>
    )
  }

  if (r.startedAt === null) {
    return (
      <p className={styles.last} data-testid="job-last">
        最近一次触发（{runStatusText(r.status)}）<b>还没被调度器认领</b>
        ——调度器在 worker 进程里，下一个 tick 才会来取。
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

export function JobCard({ job, index, now, runState, onRun }: JobCardProps) {
  const hv = healthView(job.health)
  const pending = runState?.phase === 'pending'
  const readonly = useReadonly()

  return (
    <li className={styles.job} data-testid="job-card" data-job={job.name} data-alarm={hv.alarm ? 'true' : 'false'}>
      <div className={styles.main}>
        <h3 className={styles.name}>
          <span className={styles.ord}>{jobOrdinal(index)}、</span>
          {job.label}
          <Pill tone={hv.tone}>{hv.label}</Pill>
          {job.openFailures > 0 && (
            <Pill tone="fail" solid>
              {job.openFailures} 项失败
            </Pill>
          )}
        </h3>
        <p className={styles.what}>
          {job.schedule} · {job.what}
        </p>
        {hv.note !== '' && <p className={styles.healthNote}>{hv.note}</p>}
        <LastRun job={job} now={now} />
        {/* 这个任务没跑成的后果。spec §4.8 要求明写，失败项表里也有同一句 */}
        <p className={styles.impact}>没跑成的后果：{job.impact}</p>
      </div>

      <div className={styles.right}>
        {job.recentRuns.length === 0 ? (
          <p className={styles.noRuns}>从没跑过</p>
        ) : (
          <Sparkline runs={job.recentRuns} now={now} />
        )}
        <div className={styles.next}>
          {/* 「预计」不是「承诺」：调度器停了这个时刻照样算得出，所以它永远和
              health 一起看，不能单独当"一切正常"的证据。 */}
          <span className={styles.nextKey}>下次预计</span>
          <b className={styles.nextAt}>{fmtDateTime(job.nextDueAt, new Date(now * 1000))}</b>
          <span className={styles.nextGap}>{fmtAfter(job.nextDueAt, now)}</span>
        </div>
        {/* 只读账号禁用而不是隐藏：藏起来会让人以为这个系统没有手动触发这回事 */}
        <Button size="sm" onClick={() => onRun(job.name)} disabled={pending || readonly} title={readonlyTitle(readonly)}>
          {pending ? '排队中…' : '立即运行'}
        </Button>
      </div>

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
