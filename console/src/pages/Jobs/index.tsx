import { useCallback, useState } from 'react'
import { fetchJobs, runJob, type JobsOverview } from '@/api/admin/jobs'
import { useResource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { PageShell } from '@/ui/PageShell'
import { Skeleton } from '@/ui/Skeleton'
import { FailuresTable } from './FailuresTable'
import { JobCard, type RunState } from './JobCard'
import { fetchStall, overdueJobs, runQueuedNote } from './view'
import styles from './Jobs.module.css'

/**
 * 定时任务页（spec.md §4.8）。
 *
 * 它回答两个问题：**四个任务跑得怎么样**、**失败项在哪**。
 *
 * ## 「新建任务」按钮不在这里，而且是故意的（计划裁定 G-g）
 *
 * 原型里有这个按钮，点了弹一句「新建任务还没做——四个内置任务已经覆盖整条链路，
 * 先不急着开放自定义」（`docs/console/prototype/gate-console.html:3934`）。
 * 这一轮的处置是**把它删掉**，不是把那句 toast 搬过来：
 *
 * `JOB_CATALOG`（`src/store/jobs.ts`）是代码里的四个常量、不是一张表。要支持
 * 自定义任务，得先回答"执行体从哪来"——那是一个新子系统，不是一个表单。留一个
 * 点了弹「还没做」的按钮，比没有这个按钮更差：它承诺了一件不存在的事。
 *
 * 处置记在 `docs/console/spec.md` §10（明确不做），§11 缺口 3 指向那里。
 *
 * ## 这一页同时是 `tencent-down` 的来源（计划 G-d）
 *
 * 后端**没有**探测腾讯会议连通性的端点。「拉取新录制」连续失败是一个观察，
 * 由它推出"拉不通"是一个推断。措辞因此只能是观察本身，而且**只有一个出处**：
 * `api/admin/health.ts` 的 `fetchStreakText()`——本页与顶栏的系统状态条
 * import 同一个函数，两处说法不一致就等于给了两个不同的事实。
 */
export default function JobsPage() {
  const res = useResource(() => fetchJobs(), [])
  const { retry } = res
  const [runStates, setRunStates] = useState<Record<string, RunState>>({})

  const onRun = useCallback(
    (name: string) => {
      setRunStates((s) => ({ ...s, [name]: { phase: 'pending' } }))
      void runJob(name)
        .then((accepted) => {
          // **不说「已完成」**：202 的意思是"接受了，还没执行"。调度器在 worker
          // 进程里，下一个 tick 才会认领。
          //
          // 不再原样显示 `accepted.message`——那句话是写给没有界面的调用方的，
          // 在这一页会被卡片自己那行重说一遍，且末尾「刷新本页看运行记录」在
          // 控制台里是错的（下面那行 `retry()` 已经刷过了）。理由写在
          // `view.ts` 的 `runQueuedNote` 上。
          setRunStates((s) => ({ ...s, [name]: { phase: 'done', text: runQueuedNote(accepted.runId) } }))
          // 写操作 = 发请求 + 重取（计划 G-c）。这一刻运行记录里多了一行 queued，
          // 前端不自己往列表里塞一条假的。
          retry()
        })
        .catch((e: unknown) => {
          setRunStates((s) => ({
            ...s,
            [name]: { phase: 'error', text: e instanceof Error ? e.message : String(e) },
          }))
        })
    },
    [retry],
  )

  return (
    <PageShell
      title="定时任务"
      // 第二句（「失败项不会静默丢弃，会一直留在下方等重试」）删了：它在下面
      // 那张表里逐行都写着——「已自动重试 2 / 5」就是同一件事的可核对版本
      description="四个任务串起整条链路。"
    >
      {res.state === 'loading' && <Loading />}
      {res.state === 'error' && <ErrorBox message={res.error.message} onRetry={retry} />}
      {res.state === 'ready' && <Ready o={res.data} runStates={runStates} onRun={onRun} />}
    </PageShell>
  )
}

function Loading() {
  return (
    <div className={styles.loading} data-testid="jobs-loading" role="status">
      <p className={styles.loadingText}>正在读取四个任务的运行情况…</p>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={styles.loadingRow}>
          <Skeleton width="34%" />
          <Skeleton width="58%" size="sm" />
        </div>
      ))}
    </div>
  )
}

/**
 * 读不到时的出口。
 *
 * 第一句必须是「这不代表任务没在跑」：看到这一屏的人第一个想知道的就是
 * "是任务停了，还是我看不到"。这两件事的应对完全不同，而一句笼统的
 * 「加载失败」会把它们糊在一起。
 */
function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.errorBox} data-testid="jobs-error">
      <h2 className={styles.h2}>读不到任务状态</h2>
      {/* 标题已经说了「读不到」。留下的这半句是标题说不出来的那一件事：
          读不到与"没在跑"是两回事，而这两件事的应对完全不同。 */}
      <p className={styles.errorText}>
        后台服务没有响应。<b>这不代表任务没在跑</b>——调度器在另一个进程里。
      </p>
      <div className={styles.errorActs}>
        <Button variant="primary" onClick={onRetry}>
          重试
        </Button>
      </div>
      <p className={styles.errorDetail}>{message}</p>
    </div>
  )
}

function Ready({
  o,
  runStates,
  onRun,
}: {
  o: JobsOverview
  runStates: Record<string, RunState>
  onRun: (name: string) => void
}) {
  const overdue = overdueJobs(o.jobs)
  const stall = fetchStall(o.jobs)

  return (
    <>
      {overdue.length > 0 && (
        /* 原来这条横幅底下还有一段：「下面每个格子的『下次预计』照样算得出来，
           那是算术不是承诺」。那是在替一个**此刻在说谎的标签**道歉——所以改的是
           标签：落后的任务那一格现在写「按周期应在」（见 `JobCard`），
           一个算出来的时刻，不是一次承诺。这段话就不用写了。 */
        <div className={styles.banner} data-sev="fail" data-testid="jobs-overdue" role="status">
          <p className={styles.bannerText}>
            <b>
              {overdue.length} 个任务已经落后（{overdue.map((j) => j.label).join('、')}）
            </b>
            ——离上一次开跑超过两个周期，<b>调度器多半已经不在跑了</b>。
            <br />
            <span className={styles.bannerSub}>先确认调度进程还在不在。</span>
          </p>
        </div>
      )}

      {stall !== null && (
        <div className={styles.banner} data-sev="warn" data-testid="jobs-fetch-stalled" role="status">
          <p className={styles.bannerText}>
            <b>{stall.text}</b>——「{stall.label}」连着没跑成，新的录制多半正在积压。
            <br />
            {/* 主语从头到尾是那个**任务**（「最近 N 轮拉取连续失败」），
                所以「这不是对腾讯会议接口的探测」那句免责已经不必写。
                留下的是它说不出来的那件事：受影响的范围到哪儿为止。 */}
            <span className={styles.bannerSub}>
              已经拉下来的会议、归档与对外采集<b>不受影响</b>。
            </span>
          </p>
        </div>
      )}

      <ul className={styles.chain} aria-label="内置定时任务">
        {o.jobs.map((job, i) => (
          <JobCard
            key={job.name}
            job={job}
            index={i}
            now={o.now}
            runState={runStates[job.name]}
            onRun={onRun}
          />
        ))}
      </ul>

      <FailuresTable o={o} now={o.now} />
    </>
  )
}
