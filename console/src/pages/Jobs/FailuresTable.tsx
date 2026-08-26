import type { JobsOverview } from '@/api/admin/jobs'
import { fmtDateTime } from '@/lib/format'
import { Table } from '@/ui/Table'
import { attemptsText, fmtAgo, hiddenFailureCount } from './view'
import styles from './Jobs.module.css'

/**
 * 「失败项 · 需要处理」（spec.md §4.8）。
 *
 * spec 在这一节写死了两件事，所以它们是这张表的存在理由，不是可选的列：
 *
 * > **失败项不会静默丢弃**，会一直留在下方的「失败项 · 需要处理」表里等重试，
 * > 且明写影响（「未归档，到期会永久丢失」）和已重试次数（`2 / 5`）
 *
 * 第三件事是契约给的：`failures[]` 一次最多 100 条而 `failuresTotal` 是全量总数。
 * **被截断时必须说出来**——「显示 100 条」与「一共就 100 条」在屏幕上长得一模一样，
 * 而后者会让人以为已经看完了。
 *
 * ## 为什么每行没有「重试」按钮
 *
 * 原型里有一个（`gate-console.html` 的 `data-retry`），但后端只有一条写端点
 * （`POST /api/v1/admin/jobs/:name/run`），**没有"重试这一条失败项"这个动作**。
 * 四个任务的重试是由各自的枚举源结构性驱动的：那一条失败项下一轮照样会被捞起来
 * 重试，不需要也没法单独点。把整个任务的「立即运行」伪装成行内的「重试」，
 * 点下去实际跑的是一整轮——那是一个名字和行为对不上的按钮。
 *
 * 所以这里给的是一句说明（表头下方那段），把人指回上面对应任务的「立即运行」。
 */
export function FailuresTable({ o, now }: { o: JobsOverview; now: number }) {
  const hidden = hiddenFailureCount(o)
  const base = new Date(now * 1000)
  const labelOf = (name: string): string => o.jobs.find((j) => j.name === name)?.label ?? name

  return (
    <section className={styles.failures} aria-labelledby="jobs-failures-title">
      <h2 id="jobs-failures-title" className={styles.h2}>
        失败项 · 需要处理
      </h2>

      <p className={styles.failuresNote} data-testid="failures-note">
        失败项不会被静默丢弃：它们会一直留在这张表里<b>等重试</b>
        ——由各自的任务在下一轮自动捞起来重试。想立刻重试就用上面对应任务的「立即运行」。
      </p>

      {hidden > 0 && (
        <p className={styles.truncated} data-testid="failures-truncated" role="status">
          下面只列出最近 {o.failures.length} 条；<b>一共 {o.failuresTotal} 条待处理</b>，
          还有 {hidden} 条没有列出来。
        </p>
      )}

      {o.failures.length === 0 ? (
        <p className={styles.empty} data-testid="failures-empty">
          没有待处理的失败项。
        </p>
      ) : (
        <Table data-testid="failures-table">
          <thead>
            <tr>
              <th scope="col">最近失败</th>
              <th scope="col">任务</th>
              <th scope="col">对象</th>
              <th scope="col">原因</th>
              <th scope="col">已重试</th>
              <th scope="col">影响</th>
            </tr>
          </thead>
          <tbody>
            {o.failures.map((f) => (
              <tr key={f.id} data-testid="failure-row" data-escalated={f.escalated ? 'true' : 'false'}>
                <td className={styles.nowrap}>
                  {fmtDateTime(f.lastFailedAt, base)}
                  <span className={styles.sub}>{fmtAgo(f.lastFailedAt, now)}</span>
                </td>
                <td className={styles.nowrap}>{labelOf(f.jobName)}</td>
                <td>
                  {/* 拿不到人读的名字时照 target 显示。留空会让这一行看起来
                      像"不知道是哪一场"，而 target 恰恰就是那个键 */}
                  <span className={styles.targetName}>
                    {f.targetLabel === '' ? f.target : f.targetLabel}
                  </span>
                  {f.meetingId !== null && f.meetingId !== '' && (
                    <span className={styles.sub}>
                      {f.meetingId}
                      {f.subMeetingId === '' ? '' : ` · ${f.subMeetingId}`}
                    </span>
                  )}
                </td>
                <td className={styles.reason}>{f.reason}</td>
                <td className={styles.nowrap}>
                  {attemptsText(f)}
                  {f.escalated && (
                    // 到上限的含义是**该找人了**，不是"系统放弃了"：四个任务的
                    // 重试都由各自的枚举源驱动，没有一个会因为这个数字停下来。
                    <span className={styles.escalated}>已到上限 · 需要人工介入</span>
                  )}
                </td>
                <td className={styles.impactCell}>{f.impact}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}

export default FailuresTable
