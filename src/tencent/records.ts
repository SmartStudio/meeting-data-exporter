import type { Meeting, MeetingSelector, RecordState } from '../domain/types'
import { msToSec } from '../domain/time'
import type { TencentClient } from './client'
import { DEFAULT_WINDOW_SEC, splitWindows } from './window'

const PAGE_SIZE = 20 // 两个列表接口的平台上限都是 20

/**
 * [查询会议录制列表](https://cloud.tencent.com/document/product/1095/51189)——**用户维度**。
 *
 * 官方原话：「当会议 ID 和会议 code 均为空时，表示查询**用户**所有会议的录制列表」。
 * 它的参数表里**没有任何指定查谁的参数**（只有 operator_id / operator_id_type /
 * meeting_id / meeting_code / start_time / end_time / page / page_size /
 * media_set_type / query_record_type）——所以「查看企业录制」这类应用权限只决定
 * **能不能调**，不决定**返回谁的**。
 *
 * 2026-08-27 真实环境实测：用它拉最近 31 天，7 场会议的 host_user_id 全是同一个
 * 人，且正是 TM_OPERATOR_ID 本人。全公司归档拿它做数据源是不成立的。
 *
 * 保留它的唯一理由：它是**仅有的**支持 meeting_id / meeting_code 精确过滤的列表
 * 接口（见 CORP_RECORDS_PATH 的说明）。
 */
export const USER_RECORDS_PATH = '/v1/records'

/**
 * [获取账户级会议录制列表](https://cloud.tencent.com/document/product/1095/53224)——**企业维度**。
 *
 * 账户管理员专用，按企业维度返回全公司的录制，这才是「全公司会议持续归档」
 * （spec §1.2 · US-5.1）的数据来源。权限要求：录制管理的查看/编辑权限。
 *
 * 与 /v1/records 的三处硬差异，逐条都会咬人：
 *   1. 主持人字段叫 `userid`，**不是** `host_user_id`；
 *   2. `query_record_type` 默认 **1（只有云录制）**，不是 0（全部）；
 *   3. **没有** meeting_id / meeting_code 参数，无法做精确过滤。
 *
 * 另有 **10次/min** 的访问限制，节流在 tencent/client.ts 的 ENDPOINT_QUOTAS_PER_MINUTE。
 */
export const CORP_RECORDS_PATH = '/v1/corp/records'

/**
 * 精确查询（meeting_code / meeting_id）的**可见范围限制**，会原样进错误提示。
 *
 * 为什么不把精确查询也改成「拉全范围再本地过滤」：/v1/corp/records 每页 20 条、
 * 配额 10次/min，一次 31 天的全量枚举动辄几十次调用。把一次点名查询换成那个
 * 代价，`mde get --code` 会直接撞死配额。所以精确查询留在 /v1/records 上，
 * 代价是只看得到 operator 自己主持的会议——这个代价必须**说出来**，不能让
 * 使用者从一句笼统的「未找到」里去猜。
 */
const EXACT_LOOKUP_SCOPE_NOTE =
  `Note: lookup by meeting code/ID uses ${USER_RECORDS_PATH}, the only list endpoint that ` +
  'accepts meeting_id/meeting_code — and that endpoint returns ONLY meetings hosted by the ' +
  "gateway's own operator account (TM_OPERATOR_ID), regardless of the app's permissions. " +
  `A meeting hosted by someone else is invisible to it. Company-wide listing goes through ` +
  `${CORP_RECORDS_PATH} instead, which is used by range queries (from/to without ` +
  'meeting_code/meeting_id) — try a range query covering the meeting time.'

export class MeetingNotFoundInRangeError extends Error {
  constructor(readonly identifier: string, readonly from: number, readonly to: number) {
    super(
      `meeting ${identifier} not found within [${from}, ${to}]. ` +
        'The meeting may exist outside this range — widen the time range and retry. ' +
        EXACT_LOOKUP_SCOPE_NOTE,
    )
    this.name = 'MeetingNotFoundInRangeError'
  }
}

/** 企业维度响应缺主持人字段时抛出：不静默产出一场没有主持人的会议 */
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
 * 两个列表接口的 record_files[] 形状一致，故此类型共用。
 */
interface RawRecordFile {
  record_file_id?: string
  /** 毫秒时间戳 */
  record_start_time?: number
  /** 毫秒时间戳 */
  record_end_time?: number
}

/** 两个接口共有的部分——**不含主持人字段**，因为那正是二者不同的地方 */
interface RawMeetingCommon {
  meeting_record_id: string
  meeting_id: string
  meeting_code: string
  media_start_time: number
  subject: string
  state: number
  record_files?: RawRecordFile[]
}

/**
 * `/v1/records` 的条目：主持人在 `host_user_id`。
 *
 * **不要**把它和下面的 RawCorpRecordMeeting 合并成一个 interface 硬套两边。
 * M3.5 栽过完全同一类的坑（`ae5d7c9`：asset_type 词汇表只有两项不同，故障伪装
 * 成「视频没产出」）——两个接口的 wire 形状不同，就写两个类型。
 */
interface RawUserRecordMeeting extends RawMeetingCommon {
  host_user_id: string
}

/** `/v1/corp/records` 的条目：主持人在 `userid`（不是 host_user_id） */
interface RawCorpRecordMeeting extends RawMeetingCommon {
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
function meetingEndTime(r: RawMeetingCommon): number {
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

/** 两个接口的条目差异只在主持人字段，故主持人由调用方取好再传进来 */
function toMeeting(r: RawMeetingCommon, hostUserId: string): Meeting {
  return {
    meetingId: r.meeting_id,
    subMeetingId: '',
    meetingRecordId: r.meeting_record_id,
    meetingCode: r.meeting_code,
    subject: r.subject,
    hostUserId,
    startTime: msToSec(r.media_start_time),
    endTime: meetingEndTime(r),
    state: STATE_MAP[r.state] ?? 'recording',
  }
}

export interface RecordsApi {
  listMeetings(selector: MeetingSelector, now: number): Promise<Meeting[]>
}

export function createRecordsApi(client: TencentClient, operatorId: string): RecordsApi {
  /** 翻页循环：两个接口的分页形状一致（page 从 1 起、total_page 收敛） */
  async function paginate<T>(
    path: string,
    query: (page: number) => Record<string, string | number>,
    map: (row: T) => Meeting,
  ): Promise<Meeting[]> {
    const out: Meeting[] = []
    let page = 1
    let totalPage = 1

    do {
      const res = await client.get<RawListResponse<T>>(path, query(page))
      totalPage = res.total_page ?? 1
      for (const r of res.record_meetings ?? []) out.push(map(r))
      page++
    } while (page <= totalPage)

    return out
  }

  /**
   * 企业维度枚举（范围查询走这条）——全公司会议的数据来源。
   */
  function fetchCorpWindow(from: number, to: number): Promise<Meeting[]> {
    return paginate<RawCorpRecordMeeting>(
      CORP_RECORDS_PATH,
      (page) => ({
        operator_id: operatorId,
        operator_id_type: 1, // 该接口当前**仅支持 1**（userid）
        start_time: from,
        end_time: to,
        page,
        page_size: PAGE_SIZE,
        // **必须显式传 0。** 这个接口的 query_record_type 默认是 **1（只有云录制）**，
        // 与 /v1/records 的默认 0（全部）不同。不传就会静默漏掉上传录制（2）与
        // 客户端视频/音频录制（4/5）——表现是「有些会议就是没有录制」，而不是报错。
        query_record_type: 0,
      }),
      (r) => {
        // 主持人字段在这个接口里叫 userid。照搬 host_user_id 会让它静默变成
        // undefined，而 hostUserId 是策略引擎 host 条件的唯一输入——空值不会报错，
        // 只会让规则全部不匹配，整批会议悄悄变成「不可见」。
        if (typeof r.userid !== 'string' || r.userid === '') {
          throw new CorpRecordShapeError(r.meeting_record_id, 'userid')
        }
        return toMeeting(r, r.userid)
      },
    )
  }

  /**
   * 用户维度枚举（精确查询走这条）。
   *
   * 只看得到 operator 自己主持的会议——见 EXACT_LOOKUP_SCOPE_NOTE。
   */
  function fetchUserWindow(
    from: number,
    to: number,
    extra: { meeting_id?: string; meeting_code?: string },
  ): Promise<Meeting[]> {
    return paginate<RawUserRecordMeeting>(
      USER_RECORDS_PATH,
      (page) => ({
        operator_id: operatorId,
        operator_id_type: 1,
        start_time: from,
        end_time: to,
        page,
        page_size: PAGE_SIZE,
        ...extra,
      }),
      (r) => toMeeting(r, r.host_user_id),
    )
  }

  return {
    async listMeetings(selector, now) {
      // 两个接口都要求 start_time / end_time 必填，不存在仅凭 ID 查询的路径。
      // 未指定时间时补默认窗口（最近 31 天，正好是单次查询上限）。
      const from = selector.kind === 'range' ? selector.from : (selector.from ?? now - DEFAULT_WINDOW_SEC)
      const to = selector.kind === 'range' ? selector.to : (selector.to ?? now)

      // 走哪个接口按 selector 分流，这是本模块最要紧的一条分支：
      //   range → /v1/corp/records（企业维度，worker 主路径、产品核心）
      //   code / id → /v1/records（用户维度，只有它支持精确过滤）
      // 不把精确查询也改成「拉全范围再本地过滤」的理由见 EXACT_LOOKUP_SCOPE_NOTE。
      const extra =
        selector.kind === 'code'
          ? { meeting_code: selector.meetingCode }
          : selector.kind === 'id'
            ? { meeting_id: selector.meetingId }
            : null

      const results: Meeting[] = []
      for (const w of splitWindows(from, to)) {
        results.push(
          ...(extra === null
            ? await fetchCorpWindow(w.from, w.to)
            : await fetchUserWindow(w.from, w.to, extra)),
        )
      }

      if (results.length === 0 && selector.kind !== 'range') {
        const id = selector.kind === 'code' ? selector.meetingCode : selector.meetingId
        throw new MeetingNotFoundInRangeError(id, from, to)
      }
      return results
    },
  }
}
