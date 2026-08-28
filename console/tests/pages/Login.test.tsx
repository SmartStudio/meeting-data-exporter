import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../src/app/routes'
import { SystemStateProvider } from '../../src/app/SystemStatus'

/**
 * 挂起内存路由 + `SystemStateProvider`，镜像 `shell.test.tsx` 的 `renderApp`。
 * `SystemStateProvider` 是必须的——登录成功后会真的落到 `/meetings`，那一页
 * 的 `useMeetings()` 依赖它才能取到（哪怕是 mock）数据，缺了它渲染期会抛错。
 */
function renderApp(initialPath: string) {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  return render(
    <SystemStateProvider>
      <RouterProvider router={router} />
    </SystemStateProvider>,
  )
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * `console/src/api/admin.ts` 直接 `fetch`、不经过 `api/mock/` 那层（T6 简报
 * 里的架构分界），所以这里也直接 mock `global.fetch`，而不是走 mockApi。
 * `authenticated` 是个可变引用：登录成功之后测试要能让后续的 `/auth/me`
 * 也回报"已登录"，才能验证"跳回原本想去的页面"这条路径——那条路径会让
 * `AppShell` 重新挂载、重新探一次登录态，不是靠内存里的一个标志位直接跳过。
 */
function installFetchMock(validCredentials: { username: string; password: string }) {
  const authenticated = { value: false }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url.endsWith('/api/v1/admin/auth/me') && method === 'GET') {
      return authenticated.value
        ? jsonResponse(200, { adminId: 'admin-1', username: validCredentials.username, role: 'admin' })
        : jsonResponse(401, { error: 'missing_admin_session' })
    }

    if (url.endsWith('/api/v1/admin/auth/login') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        username?: string
        password?: string
        remember?: boolean
      }
      if (body.username === validCredentials.username && body.password === validCredentials.password) {
        authenticated.value = true
        return jsonResponse(200, { adminId: 'admin-1', username: body.username, role: 'admin' })
      }
      return jsonResponse(401, { error: 'invalid_credentials' })
    }

    throw new Error(`Login.test.tsx: 未预期的 fetch ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const CREDS = { username: 'chen.yw', password: 'right-pass' }

describe('AppShell 路由守卫：管理员登录态检查', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('挂载时身份检查还没有结果——显示骨架屏，不是空白', async () => {
    let resolveMe!: (res: Response) => void
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/admin/auth/me')) {
        return new Promise<Response>((res) => {
          resolveMe = res
        })
      }
      throw new Error(`未预期的 fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderApp('/meetings')
    expect(screen.getByTestId('admin-auth-loading')).toBeInTheDocument()

    resolveMe(jsonResponse(401, { error: 'missing_admin_session' }))
    await waitFor(() => expect(screen.queryByTestId('admin-auth-loading')).not.toBeInTheDocument())
    expect(await screen.findByLabelText('账号')).toBeInTheDocument()
  })

  test('未登录访问 /meetings，被重定向到 /login', async () => {
    installFetchMock(CREDS)
    renderApp('/meetings')

    expect(await screen.findByLabelText('账号')).toBeInTheDocument()
    expect(screen.getByLabelText('密码')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '会议记录' })).not.toBeInTheDocument()
  })

  test('身份检查遇到非 401 的网络错误——显示加载失败提示而不是空白，重试会重新发起请求', async () => {
    const user = userEvent.setup()
    let calls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/admin/auth/me')) {
        calls += 1
        // 第一次报 500（网络/服务错误，非 401），第二次（点重试后）恢复正常
        return calls === 1
          ? jsonResponse(500, { error: 'internal_error' })
          : jsonResponse(200, { adminId: 'admin-1', username: CREDS.username, role: 'admin' })
      }
      throw new Error(`未预期的 fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderApp('/meetings')

    const errorBlock = await screen.findByTestId('admin-auth-error')
    expect(errorBlock.textContent).toMatch(/失败/)

    await user.click(within(errorBlock).getByRole('button', { name: '重试' }))

    expect(await screen.findByRole('heading', { name: '会议记录' })).toBeInTheDocument()
    expect(calls).toBe(2)
  })
})

describe('登录页：提交与报错', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('提交正确凭据后，跳转到原本想去的页面', async () => {
    const user = userEvent.setup()
    installFetchMock(CREDS)

    // 从 /meetings 出发：会先被弹去 /login 且带上 state.from = '/meetings'——
    // 这正是要验证的"登录后跳回原本想去的页面"，不是从 /login 直接进的近路。
    renderApp('/meetings')
    await screen.findByLabelText('账号')

    await user.type(screen.getByLabelText('账号'), CREDS.username)
    await user.type(screen.getByLabelText('密码'), CREDS.password)
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByRole('heading', { name: '会议记录' })).toBeInTheDocument()
    expect(screen.queryByLabelText('账号')).not.toBeInTheDocument()
  })

  test('提交错误凭据后显示统一错误文案，报错行不改变表单的 DOM 结构（不跳动）', async () => {
    const user = userEvent.setup()
    installFetchMock(CREDS)

    renderApp('/login')

    const errorSlot = screen.getByRole('alert')
    expect(errorSlot).toHaveTextContent('')

    await user.type(screen.getByLabelText('账号'), CREDS.username)
    await user.type(screen.getByLabelText('密码'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(errorSlot).toHaveTextContent('账号或密码错误'))
    // 同一个节点被复用、不是错误出现时才插入的新元素——DOM 结构没有多一行或少一行。
    expect(screen.getByRole('alert')).toBe(errorSlot)
  })

  test('报错行容器有固定高度（CSS 层面防跳动，不止是"复用同一个节点"）', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/Login/Login.module.css'), 'utf-8')
    const block = /\.errorSlot\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(block).toMatch(/min-height/)
  })

  test('提交时把当前的账号/密码/"记住此设备"状态原样发给后端——包括取消勾选记住', async () => {
    const user = userEvent.setup()
    const fetchMock = installFetchMock(CREDS)

    renderApp('/login')

    // 默认是勾选的（spec.md §4.1「记住此设备 30 天」是默认态）
    expect(screen.getByRole('checkbox', { name: '记住此设备 30 天' })).toBeChecked()

    await user.type(screen.getByLabelText('账号'), CREDS.username)
    await user.type(screen.getByLabelText('密码'), CREDS.password)
    await user.click(screen.getByRole('checkbox', { name: '记住此设备 30 天' }))
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const loginCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/auth/login'))
    expect(loginCall).toBeDefined()
    const init = loginCall?.[1]
    expect(JSON.parse(String(init?.body))).toEqual({
      username: CREDS.username,
      password: CREDS.password,
      remember: false,
    })
    expect(init?.credentials).toBe('include')
  })
})

describe('登录页：这一页只有一件事要做', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('底部那行功能 chip 整条删掉了——其中「保留 30 天」是一句会撒谎的话', () => {
    // 真实保留天数在 `system_settings`（`GET /admin/storage` 的
    // `retention.defaultDays`，当前 `defaultDaysSource: "fallback"`）。管理员
    // 改成 60 天的那一刻，写死在登录页上的「30 天」开始骗人。登录页没有会话、
    // 拿不到也不该拿这个设置，所以正确做法是删掉这个数字，不是想办法去取它。
    installFetchMock(CREDS)
    renderApp('/login')

    expect(screen.queryByText(/保留\s*30\s*天/)).toBeNull()
    expect(screen.queryByText('归档 NAS')).toBeNull()
    expect(screen.queryByText('授权采集')).toBeNull()
    expect(document.querySelector('ol')).toBeNull()

    // 「记住此设备 30 天」里的 30 天是另一回事：它是这次登录真的会写进 cookie
    // 的有效期，由这次提交自己决定，不是一个别处可改的设置。
    expect(screen.getByRole('checkbox', { name: '记住此设备 30 天' })).toBeInTheDocument()
  })

  test('占位标志（蓝底方块里一个「Y」）不在首屏了，产品名自己说话', () => {
    installFetchMock(CREDS)
    renderApp('/login')

    expect(screen.queryByText('Y')).toBeNull()
    expect(screen.getByRole('heading', { name: 'YAO-DATA', level: 1 })).toBeInTheDocument()
  })

  test('辅助文字只剩一句、且是控件缺席时必须交代的那一句', () => {
    // 判据：删掉它，用户会不会做错事？
    //   「仅限公司内部管理员使用」——不会（没有注册按钮这件事自己说清楚了），删。
    //   「忘记密码请联系系统管理员」——会：这一页没有、也不会有找回密码的控件，
    //     没这句话，被锁在外面的人只能去找一个不存在的链接。留。
    //   原文尾巴上的「开通」删掉：那说的是开户，不是找回密码，两件事。
    installFetchMock(CREDS)
    renderApp('/login')

    expect(screen.queryByText(/仅限公司内部管理员使用/)).toBeNull()
    expect(screen.getByText('忘记密码请联系系统管理员')).toBeInTheDocument()
  })

  test('登录页不再自己压焦点边框——根因已经在 ui/Input 里修掉了', () => {
    // 双层焦点环的根因是 `ui/Input.module.css` 用了裸 `.input:focus` 刷品牌蓝，
    // 与 `styles/base.css` 的全局 `:focus-visible` 外圈叠成双线框。它不是登录页
    // 独有的，每个输入框都这样，所以修在共用组件里（改成
    // `:focus:not(:focus-visible)`），断言搬去 `tests/ui.test.tsx`。
    // 这里反过来钉住：登录页**不该**再留那份局部覆盖，否则根因回归了也看不出来。
    const css = readFileSync(resolve(process.cwd(), 'src/pages/Login/Login.module.css'), 'utf-8')
    expect(/\.field\s+input:focus\s*\{/.test(css)).toBe(false)
  })

  test('品牌字距是唯一的装饰动作，标题上没有多加别的花样', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/Login/Login.module.css'), 'utf-8')
    const block = /\.title\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(block).toMatch(/letter-spacing/)
    // 不使用 uppercase/text-transform——那是拉丁排版手法，这一页刻意只动字距
    expect(block).not.toMatch(/text-transform/)
  })

  test('卡片靠居中和留白立住，不再靠边框/阴影画一条边', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/Login/Login.module.css'), 'utf-8')
    const block = /\.card\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(block).not.toMatch(/\bborder:/)
    expect(block).not.toMatch(/box-shadow/)
  })

  test('报错行排在「登录」之后：常驻占位落到卡片底部，表单内部间距回到一致', async () => {
    // 它原来夹在勾选框和按钮中间，空着也占一行，两侧各再吃一份 16px 的 gap——
    // 勾选框到按钮之间空出 55px，是字段间距的三倍多。它不能改成"有错才渲染"
    // （spec §4.1 要求不跳动），所以挪到最后一个控件之后，让那段常驻空白和
    // 卡片内边距连成一片。
    const user = userEvent.setup()
    installFetchMock(CREDS)
    renderApp('/login')

    const submit = screen.getByRole('button', { name: '登录' })
    const slot = screen.getByRole('alert')
    // querySelectorAll 按文档顺序返回，所以这就是"谁在前谁在后"
    const inOrder = [...document.querySelectorAll('form button[type="submit"], form [role="alert"]')]
    expect(inOrder).toEqual([submit, slot])

    // 挪了位置，但仍然是同一个常驻节点——出错前后 DOM 不多一行也不少一行
    await user.type(screen.getByLabelText('账号'), CREDS.username)
    await user.type(screen.getByLabelText('密码'), 'wrong-password')
    await user.click(submit)
    await waitFor(() => expect(slot).toHaveTextContent('账号或密码错误'))
    expect(screen.getByRole('alert')).toBe(slot)
  })
})
