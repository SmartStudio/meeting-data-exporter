import type { RowDataPacket } from 'mysql2'
import type { Pool } from './db'
import type { Meeting, RecordState } from '../domain/types'

/**
 * assetId 格式为 <meetingRecordId>:<recordFileId>:<assetType>:<index>，自包含
 * meetingRecordId 足以解析下载地址（见 catalog/index.ts），但不含 meeting_id /
 * host_user_id / start_time 等策略判定（policyEngine.decide）所需的会议属性——
 * 而这些属性只能来自 GET /v1/records（按 meeting_id 或时间窗口查询），该接口不支持
 * 按 meeting_record_id 反查。
 *
 * 因此 download-url 端点若要在签发前对着真实的 Meeting 做策略校验（而不是信任
 * 客户端传来的任何数据），必须能仅凭 meetingRecordId 重建出完整 Meeting。本表
 * 就是为此设计的：每次成功列出会议（GET /meetings、/meetings/:id、
 * /meetings/:id/assets）时机会性地把结果写入这里；download-url 端点据此查找。
 *
 * 表存于共享 MySQL，多实例部署下安全（不依赖任何进程内缓存）。缓存未命中一律
 * 按拒绝处理（403），不放行也不返回 404——网关无法判断该 meetingRecordId
 * 究竟是伪造的还是"真实存在但尚未被任何人列出过"，两种情况都不应向调用方
 * 泄露区别。
 */
export interface MeetingCacheStore {
  upsert(meeting: Meeting, now: number): Promise<void>
  getByRecordId(meetingRecordId: string): Promise<Meeting | null>
}

interface MeetingCacheRow extends RowDataPacket {
  meeting_record_id: string
  meeting_id: string
  sub_meeting_id: string
  meeting_code: string
  subject: string
  host_user_id: string
  start_time: number
  end_time: number
  state: string
}

const RECORD_STATES: readonly RecordState[] = ['recording', 'transcoding', 'completed']

function toRecordState(v: string): RecordState {
  return (RECORD_STATES as readonly string[]).includes(v) ? (v as RecordState) : 'recording'
}

export function createMeetingCacheStore(pool: Pool): MeetingCacheStore {
  return {
    async upsert(meeting, now) {
      await pool.execute(
        `INSERT INTO meeting_cache
           (meeting_record_id, meeting_id, sub_meeting_id, meeting_code, subject,
            host_user_id, start_time, end_time, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           meeting_id = VALUES(meeting_id),
           sub_meeting_id = VALUES(sub_meeting_id),
           meeting_code = VALUES(meeting_code),
           subject = VALUES(subject),
           host_user_id = VALUES(host_user_id),
           start_time = VALUES(start_time),
           end_time = VALUES(end_time),
           state = VALUES(state),
           updated_at = VALUES(updated_at)`,
        [
          meeting.meetingRecordId,
          meeting.meetingId,
          meeting.subMeetingId,
          meeting.meetingCode,
          meeting.subject,
          meeting.hostUserId,
          meeting.startTime,
          meeting.endTime,
          meeting.state,
          now,
        ],
      )
    },

    async getByRecordId(meetingRecordId) {
      const [rows] = await pool.execute<MeetingCacheRow[]>(
        `SELECT meeting_record_id, meeting_id, sub_meeting_id, meeting_code, subject,
                host_user_id, start_time, end_time, state
           FROM meeting_cache
          WHERE meeting_record_id = ?`,
        [meetingRecordId],
      )
      const r = rows[0]
      if (!r) return null
      return {
        meetingRecordId: r.meeting_record_id,
        meetingId: r.meeting_id,
        subMeetingId: r.sub_meeting_id,
        meetingCode: r.meeting_code,
        subject: r.subject,
        hostUserId: r.host_user_id,
        startTime: Number(r.start_time),
        endTime: Number(r.end_time),
        state: toRecordState(r.state),
      }
    },
  }
}
