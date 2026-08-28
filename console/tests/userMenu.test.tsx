import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import UserMenu from '../src/app/UserMenu'
import { renderAsRole } from './helpers/session'

/**
 * 用户菜单 + 修改密码（spec §11 缺口 1 的那一行 · 缺口 5 的那个入口）。
 *
 * 盯的是三句话：
 * 1. 角色那一行**随角色变**——只读账号看到「可改规则与授权」就是在骗人；
 * 2. 改密码**要填当前密码**，且界面上说得出为什么；
 * 3. 改完之后**其它会话被吊销、当前这条保留**这件事要说出来，包括 0 的情况。
 */

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[] = []
let next: { status: number; body: unknown } = { status: 200, body: { revokedOtherSessions: 0 } }

beforeEach(() => {
  calls = []
  next = { status: 200, body: { revokedOtherSessions: 0 } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mount(role: 'admin' | 'readonly') {
  const router = createMemoryRouter(
    [
      { path: '/meetings', element: <UserMenu /> },
      { path: '/login', element: <div>登录页</div> },
    ],
    { initialEntries: ['/meetings'] },
  )
  return renderAsRole(<RouterProvider router={router} />, role)
}

async function openMenu(role: 'admin' | 'readonly' = 'admin'): Promise<void> {
  mount(role)
  await userEvent.click(screen.getByRole('button', { name: /测试/ }))
}

describe('账号与角色', () => {
  test('显示的是登录账号，不是写死的名字', async () => {
    mount('admin')
    expect(screen.getByRole('button', { name: /测试管理员/ })).toBeInTheDocument()
  })

  test('管理员那一行是 spec §2 的原话', async () => {
    await openMenu('admin')
    const line = await screen.findByTestId('user-role-line')
    expect(line).toHaveTextContent('数据管理员 · 可改规则与授权')
  })

  test('只读账号那一行**不能**再说「可改规则与授权」', async () => {
    await openMenu('readonly')
    const line = await screen.findByTestId('user-role-line')
    expect(line).toHaveAttribute('data-role', 'readonly')
    expect(line).toHaveTextContent('只读')
    expect(line).not.toHaveTextContent('可改规则与授权')
  })

  test('退出登录发 POST /auth/logout 并回登录页', async () => {
    await openMenu('admin')
    await userEvent.click(await screen.findByRole('button', { name: '退出登录' }))
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/auth/logout'))).toBe(true)
    })
    expect(await screen.findByText('登录页')).toBeInTheDocument()
  })
})

describe('修改密码', () => {
  async function openForm(role: 'admin' | 'readonly' = 'admin'): Promise<HTMLElement> {
    await openMenu(role)
    await userEvent.click(await screen.findByRole('button', { name: '修改密码' }))
    return screen.getByRole('dialog', { name: '修改密码' })
  }

  async function fill(cur: string, a: string, b = a): Promise<void> {
    await userEvent.type(screen.getByLabelText('当前密码'), cur)
    await userEvent.type(screen.getByLabelText('新密码'), a)
    await userEvent.type(screen.getByLabelText('再输一遍新密码'), b)
  }

  test('三栏都在，且当前密码那一栏说得出为什么必须填', async () => {
    const panel = await openForm()
    expect(within(panel).getByLabelText('当前密码')).toBeInTheDocument()
    expect(within(panel).getByLabelText('新密码')).toBeInTheDocument()
    expect(within(panel).getByLabelText('再输一遍新密码')).toBeInTheDocument()
    expect(panel).toHaveTextContent('XSS')
  })

  test('打开时就说清「其它设备会被吊销、当前这条保留」', async () => {
    const panel = await openForm()
    expect(panel).toHaveTextContent('其它设备上的会话会被吊销')
    expect(panel).toHaveTextContent('当前这一条保留')
  })

  test('提交发的是 POST /auth/password，请求体只有两个字段', async () => {
    await openForm()
    await fill('old-pass', 'new-pass-1234')
    await userEvent.click(screen.getByRole('button', { name: '改密码' }))

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/auth/password'))
      expect(post).toBeDefined()
      expect(post!.body).toEqual({ currentPassword: 'old-pass', newPassword: 'new-pass-1234' })
    })
  })

  test('成功之后把"另外 N 个会话被踢下线"说出来', async () => {
    next = { status: 200, body: { revokedOtherSessions: 3 } }
    await openForm()
    await fill('old-pass', 'new-pass-1234')
    await userEvent.click(screen.getByRole('button', { name: '改密码' }))

    const done = await screen.findByTestId('password-done')
    expect(done).toHaveTextContent('另外 3 个会话已经被踢下线')
    expect(done).toHaveTextContent('当前这条会话保留')
  })

  test('0 也要说出来，不是留白——"没有别的设备在登录"是一个结论', async () => {
    next = { status: 200, body: { revokedOtherSessions: 0 } }
    await openForm()
    await fill('old-pass', 'new-pass-1234')
    await userEvent.click(screen.getByRole('button', { name: '改密码' }))

    expect(await screen.findByTestId('password-done')).toHaveTextContent('没有还在登录的会话')
  })

  test('当前密码不对时说的是"当前密码不对"，不会被当成会话过期', async () => {
    next = { status: 401, body: { error: 'invalid_current_password' } }
    await openForm()
    await fill('wrong', 'new-pass-1234')
    await userEvent.click(screen.getByRole('button', { name: '改密码' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('当前密码不对')
    expect(screen.queryByTestId('password-done')).toBeNull()
  })

  test('太短时把后端下发的门槛说出来，不抄一个前端自己的数', async () => {
    next = { status: 400, body: { error: 'password_too_short', minLength: 12 } }
    await openForm()
    await fill('old-pass', 'short')
    await userEvent.click(screen.getByRole('button', { name: '改密码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('至少 12 位')
  })

  test('两次输入不一致时在前端就拦下来，不发请求', async () => {
    await openForm()
    await fill('old-pass', 'new-pass-1234', 'new-pass-9999')
    await userEvent.click(screen.getByRole('button', { name: '改密码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的新密码不一样')
    expect(calls.some((c) => c.url.endsWith('/auth/password'))).toBe(false)
  })

  test('只读账号照样能改自己的密码（A8 白名单三条之一）', async () => {
    const panel = await openForm('readonly')
    expect(within(panel).getByLabelText('当前密码')).toBeEnabled()
    await fill('old-pass', 'new-pass-1234')
    expect(screen.getByRole('button', { name: '改密码' })).toBeEnabled()
  })
})

/**
 * 主题三选，从顶栏（`GlobalBar.tsx`）搬进了这个菜单——顶栏最贵的右上角以前
 * 摆着一个一年点一次的设置，现在跟"你是谁""改密码""退出登录"放在一起。
 *
 * 这几条覆盖的是 `tests/theme.test.tsx` 没管的那一半：那个文件只测
 * `useTheme` 这个 hook 本身（读写 localStorage、写 `data-theme` 属性），
 * 从来没有一条测试真的点过界面上的「浅色/深色/跟随系统」按钮——搬家之前
 * 顶栏那三颗按钮也没人这样测过。所以这不是「弱化」，是把入口搬过来的同时
 * 顺带补上一直没有的 UI 级覆盖：真的点按钮，真的看 `<html data-theme>`
 * 变没变。
 */
describe('主题三选（从顶栏搬进头像菜单）', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })

  test('菜单里有一组「主题切换」，默认选中跟随系统', async () => {
    await openMenu()
    const group = screen.getByRole('group', { name: '主题切换' })
    const system = within(group).getByRole('button', { name: '跟随系统' })
    expect(system).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(group).getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('点「深色」写 data-theme="dark"；点「跟随系统」清掉属性', async () => {
    await openMenu()
    const group = screen.getByRole('group', { name: '主题切换' })

    await userEvent.click(within(group).getByRole('button', { name: '深色' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(within(group).getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(within(group).getByRole('button', { name: '跟随系统' }))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  test('选择被记住：重新挂载菜单后仍是上次选的那个', async () => {
    // 不用 openMenu() 这个 helper：它内部 mount() 但不回传 RenderResult，
    // 这条测试要真的卸载再重新挂载（模拟换页再回来），所以直接调用同文件里
    // 的 mount()，自己管生命周期。
    const first = mount('admin')
    await userEvent.click(screen.getByRole('button', { name: /测试/ }))
    await userEvent.click(
      within(screen.getByRole('group', { name: '主题切换' })).getByRole('button', { name: '浅色' }),
    )
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    first.unmount()

    mount('admin')
    await userEvent.click(screen.getByRole('button', { name: /测试/ }))
    const group = screen.getByRole('group', { name: '主题切换' })
    expect(within(group).getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'true')
  })
})
