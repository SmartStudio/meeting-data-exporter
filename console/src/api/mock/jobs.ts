import type { Meeting } from '../types'

/**
 * 五个内置定时任务（`JOB_CATALOG`）的种子。
 *
 * ## 健康状态各不相同，这是故意的
 *
 * `never_ran` / `running` / `overdue` / `ok` 四个取值在 `pages/Jobs/view.ts` 里
 * 是四种不同的呈现（中性 / 品牌蓝 / 红 + 页面级横幅 / 无标注）。种子里如果每个
 * 任务都正常，a11y 门槛就只扫得到其中一种，而"已经落后"那一条恰恰是红底红字
 * 最容易在深色主题下写错的地方。所以前四个任务各占一种，第五个（自动授权）
 * 与拉取同为 `ok`——四种呈现已经各有一份，第五份只需要是一条真实的正常态。
 *
 * ## 失败项从会议世界里推，不另写一份
 *
 * `job_failures` 里 `archive_nas` 的未解决行，与会议列表里 `archive === 'failed'`
 * 的那几场，在真系统里是同一件事的两个视角。这里也照办：失败项由传进来的会议
 * 快照推出来。于是 NAS 断连（`applyNasDown` 把 4 场翻成归档失败）之后，
 * 任务页的失败项、归档存储页的 `failedMeetings`、会议页的红叉三处会一起变——
 * 三处对不上，演示就在自己打自己。
 */

/** 一次运行的下发形状。 */
export interface ProtoRun {
  id: number
  status: string
  trigger: string
  requestedBy: string | null
  startedAt: number | null
  finishedAt: number | null
  durationSec: number | null
  summary: unknown
  error: string | null
}

export interface ProtoJob {
  name: string
  label: string
  what: string
  schedule: string
  nextDueAt: number
  impact: string
  maxAttempts: number
  openFailures: number
  health: string
  lastRun: ProtoRun | null
  recentRuns: ProtoRun[]
}

export interface ProtoJobs {
  now: number
  timezoneOffsetSec: number
  jobs: ProtoJob[]
  failuresTotal: number
  failures: Array<Record<string, unknown>>
}

interface RunSpec {
  id: number
  status: string
  /** 多久以前开跑（秒）。`null` = 还没被调度器认领，`startedAt` 因此也是 null */
  agoSec: number | null
  /** 还没跑完就是 `null`——不许拿"到现在为止"凑一个会持续变大的数 */
  durationSec: number | null
  summary?: unknown
  error?: string
  trigger?: string
  requestedBy?: string | null
}

function run(nowSec: number, s: RunSpec): ProtoRun {
  const startedAt = s.agoSec === null ? null : nowSec - s.agoSec
  return {
    id: s.id,
    status: s.status,
    trigger: s.trigger ?? 'schedule',
    requestedBy: s.requestedBy ?? null,
    startedAt,
    finishedAt: startedAt === null || s.durationSec === null ? null : startedAt + s.durationSec,
    durationSec: s.durationSec,
    summary: s.summary ?? null,
    error: s.error ?? null,
  }
}

/** 一条失败项。`target` 是规范化键：会议维度是 `meetingId|subMeetingId`。 */
function failure(
  id: number,
  nowSec: number,
  o: {
    jobName: string
    target: string
    targetLabel: string
    meetingId: string | null
    reason: string
    impact: string
    attempts: number
    maxAttempts: number
    firstAgoSec: number
    lastAgoSec: number
  },
): Record<string, unknown> {
  return {
    id,
    jobName: o.jobName,
    target: o.target,
    targetLabel: o.targetLabel,
    meetingId: o.meetingId,
    subMeetingId: '',
    reason: o.reason,
    impact: o.impact,
    attempts: o.attempts,
    maxAttempts: o.maxAttempts,
    // "该找人了"，不是"系统放弃了"：每个任务的重试都由各自的枚举源结构性驱动
    escalated: o.attempts >= o.maxAttempts,
    firstFailedAt: nowSec - o.firstAgoSec,
    lastFailedAt: nowSec - o.lastAgoSec,
  }
}

const HOUR = 3600

export function buildJobs(nowSec: number, meetings: readonly Meeting[]): ProtoJobs {
  const failed = meetings.filter((m) => m.archive === 'failed')

  const fetchRuns: ProtoRun[] = [
    run(nowSec, {
      id: 941,
      status: 'succeeded',
      agoSec: 260,
      durationSec: 42,
      summary: { meetings: 3, discovered: 19, completed: 19, probes: 12, manifests: 3 },
    }),
    run(nowSec, { id: 940, status: 'succeeded', agoSec: 1160, durationSec: 38 }),
    run(nowSec, {
      id: 939,
      status: 'failed',
      agoSec: 2060,
      durationSec: 12,
      error: '腾讯会议 API 返回 429 Too Many Requests，本轮 3 场没拉到。',
    }),
    run(nowSec, { id: 938, status: 'succeeded', agoSec: 2960, durationSec: 51 }),
    run(nowSec, {
      id: 937,
      status: 'interrupted',
      agoSec: 3860,
      durationSec: 9,
      error: '进程收到 SIGTERM（部署重启），本轮中断。被中断不算失败——那是本机的事。',
    }),
    run(nowSec, { id: 936, status: 'succeeded', agoSec: 4760, durationSec: 40 }),
    // 跳过的那一轮没有开跑过：startedAt 与耗时都是 null
    run(nowSec, { id: 935, status: 'skipped', agoSec: null, durationSec: null }),
    run(nowSec, { id: 934, status: 'succeeded', agoSec: 6560, durationSec: 44 }),
  ]

  const archiveRuns: ProtoRun[] = [
    run(nowSec, {
      id: 812,
      status: 'failed',
      agoSec: 3.5 * HOUR,
      durationSec: 26,
      error: `NAS 写入失败：目标目录不可写（errno 30, EROFS），${failed.length} 场没归档成。`,
      summary: { newlyArchived: 0, failed: failed.length, verificationFailed: 1, undecidable: 2 },
    }),
    run(nowSec, {
      id: 811,
      status: 'failed',
      agoSec: 4.5 * HOUR,
      durationSec: 31,
      error: 'NAS 写入失败：目标目录不可写（errno 30, EROFS）。',
      summary: { newlyArchived: 0, failed: failed.length, verificationFailed: 0, undecidable: 2 },
    }),
    run(nowSec, {
      id: 810,
      status: 'succeeded',
      agoSec: 5.5 * HOUR,
      durationSec: 44,
      summary: { newlyArchived: 2, failed: 0, verificationFailed: 0, sidecarFailed: 0 },
    }),
    run(nowSec, { id: 809, status: 'succeeded', agoSec: 6.5 * HOUR, durationSec: 39 }),
    run(nowSec, { id: 808, status: 'succeeded', agoSec: 7.5 * HOUR, durationSec: 47 }),
  ]

  const cleanupRuns: ProtoRun[] = [
    // 正在跑：还没跑完，耗时是 null
    run(nowSec, { id: 77, status: 'running', agoSec: 95, durationSec: null }),
    run(nowSec, {
      id: 76,
      status: 'succeeded',
      agoSec: 24 * HOUR,
      durationSec: 63,
      summary: { purged: 6, purgedBytes: 5_583_457_894, paused: false, failed: 0 },
    }),
    run(nowSec, {
      id: 75,
      status: 'succeeded',
      agoSec: 48 * HOUR,
      durationSec: 58,
      summary: { purged: 0, purgedBytes: 0, paused: true, failed: 0 },
    }),
  ]

  /** 自动授权：每一轮逐程序报数。`granted` 是本轮真的写进 `meeting_grants` 的条数。 */
  const autoGrantRuns: ProtoRun[] = [
    run(nowSec, {
      id: 305,
      status: 'succeeded',
      agoSec: 140,
      durationSec: 3,
      summary: {
        programs: [{ programId: 'kb-indexer', name: '知识库索引器', candidates: 2, granted: 2, skippedRevoked: 1 }],
        granted: 2,
        // 人工撤销过的那一场不会被补回来：人的决定压过开关（共享契约规矩 2）
        skippedRevoked: 1,
        failedPrograms: 0,
      },
    }),
    run(nowSec, {
      id: 304,
      status: 'succeeded',
      // 接在 fetch_recordings 那一轮后面跑的：拉取有资产下载完成就紧接着跑一次
      agoSec: 255,
      durationSec: 2,
      trigger: 'chain',
      summary: {
        programs: [{ programId: 'kb-indexer', name: '知识库索引器', candidates: 0, granted: 0, skippedRevoked: 1 }],
        granted: 0,
        skippedRevoked: 1,
        failedPrograms: 0,
      },
    }),
    run(nowSec, { id: 303, status: 'succeeded', agoSec: 440, durationSec: 2 }),
    run(nowSec, { id: 302, status: 'succeeded', agoSec: 740, durationSec: 3 }),
  ]

  const failures = [
    ...failed.map((m, i) =>
      failure(600 + i, nowSec, {
        jobName: 'archive_nas',
        target: `${m.id}|`,
        targetLabel: m.title,
        meetingId: m.id,
        reason: 'NAS 写入失败：目标目录不可写（errno 30, EROFS）。',
        impact: '未归档。本地保留期一到，这场会议就永久没有了。',
        attempts: i === 0 ? 5 : 2,
        maxAttempts: 5,
        firstAgoSec: 30 * HOUR,
        lastAgoSec: 3.5 * HOUR,
      }),
    ),
    // 整轮维度的失败项：没有会议，`meetingId` 是 null，人读的名字也给不出
    failure(690, nowSec, {
      jobName: 'archive_nas',
      target: 'round',
      targetLabel: '',
      meetingId: null,
      reason: '挂载点探测失败：/nas/meetings 在 5s 内没有响应，本轮整轮没跑成。',
      impact: '这一轮一场都没归档。',
      attempts: 3,
      maxAttempts: 5,
      firstAgoSec: 8 * HOUR,
      lastAgoSec: 3.5 * HOUR,
    }),
  ]

  // ⚠ 下面五条的 label / schedule / what / impact **逐字抄自后端的 JOB_CATALOG**
  //   （`src/store/jobs.ts`），不是原型自己的文案。它们曾经各写各的：这一份比
  //   生产长一倍、任务四的频率还写成「每 30 分钟」（真值 5 分钟），于是所有原型
  //   截图与 `scripts/vqa.ts` 的视觉验收量的都是一页并不存在的文字——谁照着原型
  //   调版式，调的就是错的字长。`tests/store/jobs-copy.test.ts` 现在钉住这件事。
  //   要改文案，改 JOB_CATALOG，然后把这里同步过来。
  const jobs: ProtoJob[] = [
    {
      name: 'fetch_recordings',
      label: '拉取新录制',
      what: '从腾讯会议下载新录制到本地',
      schedule: '每 15 分钟',
      nextDueAt: nowSec + 640,
      impact: '录制在腾讯会议过期后就再也拉不回来了',
      maxAttempts: 5,
      openFailures: 0,
      health: 'ok',
      lastRun: fetchRuns[0]!,
      recentRuns: fetchRuns,
    },
    {
      name: 'archive_nas',
      label: '归档到 NAS',
      what: '把本地文件写进 NAS 并校验哈希',
      schedule: '每小时整点',
      // 已经到点很久了——这正是 overdue 的意思：调度器多半不在跑了
      nextDueAt: nowSec - 2.5 * HOUR,
      impact: '本地文件到期清理后，这场会议就一份都不剩了',
      maxAttempts: 5,
      openFailures: failures.length,
      health: 'overdue',
      lastRun: archiveRuns[0]!,
      recentRuns: archiveRuns,
    },
    {
      name: 'cleanup_expired',
      label: '清理到期文件',
      what: '删掉已过期且已归档的本地文件，记录保留',
      schedule: '每天 03:00',
      nextDueAt: nowSec + 20 * HOUR,
      impact: '本地磁盘会被占满，新的录制拉不下来',
      maxAttempts: 3,
      openFailures: 0,
      health: 'running',
      lastRun: cleanupRuns[0]!,
      recentRuns: cleanupRuns,
    },
    {
      name: 'refresh_inventory',
      label: '刷新采集清单',
      what: '重算每个程序能取走哪些会议的哪些资产',
      schedule: '每 5 分钟',
      nextDueAt: nowSec + 190,
      impact: '采集程序取不到新会议，清单停在上一轮',
      maxAttempts: 3,
      openFailures: 0,
      // 一次都没跑过。刚部署的实例就是这样，**不是故障**
      health: 'never_ran',
      lastRun: null,
      recentRuns: [],
    },
    {
      name: 'auto_grant',
      label: '自动授权',
      what: '把规则放行的会议授权给开了自动授权的程序',
      schedule: '每 5 分钟',
      nextDueAt: nowSec + 160,
      impact: '新会议不会自动授权，程序取不到',
      maxAttempts: 5,
      openFailures: 0,
      health: 'ok',
      lastRun: autoGrantRuns[0]!,
      recentRuns: autoGrantRuns,
    },
  ]

  return {
    now: nowSec,
    timezoneOffsetSec: -new Date().getTimezoneOffset() * 60,
    jobs,
    failuresTotal: failures.length,
    failures,
  }
}

/**
 * 「腾讯会议不可达」时的数据变形（spec §7.2）。
 *
 * 顶栏那个状态说的是**观察**——「最近 N 轮拉取连续失败」，而不是"腾讯会议挂了"
 * 这个结论（`api/admin/health.ts` 的 `fetchStreakText()`）。观察的出处只有一个：
 * `fetch_recordings` 最近几轮的运行记录。所以这个状态下必须真的把那几轮翻成
 * 失败——否则顶栏说连续失败、任务页里那一排柱子全是绿的，两处对不上。
 *
 * 与 `applyNasDown` 同一条规矩：**改状态就要一起改理由**，每一轮都带上错误原文。
 */
export function applyTencentDown(o: ProtoJobs, nowSec: number): ProtoJobs {
  const jobs = o.jobs.map((j) => {
    if (j.name !== 'fetch_recordings') return j
    let broken = 3
    const recentRuns = j.recentRuns.map((r) => {
      // 排队 / 正在跑 / 跳过的轮次没有结果，不能拿来当"连续失败"的证据，跨过去
      if (broken <= 0 || r.status === 'queued' || r.status === 'running' || r.status === 'skipped') {
        return r
      }
      broken -= 1
      return {
        ...r,
        status: 'failed',
        summary: null,
        error: '腾讯会议接口连不上：连接超时（ETIMEDOUT），本轮一场都没拉到。',
      }
    })
    return { ...j, recentRuns, lastRun: recentRuns[0] ?? null }
  })

  const extra = failure(700, nowSec, {
    jobName: 'fetch_recordings',
    target: 'round',
    targetLabel: '',
    meetingId: null,
    reason: '腾讯会议接口连不上：连接超时（ETIMEDOUT）。',
    impact: '新的录制拉不下来，正在积压。已经拉下来的会议不受影响。',
    attempts: 3,
    maxAttempts: 5,
    firstAgoSec: 3 * HOUR,
    lastAgoSec: 260,
  })

  const failures = [extra, ...o.failures]
  return {
    ...o,
    jobs: jobs.map((j) =>
      j.name === 'fetch_recordings' ? { ...j, openFailures: 1 } : j,
    ),
    failures,
    failuresTotal: failures.length,
  }
}

/** 手动触发排进队里的一行。**这一行不会开跑**——见 `withQueued`。 */
export interface QueuedRun {
  jobName: string
  run: ProtoRun
}

/**
 * 手动触发：**只排一行队，不执行**。调度器在 worker 进程里（网关是多实例的），
 * 下一个 tick 才认领。界面上因此会看见一行 `queued`：还没开跑、耗时是 null。
 * 那正是真后端的样子——这一刻任务还没跑，界面上不许说成"已完成"。
 */
export function makeQueuedRun(jobName: string, runId: number, nowSec: number): QueuedRun {
  return {
    jobName,
    run: run(nowSec, {
      id: runId,
      status: 'queued',
      agoSec: null,
      durationSec: null,
      trigger: 'manual',
      requestedBy: 'proto',
    }),
  }
}

/** 把手动排的那几行并回任务清单。种子是每次请求现算的，排队的行单独存着。 */
export function withQueued(o: ProtoJobs, queued: readonly QueuedRun[]): ProtoJobs {
  if (queued.length === 0) return o
  return {
    ...o,
    jobs: o.jobs.map((j) => {
      const mine = queued.filter((q) => q.jobName === j.name).map((q) => q.run)
      if (mine.length === 0) return j
      const recentRuns = [...mine.reverse(), ...j.recentRuns].slice(0, 20)
      return { ...j, recentRuns, lastRun: recentRuns[0]! }
    }),
  }
}
