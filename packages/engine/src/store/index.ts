import type { Database } from 'bun:sqlite'
import type { Meeting, AssetStatus, ProbeState } from '../domain/types'

export interface AssetUpsert {
  meetingId: string; subMeetingId: string; assetType: string; remoteId: string
  assetId?: string | null
  bytesExpected?: number | null; fileType?: string | null
}
export interface AssetRow {
  id: number; meeting_id: string; sub_meeting_id: string; asset_type: string; remote_id: string
  asset_id: string | null
  status: AssetStatus; target_path: string | null; file_type: string | null
  bytes_expected: number | null; bytes_written: number; content_hash: string | null
  attempts: number; lease_expires_at: number | null; last_error: string | null
}
export interface ProbeUpsert { meetingId: string; subMeetingId: string; assetType: string; deadlineAt: number; probeAfter: number }
export interface ProbeRow { meeting_id: string; sub_meeting_id: string; asset_type: string; state: ProbeState; attempts: number; deadline_at: number }
export interface ProbeKey { meetingId: string; subMeetingId: string; assetType: string }

export interface Store {
  upsertMeeting(m: Meeting, now: number): Promise<void>
  upsertAsset(a: AssetUpsert, now: number): Promise<void>
  claimNext(now: number, leaseSec: number): Promise<AssetRow | null>
  /**
   * 收尾一条下载完成的资产。`bytesWritten` 是 downloader 报回的**真实文件大小**
   * （逐 chunk 累加、且过了尺寸校验那道关），它会覆盖 `touchProgress` 一路写下的
   * 进度检查点——**一个 completed 行的 `bytes_written` 从此就是文件大小**。
   * 语义边界与它为什么值得信，见 domain/manifest.ts 里 `bytes` 字段的注释。
   */
  markCompleted(id: number, contentHash: string | null, bytesWritten: number, now: number): Promise<void>
  markFailed(id: number, err: string, now: number): Promise<void>
  markSkipped(id: number, reason: string, now: number): Promise<void>
  markSkippedByKey(k: ProbeKey, reason: string, now: number): Promise<void>
  markDead(id: number, err: string, now: number): Promise<void>
  touchProgress(id: number, bytesWritten: number, now: number, leaseSec: number): Promise<void>
  setTargetPath(id: number, path: string, fileType: string | null, now: number): Promise<void>
  /**
   * 该资产在同 (meeting, sub_meeting, asset_type, **file_type**) 兄弟中的 1-based
   * 序号与兄弟总数（文件名消歧用）。
   *
   * 按 file_type 分组是关键：同类资产的多种**格式**（txt/docx/pdf）靠扩展名天然
   * 区分，不该加序号；只有同一格式的**多段录制**（同 asset_type 同扩展名、不同
   * remote_id）才需要 `_2`、`_3` 消歧。不分组的话 transcript 的三种格式会变成
   * transcript.txt / transcript_2.docx / transcript_3.pdf，序号毫无意义且不稳定。
   */
  siblingRank(row: { id: number; meeting_id: string; sub_meeting_id: string; asset_type: string; file_type: string | null }): Promise<{ ordinal: number; total: number }>
  upsertProbe(p: ProbeUpsert): Promise<void>
  dueProbes(now: number): Promise<ProbeRow[]>
  resolveProbe(k: ProbeKey): Promise<void>
  abandonProbe(k: ProbeKey, reason: string): Promise<void>
  bumpProbe(k: ProbeKey, probeAfter: number): Promise<void>
  counts(): Promise<Record<AssetStatus, number>>
  failures(): Promise<AssetRow[]>
  resetFailed(now: number): Promise<number>
  /**
   * 拼落盘路径要用的会议元数据，键为 meeting_id。
   *
   * 新增这个方法不是顺手加功能——`client/src/cli/commands/{run,execute}.ts` 各有一份
   * **逐字重复**的 `loadMeetings(db)`，都绕过 Store 直接查 SQLite 的 `db`，且全程 `any`。
   * 那条路在 MySQL 宿主下根本不存在，必须收进接口。
   */
  meetingsForPaths(): Promise<Map<string, { subject: string | null; startTime: number | null; meetingCode: string | null; endTime: number | null; subMeetingId: string }>>
  /**
   * 单场会议的完整元数据，按**精确的 (meeting_id, sub_meeting_id)** 取；没有则 null。
   *
   * 与 `meetingsForPaths()` 是两件事，不要用后者代替：那个方法按 meeting_id 去重
   * （一次只要一个「代表」场次来拼目录名），周期性会议的其它场次会被静默丢掉；
   * 而且它刻意只带拼路径用得上的几列，没有 `host_userid`。`meeting.json` 要写的是
   * 这一场会议的全部元数据，只能按真实主键取。
   */
  getMeeting(meetingId: string, subMeetingId: string): Promise<Meeting | null>
  /**
   * 单场会议的**全部**资产行（按 id 升序），不按 status 过滤。
   *
   * 不在 SQL 里过滤成「只要 completed」，是因为 `_manifest.json` 要同时回答两个问题：
   * 这个目录里有什么（completed），以及哪些资产是**确认取不到**的、为什么
   * （skipped / dead）——「确认缺失」与「不知有无」是两种状态。分类规则属于清单的
   * 语义，放在 manifest/ 里一处说清楚，比在两个宿主的 SQL 里各写一遍 WHERE 更难写错。
   */
  assetsForMeeting(meetingId: string, subMeetingId: string): Promise<AssetRow[]>
}

export function createStore(db: Database): Store {
  const claimStmt = db.query<AssetRow, [number, number, number]>(`
    UPDATE assets SET status='running', lease_expires_at=?1, attempts=attempts+1, updated_at=?3
    WHERE id = (SELECT id FROM assets
                WHERE status='pending' OR (status='running' AND lease_expires_at < ?2)
                ORDER BY id LIMIT 1)
    RETURNING *`)
  return {
    async upsertMeeting(m, now) {
      db.query(`INSERT INTO meetings (meeting_id,sub_meeting_id,meeting_code,subject,host_userid,start_time,end_time,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(meeting_id,sub_meeting_id) DO UPDATE SET
          meeting_code=excluded.meeting_code, subject=excluded.subject, host_userid=excluded.host_userid,
          start_time=excluded.start_time, end_time=excluded.end_time, updated_at=excluded.updated_at`)
        .run(m.meetingId, m.subMeetingId, m.meetingCode, m.subject, m.hostUserId, m.startTime, m.endTime, now, now)
    },
    async upsertAsset(a, now) {
      // file_type 进唯一键（见 db.ts 的 SCHEMA_VERSION 说明）：同一份录制的多种
      // 导出格式共享 record_file_id，只有格式能区分。列为 NOT NULL DEFAULT ''，
      // 故这里把未知格式归一成 ''——SQLite 的 UNIQUE 视每个 NULL 互不相同，
      // 可空列进唯一键等于没有约束。
      db.query(`INSERT INTO assets (meeting_id,sub_meeting_id,asset_type,remote_id,asset_id,status,bytes_expected,file_type,created_at,updated_at)
        VALUES (?,?,?,?,?, 'pending', ?,?,?,?)
        ON CONFLICT(meeting_id,sub_meeting_id,asset_type,remote_id,file_type) DO UPDATE SET
          asset_id=COALESCE(excluded.asset_id, assets.asset_id),
          bytes_expected=COALESCE(excluded.bytes_expected, assets.bytes_expected),
          updated_at=excluded.updated_at`)
        .run(a.meetingId, a.subMeetingId, a.assetType, a.remoteId, a.assetId ?? null, a.bytesExpected ?? null, a.fileType ?? '', now, now)
    },
    async claimNext(now, leaseSec) { return claimStmt.get(now + leaseSec, now, now) ?? null },
    async markCompleted(id, h, bytes, now) { db.query(`UPDATE assets SET status='completed', content_hash=?, bytes_written=?, completed_at=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(h, bytes, now, now, id) },
    async markFailed(id, e, now) { db.query(`UPDATE assets SET status='failed', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(e, now, id) },
    async markSkipped(id, r, now) { db.query(`UPDATE assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(r, now, id) },
    async markSkippedByKey(k, r, now) { db.query(`UPDATE assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND status NOT IN ('completed','running')`).run(r, now, k.meetingId, k.subMeetingId, k.assetType) }, // 不回退已完成的下载、不中断执行中的任务
    async markDead(id, e, now) { db.query(`UPDATE assets SET status='dead', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(e, now, id) },
    async touchProgress(id, bytes, now, leaseSec) { db.query(`UPDATE assets SET bytes_written=?, lease_expires_at=?, updated_at=? WHERE id=?`).run(bytes, now + leaseSec, now, id) },
    async setTargetPath(id, p, ft, now) { db.query(`UPDATE assets SET target_path=?, file_type=COALESCE(?,file_type), updated_at=? WHERE id=?`).run(p, ft, now, id) },
    async siblingRank(row) {
      const r = db.query<{ total: number; ordinal: number }, [string, string, string, string, number]>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN id <= ?5 THEN 1 ELSE 0 END) AS ordinal
         FROM assets WHERE meeting_id=?1 AND sub_meeting_id=?2 AND asset_type=?3
           AND file_type=?4`,
      ).get(row.meeting_id, row.sub_meeting_id, row.asset_type, row.file_type ?? '', row.id)
      return { ordinal: r?.ordinal ?? 1, total: r?.total ?? 1 }
    },
    async upsertProbe(p) {
      db.query(`INSERT INTO asset_probes (meeting_id,sub_meeting_id,asset_type,state,deadline_at,probe_after)
        VALUES (?,?,?, 'probing', ?, ?)
        ON CONFLICT(meeting_id,sub_meeting_id,asset_type) DO UPDATE SET deadline_at=excluded.deadline_at`)
        .run(p.meetingId, p.subMeetingId, p.assetType, p.deadlineAt, p.probeAfter)
    },
    async dueProbes(now) { return db.query<ProbeRow, [number]>(`SELECT * FROM asset_probes WHERE state='probing' AND probe_after <= ?`).all(now) },
    async resolveProbe(k) { db.query(`UPDATE asset_probes SET state='resolved' WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(k.meetingId, k.subMeetingId, k.assetType) },
    async abandonProbe(k, r) { db.query(`UPDATE asset_probes SET state='abandoned', last_reason=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(r, k.meetingId, k.subMeetingId, k.assetType) },
    async bumpProbe(k, after) { db.query(`UPDATE asset_probes SET attempts=attempts+1, probe_after=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(after, k.meetingId, k.subMeetingId, k.assetType) },
    async counts() {
      const rows = db.query<{ status: AssetStatus; n: number }, []>(`SELECT status, COUNT(*) n FROM assets GROUP BY status`).all()
      const out = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, dead: 0 } as Record<AssetStatus, number>
      for (const r of rows) out[r.status] = r.n
      return out
    },
    async failures() { return db.query<AssetRow, []>(`SELECT * FROM assets WHERE status IN ('failed','dead') ORDER BY id`).all() },
    async resetFailed(now) { return db.query(`UPDATE assets SET status='pending', last_error=NULL, updated_at=?  WHERE status IN ('failed','dead')`).run(now).changes },
    async meetingsForPaths() {
      const rows = db.query<{ meeting_id: string; sub_meeting_id: string; subject: string | null;
                              meeting_code: string | null; start_time: number | null; end_time: number | null }, []>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time FROM meetings`,
      ).all()
      return new Map(rows.map((r) => [r.meeting_id, {
        subject: r.subject, startTime: r.start_time, meetingCode: r.meeting_code,
        endTime: r.end_time, subMeetingId: r.sub_meeting_id,
      }]))
    },
    async getMeeting(meetingId, subMeetingId) {
      const r = db.query<{ meeting_id: string; sub_meeting_id: string; meeting_code: string | null;
                           subject: string | null; host_userid: string | null;
                           start_time: number | null; end_time: number | null }, [string, string]>(
        `SELECT meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time
           FROM meetings WHERE meeting_id=? AND sub_meeting_id=?`,
      ).get(meetingId, subMeetingId)
      if (!r) return null
      return {
        meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id, meetingCode: r.meeting_code,
        subject: r.subject, hostUserId: r.host_userid, startTime: r.start_time, endTime: r.end_time,
      }
    },
    async assetsForMeeting(meetingId, subMeetingId) {
      return db.query<AssetRow, [string, string]>(
        `SELECT * FROM assets WHERE meeting_id=? AND sub_meeting_id=? ORDER BY id`,
      ).all(meetingId, subMeetingId)
    },
  }
}
