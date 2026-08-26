import { useMemo } from 'react'
import type { Triage } from '@/api/types'
import type { ServiceProgram } from '@/api/admin/grants'
import { listPrograms } from '@/api/admin/grants'
import type { AdminMeeting, MeetingPage, TriageBucket } from '@/api/admin/meetings'
import { fetchTriage, listMeetings } from '@/api/admin/meetings'
import { isProtoMode } from '@/app/proto'
import { useSystemState } from '@/app/SystemStatus'
import { useResource, type Resource } from '@/lib/useResource'

/**
 * 会议记录页的数据层。**接的是真 API**，三处形态差异按计划 §4.1 处理：
 *
 * 1. **分页在服务端**。`limit` / `offset` 由调用方给，`total` 由后端下发。
 * 2. **分诊五格走自己的端点**（`fetchTriage`），不从当页的行现算——现算会得到
 *    一个随翻页变化的"总数"，而这一排回答的是"全系统有什么需要处理"。
 * 3. **筛选在服务端**。后端支持的就是 `search` / `triage` / `hasGrant` /
 *    `hasOverride` / `inRetention` 五项，不多不少。**服务端不支持的筛选项
 *    不在这里补一个内存版本**——那样翻到第二页筛选就失效，而用户看不出来。
 *
 * ## 原型模式下的三个数据态
 *
 * `?proto=1` 的系统状态下拉要能一键复现 spec §8 的三个数据态。这三个态
 * **不需要任何假数据**——加载中是一个不 resolve 的 promise，加载失败是一个
 * 错误，空态是一页零行。所以它们在这里就地做掉，页面本身仍然只认真 API。
 * `ok` / `nas-down` / `tencent-down` 三态照常发真实请求（原型模式下由
 * `api/mock/install.ts` 那个假后端接住，见 `src/main.tsx`）。
 */

export interface MeetingsQuery {
  search: string
  triage: TriageBucket | null
  /** 三态：`undefined` = 不筛选。`false` 是"只要没有的那些"，不是"不筛" */
  hasGrant: boolean | undefined
  hasOverride: boolean | undefined
  inRetention: boolean | undefined
  /** 1 起算 */
  page: number
  pageSize: number
}

export const DEFAULT_QUERY: MeetingsQuery = {
  search: '',
  triage: null,
  hasGrant: undefined,
  hasOverride: undefined,
  inRetention: undefined,
  page: 1,
  pageSize: 10,
}

/** 原型模式「加载失败」用的错误。带上下文，不是裸 `new Error('failed')`。 */
function protoLoadError(): Error {
  return new Error(
    '原型模式：这是"加载失败"这一态的演示。真实环境里这里会是网关返回的错误，' +
      '例如 GET /api/v1/admin/meetings 返回 503。',
  )
}

type ProtoData = 'loading' | 'failed' | 'empty' | null

function protoDataState(state: string, proto: boolean): ProtoData {
  if (!proto) return null
  if (state === 'loading') return 'loading'
  if (state === 'load-failed') return 'failed'
  if (state === 'empty') return 'empty'
  return null
}

function protoFetcher<T>(kind: Exclude<ProtoData, null>, empty: T): () => Promise<T> {
  if (kind === 'loading') return () => new Promise<T>(() => {})
  if (kind === 'failed') return () => Promise.reject(protoLoadError())
  return () => Promise.resolve(empty)
}

const EMPTY_PAGE: MeetingPage = { rows: [], total: 0, limit: 0, offset: 0 }
const EMPTY_TRIAGE: Triage = {
  archiveFailed: 0,
  expiringIn7d: 0,
  awaitingGrant: 0,
  inProgress: 0,
  nasOnly: 0,
}

export interface MeetingsData {
  list: Resource<MeetingPage> & { retry: () => void }
  triage: Resource<Triage> & { retry: () => void }
  programs: Resource<ServiceProgram[]> & { retry: () => void }
}

/**
 * `nonce` 是重取的触发器：每次写操作成功之后 +1，三份数据一起重来。
 * 三份都要重来是刻意的——一次授权同时改变列表里的那一行**和**分诊条的
 * 「待授权」那一格，只重取列表会留下一个对不上的数字。
 */
export function useMeetingsData(query: MeetingsQuery, nonce: number): MeetingsData {
  const proto = useMemo(() => isProtoMode(), [])
  const { state } = useSystemState()
  const forced = protoDataState(state, proto)

  const { search, triage, hasGrant, hasOverride, inRetention, page, pageSize } = query
  const offset = (page - 1) * pageSize

  const list = useResource<MeetingPage>(
    forced !== null
      ? protoFetcher(forced, EMPTY_PAGE)
      : () =>
          listMeetings({
            search: search.trim() === '' ? undefined : search.trim(),
            triage: triage ?? undefined,
            hasGrant,
            hasOverride,
            inRetention,
            limit: pageSize,
            offset,
          }),
    [forced, search, triage, hasGrant, hasOverride, inRetention, pageSize, offset, nonce],
  )

  const triageRes = useResource<Triage>(
    forced !== null ? protoFetcher(forced, EMPTY_TRIAGE) : () => fetchTriage(),
    [forced, nonce],
  )

  // 采集程序列表跟着 nonce 走，但**不跟筛选走**：它与筛选无关，
  // 每改一次搜索词就重拉一遍是白发的请求。
  const programs = useResource<ServiceProgram[]>(
    forced !== null ? protoFetcher(forced, []) : () => listPrograms(),
    [forced, nonce],
  )

  return { list, triage: triageRes, programs }
}

/** 还没读到时的空列表。模块级常量，免得每次渲染换一个引用把下游 memo 全带失效。 */
export const NO_PROGRAMS: ServiceProgram[] = []
export const NO_ROWS: AdminMeeting[] = []
