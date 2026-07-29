import { expect, test } from 'bun:test'
import { splitWindow } from '../../src/domain/window'

const D = 86400
test('90 天切成 3 个不超 31 天的窗口，无重叠无遗漏', () => {
  const w = splitWindow(1_000_000, 1_000_000 + 90 * D)
  expect(w.length).toBe(3)
  expect(w[0]!.from).toBe(1_000_000)
  expect(w[w.length - 1]!.to).toBe(1_000_000 + 90 * D)
  for (let i = 1; i < w.length; i++) expect(w[i]!.from).toBe(w[i - 1]!.to) // 左闭右开衔接
  for (const win of w) expect(win.to - win.from).toBeLessThanOrEqual(31 * D)
})
test('小于 31 天返回单窗口', () => {
  expect(splitWindow(100, 100 + 10 * D)).toEqual([{ from: 100, to: 100 + 10 * D }])
})
