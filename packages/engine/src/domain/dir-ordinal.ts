import { meetingDirPath, type MeetingDirInfo } from './filename'
import { meetingPathKey } from './types'

/**
 * 给一批录制记录算出各自的**目录序号**：同一 `meeting_id` 下、`meetingDirPath`
 * 算出同名目录的多条记录，按 `(created_at, sub_meeting_id)` 升序编号（1、2、3…）
 * ——`created_at`（首次发现时间）是主序，`sub_meeting_id` 只在同批发现时定次序。
 * 为什么不是单按 `sub_meeting_id`，见下面「不变量是『序号钉住不动』」。
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
 * ## 排序按 `(created_at, sub_meeting_id)`：不变量是「序号钉住不动」
 *
 * **只要没有行被删除，一行的序号永远不变，新来的取下一个号。** 这条不变量是这个
 * 函数的全部意义所在：序号决定盘上的目录名，而这个函数**每一轮都从头算一遍**，
 * 算出来的答案一旦会变，变的就是已经装着文件的目录的名字。
 *
 * 光按 `sub_meeting_id` 排做不到这一点，而且失效方式恰好就是本函数要防的那次碰撞：
 * 某场会议这一轮只有 `rec-5`（序号 1，资产落进无后缀的目录），下一轮上游补出一条
 * 更早的 `rec-3`——纯字符串序会把它排到前面，于是 `rec-5` 的目录当场改名：它已完成
 * 的资产留在旧目录里（`writeMeetingManifest` 从此判定「资产不在本目录」，一份清单
 * 都写不出来，旧目录里那份成了孤儿），未完成的落进 `_2`，而 `rec-3` 下载进那个已经
 * 装着 `rec-5` 文件的无后缀目录。同一场录制被劈成两个目录 + 两场会议共用一个目录。
 *
 * 所以主序是 `created_at`（**首次发现时间**：两个宿主的 `upsertMeeting` 在冲突时都
 * 不改这一列，只改 `updated_at`），`sub_meeting_id` 升序只做同批发现时的次序。
 * 于是：
 *
 * - **序号 1 不加后缀**（后缀由 `meetingDirPath` 拼，见那边）：绝大多数会议只有
 *   一条记录，它们的目录名一个字都不变。
 * - **存量行保住无后缀的目录**，靠的是「它已经在库里 = `created_at` 更早」这个事实，
 *   不是靠给空串 `sub_meeting_id` 开小灶。
 * - Task 5/6 的拆分脚本在一个事务里插进去的那批场次会拿到**同一个 `created_at`**，
 *   届时定序的是 `sub_meeting_id` 这一档——与脚本自己喂同一批行进来算出的答案一致。
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
export function assignDirOrdinals<T extends MeetingDirInfo & { meetingId: string; subMeetingId: string; createdAt: number }>(
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
    // 首次发现时间升序，同一批发现的再按 sub_meeting_id 字符串升序。
    // 不用 localeCompare 比字符串：那是给人看的排序，会随 locale 变，而这个序号决定
    // 的是盘上的目录名——同一批数据在不同机器上必须给出同一个答案。
    group.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt - b.createdAt
        : a.subMeetingId < b.subMeetingId ? -1 : a.subMeetingId > b.subMeetingId ? 1 : 0,
    )
    group.forEach((row, i) => out.set(meetingPathKey(row.meetingId, row.subMeetingId), i + 1))
  }
  return out
}
