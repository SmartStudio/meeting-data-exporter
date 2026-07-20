/**
 * 平台时间戳单位不统一：查询参数为秒，media_start_time / record_*_time 为毫秒，
 * record_info.start_time 为字符串型毫秒。统一在此归一为秒。
 */
export function msToSec(ms: number | string): number {
  const n = typeof ms === 'string' ? Number(ms) : ms
  if (!Number.isFinite(n)) {
    throw new Error(`invalid millisecond timestamp: ${ms}`)
  }
  return Math.floor(n / 1000)
}

export function secToMs(sec: number): number {
  return sec * 1000
}
