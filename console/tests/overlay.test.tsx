import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, test, expect } from 'vitest'
import { Overlay } from '../src/ui/Overlay'
import { Drawer } from '../src/ui/Drawer'
import { Sheet } from '../src/ui/Sheet'
import { Popover } from '../src/ui/Popover'
import { Toast } from '../src/ui/Toast'

/**
 * jsdom 不实现 `inert` 的行为语义（不阻断 `.focus()`，也不计算无障碍树），
 * `@testing-library/user-event` 的 `tab()` 同样不认它——这两点都用探针脚本
 * 实测过（见 task-4-report.md）：给一个 `inert` 祖先包着的按钮手动
 * `.focus()` 照样成功，`userEvent.tab()` 也照样会移进去。
 *
 * 所以这份测试**不能**指望「渲染一个关闭的浮层，调 userEvent.tab()，断言
 * 焦点没移进去」——那种写法在这套工具链里哪怕 Overlay 完全没接 inert 也会
 * 通过，是一张废纸。真正能验证到、也是浏览器据以把元素同时摘出 Tab 序列
 * 和无障碍树的唯一依据，是 `inert` 属性本身是否真的挂在了正确的祖先上。
 * isReachableByTab 把这条规则显式写出来（走祖先链找 inert/hidden/aria-hidden/
 * disabled/tabindex=-1），断言的是「够不够格被 Tab 到」这件事本身，不只是
 * 「有没有一个属性」。
 */
function isReachableByTab(el: HTMLElement): boolean {
  let node: HTMLElement | null = el
  while (node) {
    if (node.hasAttribute('inert')) return false
    if (node.hasAttribute('hidden')) return false
    if (node.getAttribute('aria-hidden') === 'true') return false
    if (node.style.display === 'none') return false
    node = node.parentElement
  }
  if (el.hasAttribute('disabled')) return false
  const tabIndexAttr = el.getAttribute('tabindex')
  if (tabIndexAttr !== null && Number(tabIndexAttr) < 0) return false
  return true
}

describe('Overlay 基座', () => {
  test('关闭时内部元素既退出 Tab 序列，也退出无障碍树', () => {
    render(
      <Overlay open={false} onClose={() => {}} label="面板">
        <button>藏起来的</button>
        <input aria-label="也藏起来的" />
      </Overlay>,
    )
    const btn = screen.getByText('藏起来的')
    const input = screen.getByLabelText('也藏起来的')

    // inert 必须挂在包裹这些控件的最近容器上——这是浏览器真正据以把它们
    // 同时移出 Tab 序列与无障碍树的属性。
    expect(btn.closest('[inert]')).not.toBeNull()
    expect(input.closest('[inert]')).not.toBeNull()
    expect(isReachableByTab(btn)).toBe(false)
    expect(isReachableByTab(input)).toBe(false)
  })

  test('打开时内部元素在 Tab 序列里、也在无障碍树里', () => {
    render(
      <Overlay open onClose={() => {}} label="面板">
        <button>可见的</button>
      </Overlay>,
    )
    const btn = screen.getByText('可见的')
    expect(btn.closest('[inert]')).toBeNull()
    expect(isReachableByTab(btn)).toBe(true)
  })

  test('退场动画期间仍然是 inert——不能等动画放完才切', () => {
    // Overlay 不做 setTimeout 驱动的「等动画播完再切」——inert 与 open 同一次
    // 渲染同步落地，退场视觉效果完全交给 CSS transition 自己播。这里不 await
    // 任何东西、不推进任何计时器，如果这个断言需要等待才能通过，恰恰说明
    // inert 被做成了「动画结束后才切」，这正是 design-system.md §5.1 明确
    // 禁止的写法。
    function Wrapper() {
      const [open, setOpen] = useState(true)
      return (
        <div>
          <button onClick={() => setOpen(false)}>关闭</button>
          <Overlay open={open} onClose={() => setOpen(false)} label="面板">
            <button>面板按钮</button>
          </Overlay>
        </div>
      )
    }
    render(<Wrapper />)
    const panelBtn = screen.getByText('面板按钮')
    expect(panelBtn.closest('[inert]')).toBeNull()
    expect(panelBtn.closest('[data-state="open"]')).not.toBeNull()

    fireEvent.click(screen.getByText('关闭'))

    // 同一个事件循环内，不等待、不推进计时器：
    expect(panelBtn.closest('[inert]')).not.toBeNull()
    // 面板仍然挂载在 DOM 里（没有被条件渲染直接摘掉），CSS 退场动画才有机会播完。
    expect(panelBtn.closest('[data-state="closed"]')).not.toBeNull()
  })

  test('打开时焦点移进浮层，关闭后焦点还给触发元素', () => {
    function Wrapper() {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button onClick={() => setOpen(true)}>打开</button>
          <Overlay open={open} onClose={() => setOpen(false)} label="面板">
            <button>第一个</button>
            <button>第二个</button>
          </Overlay>
        </div>
      )
    }
    render(<Wrapper />)
    const trigger = screen.getByText('打开')
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByText('第一个'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  test('Esc 关闭', () => {
    function Wrapper() {
      const [open, setOpen] = useState(true)
      return (
        <Overlay open={open} onClose={() => setOpen(false)} label="面板">
          <button>面板按钮</button>
        </Overlay>
      )
    }
    render(<Wrapper />)
    expect(screen.getByText('面板按钮').closest('[inert]')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByText('面板按钮').closest('[inert]')).not.toBeNull()
  })

  test('Esc 只关最上面那层——嵌套浮层就近关闭', () => {
    function Wrapper() {
      const [outer, setOuter] = useState(true)
      const [inner, setInner] = useState(true)
      return (
        <Overlay open={outer} onClose={() => setOuter(false)} label="外层">
          <button>外层按钮</button>
          {outer && (
            <Overlay open={inner} onClose={() => setInner(false)} label="内层">
              <button>内层按钮</button>
            </Overlay>
          )}
        </Overlay>
      )
    }
    render(<Wrapper />)
    expect(screen.getByText('内层按钮').closest('[inert]')).toBeNull()
    expect(screen.getByText('外层按钮').closest('[inert]')).toBeNull()

    // 第一次 Esc：只关内层。外层按钮不在内层容器内，不受内层 inert 影响。
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByText('内层按钮').closest('[inert]')).not.toBeNull()
    expect(screen.getByText('外层按钮').closest('[inert]')).toBeNull()

    // 第二次 Esc：内层已经不在栈里了，这次轮到外层。
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByText('外层按钮').closest('[inert]')).not.toBeNull()
  })

  test('Tab 在浮层内循环，不会跑到底层页面', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <button>页面上的按钮</button>
        <Overlay open onClose={() => {}} label="面板">
          <button>p1</button>
          <button>p2</button>
          <button>p3</button>
        </Overlay>
      </div>,
    )
    screen.getByText('p3').focus()
    await user.tab()
    // 从最后一个 Tab 出去应该绕回第一个，而不是跑到浮层外面的「页面上的按钮」。
    expect(document.activeElement).toBe(screen.getByText('p1'))

    await user.tab({ shift: true })
    // Shift+Tab 从第一个应该反绕回最后一个。
    expect(document.activeElement).toBe(screen.getByText('p3'))
  })

  test('Toast 例外：没有动作按钮时整块不可达；有动作按钮时按钮可达，且不抢初始焦点', () => {
    function Wrapper() {
      const [withAction, setWithAction] = useState(false)
      return (
        <div>
          <button onClick={() => setWithAction(true)}>切换成带动作</button>
          <Toast
            open
            onClose={() => {}}
            message={withAction ? '有动作' : '纯提示，没有动作'}
            actionLabel={withAction ? '撤销' : undefined}
            onAction={withAction ? () => {} : undefined}
          />
        </div>
      )
    }
    render(<Wrapper />)

    // 没有动作按钮：整条 toast 都不该在 Tab 序列里，即使它正显示着。
    const message = screen.getByText('纯提示，没有动作')
    expect(message.closest('[inert]')).not.toBeNull()
    expect(isReachableByTab(message)).toBe(false)

    fireEvent.click(screen.getByText('切换成带动作'))

    // 有动作按钮：按钮本身必须可达。
    const actionBtn = screen.getByText('撤销')
    expect(actionBtn.closest('[inert]')).toBeNull()
    expect(isReachableByTab(actionBtn)).toBe(true)

    // Toast 不抢焦点：打开后 activeElement 不应该被拉进 toast 里。
    expect(document.activeElement).not.toBe(actionBtn)
  })
})

describe('Drawer / Sheet / Popover 套壳——定位不同，交互契约共用同一个 Overlay', () => {
  test('Drawer：有标题时自动挂 aria-labelledby，关闭按钮可达且能触发 onClose', () => {
    let closed = false
    render(
      <Drawer open onClose={() => (closed = true)} title="会议详情">
        <p>内容</p>
      </Drawer>,
    )
    const dialog = screen.getByRole('dialog', { name: '会议详情' })
    expect(dialog).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(closed).toBe(true)
  })

  test('Drawer：关闭态内容 inert', () => {
    render(
      <Drawer open={false} onClose={() => {}} title="会议详情">
        <button>抽屉里的按钮</button>
      </Drawer>,
    )
    expect(screen.getByText('抽屉里的按钮').closest('[inert]')).not.toBeNull()
  })

  test('Sheet：有标题时自动挂 aria-labelledby，关闭态内容 inert', () => {
    const { rerender } = render(
      <Sheet open onClose={() => {}} title="批量操作">
        <button>面板按钮</button>
      </Sheet>,
    )
    expect(screen.getByRole('dialog', { name: '批量操作' })).toBeInTheDocument()
    expect(screen.getByText('面板按钮').closest('[inert]')).toBeNull()

    rerender(
      <Sheet open={false} onClose={() => {}} title="批量操作">
        <button>面板按钮</button>
      </Sheet>,
    )
    expect(screen.getByText('面板按钮').closest('[inert]')).not.toBeNull()
  })

  test('Popover：非模态（aria-modal 不为 true），关闭态内容 inert', () => {
    const { rerender } = render(
      <Popover open onClose={() => {}} label="筛选">
        <button>选项</button>
      </Popover>,
    )
    const panel = screen.getByRole('dialog', { name: '筛选' })
    expect(panel).not.toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('选项').closest('[inert]')).toBeNull()

    rerender(
      <Popover open={false} onClose={() => {}} label="筛选">
        <button>选项</button>
      </Popover>,
    )
    expect(screen.getByText('选项').closest('[inert]')).not.toBeNull()
  })
})
