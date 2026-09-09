import { meetingDirPath, type MeetingDirInfo } from './filename'
import { meetingPathKey } from './types'

/**
 * 给一批录制记录算出各自的**目录序号**：同一 `meeting_id` 下、`meetingDirPath`
 * 算出同名目录的多条记录，按 `sub_meeting_id` 字符串升序编号（1、2、3…）。
 *
 * ## 为什么需要它
 *
 * 「各场次 start_time 不同，目录天然分开」这个假设实测不成立：腾讯常给同一场会议
 * **两条** `meeting_record_id`——正常录制，以及主题带「转写_」前缀的转写记录，
 * 两者 `media_start_time` 完全相同。本机库 294 场会议里有 84 组（168 条记录）落在
 * 同一 `(meeting_id, 起始分钟)`，其中 80 组是转写记录、4 组是同一分钟的两次正常
 * 录制。按录制记录拆成两场会议之后，它们的 `transcript.txt`、`meeting.json`、
 * `_manifest.json` 会互相覆盖，而且每一轮清单写入都在两份内容之间来回翻转。
 *
 * ## 编号规则的两条选择，都是为了「存量目录不改名」
 *
 * - **序号 1 不加后缀**（后缀由 `meetingDirPath` 拼，见那边）：绝大多数会议只有
 *   一条记录，它们的目录名一个字都不变。
 * - **空串排在最前**：空串是存量行的 `sub_meeting_id`（拆分之前只有一条记录的
 *   老库），字符串升序天然把它排到第一位，于是存量目录永远保住无后缀的那个名字。
 *   `meeting_record_id` 是时间序递增的，所以在新库里也是先出现的记录保住原名。
 *
 * ## 分组键为什么带 meeting_id
 *
 * 目录名里只有日期、时分、会议号，**两场不同的会议完全可能撞出同名目录**（同一
 * 分钟开始、会议号相同或都缺失）。序号是用来把「同一场会议的多条录制记录」分开的，
 * 拿它去分开两场真会议只会让其中一场莫名改名。分隔符用 NUL 而不是可打印字符，
 * 理由与 `meetingPathKey` 同一条：两段都是外部给的字符串，可打印分隔符会撞键。
 *
 * 纯函数，两个 Store 宿主（SQLite / MySQL）共用这一份实现——序号一旦两处各算一遍，
 * 同一场会议在两个宿主上会落进不同的目录。Task 5/6 的拆分脚本也必须用它。
 */
export function assignDirOrdinals<T extends MeetingDirInfo & { meetingId: string; subMeetingId: string }>(
  rows: readonly T[],
): Map<string, number> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    // fallbackCode 传 meetingId，与 executor / manifest 拼目录时同一口径：会议号缺失时
    // 顶上去的那个值也是目录名的一部分，分组必须看到与最终目录名一样的字符串
    const key = `${row.meetingId}\u0000${meetingDirPath(row, row.meetingId)}`
    const g = groups.get(key)
    if (g === undefined) groups.set(key, [row])
    else g.push(row)
  }
  const out = new Map<string, number>()
  for (const group of groups.values()) {
    // 字符串升序。不用 localeCompare：那是给人看的排序，会随 locale 变，而这个序号
    // 决定的是盘上的目录名——同一批数据在不同机器上必须给出同一个答案。
    group.sort((a, b) => (a.subMeetingId < b.subMeetingId ? -1 : a.subMeetingId > b.subMeetingId ? 1 : 0))
    group.forEach((row, i) => out.set(meetingPathKey(row.meetingId, row.subMeetingId), i + 1))
  }
  return out
}
