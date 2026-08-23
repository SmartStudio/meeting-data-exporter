/**
 * 把 `api/types.ts` 的原始值（unix 秒 / 数字）转成界面展示串。
 * 这是唯一允许出现展示格式的地方——组件不自己拼日期、拼单位。
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * 本地时区。同年不补年份（`8-21 14:00`），跨年补上（`2025-12-31 09:05`）。
 * `now` 用来判断"是否同年"，默认取当前时间；测试里显式传入以固定基准。
 */
export function fmtDateTime(unixSec: number, now: Date = new Date()): string {
  const d = new Date(unixSec * 1000)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
}

/** `时:分`，时不补零，分补零。按整分钟截断（不四舍五入到下一分钟）。 */
export function fmtDuration(sec: number): string {
  const totalMin = Math.floor(sec / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}:${pad2(m)}`
}

/** 三位有效数字。 */
function sig3(n: number): string {
  if (n >= 100) return String(Math.round(n))
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

/** 二进制单位（1024 进制），三位有效数字。`null` 表示不适用，显示为 `—`。 */
export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes === 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = Math.abs(bytes)
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }

  let display = sig3(value)
  // 三位有效数字四舍五入后可能整数进到了下一级（例如 1023.99 KB 显示成
  // "1024 KB"，数字上不成立），再检一次并进位到下一个单位。
  if (parseFloat(display) >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
    display = sig3(value)
  }
  return `${display} ${units[i]}`
}

/**
 * 剩余天数，按自然日算——不是 `Math.floor(差值 / 86400)`。
 * 把 `expiresAt` 与 `now` 都归到当地零点再相减，四舍五入到整天
 * （夏令时切换周会让本地一天不是精确 86400000 毫秒，round 比 floor 更稳）。
 * 已过期（差值 <= 0）返回 0，不返回负数——负数会被读成"还有负几天"，
 * 而这个产品里"到期"就是"今晚就删"，不该再细分过期了多久。
 *
 * 调用方必须先确认 `expiresAt !== null`（未归档成功的会议保留窗口未起算，
 * 不该问"还剩几天"）。
 */
export function daysLeft(expiresAt: number, now: Date = new Date()): number {
  const a = startOfDay(now)
  const b = startOfDay(new Date(expiresAt * 1000))
  const diffDays = Math.round((b.getTime() - a.getTime()) / 86400000)
  return Math.max(0, diffDays)
}

/** 中文写法的日期，不补零、不带年份（用于同年内的"归档于 X 月 X 日"这类文案）。 */
export function fmtDay(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
