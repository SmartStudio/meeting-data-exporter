import { describe, expect, test } from 'vitest'
import { fmtDateTime, fmtDuration, fmtBytes, daysLeft, fmtDay, fmtClock } from '../src/lib/format'

describe('format', () => {
  test('fmtDateTime 用本地时区，不补年（同年）', () => {
    // 2026-08-21 14:00 本地
    const t = new Date(2026, 7, 21, 14, 0).getTime() / 1000
    expect(fmtDateTime(t, new Date(2026, 7, 23))).toBe('8-21 14:00')
  })
  test('fmtDateTime 跨年时补上年份', () => {
    const t = new Date(2025, 11, 31, 9, 5).getTime() / 1000
    expect(fmtDateTime(t, new Date(2026, 7, 23))).toBe('2025-12-31 09:05')
  })
  /**
   * `fmtDuration` 原来输出 `时:分`（`0:05`）。2026-08-28 换成带单位的中文,
   * 因为 `时:分` 在这一页上被读错了两次，而且都是硬错：
   *
   * 1. **和时间码撞脸**。内容预览页抬头写「时长 0:05」，同一屏下面的走时条写
   *    「2:46 / 5:32」——同一个 332 秒，一个是「0 时 05 分」一个是「5 分 32 秒」。
   *    人只会把「0:05」读成 5 秒。
   * 2. **短会议显示成零**。`fmtDuration(59)` 是 `'0:00'`，而库里最短的会议是
   *    7 秒——那几场在界面上时长写着「0:00」，读起来是「这场会议没开」。
   *
   * `fmtClock` 不动：它报的是「录像走到哪一秒」，`分:秒` 是时间码的通用写法,
   * 而且预览页三处联动全靠它对得上。两个函数从此**连形状都不一样**，
   * 再也顶替不了对方。
   */
  test('fmtDuration 带单位，不与时间码撞脸', () => {
    expect(fmtDuration(6720)).toBe('1 小时 52 分')
    expect(fmtDuration(2820)).toBe('47 分 0 秒')
    expect(fmtDuration(332)).toBe('5 分 32 秒')
    expect(fmtDuration(0)).toBe('0 秒')
  })

  test('不足一分钟的会议报得出真实秒数——不是 0', () => {
    // 库里最短的一场是 7 秒。旧实现按整分钟截断，这一场显示成「0:00」
    expect(fmtDuration(7)).toBe('7 秒')
    expect(fmtDuration(59)).toBe('59 秒')
  })
  test('fmtBytes 三位有效数字，二进制单位', () => {
    expect(fmtBytes(23907140)).toBe('22.8 MB')
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(null)).toBe('—')
  })
  test('daysLeft 按自然日算，不是按 86400 秒的整除', () => {
    // 今天 23 日 23:59，到期 24 日 00:01 —— 只差 2 分钟，但那是「明天」，应当是 1 天
    const now = new Date(2026, 7, 23, 23, 59)
    const exp = new Date(2026, 7, 24, 0, 1).getTime() / 1000
    expect(daysLeft(exp, now)).toBe(1)
  })
  test('daysLeft 已过期返回 0，不返回负数', () => {
    const now = new Date(2026, 7, 23)
    expect(daysLeft(new Date(2026, 7, 20).getTime() / 1000, now)).toBe(0)
  })
  test('fmtDay 中文写法', () => {
    expect(fmtDay(new Date(2026, 7, 21).getTime() / 1000)).toBe('8 月 21 日')
  })

  // ── 下面是简报之外补充的边界覆盖 ──

  test('fmtDuration 进位边界：59 秒 / 60 秒 / 3599 秒 / 3600 秒', () => {
    expect(fmtDuration(59)).toBe('59 秒') // 不足一分钟就报秒，不再截成 0
    expect(fmtDuration(60)).toBe('1 分 0 秒')
    expect(fmtDuration(3599)).toBe('59 分 59 秒') // 差 1 秒不到一小时，不进位
    // 满一小时之后丢掉秒：一场两小时的会议，末尾那 13 秒不是任何人要的信息
    expect(fmtDuration(3600)).toBe('1 小时 0 分')
    expect(fmtDuration(3613)).toBe('1 小时 0 分')
  })

  test('fmtBytes 量级切换边界：1023/1024 B，1048575/1048576 字节', () => {
    expect(fmtBytes(1023)).toBe('1023 B') // 差 1 字节不到 1 KB，不切单位
    expect(fmtBytes(1024)).toBe('1.00 KB')
    // 1048575 字节 = 1023.999... KB，四舍五入到三位有效数字会摸到 "1024 KB"
    // 这个数字上不成立的显示——必须再进一级到 MB，而不是原样打印。
    expect(fmtBytes(1048575)).toBe('1.00 MB')
    expect(fmtBytes(1048576)).toBe('1.00 MB')
  })

  test('daysLeft 跨零点边界：今天 23:59 到明天 00:01 只差 2 分钟，仍应算 1 天（而不是 0）', () => {
    // 复述简报里的关键场景，换一个不同的日界（8-23 → 8-24）避免和上面那条完全重复的输入
    const now = new Date(2026, 7, 23, 23, 59, 30)
    const exp = new Date(2026, 7, 24, 0, 0, 30).getTime() / 1000
    expect(daysLeft(exp, now)).toBe(1)
  })

  test('daysLeft 同一天内（还没跨零点）应为 0', () => {
    const now = new Date(2026, 7, 23, 8, 0)
    const exp = new Date(2026, 7, 23, 23, 59).getTime() / 1000
    expect(daysLeft(exp, now)).toBe(0)
  })
})

/**
 * `fmtClock` —— 播放位置 / 转写时间戳专用（F6 内容预览页）。
 *
 * 它与 `fmtDuration` 是两件事，不能互相顶替：`fmtDuration(65)` 是「1 分 5 秒」
 * （这场会议开了多久），而转写里第 65 秒那一段必须显示 `1:05`（走到哪一秒）。
 * 把时长格式套到时间戳上，点开的就是另一个位置。
 */
describe('fmtClock（播放位置 / 转写时间戳）', () => {
  test('一小时以内是 分:秒，秒补零、分不补', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(65)).toBe('1:05')
    expect(fmtClock(599)).toBe('9:59')
    expect(fmtClock(600)).toBe('10:00')
  })

  test('满一小时补出小时段，分秒都补零', () => {
    expect(fmtClock(3600)).toBe('1:00:00')
    expect(fmtClock(3661)).toBe('1:01:01')
    expect(fmtClock(36000)).toBe('10:00:00')
  })

  test('与 fmtDuration 不是一回事：同一个 65 秒，一个是时长一个是时间戳', () => {
    expect(fmtDuration(65)).toBe('1 分 5 秒')
    expect(fmtClock(65)).toBe('1:05')
  })

  test('小数按秒向下取整，负数夹到 0——播放位置不存在「负几秒」', () => {
    expect(fmtClock(65.9)).toBe('1:05')
    expect(fmtClock(-3)).toBe('0:00')
  })
})
