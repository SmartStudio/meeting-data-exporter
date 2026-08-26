/**
 * 归档存储页（spec.md §4.9）的域文件——storage.ts 的四条端点。
 *
 * 权威是后端 `src/http/handlers/console/storage.ts`，字段名照它抄。
 * 类型定义在这里、不进 `api/types.ts`（计划 G-b）：它们只有这一页用得到。
 *
 * ## 三条这个域特有的规矩
 *
 * 1. **`nas.reachable === false` 仍然是 200。** 不可达本身是这一页要展示的
 *    内容，不是一次失败的请求。把它当错误处理，界面上就只剩一句"读取失败"，
 *    而管理员最需要看到的恰恰是"NAS 断了、还有几场没归档、到期清理停没停"。
 *
 * 2. **`null` 不许折成 `0`。** `totalBytes` / `availableBytes` 在探测失败时
 *    是 null，`failedMeetings` 在后端查不出来时也是。0 的意思是"确实没有"，
 *    null 的意思是"没查到"，两者在界面上必须分得开，所以解析层一个字都不替
 *    它们决定。
 *
 * 3. **写操作不做乐观更新**（计划 G-c）。这里只负责发请求、把后端的回显解析
 *    出来；页面拿到回显之后重新 `fetchStorage()`。`setCleanupPaused` 尤其
 *    如此——后端是写后重读，回的是库里此刻的真值，前端要照它更新而不是
 *    相信自己发出去的那个值。
 */

import { apiGet, apiSend } from '../client'
import { reader } from '../validate'

const BASE = '/api/v1/admin'

/* ── 类型 ───────────────────────────────────────────────────────── */

export interface NasArchive {
  /** 挂载点原值。**未配置 `MDE_NAS_ROOT` 时是 null**（装配处的 `nasRoot` 就是 `string | null`） */
  root: string | null
  /** false 时后端仍返回 200 —— 见文件头第 1 条 */
  reachable: boolean
  /** unix 秒 */
  checkedAt: number
  /** 探测耗时。后端恒有值（失败时是触发失败前实际耗掉的时间），仍按可空读 */
  latencyMs: number | null
  /** reachable=false 时的人类可读原因；可达时为 null */
  error: string | null
  /** statfs 的总容量 / 剩余。探测失败时为 null —— 不是 0 */
  totalBytes: number | null
  availableBytes: number | null
  /** **我们自己的记账**（archived_assets × 平台声明的字节数），不是 NAS 上的真实占用 */
  usedByUsBytes: number
  /** 总 - 剩余 - 本系统，后端已钳到 0；总/剩余任一为 null 时它也是 null */
  usedByOthersBytes: number | null
  archivedMeetings: number
  /**
   * 还有资产没进 `archived_assets` 的场次数。
   *
   * **它同时包含"还没轮到"和"一直归档不成功"两种**——两者在库里现在长得
   * 一模一样。所以界面上不能把它说成纯粹的"等待中"，也不能拿它顶替
   * `failedMeetings`。
   */
  pendingMeetings: number
  /**
   * 归档失败的场次数，来自 `job_failures` 里 `job_name = 'archive_nas'`
   * 的未解决行（A8 接上的，2026-08-26）。查不出来时是 null，不是 0。
   */
  failedMeetings: number | null
  /**
   * `failedMeetings` 为 null 的原因。
   *
   * A8 之前后端恒在这里塞一句"归档失败项尚未落库"——那句话在 T-A4 建了
   * `job_failures` 之后就不成立了，A8 已经把它删掉，所以现在正常是 null。
   * 留着这个字段是为了兼容还没升级的网关：**它非空的时候，页面显示这句话
   * 而不是显示一个数**。
   */
  failedMeetingsNote: string | null
}

/**
 * `default_retention_days` 这个配置的来源，也就是"页面上那个天数可不可信"。
 *
 * - `setting`：库里有合法配置
 * - `fallback`：没配过，归档流水线用内置默认 30
 * - `invalid`：配置值非法。此时 `defaultDays` 是 null、`defaultDaysRaw` 带着原始脏值
 *
 * 类型留成 `string` 而不是收窄的联合：后端将来多一种来源时，前端应当把它
 * 原样显示出来（"配置来源未知：xxx"），而不是因为不在枚举里就崩掉或者
 * 悄悄折成其中一种——那正是"静默放行"。
 */
export type RetentionDaysSource = string

export interface RetentionWindow {
  /** `defaultDaysSource === 'invalid'` 时是 null */
  defaultDays: number | null
  defaultDaysSource: RetentionDaysSource
  /** 库里那个原始字符串。没配过时是 null */
  defaultDaysRaw: string | null
  /** 到期清理是不是被暂停了。极性与 `worker/retention.ts` 一致：除非明确说没暂停，一律算暂停 */
  cleanupPaused: boolean
  /** 保留期内（本地文件还在）的场次 */
  liveMeetings: number
  /** 其中已授权给至少一个采集程序的 */
  grantedMeetings: number
  expiringIn7dMeetings: number
  /** 已到期但还没被清理掉的。「立即清理」动的就是这些 */
  expiredMeetings: number
  localBytes: number
}

export interface StorageInfo {
  nas: NasArchive
  retention: RetentionWindow
}

export interface RetentionDaysChange {
  defaultDays: number
  /** 旧值非法或没配过时是 null——"从多少改的"答不出来就说答不出来 */
  previousDefaultDays: number | null
}

export interface CleanupItem {
  meetingId: string
  subMeetingId: string
  /** 这场会议本轮会被删掉本地文件的资产数 */
  assetCount: number
  localBytes: number
}

export interface CleanupFailure {
  meetingId: string
  subMeetingId: string
  reason: string
}

/** dry-run 预览。只读，后端不记审计。 */
export interface CleanupPreview {
  dryRun: true
  cleanupPaused: boolean
  items: CleanupItem[]
  totalBytes: number
}

/** 真执行的结果。三个桶含义不同，不许合并成一个数字。 */
export interface CleanupExecuted {
  dryRun: false
  /** 本轮被暂停开关中止。**purged 未必为空**：已经删掉的不会因为随后按下暂停而收回 */
  paused: boolean
  purged: CleanupItem[]
  /** 哈希重新校验不一致 / NAS 侧读不到，本轮拒绝删除——需要人工介入 */
  verificationFailed: CleanupFailure[]
  /** 处理过程本身抛出而没跑完的。与上一桶是两层不同的容错 */
  failed: CleanupFailure[]
}

/* ── 校验 + 四条端点 ─────────────────────────────────────────────── */

function readCleanupItem(
  r: ReturnType<typeof reader>,
  raw: Record<string, unknown>,
  where: string,
): CleanupItem {
  return {
    meetingId: r.str(raw, 'meetingId', where),
    subMeetingId: r.str(raw, 'subMeetingId', where),
    assetCount: r.num(raw, 'assetCount', where),
    localBytes: r.num(raw, 'localBytes', where),
  }
}

function readFailures(
  r: ReturnType<typeof reader>,
  o: Record<string, unknown>,
  key: string,
): CleanupFailure[] {
  return r.objList(o, key, '').map((f, i) => ({
    meetingId: r.str(f, 'meetingId', `${key}[${i}]`),
    subMeetingId: r.str(f, 'subMeetingId', `${key}[${i}]`),
    reason: r.str(f, 'reason', `${key}[${i}]`),
  }))
}

/** `GET /api/v1/admin/storage`。NAS 状态 + 容量 + 保留窗口统计。 */
export async function fetchStorage(): Promise<StorageInfo> {
  const endpoint = `GET ${BASE}/storage`
  const raw = await apiGet<unknown>(`${BASE}/storage`)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  const nas = r.object(o.nas, 'nas')
  const ret = r.object(o.retention, 'retention')

  return {
    nas: {
      root: r.strOrNull(nas, 'root', 'nas'),
      reachable: r.bool(nas, 'reachable', 'nas'),
      checkedAt: r.num(nas, 'checkedAt', 'nas'),
      latencyMs: r.numOrNull(nas, 'latencyMs', 'nas'),
      error: r.strOrNull(nas, 'error', 'nas'),
      totalBytes: r.numOrNull(nas, 'totalBytes', 'nas'),
      availableBytes: r.numOrNull(nas, 'availableBytes', 'nas'),
      usedByUsBytes: r.num(nas, 'usedByUsBytes', 'nas'),
      usedByOthersBytes: r.numOrNull(nas, 'usedByOthersBytes', 'nas'),
      archivedMeetings: r.num(nas, 'archivedMeetings', 'nas'),
      pendingMeetings: r.num(nas, 'pendingMeetings', 'nas'),
      failedMeetings: r.numOrNull(nas, 'failedMeetings', 'nas'),
      // A8 接上 job_failures 之后这个字段会消失，那时它不是"缺字段"而是
      // "不再需要"——所以用 ?? null 收，不走校验器的必填分支。
      failedMeetingsNote:
        nas.failedMeetingsNote === undefined
          ? null
          : r.strOrNull(nas, 'failedMeetingsNote', 'nas'),
    },
    retention: {
      defaultDays: r.numOrNull(ret, 'defaultDays', 'retention'),
      defaultDaysSource: r.str(ret, 'defaultDaysSource', 'retention'),
      defaultDaysRaw: r.strOrNull(ret, 'defaultDaysRaw', 'retention'),
      cleanupPaused: r.bool(ret, 'cleanupPaused', 'retention'),
      liveMeetings: r.num(ret, 'liveMeetings', 'retention'),
      grantedMeetings: r.num(ret, 'grantedMeetings', 'retention'),
      expiringIn7dMeetings: r.num(ret, 'expiringIn7dMeetings', 'retention'),
      expiredMeetings: r.num(ret, 'expiredMeetings', 'retention'),
      localBytes: r.num(ret, 'localBytes', 'retention'),
    },
  }
}

/**
 * `POST /api/v1/admin/storage/retention-days`。合法区间 1..365，越界后端回
 * 400 `invalid_days` 并带上 min/max——那两个数进 `ApiError.body`，界面照它说话，
 * 不在前端另写一份区间。
 */
export async function setRetentionDays(days: number): Promise<RetentionDaysChange> {
  const endpoint = `POST ${BASE}/storage/retention-days`
  const raw = await apiSend<unknown>('POST', `${BASE}/storage/retention-days`, { days })
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    defaultDays: r.num(o, 'defaultDays', ''),
    previousDefaultDays: r.numOrNull(o, 'previousDefaultDays', ''),
  }
}

/**
 * `POST /api/v1/admin/storage/cleanup-pause`。**返回的是库里此刻的真值**
 * （后端写后重读），不是把 `paused` 抄回来。调用方必须用返回值更新界面。
 */
export async function setCleanupPaused(paused: boolean): Promise<boolean> {
  const endpoint = `POST ${BASE}/storage/cleanup-pause`
  const raw = await apiSend<unknown>('POST', `${BASE}/storage/cleanup-pause`, { paused })
  const r = reader(endpoint)
  return r.bool(r.object(raw, ''), 'cleanupPaused', '')
}

/**
 * `POST /api/v1/admin/storage/cleanup-now`，**不带 confirm** = dry-run 预览。
 * 这一步只读、不删、不记审计，正是二次确认框要列的内容。
 */
export async function previewCleanup(): Promise<CleanupPreview> {
  const endpoint = `POST ${BASE}/storage/cleanup-now`
  // 请求体整个不发：后端判的是 `body?.confirm !== true`，发 `{}` 也对，
  // 但"预览这次调用连一个 confirm 字段都没有"更难被误改成 true。
  const raw = await apiSend<unknown>('POST', `${BASE}/storage/cleanup-now`)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  const dryRun = r.bool(o, 'dryRun', '')
  if (!dryRun) r.fail('预览请求拿回了一个 dryRun:false 的响应——这次调用不该删任何文件', raw)
  return {
    dryRun: true,
    cleanupPaused: r.bool(o, 'cleanupPaused', ''),
    items: r.objList(o, 'items', '').map((it, i) => readCleanupItem(r, it, `items[${i}]`)),
    totalBytes: r.num(o, 'totalBytes', ''),
  }
}

/**
 * `POST /api/v1/admin/storage/cleanup-now`，**带 `confirm: true`** = 真删。
 * 不可逆：调用方必须先经过二次确认，且确认框里要说清删的是什么、留下的是什么。
 */
export async function runCleanup(): Promise<CleanupExecuted> {
  const endpoint = `POST ${BASE}/storage/cleanup-now`
  const raw = await apiSend<unknown>('POST', `${BASE}/storage/cleanup-now`, { confirm: true })
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    dryRun: false,
    paused: r.bool(o, 'paused', ''),
    purged: r.objList(o, 'purged', '').map((it, i) => readCleanupItem(r, it, `purged[${i}]`)),
    verificationFailed: readFailures(r, o, 'verificationFailed'),
    failed: readFailures(r, o, 'failed'),
  }
}

/* ── 导出可采集清单（spec §4.9 的第二个动作） ───────────────────── */

/**
 * 清单里的一行。**这是 `GET /api/v1/admin/meetings` 的一个很窄的切片**，
 * 不是那条端点的完整建模——完整建模归会议记录页（F2 独占 `api/admin/meetings.ts`）。
 *
 * 同一个理由让地基（F0）新建了 `api/admin/health.ts` 而不是往这个文件里写：
 * 并行的任务不该在别人的独占区里落笔。等 F2 合进来之后，这里可以改成
 * import 它的 `Meeting` 解析器，但**在那之前不要建那个文件**。
 */
export interface FetchableMeeting {
  meetingId: string
  subMeetingId: string
  title: string
  code: string
  host: string
  startAt: number
  /** 哪几列在库里是 NULL（title/code/host/startAt/endAt 的子集） */
  missing: string[]
  /** unix 秒。没有归档行时为 null（保留窗口还没开始计时） */
  expiresAt: number | null
  /** 已授权的采集程序 id */
  grants: string[]
  nasPath: string | null
  sizeBytes: number | null
  /** 判定理由的原文，由后端下发，前端不自己编 */
  allowWhy: string
}

export interface FetchableList {
  /** 判定为可采集（`allow === 'allow'`）的行 */
  rows: FetchableMeeting[]
  /** 后端报的"保留期内"的总数 */
  total: number
  /** 实际扫过多少行（过滤之前）。`scanned < total` 说明没扫全 */
  scanned: number
  /** 页数封顶导致没扫全。**导出时必须说出来**，不能给一份看起来完整的半份清单 */
  truncated: boolean
}

/** 单页上限，与后端 `MAX_LIMIT` 是同一个数（超了它直接 400，不静默钳制）。 */
const PAGE_SIZE = 500

/** 翻页次数上限。500 × 20 = 一万场会议，超过这个数得换一条导出端点，而不是翻更多页。 */
const MAX_PAGES = 20

function readFetchable(
  r: ReturnType<typeof reader>,
  row: Record<string, unknown>,
  where: string,
): { allow: string; row: FetchableMeeting } {
  const keep = r.object(row.keep, `${where}.keep`)
  const why = r.object(row.why, `${where}.why`)
  const allowWhy = r.object(why.allow, `${where}.why.allow`)
  return {
    allow: r.str(row, 'allow', where),
    row: {
      meetingId: r.str(row, 'meetingId', where),
      subMeetingId: r.str(row, 'subMeetingId', where),
      title: r.str(row, 'title', where),
      code: r.str(row, 'code', where),
      host: r.str(row, 'host', where),
      startAt: r.num(row, 'startAt', where),
      missing: r.strList(row, 'missing', where),
      expiresAt: r.numOrNull(keep, 'expiresAt', `${where}.keep`),
      grants: r.strList(row, 'grants', where),
      nasPath: r.strOrNull(row, 'nasPath', where),
      sizeBytes: r.numOrNull(row, 'sizeBytes', where),
      allowWhy: r.str(allowWhy, 'text', `${where}.why.allow`),
    },
  }
}

/**
 * 「导出可采集清单」的取数。
 *
 * 口径：**保留期内**（`inRetention=true`，判据是本地文件还在没有）且
 * **判定为可采集**（`allow === 'allow'`）。前一半在后端筛（有 SQL 判据），
 * 后一半只能在前端筛——那条端点没有按判定筛的参数。
 *
 * 翻页翻到 `total` 为止：只拿第一页就当成全部，会导出一份看起来完整的半份
 * 清单，而"清单上没有"与"这场会议不可采集"在使用它的人那里是同一个意思。
 */
export async function fetchFetchableMeetings(
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<FetchableList> {
  const pageSize = opts.pageSize ?? PAGE_SIZE
  const maxPages = opts.maxPages ?? MAX_PAGES
  const endpoint = `GET ${BASE}/meetings`
  const r = reader(endpoint)

  const rows: FetchableMeeting[] = []
  let scanned = 0
  let total = 0
  let pages = 0

  for (;;) {
    const raw = await apiGet<unknown>(`${BASE}/meetings`, {
      inRetention: 'true',
      limit: pageSize,
      offset: scanned,
    })
    const o = r.object(raw, '')
    const page = r.objList(o, 'rows', '')
    total = r.num(o, 'total', '')
    page.forEach((row, i) => {
      const parsed = readFetchable(r, row, `rows[${i}]`)
      if (parsed.allow === 'allow') rows.push(parsed.row)
    })
    scanned += page.length
    pages += 1

    if (page.length === 0) break
    if (scanned >= total) break
    if (pages >= maxPages) return { rows, total, scanned, truncated: true }
  }

  return { rows, total, scanned, truncated: scanned < total }
}
