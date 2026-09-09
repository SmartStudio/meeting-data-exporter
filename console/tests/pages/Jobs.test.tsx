import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { render, renderAsRole } from '../helpers/session'
import userEvent from '@testing-library/user-event'
import { TENCENT_DOWN_STREAK, fetchStreakText } from '../../src/api/admin/health'
import JobsPage from '../../src/pages/Jobs'
import { SystemStateProvider, SystemHealthProvider } from '../../src/app/SystemStatus'

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

/** 五个内置任务。第五条的四句文案逐字照 `JOB_CATALOG`（与 `api/mock/jobs.ts` 同一份）。 */
const FIVE = [
  job({ name: 'fetch_recordings', label: '拉取新录制', what: '发现新录制、入队并下载', schedule: '每 15 分钟' }),
  job(),
  job({ name: 'cleanup_expired', label: '清理到期文件', what: '删本地文件，记录与 NAS 路径保留', schedule: '每天 03:00' }),
  job({ name: 'refresh_inventory', label: '刷新采集清单', what: '重算哪些会议对哪些程序可见', schedule: '每 5 分钟' }),
  job({
    name: 'auto_grant',
    label: '自动授权',
    what: '把规则放行的会议授权给开了自动授权的程序',
    schedule: '每 5 分钟',
    impact: '新会议不会自动授权，程序取不到',
  }),
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
    detail: null,
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
    jobs: FIVE,
    failuresTotal: 0,
    fetchLookbackHours: 24,
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

/**
 * 把页面挂进**真实的** `SystemHealthProvider` 里。
 *
 * 不手工注入一个假的 alert：那样测的是"我以为 liveAlert() 会返回什么"。
 * 这里喂的是两条真端点的响应（`/storage` 与 `/jobs`，`fetchSystemHealth()`
 * 两条都要），让顶栏那一侧走完自己的推导——「顶栏正推出 fetch-stalled 时页内那条
 * 照样在」这件事因此是被真的执行到的，不是被断言假设的。
 */
async function mountWithAlert(opts: { nasReachable: boolean }, body: unknown = payload()) {
  const storage = {
    nas: {
      root: '/nas',
      reachable: opts.nasReachable,
      checkedAt: 0,
      error: opts.nasReachable ? null : 'EROFS',
      pendingMeetings: 3,
    },
  }
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const out = String(url).includes('/admin/storage') ? storage : body
    return new Response(JSON.stringify(out), {
      status: (init?.method ?? 'GET') === 'POST' ? 202 : 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', f)
  render(
    <SystemStateProvider>
      <SystemHealthProvider>
        <JobsPage />
      </SystemHealthProvider>
    </SystemStateProvider>,
  )
  await screen.findByRole('heading', { name: '定时任务', level: 1 })
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

describe('五个任务格子', () => {
  test('五个都在，各自带名字、频率、干什么', async () => {
    await mount()
    const cards = await screen.findAllByTestId('job-card')
    expect(cards).toHaveLength(5)
    const byName = (n: string) => cards.find((c) => c.getAttribute('data-job') === n)!
    expect(byName('fetch_recordings')).toHaveTextContent('拉取新录制')
    expect(byName('fetch_recordings')).toHaveTextContent('每 15 分钟')
    expect(byName('fetch_recordings')).toHaveTextContent('发现新录制、入队并下载')
    expect(byName('cleanup_expired')).toHaveTextContent('清理到期文件')
    expect(byName('cleanup_expired')).toHaveTextContent('每天 03:00')
  })

  test('分两组：拉取 → 归档 → 自动授权串成主链路，清理与刷新各自独立', async () => {
    await mount()
    const chain = await screen.findByTestId('jobs-lane-chain')
    const solo = await screen.findByTestId('jobs-lane-solo')
    const names = (el: HTMLElement) =>
      within(el)
        .getAllByTestId('job-card')
        .map((c) => c.getAttribute('data-job'))
    // 后端 JOB_CHAINS 的拓扑：归档接在拉取后面，自动授权接在两者后面。
    // 原来五个格子一行排开、格格之间画箭头，把「清理 → 刷新」也画成了因果。
    expect(names(chain)).toEqual(['fetch_recordings', 'archive_nas', 'auto_grant'])
    expect(names(solo)).toEqual(['cleanup_expired', 'refresh_inventory'])
    expect(chain).toHaveTextContent('主链路')
    expect(solo).toHaveTextContent('独立运行')
    const auto = within(chain).getAllByTestId('job-card')[2]!
    expect(auto).toHaveTextContent('自动授权')
    expect(auto).toHaveTextContent('把规则放行的会议授权给开了自动授权的程序')
    expect(auto).toHaveTextContent('每 5 分钟')
  })

  test('序号只标链上的步数（一、二、三）；独立任务没有序号', async () => {
    await mount()
    const chain = await screen.findByTestId('jobs-lane-chain')
    const solo = await screen.findByTestId('jobs-lane-solo')
    // 序号是标题前面那个元素；没有序号时标题前面什么都没有
    const ord = (c: HTMLElement) => c.querySelector('h3')?.previousElementSibling?.textContent ?? null
    expect(within(chain).getAllByTestId('job-card').map(ord)).toEqual(['一', '二', '三'])
    for (const c of within(solo).getAllByTestId('job-card')) expect(ord(c)).toBeNull()
  })

  test('段间的方向有读屏文字：链上每一段说清它通向哪，链尾与独立任务不说', async () => {
    await mount()
    const chain = await screen.findByTestId('jobs-lane-chain')
    const [fetch, archive, auto] = within(chain).getAllByTestId('job-card')
    expect(fetch).toHaveTextContent('「拉取新录制」有新产出时，「归档到 NAS」立刻接着跑')
    expect(archive).toHaveTextContent('「归档到 NAS」有新产出时，「自动授权」立刻接着跑')
    expect(auto).not.toHaveTextContent('立刻接着跑')
    const solo = await screen.findByTestId('jobs-lane-solo')
    expect(solo).not.toHaveTextContent('立刻接着跑')
  })

  test('自动授权那一轮的关键数是「新授权」，不是候选数', async () => {
    await mount(
      payload({
        jobs: [
          job({
            name: 'auto_grant',
            label: '自动授权',
            lastRun: run({ summary: { candidates: 5, granted: 2, skippedRevoked: 1, failedPrograms: 0 } }),
          }),
        ],
      }),
    )
    const card = (await screen.findAllByTestId('job-card'))[0]!
    expect(card).toHaveTextContent('新授权')
    // 摘要那一行把三个键都翻成中文，「人工撤销过」不许被吞掉
    expect(within(card).getByTestId('job-last')).toHaveTextContent('人工撤销过，跳过')
    expect(within(card).getByTestId('job-last')).toHaveTextContent('规则放行')
  })

  test('「下次」写成预计而不是承诺——调度器停了它照样算得出', async () => {
    await mount()
    const cards = await screen.findAllByTestId('job-card')
    expect(cards[0]).toHaveTextContent('下次预计')
    expect(cards[0]).toHaveTextContent('10 分钟后')
  })

  test('「影响」不再四张卡常驻——只在这个任务真的出问题时才现身', async () => {
    // D-jobs-storage 改版：四行常驻的影响说明收窄成脚注，正常任务不再挂这一行；
    // 真正卡住的那一段（overdue 或有未处理失败项）仍然要看得到，这是失败项表
    // 「如果不处理」列之外，唯一还会说这句话的地方。
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
    // 标签是「影响：」，不是那七个字。这一行挤在 298px 宽的卡片里，
    // 前缀越长，真正要读的那句话越晚开始
    expect(stuckCard).toHaveTextContent('影响：')
    expect(stuckCard).not.toHaveTextContent('没跑成的后果')
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

  test('成功后说「已排队」并带上编号，不许说成「已完成」', async () => {
    await mount(payload({ jobs: [job()] }))
    await userEvent.click(await screen.findByRole('button', { name: '立即运行' }))
    const note = await screen.findByTestId('job-run-note')
    expect(note).toHaveTextContent('已排队')
    // 202 = 接受了、还没执行。说成「已完成」是这条路径上唯一致命的措辞
    expect(note).not.toHaveTextContent('已完成')
    // 编号是卡片说不出来的那件事：审计里那一行记的就是 run #<id>，
    // 它是把「我刚才点的那一下」和事后翻出来的记录对上的唯一凭据
    expect(note).toHaveTextContent(`#${ACCEPTED.runId}`)
  })

  test('不照抄后端那句话 —— 它是写给没有界面的调用方的', async () => {
    await mount(payload({ jobs: [job()] }))
    await userEvent.click(await screen.findByRole('button', { name: '立即运行' }))
    const note = await screen.findByTestId('job-run-note')
    // 卡片自己那行随即就写着「最近一次触发（排队中）还没被调度器认领」，
    // 同一个事实说第二遍只是把它说长；四个任务都点一遍就是四段一模一样的话
    expect(note.textContent ?? '').not.toContain('worker 进程')
    // 而且这一句在控制台里**是错的**：onRun 里的 retry() 已经刷过了，
    // 照做不会有任何变化。一条让人白做一次动作的指示比啰嗦更糟
    expect(note.textContent ?? '').not.toContain('刷新本页')
    // 短到能一眼看完：原来 73 字
    expect((note.textContent ?? '').length).toBeLessThan(30)
  })

  test('各点各的，两句回执互不相同 —— 不再是几段逐字一样的话', async () => {
    // 桩每次 POST 递增 runId：断言必须由「各自那一次响应」决定，
    // 否则这条测试恒真——那种测试比没有更糟，它会在真出问题时保持绿色
    let seq = 900
    const body = payload({ jobs: [job({ name: 'fetch_recordings' }), job({ name: 'archive_nas' })] })
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const isRun = (init?.method ?? 'GET') === 'POST'
      const out = isRun ? { ...ACCEPTED, runId: ++seq } : body
      return new Response(JSON.stringify(out), {
        status: isRun ? 202 : 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', f)
    render(<JobsPage />)
    await screen.findByRole('heading', { name: '定时任务', level: 1 })

    for (const b of await screen.findAllByRole('button', { name: '立即运行' })) {
      await userEvent.click(b)
    }
    const texts = (await screen.findAllByTestId('job-run-note')).map((n) => n.textContent ?? '')
    expect(texts).toHaveLength(2)
    expect(new Set(texts).size).toBe(2)
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

  // ── 顶栏不再说这一句，这一页是它唯一的出口 ──────────────────────
  //
  // 全局状态条留给「此刻有动作能阻止损失」的事（spec §7.1）。所以就算顶栏的
  // Provider 正推出 fetch-stalled，页内这条也照样在——以前那条「顶栏正在说时让位」
  // 的规则把唯一带关闭按钮的横幅藏掉了，× 在正常路径下永远看不到。

  test('顶栏 Provider 正推出 fetch-stalled 时，页内这条照样出现——顶栏已不显示它', async () => {
    await mountWithAlert(
      { nasReachable: true },
      payload({ jobs: [job({ name: 'fetch_recordings', label: '拉取新录制', recentRuns: failedRuns })] }),
    )
    expect(await screen.findByTestId('jobs-fetch-stalled')).toBeInTheDocument()
  })

  test('第二句写的是能做什么：自动重试、超过拉取窗口要人工补拉，小时数来自后端', async () => {
    await mount(
      payload({
        fetchLookbackHours: 24,
        jobs: [job({ name: 'fetch_recordings', label: '拉取新录制', recentRuns: failedRuns })],
      }),
    )
    const bar = await screen.findByTestId('jobs-fetch-stalled')
    expect(bar).toHaveTextContent('自己再试')
    expect(bar).toHaveTextContent('超过 24 小时')
    expect(bar).toHaveTextContent('修好后需要人工补拉')
  })

  test('拉取窗口不是硬编码的 24：后端给 48 就说 48', async () => {
    await mount(
      payload({
        fetchLookbackHours: 48,
        jobs: [job({ name: 'fetch_recordings', label: '拉取新录制', recentRuns: failedRuns })],
      }),
    )
    const bar = await screen.findByTestId('jobs-fetch-stalled')
    expect(bar).toHaveTextContent('超过 48 小时')
    expect(bar.textContent ?? '').not.toContain('24 小时')
  })
})

/**
 * 关掉这条横幅（`pages/Jobs/dismiss.ts`）。
 *
 * 盯的是那条分界：「关掉」只对**眼前这一段故障**生效。关过就永远不再显示，
 * 与关不掉，是同一个错误的两头——前者会把下一次真故障也一起吞掉。
 */
describe('「拉取连续失败」那条横幅关得掉，但只对这一段故障有效', () => {
  const KEY = 'mde.jobs.fetch-stall.dismissed'
  const LATEST = 907

  /** 最近一次在第 0 个，id 随时间递增——所以最新那条 failed 的 id 最大 */
  function stalled(topId = LATEST, n = TENCENT_DOWN_STREAK): Record<string, unknown> {
    return payload({
      jobs: [
        job({
          name: 'fetch_recordings',
          label: '拉取新录制',
          recentRuns: Array.from({ length: n }, (_, i) => run({ id: topId - i, status: 'failed' })),
        }),
      ],
    })
  }

  // 每条用例前后都清一遍：关闭状态存在 localStorage 里，串到别的用例上就会
  // 变成"这一条单独跑能过、整个文件跑就挂"
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  test('点「关闭这条提醒」，横幅消失，并记下这一段故障的身份', async () => {
    await mount(stalled())
    expect(await screen.findByTestId('jobs-fetch-stalled')).toBeInTheDocument()
    await userEvent.click(within(screen.getByTestId('jobs-fetch-stalled')).getByRole('button', { name: '关闭这条提醒' }))
    await waitFor(() => expect(screen.queryByTestId('jobs-fetch-stalled')).toBeNull())
    expect(localStorage.getItem(KEY)).toBe(String(LATEST))
  })

  test('这一段故障已经关过：首次渲染就没有这条横幅', async () => {
    localStorage.setItem(KEY, String(LATEST))
    await mount(stalled())
    // 等数据真的到了再断言「没有」——加载态下什么都还没渲染，那时的 null 不算数
    await screen.findAllByTestId('job-card')
    expect(screen.queryByTestId('jobs-fetch-stalled')).toBeNull()
  })

  test('关过的是更早那一轮，之后又失败一轮：横幅回来', async () => {
    localStorage.setItem(KEY, String(LATEST))
    await mount(stalled(LATEST + 1, TENCENT_DOWN_STREAK + 1))
    expect(await screen.findByTestId('jobs-fetch-stalled')).toBeInTheDocument()
  })

  test('连续失败结束（最近一轮跑成了）：那个身份被删掉，下一段故障从头提醒', async () => {
    localStorage.setItem(KEY, String(LATEST))
    await mount() // 默认五个任务最近两轮都是 succeeded
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
  })

})

/**
 * 落后横幅也关得掉（规格 2026-09-09 §2.1），但同样只对**这一批落后**有效。
 *
 * 原来的规矩是「不能关」，理由是它是这件事在控制台里唯一的出处。那条理由仍然成立
 * ——所以关掉的粒度是「这一批」，不是「以后都别说了」：任一落后任务再跑一轮、
 * 或者落后的集合变了，它就回来。
 */
describe('「N 个任务已经落后」那条横幅关得掉，但只对这一批有效', () => {
  const KEY = 'mde.jobs.overdue.dismissed'

  function overduePayload(runId = 900): Record<string, unknown> {
    return payload({
      jobs: [
        job({ name: 'archive_nas', label: '归档到 NAS', health: 'overdue', lastRun: run({ id: runId }) }),
        job({ name: 'fetch_recordings', label: '拉取新录制', health: 'ok' }),
      ],
    })
  }

  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  test('点「关闭这条提醒」，横幅消失，并记下这一批的身份', async () => {
    await mount(overduePayload())
    expect(await screen.findByTestId('jobs-overdue')).toBeInTheDocument()
    const banner = screen.getByTestId('jobs-overdue')
    await userEvent.click(within(banner).getByRole('button', { name: '关闭这条提醒' }))
    await waitFor(() => expect(screen.queryByTestId('jobs-overdue')).toBeNull())
    expect(localStorage.getItem(KEY)).toBe('archive_nas@900')
  })

  test('这一批已经关过：首次渲染就没有这条横幅', async () => {
    localStorage.setItem(KEY, 'archive_nas@900')
    await mount(overduePayload())
    await screen.findAllByTestId('job-card')
    expect(screen.queryByTestId('jobs-overdue')).toBeNull()
  })

  test('那个落后的任务又跑了一轮：横幅回来', async () => {
    localStorage.setItem(KEY, 'archive_nas@900')
    await mount(overduePayload(901))
    expect(await screen.findByTestId('jobs-overdue')).toBeInTheDocument()
  })

  test('一个落后的都没有了：那个身份被删掉，下一批从头提醒', async () => {
    localStorage.setItem(KEY, 'archive_nas@900')
    await mount()   // 默认五个任务都是 ok
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
  })

  test('两条横幅同时在时各关各的：关掉落后那条，连续失败那条还在', async () => {
    const both = payload({
      jobs: [
        job({ name: 'archive_nas', label: '归档到 NAS', health: 'overdue', lastRun: run({ id: 900 }) }),
        job({
          name: 'fetch_recordings', label: '拉取新录制', health: 'ok',
          recentRuns: Array.from({ length: TENCENT_DOWN_STREAK }, (_, i) => run({ id: 800 - i, status: 'failed' })),
        }),
      ],
    })
    await mount(both)
    const overdue = await screen.findByTestId('jobs-overdue')
    // 两条的可访问名相同（都是「关闭这条提醒」），所以按 testid 定位到各自那一颗
    await userEvent.click(within(overdue).getByRole('button', { name: '关闭这条提醒' }))
    await waitFor(() => expect(screen.queryByTestId('jobs-overdue')).toBeNull())
    expect(screen.getByTestId('jobs-fetch-stalled')).toBeInTheDocument()
    expect(localStorage.getItem('mde.jobs.fetch-stall.dismissed')).toBeNull()
  })
})

describe('卡片上那句「影响」不与失败项表重复', () => {
  const IMPACT = '录制在腾讯会议过期后就再也拉不回来了'

  test('失败项表里已经列着这个任务的失败行时，卡片上那句不再出现', async () => {
    await mount(
      payload({
        jobs: [job({ name: 'fetch_recordings', health: 'overdue', openFailures: 1, impact: IMPACT })],
        failures: [failure({ jobName: 'fetch_recordings', impact: IMPACT })],
      }),
    )
    const card = await screen.findByTestId('job-card')
    expect(card).not.toHaveTextContent('影响：')
    // 同一句话仍然在屏幕上 —— 只是由那张表说
    expect(await screen.findByTestId('failure-row')).toHaveTextContent(IMPACT)
  })

  test('任务落后但一条失败项都没有时，卡片这句是唯一的出处', async () => {
    // 调度器停了，压根没跑到会失败的那一步 —— 那时表是空的
    await mount(
      payload({
        jobs: [job({ name: 'fetch_recordings', health: 'overdue', openFailures: 0, impact: IMPACT })],
        failures: [],
      }),
    )
    const card = await screen.findByTestId('job-card')
    expect(card).toHaveTextContent('影响：')
    expect(card).toHaveTextContent(IMPACT)
  })

  test('失败行存在、但「如果不处理」写的是另一句时，卡片这句不能被藏掉', async () => {
    // 失败行的 impact 是**独立的一列**，可以逐条不同（原型数据就是这样）。
    // 按「有没有失败行」这个代理指标抑制，会把一句根本不重复的话也藏掉 ——
    // 第一版就是这么错的，靠把页面真的渲染出来才发现，不是靠这里的断言。
    await mount(
      payload({
        jobs: [job({ name: 'fetch_recordings', health: 'overdue', openFailures: 1, impact: IMPACT })],
        failures: [failure({ jobName: 'fetch_recordings', impact: '这一轮一场都没拉成。' })],
      }),
    )
    const card = await screen.findByTestId('job-card')
    expect(card).toHaveTextContent('影响：')
    expect(card).toHaveTextContent(IMPACT)
  })

  test('失败行被那张表截断掉时，卡片这句要回来', async () => {
    // 那张表一次最多 100 条。被截断掉的行不在屏幕上，此时卡片是唯一的出处 ——
    // 判据因此是「这条失败此刻在不在屏幕上」，不是「有没有未处理的失败」。
    await mount(
      payload({
        jobs: [job({ name: 'fetch_recordings', health: 'overdue', openFailures: 7, impact: IMPACT })],
        failures: [failure({ jobName: 'archive_nas' })],
      }),
    )
    const card = await screen.findAllByTestId('job-card')
    expect(card[0]).toHaveTextContent('影响：')
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
    // 一行是一件事（按任务 + 原因归并），所以任务与原因在前，「涉及」说这件事牵扯了什么
    expect(labels).toEqual(['任务', '原因', '涉及', '最近失败', '已自动重试', '如果不处理'])
  })
})

describe('任务链：横排 → 窄屏退回竖排（D-jobs-storage brief）', () => {
  test('两组各挂在一个 ul[aria-label] 容器里（a11y 门槛认的就是这两个选择器）', async () => {
    await mount()
    const chain = screen.getByRole('list', { name: '主链路' })
    const solo = screen.getByRole('list', { name: '独立运行' })
    expect(chain.tagName).toBe('UL')
    expect(solo.tagName).toBe('UL')
    expect(within(chain).getAllByTestId('job-card')).toHaveLength(3)
    expect(within(solo).getAllByTestId('job-card')).toHaveLength(2)
  })

  test('Jobs.module.css 里有一条按宽度收窄的媒体查询，把 .cards 收回单列——\n      1440 / 1050 / 375 三个宽度都不许横向溢出，三段横排在 900 以下会溢出', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/Jobs/Jobs.module.css'), 'utf-8')
    const at = css.search(/@media\s*\(max-width:\s*[\d.]+em\)/)
    expect(at, '应该有一条按宽度收窄的媒体查询——硬规矩 7 盯着 1050 / 375 不许横向溢出').toBeGreaterThanOrEqual(0)
    const body = blockAfter(css, at)
    expect(body, '媒体查询的花括号应该配得平').not.toBeNull()
    expect(body).toMatch(/\.cards\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/)
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
    expect(btns).toHaveLength(5)
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

describe('失败项按「任务 + 原因」归并', () => {
  /** 拉取那一轮里在腾讯会议那头 404 的一场：没有标题，只有会议 id。 */
  const same = (i: number, over: Record<string, unknown> = {}) =>
    failure({
      id: i,
      jobName: 'fetch_recordings',
      target: `m-${i}|`,
      targetLabel: '',
      meetingId: `90708${i}`,
      reason: '下载重试用尽，已放弃：video（http 404）',
      impact: '录制在腾讯会议过期后就再也拉不回来了',
      attempts: 5,
      escalated: true,
      ...over,
    })

  test('18 条一模一样的原因是一行，不是 18 行；涉及写成「18 场会议」', async () => {
    const many = Array.from({ length: 18 }, (_, i) => same(i + 1))
    await mount(payload({ failuresTotal: 18, failures: many }))
    const rows = await screen.findAllByTestId('failure-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('18 场会议')
    expect(rows[0]).toHaveTextContent('5 / 5')
    expect(rows[0]).toHaveAttribute('data-escalated', 'true')
    expect(rows[0]).toHaveTextContent('已到上限 · 需要人工介入')
    // 原因只印一遍
    expect(screen.getAllByText('下载重试用尽，已放弃：video（http 404）')).toHaveLength(1)
  })

  test('原因差一段就是另一件事，另占一行', async () => {
    await mount(
      payload({
        failuresTotal: 3,
        failures: [
          same(1),
          same(2),
          same(3, { reason: '下载重试用尽，已放弃：video（http 404）；meeting_summary（ENOENT）' }),
        ],
      }),
    )
    expect(await screen.findAllByTestId('failure-row')).toHaveLength(2)
  })

  test('展开一组能看到每一场会议的 id、多久前、重试次数；超过 20 条再翻', async () => {
    const many = Array.from({ length: 25 }, (_, i) => same(i + 1, { attempts: 2, escalated: false }))
    await mount(payload({ failuresTotal: 25, failures: many }))
    const user = userEvent.setup()
    expect(screen.queryByTestId('failure-items')).toBeNull()
    await user.click(await screen.findByTestId('failure-scope'))
    const items = await screen.findByTestId('failure-items')
    expect(within(items).getAllByRole('listitem')).toHaveLength(20)
    expect(items).toHaveTextContent('907081')
    expect(items).toHaveTextContent('2 / 5')
    expect(items).toHaveTextContent('还有 5 条')
    await user.click(within(items).getByRole('button', { name: /再显示 5 条/ }))
    expect(within(items).getAllByRole('listitem')).toHaveLength(25)
  })

  test('会议维度的失败项拿不到标题时显示会议 id，不显示 `id|` 那个规范化键', async () => {
    await mount(payload({ failuresTotal: 1, failures: [same(1)] }))
    const row = await screen.findByTestId('failure-row')
    expect(row).toHaveTextContent('907081')
    expect(row).not.toHaveTextContent('m-1|')
  })

  test('一部分到上限时说清几条到了，不把整组标成已到上限；重试次数给区间不取平均', async () => {
    await mount(payload({ failuresTotal: 2, failures: [same(1), same(2, { attempts: 2, escalated: false })] }))
    const row = await screen.findByTestId('failure-row')
    expect(row).toHaveAttribute('data-escalated', 'partial')
    expect(row).toHaveTextContent('2–5 / 5')
    expect(row).toHaveTextContent('1 条已到上限')
  })

  test('失败项散在两个以上任务时才给按任务筛选；筛选后只剩那个任务的组', async () => {
    await mount(payload({ failuresTotal: 3, failures: [same(1), same(2), failure({ id: 3 })] }))
    const user = userEvent.setup()
    const facets = await screen.findByTestId('failures-facets')
    expect(facets).toHaveTextContent('全部 3')
    expect(facets).toHaveTextContent('拉取新录制 2')
    expect(facets).toHaveTextContent('归档到 NAS 1')
    expect(screen.getAllByTestId('failure-row')).toHaveLength(2)
    await user.click(within(facets).getByRole('button', { name: '归档到 NAS 1' }))
    const rows = screen.getAllByTestId('failure-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('客户沟通 · 华东区')
  })

  test('全在一个任务里时没有筛选——「全部 19」与「拉取新录制 19」说的是同一件事', async () => {
    await mount(payload({ failuresTotal: 2, failures: [same(1), same(2)] }))
    await screen.findByTestId('failures-table')
    expect(screen.queryByTestId('failures-facets')).toBeNull()
  })

  test('组超过 12 个时分页，页面高度不随失败项数无限长', async () => {
    const distinct = Array.from({ length: 15 }, (_, i) => same(i + 1, { reason: `原因 ${i + 1}` }))
    await mount(payload({ failuresTotal: 15, failures: distinct }))
    const user = userEvent.setup()
    expect(await screen.findAllByTestId('failure-row')).toHaveLength(12)
    const more = screen.getByTestId('failures-more-groups')
    expect(more).toHaveTextContent('再显示 3 组')
    await user.click(more)
    expect(screen.getAllByTestId('failure-row')).toHaveLength(15)
    expect(screen.queryByTestId('failures-more-groups')).toBeNull()
  })
})
