import { TRIAGE_BUCKETS, type TriageBucket } from '@/api/admin/meetings'
import { DEFAULT_QUERY, type MeetingsQuery } from './useMeetings'

/**
 * 会议记录页的查询条件（页码、页大小、搜索词、分诊格、三个三态筛选）与 URL
 * 查询串之间的换算。
 *
 * ## 为什么要进 URL
 *
 * 这些条件曾经只活在组件 state 里。从列表点标题进「内容预览」是换路由，列表
 * 组件被卸载，state 随之丢掉；预览页的「返回会议列表」又写死 `/meetings`——
 * 于是翻到第 7 页、筛了「待授权」、再点开一场会议看完回来，一切归零回第一页。
 * 条件进了 URL 之后，`/meetings?page=7&triage=awaitingGrant` 本身就是那一页，
 * 预览页只要回到来时的地址（`location.state.from`），浏览器的后退、刷新、
 * 复制链接给同事也都落在同一页上。
 *
 * ## 写法约定
 *
 * - **只写非默认值**：`/meetings` 就是默认查询，别把 `?page=1&size=10` 挂在
 *   每一条地址上。等价的查询序列化出来是同一个字符串（`serializeQuery` 的
 *   输出用来判断「要不要真的改地址」——改了地址就会重取列表，同样的条件不该
 *   重取）。
 * - **认不出的值当没有**：`?page=abc`、`?triage=whatever` 回落到默认，不报错。
 *   地址是人会手改的东西，读法要宽。
 * - 三态筛选（`hasGrant` 等）只有 `1` / `0` 两个字面值；缺省 = 不筛。
 */

const KEYS = {
  search: 'q',
  triage: 'triage',
  hasGrant: 'grant',
  hasOverride: 'override',
  inRetention: 'retention',
  page: 'page',
  pageSize: 'size',
} as const

function readTriage(v: string | null): TriageBucket | null {
  return v !== null && (TRIAGE_BUCKETS as readonly string[]).includes(v) ? (v as TriageBucket) : null
}

function readTristate(v: string | null): boolean | undefined {
  if (v === '1') return true
  if (v === '0') return false
  return undefined
}

/** 正整数；其他一律回落到 `fallback` */
function readPositiveInt(v: string | null, fallback: number): number {
  if (v === null) return fallback
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

export function parseQuery(params: URLSearchParams): MeetingsQuery {
  return {
    search: params.get(KEYS.search) ?? DEFAULT_QUERY.search,
    triage: readTriage(params.get(KEYS.triage)),
    hasGrant: readTristate(params.get(KEYS.hasGrant)),
    hasOverride: readTristate(params.get(KEYS.hasOverride)),
    inRetention: readTristate(params.get(KEYS.inRetention)),
    page: readPositiveInt(params.get(KEYS.page), DEFAULT_QUERY.page),
    pageSize: readPositiveInt(params.get(KEYS.pageSize), DEFAULT_QUERY.pageSize),
  }
}

function writeTristate(params: URLSearchParams, key: string, v: boolean | undefined): void {
  if (v === true) params.set(key, '1')
  else if (v === false) params.set(key, '0')
}

export function serializeQuery(q: MeetingsQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (q.search !== DEFAULT_QUERY.search) params.set(KEYS.search, q.search)
  if (q.triage !== null) params.set(KEYS.triage, q.triage)
  writeTristate(params, KEYS.hasGrant, q.hasGrant)
  writeTristate(params, KEYS.hasOverride, q.hasOverride)
  writeTristate(params, KEYS.inRetention, q.inRetention)
  if (q.page !== DEFAULT_QUERY.page) params.set(KEYS.page, String(q.page))
  if (q.pageSize !== DEFAULT_QUERY.pageSize) params.set(KEYS.pageSize, String(q.pageSize))
  return params
}
