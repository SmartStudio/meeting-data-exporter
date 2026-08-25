const ILLEGAL = /[\\/:：*?"<>|]/g

/**
 * 把**会议主题这段自由文本**清洗成一个能当目录名用的片段：非法字符→`-`、
 * 连续空白折叠成一个空格、按字素簇截断到 60、空主题兜底 `untitled`。
 *
 * 从 `cleanDirName` 里提出来，**不是为了少写几行**：归档目录模板的 `{标题}`
 * 占位符（`src/policy/archive-dir.ts`）要的正是这一段，而 `cleanDirName` 把它和
 * `date_hhmm_主题_code` 那个完整格式焊在一起，NAS 侧用不上。在那边另写一份清洗，
 * 两份迟早漂移，漂移的后果是**同一场会议在本地归档区与 NAS 上目录名不同**——
 * 而人正是靠这个名字在两处对上同一场会议的。同一份逻辑两处实现是这个仓库反复
 * 吃亏的地方（docs/console/dev-plan.md §5 的 C7）。
 *
 * 截断放在**替换之后**：非法字符替换是一对一的，不改变字素数，两种顺序结果相同；
 * 但空白折叠会缩短字符串，必须先折叠再数，否则 60 这个上限会被空白吃掉。
 * 这个顺序是 `cleanDirName` 原有的，提取时逐字保留——它的既有用例就是证据。
 */
export function cleanSubjectSegment(subject: string): string {
  let s = (subject ?? '').replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim()
  const graphemes = [...s]                          // 按码点近似字素簇，避免切断代理对
  if (graphemes.length > 60) s = graphemes.slice(0, 60).join('')
  if (s.length === 0) s = 'untitled'
  return s
}

/** 目录名：<date>_<hhmm>_<清洗主题>_<code>。清洗见 cleanSubjectSegment */
export function cleanDirName(date: string, hhmm: string, subject: string, code: string): string {
  return `${date}_${hhmm}_${cleanSubjectSegment(subject)}_${code}`
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
