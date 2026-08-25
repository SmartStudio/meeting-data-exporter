const ILLEGAL = /[\\/:：*?"<>|]/g
/** 目录名：<date>_<hhmm>_<清洗主题>_<code>。非法字符→-，字素簇截断 60，空主题兜底 */
export function cleanDirName(date: string, hhmm: string, subject: string, code: string): string {
  let s = (subject ?? '').replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim()
  const graphemes = [...s]                          // 按码点近似字素簇，避免切断代理对
  if (graphemes.length > 60) s = graphemes.slice(0, 60).join('')
  if (s.length === 0) s = 'untitled'
  return `${date}_${hhmm}_${s}_${code}`
}

/** 拼会议目录名要用的那几个会议字段（`Meeting` 与 `meetingsForPaths()` 的值都满足它） */
export interface MeetingDirInfo {
  subject: string | null
  /** unix 秒；缺失按 0 处理，与既有落盘行为一致（会落进 1970/01 的目录） */
  startTime: number | null
  meetingCode: string | null
}

/**
 * 会议目录的相对路径 `<yyyy>/<mm>/<日期_时分_清洗主题_会议号>`（不含末尾斜杠）。
 *
 * 提取成函数不是为了少写两行：资产的落盘路径（executor 的 `buildRelPath`）与同目录下
 * 的 `meeting.json` / `_manifest.json` **必须落在同一个目录**，各算一遍迟早会分叉，
 * 分叉的结果是 sidecar 孤零零地待在一个没有资产的目录里——而它存在的全部意义就是
 * 描述它所在的那个目录。同一份逻辑两处实现正是这个仓库反复吃亏的地方
 * （见 docs/console/dev-plan.md §5 的 C7）。
 *
 * 时间一律按 **UTC** 拆解，与 `buildRelPath` 原有行为逐字保持一致。
 * `fallbackCode` 在会议号缺失时顶到目录名末尾，调用方传 meeting_id。
 */
export function meetingDirPath(m: MeetingDirInfo, fallbackCode: string): string {
  const d = new Date((m.startTime ?? 0) * 1000)
  const yyyy = String(d.getUTCFullYear()), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0')
  const hhmm = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0')
  const dir = cleanDirName(`${yyyy}-${mm}-${dd}`, hhmm, m.subject ?? '', m.meetingCode ?? fallbackCode)
  return `${yyyy}/${mm}/${dir}`
}
