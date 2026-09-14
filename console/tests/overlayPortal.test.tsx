import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, test, expect } from 'vitest'
import { Drawer } from '../src/ui/Drawer'
import { Sheet } from '../src/ui/Sheet'
import { Toast } from '../src/ui/Toast'
import { Popover } from '../src/ui/Popover'

/**
 * 固定定位的浮层（Sheet / Drawer / Toast）必须挂到 body 下，不能留在触发它的
 * 那棵子树里：顶栏是 `position: sticky; z-index: var(--z-sticky)`，自成一个层叠
 * 上下文，留在里面的弹窗 z-index 再高也只在顶栏内部比大小——内容预览页的
 * 播放条同为 sticky 且在 DOM 里更靠后，于是整个顶栏（连同改密码弹窗）被它
 * 压在下面。Popover 是纯 CSS 相对触发按钮定位的，**不能**搬走。
 */
describe('固定定位的浮层挂到 body 下，逃出祖先的层叠上下文', () => {
  test('Sheet 的面板与遮罩都直接挂在 body 下，不留在渲染它的容器里', () => {
    const { container } = render(
      <div data-testid="gbar" style={{ position: 'sticky', zIndex: 30 }}>
        <Sheet open onClose={() => {}} title="修改密码">
          <button>面板按钮</button>
        </Sheet>
      </div>,
    )
    const dialog = screen.getByRole('dialog', { name: '修改密码' })
    expect(dialog.parentElement).toBe(document.body)
    expect(container.contains(dialog)).toBe(false)
    const scrim = dialog.previousElementSibling
    expect(scrim).not.toBeNull()
    expect(scrim!.getAttribute('aria-hidden')).toBe('true')
    expect(scrim!.parentElement).toBe(document.body)
  })

  test('Drawer 与 Toast 同样挂在 body 下', () => {
    const { container } = render(
      <div>
        <Drawer open onClose={() => {}} title="会议详情">
          <p>内容</p>
        </Drawer>
        <Toast open onClose={() => {}} message="已保存" />
      </div>,
    )
    expect(screen.getByRole('dialog', { name: '会议详情' }).parentElement).toBe(document.body)
    expect(screen.getByRole('status').parentElement).toBe(document.body)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  test('Popover 留在原地——它靠 CSS 相对触发按钮定位', () => {
    const { container } = render(
      <div style={{ position: 'relative' }}>
        <button>触发</button>
        <Popover open onClose={() => {}} label="菜单">
          <button>菜单项</button>
        </Popover>
      </div>,
    )
    expect(container.contains(screen.getByRole('dialog', { name: '菜单' }))).toBe(true)
  })

  test('Esc 就近关闭在 portal 之后仍然成立：Drawer 里打开的 Sheet 先关，Drawer 后关', () => {
    function Wrapper() {
      const [outer, setOuter] = useState(true)
      const [inner, setInner] = useState(true)
      return (
        <Drawer open={outer} onClose={() => setOuter(false)} title="外层">
          <button>外层按钮</button>
          <Sheet open={inner} onClose={() => setInner(false)} title="内层">
            <button>内层按钮</button>
          </Sheet>
        </Drawer>
      )
    }
    render(<Wrapper />)
    // 两层在 DOM 里是并列的（都在 body 下），「谁在上面」不能再靠 DOM 包含关系判断。
    const outerEl = screen.getByRole('dialog', { name: '外层' })
    const innerEl = screen.getByRole('dialog', { name: '内层' })
    expect(outerEl.contains(innerEl)).toBe(false)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByText('内层按钮').closest('[inert]')).not.toBeNull()
    expect(screen.getByText('外层按钮').closest('[inert]')).toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByText('外层按钮').closest('[inert]')).not.toBeNull()
  })
})
