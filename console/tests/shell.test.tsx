import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../src/app/routes'
import { SystemStateProvider, useMeetings, useSystemState } from '../src/app/SystemStatus'

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
    await waitFor(() => expect(screen.getByTestId('stat-failed')).toBeInTheDocument())

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

    expect(screen.getByRole('heading', { name: '会议记录' })).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: '采集授权' }))

    expect(await screen.findByRole('heading', { name: '采集授权' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '会议记录' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '采集授权' })).toHaveAttribute('aria-current', 'page')
  })

  test('六个非会议记录的路由都渲染占位页，写明各自的实现阶段，不留空白', async () => {
    const cases: Array<[string, string, string]> = [
      ['/consumers', '采集授权', 'F4'],
      ['/rules', '自动规则', 'F3'],
      ['/jobs', '定时任务', 'F5'],
      ['/storage', '归档存储', 'F5'],
      ['/audit', '操作审计', 'F5'],
      ['/preview/m1', '内容预览', 'F6'],
    ]
    for (const [path, title, phase] of cases) {
      const { unmount } = renderApp(path)
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
      expect(screen.getByText(new RegExp(phase))).toBeInTheDocument()
      unmount()
    }
  })
})

describe('AppShell · 顶栏', () => {
  test('保留「原型 · 全部数字为示例」标记', async () => {
    renderApp('/meetings')
    expect(screen.getByText('原型 · 全部数字为示例')).toBeInTheDocument()
    // 同上：等首轮请求落地再结束，不留悬空的状态更新告警。
    await waitFor(() => expect(screen.getByTestId('stat-failed')).toBeInTheDocument())
  })

  test('系统状态下拉能切到六种形态', async () => {
    const user = userEvent.setup()
    renderApp('/meetings')

    const picker = screen.getByRole('combobox', { name: /系统状态/ })

    // ok：无告警条，分诊数字来自真实 mock 数据（1 场归档失败，即 m3）
    await waitFor(() => expect(screen.getByTestId('stat-failed')).toHaveTextContent('1'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    // selectOptions 按 <option> 的 value 或可见文本匹配；用 value（英文短名）
    // 而不是中文标签，免得标签文案一改这条测试就跟着碎。

    // loading：内容区给出加载中提示，不是空白
    await user.selectOptions(picker, 'loading')
    expect(await screen.findByTestId('meetings-status')).toHaveTextContent('正在读取')

    // load-failed：错误详情 + 重试，不是「暂无数据」
    await user.selectOptions(picker, 'load-failed')
    const status = await screen.findByTestId('meetings-status')
    expect(status.textContent).toMatch(/失败|错误|不可用|503/)
    expect(within(status).getByRole('button', { name: '重试' })).toBeInTheDocument()

    // empty：一场会议都没有，出口文案存在
    await user.selectOptions(picker, 'empty')
    expect(await screen.findByTestId('meetings-status')).toHaveTextContent('还没有拉取过任何会议')

    // nas-down：告警条 sev=fail，且有「暂停到期清理」
    await user.selectOptions(picker, 'nas-down')
    const nasBar = await screen.findByRole('status')
    expect(nasBar).toHaveAttribute('data-sev', 'fail')
    expect(within(nasBar).getByRole('button', { name: '暂停到期清理' })).toBeInTheDocument()

    // tencent-down：告警条 sev=warn，没有暂停按钮（那是 NAS 专属的动作）
    await user.selectOptions(picker, 'tencent-down')
    const tencentBar = await screen.findByRole('status')
    expect(tencentBar).toHaveAttribute('data-sev', 'warn')
    expect(within(tencentBar).queryByRole('button', { name: '暂停到期清理' })).not.toBeInTheDocument()

    // 切回正常，告警条消失
    await user.selectOptions(picker, 'ok')
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
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

describe('SystemStatus · nas-down 必须体现在数据里', () => {
  test('nas-down：受影响会议的保留窗口清零、授权撤下——不是只挂一条横幅', async () => {
    const user = userEvent.setup()
    renderApp('/meetings', 'ok')

    // 基线：只有 1 场归档失败（m3），保留窗口本来就是 null（未归档成功）
    await waitFor(() => expect(screen.getByTestId('stat-failed')).toHaveTextContent('1'))
    expect(screen.getByTestId('stat-keep-cleared')).toHaveTextContent('1')
    expect(screen.getByTestId('stat-grants-cleared')).toHaveTextContent('1')

    await user.selectOptions(screen.getByRole('combobox', { name: /系统状态/ }), 'nas-down')

    // spec.md §7.2：归档失败从 1 变 5，全部保留窗口清零、授权撤下——
    // 只断言横幅出现等于没测到这个状态真正的含义，这里直接读数据层的数字。
    await waitFor(() => expect(screen.getByTestId('stat-failed')).toHaveTextContent('5'))
    expect(screen.getByTestId('stat-keep-cleared')).toHaveTextContent('5')
    expect(screen.getByTestId('stat-grants-cleared')).toHaveTextContent('5')
  })

  test('nas-down：具体某场会议（m1）的字段真的变了，不是巧合的计数吻合', async () => {
    // 绕开 UI 文案，直接用外壳导出的 Context/hook 断言字段本身——
    // 这是「T6 会用同一个 hook 拿数据」的那个接口点。
    function Probe() {
      const { setState } = useSystemState()
      const meetings = useMeetings()
      const m1 = meetings.state === 'ready' ? meetings.data.find((m) => m.id === 'm1') : undefined
      return (
        <div>
          <button type="button" onClick={() => setState('nas-down')}>
            切到 NAS 断连
          </button>
          <div data-testid="m1-archive">{m1?.archive}</div>
          <div data-testid="m1-archived-at">{String(m1?.keep.archivedAt)}</div>
          <div data-testid="m1-grants">{m1?.grants.length}</div>
        </div>
      )
    }

    render(
      <SystemStateProvider initialState="ok">
        <Probe />
      </SystemStateProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('m1-archive')).toHaveTextContent('done'))
    expect(screen.getByTestId('m1-archived-at')).not.toHaveTextContent('null')
    expect(screen.getByTestId('m1-grants')).toHaveTextContent('2')

    await act(async () => {
      screen.getByRole('button', { name: '切到 NAS 断连' }).click()
    })

    await waitFor(() => expect(screen.getByTestId('m1-archive')).toHaveTextContent('failed'))
    expect(screen.getByTestId('m1-archived-at')).toHaveTextContent('null')
    expect(screen.getByTestId('m1-grants')).toHaveTextContent('0')
  })

  test('nas-down：确认「暂停到期清理」前不生效，确认后横幅文案更新', async () => {
    const user = userEvent.setup()
    renderApp('/meetings', 'nas-down')

    const bar = await screen.findByRole('status')
    const pauseBtn = within(bar).getByRole('button', { name: '暂停到期清理' })
    await user.click(pauseBtn)

    // F1 只画确认弹层，不接后端：点一下不直接生效，要走确认
    expect(within(bar).getByRole('alertdialog', { name: '确认暂停到期清理' })).toBeInTheDocument()
    expect(within(bar).queryByText('已暂停到期清理')).not.toBeInTheDocument()

    await user.click(within(bar).getByRole('button', { name: '确认暂停' }))

    expect(within(bar).getByText('已暂停到期清理')).toBeInTheDocument()
    expect(within(bar).queryByRole('button', { name: '暂停到期清理' })).not.toBeInTheDocument()
  })
})
