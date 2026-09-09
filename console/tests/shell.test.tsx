import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../src/app/routes'
import { PROTO_STORAGE_KEY } from '../src/app/proto'
import { FAILURES_SEEN_KEY } from '../src/app/failuresSeen'
import { SystemStateProvider } from '../src/app/SystemStatus'

/**
 * `AppShell`（Task 6）挂载时会探一次管理员登录态（`fetchAdminIdentity()`，
 * 真的 `fetch('/api/v1/admin/auth/me')`）。F0 之后它还会挂
 * `SystemHealthProvider`，再去读 `GET /admin/storage` 与 `GET /admin/jobs`
 * 两条真实端点（计划 G-d）——`?proto=1` 下不发（那时状态来自顶栏下拉），
 * 但这个文件里有一半的测试跑在默认路径上，所以两条都要答。
 *
 * 这个文件测的是外壳本身的导航/系统状态行为，不是登录态守卫本身（守卫的
 * loading/redirect/error 三态见 `tests/pages/Login.test.tsx`），所以这里统一
 * 把登录探测 stub 成"已登录"、直接放行——不这样做，下面每一条测试都要各自
 * 处理一遍登录探测的异步时序。
 */
export function healthyStorage(): unknown {
  return {
    nas: {
      root: '/mnt/nas',
      reachable: true,
      checkedAt: 1700000000,
      latencyMs: 12,
      error: null,
      totalBytes: 4000000000000,
      availableBytes: 1400000000000,
      usedByUsBytes: 842000000000,
      usedByOthersBytes: 1758000000000,
      archivedMeetings: 71,
      pendingMeetings: 0,
      failedMeetings: null,
      failedMeetingsNote: '归档失败项尚未落库…',
    },
    retention: {
      defaultDays: 30,
      defaultDaysSource: 'setting',
      defaultDaysRaw: '30',
      cleanupPaused: false,
      liveMeetings: 10,
      grantedMeetings: 8,
      expiringIn7dMeetings: 1,
      expiredMeetings: 0,
      localBytes: 900000000,
    },
  }
}

export function healthyJobs(): unknown {
  return {
    now: 1700000000,
    timezoneOffsetSec: 28800,
    jobs: [
      {
        name: 'fetch_recordings',
        label: '拉取新录制',
        what: '从腾讯会议拉新录制',
        schedule: '每 10 分钟',
        nextDueAt: 1700000600,
        impact: '拉不到就没有原始文件',
        maxAttempts: 5,
        openFailures: 0,
        health: 'ok',
        lastRun: null,
        recentRuns: [
          {
            id: 1,
            status: 'succeeded',
            trigger: 'scheduler',
            requestedBy: null,
            startedAt: 1699999800,
            finishedAt: 1699999900,
            durationSec: 100,
            summary: null,
            error: null,
          },
        ],
      },
    ],
    failuresTotal: 0,
    fetchLookbackHours: 24,
    failures: [],
  }
}

/** 会议记录页要的一行。字段名照 api-contracts.md §6，少一个前端就崩。 */
const SHELL_MEETING = {
  id: 'm1',
  meetingId: 'm1',
  subMeetingId: '',
  title: '产品周会',
  code: '881-123-40',
  startAt: 1699900000,
  durationSec: 3600,
  host: 'zouyanjian',
  missing: [],
  assets: { ai_minutes: { got: 3, total: 3 } },
  unknownAssetTypes: [],
  fetch: 'done',
  archive: 'done',
  grants: [],
  hand: [],
  keep: {
    archivedAt: 1699950000,
    expiresAt: 1702542000,
    extended: 0,
    extendedSource: 'none',
    extendedDays: 0,
    retentionDays: 30,
    filesGone: false,
  },
  nasPath: '/nas/meetings/2023/11/88112340/',
  sizeBytes: 120000000,
  allow: 'allow',
  why: {
    fetch: { by: 'rule', text: '拉取规则 #100' },
    archive: { by: 'rule', text: '归档规则 #100' },
    allow: { by: 'rule', text: '权限规则 #100' },
  },
  history: [],
}

/** 分诊五格。**它有自己的端点**，与上面那一行没有关系（F2 的回归点之一）。 */
const TRIAGE = { archiveFailed: 1, expiringIn7d: 0, awaitingGrant: 1, inProgress: 0, nasOnly: 0 }

/**
 * 默认的假后端。`over.jobs` 可以换掉 `GET /admin/jobs` 的响应体（红点那几条要喂失败项），
 * 返回一个永不 resolve 的 Promise 就能让这一条请求挂住（测"重读期间旧数据留在屏幕上"）。
 */
function installFetch(over: { jobs?: () => unknown | Promise<unknown> } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (url.endsWith('/api/v1/admin/auth/me')) {
        return json({ adminId: 'admin-1', username: 'chen.yw', role: 'admin' })
      }
      if (url.endsWith('/api/v1/admin/storage')) return json(healthyStorage())
      if (url.endsWith('/api/v1/admin/jobs')) return json(await (over.jobs ?? healthyJobs)())
      // 接完线的页面挂载时会真的去读自己那条端点。这个文件测的是外壳的导航
      // 与系统状态、不是各页的内容，所以一律给一份最小的合法响应就够——各页
      // 自己的行为在 `tests/pages/` 下各自那份测试里。
      //
      // `/meetings/triage` 必须排在 `/meetings` 前面：后者用 includes 匹配，
      // 不排前面就会把分诊条那条请求一起吃掉，答成一页会议列表。
      if (url.includes('/api/v1/admin/meetings/triage')) return json(TRIAGE)
      if (url.includes('/api/v1/admin/meetings')) {
        return json({ rows: [SHELL_MEETING], total: 1, limit: 10, offset: 0 })
      }
      if (url.includes('/api/v1/admin/programs')) return json([])
      if (url.includes('/api/v1/admin/audit')) {
        return json({
          rows: [],
          total: 0,
          limit: 50,
          offset: 0,
          window: { from: 1699395200, to: null, isDefault: false, days: 7, text: null },
        })
      }
      throw new Error(`shell.test.tsx: 未预期的 fetch ${url}`)
    }),
  )
}

/** 一条失败项，字段照 `api/admin/jobs.ts` 的 readFailure（少一个前端就崩）。 */
function failureRow(lastFailedAt: number): Record<string, unknown> {
  return {
    id: lastFailedAt,
    jobName: 'fetch_recordings',
    target: 'm-1|',
    targetLabel: '',
    meetingId: 'm-1',
    subMeetingId: '',
    reason: '腾讯会议返回 404',
    impact: '这一场拉不到',
    detail: null,
    attempts: 1,
    maxAttempts: 5,
    escalated: false,
    firstFailedAt: lastFailedAt,
    lastFailedAt,
  }
}

/** `healthyJobs()` 外加几条失败项；`failuresTotal` 与卡片上的 `openFailures` 跟着对齐。 */
function jobsWithFailures(lastFailedAts: number[]): unknown {
  const base = healthyJobs() as { jobs: Array<Record<string, unknown>> }
  return {
    ...base,
    jobs: base.jobs.map((j, i) => (i === 0 ? { ...j, openFailures: lastFailedAts.length } : j)),
    failuresTotal: lastFailedAts.length,
    fetchLookbackHours: 24,
    failures: lastFailedAts.map(failureRow),
  }
}

beforeEach(() => installFetch())

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 顶栏下方那条系统告警条。
 *
 * 不能再用 `getByRole('status')` 抓它了：会议记录页（T6）里常驻着一个
 * `role="status"` 的 Toast——真实浏览器里它关闭时是 inert、不在无障碍树里，
 * 但 jsdom 不实现 inert 的行为语义，按角色查照样查得到。用告警条自己的
 * `data-sev` 定位，既避开这一点，也让断言指向真正要测的那个元素。
 */
function systemBanner(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="status"][data-sev]')
}

/**
 * 挂起完整外壳（`SystemStateProvider` + 内存路由），供集成测试用。
 * `initialState`/`initialPath` 让每条测试从想要的起点开始，不用先经过
 * 一轮点击才能到达要测的状态。
 */
function renderApp(initialPath = '/meetings', initialState: Parameters<typeof SystemStateProvider>[0]['initialState'] = 'ok') {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  return render(
    <SystemStateProvider initialState={initialState}>
      <RouterProvider router={router} />
    </SystemStateProvider>,
  )
}

describe('AppShell · 左栏与路由', () => {
  test('左栏六项都在，且当前项有 aria-current', async () => {
    // spec.md §3：左栏是六项，「内容预览」不占导航（从会议记录点标题进入）。
    // 简报 Step 1 的测试标题写「七项」，跟 spec.md §3 的表格本身自相矛盾——
    // 表格列出 7 行，但明确标注内容预览「不在导航」。以 spec 的显式标注和
    // 原型实际渲染（六个 `.nav-item`）为准。
    renderApp('/meetings')
    // 等 useMeetings() 的首轮请求落地，避免测试结束后才 resolve 触发
    // 「未包在 act 里的状态更新」告警——这跟本测试要断言的东西无关。
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toBeInTheDocument())

    const labels = ['会议记录', '采集授权', '自动规则', '定时任务', '归档存储', '操作审计']
    for (const label of labels) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }
    // 内容预览不应该出现在左栏导航里
    expect(screen.queryByRole('link', { name: '内容预览' })).not.toBeInTheDocument()

    const current = screen.getByRole('link', { name: '会议记录' })
    expect(current).toHaveAttribute('aria-current', 'page')
    for (const label of labels.slice(1)) {
      expect(screen.getByRole('link', { name: label })).not.toHaveAttribute('aria-current')
    }
  })

  test('点左栏切路由，内容区跟着换', async () => {
    const user = userEvent.setup()
    renderApp('/meetings')

    expect(await screen.findByRole('heading', { name: '会议记录' })).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: '采集授权' }))

    expect(await screen.findByRole('heading', { name: '采集授权' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '会议记录' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '采集授权' })).toHaveAttribute('aria-current', 'page')
  })

  // 「还没接线的空壳页」那条测试在 F6 合入时删掉了：六个页面全部接完线，
  // 名单空了，它再也断言不到任何东西。它当初的作用是逼每个任务把自己那一行
  // 划掉（留着不删就会红），这个作用已经用完。
  //
  // 接完线的页面各自被自己那份测试盯着（`tests/pages/` 下一页一份）。这里只
  // 留两条与外壳本身有关的：一条盯系统状态横幅那条链的落点，一条验「外壳里挂
  // 一个真的会发请求的页面」不会白屏。

  test('归档存储页已经接上真 API（F5b），不再是空壳', async () => {
    // 系统状态横幅上的「暂停到期清理」链到这一页，所以这里顺带盯着那条链的落点：
    // 页面得真的渲染出那个开关，而不是一句"由 F5b 接线"。
    renderApp('/storage')
    expect(await screen.findByRole('heading', { name: 'NAS 归档', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '暂停到期清理' })).toBeInTheDocument()
    expect(screen.queryByText(/F5b/)).toBeNull()
  })

  test('内容预览页（F6，已接线）在外壳里挂得起来，且仍不占左栏导航', async () => {
    // 这个文件的 fetch stub 不答内容那三条，于是这一页落到它自己的错误态。
    // **这正是要验的**：外壳里挂一个真的会发请求的页面，后端不给内容时它照样
    // 有 h1、有说得出话的错误态，不是一片白。内容本身的行为在
    // tests/pages/Preview.test.tsx 里测。
    const { unmount } = renderApp('/preview/m1')
    expect(await screen.findByRole('heading', { name: '内容预览', level: 1 })).toBeInTheDocument()
    expect(await screen.findByText(/这场会议的内容读不出来/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '内容预览' })).not.toBeInTheDocument()
    unmount()
  })

  test('内容区是唯一的 <main>——空壳页自己不再套一个', async () => {
    renderApp('/consumers')
    expect(await screen.findByRole('heading', { name: '采集授权', level: 1 })).toBeInTheDocument()
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })
})

describe('AppShell · 顶栏', () => {
  // 原型控件默认不渲染，靠 ?proto=1 调出来后记在 sessionStorage 里
  // （见 src/app/GlobalBar.tsx 的 useProtoControls）。这里直接写存储，
  // 因为 renderApp 用的是内存路由，改不了 jsdom 的 window.location.search。
  beforeEach(() => sessionStorage.setItem(PROTO_STORAGE_KEY, '1'))
  afterEach(() => sessionStorage.removeItem(PROTO_STORAGE_KEY))

  test('顶栏没有全局搜索按钮——功能不存在，按钮就不该在', async () => {
    sessionStorage.removeItem(PROTO_STORAGE_KEY)
    renderApp('/meetings')
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toBeInTheDocument())

    // 这里曾经有一颗「搜会议 / 规则 / 程序」按钮，onClick 是空的，还印着 ⌘K 徽标。
    // 两句假话：按钮看起来能按，徽标声称有一个全应用没人监听的键位。
    // 同一句谎也曾在 ShortcutBar 里（已删，见 tests/shortcutBar.test.tsx）。
    // 判据是这个仓库既有的那条：不许放一个名字对、动作不对的按钮。
    // 缺口登记在 docs/console/spec.md §11 第 6 行，不是靠这条注释活着。
    expect(screen.queryByRole('button', { name: /搜会议/ })).toBeNull()
    // ⌘K 全站没人监听（lib/keys.ts 对带修饰键的按键一律返回 null），
    // 所以整个文档里都不该出现这个徽标——顶栏删了，ShortcutBar 也删了。
    expect(screen.queryByText('⌘K')).toBeNull()
  })

  test('默认不渲染原型控件——它们是开发脚手架，不该出现在运维人员的界面里', async () => {
    sessionStorage.removeItem(PROTO_STORAGE_KEY)
    renderApp('/meetings')
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toBeInTheDocument())
    expect(screen.queryByText('原型 · 全部数字为示例')).toBeNull()
    expect(screen.queryByRole('combobox', { name: /系统状态/ })).toBeNull()
  })

  test('带上 ?proto=1 之后保留「原型 · 全部数字为示例」标记', async () => {
    renderApp('/meetings')
    expect(await screen.findByText('原型 · 全部数字为示例')).toBeInTheDocument()
    // 同上：等首轮请求落地再结束，不留悬空的状态更新告警。
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toBeInTheDocument())
  })

  test('系统状态下拉能切到六种形态', async () => {
    const user = userEvent.setup()
    renderApp('/meetings')

    const picker = await screen.findByRole('combobox', { name: /系统状态/ })

    // ok：无告警条，分诊数字来自真实 mock 数据（1 场归档失败，即 m3）
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('1'))
    expect(systemBanner()).toBeNull()

    // selectOptions 按 <option> 的 value 或可见文本匹配；用 value（英文短名）
    // 而不是中文标签，免得标签文案一改这条测试就跟着碎。

    // loading：内容区给出加载中提示，不是空白
    await user.selectOptions(picker, 'loading')
    expect(await screen.findByTestId('meetings-loading')).toHaveTextContent('正在读取')

    // load-failed：错误详情 + 重试，不是「暂无数据」
    await user.selectOptions(picker, 'load-failed')
    const status = await screen.findByTestId('meetings-error')
    expect(status.textContent).toMatch(/失败|错误|不可用|503/)
    expect(within(status).getByRole('button', { name: '重试' })).toBeInTheDocument()

    // empty：一场会议都没有，出口文案存在
    await user.selectOptions(picker, 'empty')
    expect(await screen.findByTestId('meetings-empty')).toHaveTextContent('还没有拉取过任何会议')

    // nas-down：告警条 sev=fail，且给得出「去暂停到期清理」的去处
    await user.selectOptions(picker, 'nas-down')
    await waitFor(() => expect(systemBanner()).not.toBeNull())
    const nasBar = systemBanner()!
    expect(nasBar).toHaveAttribute('data-sev', 'fail')
    expect(within(nasBar).getByRole('link', { name: '暂停到期清理' })).toBeInTheDocument()

    // tencent-down：**没有**告警条（spec §7.1）。这件事在控制台里没有一个能按的动作，
    // 它的出口是左栏底部的摘要——措辞是观察到的事实，不是一句我们探测不到的结论
    await user.selectOptions(picker, 'tencent-down')
    await waitFor(() => expect(document.body.textContent).toContain('拉取连续失败'))
    expect(systemBanner()).toBeNull()
    expect(document.body.textContent).not.toContain('腾讯会议接口不可达')

    // 切回正常，左栏摘要也不再说这件事
    await user.selectOptions(picker, 'ok')
    await waitFor(() => expect(document.body.textContent).not.toContain('拉取连续失败'))
  })

  test('rail 宽度取自 --rail-w，不是写死的 196px', () => {
    // 计算样式在 jsdom 里读不出外部样式表解析出的真实像素值，所以直接查
    // CSS Module 的源文本：必须引用 var(--rail-w)，且不出现字面量 196px。
    const shellCss = readFileSync(resolve(process.cwd(), 'src/app/AppShell.module.css'), 'utf-8')
    const railCss = readFileSync(resolve(process.cwd(), 'src/app/Rail.module.css'), 'utf-8')
    expect(shellCss).toMatch(/var\(--rail-w\)/)
    expect(railCss).toMatch(/var\(--rail-w\)/)
    expect(shellCss).not.toMatch(/196px/)
    expect(railCss).not.toMatch(/196px/)
  })
})

/**
 * 顶栏归位（简报「二」）：标题从路由派生，跟左栏导航同一份文案，不再是
 * 一句空话；「浅色/深色/跟随系统」搬进了头像菜单——那半条断言现在在
 * `tests/userMenu.test.tsx` 里（入口换了地方，覆盖跟着搬，不是被删掉）。
 */
describe('AppShell · 顶栏标题从路由派生', () => {
  test('顶栏标题跟左栏导航同一份文案，切路由跟着换', async () => {
    const user = userEvent.setup()
    renderApp('/meetings')
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toBeInTheDocument())
    expect(screen.getByTestId('topbar-title')).toHaveTextContent('会议记录')

    await user.click(screen.getByRole('link', { name: '采集授权' }))
    await waitFor(() => expect(screen.getByTestId('topbar-title')).toHaveTextContent('采集授权'))
  })

  test('内容预览页不占左栏导航（spec §3），顶栏标题仍然对得上', async () => {
    const { unmount } = renderApp('/preview/m1')
    await waitFor(() => expect(screen.getByTestId('topbar-title')).toHaveTextContent('内容预览'))
    unmount()
  })
})

/**
 * 左栏「定时任务」旁那颗红点。
 *
 * 它以前是一枚计数徽标（`failuresTotal`）。数字与底部「N 项需要处理」重复，而且
 * 整个会话只读一次、处理完了还写着老数。现在它只回答「我看过之后又出事了吗」：
 * 定时任务页读完列表记下最新一条失败的时间（`app/failuresSeen.ts`），比它更新的
 * 失败出现时才亮；换栏目、回前台时 `SystemHealthProvider` 会重读，红点才有机会再亮。
 * 下面盯的是这一整条链：亮 → 看过就灭 → 老的不再亮 → 新的再亮，以及重读本身。
 */
describe('AppShell · 左栏「定时任务」旁的红点', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  const T1 = 1700000100
  const T2 = 1700000200
  const T3 = 1700000300
  const dot = () => screen.queryByTestId('jobs-dot')
  const jobsReads = () =>
    vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/api/v1/admin/jobs')).length

  test('没有失败项：没有红点，链接上也没有数字', async () => {
    renderApp('/meetings')
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toBeInTheDocument())
    const jobsLink = screen.getByRole('link', { name: '定时任务' })
    expect(within(jobsLink).queryByText(/\d/)).not.toBeInTheDocument()
    expect(dot()).toBeNull()
    expect(jobsLink).not.toHaveAttribute('aria-describedby')
  })

  test('有还没看过的失败项：亮红点、不印数字；读屏得到「有新的失败项」；底部摘要照旧说总数', async () => {
    installFetch({ jobs: () => jobsWithFailures([T1, T2]) })
    renderApp('/meetings')
    const jobsLink = await screen.findByRole('link', { name: '定时任务' })
    await waitFor(() => expect(dot()).not.toBeNull())
    expect(within(jobsLink).queryByText(/\d/)).not.toBeInTheDocument()
    expect(jobsLink).toHaveAccessibleDescription('有新的失败项')
    expect(jobsLink).toHaveAttribute('title', '定时任务 · 有新的失败项')
    expect(screen.getByText('2 项需要处理')).toBeInTheDocument()
  })

  test('打开定时任务页、列表读完：红点灭，记号是最新那条的 lastFailedAt', async () => {
    installFetch({ jobs: () => jobsWithFailures([T2, T1]) })
    const user = userEvent.setup()
    renderApp('/meetings')
    await waitFor(() => expect(dot()).not.toBeNull())
    await user.click(screen.getByRole('link', { name: '定时任务' }))
    await waitFor(() => expect(dot()).toBeNull())
    expect(localStorage.getItem(FAILURES_SEEN_KEY)).toBe(String(T2))
    expect(screen.getByRole('link', { name: '定时任务' })).not.toHaveAttribute('aria-describedby')
  })

  test('看过之后：换栏目会重读；老的那几条不再亮，来了更新的才再亮', async () => {
    let times = [T1, T2]
    installFetch({ jobs: () => jobsWithFailures(times) })
    const user = userEvent.setup()
    renderApp('/jobs')
    await waitFor(() => expect(localStorage.getItem(FAILURES_SEEN_KEY)).toBe(String(T2)))
    expect(dot()).toBeNull()

    const before = jobsReads()
    await user.click(screen.getByRole('link', { name: '会议记录' }))
    await waitFor(() => expect(screen.getByTestId('topbar-title')).toHaveTextContent('会议记录'))
    await waitFor(() => expect(jobsReads()).toBeGreaterThan(before))
    expect(dot()).toBeNull()

    times = [T1, T2, T3]
    await user.click(screen.getByRole('link', { name: '采集授权' }))
    await waitFor(() => expect(dot()).not.toBeNull())
    expect(screen.getByText('3 项需要处理')).toBeInTheDocument()
  })

  test('标签页回到前台也重读', async () => {
    let times: number[] = []
    installFetch({ jobs: () => jobsWithFailures(times) })
    renderApp('/meetings')
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toBeInTheDocument())
    expect(dot()).toBeNull()
    times = [T1]
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(dot()).not.toBeNull())
  })

  test('重读期间上一份数据留在屏幕上，不闪「正在检测」', async () => {
    let hang = false
    installFetch({
      jobs: () => (hang ? new Promise<never>(() => undefined) : healthyJobs()),
    })
    const user = userEvent.setup()
    renderApp('/meetings')
    await waitFor(() => expect(screen.getByText('一切正常')).toBeInTheDocument())
    hang = true
    await user.click(screen.getByRole('link', { name: '采集授权' }))
    await waitFor(() => expect(screen.getByTestId('topbar-title')).toHaveTextContent('采集授权'))
    expect(screen.getByText('一切正常')).toBeInTheDocument()
    expect(screen.queryByText('正在检测…')).not.toBeInTheDocument()
  })
})

describe('SystemStatus · NAS 断连：横幅是前端的活，数据不是', () => {
  // 这几条借顶栏那个状态下拉来切换形态，而它默认不渲染
  // （见 src/app/GlobalBar.tsx 的 useProtoControls），所以要先把标志打开。
  beforeEach(() => sessionStorage.setItem(PROTO_STORAGE_KEY, '1'))
  afterEach(() => sessionStorage.removeItem(PROTO_STORAGE_KEY))

  /**
   * F1 时代这里有两条测试，断言"切到 nas-down 之后受影响会议的保留窗口清零、
   * 授权撤下"。那是 mock 数据层（`applyNasDown`）做的事。
   *
   * **接真 API 之后这件事不再由前端做，也不该由前端做。** NAS 断了会不会让
   * 某几场会议变成归档失败，是后端算出来的事实；前端照着一个横幅去改写会议
   * 数据，等于凭一个全局状态编造几场归档失败——那正是这一整轮在防的那类错误。
   * 所以这两条测试换成下面这一条：**横幅要出来，表格不许被前端改写。**
   *
   * spec §7.2 那个数据形态仍然要能一键复现，它搬到了原型模式的假后端里
   * （`api/mock/install.ts`，由 `tests/mock.test.ts` 盯着）。
   */
  test('切到 nas-down：横幅出来，但会议表格照旧显示服务端给的那一行', async () => {
    const user = userEvent.setup()
    renderApp('/meetings', 'ok')

    await waitFor(() => expect(screen.getByTestId('row-m1')).toBeInTheDocument())
    expect(screen.getByTestId('keep-m1')).not.toHaveTextContent('归档失败')
    expect(systemBanner()).toBeNull()

    await user.selectOptions(screen.getByRole('combobox', { name: /系统状态/ }), 'nas-down')

    await waitFor(() => expect(systemBanner()).not.toBeNull())
    // 表格没有被前端改写：服务端说这一场归档成功，它就还是归档成功
    expect(screen.getByTestId('keep-m1')).not.toHaveTextContent('归档失败')
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('1')
  })

  test('会议数据不看那个手动状态 —— 它只驱动横幅与三个数据态', async () => {
    const user = userEvent.setup()
    renderApp('/meetings', 'ok')
    await waitFor(() => expect(screen.getByTestId('row-m1')).toBeInTheDocument())
    const before = screen.getByTestId('row-m1').textContent

    await user.selectOptions(screen.getByRole('combobox', { name: /系统状态/ }), 'tencent-down')
    // tencent-down 不再出横幅（spec §7.1），等左栏摘要说出来就算状态切过去了
    await waitFor(() => expect(document.body.textContent).toContain('拉取连续失败'))
    expect(screen.getByTestId('row-m1').textContent).toBe(before)
  })


  test('nas-down：「暂停到期清理」是一个真的去得到那个动作的链接，不是假按钮', async () => {
    // F1 的那个按钮点一下只改本地 state，什么都没暂停。这个动作有真实端点
    // （`POST /admin/storage/cleanup-pause`），但它归归档存储页（F5b 独占
    // `api/admin/storage.ts`），地基不越界去写。所以横幅给的是去处，
    // 不是一个点了没反应的按钮——后者比多点一次糟得多。
    const user = userEvent.setup()
    renderApp('/meetings', 'nas-down')

    await waitFor(() => expect(systemBanner()).not.toBeNull())
    const bar = systemBanner()!
    const link = within(bar).getByRole('link', { name: '暂停到期清理' })
    expect(link).toHaveAttribute('href', '/storage')

    await user.click(link)
    expect(await screen.findByRole('heading', { name: '归档存储', level: 1 })).toBeInTheDocument()
  })
})
