import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Button } from '../src/ui/Button'
import buttonCss from '../src/ui/Button.module.css?raw'

import { Input } from '../src/ui/Input'
import inputCss from '../src/ui/Input.module.css?raw'

import { Pill } from '../src/ui/Pill'
import pillCss from '../src/ui/Pill.module.css?raw'

import { Chip } from '../src/ui/Chip'
import chipCss from '../src/ui/Chip.module.css?raw'

import { StatusDot, STATUS_DOT_LABEL, type StatusDotState } from '../src/ui/StatusDot'
import statusDotCss from '../src/ui/StatusDot.module.css?raw'

import { ProgressBar } from '../src/ui/ProgressBar'
import progressCss from '../src/ui/ProgressBar.module.css?raw'

import { Skeleton } from '../src/ui/Skeleton'
import skeletonCss from '../src/ui/Skeleton.module.css?raw'

import { Table } from '../src/ui/Table'
import tableCss from '../src/ui/Table.module.css?raw'

import tokensCss from '../src/styles/tokens.css?raw'

/*
 * 为什么大量断言直接读原始 CSS 源码而不是 getComputedStyle：
 * 已经实测过——jsdom 不解析 CSS 自定义属性（var(...)），getComputedStyle 在这个
 * 项目里对任何引用了 var() 的声明只会吐出未展开的字面串（甚至把整条 shorthand
 * 判成非法值直接丢弃），量不出真实像素。既然全部设计令牌都是 var()，
 * getComputedStyle 这条路在这个代码库里对任何组件都走不通。改成直接读取打包前的
 * .module.css 源文本（Vite 的 ?raw 导入），断言"确实引用了正确的令牌/正确的
 * CSS 属性"，再单独断言 tokens.css 里那个令牌的字面值——两条证据链起来，
 * 等价于验证了最终计算出来的效果，且是对着真实产物断言，不是假装通过。
 */

/** 提取某个选择器片段对应规则块的内容（正确处理嵌套花括号，如 @media/@keyframes）。 */
function ruleBody(css: string, selectorFragment: string): string {
  const idx = css.indexOf(selectorFragment)
  expect(idx, `selector containing "${selectorFragment}" not found`).toBeGreaterThanOrEqual(0)
  const start = css.indexOf('{', idx)
  expect(start, `no "{" found after "${selectorFragment}"`).toBeGreaterThan(idx)
  let depth = 0
  let i = start
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return css.slice(start + 1, i)
}

/** 从 tokens.css 里取出某个令牌的裸 px 数值（用于给上面的 CSS 断言配一条数值证据）。 */
function tokenPx(name: string): number {
  const m = tokensCss.match(new RegExp(`--${name}:\\s*(-?[0-9.]+)px`))
  expect(m, `token --${name} not found in tokens.css`).not.toBeNull()
  return Number(m![1])
}

describe('Button', () => {
  test('三档（primary / default / quiet）都渲染，disabled 不可点也不可聚焦', async () => {
    const onClick = vi.fn()
    render(
      <>
        <Button variant="primary">主要</Button>
        <Button variant="default">默认</Button>
        <Button variant="quiet">安静</Button>
        <Button variant="quiet" disabled onClick={onClick}>
          禁用
        </Button>
      </>,
    )
    expect(screen.getByRole('button', { name: '主要' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '默认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安静' })).toBeInTheDocument()

    const disabled = screen.getByRole('button', { name: '禁用' })
    expect(disabled).toBeDisabled()

    // 真的点不到：即便是原生 click 事件（不经用户交互前置检查）也不触发处理器。
    disabled.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).not.toHaveBeenCalled()

    // 真的进不了 Tab 序列：disabled 原生按钮不可被聚焦。
    disabled.focus()
    expect(disabled).not.toHaveFocus()
  })

  test('danger / warn 两档分别只用红 / 琥珀，不混用', () => {
    const dangerRule = ruleBody(buttonCss, '.danger {')
    expect(dangerRule).toMatch(/color:\s*var\(--fail\)/)
    const warnRule = ruleBody(buttonCss, '.warn {')
    expect(warnRule).toMatch(/color:\s*var\(--warn\)/)
    const primaryRule = ruleBody(buttonCss, '.primary {')
    expect(primaryRule).toMatch(/color:\s*var\(--on-brand\)/)
  })

  test('按下反馈是 translateY(1px) 且不加过渡——按下应当是即时的', () => {
    const active = ruleBody(buttonCss, ':active:not(:disabled)')
    expect(active).toMatch(/transform:\s*translateY\(var\(--s-px\)\)/)
    expect(active).toMatch(/transition:\s*none/)
    expect(tokenPx('s-px')).toBe(1)
  })
})

describe('Input', () => {
  test('触控目标 ≥44px', () => {
    expect(inputCss).toMatch(/min-height:\s*var\(--tap-min\)/)
    expect(tokenPx('tap-min')).toBeGreaterThanOrEqual(44)
  })

  test('可以正常输入文本，值随输入变化（真实交互，不是摆拍）', async () => {
    render(<Input aria-label="搜索会议" />)
    const el = screen.getByLabelText('搜索会议')
    await userEvent.type(el, '产品周会')
    expect(el).toHaveValue('产品周会')
  })

  test('invalid 态设置 aria-invalid 并套用错误态样式类', () => {
    render(<Input invalid aria-label="账号" />)
    expect(screen.getByLabelText('账号')).toHaveAttribute('aria-invalid', 'true')
    const invalidRule = ruleBody(inputCss, '.invalid {')
    expect(invalidRule).toMatch(/border-color:\s*var\(--fail\)/)
  })

  test('disabled 态不可输入', async () => {
    render(<Input disabled aria-label="搜索" defaultValue="" />)
    const el = screen.getByLabelText('搜索')
    await userEvent.type(el, 'x')
    expect(el).toHaveValue('')
  })
})

describe('Pill', () => {
  test('可移除的 Pill 渲染带 aria-label 的移除按钮，点击触发回调', async () => {
    const onRemove = vi.fn()
    render(
      <Pill tone="brand" onRemove={onRemove} removeLabel="收回 kb-indexer">
        kb-indexer
      </Pill>,
    )
    const btn = screen.getByRole('button', { name: '收回 kb-indexer' })
    await userEvent.click(btn)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  test('不带 onRemove 时不渲染任何可点元素', () => {
    render(<Pill tone="fail">归档失败</Pill>)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('归档失败')).toBeInTheDocument()
  })

  test('solid 变体的 brand / fail 用成对的 on- 令牌撑字色，不写死白色', () => {
    const brandSolid = ruleBody(pillCss, '.brand.solid {')
    expect(brandSolid).toMatch(/color:\s*var\(--on-brand\)/)
    expect(brandSolid).not.toMatch(/#fff/i)
    const failSolid = ruleBody(pillCss, '.fail.solid {')
    expect(failSolid).toMatch(/color:\s*var\(--on-fail\)/)
    expect(failSolid).not.toMatch(/#fff/i)
  })
})

describe('Chip', () => {
  test('用 aria-pressed 表达选中态，点击真的切换状态', async () => {
    function Demo() {
      const [active, setActive] = useState(false)
      return (
        <Chip active={active} onClick={() => setActive((a) => !a)}>
          归档失败
        </Chip>
      )
    }
    render(<Demo />)
    const chip = screen.getByRole('button', { name: '归档失败' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'false')
  })

  test('选中态只用品牌蓝（主交互色），不借用 Chip 自身筛选语义的颜色', () => {
    const pressedRule = ruleBody(chipCss, "[aria-pressed='true']")
    expect(pressedRule).toMatch(/background:\s*var\(--brand\)/)
    expect(pressedRule).toMatch(/color:\s*var\(--on-brand\)/)
  })
})

describe('StatusDot', () => {
  const states: StatusDotState[] = ['done', 'running', 'failed', 'blocked', 'off', 'none']

  test('六态各有可读文本，不只有颜色（aria-label 与原生 tooltip 双重暴露）', () => {
    const seenLabels = new Set<string>()
    for (const state of states) {
      const { unmount } = render(<StatusDot state={state} label="拉取" />)
      const text = `拉取：${STATUS_DOT_LABEL[state]}`
      const el = screen.getByLabelText(text)
      expect(el).toHaveAttribute('title', text)
      seenLabels.add(STATUS_DOT_LABEL[state])
      unmount()
    }
    // 六个状态的文案互不相同：颜色之外还有六种不同的可读信息，不是一套颜色配一句空话
    expect(seenLabels.size).toBe(6)
  })

  test('overridden 态把"人工改写"写进文本里，不是只加一圈看不出含义的颜色', () => {
    render(<StatusDot state="done" label="拉取" overridden />)
    expect(screen.getByLabelText('拉取：已完成 · 人工改写')).toBeInTheDocument()
  })

  test('带 onClick 时是可点的切换按钮（点一下重跑该阶段），disabled 时不可点', async () => {
    const onClick = vi.fn()
    const { rerender } = render(<StatusDot state="failed" label="归档到 NAS" onClick={onClick} />)
    const btn = screen.getByRole('button', { name: '归档到 NAS：失败' })
    await userEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(<StatusDot state="failed" label="归档到 NAS" onClick={onClick} disabled />)
    const disabledBtn = screen.getByRole('button', { name: '归档到 NAS：失败' })
    expect(disabledBtn).toBeDisabled()
  })

  test('不带 onClick 时是纯展示元素，不出现在按钮角色里', () => {
    render(<StatusDot state="done" label="拉取" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  test('failed 态只用语义红 --fail，不借它表达别的意思', () => {
    const failedRule = ruleBody(statusDotCss, '.glyphFailed {')
    expect(failedRule).toMatch(/fill:\s*var\(--fail\)/)
  })

  test('"进行中"呼吸动画只动 opacity（合成属性），reduced-motion 下关闭', () => {
    const keyframes = ruleBody(statusDotCss, '@keyframes statusDotPulse')
    expect(keyframes).toMatch(/opacity/)
    expect(keyframes).not.toMatch(/transform|background-position/)
    const reduced = ruleBody(statusDotCss, 'prefers-reduced-motion: reduce')
    expect(reduced).toMatch(/animation:\s*none\s*!important/)
  })
})

describe('ProgressBar', () => {
  test('有 role=progressbar 与 aria-valuenow，且与视觉宽度（scaleX）出自同一次计算', () => {
    const { container } = render(<ProgressBar value={40} max={100} label="保留期" />)
    const bar = screen.getByRole('progressbar', { name: '保留期' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')

    const fill = container.querySelector('[data-pct]')
    expect(fill).not.toBeNull()
    expect(fill!.getAttribute('data-pct')).toBe('40')
    expect((fill as HTMLElement).style.transform).toBe('scaleX(0.4)')
  })

  test('value 超出 [0,max] 会被夹住，不会产生非法的 aria-valuenow', () => {
    render(<ProgressBar value={999} max={100} label="容量" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    render(<ProgressBar value={-5} max={100} label="容量2" />)
    expect(screen.getByRole('progressbar', { name: '容量2' })).toHaveAttribute('aria-valuenow', '0')
  })

  test('用 transform 做取值动画，不用 width——不动布局属性', () => {
    const fillRule = ruleBody(progressCss, '.fill {')
    expect(fillRule).toMatch(/transition:\s*transform/)
    expect(fillRule).not.toMatch(/width\s+var\(--dur/)
    expect(fillRule).not.toMatch(/transition:\s*width/)
  })

  test('条状元素用 --r-pill（半高语义），不是某个像素圆角值', () => {
    const trackRule = ruleBody(progressCss, '.track {')
    expect(trackRule).toMatch(/border-radius:\s*var\(--r-pill\)/)
  })
})

describe('Skeleton', () => {
  test('用 transform 做扫光动画，不动 background-position（非合成属性会每帧触发 paint）', () => {
    const keyframes = ruleBody(skeletonCss, '@keyframes skelSweep')
    expect(keyframes).toMatch(/transform:\s*translateX/)
    expect(keyframes).not.toMatch(/background-position/)

    const afterRule = ruleBody(skeletonCss, '.skel::after {')
    expect(afterRule).toMatch(/animation:\s*skelSweep/)

    const reduced = ruleBody(skeletonCss, 'prefers-reduced-motion: reduce')
    expect(reduced).toMatch(/animation:\s*none\s*!important/)
  })

  test('渲染为 aria-hidden 的纯展示元素，宽度按 prop 传入', () => {
    const { container } = render(<Skeleton width="40%" size="sm" />)
    const el = container.firstElementChild as HTMLElement
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(el.style.width).toBe('40%')
  })
})

describe('Table', () => {
  test('横向溢出裹在自己的 overflow-x 容器里，页面 body 不横滚', () => {
    const scrollRule = ruleBody(tableCss, '.scroll {')
    expect(scrollRule).toMatch(/overflow-x:\s*auto/)
    // 外层 wrap 容器不重复设置横向滚动——横向溢出只应该发生在 .scroll 这一层。
    const wrapRule = ruleBody(tableCss, '.wrap {')
    expect(wrapRule).not.toMatch(/overflow-x/)

    const bodyStyleBefore = document.body.getAttribute('style')
    render(
      <Table minWidth={1020}>
        <thead>
          <tr>
            <th>标题</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>产品周会</td>
          </tr>
        </tbody>
      </Table>,
    )
    // Table 组件本身完全不碰 document.body——不靠"body 也能横向滚"这种旁路。
    expect(document.body.getAttribute('style')).toBe(bodyStyleBefore)
  })

  test('渲染出 wrap > scroll > table 的嵌套结构，minWidth 加在 table 自己身上', () => {
    const { container } = render(
      <Table minWidth={820}>
        <tbody>
          <tr>
            <td>x</td>
          </tr>
        </tbody>
      </Table>,
    )
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect((table as HTMLTableElement).style.minWidth).toBe('820px')
    expect(table!.parentElement?.tagName).toBe('DIV')
    expect(table!.parentElement?.parentElement?.tagName).toBe('DIV')
  })

  test('行状态用 data 属性驱动样式钩子（selected 用品牌蓝，cursor 用左侧内投影）', () => {
    const selectedRule = ruleBody(tableCss, "[data-selected='true']")
    expect(selectedRule).toMatch(/var\(--brand\)/)
    const cursorRule = ruleBody(tableCss, "[data-cursor='true']")
    expect(cursorRule).toMatch(/box-shadow:\s*inset/)
  })
})

describe('令牌纪律（本任务新增的两个令牌）', () => {
  test('--tap-min / --dur-loop 只在 :root 定义一次，没有写进 @media 或 [data-theme] 块', () => {
    const rootRule = ruleBody(tokensCss, ':root {')
    expect(rootRule).toMatch(/--tap-min:\s*44px/)
    expect(rootRule).toMatch(/--dur-loop:\s*1\.4s/)

    const darkMediaIdx = tokensCss.indexOf('@media (prefers-color-scheme: dark)')
    expect(darkMediaIdx).toBeGreaterThan(0)
    const afterDark = tokensCss.slice(darkMediaIdx)
    expect(afterDark).not.toMatch(/--tap-min|--dur-loop/)
  })
})
