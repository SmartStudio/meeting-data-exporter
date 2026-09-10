import type { RowDataPacket } from 'mysql2'
import type { Pool } from './db'
import type { Meeting, RecordState } from '../domain/types'

/**
 * 会议元数据缓存。**两个读者，一条写入路径。**
 *
 * ## 写入
 *
 * 只有 `src/tencent/records.ts` 写它：每一次向 `/v1/corp/records` 拿到会议
 * （范围查询、以及精确查询未命中时的回退枚举）都把整窗口的结果 `upsertMany` 进来。
 * HTTP 处理器不再各写各的——写入点散开就必然漂移，而下面两个读者都押在
 * 「列过的会议一定在表里」这个前提上。
 *
 * ## 读者一：download-url 端点，凭 meetingRecordId 重建 Meeting
 *
 * assetId 格式为 `<meetingRecordId>:<recordFileId>:<assetType>:<selector>`，自包含
 * meetingRecordId 足以解析下载地址（见 catalog/index.ts），但不含 meeting_id /
 * host_user_id / start_time 等策略判定（`policy/access.ts` 的 `AccessGate.decide`）
 * 所需的会议属性——而 `/v1/corp/records` **不支持按 meeting_record_id 反查**。
 * 所以 download-url 端点若要在签发前对着真实的 Meeting 做策略校验（而不是信任
 * 客户端传来的任何数据），只能靠本表。
 *
 * 缓存未命中一律按拒绝处理（403），不放行也不返回 404——网关无法判断该
 * meetingRecordId 究竟是伪造的还是「真实存在但尚未被任何人列出过」，两种情况都
 * 不应向调用方泄露区别。
 *
 * ## 读者二：精确查询（按会议号 / 会议 ID 点名查）的第一级
 *
 * 2026-08-27 之后加的（P0 修复）。`/v1/corp/records` 是全公司唯一的会议列表来源，
 * 但它**没有** meeting_id / meeting_code 参数，且有 10 次/min 的配额。所以
 * 「点名查一场会议」的解析顺序是：本表 → corp 全窗口枚举 + 本地过滤 → 报错。
 * 完整论证见 `src/tencent/records.ts` 的 `EXACT_LOOKUP_RESOLUTION_NOTE`。
 *
 * 靠这一级，worker 一轮里 discovery 拉到的会议直接喂饱后续每一次 `listAssets`
 * 的反查，corp 接口只被调用分页所需的那几次。
 *
 * 表存于共享 MySQL，多实例部署下安全（不依赖任何进程内缓存）。
 */
export interface MeetingCacheStore {
  /**
   * 整批写入。**没有单条版本**：唯一的调用方是「拿到一窗口 corp 结果」那一刻，
   * 一场一条 SQL 会让一轮 discovery（实测 229 场）打出 229 次往返。
   */
  upsertMany(meetings: readonly Meeting[], now: number): Promise<void>
  getByRecordId(meetingRecordId: string): Promise<Meeting | null>
  /**
   * 同一个 meeting_id 可能对应多行——周期性会议的多次实例复用同一 meeting_id。
   * **全部返回**，择一是调用方的事（worker 要全归档，HTTP 详情页取最新一条）。
   *
   * `from` / `to` 按 `start_time` 过滤，且**只作用在给出来的那一侧边界上**：
   * 两侧都不给就是「不限时间」。引擎在 range 模式下调 `listAssets` 时 from/to
   * 正是 undefined（packages/engine/src/discovery/index.ts），而被发现的会议
   * 完全可能落在默认 31 天窗口之外（补跑历史窗口）——那时套一个默认窗口
   * 会把刚刚才发现的会议判成「查不到」。
   */
  listByMeetingId(meetingId: string, from?: number, to?: number): Promise<Meeting[]>
  /** 同 `listByMeetingId`，按会议号。会议号的分隔符归一由调用方负责（见 records.ts） */
  listByMeetingCode(meetingCode: string, from?: number, to?: number): Promise<Meeting[]>
}

interface MeetingCacheRow extends RowDataPacket {
  meeting_record_id: string
  meeting_id: string
  sub_meeting_id: string
  meeting_code: string
  subject: string
  record_type: number
  host_user_id: string
  start_time: number
  end_time: number
  state: string
}

const RECORD_STATES: readonly RecordState[] = ['recording', 'transcoding', 'completed']

function toRecordState(v: string): RecordState {
  return (RECORD_STATES as readonly string[]).includes(v) ? (v as RecordState) : 'recording'
}

const SELECT_COLUMNS =
  `meeting_record_id, meeting_id, sub_meeting_id, meeting_code, subject, record_type,
   host_user_id, start_time, end_time, state`

const INSERT_COLUMNS =
  `(meeting_record_id, meeting_id, sub_meeting_id, meeting_code, subject, record_type,
    host_user_id, start_time, end_time, state, updated_at)`

const ON_DUPLICATE =
  `ON DUPLICATE KEY UPDATE
     meeting_id = VALUES(meeting_id),
     sub_meeting_id = VALUES(sub_meeting_id),
     meeting_code = VALUES(meeting_code),
     subject = VALUES(subject),
     record_type = VALUES(record_type),
     host_user_id = VALUES(host_user_id),
     start_time = VALUES(start_time),
     end_time = VALUES(end_time),
     state = VALUES(state),
     updated_at = VALUES(updated_at)`

/**
 * 一条语句最多写多少行。
 *
 * 每行 11 个占位符，200 行 = 2200 个，离 MySQL 的 65535 上限还很远；分块是为了
 * 别把单条语句撑到 max_allowed_packet 的量级（subject 是 VARCHAR(512)）。
 */
const UPSERT_CHUNK = 200

function rowValues(m: Meeting, now: number): (string | number)[] {
  return [
    m.meetingRecordId,
    m.meetingId,
    m.subMeetingId,
    m.meetingCode,
    m.subject,
    m.recordType,
    m.hostUserId,
    m.startTime,
    m.endTime,
    m.state,
    now,
  ]
}

function toMeeting(r: MeetingCacheRow): Meeting {
  return {
    meetingRecordId: r.meeting_record_id,
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    meetingCode: r.meeting_code,
    subject: r.subject,
    recordType: Number(r.record_type),
    hostUserId: r.host_user_id,
    startTime: Number(r.start_time),
    endTime: Number(r.end_time),
    state: toRecordState(r.state),
  }
}

/**
 * `from` / `to` 拼进 WHERE。缺哪一侧就不拼哪一侧——不是补一个默认值，
 * 见 `MeetingCacheStore.listByMeetingId` 的注释。
 */
function timeBounds(from?: number, to?: number): { sql: string; params: number[] } {
  const sql: string[] = []
  const params: number[] = []
  if (from !== undefined) {
    sql.push('AND start_time >= ?')
    params.push(from)
  }
  if (to !== undefined) {
    sql.push('AND start_time <= ?')
    params.push(to)
  }
  return { sql: sql.join(' '), params }
}

export function createMeetingCacheStore(pool: Pool): MeetingCacheStore {
  async function listBy(
    column: 'meeting_id' | 'meeting_code',
    value: string,
    from?: number,
    to?: number,
  ): Promise<Meeting[]> {
    const bounds = timeBounds(from, to)
    const [rows] = await pool.query<MeetingCacheRow[]>(
      `SELECT ${SELECT_COLUMNS}
         FROM meeting_cache
        WHERE ${column} = ? ${bounds.sql}
        ORDER BY start_time DESC, meeting_record_id ASC`,
      [value, ...bounds.params],
    )
    return rows.map(toMeeting)
  }

  return {
    async upsertMany(meetings, now) {
      // 同一 meeting_record_id 在一批里可能出现多次（切窗口时的边界重叠）。
      // 一条 INSERT 里出现重复主键在 MySQL 下会连着更新两次，结果对但白写一次；
      // 先去重，顺便让「同一批里以最后一条为准」这件事是显式的，不靠引擎行为。
      const uniq = new Map<string, Meeting>()
      for (const m of meetings) uniq.set(m.meetingRecordId, m)
      const list = [...uniq.values()]

      for (let i = 0; i < list.length; i += UPSERT_CHUNK) {
        const chunk = list.slice(i, i + UPSERT_CHUNK)
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
        await pool.query(
          `INSERT INTO meeting_cache ${INSERT_COLUMNS}
           VALUES ${placeholders}
           ${ON_DUPLICATE}`,
          chunk.flatMap((m) => rowValues(m, now)),
        )
      }
    },

    async getByRecordId(meetingRecordId) {
      const [rows] = await pool.execute<MeetingCacheRow[]>(
        `SELECT ${SELECT_COLUMNS}
           FROM meeting_cache
          WHERE meeting_record_id = ?`,
        [meetingRecordId],
      )
      const r = rows[0]
      return r ? toMeeting(r) : null
    },

    listByMeetingId: (meetingId, from, to) => listBy('meeting_id', meetingId, from, to),
    listByMeetingCode: (meetingCode, from, to) => listBy('meeting_code', meetingCode, from, to),
  }
}
