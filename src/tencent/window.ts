/** 平台限制：`/v1/records` 与 `/v1/corp/records` 单次查询区间均不得超过 31 天 */
export const MAX_WINDOW_SEC = 31 * 24 * 3600
export const DEFAULT_WINDOW_SEC = 31 * 24 * 3600

export interface Window {
  from: number
  to: number
}

/** 左闭右开切分，保证无重叠无遗漏 */
export function splitWindows(from: number, to: number): Window[] {
  if (from > to) throw new Error(`invalid range: from ${from} > to ${to}`)
  const windows: Window[] = []
  let cursor = from
  while (cursor < to) {
    const next = Math.min(cursor + MAX_WINDOW_SEC, to)
    windows.push({ from: cursor, to: next })
    cursor = next
  }
  return windows.length > 0 ? windows : [{ from, to }]
}
