import { describe, expect, test } from 'vitest'
import { useRef, useState } from 'react'
import { act, render } from '@testing-library/react'
import { useFollowCurrent } from '../../src/pages/Preview/text'

/**
 * 转写/时间轴的「走时自动跟随」只许滚自己那个框。
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
