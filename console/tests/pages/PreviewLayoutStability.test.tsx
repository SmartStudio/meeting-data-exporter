import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RefObject } from 'react'
import { useRef, useState } from 'react'
import { act, render } from '@testing-library/react'
import { useFollowCurrent, useHeightFloor } from '../../src/pages/Preview/text'

/**
 * 这一页的**布局稳定性**：内容变化不许去动人正在看的位置。
 *
 * 两条约束是同一件事的两半，都由真实使用报出来、都由真浏览器量出来：
 *
 * 1. **不许把页面滚走**（`useFollowCurrent`）——走时跟随只滚分段列表那个框。
 * 2. **不许把页面塌掉**（`useHeightFloor`）——取新数据时正文槽的高度冻住,
 *    骨架屏不把页面拽矮、滚动位置不被浏览器钳掉。
 *
 * ## 转写/时间轴的「走时自动跟随」只许滚自己那个框。
 *
 * 上一版用 `scrollIntoView({ block: 'nearest' })`，在真浏览器上把 window 一起滚了
 * （1440×900 实测：一按播放 3.75 秒内 `scrollY` 0 → 544，人滚回去下一段又拽回来）。
 * 推理写在 `Preview/text.tsx` 的 `useFollowCurrent` 头上。
 *
 * ## 为什么要自己造几何
 *
 * jsdom 不做排版：`getBoundingClientRect` 恒返回全 0，`Element.prototype.scrollTop`
 * 是「读恒 0、写空转」。所以**这条测试不注几何就只能测到"什么都没发生"**——
 * 而那正是旧实现在 jsdom 里的样子（`scrollIntoView` 不存在，可选调用静默跳过，
 * 测试全绿）。下面把框和行的矩形、以及一个真的存得住的 `scrollTop` 都注进去,
 * 让这条测试真的有东西可测。
 */

const BOX_TOP = 100
const BOX_H = 300
const ROW_H = 100

function Harness({ cur }: { cur: number }) {
  const ref = useRef<HTMLUListElement>(null)
  useFollowCurrent(ref, cur)
  return (
    <ul ref={ref} data-testid="box">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i}>
          <button type="button" aria-current={i === cur ? 'true' : undefined}>
            第 {i} 段
          </button>
        </li>
      ))}
    </ul>
  )
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top } as DOMRect
}

/** 给框和每一行注入排版：行 i 的视口位置 = 框顶 − 已滚距离 + i×行高 */
function layout(box: HTMLElement): { get scrollTop(): number } {
  let top = 0
  Object.defineProperty(box, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v
    },
    configurable: true,
  })
  Object.defineProperty(box, 'getBoundingClientRect', {
    value: () => rect(BOX_TOP, BOX_H),
    configurable: true,
  })
  box.querySelectorAll('button').forEach((b, i) => {
    Object.defineProperty(b, 'getBoundingClientRect', {
      value: () => rect(BOX_TOP - top + i * ROW_H, ROW_H),
      configurable: true,
    })
  })
  return {
    get scrollTop() {
      return top
    },
  }
}

/** 挂载 → 注入几何 → 换当前段。注入必须在首次 effect 之后，否则量到的是全 0。 */
function follow(from: number, to: number): number {
  function Wrap() {
    const [cur, setCur] = useState(from)
    ;(Wrap as unknown as { set: (n: number) => void }).set = setCur
    return <Harness cur={cur} />
  }
  const { getByTestId } = render(<Wrap />)
  const box = getByTestId('box')
  const view = layout(box)
  act(() => {
    ;(Wrap as unknown as { set: (n: number) => void }).set(to)
  })
  return view.scrollTop
}

describe('走时跟随只滚自己那个框', () => {
  test('当前段在框里 → 一动不动', () => {
    // 框是 100..400，第 2 段是 300..400，整段在里面
    expect(follow(0, 2)).toBe(0)
  })

  test('当前段掉到框下面 → 只补差的那一段，正好贴住下边', () => {
    // 第 4 段是 500..600，框底 400，差 200
    expect(follow(0, 4)).toBe(200)
  })

  test('框比行高 → 不会一次滚过头', () => {
    // 第 3 段是 400..500，差 100：贴下边就够，不该按整屏翻
    expect(follow(0, 3)).toBe(100)
  })

  test('没有当前段（位置还没走到第一段）→ 不滚', () => {
    function Wrap() {
      const ref = useRef<HTMLUListElement>(null)
      useFollowCurrent(ref, 7)
      return (
        <ul ref={ref} data-testid="box">
          <li>
            <button type="button">第 0 段</button>
          </li>
        </ul>
      )
    }
    const { getByTestId } = render(<Wrap />)
    const view = layout(getByTestId('box'))
    expect(view.scrollTop).toBe(0)
  })
})

/* ── 取新数据时不许把页面塌掉 ────────────────────────────────────── */

/**
 * jsdom 不做排版，`offsetHeight` 恒 0，所以这一组也得自己注几何——注不进去的话
 * 这几条就是「报告通过却什么都没量」的门禁（同上面那一组）。
 */
function Floor({ loading, h, memo }: { loading: boolean; h: number; memo: RefObject<number | null> }) {
  const floor = useHeightFloor(loading, memo)
  return (
    <div ref={floor.ref} style={floor.style} data-testid="slot" data-h={h}>
      {loading ? '骨架屏' : '正文'}
    </div>
  )
}

/** 让 `offsetHeight` 读 `data-h`，这样每次重渲染都能给出不同的"排版结果" */
function withHeight(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get(this: HTMLElement) {
      return Number(this.getAttribute('data-h') ?? 0)
    },
    configurable: true,
  })
}

describe('取新数据时正文槽的高度冻住', () => {
  test('ready 时量到高度 → 下一次 loading 冻在那个高度上', () => {
    withHeight()
    const memo = { current: null as number | null }
    const { getByTestId, rerender } = render(<Floor loading={false} h={755} memo={memo} />)
    expect(getByTestId('slot').style.minHeight, 'ready 时不该有 min-height').toBe('')
    rerender(<Floor loading h={0} memo={memo} />)
    expect(getByTestId('slot').style.minHeight).toBe('755px')
    // 新数据到了就撤掉——留着它会把一个更矮的正文垫出一段空白
    rerender(<Floor loading={false} h={232} memo={memo} />)
    expect(getByTestId('slot').style.minHeight).toBe('')
  })

  test('首次加载（还没量到过）不冻 —— 那时页面本来就没有内容会被塌掉', () => {
    withHeight()
    const { getByTestId } = render(<Floor loading h={0} memo={{ current: null }} />)
    expect(getByTestId('slot').style.minHeight).toBe('')
  })

  test('量到 0 不记 —— 记了会挂一个 `min-height: 0px`，看着生效其实什么都没冻', () => {
    withHeight()
    const memo = { current: null as number | null }
    const { getByTestId, rerender } = render(<Floor loading={false} h={0} memo={memo} />)
    rerender(<Floor loading h={0} memo={memo} />)
    expect(getByTestId('slot').style.minHeight).toBe('')
  })

  /**
   * 这一条是「点纪要页面塌一下又弹回来」的最后一段：切到别的 tab 时 `MinutesTab`
   * 会被**卸载**，记在组件里的高度跟着没了，切回来冻无可冻（实测 y 185 → 107 → 185）。
   * 所以记忆由页面持有——卸载再挂载，它必须还在。
   */
  test('记忆活过卸载 —— 切走再切回来，冻的还是上次那个高度', () => {
    withHeight()
    const memo = { current: null as number | null }
    const first = render(<Floor loading={false} h={640} memo={memo} />)
    first.unmount()
    const again = render(<Floor loading h={0} memo={memo} />)
    expect(again.getByTestId('slot').style.minHeight).toBe('640px')
  })
})

describe('冻高度的那个槽真的套在正文外面', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/pages/Preview/MinutesTab.tsx'), 'utf-8')

  /**
   * 冻错盒子等于没冻：槽必须同时装住 loading / error / ready 三条分支，
   * 否则骨架屏在槽外面，槽冻的是一个空盒子，页面照塌。
   */
  test('骨架屏与正文在同一个槽里', () => {
    const slot = /<div ref=\{floor\.ref\}[\s\S]*?\n      <\/div>/.exec(src)
    expect(slot, '找不到 floor.ref 那个槽').not.toBeNull()
    expect(slot![0]).toMatch(/res\.state === 'loading'/)
    expect(slot![0]).toMatch(/res\.state === 'error'/)
    expect(slot![0]).toMatch(/<SelectedBody/)
  })

  /**
   * 2026-09-08：纪要只有一份，工具条整块删了（原来是模板与文件格式两组单选）。
   * 这条从「工具条不在槽里」改成「根本没有工具条」——冻高度的槽因此就是整个 tab。
   */
  test('纪要 tab 上没有工具条 —— 只有一类纪要，没有可切的东西', () => {
    expect(src).not.toMatch(/RadioRow|styles\.toolbar/)
  })

  /**
   * min-height 生效的那一帧，槽比里面的骨架屏高。grid 默认 `align-content: stretch`
   * 会把骨架屏拉成一根几百 px 的灰条——那比塌陷还难看。
   */
  test('槽是 align-content: start，不许把骨架屏拉伸成灰条', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/Preview/Preview.module.css'), 'utf-8')
    const block = /\.docSlot \{([^}]*)\}/.exec(css)
    expect(block, '找不到 .docSlot 规则').not.toBeNull()
    expect(block![1]).toMatch(/align-content:\s*start/)
  })
})

describe('纪要正文槽的高度记忆由页面持有', () => {
  test('MinutesTab 只收记忆，不自己造一个', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/pages/Preview/MinutesTab.tsx'), 'utf-8')
    expect(src).toMatch(/heightMemo/)
    expect(src, '组件内不许再自己 useRef 存高度 —— 卸载一次就没了').not.toMatch(
      /useRef<number \| null>/,
    )
  })

  test('页面把记忆传下去了', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/pages/Preview/index.tsx'), 'utf-8')
    expect(src).toMatch(/const minutesH = useRef<number \| null>\(null\)/)
    expect(src).toMatch(/heightMemo=\{minutesH\}/)
  })
})
