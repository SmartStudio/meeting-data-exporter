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

/**
 * 这场会议开了多久。`7 秒` · `5 分 32 秒` · `1 小时 52 分`。
 *
 * ## 为什么带单位，而不是 `时:分`
 *
 * 原来输出 `时:分`（332 秒 → `0:05`）。这个写法在内容预览页上被读错了两次,
 * 两次都是硬错：
 *
 * 1. **和时间码撞脸**。抬头写「时长 0:05」，同一屏下面的走时条写「2:46 / 5:32」
 *    ——同一个 332 秒。人只会把「0:05」读成 5 秒，然后奇怪一场 5 秒的会议
 *    怎么有 5 分 32 秒的录像。
 * 2. **短会议显示成零**。旧实现按整分钟截断，`fmtDuration(59)` 是 `'0:00'`。
 *    库里最短的会议是 7 秒——那几场界面上写着「时长 0:00」，读起来是
 *    「这场会议根本没开」，而它其实开了 7 秒、还归了档。
 *
 * 满一小时之后**丢掉秒**：一场两小时的会议，末尾那 13 秒不是任何人要的信息,
 * 而多出来的两个字会把这一行挤到换行。不满一小时则**必须报秒**——第 1 条错误
 * 就出在那里。
 *
 * 与 `fmtClock` 从此**连形状都不一样**，再也顶替不了对方。
 */
export function fmtDuration(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  if (total < 60) return `${total} 秒`
  const totalMin = Math.floor(total / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分 ${total % 60} 秒`
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

/**
 * 播放位置 / 转写时间戳。`0:00` · `1:05` · `1:01:01`。
 *
 * **与 `fmtDuration` 是两件事，不能互相顶替。** `fmtDuration` 报的是「这场会议
 * 开了多久」（带单位，`fmtDuration(65) === '1 分 5 秒'`）；这里报的是「录像走到
 * 哪一秒」（分:秒，`fmtClock(65) === '1:05'`）。把时长格式套在时间戳上，点开的
 * 就是另一个位置——而内容预览页的三处联动全靠这个数对得上。
 *
 * 秒按向下取整（走时是连续的，四舍五入会让 `0:59` 跳过 `1:00` 直接显示成 `1:00`
 * 又退回去）。负数夹到 0：播放位置不存在「负几秒」。
 */
export function fmtClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h === 0 ? `${m}:${pad2(s)}` : `${h}:${pad2(m)}:${pad2(s)}`
}

/** 中文写法的日期，不补零、不带年份（用于同年内的"归档于 X 月 X 日"这类文案）。 */
export function fmtDay(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/**
 * `fmtDateTime` 带秒：`9-14 10:44:07`。
 *
 * 审计记录要到秒——同一个程序在一分钟里取了两次，`10:44` 两行看起来是重复，
 * `10:44:07` 与 `10:44:41` 才看得出是两次。其它页面不需要秒，仍用 `fmtDateTime`。
 */
export function fmtDateTimeSec(unixSec: number, now: Date = new Date()): string {
  const d = new Date(unixSec * 1000)
  return `${fmtDateTime(unixSec, now)}:${pad2(d.getSeconds())}`
}

/** 当天的时刻，到秒：`10:44:07`。日期由别处（分组行）给出时用它。 */
export function fmtTimeSec(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 本地日期键 `YYYY-M-D`，用来判断两个时刻是不是同一天（不是 UTC 的同一天）。 */
export function dayKeyOf(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/**
 * 分组行的日期：`9 月 14 日 周日`；跨年补年份 `2025 年 12 月 31 日 周三`。
 * 星期是给人定位用的——"上周五那次"比"9 月 11 日那次"更接近人回忆事情的方式。
 */
export function fmtDayHeading(unixSec: number, now: Date = new Date()): string {
  const d = new Date(unixSec * 1000)
  const wd = WEEKDAYS[d.getDay()] ?? ''
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${wd}`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()} 年 ${md}`
}
