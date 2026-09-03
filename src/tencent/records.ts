import type { Meeting, MeetingSelector, RecordState } from '../domain/types'
import { msToSec } from '../domain/time'
import type { TencentClient } from './client'
import { DEFAULT_WINDOW_SEC, splitWindows } from './window'

const PAGE_SIZE = 20 // 平台上限

/**
 * [获取账户级会议录制列表](https://cloud.tencent.com/document/product/1095/53224)——**企业维度**。
 *
 * **本网关向腾讯要会议列表的唯一接口。**
 *
 * 账户管理员专用，按企业维度返回全公司的录制，这才是「全公司会议持续归档」
 * （spec §1.2 · US-5.1）的数据来源。权限要求：录制管理的查看/编辑权限。
 *
 * ## `/v1/records` 去哪了（2026-08-27 删除）
 *
 * [查询会议录制列表](https://cloud.tencent.com/document/product/1095/51189)
 * （`GET /v1/records`）曾是精确查询（按 meeting_id / meeting_code 点名查）的路径，
 * 因为它是**唯一**带这两个查询参数的列表接口。它已被整条删除，理由是它做不到
 * 这个产品要的事，而留着它只会让代码里写着一条不成立的限制：
 *
 *   - 官方原话是「当会议 ID 和会议 code 均为空时，表示查询**用户**所有会议的
 *     录制列表」，参数表里**没有任何指定查谁的参数**——「查看企业录制」这类应用
 *     权限只决定**能不能调**，不决定**返回谁的**。
 *   - 2026-08-27 实测：用它拉最近 31 天，7 场会议的 host_user_id 全是同一个人，
 *     且正是 TM_OPERATOR_ID 本人。
 *   - 于是「范围查询走 corp、精确查询留在 /v1/records」的分流当场炸出一个 P0：
 *     corp 发现一场别人主持的会议 → 引擎回头精确查一次 → `/v1/records` 看不见它
 *     → MeetingNotFoundInRangeError → **整轮 worker 中止**。只要拉到任何一场
 *     别人主持的会议就必然发生。回归用例：tests/worker/exact-lookup.test.ts。
 *
 * 它能查到的会议是 corp 能查到的**真子集**（operator 自己主持的那些），所以删掉
 * 它不会少看见任何一场会议，只是省掉一条谁都不该走的路。
 *
 * ## 这个接口的三处硬差异（相对已删除的 `/v1/records`，逐条都咬过人）
 *
 *   1. 主持人字段叫 `userid`，**不是** `host_user_id`；
 *   2. `query_record_type` 默认 **1（只有云录制）**，不是 0（全部）；
 *   3. **没有** meeting_id / meeting_code 参数，无法做精确过滤 —— 精确查询因此
 *      变成「meeting_cache → 全窗口枚举 + 本地过滤」，见 `EXACT_LOOKUP_RESOLUTION_NOTE`。
 *
 * 另有 **10次/min** 的访问限制，节流在 tencent/client.ts 的 ENDPOINT_QUOTAS_PER_MINUTE。
 */
export const CORP_RECORDS_PATH = '/v1/corp/records'

/**
 * 精确查询（meeting_code / meeting_id）的**解析顺序**，会原样进错误提示。
 *
 * `/v1/corp/records` 没有精确过滤参数，所以「点名查一场会议」只能自己解析：
 *
 *   ① **先读 `meeting_cache`**（migrations/001，写入见下面的 `fetchWindow`）。
 *      命中即返回，**零 API 调用**。这一级是整条路径的成败所在，不是优化：
 *      worker 一轮里 discovery 已经把整窗口的会议全拉到手并写进了缓存，后续每
 *      一次 `listAssets` 的反查因此全部命中，corp 接口只被调用分页所需的那几次。
 *   ② 未命中 → **corp 全窗口枚举 + 本地过滤**，并把**整窗口**的会议写回缓存
 *      （不只是命中的那几场）——下一个人点名查同一窗口里的另一场时就不必再花
 *      一遍同样的配额。
 *   ③ 仍未命中 → 报错，且理由说清是「**这个时间窗里没有这场会议**」。
 *
 * 代价说在明处，**算清楚了写在这里**：缓存未命中的一次点名查询会退化成一次全窗口
 * 枚举。每页 20 条、零突发 10 次/min，所以每 20 场会议就要多等 6 秒——2026-08-27
 * 实测全公司 3 天有 229 场，一个 31 天的默认窗口按同样密度是两千场量级，
 * 折算下来**十几分钟**，比任何 HTTP 超时都长。
 *
 * 这是用户明确接受的代价，换来的是「按会议号也看得到别人主持的会议」（旧实现在
 * 这里是零调用，但看不见全公司 99% 的会议）。真正让它不痛的是**上面那一级**：
 * worker 每一轮都把整窗口的全公司会议写进 `meeting_cache`，所以正常运行的部署里
 * 这条退化路径几乎走不到。**它走到了，就说明缓存没被喂上**——那是该去查的事，
 * 不是该忍的慢。查询时带上尽量窄的 from/to 也能把窗口缩下来。
 */
const EXACT_LOOKUP_RESOLUTION_NOTE =
  'Lookup by meeting code/ID resolves in two steps: first the gateway\'s meeting_cache ' +
  '(filled by every listing that goes through this gateway), then a full enumeration of ' +
  `${CORP_RECORDS_PATH} over the same window with local filtering — that endpoint is ` +
  'account-level and returns meetings hosted by ANYONE in the company, so this is NOT a ' +
  'visibility limit: the recording simply has no media start time inside the window. ' +
  'Widen from/to and retry.'

export class MeetingNotFoundInRangeError extends Error {
  constructor(readonly identifier: string, readonly from: number, readonly to: number) {
    super(
      `meeting ${identifier} not found within [${from}, ${to}]. ` +
        EXACT_LOOKUP_RESOLUTION_NOTE,
    )
    this.name = 'MeetingNotFoundInRangeError'
  }
}

/**
 * 企业维度响应**没有** `userid` 字段（或不是字符串）时抛出：那是接口形状变了，
 * 错的是整批，整轮中止是对的。
 *
 * **字段在、值是空串不算**。2026-09-03 实测：设备账号发起的快速会议
 * （meeting_record_id=2095448286274887680，`userid` 与 `host_user_id` 都是 `""`）
 * 就是这样返回的，同一页其余 94 条都正常。那是一条会反复出现的正常数据，
 * 由 `toMeeting` 放行成「没有主持人」，不走这里。
 */
export class CorpRecordShapeError extends Error {
  constructor(readonly meetingRecordId: string, readonly field: string) {
    super(
      `${CORP_RECORDS_PATH} returned a record_meetings[] item without "${field}" ` +
        `(meeting_record_id=${meetingRecordId}). The wire shape does not match the documented ` +
        'one; refusing to emit a meeting with an unknown host rather than silently producing ' +
        'a dataset that policy rules would evaluate against a missing value.',
    )
    this.name = 'CorpRecordShapeError'
  }
}

/**
 * `record_meetings[].record_files[]`。字段名以 M3.5 联调抓到的真实响应为准
 * （2026-08-21）：record_file_id / record_start_time / record_end_time /
 * record_size / sharing_state / sharing_url / required_same_corp /
 * required_participant / sharing_expire / allow_download。
 *
 * 这里只声明本模块会用到的三个；其余字段由 catalog 经 `/v1/addresses` 获取。
 */
interface RawRecordFile {
  record_file_id?: string
  /** 毫秒时间戳 */
  record_start_time?: number
  /** 毫秒时间戳 */
  record_end_time?: number
}

/**
 * `/v1/corp/records` 的一条 `record_meetings[]`。
 *
 * 主持人在 `userid`，**不是** host_user_id——那是已删除的 `/v1/records` 的字段名。
 * 这里**只有一个** wire 类型是因为**只剩一个接口**，不是因为把两个合并了：
 * M3.5 栽过完全同一类的坑（`ae5d7c9`：asset_type 词汇表只有两项不同，故障伪装成
 * 「视频没产出」）。将来若再接入第二个列表接口，仍然要写第二个类型。
 */
interface RawCorpRecordMeeting {
  meeting_record_id: string
  meeting_id: string
  meeting_code: string
  media_start_time: number
  subject: string
  state: number
  record_files?: RawRecordFile[]
  /** 会议创建者的企业成员 id。**空串是合法值**：设备账号发起的会议没有成员身份 */
  userid?: string
}

interface RawListResponse<T> {
  total_page?: number
  record_meetings?: T[]
}

/**
 * 会议的录制结束时间。
 *
 * `record_meetings[]` 本身**没有**会议级结束时间字段（M3.5 联调对真实响应逐字
 * 核实的结果），但同一条响应里的 `record_files[]` 每个文件都带
 * `record_end_time`——取其最大值即整场录制的结束时刻，**无需额外 API 调用**。
 *
 * 为什么不能沿用 media_start_time 充当结束时间（原实现）：客户端用
 * `deadline_at = end_time + 每类资产的等待上限` 判断「延迟产出的资产等到什么
 * 时候放弃」。把开始时间当结束时间，等于把等待窗口凭空砍掉一整个会议时长——
 * 联调环境里实测有 112 分钟的会议，而视频/音频/转写的上限只有 6 小时，误差达
 * 31%。转码偏慢的录制会被提前判定 skip_timeout 而静默丢失。
 *
 * 没有 record_files（或字段缺失）时回退到 media_start_time：宁可保守，也不要
 * 因为缺字段而抛错中断整批会议的列举。
 */
function meetingEndTime(r: RawCorpRecordMeeting): number {
  let latestMs = 0
  for (const f of r.record_files ?? []) {
    if (typeof f.record_end_time === 'number' && f.record_end_time > latestMs) {
      latestMs = f.record_end_time
    }
  }
  return msToSec(latestMs > 0 ? latestMs : r.media_start_time)
}

const STATE_MAP: Record<number, RecordState> = {
  1: 'recording',
  2: 'transcoding',
  3: 'completed',
}

function toMeeting(r: RawCorpRecordMeeting): Meeting {
  // 主持人字段在这个接口里叫 userid。照搬 host_user_id 会让它静默变成 undefined，
  // 而 hostUserId 是策略引擎 host 条件的唯一输入——undefined 不会报错，只会让规则
  // 全部不匹配，整批会议悄悄变成「不可见」。所以**字段不存在**要整轮抛出。
  //
  // **字段存在但是空串**是另一回事：设备账号发起的快速会议就是这样返回的
  // （见 CorpRecordShapeError 的注释），错的只是这一条、而且它本来就没有主持人。
  // 这里曾把两者一起抛，结果一条正常数据让全公司的拉取整轮中止了三个小时
  // （2026-09-03 18:15 起连续 13 轮）。空串照原样放行：`hostUserId === ''` 的语义
  // 在 domain/types.ts 上写明，规则引擎的 host 条件对它一律不匹配（policy/conds.ts）。
  if (typeof r.userid !== 'string') {
    throw new CorpRecordShapeError(r.meeting_record_id, 'userid')
  }
  return {
    meetingId: r.meeting_id,
    subMeetingId: '',
    meetingRecordId: r.meeting_record_id,
    meetingCode: r.meeting_code,
    subject: r.subject,
    hostUserId: r.userid,
    startTime: msToSec(r.media_start_time),
    endTime: meetingEndTime(r),
    state: STATE_MAP[r.state] ?? 'recording',
  }
}

/**
 * 会议号的比对形态。
 *
 * 腾讯返回的 `meeting_code` 是纯数字串，而人手输入（`mde get --code`、控制台
 * 搜索框）常常带分隔符：`881-234-56`。过去这一步是**平台**做的——meeting_code
 * 是查询参数，匹配与否由腾讯说了算。改成本地过滤之后必须自己做，否则一个带
 * 横杠的会议号会一场都匹配不上，报出来的还是「这个时间窗里没有」这种误导性理由。
 *
 * 只去掉分隔符，不做别的归一：数字串之间不存在「差别只在分隔符」的两场会议，
 * 所以这条放宽不会引入错误匹配。
 */
function normalizeMeetingCode(code: string): string {
  const stripped = code.replace(/[\s-]/g, '')
  return stripped === '' ? code : stripped
}

/**
 * 精确查询要用到的 `meeting_cache` 视图。
 *
 * 声明在这里而不是从 `src/store/meetings.ts` import：本模块是腾讯边界，
 * 它需要的只是这三个动作，把整个 store 递进来会让它顺手够得着别的表
 * （与 `ArchiveDeps.getMeeting`、`FetchPolicyDeps.listFetchRules` 同一个先例）。
 * `MeetingCacheStore` 结构上满足它。
 */
export interface MeetingCacheLookup {
  listByMeetingId(meetingId: string, from?: number, to?: number): Promise<Meeting[]>
  listByMeetingCode(meetingCode: string, from?: number, to?: number): Promise<Meeting[]>
  upsertMany(meetings: readonly Meeting[], now: number): Promise<void>
}

/**
 * 纯粹的窗口枚举——`/v1/corp/records` 的直接包装，**不认识缓存**。
 *
 * 单独导出是给 `scripts/preflight.ts` 用的：它探的是「凭证、签名、账号权限对不对」，
 * 那时数据库连不连得上是另一项检查，不该被绑在一起。
 */
export interface CorpRecordsApi {
  /** 枚举 [from, to] 内全公司的录制。超过 31 天的区间自己切窗口，翻页也自己翻 */
  listRange(from: number, to: number): Promise<Meeting[]>
}

export function createCorpRecordsApi(client: TencentClient, operatorId: string): CorpRecordsApi {
  /** 翻页循环：page 从 1 起、total_page 收敛 */
  async function paginate(from: number, to: number): Promise<Meeting[]> {
    const out: Meeting[] = []
    let page = 1
    let totalPage = 1

    do {
      const res = await client.get<RawListResponse<RawCorpRecordMeeting>>(CORP_RECORDS_PATH, {
        operator_id: operatorId,
        operator_id_type: 1, // 该接口当前**仅支持 1**（userid）
        start_time: from,
        end_time: to,
        page,
        page_size: PAGE_SIZE,
        // **必须显式传 0。** 这个接口的 query_record_type 默认是 **1（只有云录制）**。
        // 不传就会静默漏掉上传录制（2）与客户端视频/音频录制（4/5）——表现是
        // 「有些会议就是没有录制」，而不是报错。
        query_record_type: 0,
      })
      totalPage = res.total_page ?? 1
      for (const r of res.record_meetings ?? []) out.push(toMeeting(r))
      page++
    } while (page <= totalPage)

    return out
  }

  return {
    async listRange(from, to) {
      const out: Meeting[] = []
      for (const w of splitWindows(from, to)) out.push(...(await paginate(w.from, w.to)))
      return out
    },
  }
}

export interface RecordsApi {
  listMeetings(selector: MeetingSelector, now: number): Promise<Meeting[]>
}

/**
 * 一次精确查询的三件事：报错时说谁、查缓存哪一列、本地比对哪个字段。
 *
 * 把它们绑在一起构造，是为了让「缓存那一路」和「回退那一路」不可能各按各的字段
 * 来——两路漂移不会报错，只会让某一种查法永远查不到。
 */
interface ExactLookup {
  /** 进错误提示的标识符：**用户给的原样**，不是归一之后的 */
  identifier: string
  fromCache(from?: number, to?: number): Promise<Meeting[]>
  matches(m: Meeting): boolean
}

function exactLookupOf(
  selector: Exclude<MeetingSelector, { kind: 'range' }>,
  cache: MeetingCacheLookup,
): ExactLookup {
  if (selector.kind === 'code') {
    const wanted = normalizeMeetingCode(selector.meetingCode)
    return {
      identifier: selector.meetingCode,
      fromCache: (from, to) => cache.listByMeetingCode(wanted, from, to),
      matches: (m) => normalizeMeetingCode(m.meetingCode) === wanted,
    }
  }
  const wanted = selector.meetingId
  return {
    identifier: wanted,
    fromCache: (from, to) => cache.listByMeetingId(wanted, from, to),
    matches: (m) => m.meetingId === wanted,
  }
}

/**
 * 网关（HTTP 与 worker 两个宿主）看会议的唯一出口。
 *
 * 范围查询直落 corp；精确查询按 `EXACT_LOOKUP_RESOLUTION_NOTE` 的三级顺序解析。
 * **两种查询都会把拿到的会议写进 `meeting_cache`**——写入点只有这一处，
 * 调用方不必（也不该）自己再 upsert 一遍。
 */
export function createRecordsApi(
  client: TencentClient,
  operatorId: string,
  cache: MeetingCacheLookup,
): RecordsApi {
  const corp = createCorpRecordsApi(client, operatorId)

  /** 拉一个窗口并写回缓存。精确查询与范围查询共用，保证两边写入的口径一致 */
  async function fetchWindow(from: number, to: number, now: number): Promise<Meeting[]> {
    const meetings = await corp.listRange(from, to)
    await cache.upsertMany(meetings, now)
    return meetings
  }

  return {
    async listMeetings(selector, now) {
      if (selector.kind === 'range') {
        return fetchWindow(selector.from, selector.to, now)
      }

      // ── 精确查询 ──────────────────────────────────────────────────────
      // 「按会议号查」与「按会议 ID 查」的差别只有两处：查缓存哪一列、本地比对哪个
      // 字段。收成一个 lookup 就不会出现「缓存按会议号查、回退按 ID 过滤」这种
      // 半边漂移——那种漂移不会报错，只会让某一路永远查不到。
      const exact = exactLookupOf(selector, cache)

      // ① 缓存。from/to 原样递下去——**缺哪一侧就不过滤哪一侧**，不在这里补默认窗口：
      //    引擎在 range 模式下调 listAssets 时 from/to 就是 undefined，而被发现的
      //    会议完全可能落在「最近 31 天」之外（补跑历史窗口）。补了默认值就会把
      //    这一轮刚刚发现的会议判成查不到，P0 换个姿势复活。
      const cached = await exact.fromCache(selector.from, selector.to)
      if (cached.length > 0) return cached

      // ② 回退：corp 全窗口枚举 + 本地过滤。这个接口要求 start_time / end_time
      //    必填，不存在仅凭 ID 查询的路径，所以这里才补默认窗口（最近 31 天，
      //    正好是单次查询上限）。
      const from = selector.from ?? now - DEFAULT_WINDOW_SEC
      const to = selector.to ?? now
      const hit = (await fetchWindow(from, to, now)).filter(exact.matches)

      // ③ 仍未命中。理由是「这个时间窗里没有」，不是「你看不见别人的会议」
      if (hit.length === 0) throw new MeetingNotFoundInRangeError(exact.identifier, from, to)
      return hit
    },
  }
}
