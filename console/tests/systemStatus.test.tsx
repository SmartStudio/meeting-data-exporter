import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../src/app/routes'
import { PROTO_STORAGE_KEY } from '../src/app/proto'
import { SystemStateProvider } from '../src/app/SystemStatus'

/**
 * 系统状态条接真实来源（计划 G-d）。
 *
 * F1 时它由顶栏那个手动下拉驱动，所有五种形态都是演出来的。现在：
 *   - `nas-down`      ← `GET /api/v1/admin/storage` 的 `nas.reachable`
 *   - `tencent-down`  ← **推断**：`GET /api/v1/admin/jobs` 里 `fetch_recordings`
 *                        的 `recentRuns` 连续失败
 *   - 读不到           ← 显示"读取失败"，**不许假装正常**
 * 手动下拉退回 `?proto=1`，那时一条真实请求都不发。
 */

function jsonOf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function run(status: string): Record<string, unknown> {
  return {
    id: 1,
    status,
    trigger: 'scheduler',
    requestedBy: null,
    startedAt: 1699999800,
    finishedAt: 1699999900,
    durationSec: 100,
    summary: null,
    error: null,
  }
}

function storagePayload(over: Record<string, unknown> = {}): unknown {
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
      ...over,
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

function jobsPayload(fetchRuns: string[] | null, failuresTotal = 0): unknown {
  const jobs: Array<Record<string, unknown>> = []
  if (fetchRuns !== null) {
    jobs.push({
      name: 'fetch_recordings',
      label: '拉取新录制',
      what: '从腾讯会议拉新录制',
      schedule: '每 10 分钟',
      nextDueAt: 1700000600,
      impact: '拉不到就没有原始文件',
      maxAttempts: 5,
      openFailures: 0,
      health: 'ok',
      lastRun: fetchRuns.length === 0 ? null : run(fetchRuns[0]!),
      recentRuns: fetchRuns.map(run),
    })
  }
  return { now: 1700000000, timezoneOffsetSec: 28800, jobs, failuresTotal, failures: [] }
}

interface Backend {
  storage?: () => Response
  jobs?: () => Response
}

let seen: string[] = []

function install(backend: Backend): void {
  seen = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith('/api/v1/admin/auth/me')) {
        return jsonOf({ adminId: 'admin-1', username: 'chen.yw', role: 'admin' })
      }
      if (url.endsWith('/api/v1/admin/storage')) {
        return (backend.storage ?? (() => jsonOf(storagePayload())))()
      }
      if (url.endsWith('/api/v1/admin/jobs')) {
        return (backend.jobs ?? (() => jsonOf(jobsPayload(['succeeded']))))()
      }
      throw new Error(`systemStatus.test.tsx: 未预期的 fetch ${url}`)
    }),
  )
}

function renderApp(initialPath = '/meetings') {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  return render(
    <SystemStateProvider>
      <RouterProvider router={router} />
    </SystemStateProvider>,
  )
}

function banner(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="status"][data-sev]')
}

/** 等外壳挂完（左栏出现即说明登录态检查过了）。 */
async function shellReady(): Promise<void> {
  await screen.findByRole('navigation', { name: '主导航' })
}

beforeEach(() => sessionStorage.removeItem(PROTO_STORAGE_KEY))
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.removeItem(PROTO_STORAGE_KEY)
})

describe('默认路径：状态来自两条真实端点', () => {
  test('挂载后真的去读 storage 与 jobs（不是读 mock）', async () => {
    install({})
    renderApp()
    await shellReady()
    await waitFor(() => {
      expect(seen.some((u) => u.endsWith('/api/v1/admin/storage'))).toBe(true)
      expect(seen.some((u) => u.endsWith('/api/v1/admin/jobs'))).toBe(true)
    })
  })

  test('一切正常时没有告警条', async () => {
    install({})
    renderApp()
    await shellReady()
    await waitFor(() => expect(seen.some((u) => u.endsWith('/api/v1/admin/jobs'))).toBe(true))
    expect(banner()).toBeNull()
  })

  test('后端不可达：显示"系统状态读取失败"，不假装正常；重试能恢复', async () => {
    let attempt = 0
    install({
      storage: () => {
        attempt += 1
        if (attempt === 1) throw new TypeError('Failed to fetch')
        return jsonOf(storagePayload())
      },
    })
    const user = userEvent.setup()
    renderApp()
    await shellReady()

    await waitFor(() => expect(banner()).not.toBeNull())
    const bar = banner()!
    expect(bar).toHaveAttribute('data-alert', 'unreadable')
    expect(bar.textContent).toContain('系统状态读取失败')
    // 端点名要出现在界面上——否则错误态里看不出是哪一条读不到
    expect(bar.textContent).toContain('/api/v1/admin/storage')

    // 左栏摘要同样不许说"一切正常"
    expect(screen.getByText('系统状态读不到')).toBeInTheDocument()
    expect(screen.queryByText('一切正常')).not.toBeInTheDocument()

    await user.click(within(bar).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(banner()).toBeNull())
  })

  test('响应形状不对（少一个字段）也是"读不到"，不是空白', async () => {
    const broken = storagePayload() as { nas: Record<string, unknown> }
    delete broken.nas.reachable
    install({ storage: () => jsonOf(broken) })
    renderApp()
    await shellReady()

    await waitFor(() => expect(banner()).not.toBeNull())
    expect(banner()!.textContent).toContain('nas.reachable')
  })
})

describe('nas-down：来自 storage 的 nas.reachable', () => {
  test('reachable=false（仍是 200）→ 红色告警条 + 真实的待归档场次数', async () => {
    install({
      storage: () =>
        jsonOf(storagePayload({ reachable: false, error: 'ENOENT: /mnt/nas', pendingMeetings: 5 })),
    })
    renderApp()
    await shellReady()

    await waitFor(() => expect(banner()).not.toBeNull())
    const bar = banner()!
    expect(bar).toHaveAttribute('data-sev', 'fail')
    expect(bar).toHaveAttribute('data-alert', 'nas-down')
    expect(bar.textContent).toContain('5')
    // 后端给了原因就把原因显示出来，不用一句通用的建议顶替
    expect(bar.textContent).toContain('ENOENT: /mnt/nas')
    expect(within(bar).getByRole('link', { name: '暂停到期清理' })).toHaveAttribute(
      'href',
      '/storage',
    )
  })
})

describe('tencent-down：从拉取任务的最近运行推断（不是直报）', () => {
  test('连续 3 轮失败 → 告警条，措辞是观察到的事实', async () => {
    install({ jobs: () => jsonOf(jobsPayload(['failed', 'failed', 'failed', 'succeeded'])) })
    renderApp()
    await shellReady()

    await waitFor(() => expect(banner()).not.toBeNull())
    const bar = banner()!
    expect(bar).toHaveAttribute('data-sev', 'warn')
    expect(bar).toHaveAttribute('data-alert', 'fetch-stalled')
    expect(bar.textContent).toContain('最近 3 轮拉取连续失败')
    // **这是推断，不是探测**：界面上不许出现一句肯定的结论
    expect(bar.textContent).not.toContain('腾讯会议接口不可达')
    expect(bar.textContent).toContain('推出来的判断')
  })

  test('只失败 2 轮（没到阈值）→ 不报，一次抖动不是一次故障', async () => {
    install({ jobs: () => jsonOf(jobsPayload(['failed', 'failed', 'succeeded'])) })
    renderApp()
    await shellReady()
    await waitFor(() => expect(seen.some((u) => u.endsWith('/api/v1/admin/jobs'))).toBe(true))
    expect(banner()).toBeNull()
  })

  test('任务清单里没有「拉取新录制」→ 说未知，不默认成正常', async () => {
    install({ jobs: () => jsonOf(jobsPayload(null)) })
    renderApp()
    await shellReady()

    await waitFor(() => expect(banner()).not.toBeNull())
    expect(banner()).toHaveAttribute('data-alert', 'fetch-unknown')
    expect(screen.queryByText('一切正常')).not.toBeInTheDocument()
  })
})

describe('?proto=1：手动下拉是演示工具，那时一条真实请求都不发', () => {
  beforeEach(() => sessionStorage.setItem(PROTO_STORAGE_KEY, '1'))

  test('原型模式下不去读 storage / jobs', async () => {
    install({
      storage: () => {
        throw new Error('原型模式不该发这条请求')
      },
      jobs: () => {
        throw new Error('原型模式不该发这条请求')
      },
    })
    renderApp()
    await shellReady()
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toBeInTheDocument())

    expect(seen.filter((u) => u.endsWith('/api/v1/admin/storage'))).toHaveLength(0)
    expect(seen.filter((u) => u.endsWith('/api/v1/admin/jobs'))).toHaveLength(0)
    // 原型模式在界面上有可见标记，不会被误当成真实数据
    expect(screen.getByText('原型 · 全部数字为示例')).toBeInTheDocument()
  })
})
