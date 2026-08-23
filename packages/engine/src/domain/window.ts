const MAX_WINDOW_SEC = 31 * 86400
/** 把 [from,to] 切成 ≤31 天的左闭右开窗口，衔接无重叠无遗漏 */
export function splitWindow(from: number, to: number): Array<{ from: number; to: number }> {
  if (to <= from) return [{ from, to }]
  const out: Array<{ from: number; to: number }> = []
  let cur = from
  while (cur < to) {
    const next = Math.min(cur + MAX_WINDOW_SEC, to)
    out.push({ from: cur, to: next })
    cur = next
  }
  return out
}
