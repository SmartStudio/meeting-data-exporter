import { expect, test } from 'bun:test'
import { MAX_WINDOW_SEC, splitWindows } from '../../src/tencent/window'

const DAY = 86400

test('小于 31 天返回单个窗口', () => {
  expect(splitWindows(0, 10 * DAY)).toEqual([{ from: 0, to: 10 * DAY }])
})

test('恰好 31 天不切分', () => {
  expect(splitWindows(0, MAX_WINDOW_SEC)).toHaveLength(1)
})

test('90 天切成 3 个窗口', () => {
  const w = splitWindows(0, 90 * DAY)
  expect(w).toHaveLength(3)
  expect(w[0]!.from).toBe(0)
  expect(w[2]!.to).toBe(90 * DAY)
})

test('窗口左闭右开，无重叠无遗漏', () => {
  const w = splitWindows(0, 90 * DAY)
  for (let i = 1; i < w.length; i++) {
    expect(w[i]!.from).toBe(w[i - 1]!.to)
  }
})

test('每个窗口都不超过上限', () => {
  for (const win of splitWindows(0, 200 * DAY)) {
    expect(win.to - win.from).toBeLessThanOrEqual(MAX_WINDOW_SEC)
  }
})

test('from 大于 to 时抛错', () => {
  expect(() => splitWindows(100, 50)).toThrow('invalid range')
})
