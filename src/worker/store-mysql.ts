import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { AssetRow, AssetStatus, ProbeRow, Store } from '@yaowu/mde-engine'
import type { Pool } from '../store/db'

/**
 * Store 的 MySQL 实现。与 packages/engine 的 SQLite 实现是同一个接口的两个宿主：
 * SQLite 服务 mde CLI（管理员机器），本文件服务归档 worker（服务器）。
 *
 * 两者行为必须一致——引擎的 executor / discovery 不知道自己跑在哪个宿主上，
 * 行为一分叉就没人能推理这个系统。下面每条 SQL 都对着
 * `packages/engine/src/store/index.ts` 的同名方法写，语句结构、字段、
 * COALESCE / NOT IN 之类的细节逐条对齐；只有 SQLite 方言在 MySQL 里不存在
 * 对应写法的地方才改，改动点在注释里写明为什么等价。
 */
export function createMysqlStore(pool: Pool): Store {
  return {
    async upsertMeeting(m, now) {
      await pool.query(
        `INSERT INTO meetings (meeting_id,sub_meeting_id,meeting_code,subject,host_userid,start_time,end_time,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE
           meeting_code=new.meeting_code, subject=new.subject, host_userid=new.host_userid,
           start_time=new.start_time, end_time=new.end_time, updated_at=new.updated_at`,
        [m.meetingId, m.subMeetingId, m.meetingCode, m.subject, m.hostUserId, m.startTime, m.endTime, now, now],
      )
    },

    async upsertAsset(a, now) {
      // file_type 归一成空串而非 null：它参与唯一键 uk_asset，可空列进唯一键
      // 等于没有约束（同一份录制的多种导出格式共享 record_file_id，只有格式能区分）。
      // asset_id / bytes_expected 用 COALESCE 保护：后来的一次投递没带这两个值时
      // 不能把已经发现的值冲成 NULL——与 SQLite 版逐字同义。
      await pool.query(
        `INSERT INTO meeting_assets (meeting_id,sub_meeting_id,asset_type,remote_id,asset_id,status,bytes_expected,file_type,created_at,updated_at)
         VALUES (?,?,?,?,?,'pending',?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE
           asset_id=COALESCE(new.asset_id, meeting_assets.asset_id),
           bytes_expected=COALESCE(new.bytes_expected, meeting_assets.bytes_expected),
           updated_at=new.updated_at`,
        [a.meetingId, a.subMeetingId, a.assetType, a.remoteId, a.assetId ?? null,
          a.bytesExpected ?? null, a.fileType ?? '', now, now],
      )
    },

    /**
     * 领取一条任务。SQLite 版是单进程单连接，一条
     * `UPDATE … WHERE id=(SELECT … LIMIT 1) RETURNING *` 天然原子；
     * MySQL 既没有 `UPDATE … RETURNING`，网关又是多实例并发，
     * 所以拆成「事务内 SELECT … FOR UPDATE SKIP LOCKED → UPDATE → 回读」三步。
     *
     * 原子性靠的是行锁而不是单语句：SELECT 拿到的是排他行锁，直到 COMMIT 才释放，
     * 期间别的事务既读不到未提交的 running，也拿不到这行的锁。三步在同一个
     * 连接的同一个事务里，因此对外仍是一次原子的领取。
     *
     * SKIP LOCKED 是关键：没有它，并发的 worker 会在同一行上排队等锁，
     * 拿到锁时那行的 status 早已变成 running，等于白等一轮。有了它，
     * 被别人锁住的行直接跳过，每个 worker 领到不同的任务。
     *
     * 回读用 `SELECT *`，返回的是 UPDATE 之后的值（同事务内看得见自己的写），
     * 与 SQLite `RETURNING *` 返回更新后行的语义一致。
     *
     * 需要 MySQL 8.0+（见本仓库 Global Constraints）。
     */
    async claimNext(now, leaseSec) {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const [picked] = await conn.query<RowDataPacket[]>(
          `SELECT id FROM meeting_assets
            WHERE status='pending' OR (status='running' AND lease_expires_at < ?)
            ORDER BY id LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [now],
        )
        const id = picked[0]?.id as number | undefined
        if (id === undefined) {
          await conn.commit()
          return null
        }
        await conn.query(
          `UPDATE meeting_assets SET status='running', lease_expires_at=?, attempts=attempts+1, updated_at=? WHERE id=?`,
          [now + leaseSec, now, id],
        )
        const [got] = await conn.query<RowDataPacket[]>(
          `SELECT * FROM meeting_assets WHERE id=?`, [id],
        )
        await conn.commit()
        return (got[0] as AssetRow | undefined) ?? null
      } catch (err) {
        await conn.rollback()
        throw err
      } finally {
        conn.release()
      }
    },

    async markCompleted(id, h, now) {
      await pool.query(
        `UPDATE meeting_assets SET status='completed', content_hash=?, completed_at=?, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        [h, now, now, id],
      )
    },
    async markFailed(id, e, now) {
      await pool.query(
        `UPDATE meeting_assets SET status='failed', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        [e, now, id],
      )
    },
    async markSkipped(id, r, now) {
      await pool.query(
        `UPDATE meeting_assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        [r, now, id],
      )
    },
    // 不回退已完成的下载、不中断执行中的任务——与 SQLite 版逐字一致
    async markSkippedByKey(k, r, now) {
      await pool.query(
        `UPDATE meeting_assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=?
          WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND status NOT IN ('completed','running')`,
        [r, now, k.meetingId, k.subMeetingId, k.assetType],
      )
    },
    async markDead(id, e, now) {
      await pool.query(
        `UPDATE meeting_assets SET status='dead', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        [e, now, id],
      )
    },
    // 刻意不加 `AND status='running'`：SQLite 版没加，加了两个宿主就分叉。
    // （不 await 的 touchProgress 可能落在 markCompleted 之后、把字段写回一条
    // 已 completed 的行，这是已知的脏数据问题，根治是逻辑改动，另开任务。）
    async touchProgress(id, bytes, now, leaseSec) {
      await pool.query(
        `UPDATE meeting_assets SET bytes_written=?, lease_expires_at=?, updated_at=? WHERE id=?`,
        [bytes, now + leaseSec, now, id],
      )
    },
    async setTargetPath(id, p, ft, now) {
      await pool.query(
        `UPDATE meeting_assets SET target_path=?, file_type=COALESCE(?,file_type), updated_at=? WHERE id=?`,
        [p, ft, now, id],
      )
    },

    async siblingRank(row) {
      const [r] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN id <= ? THEN 1 ELSE 0 END) AS ordinal
           FROM meeting_assets
          WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND file_type=?`,
        [row.id, row.meeting_id, row.sub_meeting_id, row.asset_type, row.file_type ?? ''],
      )
      // MySQL 的 SUM 返回 DECIMAL，mysql2 给出的是 string，必须 Number 化；
      // 空组时 SUM 是 NULL、COUNT 是 0，`?? 1` 与 SQLite 版的兜底逐字一致。
      return { ordinal: Number(r[0]?.ordinal ?? 1), total: Number(r[0]?.total ?? 1) }
    },

    async upsertProbe(p) {
      await pool.query(
        `INSERT INTO meeting_asset_probes (meeting_id,sub_meeting_id,asset_type,state,deadline_at,probe_after)
         VALUES (?,?,?,'probing',?,?) AS new
         ON DUPLICATE KEY UPDATE deadline_at=new.deadline_at`,
        [p.meetingId, p.subMeetingId, p.assetType, p.deadlineAt, p.probeAfter],
      )
    },
    async dueProbes(now) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT * FROM meeting_asset_probes WHERE state='probing' AND probe_after <= ?`, [now],
      )
      return rows as unknown as ProbeRow[]
    },
    async resolveProbe(k) {
      await pool.query(
        `UPDATE meeting_asset_probes SET state='resolved' WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`,
        [k.meetingId, k.subMeetingId, k.assetType],
      )
    },
    async abandonProbe(k, r) {
      await pool.query(
        `UPDATE meeting_asset_probes SET state='abandoned', last_reason=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`,
        [r, k.meetingId, k.subMeetingId, k.assetType],
      )
    },
    async bumpProbe(k, after) {
      await pool.query(
        `UPDATE meeting_asset_probes SET attempts=attempts+1, probe_after=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`,
        [after, k.meetingId, k.subMeetingId, k.assetType],
      )
    },

    async counts() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT status, COUNT(*) n FROM meeting_assets GROUP BY status`,
      )
      const out = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, dead: 0 } as Record<AssetStatus, number>
      for (const r of rows) out[r.status as AssetStatus] = Number(r.n)
      return out
    },
    async failures() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT * FROM meeting_assets WHERE status IN ('failed','dead') ORDER BY id`,
      )
      return rows as unknown as AssetRow[]
    },
    async resetFailed(now) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='pending', last_error=NULL, updated_at=? WHERE status IN ('failed','dead')`,
        [now],
      )
      return res.affectedRows
    },

    async meetingsForPaths() {
      // 不加 ORDER BY、不去重——与 SQLite 版同构：同一 meeting_id 有多个
      // sub_meeting_id 时后一行覆盖前一行。换行序或换去重方式会改掉落盘路径。
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time FROM meetings`,
      )
      return new Map(rows.map((r) => [r.meeting_id as string, {
        subject: (r.subject ?? null) as string | null,
        startTime: r.start_time === null ? null : Number(r.start_time),
        meetingCode: (r.meeting_code ?? null) as string | null,
        endTime: r.end_time === null ? null : Number(r.end_time),
        subMeetingId: r.sub_meeting_id as string,
      }]))
    },
  }
}
