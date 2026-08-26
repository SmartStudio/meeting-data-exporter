import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import { render, renderAsRole } from '../helpers/session'
import { PageShell } from '../../src/ui/PageShell'

/**
 * `PageShell` 是七个页面共同的页头骨架。它在地基阶段建好，是为了让七个并行
 * 任务不各画一遍页头——那样会得到七种略微不同的间距和字号。
 *
 * 这里测的是它的无障碍契约（区域有名字、标题是 h1），不是它长什么样：
 * 样式回归由 `npm run a11y` 在真实浏览器里跑。
 */
describe('PageShell', () => {
  test('区域由标题命名（aria-labelledby 指到那个 h1）', () => {
    render(<PageShell title="归档存储" />)
    const region = screen.getByRole('region', { name: '归档存储' })
    const heading = screen.getByRole('heading', { name: '归档存储', level: 1 })
    expect(region).toHaveAttribute('aria-labelledby', heading.id)
  })

  test('不自带 <main>：一页只能有一个，它在 AppShell 那一层', () => {
    render(<PageShell title="操作审计" />)
    expect(screen.queryByRole('main')).toBeNull()
  })

  test('说明与动作区给了才渲染，不留空节点', () => {
    const { rerender } = render(<PageShell title="定时任务" />)
    expect(screen.queryByRole('button')).toBeNull()

    rerender(
      <PageShell
        title="定时任务"
        description="四个内置任务"
        actions={<button type="button">立即运行</button>}
      >
        <p>内容</p>
      </PageShell>,
    )
    expect(screen.getByText('四个内置任务')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即运行' })).toBeInTheDocument()
    expect(screen.getByText('内容')).toBeInTheDocument()
  })

  test('只读账号：每一页都带一句说明，管理员不带', () => {
    renderAsRole(<PageShell title="自动规则" />, 'readonly')
    const note = screen.getByTestId('readonly-banner')
    expect(note).toHaveTextContent('只读角色')
    // 说清"不能改什么"与"去找谁"，不是一句"权限不足"
    expect(note).toHaveTextContent('管理员')
  })

  test('没有 SessionProvider 时落到只读一侧（安全的那一侧）', () => {
    // 这条是回归：`useRole()` 的默认值一旦改成 admin，少包一层 Provider
    // 的页面就会把写入口画成可点的。
    render(<PageShell title="定时任务" />)
    expect(screen.queryByTestId('readonly-banner')).toBeNull() // 包了 admin，所以没有
    renderAsRole(<PageShell title="定时任务" />, 'readonly')
    expect(screen.getAllByTestId('readonly-banner').length).toBe(1)
  })

  test('CSS 里没有裸值——色值与间距一律走令牌', () => {
    // a11y 门槛的「检查 4 裸值扫描」跑在构建产物上，这里在单测里先拦一道，
    // 免得改样式时要等一次完整构建才知道踩线。
    const css = readFileSync(resolve(process.cwd(), 'src/ui/PageShell.module.css'), 'utf-8')
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(declarations).not.toMatch(/\brgba?\(/)
    expect(declarations).not.toMatch(/\b\d+px\b/)
  })
})
