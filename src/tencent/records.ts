import type { Meeting, MeetingSelector, RecordState } from '../domain/types'
import { msToSec } from '../domain/time'
import type { TencentClient } from './client'
import { DEFAULT_WINDOW_SEC, splitWindows } from './window'

const PAGE_SIZE = 20 // 平台上限

export class MeetingNotFoundInRangeError extends Error {
  constructor(readonly identifier: string, readonly from: number, readonly to: number) {
    super(
      `meeting ${identifier} not found within [${from}, ${to}]. ` +
        'The meeting may exist outside this range — widen the time range and retry.',
    )
    this.name = 'MeetingNotFoundInRangeError'
  }
}

/**
 * `/v1/records` 的 `record_meetings[].record_files[]`。字段名以 M3.5 联调抓到的
 * 真实响应为准（2026-08-21）：record_file_id / record_start_time /
 * record_end_time / record_size / sharing_state / sharing_url /
 * required_same_corp / required_participant / sharing_expire / allow_download。
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

interface RawRecordMeeting {
  meeting_record_id: string
  meeting_id: string
  meeting_code: string
  host_user_id: string
  media_start_time: number
  subject: string
  state: number
  record_files?: RawRecordFile[]
}

interface RawListResponse {
  total_page?: number
  record_meetings?: RawRecordMeeting[]
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
function meetingEndTime(r: RawRecordMeeting): number {
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

export interface RecordsApi {
  listMeetings(selector: MeetingSelector, now: number): Promise<Meeting[]>
}

export function createRecordsApi(client: TencentClient, operatorId: string): RecordsApi {
  async function fetchWindow(
    from: number,
    to: number,
    extra: { meeting_id?: string; meeting_code?: string },
  ): Promise<Meeting[]> {
    const out: Meeting[] = []
    let page = 1
    let totalPage = 1

    do {
      const res = await client.get<RawListResponse>('/v1/records', {
        operator_id: operatorId,
        operator_id_type: 1,
        start_time: from,
        end_time: to,
        page,
        page_size: PAGE_SIZE,
        ...extra,
      })
      totalPage = res.total_page ?? 1
      for (const r of res.record_meetings ?? []) {
        out.push({
          meetingId: r.meeting_id,
          subMeetingId: '',
          meetingRecordId: r.meeting_record_id,
          meetingCode: r.meeting_code,
          subject: r.subject,
          hostUserId: r.host_user_id,
          startTime: msToSec(r.media_start_time),
          endTime: meetingEndTime(r),
          state: STATE_MAP[r.state] ?? 'recording',
        })
      }
      page++
    } while (page <= totalPage)

    return out
  }

  return {
    async listMeetings(selector, now) {
      // 平台要求 start_time / end_time 必填，不存在仅凭 ID 查询的路径。
      // 未指定时间时补默认窗口（最近 31 天，正好是单次查询上限）。
      const from = selector.kind === 'range' ? selector.from : (selector.from ?? now - DEFAULT_WINDOW_SEC)
      const to = selector.kind === 'range' ? selector.to : (selector.to ?? now)

      const extra =
        selector.kind === 'code'
          ? { meeting_code: selector.meetingCode }
          : selector.kind === 'id'
            ? { meeting_id: selector.meetingId }
            : {}

      const results: Meeting[] = []
      for (const w of splitWindows(from, to)) {
        results.push(...(await fetchWindow(w.from, w.to, extra)))
      }

      if (results.length === 0 && selector.kind !== 'range') {
        const id = selector.kind === 'code' ? selector.meetingCode : selector.meetingId
        throw new MeetingNotFoundInRangeError(id, from, to)
      }
      return results
    },
  }
}
