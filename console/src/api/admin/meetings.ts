/**
 * 会议查询（A2 三条）+ 延长保留窗口 + 操作历史。
 *
 * 会议记录页是这个域唯一的消费者，所以类型定义在这里、从这里导出（计划 G-b）。
 * `api/types.ts` 里那份 `Meeting` 是 F1 按契约写的**展示形状**，本文件的
 * `AdminMeeting` 是**下发形状**：后端多带了四个事实字段（`meetingId` /
 * `subMeetingId` / `missing` / `unknownAssetTypes`）和 `keep` 的三个字段
 * （`extendedSource` / `extendedDays` / `retentionDays`），少一个前端就崩、
 * 多的不会。所以这里照下发形状建模，不去裁。
 *
 * ## 状态与理由**不收窄成联合**
 *
 * `fetch` / `archive` / `allow` / `why.by` 在这里都是 `string`。
 * 收窄成 TS 联合是自欺：`res.json()` 回来是 `any`，把一个认不出的取值
 * 断言成 `FetchState` 只是让编译器闭嘴，界面上得到的是一个 `switch` 落到
 * default 的分支——而默认分支通常写着「正常」。计划 §1 第 2 条要的是相反的：
 * **拿不到状态时显示「未知」，不许默认成「正常」**。所以原样带出来，
 * 由展示层（`pages/Meetings/display.ts`）把认不出的取值显式画成「未知」。
 *
 * ## 判定理由缺失是**显式取值**，不是抛错也不是空串
 *
 * `why` 的三段任何一段读不出来，都落到 `WHY_MISSING` 这个显式取值上
 * （`by: ''`），界面据此显示「理由缺失」。两个极端都不对：
 * - 抛错 → 一场会议的全部信息（状态、资产、NAS 路径）都跟着看不见了，
 *   而缺的只是一句解释；
 * - 空串 → 就是计划 §1 第 2 条明令禁止的「留空」，看起来像「本来就没有理由」。
 *
 * 其余必填字段（id / title / keep.* / nasPath …）缺了照常抛 `ApiShapeError`：
 * 那是结构性的错，页面显示错误态比显示一行半真半假的数据好。
 */

import type { Triage } from '../types'
import { apiGet, apiSend } from '../client'
import { reader } from '../validate'
// `unlabeledActions` 两条端点同形状，读法只有一份（在审计域里，那是它的出处）
import { readUnlabeledActions, type UnlabeledAction } from './audit'

const BASE = '/api/v1/admin'

/* ── 类型 ───────────────────────────────────────────────────────── */

/** 分诊条五格。同时是 `GET /meetings?triage=` 的取值（后端认不出就 400）。 */
export type TriageBucket = keyof Triage

export const TRIAGE_BUCKETS: readonly TriageBucket[] = [
  'archiveFailed',
  'expiringIn7d',
  'awaitingGrant',
  'inProgress',
  'nasOnly',
]

/** 判定理由。`by` 不收窄，理由见文件头。 */
export interface AdminWhy {
  by: string
  text: string
}

/**
 * 「这一段的判定理由读不出来」。`by` 用空串——它不可能与后端的任何一个
 * 合法取值撞上，展示层拿它当哨兵判「理由缺失」。
 */
export const WHY_MISSING: AdminWhy = { by: '', text: '' }

export interface AdminKeepWindow {
  /** unix 秒。归档成功的那一刻——保留窗口从这里起算，不是从会议日 */
  archivedAt: number | null
  /** unix 秒。**后端算好下发**，前端不许自己加天数 */
  expiresAt: number | null
  /** 被人工延长过几次。`extendedSource === 'floor'` 时它只是下界 */
  extended: number
  /** `extended` 这个数是哪来的，也就是它准不准：none / audit / floor */
  extendedSource: string
  /** 被人工延长的累计天数。这个字段永远准确——「延长了多少天」只看它 */
  extendedDays: number
  /** 这场会议的保留天数。没有归档行时为 null（窗口还没开始计时） */
  retentionDays: number | null
  /** 本地文件是否已被到期清理删掉（记录与 NAS 路径仍在） */
  filesGone: boolean
}

export interface AdminMeeting {
  /** 不透明行标识（`consoleMeetingId` 编的）。拼路径时要 `encodeURIComponent` */
  id: string
  /** 真实主键的两段。写操作要用它们定位（`?sub=`） */
  meetingId: string
  subMeetingId: string
  title: string
  code: string
  /** unix 秒。库里是 NULL 时为 0，`missing` 里会有 `'startAt'` */
  startAt: number
  durationSec: number
  /** **主持人的 userid，不是姓名**（企微通讯录未接） */
  host: string
  /**
   * 主持人的显示名。**查不到时是 `null`，而且这是常态**——身份映射表
   * （网关侧的 `identity_map`）在本部署里一行都没有。
   *
   * 所以「查不到」那条路径是唯一会跑到的路径，展示层必须把 `host` 降级成
   * 能区分行、又不会被误读成姓名的样子（见 `pages/Meetings/display.ts` 的
   * `hostView`）。把 `host` 原样摆上去是这个字段存在的原因。
   */
  hostName: string | null
  /** 哪几列在库里是 NULL。空数组 = 每一列都有真实值 */
  missing: string[]
  /** 各类资产已拿到 / 应有。不适用的类**不出现在对象里** */
  assets: Record<string, { got: number; total: number }>
  /** 认不出的 `asset_type`。不静默丢掉——它们确实占着 got/total */
  unknownAssetTypes: string[]
  fetch: string
  archive: string
  allow: string
  grants: string[]
  hand: string[]
  keep: AdminKeepWindow
  nasPath: string | null
  sizeBytes: number | null
  why: { fetch: AdminWhy; archive: AdminWhy; allow: AdminWhy }
  /** **只有详情端点会填**，列表端点恒为 `[]`（避免每页 N 次审计查询） */
  history: Array<{ at: number; text: string }>
}

/**
 * 列表查询。**只放后端真的支持的参数**——服务端不支持的筛选项不要在前端
 * 补一个内存版本：翻到第二页就失效，而且用户看不出来（计划 §4.1 第 3 条）。
 */
export interface MeetingListQuery {
  /** 模糊搜索标题 / 会议号 / 主持人 */
  search?: string
  /** 分诊五格之一。后端只收**一个**，不支持同时筛两格 */
  triage?: TriageBucket
  /** 三态：不给 = 不筛选。给 false 是「只要没有的那些」，不是「不筛」 */
  hasGrant?: boolean
  hasOverride?: boolean
  inRetention?: boolean
  /** 1..500，默认 50 */
  limit?: number
  /** ≥0，默认 0 */
  offset?: number
}

export interface MeetingPage {
  rows: AdminMeeting[]
  /** 符合筛选的**总数**。页数算它，不算当页行数 */
  total: number
  /** 后端回显的页大小与偏移——翻页的步长以它为准 */
  limit: number
  offset: number
}

/** 一场会议（或周期性会议的一个场次）的定位。空 `subMeetingId` = 主场次。 */
export interface MeetingRef {
  meetingId: string
  subMeetingId?: string
}

export interface ExtendResult {
  meetingId: string
  subMeetingId: string
  /** 这一次加了几天 */
  addedDays: number
  /** 累计延长了几天 */
  extendedDays: number
  archivedAt: number
  /** 新的到期时刻，**后端算的** */
  expiresAt: number
}

/**
 * 「延长 30 天」那个按钮加的天数。后端 `days` 缺省也是 30，且契约明写
 * **不跟随** `default_retention_days`——所以这里写死 30 是照契约，不是猜。
 */
export const EXTEND_DEFAULT_DAYS = 30

export interface MeetingHistoryRow {
  id: number
  /** unix 秒 */
  at: number
  /** 后端拼好的一句人话，抽屉直接渲染 */
  text: string
  /**
   * 动作的中文名。**没登记时是 null**，后端绝不回退成 snake_case 原值。
   *
   * 以前这里读成 `string` 且用 `r.str` 校验——契约从来就是 `string | null`，
   * 于是库里出现一个没登记标签的动作时，整段操作历史会打成一个形状错，
   * 而抽屉里显示的是「读取失败」。改成宽读（阶段 5 · F9）。
   */
  actionLabel: string | null
  /** allow / deny / null。着色看它——「被拒绝」要看得出来 */
  decision: string | null
  /** console / program / … 谁发起的 */
  clientKind: string | null
}

export interface MeetingHistory {
  /** 会议元数据。查不到时为 null，**仍是 200**——「记录还在不在」正是这条端点要回答的 */
  meeting: { id: string; title: string; code: string; startAt: number; source: string } | null
  rows: MeetingHistoryRow[]
  /** 这次查询的时间下界。`text` 非空时要显示出来：被截掉与本来就空不是一回事 */
  window: { since: number | null; sinceSource: string | null; text: string | null }
  /**
   * 这一段历史里后端没有登记中文标签的动作（阶段 5 · A9）。
   * 每行的 `text` 里已经带着「（未登记标签）」四个字，这里另给结构化的一份，
   * 好让抽屉汇总成一句提示。见 `api/admin/audit.ts` 的 `UnlabeledAction`。
   */
  unlabeledActions: UnlabeledAction[]
}

/* ── 校验 ───────────────────────────────────────────────────────── */

type R = ReturnType<typeof reader>

/**
 * 读一段判定理由。读不出来给 `WHY_MISSING`，**不抛**（见文件头）。
 * 这是本文件里唯一一处宽容，其余字段一律严格。
 */
function readWhy(raw: unknown, key: 'fetch' | 'archive' | 'allow'): AdminWhy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return WHY_MISSING
  const block = (raw as Record<string, unknown>)[key]
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return WHY_MISSING
  const o = block as Record<string, unknown>
  if (typeof o.by !== 'string' || typeof o.text !== 'string') return WHY_MISSING
  // by 是空串的话它会与 WHY_MISSING 撞上——后端不会下发空串，但真撞上时
  // 显示「理由缺失」比显示一个没有分类的理由更接近事实。
  return { by: o.by, text: o.text }
}

function readAssets(r: R, o: Record<string, unknown>, where: string): AdminMeeting['assets'] {
  const raw = r.object(o.assets, `${where}assets`)
  const out: AdminMeeting['assets'] = {}
  for (const [key, value] of Object.entries(raw)) {
    const cell = r.object(value, `${where}assets.${key}`)
    out[key] = {
      got: r.num(cell, 'got', `${where}assets.${key}`),
      total: r.num(cell, 'total', `${where}assets.${key}`),
    }
  }
  return out
}

function readKeep(r: R, o: Record<string, unknown>, where: string): AdminKeepWindow {
  const at = `${where}keep`
  const k = r.object(o.keep, at)
  return {
    archivedAt: r.numOrNull(k, 'archivedAt', at),
    expiresAt: r.numOrNull(k, 'expiresAt', at),
    extended: r.num(k, 'extended', at),
    extendedSource: r.str(k, 'extendedSource', at),
    extendedDays: r.num(k, 'extendedDays', at),
    retentionDays: r.numOrNull(k, 'retentionDays', at),
    filesGone: r.bool(k, 'filesGone', at),
  }
}

function readMeeting(r: R, raw: unknown, where: string): AdminMeeting {
  const o = r.object(raw, where === '' ? '' : where)
  // `where` 是路径前缀；拼子字段时要带一个点，根对象则不带。
  const p = where === '' ? '' : `${where}.`
  return {
    id: r.str(o, 'id', where),
    meetingId: r.str(o, 'meetingId', where),
    subMeetingId: r.str(o, 'subMeetingId', where),
    title: r.str(o, 'title', where),
    code: r.str(o, 'code', where),
    startAt: r.num(o, 'startAt', where),
    durationSec: r.num(o, 'durationSec', where),
    host: r.str(o, 'host', where),
    // **宽读**：字段缺席与 `null` 在这里是同一个意思——「没查到姓名」，
    // 展示层对两者走同一条降级路径。为它抛一个形状错，会让一整页会议
    // （状态、资产、NAS 路径）因为一个显示名读不出来而全部看不见。
    hostName: typeof o.hostName === 'string' && o.hostName !== '' ? o.hostName : null,
    missing: r.strList(o, 'missing', where),
    assets: readAssets(r, o, p),
    unknownAssetTypes: r.strList(o, 'unknownAssetTypes', where),
    fetch: r.str(o, 'fetch', where),
    archive: r.str(o, 'archive', where),
    allow: r.str(o, 'allow', where),
    grants: r.strList(o, 'grants', where),
    hand: r.strList(o, 'hand', where),
    keep: readKeep(r, o, p),
    nasPath: r.strOrNull(o, 'nasPath', where),
    sizeBytes: r.numOrNull(o, 'sizeBytes', where),
    why: {
      fetch: readWhy(o.why, 'fetch'),
      archive: readWhy(o.why, 'archive'),
      allow: readWhy(o.why, 'allow'),
    },
    history: r.objList(o, 'history', where).map((h, i) => ({
      at: r.num(h, 'at', `${p}history[${i}]`),
      text: r.str(h, 'text', `${p}history[${i}]`),
    })),
  }
}

/* ── 端点 ───────────────────────────────────────────────────────── */

/** `GET /api/v1/admin/meetings`。筛选与分页**全部在服务端**。 */
export async function listMeetings(query: MeetingListQuery): Promise<MeetingPage> {
  const endpoint = `GET ${BASE}/meetings`
  // 布尔要发成 'true' / 'false' 字面量；`undefined` 的键由 client 丢掉，
  // 也就是「不筛选」——**不要**在这里把它折成 false（那是「只要没有的那些」）。
  const raw = await apiGet<unknown>(`${BASE}/meetings`, {
    search: query.search,
    triage: query.triage,
    hasGrant: query.hasGrant === undefined ? undefined : String(query.hasGrant),
    hasOverride: query.hasOverride === undefined ? undefined : String(query.hasOverride),
    inRetention: query.inRetention === undefined ? undefined : String(query.inRetention),
    limit: query.limit,
    offset: query.offset,
  })
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    rows: r.objList(o, 'rows', '').map((row, i) => readMeeting(r, row, `rows[${i}]`)),
    total: r.num(o, 'total', ''),
    limit: r.num(o, 'limit', ''),
    offset: r.num(o, 'offset', ''),
  }
}

/**
 * `GET /api/v1/admin/meetings/triage`。
 *
 * **五格计数有自己的端点**，不能拿当页的行现算——那会得到一个随翻页变化的
 * 「总数」，而分诊条的产品职责恰恰是「全系统现在有什么需要处理」。
 */
export async function fetchTriage(): Promise<Triage> {
  const endpoint = `GET ${BASE}/meetings/triage`
  const raw = await apiGet<unknown>(`${BASE}/meetings/triage`)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    archiveFailed: r.num(o, 'archiveFailed', ''),
    expiringIn7d: r.num(o, 'expiringIn7d', ''),
    awaitingGrant: r.num(o, 'awaitingGrant', ''),
    inProgress: r.num(o, 'inProgress', ''),
    nasOnly: r.num(o, 'nasOnly', ''),
  }
}

/**
 * `GET /api/v1/admin/meetings/:meetingId`。详情抽屉用它，不复用列表里的那一行：
 * 后端的单场路径走 `explainMeetingAccess`，与采集程序真正取数时是同一段判定——
 * 「抽屉说准许、程序取的时候被拒」正是分开算会得到的结果。
 */
export async function getMeeting(id: string): Promise<AdminMeeting> {
  const endpoint = `GET ${BASE}/meetings/:meetingId`
  const raw = await apiGet<unknown>(`${BASE}/meetings/${encodeURIComponent(id)}`)
  return readMeeting(reader(endpoint), raw, '')
}

/**
 * `POST /api/v1/admin/meetings/:meetingId/extend`。
 *
 * 场次走**请求体**的 `subMeetingId`，不是 `?sub=`——这一条端点与 grants /
 * override 那几条的约定不一样，照契约来。
 */
export async function extendRetention(
  ref: MeetingRef,
  days: number = EXTEND_DEFAULT_DAYS,
): Promise<ExtendResult> {
  const endpoint = `POST ${BASE}/meetings/:meetingId/extend`
  const body: Record<string, unknown> = { days }
  const sub = ref.subMeetingId ?? ''
  if (sub !== '') body.subMeetingId = sub
  const raw = await apiSend<unknown>(
    'POST',
    `${BASE}/meetings/${encodeURIComponent(ref.meetingId)}/extend`,
    body,
  )
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    meetingId: r.str(o, 'meetingId', ''),
    subMeetingId: r.str(o, 'subMeetingId', ''),
    addedDays: r.num(o, 'addedDays', ''),
    extendedDays: r.num(o, 'extendedDays', ''),
    archivedAt: r.num(o, 'archivedAt', ''),
    expiresAt: r.num(o, 'expiresAt', ''),
  }
}

/** `GET /api/v1/admin/meetings/:meetingId/history`。抽屉底部那段操作历史。 */
export async function fetchMeetingHistory(id: string, limit?: number): Promise<MeetingHistory> {
  const endpoint = `GET ${BASE}/meetings/:meetingId/history`
  const raw = await apiGet<unknown>(
    `${BASE}/meetings/${encodeURIComponent(id)}/history`,
    limit === undefined ? undefined : { limit },
  )
  const r = reader(endpoint)
  const o = r.object(raw, '')
  const metaRaw = r.objOrNull(o, 'meeting', '')
  const win = r.object(o.window, 'window')
  return {
    meeting:
      metaRaw === null
        ? null
        : {
            id: r.str(metaRaw, 'id', 'meeting'),
            title: r.str(metaRaw, 'title', 'meeting'),
            code: r.str(metaRaw, 'code', 'meeting'),
            startAt: r.num(metaRaw, 'startAt', 'meeting'),
            source: r.str(metaRaw, 'source', 'meeting'),
          },
    rows: r.objList(o, 'rows', '').map((row, i) => {
      const where = `rows[${i}]`
      // `result` 是一个对象，但它的形状归审计域；这里只取着色要用的那一个字段，
      // 取不到就当「没有判定结果」，不因为一个可选字段把整段历史打红。
      const result = row.result
      const decision =
        result !== null && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>).decision
          : undefined
      return {
        id: r.num(row, 'id', where),
        at: r.num(row, 'at', where),
        text: r.str(row, 'text', where),
        // 契约是 `string | null`：没登记标签时后端给 null，**不回退成原值**
        actionLabel: r.strOrNull(row, 'actionLabel', where),
        decision: typeof decision === 'string' ? decision : null,
        clientKind: typeof row.clientKind === 'string' ? row.clientKind : null,
      }
    }),
    window: {
      since: r.numOrNull(win, 'since', 'window'),
      sinceSource: r.strOrNull(win, 'sinceSource', 'window'),
      text: r.strOrNull(win, 'text', 'window'),
    },
    unlabeledActions: readUnlabeledActions(r, o),
  }
}
