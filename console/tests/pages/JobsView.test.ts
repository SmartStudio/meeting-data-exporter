import { describe, expect, test } from 'vitest'
import { TENCENT_DOWN_STREAK, fetchStreakText } from '../../src/api/admin/health'
import type { JobItem, JobRun } from '../../src/api/admin/jobs'
import {
  SPARK_MIN_PCT,
  attemptsText,
  fetchStall,
  fmtAfter,
  fmtAgo,
  fmtGap,
  fmtSpan,
  healthView,
  jobOrdinal,
  keyMetric,
  overdueJobs,
  runStatusText,
  sparkBars,
  summaryView,
} from '../../src/pages/Jobs/view'

/** 呈现层的纯函数。页面上每一句话的口径都定在这里，组件只管把它们摆出来。 */

const NOW = 1700000000

function run(over: Partial<JobRun> = {}): JobRun {
  return {
    id: 1,
    status: 'succeeded',
    trigger: 'schedule',
    requestedBy: null,
    startedAt: NOW - 600,
    finishedAt: NOW - 500,
    durationSec: 100,
    summary: null,
    error: null,
    ...over,
  }
}

function job(over: Partial<JobItem> = {}): JobItem {
  return {
    name: 'archive_nas',
    label: '归档到 NAS',
    what: '写入 NAS 并校验哈希',
    schedule: '每小时整点',
    nextDueAt: NOW + 600,
    impact: '未归档，到期会永久丢失',
    maxAttempts: 5,
    openFailures: 0,
    health: 'ok',
    lastRun: run(),
    recentRuns: [run()],
    ...over,
  }
}

describe('healthView() —— 四个取值各有各的呈现，认不出的不当成正常', () => {
  test('never_ran：从没跑过，与"调度器挂了"靠状态分得开，不靠一句解释', () => {
    const v = healthView('never_ran')
    expect(v.label).toBe('从没跑过')
    expect(v.alarm).toBe(false)
    expect(v.tone).toBe('neutral')
    // 「这不是调度器挂了」是徽标的字与颜色说的：它和 overdue 是两个不同的取值、
    // 两种不同的 tone、一个不告警一个告警。再挂一句说明就是四张卡片四行重复
    expect(v.note).toBe('')
    expect(v.tone).not.toBe(healthView('overdue').tone)
  })

  test('running：正在跑', () => {
    const v = healthView('running')
    expect(v.label).toBe('正在跑')
    expect(v.tone).toBe('brand')
    expect(v.alarm).toBe(false)
  })

  test('overdue：意思是"调度器多半挂了"，且是告警级', () => {
    const v = healthView('overdue')
    expect(v.label).toBe('已经落后')
    expect(v.tone).toBe('fail')
    expect(v.alarm).toBe(true)
    // 「调度器多半挂了」这句话在页面顶上那条横幅里（`jobs-overdue`，由 alarm
    // 触发），不在每一张卡片上——两处都写就是同一句话出现两遍
    expect(v.note).toBe('')
  })

  test('ok：正常，不告警', () => {
    const v = healthView('ok')
    expect(v.label).toBe('正常')
    expect(v.alarm).toBe(false)
  })

  test('认不出的取值给「未知」，不给「正常」，并且原样带上后端给的值', () => {
    const v = healthView('paused_by_operator')
    expect(v.label).toContain('未知')
    expect(v.label).toContain('paused_by_operator')
    expect(v.tone).toBe('warn')
    expect(v.label).not.toContain('正常')
  })
})

describe('runStatusText()', () => {
  test('六个已知状态各有中文', () => {
    expect(runStatusText('queued')).toBe('排队中')
    expect(runStatusText('running')).toBe('正在跑')
    expect(runStatusText('succeeded')).toBe('成功')
    expect(runStatusText('failed')).toBe('失败')
    expect(runStatusText('interrupted')).toBe('被中断')
    expect(runStatusText('skipped')).toBe('跳过')
  })

  test('认不出的状态原样带出来，不映成任何一个已知状态', () => {
    expect(runStatusText('weird')).toContain('weird')
    expect(runStatusText('weird')).toContain('未知')
  })
})

describe('sparkBars() —— 数据是 recentRuns，失败那次是红的', () => {
  test('从旧到新排（recentRuns 第 0 个是最近一次，画在最右）', () => {
    const bars = sparkBars(
      [run({ id: 3, startedAt: NOW - 100 }), run({ id: 2 }), run({ id: 1 })],
      NOW,
    )
    expect(bars.map((b) => b.runId)).toEqual([1, 2, 3])
  })

  test('失败那次 tone=fail，成功那次 tone=ok', () => {
    const bars = sparkBars([run({ id: 2, status: 'failed' }), run({ id: 1 })], NOW)
    expect(bars.map((b) => b.tone)).toEqual(['ok', 'fail'])
  })

  test('既非成功也非失败（排队 / 跳过 / 被中断）是第三种，不冒充成功', () => {
    const bars = sparkBars(
      [run({ id: 3, status: 'interrupted' }), run({ id: 2, status: 'skipped' }), run({ id: 1, status: 'queued' })],
      NOW,
    )
    expect(bars.map((b) => b.tone)).toEqual(['other', 'other', 'other'])
  })

  test('柱高按窗口内最长耗时归一，最长那根满格', () => {
    const bars = sparkBars(
      [run({ id: 3, durationSec: 200 }), run({ id: 2, durationSec: 100 }), run({ id: 1, durationSec: 50 })],
      NOW,
    )
    expect(bars[2]?.heightPct).toBe(100)
    expect(bars[1]?.heightPct).toBe(50)
    expect(bars[0]?.heightPct).toBe(25)
  })

  test('耗时为 0 的那根也画得出来（不塌成一条看不见的线）', () => {
    // 柱子是从旧到新排的，所以最近这一轮（id 2，耗时 0）在最后一根
    const bars = sparkBars([run({ id: 2, durationSec: 0 }), run({ id: 1, durationSec: 100 })], NOW)
    expect(bars[1]?.runId).toBe(2)
    expect(bars[1]?.heightPct).toBe(SPARK_MIN_PCT)
    expect(bars[1]?.unfinished).toBe(false)
  })

  test('durationSec 为 null（还没跑完）标成 unfinished，不拿当前时刻凑一个高度', () => {
    const bars = sparkBars(
      [run({ id: 2, status: 'running', finishedAt: null, durationSec: null }), run({ id: 1, durationSec: 100 })],
      NOW,
    )
    expect(bars[1]?.unfinished).toBe(true)
    expect(bars[1]?.heightPct).toBe(SPARK_MIN_PCT)
    expect(bars[1]?.title).toContain('还没跑完')
    // 关键回归：换一个"现在"，那根柱子的高度不许跟着变大
    const later = sparkBars(
      [run({ id: 2, status: 'running', finishedAt: null, durationSec: null }), run({ id: 1, durationSec: 100 })],
      NOW + 99999,
    )
    expect(later[1]?.heightPct).toBe(bars[1]?.heightPct)
  })

  test('全都没跑完时不会除以 0，也不会全塌成 0', () => {
    const bars = sparkBars([run({ id: 1, durationSec: null }), run({ id: 2, durationSec: null })], NOW)
    expect(bars.every((b) => b.heightPct === SPARK_MIN_PCT)).toBe(true)
  })

  test('一次运行都没有时返回空数组——由调用方显示"从没跑过"，不画空 sparkline', () => {
    expect(sparkBars([], NOW)).toEqual([])
  })

  test('每根柱子都有可读文本（时间 · 状态 · 耗时）', () => {
    const bars = sparkBars([run({ status: 'failed', durationSec: 12 })], NOW)
    expect(bars[0]?.title).toContain('失败')
    expect(bars[0]?.title).toContain('12 秒')
  })

  test('没开跑过的那一行（startedAt 为 null）不编一个时间出来', () => {
    const bars = sparkBars([run({ status: 'queued', startedAt: null, finishedAt: null, durationSec: null })], NOW)
    expect(bars[0]?.title).toContain('还没开跑')
  })
})

describe('时长与相对时间', () => {
  test('fmtSpan：秒 / 分 / 小时三档', () => {
    expect(fmtSpan(0)).toBe('0 秒')
    expect(fmtSpan(8)).toBe('8 秒')
    expect(fmtSpan(59)).toBe('59 秒')
    expect(fmtSpan(60)).toBe('1 分')
    expect(fmtSpan(100)).toBe('1 分 40 秒')
    expect(fmtSpan(3600)).toBe('1 小时')
    expect(fmtSpan(3780)).toBe('1 小时 3 分')
  })

  test('fmtSpan：负数夹到 0，不显示"负 3 秒"', () => {
    expect(fmtSpan(-3)).toBe('0 秒')
  })

  test('fmtGap：粗粒度，不给秒（"还有 6 分钟"不需要精确到秒）', () => {
    expect(fmtGap(30)).toBe('不到 1 分钟')
    expect(fmtGap(360)).toBe('6 分钟')
    expect(fmtGap(3600)).toBe('1 小时')
    expect(fmtGap(11_520)).toBe('3 小时 12 分钟')
    expect(fmtGap(180_000)).toBe('2 天 2 小时')
  })

  test('fmtAfter / fmtAgo：到点了与刚刚各有自己的说法', () => {
    expect(fmtAfter(NOW + 360, NOW)).toBe('6 分钟后')
    expect(fmtAfter(NOW, NOW)).toBe('已经到点')
    expect(fmtAfter(NOW - 10, NOW)).toBe('已经到点')
    expect(fmtAgo(NOW - 360, NOW)).toBe('6 分钟前')
    expect(fmtAgo(NOW - 5, NOW)).toBe('刚刚')
  })
})

describe('summaryView() —— job_runs.summary 是任意 JSON', () => {
  test('没有摘要就是没有，不编一句"任务已完成"', () => {
    expect(summaryView(null).kind).toBe('none')
    expect(summaryView(undefined).kind).toBe('none')
    expect(summaryView({}).kind).toBe('none')
  })

  test('字符串摘要原样显示', () => {
    const v = summaryView('归档 12 场')
    expect(v).toEqual({ kind: 'text', text: '归档 12 场' })
  })

  test('对象摘要拆成键值对，已知的键给中文，认不出的键原样用', () => {
    const v = summaryView({ newlyArchived: 12, failed: 1, weirdNewKey: 3 })
    expect(v.kind).toBe('pairs')
    if (v.kind !== 'pairs') return
    expect(v.pairs).toEqual([
      { key: 'newlyArchived', label: '新归档', value: '12' },
      { key: 'failed', label: '失败', value: '1' },
      { key: 'weirdNewKey', label: 'weirdNewKey', value: '3' },
    ])
  })

  test('字节数走 fmtBytes，布尔给中文，数组给条数，嵌套对象跳过', () => {
    const v = summaryView({
      purgedBytes: 1024,
      paused: true,
      programs: [{ programId: 'a' }, { programId: 'b' }],
      nested: { a: 1 },
    })
    if (v.kind !== 'pairs') throw new Error('应该是 pairs')
    const byKey = Object.fromEntries(v.pairs.map((p) => [p.key, p.value]))
    expect(byKey.purgedBytes).toBe('1.00 KB')
    expect(byKey.paused).toBe('是')
    expect(byKey.programs).toBe('2 项')
    expect(byKey.nested).toBeUndefined()
  })
})

describe('失败项', () => {
  test('已重试次数是分数形式（spec §4.8 逐字给的 `2 / 5`）', () => {
    expect(attemptsText({ attempts: 2, maxAttempts: 5 })).toBe('2 / 5')
  })
})

describe('overdueJobs()', () => {
  test('只挑 overdue，别的健康状态不算', () => {
    const list = [job({ name: 'a', health: 'ok' }), job({ name: 'b', health: 'overdue' }), job({ name: 'c', health: 'never_ran' })]
    expect(overdueJobs(list).map((j) => j.name)).toEqual(['b'])
  })
})

describe('fetchStall() —— tencent-down 的推断，与系统状态条同一个出处', () => {
  const failed = (n: number): JobRun[] => Array.from({ length: n }, (_, i) => run({ id: i, status: 'failed' }))

  test('连续失败没到阈值时不报', () => {
    const list = [job({ name: 'fetch_recordings', recentRuns: failed(TENCENT_DOWN_STREAK - 1) })]
    expect(fetchStall(list)).toBeNull()
  })

  test('到了阈值就报，措辞逐字等于 fetchStreakText()（不另写一句）', () => {
    const n = TENCENT_DOWN_STREAK
    const list = [job({ name: 'fetch_recordings', label: '拉取新录制', recentRuns: failed(n) })]
    const stall = fetchStall(list)
    expect(stall).not.toBeNull()
    expect(stall?.streak).toBe(n)
    expect(stall?.text).toBe(fetchStreakText(n))
    // 这是推断不是直报：不许出现"腾讯会议不可达"这个结论
    expect(stall?.text).not.toContain('腾讯会议')
  })

  test('清单里没有 fetch_recordings 时返回 null（推不出来，也不当成正常）', () => {
    expect(fetchStall([job({ name: 'archive_nas' })])).toBeNull()
  })

  test('排队 / 正在跑 / 跳过跨过去，成功打断计数——口径与 health.ts 一致', () => {
    const n = TENCENT_DOWN_STREAK
    const withQueued = [run({ id: 99, status: 'queued' }), ...failed(n)]
    expect(fetchStall([job({ name: 'fetch_recordings', recentRuns: withQueued })])?.streak).toBe(n)
    const withSuccess = [run({ id: 99, status: 'succeeded' }), ...failed(n)]
    expect(fetchStall([job({ name: 'fetch_recordings', recentRuns: withSuccess })])).toBeNull()
  })

  /* ── 这一段故障的身份：`latestFailedRunId`（横幅关闭要用，见 dismiss.ts）──
     真实数据里 `recentRuns[0]` 是最近一次、id 随时间递增，所以最新那条 id 最大。
     上面的 `failed()` 反过来（id 从 0 递增），会把"取到的是最新那条"和
     "取到的是第一条/最小的那条"混在一起分不出来，这里另铺一份。 */
  const failedDesc = (topId: number, n: number): JobRun[] =>
    Array.from({ length: n }, (_, i) => run({ id: topId - i, status: 'failed' }))

  test('latestFailedRunId 是这一段连续失败里最新那一次 failed 的 id', () => {
    const runs = failedDesc(903, TENCENT_DOWN_STREAK)
    expect(fetchStall([job({ name: 'fetch_recordings', recentRuns: runs })])?.latestFailedRunId).toBe(903)
  })

  test('排队 / 正在跑 / 跳过跨过去之后才算身份——不是 recentRuns[0] 的 id', () => {
    // 在一台已经拉不通的机器上按一下「立即运行」，最新一行就是 queued。
    // 拿它当身份，横幅会在每次手动触发之后都换一个身份、重新冒出来。
    const runs: JobRun[] = [
      run({ id: 910, status: 'queued' }),
      run({ id: 909, status: 'running' }),
      run({ id: 908, status: 'skipped' }),
      ...failedDesc(907, TENCENT_DOWN_STREAK),
    ]
    const stall = fetchStall([job({ name: 'fetch_recordings', recentRuns: runs })])
    expect(stall?.streak).toBe(TENCENT_DOWN_STREAK)
    expect(stall?.latestFailedRunId).toBe(907)
  })

  test('又失败一轮，身份就换一个——关掉的那条不会把新的失败一起藏掉', () => {
    const before = fetchStall([
      job({ name: 'fetch_recordings', recentRuns: failedDesc(907, TENCENT_DOWN_STREAK) }),
    ])
    const after = fetchStall([
      job({ name: 'fetch_recordings', recentRuns: failedDesc(908, TENCENT_DOWN_STREAK + 1) }),
    ])
    expect(after?.latestFailedRunId).not.toBe(before?.latestFailedRunId)
  })
})

describe('keyMetric() —— 链上每一段自己的一个关键数（D-jobs-storage brief）', () => {
  test('四个内置任务各自映到 summary 里的一个键，中文沿用 SUMMARY_LABEL 那一份', () => {
    expect(keyMetric(job({ name: 'fetch_recordings', lastRun: run({ summary: { discovered: 19 } }) }))).toEqual({
      label: '发现资产',
      value: '19',
    })
    expect(keyMetric(job({ name: 'archive_nas', lastRun: run({ summary: { newlyArchived: 3 } }) }))).toEqual({
      label: '新归档',
      value: '3',
    })
    expect(keyMetric(job({ name: 'cleanup_expired', lastRun: run({ summary: { purged: 0 } }) }))).toEqual({
      label: '已清理',
      value: '0',
    })
    expect(keyMetric(job({ name: 'refresh_inventory', lastRun: run({ summary: { fetchable: 12 } }) }))).toEqual({
      label: '可采集',
      value: '12',
    })
  })

  test('没有摘要、summary 里没有那个键、或压根没跑过——value 是 null，不编一个数', () => {
    expect(keyMetric(job({ name: 'archive_nas', lastRun: null })).value).toBeNull()
    expect(keyMetric(job({ name: 'archive_nas', lastRun: run({ summary: null }) })).value).toBeNull()
    expect(keyMetric(job({ name: 'archive_nas', lastRun: run({ summary: { somethingElse: 1 } }) })).value).toBeNull()
  })

  test('认不出的任务名（四个内置之外）没有关键数，label 是空串', () => {
    expect(keyMetric(job({ name: 'weird_job', lastRun: run({ summary: { x: 1 } }) }))).toEqual({
      label: '',
      value: null,
    })
  })
})

describe('jobOrdinal()', () => {
  test('四个内置任务用中文序号（spec §4.8 的表就是这么排的）', () => {
    expect([0, 1, 2, 3].map(jobOrdinal)).toEqual(['一', '二', '三', '四'])
  })

  test('第五个之后退回阿拉伯数字，不越界也不留空', () => {
    expect(jobOrdinal(4)).toBe('5')
  })
})
