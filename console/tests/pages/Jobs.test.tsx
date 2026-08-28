import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { render, renderAsRole } from '../helpers/session'
import userEvent from '@testing-library/user-event'
import { TENCENT_DOWN_STREAK, fetchStreakText } from '../../src/api/admin/health'
import JobsPage from '../../src/pages/Jobs'

/**
 * 定时任务页（spec.md §4.8）。
 *
 * 这一页最容易出的错是"把不知道的事说成知道"，所以下面每一组测试都在盯一句话：
 * 「从没跑过」不许说成「正常」、「还没跑完」不许说成一个耗时数字、
 * 「显示 100 条」不许说成「一共 100 条」、`overdue` 不许说得像"晚了一点"。
 */

const NOW = 1700000000

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Math.floor(Math.random() * 1e9),
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

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
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
    recentRuns: [run(), run()],
    ...over,
  }
}

const FOUR = [
  job({ name: 'fetch_recordings', label: '拉取新录制', what: '发现新录制、入队并下载', schedule: '每 15 分钟' }),
  job(),
  job({ name: 'cleanup_expired', label: '清理到期文件', what: '删本地文件，记录与 NAS 路径保留', schedule: '每天 03:00' }),
  job({ name: 'refresh_inventory', label: '刷新采集清单', what: '重算哪些会议对哪些程序可见', schedule: '每 5 分钟' }),
]

function failure(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    jobName: 'archive_nas',
    target: 'm-1|',
    targetLabel: '客户沟通 · 华东区',
    meetingId: '881-140-88',
    subMeetingId: '',
    reason: 'NAS 写入超时（30 秒）',
    impact: '未归档，到期会永久丢失',
    attempts: 2,
    maxAttempts: 5,
    escalated: false,
    firstFailedAt: NOW - 90000,
    lastFailedAt: NOW - 3600,
    ...over,
  }
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    now: NOW,
    timezoneOffsetSec: 28800,
    jobs: FOUR,
    failuresTotal: 0,
    failures: [],
    ...over,
  }
}

const ACCEPTED = {
  runId: 555,
  jobName: 'archive_nas',
  label: '归档到 NAS',
  status: 'queued',
  message: '已排队。定时任务由 worker 进程的调度器执行，它会在下一个 tick 认领这一次触发。',
}

interface StubOpts {
  getStatus?: number
  getBody?: unknown
  runStatus?: number
  runBody?: unknown
}

function stubApi(body: unknown, opts: StubOpts = {}) {
  const calls: Array<{ url: string; method: string }> = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const isRun = method === 'POST'
    const status = isRun ? (opts.runStatus ?? 202) : (opts.getStatus ?? 200)
    const out = isRun ? (opts.runBody ?? ACCEPTED) : (opts.getBody ?? body)
    return new Response(JSON.stringify(out), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', f)
  return { f, calls }
}

/** 永远挂着的 GET，用来看加载态。 */
function stubPending() {
  const f = vi.fn(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(body: unknown = payload(), opts: StubOpts = {}) {
  const stub = stubApi(body, opts)
  render(<JobsPage />)
  await screen.findByRole('heading', { name: '定时任务', level: 1 })
  return stub
}

describe('三态出口', () => {
  test('加载中有自己的出口，不是一片空白', async () => {
    stubPending()
    render(<JobsPage />)
    expect(await screen.findByTestId('jobs-loading')).toBeInTheDocument()
  })

  test('读不到时显示错误（带端点名），并且有重试', async () => {
    stubApi(null, { getStatus: 500, getBody: { error: 'boom' } })
    render(<JobsPage />)
    const box = await screen.findByTestId('jobs-error')
    expect(box).toHaveTextContent('GET /api/v1/admin/jobs')
    expect(within(box).getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  test('点重试会重新请求', async () => {
    const { calls } = stubApi(null, { getStatus: 500, getBody: { error: 'boom' } })
    render(<JobsPage />)
    const box = await screen.findByTestId('jobs-error')
    await userEvent.click(within(box).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBe(2))
  })
})

describe('四个任务格子', () => {
  test('四个都在，各自带名字、频率、干什么', async () => {
    await mount()
    const cards = await screen.findAllByTestId('job-card')
    expect(cards).toHaveLength(4)
    expect(cards[0]).toHaveTextContent('拉取新录制')
    expect(cards[0]).toHaveTextContent('每 15 分钟')
    expect(cards[0]).toHaveTextContent('发现新录制、入队并下载')
    expect(cards[2]).toHaveTextContent('清理到期文件')
    expect(cards[2]).toHaveTextContent('每天 03:00')
  })

  test('「下次」写成预计而不是承诺——调度器停了它照样算得出', async () => {
    await mount()
    const cards = await screen.findAllByTestId('job-card')
    expect(cards[0]).toHaveTextContent('下次预计')
    expect(cards[0]).toHaveTextContent('10 分钟后')
  })

  test('「没跑成的后果」不再四张卡常驻——只在这个任务真的出问题时才现身', async () => {
    // D-jobs-storage 改版：四行常驻的「没跑成的后果：……」收窄成脚注，正常任务
    // 不再挂这一行；真正卡住的那一段（overdue 或有未处理失败项）仍然要看得到，
    // 这是失败项表「如果不处理」列之外，唯一还会说这句话的地方。
    await mount(
      payload({
        jobs: [
          job({ name: 'ok-one', health: 'ok', openFailures: 0 }),
          job({ name: 'stuck-one', health: 'overdue' }),
        ],
      }),
    )
    const [okCard, stuckCard] = await screen.findAllByTestId('job-card')
    expect(okCard).not.toHaveTextContent('未归档，到期会永久丢失')
    expect(stuckCard).toHaveTextContent('未归档，到期会永久丢失')
  })

  test('有未处理失败项（即使健康状态本身是 ok）也会现身，不必等到 overdue', async () => {
    await mount(payload({ jobs: [job({ health: 'ok', openFailures: 2 })] }))
    const card = (await screen.findAllByTestId('job-card'))[0]!
    expect(card).toHaveTextContent('未归档，到期会永久丢失')
  })

  test('有失败项的任务在格子上带一个计数徽标', async () => {
    await mount(payload({ jobs: [job({ openFailures: 3 })], failuresTotal: 3, failures: [failure()] }))
    const card = (await screen.findAllByTestId('job-card'))[0]!
    expect(card).toHaveTextContent('3 项失败')
  })
})

describe('sparkline', () => {
  test('每次运行一根柱子，失败那次是红的（data-tone=fail）', async () => {
    await mount(
      payload({
        jobs: [job({ recentRuns: [run({ status: 'failed' }), run(), run()] })],
      }),
    )
    const spark = await screen.findByTestId('job-spark')
    expect(spark.querySelectorAll('[data-tone]')).toHaveLength(3)
    expect(spark.querySelectorAll('[data-tone="fail"]')).toHaveLength(1)
  })

  test('recentRuns 为空时显示「从没跑过」，不画一条空 sparkline', async () => {
    await mount(payload({ jobs: [job({ recentRuns: [], lastRun: null, health: 'never_ran' })] }))
    const card = (await screen.findAllByTestId('job-card'))[0]!
    expect(card).toHaveTextContent('从没跑过')
    expect(screen.queryByTestId('job-spark')).toBeNull()
  })

  test('整条 sparkline 有读屏文本——颜色不是唯一的信息载体', async () => {
    await mount(payload({ jobs: [job({ recentRuns: [run({ status: 'failed' }), run()] })] }))
    const spark = await screen.findByTestId('job-spark')
    expect(spark).toHaveAttribute('role', 'img')
    expect(spark.getAttribute('aria-label')).toContain('失败 1 次')
  })

  test('还没跑完的那一轮标出来，且高度不随时间变大', async () => {
    await mount(
      payload({
        jobs: [job({ recentRuns: [run({ status: 'running', finishedAt: null, durationSec: null }), run()] })],
      }),
    )
    const spark = await screen.findByTestId('job-spark')
    const pending = spark.querySelector('[data-unfinished="true"]')
    expect(pending).not.toBeNull()
    expect(pending?.getAttribute('title')).toContain('还没跑完')
  })
})

describe('四个 health 各有各的呈现', () => {
  test('never_ran 说「从没跑过」，且与「已经落后」是两个不同的状态，不是一句解释', async () => {
    await mount(
      payload({
        jobs: [
          job({ health: 'never_ran', lastRun: null, recentRuns: [] }),
          job({ name: 'x', health: 'overdue' }),
        ],
      }),
    )
    const [neverRan, overdue] = await screen.findAllByTestId('job-card')
    expect(neverRan).toHaveTextContent('从没跑过')
    expect(neverRan).not.toHaveTextContent('正常')
    // 「这不是调度器挂了」由**状态本身**说：两张卡片一个不告警、一个告警。
    // 以前它是每张卡片上一句一模一样的说明文字，四个任务就是四行重复
    expect(neverRan).toHaveAttribute('data-alarm', 'false')
    expect(overdue).toHaveAttribute('data-alarm', 'true')
    expect(overdue).toHaveTextContent('已经落后')
    // 而且「从没跑过」在一张卡片上只出现一次：徽标说了，右边就不再重复一遍
    expect(within(neverRan!).getAllByText('从没跑过')).toHaveLength(1)
  })

  test('running 说「正在跑」', async () => {
    await mount(payload({ jobs: [job({ health: 'running' })] }))
    expect((await screen.findAllByTestId('job-card'))[0]).toHaveTextContent('正在跑')
  })

  test('overdue 显眼：格子上是告警色，页面顶上还有一条横幅点名调度器', async () => {
    await mount(payload({ jobs: [job({ health: 'overdue' }), job({ name: 'x', health: 'ok' })] }))
    const card = (await screen.findAllByTestId('job-card'))[0]!
    expect(card).toHaveAttribute('data-alarm', 'true')
    expect(card).toHaveTextContent('已经落后')
    const banner = screen.getByTestId('jobs-overdue')
    expect(banner).toHaveTextContent('调度器')
    expect(banner).toHaveTextContent('归档到 NAS')
  })

  test('没有 overdue 就没有那条横幅', async () => {
    await mount()
    expect(screen.queryByTestId('jobs-overdue')).toBeNull()
  })

  test('认不出的 health 说「未知」，绝不说「正常」', async () => {
    await mount(payload({ jobs: [job({ health: 'paused_by_operator' })] }))
    const card = (await screen.findAllByTestId('job-card'))[0]!
    expect(card).toHaveTextContent('未知状态')
    expect(card).toHaveTextContent('paused_by_operator')
    expect(card).not.toHaveTextContent('正常')
  })
})

describe('上次运行那一行', () => {
  test('还没跑完时说「还没跑完」，不给一个会持续变大的耗时', async () => {
    await mount(
      payload({
        jobs: [job({ health: 'running', lastRun: run({ status: 'running', finishedAt: null, durationSec: null }) })],
      }),
    )
    const card = (await screen.findAllByTestId('job-card'))[0]!
    expect(within(card).getByTestId('job-last')).toHaveTextContent('还没跑完')
  })

  test('手动触发还在排队（没开跑）时不编一个开始时间', async () => {
    await mount(
      payload({
        jobs: [job({ lastRun: run({ status: 'queued', startedAt: null, finishedAt: null, durationSec: null }) })],
      }),
    )
    expect(await screen.findByTestId('job-last')).toHaveTextContent('还没被调度器认领')
  })

  test('摘要里的数字摆出来，认不出的键原样显示', async () => {
    await mount(
      payload({ jobs: [job({ lastRun: run({ summary: { newlyArchived: 12, failed: 1, brandNewKey: 4 } }) })] }),
    )
    const last = await screen.findByTestId('job-last')
    expect(last).toHaveTextContent('新归档')
    expect(last).toHaveTextContent('12')
    expect(last).toHaveTextContent('brandNewKey')
  })

  test('上一轮的报错原样显示', async () => {
    await mount(payload({ jobs: [job({ lastRun: run({ status: 'failed', error: 'NAS 写入超时' }) })] }))
    expect(await screen.findByTestId('job-last')).toHaveTextContent('NAS 写入超时')
  })
})

describe('失败项 · 需要处理', () => {
  test('影响与已重试次数都在表里（spec 写死的两列）', async () => {
    await mount(payload({ failuresTotal: 1, failures: [failure()] }))
    const table = await screen.findByTestId('failures-table')
    expect(table).toHaveTextContent('未归档，到期会永久丢失')
    expect(table).toHaveTextContent('2 / 5')
    expect(table).toHaveTextContent('客户沟通 · 华东区')
    expect(table).toHaveTextContent('NAS 写入超时（30 秒）')
  })

  test('重试到上限的那条标出来——意思是该找人了，不是系统放弃了', async () => {
    await mount(payload({ failuresTotal: 1, failures: [failure({ attempts: 5, escalated: true })] }))
    const row = await screen.findByTestId('failure-row')
    expect(row).toHaveAttribute('data-escalated', 'true')
    expect(row).toHaveTextContent('5 / 5')
  })

  test('拿不到人读的名字时照 target 显示，不留空', async () => {
    await mount(payload({ failuresTotal: 1, failures: [failure({ targetLabel: '', target: 'kb-indexer', meetingId: null })] }))
    expect(await screen.findByTestId('failure-row')).toHaveTextContent('kb-indexer')
  })

  test('被 100 条上限截断时说清还有多少条没列出来', async () => {
    const many = Array.from({ length: 100 }, (_, i) => failure({ id: i + 1 }))
    await mount(payload({ failuresTotal: 137, failures: many }))
    const note = await screen.findByTestId('failures-truncated')
    expect(note).toHaveTextContent('137')
    expect(note).toHaveTextContent('37')
  })

  test('没被截断时不出现那句话', async () => {
    await mount(payload({ failuresTotal: 1, failures: [failure()] }))
    await screen.findByTestId('failures-table')
    expect(screen.queryByTestId('failures-truncated')).toBeNull()
  })

  test('一条失败项都没有时明确说出来，并说清失败项不会被静默丢弃', async () => {
    await mount()
    const empty = await screen.findByTestId('failures-empty')
    expect(empty).toHaveTextContent('没有待处理的失败项')
  })

  test('「会被自动重试」写在列名上（spec §4.8 的产品承诺），不是表头上方一段话', async () => {
    await mount(payload({ failuresTotal: 1, failures: [failure()] }))
    const table = await screen.findByTestId('failures-table')
    // 列名把「自动」写进去，逐行的「2 / 5」就是这条承诺可核对的样子
    expect(within(table).getByRole('columnheader', { name: '已自动重试' })).toBeInTheDocument()
    expect(table).toHaveTextContent('2 / 5')
  })
})

describe('手动触发', () => {
  test('POST 到 /api/v1/admin/jobs/:name/run', async () => {
    const { calls } = await mount(payload({ jobs: [job({ name: 'cleanup_expired' })] }))
    await userEvent.click(await screen.findByRole('button', { name: '立即运行' }))
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/admin/jobs/cleanup_expired/run')).toBe(true),
    )
  })

  test('成功后显示后端那句话，且不许说成「已完成」', async () => {
    await mount(payload({ jobs: [job()] }))
    await userEvent.click(await screen.findByRole('button', { name: '立即运行' }))
    const note = await screen.findByTestId('job-run-note')
    expect(note).toHaveTextContent('已排队')
    expect(note).toHaveTextContent('下一个 tick')
    expect(note).not.toHaveTextContent('已完成')
  })

  test('触发之后重新取一遍数据（运行记录会变）', async () => {
    const { calls } = await mount(payload({ jobs: [job()] }))
    await userEvent.click(await screen.findByRole('button', { name: '立即运行' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBe(2))
  })

  test('触发失败时把错误显示出来，按钮回到可点', async () => {
    await mount(payload({ jobs: [job({ name: 'nope' })] }), {
      runStatus: 404,
      runBody: { error: 'unknown_job', name: 'nope', knownJobs: [] },
    })
    const btn = await screen.findByRole('button', { name: '立即运行' })
    await userEvent.click(btn)
    const note = await screen.findByTestId('job-run-note')
    expect(note).toHaveTextContent('unknown_job')
    expect(await screen.findByRole('button', { name: '立即运行' })).toBeEnabled()
  })
})

describe('「拉取连续失败」的措辞（计划 G-d）', () => {
  const failedRuns = Array.from({ length: TENCENT_DOWN_STREAK }, () => run({ status: 'failed' }))

  test('逐字用 api/admin/health.ts 的 fetchStreakText()，与系统状态条同一句', async () => {
    await mount(payload({ jobs: [job({ name: 'fetch_recordings', label: '拉取新录制', recentRuns: failedRuns })] }))
    const bar = await screen.findByTestId('jobs-fetch-stalled')
    expect(bar).toHaveTextContent(fetchStreakText(TENCENT_DOWN_STREAK))
  })

  test('主语是那个任务，不是腾讯会议——我们没有那个探测', async () => {
    await mount(
      payload({ jobs: [job({ name: 'fetch_recordings', label: '拉取新录制', recentRuns: failedRuns })] }),
    )
    const bar = await screen.findByTestId('jobs-fetch-stalled')
    // 说的是「这个任务连着没跑成」这个观察本身，句子里没有一处把它说成一个结论
    expect(bar).toHaveTextContent('拉取新录制')
    expect(bar).toHaveTextContent('连着没跑成')
    expect(bar.textContent ?? '').not.toContain('腾讯会议不可达')
    // 受影响的范围说清楚：那是这句观察本身说不出来的事
    expect(bar).toHaveTextContent('不受影响')
  })

  test('没连续失败到阈值就没有这条', async () => {
    await mount()
    expect(screen.queryByTestId('jobs-fetch-stalled')).toBeNull()
  })
})

describe('「新建任务」按钮已删（裁定 G-g）', () => {
  test('页面上没有这个按钮——留一个点了弹「还没做」的按钮比没有更差', async () => {
    await mount()
    await screen.findAllByTestId('job-card')
    expect(screen.queryByRole('button', { name: /新建任务/ })).toBeNull()
    expect(screen.queryByText(/新建任务/)).toBeNull()
  })
})

describe('窄屏一行一张卡片（spec §11 缺口 2）', () => {
  test('失败项表的六个格子都带 data-label', async () => {
    await mount(payload({ failuresTotal: 1, failures: [failure()] }))
    const row = await screen.findByTestId('failure-row')
    const labels = [...row.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))
    // 「影响」改名「如果不处理」（D-jobs-storage brief）：这句话现在只在这张表
    // 里、只对真正失败的那一项写一次，不再是每张任务卡固定挂的一行。
    expect(labels).toEqual(['最近失败', '任务', '对象', '原因', '已自动重试', '如果不处理'])
  })
})

describe('任务链：横排 → 窄屏退回竖排（D-jobs-storage brief）', () => {
  test('四段挂在同一个 ul[aria-label] 容器里（a11y 门槛认的就是这个选择器）', async () => {
    await mount()
    const chain = screen.getByRole('list', { name: '内置定时任务' })
    expect(chain.tagName).toBe('UL')
    expect(within(chain).getAllByTestId('job-card')).toHaveLength(4)
  })

  test('Jobs.module.css 里有一条按宽度收窄的媒体查询，把 .chain 收回单列——\n      1440 / 1050 / 375 三个宽度都不许横向溢出，四段横排在 1050 会溢出', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/Jobs/Jobs.module.css'), 'utf-8')
    const at = css.search(/@media\s*\(max-width:\s*[\d.]+em\)/)
    expect(at, '应该有一条按宽度收窄的媒体查询——硬规矩 7 盯着 1050 / 375 不许横向溢出').toBeGreaterThanOrEqual(0)
    const body = blockAfter(css, at)
    expect(body, '媒体查询的花括号应该配得平').not.toBeNull()
    expect(body).toMatch(/\.chain\s*\{[^}]*grid-template-columns:\s*1fr/)
  })
})

describe('迷你柱图：没数据就不画，不画假的（D-jobs-storage brief）', () => {
  test('从没跑过的任务，整段里连 job-spark 容器都不出现', async () => {
    await mount(payload({ jobs: [job({ recentRuns: [], lastRun: null, health: 'never_ran' })] }))
    const card = (await screen.findAllByTestId('job-card'))[0]!
    // 这是 sparkBars([]) 返回空数组（JobsView.test.ts 已经单测过）在组件层面
    // 的另一半：调用方据此干脆不渲染容器，不是渲染一个空的容器。
    expect(within(card).queryByTestId('job-spark')).toBeNull()
  })
})

/** 取出 `sel {` 之后配对到的那一层花括号内容，与 scripts/a11y-check.ts 的
 *  同名工具函数同一个写法——嵌套花括号（这里是 .chain{} / .job{} 挨在一起）
 *  用非贪婪正则配不平，必须真的数深度。 */
function blockAfter(src: string, from: number): string | null {
  const open = src.indexOf('{', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

describe('只读账号（spec §11 缺口 1）', () => {
  test('「立即运行」禁用而不是消失，并且说得出为什么', async () => {
    stubApi(payload())
    renderAsRole(<JobsPage />, 'readonly')
    const btns = await screen.findAllByRole('button', { name: '立即运行' })
    expect(btns).toHaveLength(4)
    for (const b of btns) {
      expect(b).toBeDisabled()
      expect(b).toHaveAttribute('title', '只读账号不能改')
    }
  })

  test('页头有一句说明，不用把鼠标停在按钮上才知道', async () => {
    stubApi(payload())
    renderAsRole(<JobsPage />, 'readonly')
    await screen.findAllByTestId('job-card')
    expect(screen.getByTestId('readonly-banner')).toHaveTextContent('只读角色')
  })

  test('管理员这一侧不受影响：按钮能点', async () => {
    stubApi(payload())
    render(<JobsPage />)
    const btns = await screen.findAllByRole('button', { name: '立即运行' })
    expect(btns[0]).toBeEnabled()
    expect(screen.queryByTestId('readonly-banner')).toBeNull()
  })
})
