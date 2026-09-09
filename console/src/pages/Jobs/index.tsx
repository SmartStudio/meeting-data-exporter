import { useCallback, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { fetchJobs, newestFailedAt, runJob, type JobItem, type JobsOverview } from '@/api/admin/jobs'
import { useResource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { PageShell } from '@/ui/PageShell'
import { Skeleton } from '@/ui/Skeleton'
import { FailuresTable } from './FailuresTable'
import { JobCard, type RunState } from './JobCard'
import { useMarkFailuresSeen } from '@/app/failuresSeen'
import { useDismissedBanner, useDismissedStall, OVERDUE_DISMISS_KEY } from './dismiss'
import { chainEdgeText, fetchStall, jobOrdinal, overdueIdentity, overdueJobs, runQueuedNote, splitLanes } from './view'
import styles from './Jobs.module.css'

/**
 * 定时任务页（spec.md §4.8）。
 *
 * 它回答两个问题：**任务跑得怎么样**、**失败项在哪**。
 *
 * ## 两组，不是一行五格
 *
 * 五个任务原来排成一行四格（第五个孤零零掉到第二行），格与格之间一律画箭头——
 * 于是「清理到期文件 → 刷新采集清单」也被画成了因果，而那两个任务谁也不接谁。
 * 真正串成一条链的只有三个（拉取 → 归档 → 自动授权，后端 `JOB_CHAINS`），
 * 页面就按这个事实分两组：**主链路**连着画、段间有箭头；**独立运行**是普通卡片。
 * 分组的判据在 `view.ts` 的 `splitLanes`，任务再多也只是两组各自变长。
 *
 * ## 「新建任务」按钮不在这里，而且是故意的（计划裁定 G-g）
 *
 * 原型里有这个按钮，点了弹一句「新建任务还没做——内置任务已经覆盖整条链路，
 * 先不急着开放自定义」（`docs/console/prototype/gate-console.html:3934`）。
 * 这一轮的处置是**把它删掉**，不是把那句 toast 搬过来：
 *
 * `JOB_CATALOG`（`src/store/jobs.ts`）是代码里的五个常量、不是一张表。要支持
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

  // 列表读完 = 失败项「看过了」，左栏那颗红点靠这个灭（`app/failuresSeen.ts`）。
  // 加载中 / 读失败传 undefined：没看到列表不算看过。
  useMarkFailuresSeen(res.state === 'ready' ? newestFailedAt(res.data.failures) : undefined)
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
    /* 页头那句「五个任务串起整条链路。」删了：它说的不是事实（只有三个串在
       一条链上），而两组各自的标题下面现在各有一句准确的。没有说明句时
       PageShell 整条页头都不画，内容直接从顶栏下面开始。 */
    <PageShell title="定时任务">
      {res.state === 'loading' && <Loading />}
      {res.state === 'error' && <ErrorBox message={res.error.message} onRetry={retry} />}
      {res.state === 'ready' && <Ready o={res.data} runStates={runStates} onRun={onRun} />}
    </PageShell>
  )
}

function Loading() {
  return (
    <div className={styles.loading} data-testid="jobs-loading" role="status">
      <p className={styles.loadingText}>正在读取任务运行情况…</p>
      {[0, 1, 2, 3, 4].map((i) => (
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

/**
 * 一组任务：一个标题、一句这组是怎么跑的、一排卡片。
 *
 * `--cols` 两组都传同一个数（链的长度），所以两组的卡片一样宽；链上有几段就
 * 几列，独立组按同样的列数折行。窄屏（≤72em）两组都退回单列（见 CSS）。
 */
function Lane({
  id,
  lane,
  title,
  sub,
  cols,
  children,
}: {
  id: string
  lane: 'chain' | 'solo'
  title: string
  sub: string
  cols: number
  children: ReactNode
}) {
  const titleId = `jobs-lane-${id}`
  return (
    <section className={styles.lane} aria-labelledby={titleId} data-testid={`jobs-lane-${id}`}>
      <div className={styles.laneHead}>
        <h2 id={titleId} className={styles.laneTitle}>
          {title}
        </h2>
        <p className={styles.laneSub}>{sub}</p>
      </div>
      {/* aria-label 就是组标题：a11y 门槛（`scripts/a11y-check.ts`）按 `ul[aria-label="主链路"]`
          找这一组，测试也按名字找。 */}
      <ul className={styles.cards} data-lane={lane} aria-label={title} style={{ '--cols': cols } as CSSProperties}>
        {children}
      </ul>
    </section>
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
  const lanes = splitLanes(o.jobs)
  // 链是空的（后端一个链上任务都没发）时按三列排独立组，别让它们铺成整行宽。
  const cols = Math.max(lanes.chain.length, 3)

  /**
   * 这条横幅关得掉——但只对**眼前这一段**故障有效。身份、存储与"故障结束就忘掉"
   * 的理由都写在 `./dismiss.ts` 的文件头。
   *
   * 它是这句话在页面上的唯一出口：顶栏的全局状态条不再显示「拉取连续失败」
   * （理由见 `app/SystemStatus.tsx` 里 `fetch-stalled` 那一行的注释），左栏底部摘要
   * 与红点只提一句。所以这里既要把话说全，也要能关——知道了的人在等修复期间
   * 还要继续用这一页。
   *
   * 上面那条 `jobs-overdue`（「调度器多半已经不在跑了」）用的是同一套机制，见下面
   * `overdueId` 那一段的注释。
   */
  const { hidden: stallDismissed, dismiss: dismissStall } = useDismissedStall(stall)

  /**
   * 落后横幅也关得掉，粒度是**这一批落后**（`overdueIdentity`）。
   *
   * 从前它不给关闭按钮，理由是「顶栏的 liveAlert() 不报 overdue，关掉就等于把
   * 『调度器死了』从整个控制台里抹掉」。那条理由是对的，所以关掉的不是这件事
   * 本身而是这一批：任一落后任务再跑一轮、或落后集合变了，它就回来。知道了的人
   * 在等修复期间还要继续用这一页，而一条关不掉的横幅会把四张卡片一直往下挤。
   */
  const overdueId = overdueIdentity(o.jobs)
  const { hidden: overdueDismissed, dismiss: dismissOverdue } = useDismissedBanner(
    OVERDUE_DISMISS_KEY,
    overdueId,
  )

  /**
   * 卡片上那句「影响」是不是**逐字**已经在下面那张表里了。
   *
   * 判据是**文字本身相同**，不是「这个任务有没有失败行」——那只是个代理指标，
   * 而它会错：`scheduler.ts` 把 `spec.impact` 原样写进失败行，所以生产环境里
   * 两处确实是同一句；但失败行的 `impact` 是**一个独立的列**，可以逐条不同
   * （原型数据就是这样写的：「未归档。本地保留期一到，这场会议就永久没有了。」
   * 与任务级的那句并不一样）。按代理指标抑制，会把一句根本不重复的话也藏掉——
   * 这一版就是这么错的，靠把页面真的渲染出来才发现。
   *
   * 用 `o.failures`（屏幕上那一批）而不是 `job.openFailures > 0`：那张表一次
   * 最多 100 条，被截断掉的行不在屏幕上，那时卡片这句是唯一的出处。
   */
  const impactShownBelow = (name: string, impact: string): boolean =>
    o.failures.some((f) => f.jobName === name && f.impact === impact)

  const card = (job: JobItem, ordinal: string | null, next: JobItem | undefined) => (
    <JobCard
      key={job.name}
      job={job}
      ordinal={ordinal}
      now={o.now}
      runState={runStates[job.name]}
      impactShownBelow={impactShownBelow(job.name, job.impact)}
      edgeText={next === undefined ? null : chainEdgeText(job, next)}
      onRun={onRun}
    />
  )

  return (
    <>
      {overdue.length > 0 && !overdueDismissed && (
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
          {/* 可访问名与黄色那条相同（「关闭」这个名字在全站归 ui/Sheet 头部那个
              × 所有）。两条同时在时靠 data-testid 区分，测试也按它定位。 */}
          <button
            type="button"
            className={styles.bannerClose}
            aria-label="关闭这条提醒"
            data-testid="jobs-overdue-close"
            onClick={dismissOverdue}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      {stall !== null && !stallDismissed && (
        <div className={styles.banner} data-sev="warn" data-testid="jobs-fetch-stalled" role="status">
          <p className={styles.bannerText}>
            <b>{stall.text}</b>——「{stall.label}」连着没跑成，新的录制多半正在积压。
            <br />
            {/* 第二句写的是**能做什么**，不是免责。这条告警在控制台里没有一个能按的
                动作：调度器自己会一轮轮再试，「立即运行」只是再排一轮同样的事。唯一要
                人出手的情形是中断超过拉取窗口——调度器每轮只回看那么久，中间的会议
                不会被回头补上。窗口的小时数来自后端（与调度器读同一个环境变量），
                这里不写 24：运维一改，硬编码的句子就会说谎。整句放在一行里：JSX 会把
                文字中间的换行折成一个空格，中文句子里不该冒出空格。 */}
            <span className={styles.bannerSub}>
              调度器每轮都会自己再试，不用手动触发。连续失败超过 {o.fetchLookbackHours} 小时，这段时间里的会议会落在拉取窗口之外，修好后需要人工补拉。已经拉下来的会议、归档与对外采集<b>不受影响</b>。
            </span>
          </p>
          {/* 可访问名不叫「关闭」，叫「关闭这条提醒」：一个光说「关闭」的名字没有
              说清关掉的是什么——这一页上面还可能站着另一条横幅（`jobs-overdue`）；
              而「关闭」这个名字在全站已经归 `ui/Sheet.tsx` 头部那个 × 所有，读屏
              按名字找按钮时两者会撞在一起（同样的取舍见
              `Consumers/ProgramActions.tsx` 的「关掉这一屏」）。 */}
          <button
            type="button"
            className={styles.bannerClose}
            aria-label="关闭这条提醒"
            data-testid="jobs-fetch-stalled-close"
            onClick={dismissStall}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      {lanes.chain.length > 0 && (
        <Lane
          id="chain"
          lane="chain"
          title="主链路"
          sub="上一步有新产出，下一步立刻接着跑；到点也照常跑。"
          cols={cols}
        >
          {lanes.chain.map((job, i) => card(job, jobOrdinal(i), lanes.chain[i + 1]))}
        </Lane>
      )}

      {lanes.solo.length > 0 && (
        <Lane id="solo" lane="solo" title="独立运行" sub="各按自己的周期跑，不接在别的任务后面。" cols={cols}>
          {lanes.solo.map((job) => card(job, null, undefined))}
        </Lane>
      )}

      <FailuresTable o={o} now={o.now} />
    </>
  )
}
