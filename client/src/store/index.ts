import type { Database } from 'bun:sqlite'
import type { Meeting, AssetStatus, ProbeState } from '../domain/types'

export interface AssetUpsert {
  meetingId: string; subMeetingId: string; assetType: string; remoteId: string
  bytesExpected?: number | null; fileType?: string | null
}
export interface AssetRow {
  id: number; meeting_id: string; sub_meeting_id: string; asset_type: string; remote_id: string
  status: AssetStatus; target_path: string | null; file_type: string | null
  bytes_expected: number | null; bytes_written: number; content_hash: string | null
  attempts: number; lease_expires_at: number | null; last_error: string | null
}
export interface ProbeUpsert { meetingId: string; subMeetingId: string; assetType: string; deadlineAt: number; probeAfter: number }
export interface ProbeRow { meeting_id: string; sub_meeting_id: string; asset_type: string; state: ProbeState; attempts: number; deadline_at: number }
export interface ProbeKey { meetingId: string; subMeetingId: string; assetType: string }

export interface Store {
  upsertMeeting(m: Meeting, now: number): void
  upsertAsset(a: AssetUpsert, now: number): void
  claimNext(now: number, leaseSec: number): AssetRow | null
  markCompleted(id: number, contentHash: string | null, now: number): void
  markFailed(id: number, err: string, now: number): void
  markSkipped(id: number, reason: string, now: number): void
  markSkippedByKey(k: ProbeKey, reason: string, now: number): void
  markDead(id: number, err: string, now: number): void
  touchProgress(id: number, bytesWritten: number, now: number, leaseSec: number): void
  setTargetPath(id: number, path: string, fileType: string | null, now: number): void
  upsertProbe(p: ProbeUpsert): void
  dueProbes(now: number): ProbeRow[]
  resolveProbe(k: ProbeKey): void
  abandonProbe(k: ProbeKey, reason: string): void
  bumpProbe(k: ProbeKey, probeAfter: number): void
  counts(): Record<AssetStatus, number>
  failures(): AssetRow[]
  resetFailed(now: number): number
}

export function createStore(db: Database): Store {
  const claimStmt = db.query<AssetRow, [number, number, number]>(`
    UPDATE assets SET status='running', lease_expires_at=?1, attempts=attempts+1, updated_at=?3
    WHERE id = (SELECT id FROM assets
                WHERE status='pending' OR (status='running' AND lease_expires_at < ?2)
                ORDER BY id LIMIT 1)
    RETURNING *`)
  return {
    upsertMeeting(m, now) {
      db.query(`INSERT INTO meetings (meeting_id,sub_meeting_id,meeting_code,subject,host_userid,start_time,end_time,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(meeting_id,sub_meeting_id) DO UPDATE SET
          meeting_code=excluded.meeting_code, subject=excluded.subject, host_userid=excluded.host_userid,
          start_time=excluded.start_time, end_time=excluded.end_time, updated_at=excluded.updated_at`)
        .run(m.meetingId, m.subMeetingId, m.meetingCode, m.subject, m.hostUserId, m.startTime, m.endTime, now, now)
    },
    upsertAsset(a, now) {
      db.query(`INSERT INTO assets (meeting_id,sub_meeting_id,asset_type,remote_id,status,bytes_expected,file_type,created_at,updated_at)
        VALUES (?,?,?,?, 'pending', ?,?,?,?)
        ON CONFLICT(meeting_id,sub_meeting_id,asset_type,remote_id) DO UPDATE SET
          bytes_expected=COALESCE(excluded.bytes_expected, assets.bytes_expected),
          file_type=COALESCE(excluded.file_type, assets.file_type), updated_at=excluded.updated_at`)
        .run(a.meetingId, a.subMeetingId, a.assetType, a.remoteId, a.bytesExpected ?? null, a.fileType ?? null, now, now)
    },
    claimNext(now, leaseSec) { return claimStmt.get(now + leaseSec, now, now) ?? null },
    markCompleted(id, h, now) { db.query(`UPDATE assets SET status='completed', content_hash=?, completed_at=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(h, now, now, id) },
    markFailed(id, e, now) { db.query(`UPDATE assets SET status='failed', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(e, now, id) },
    markSkipped(id, r, now) { db.query(`UPDATE assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(r, now, id) },
    markSkippedByKey(k, r, now) { db.query(`UPDATE assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND status NOT IN ('completed','running')`).run(r, now, k.meetingId, k.subMeetingId, k.assetType) }, // 不回退已完成的下载、不中断执行中的任务
    markDead(id, e, now) { db.query(`UPDATE assets SET status='dead', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(e, now, id) },
    touchProgress(id, bytes, now, leaseSec) { db.query(`UPDATE assets SET bytes_written=?, lease_expires_at=?, updated_at=? WHERE id=?`).run(bytes, now + leaseSec, now, id) },
    setTargetPath(id, p, ft, now) { db.query(`UPDATE assets SET target_path=?, file_type=COALESCE(?,file_type), updated_at=? WHERE id=?`).run(p, ft, now, id) },
    upsertProbe(p) {
      db.query(`INSERT INTO asset_probes (meeting_id,sub_meeting_id,asset_type,state,deadline_at,probe_after)
        VALUES (?,?,?, 'probing', ?, ?)
        ON CONFLICT(meeting_id,sub_meeting_id,asset_type) DO UPDATE SET deadline_at=excluded.deadline_at`)
        .run(p.meetingId, p.subMeetingId, p.assetType, p.deadlineAt, p.probeAfter)
    },
    dueProbes(now) { return db.query<ProbeRow, [number]>(`SELECT * FROM asset_probes WHERE state='probing' AND probe_after <= ?`).all(now) },
    resolveProbe(k) { db.query(`UPDATE asset_probes SET state='resolved' WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(k.meetingId, k.subMeetingId, k.assetType) },
    abandonProbe(k, r) { db.query(`UPDATE asset_probes SET state='abandoned', last_reason=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(r, k.meetingId, k.subMeetingId, k.assetType) },
    bumpProbe(k, after) { db.query(`UPDATE asset_probes SET attempts=attempts+1, probe_after=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(after, k.meetingId, k.subMeetingId, k.assetType) },
    counts() {
      const rows = db.query<{ status: AssetStatus; n: number }, []>(`SELECT status, COUNT(*) n FROM assets GROUP BY status`).all()
      const out = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, dead: 0 } as Record<AssetStatus, number>
      for (const r of rows) out[r.status] = r.n
      return out
    },
    failures() { return db.query<AssetRow, []>(`SELECT * FROM assets WHERE status IN ('failed','dead') ORDER BY id`).all() },
    resetFailed(now) { return db.query(`UPDATE assets SET status='pending', last_error=NULL, updated_at=?  WHERE status IN ('failed','dead')`).run(now).changes },
  }
}
