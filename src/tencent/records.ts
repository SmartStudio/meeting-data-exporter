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

interface RawRecordMeeting {
  meeting_record_id: string
  meeting_id: string
  meeting_code: string
  host_user_id: string
  media_start_time: number
  subject: string
  state: number
}

interface RawListResponse {
  total_page?: number
  record_meetings?: RawRecordMeeting[]
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
          endTime: msToSec(r.media_start_time),
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
