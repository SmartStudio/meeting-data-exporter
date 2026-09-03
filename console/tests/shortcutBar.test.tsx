import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../src/app/routes'
import { shortcutsFor } from '../src/app/ShortcutBar'
import { SystemStateProvider } from '../src/app/SystemStatus'
import { resolveMeetingKey } from '../src/lib/keys'

/**
 * 底部快捷键条。
 *
 * 它原来是九条**硬编码**提示、挂在每一个页面上，而全应用只有会议记录页接了
 * 键盘（`lib/keys.ts` 只有 `pages/Meetings/index.tsx` 一个消费者）。于是在归档
 * 存储页上它一边写着「空格 选中」「/ 搜索」，一边这一页既没有可选中的行也没有
 * 搜索框。这个文件钉住两件事：
 *
 *   1. 印在屏幕上的每一个键，`resolveMeetingKey` 都真的认得（提示表和键位表
 *      不许各走各的）；
 *   2. 没有键位的路由整条不渲染——不是渲染一条空栏占着 28px。
 */

/** 六条主路由的最小合法响应。这个文件不测各页内容，只测外壳底部那条。 */
function installFetch() {
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
      if (url.endsWith('/api/v1/admin/storage')) {
        return json({
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
        })
      }
      if (url.endsWith('/api/v1/admin/jobs')) {
        return json({ now: 1700000000, timezoneOffsetSec: 28800, jobs: [], failuresTotal: 0, fetchLookbackHours: 24, failures: [] })
      }
      if (url.includes('/api/v1/admin/meetings/triage')) {
        return json({ archiveFailed: 0, expiringIn7d: 0, awaitingGrant: 0, inProgress: 0, nasOnly: 0 })
      }
      if (url.includes('/api/v1/admin/meetings')) {
        return json({ rows: [], total: 0, limit: 10, offset: 0 })
      }
      if (url.includes('/api/v1/admin/programs')) return json([])
      if (url.includes('/api/v1/admin/rules')) return json([])
      if (url.includes('/api/v1/admin/audit')) {
        return json({
          rows: [],
          total: 0,
          limit: 50,
          offset: 0,
          window: { from: 1699395200, to: null, isDefault: false, days: 7, text: null },
        })
      }
      throw new Error(`shortcutBar.test.tsx: 未预期的 fetch ${url}`)
    }),
  )
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  return render(
    <SystemStateProvider initialState="ok">
      <RouterProvider router={router} />
    </SystemStateProvider>,
  )
}

/** 那条栏没有 role，也刻意 aria-hidden。用它自己的形状找：装着 <kbd> 的提示条。 */
function bar(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')].find((d) =>
    d.querySelector('kbd'),
  ) ?? null
}

describe('ShortcutBar · 路由表本身（纯函数，不用搭 DOM）', () => {
  test('只有会议记录页有键位——它是 lib/keys.ts 唯一的消费者', () => {
    expect(shortcutsFor('/meetings').length).toBeGreaterThan(0)
  })

  test('其余七条路由一条键位都没有，返回空数组', () => {
    // 空数组而不是"一条通用提示"：调用方据此整条不渲染。返回一条内容为空的
    // 提示，就会退化成一条空栏占着 28px——那正是要修的东西。
    for (const path of ['/', '/consumers', '/rules', '/jobs', '/storage', '/audit', '/preview/m1', '/login']) {
      expect(shortcutsFor(path)).toEqual([])
    }
  })

  test('末尾斜杠不影响判断', () => {
    expect(shortcutsFor('/meetings/')).toEqual(shortcutsFor('/meetings'))
  })

  test('印在屏幕上的每一个键，resolveMeetingKey 都真的认得', () => {
    // 这条是这个文件存在的理由：原来那份列表是硬编码的，键位表改了它不会跟着
    // 改，也没有任何东西会因此变红。现在提示表带着真实的 KeyboardEvent.key，
    // 逐个去问键位表——认不出来的键从此进不了屏幕。
    for (const hint of shortcutsFor('/meetings')) {
      for (const k of hint.keys) {
        expect(resolveMeetingKey({ key: k.key, target: null }), `键「${k.shown}」没有人接`).not.toBeNull()
      }
    }
  })

  test('⌘K 与 Esc 不在表里——前者全应用没人监听，后者只在浮层开着时成立', () => {
    const shown = shortcutsFor('/meetings').flatMap((h) => h.keys.map((k) => k.shown))
    expect(shown).not.toContain('⌘K')
    expect(shown).not.toContain('Esc')
    // ⌘K 为什么必然是死的：带修饰键的按键，键位表一律不接管。
    expect(resolveMeetingKey({ key: 'k', metaKey: true, target: null })).toBeNull()
  })
})

describe('ShortcutBar · 挂在外壳里', () => {
  beforeEach(installFetch)
  afterEach(() => vi.unstubAllGlobals())

  test('会议记录页：提示条在，键位是这一页真的响应的那批', async () => {
    renderAt('/meetings')
    await screen.findByRole('heading', { name: '会议记录', level: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    const text = bar()!.textContent ?? ''
    expect(text).toContain('选中')
    expect(text).toContain('上下移动')
    expect(text).toContain('延长保留')
  })

  test('归档存储页：整条不渲染——这一页没有列表、没有可选中的东西、没有搜索框', async () => {
    renderAt('/storage')
    await screen.findByRole('heading', { name: '归档存储', level: 1 })
    expect(bar()).toBeNull()
    // 逐条点名那些原来在这一页上撒谎的提示
    expect(document.body.textContent).not.toContain('空格')
    expect(document.body.textContent).not.toContain('打开详情')
    expect(document.body.textContent).not.toContain('延长保留')
    expect(document.body.textContent).not.toContain('预览内容')
    expect(document.body.textContent).not.toContain('全局搜索')
  })

  test('采集授权页同样不渲染', async () => {
    renderAt('/consumers')
    await screen.findByRole('heading', { name: '采集授权', level: 1 })
    expect(bar()).toBeNull()
  })

  test('底部留白跟着那条栏走：不渲染的页面不为它空出一屏底部', async () => {
    // 那条栏是 position: fixed。留白给多了，五个页面各自空出 72px；给少了，
    // 归档存储页首屏那四颗按钮（其中两颗是破坏性操作）被盖住下半截。
    // 两处必须同一个判据，所以这里连着显隐一起断言。
    const withBar = renderAt('/meetings')
    await screen.findByRole('heading', { name: '会议记录', level: 1 })
    expect(screen.getByRole('main').className).toMatch(/viewWithBar/)
    withBar.unmount()

    renderAt('/storage')
    await screen.findByRole('heading', { name: '归档存储', level: 1 })
    expect(screen.getByRole('main').className).not.toMatch(/viewWithBar/)
  })
})
