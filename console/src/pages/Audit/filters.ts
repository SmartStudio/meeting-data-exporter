/**
 * 操作审计页的筛选条件：界面上的那几个控件 ↔ `GET /api/v1/admin/audit` 的查询参数。
 *
 * 拆成一个纯函数文件，是因为**这一层的每一条都是可以单独说对错的规则**
 * （「全部时间」该发什么、空集合该不该发、翻页该动哪个参数），
 * 混在组件里就只能靠点击一遍界面来验。
 *
 * ## 筛选一律走后端，前端不留内存版
 *
 * 原型（`gate-console.html` 的 `audVisible()`）在内存里对整张表做模糊搜索 +
 * 过滤 + 分页。那套在 mock 数据下成立，接真 API 之后不成立：一次请求只带回
 * 一页（默认 50 条），在这一页上再筛一次，得到的是「这 50 条里符合的」，
 * 而界面上写的是「共 N 条」。**翻到第二页就错，而且用户看不出来。**
 *
 * 所以这里只有后端真有的六个维度。原型那个「搜操作者 / 动作 / 会议号」的
 * 模糊搜索框没有对应参数，删掉了（记进任务报告，不在前端补）。
 */

import type { AuditFilter, AuditFilterActorKind } from '@/api/admin/audit'

/** 一天多少秒。时间一律是 unix **秒**，见 `api/admin/audit.ts` 的文件头。 */
const DAY_SEC = 86_400

/**
 * 时间范围预设。
 *
 * 全是**滚动窗口**（「近 24 小时」而不是「今天」）：原型那一档叫「今天」，
 * 但它比的是"距今第几天"，实际上就是滚动 24 小时。名字与算法对不上时，
 * 出问题的是凌晨——凌晨一点打开审计页，「今天」只剩一个小时的记录。
 *
 * `days === 0` 是「全部时间」，见 `toQuery` 里为什么它发 `from=0`。
 */
export interface AuditRange {
  id: string
  label: string
  days: number
}

export const AUDIT_RANGES: readonly AuditRange[] = [
  { id: 'd1', label: '近 24 小时', days: 1 },
  { id: 'd7', label: '近 7 天', days: 7 },
  { id: 'd30', label: '近 30 天', days: 30 },
  { id: 'd90', label: '近 90 天', days: 90 },
  { id: 'all', label: '全部时间', days: 0 },
]

export const AUDIT_DEFAULT_RANGE_ID = 'd7'

/** 认不出的 id 落回默认档，而不是抛错——范围记错了不该让整页打不开。 */
export function rangeOf(id: string): AuditRange {
  return (
    AUDIT_RANGES.find((r) => r.id === id) ??
    AUDIT_RANGES.find((r) => r.id === AUDIT_DEFAULT_RANGE_ID)!
  )
}

/** 界面上那几个控件的取值。 */
export interface AuditUiFilter {
  rangeId: string
  actorKinds: readonly AuditFilterActorKind[]
  onlyDenied: boolean
  /** 精确匹配的操作者 ID（不是模糊搜索）。 */
  actorId: string
  /** 动作原值，逗号分隔可给多个。 */
  action: string
  /** 1 起。 */
  page: number
  pageSize: number
}

/**
 * 默认每页 50 条 —— 与后端的 `AUDIT_DEFAULT_LIMIT` 同一个数，
 * 但这里仍然**显式发出去**：靠"不发就是 50"这条默契，后端改了默认值之后
 * 界面上的「每页 50」就会变成一句谎话。
 */
export const AUDIT_PAGE_SIZES: readonly number[] = [20, 50, 100, 200]

export const AUDIT_DEFAULT_UI: AuditUiFilter = {
  rangeId: AUDIT_DEFAULT_RANGE_ID,
  actorKinds: [],
  onlyDenied: false,
  actorId: '',
  action: '',
  page: 1,
  pageSize: 50,
}

/** 逗号分隔的多值参数：拆开、去空白、丢空段、去重。空集合返回 undefined。 */
function multi(raw: string): string[] | undefined {
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  ]
  // **空数组不能发**：后端把空集合当客户端错误（400 `empty_filter`），
  // 因为空集合在 SQL 里是「一条都不匹配」，而调用方的本意多半是「不筛选」。
  return values.length === 0 ? undefined : values
}

/**
 * 界面取值 → 请求参数。`nowSec` 是**这一次查询的时间锚点**，由页面冻住：
 * 每次渲染现取的话，翻页时下界会跟着往前挪，第 2 页与第 1 页看的不是同一段
 * 时间——中间那几条记录会从两页之间漏掉，而屏幕上看不出来。
 */
export function toQuery(ui: AuditUiFilter, nowSec: number): AuditFilter {
  const range = rangeOf(ui.rangeId)
  const q: AuditFilter = {
    // 「全部时间」发 `from=0` 而不是干脆不发：**不发的话后端会兜一个最近 7 天的
    // 默认窗口**（`AUDIT_DEFAULT_WINDOW_DAYS`），于是界面上写着"全部时间"、
    // 实际只查了一周。审计页最不能有的就是这种看不见的窗口——管理员找不到某条
    // 记录会读成"这件事没发生过"。
    from: range.days === 0 ? 0 : nowSec - range.days * DAY_SEC,
    limit: ui.pageSize,
    offset: (Math.max(1, ui.page) - 1) * ui.pageSize,
  }
  if (ui.actorKinds.length > 0) q.actorKind = [...ui.actorKinds]
  if (ui.onlyDenied) q.decision = 'deny'
  const actorId = ui.actorId.trim()
  if (actorId !== '') q.actorId = actorId
  const action = multi(ui.action)
  if (action !== undefined) q.action = action
  return q
}

/** 除时间范围之外还有没有别的筛选条件（决定空态给哪个出口）。 */
export function hasFieldFilters(ui: AuditUiFilter): boolean {
  return (
    ui.actorKinds.length > 0 ||
    ui.onlyDenied ||
    ui.actorId.trim() !== '' ||
    multi(ui.action) !== undefined
  )
}

/** 时间范围有没有把结果收窄（「全部时间」不算）。 */
export function hasRangeFilter(ui: AuditUiFilter): boolean {
  return rangeOf(ui.rangeId).days !== 0
}

/**
 * 空表是因为什么。**顺序就是因果的粗细**，粗的先答——
 * 否则会给出「清除筛选」这种解决不了问题的出口（spec.md §8）。
 */
export type AuditEmptyKind = 'none-at-all' | 'filtered-out' | 'out-of-range'

export function emptyKind(ui: AuditUiFilter): AuditEmptyKind {
  if (hasFieldFilters(ui)) return 'filtered-out'
  if (hasRangeFilter(ui)) return 'out-of-range'
  return 'none-at-all'
}
