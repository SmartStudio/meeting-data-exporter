import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
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
     * 需要 MySQL 8.0.19+：`SKIP LOCKED` 是 8.0 引入的，upsert 用的
     * `VALUES (…) AS new` 行别名是 8.0.19 引入的（8.0.0–8.0.18 上会当场语法错误
     * 而不是降级）。生产 RDS 8.0.36 满足。
     */
    async claimNext(now, leaseSec) {
      const conn = await pool.getConnection()
      try {
        // READ COMMITTED 不是性能调优，是正确性需要。RR 下 `SELECT … FOR UPDATE`
        // 会在 status='pending' 区间留间隙锁；队列刚被抽干（稳态）时那把锁覆盖
        // 整个区间，discovery 插入新发现的资产会被它挡住——实测 2s 后
        // lock wait timeout。RC 不加间隙锁，同样场景实测 5ms 插入成功。
        //
        // 不带 SESSION 的 `SET TRANSACTION` 只影响紧接着的下一个事务，
        // 所以不会污染这条连接回池后的其它用途。
        //
        // 一个边角：若紧接着的 `beginTransaction()` 自己抛错，这条已经 armed 的
        // 「下一个事务用 RC」会跟着连接回到池子里，落到该连接的下一个事务上。
        // 今天影响为零——`claimNext` 是 src/ 里唯一开事务的地方，而 arming 会被
        // 下一条 autocommit 语句消耗掉。但 Task 7 之后如果有别的事务写入者共用
        // 这个池，这句话就有用了。
        await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await conn.beginTransaction()
        const id = await pickClaimable(conn, now)
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
        // 回滚失败是次生错误（连接已经断了之类），不许盖掉真正的根因：
        // 否则日志里只剩 "Can't add new command when connection is in closed state"，
        // 而 lock wait timeout / 磁盘满 / DDL 冲突这些真原因被吃掉。
        try { await conn.rollback() } catch { /* 忽略：根因是 err */ }
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
      // 去重方式与 SQLite 版同构：同一 meeting_id 有多个 sub_meeting_id 时
      // 后一行覆盖前一行，胜出的是 sub_meeting_id 最大的那条。
      //
      // ORDER BY 是显式钉住这件事，不是改行为——今天不加 ORDER BY 时 InnoDB 全表扫
      // 走聚簇索引、恰好也是 (meeting_id, sub_meeting_id) 序，胜出行一模一样。但那是
      // 当前执行计划的副产物，不是 SQL 语义保证：优化器哪天改挑一个覆盖索引，
      // 胜出行就会静默换人。把「凑巧确定」写成「明确确定」。
      //
      // 注意这个「后行覆盖」本身仍是个洞（两个宿主都有，本任务不修）：周期性会议
      // 各场次共享 meeting_id、start_time 各不相同，而 start_time 会进目录名
      // （packages/engine/src/executor/index.ts:51-54），所以后果是**所有场次的文件
      // 落进某一场次的目录**。已记进台账。
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time
           FROM meetings ORDER BY meeting_id, sub_meeting_id`,
      )
      return new Map(rows.map((r) => [r.meeting_id as string, {
        subject: (r.subject ?? null) as string | null,
        startTime: r.start_time === null ? null : Number(r.start_time),
        meetingCode: (r.meeting_code ?? null) as string | null,
        endTime: r.end_time === null ? null : Number(r.end_time),
        subMeetingId: r.sub_meeting_id as string,
      }]))
    },

    // meetingsForPaths 之外**另开**一个按精确 (meeting_id, sub_meeting_id) 取的读法：
    // 前者按 meeting_id 去重、且只带拼路径用得上的几列（没有 host_userid），
    // meeting.json 要写的是这一场会议的全部元数据，只能按真实主键取。
    // 与 SQLite 版同一条语句、同一组列。
    async getMeeting(meetingId, subMeetingId) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time
           FROM meetings WHERE meeting_id=? AND sub_meeting_id=?`,
        [meetingId, subMeetingId],
      )
      const r = rows[0]
      if (r === undefined) return null
      // start_time / end_time 是 BIGINT，与 meetingsForPaths 一样显式 Number 化：
      // 这两个值会被写进 meeting.json，一个字符串 "1787218200" 会让 JSON 里的
      // 时间戳变成带引号的字符串，读清单的人（和脚本）拿到的就是另一种类型。
      return {
        meetingId: r.meeting_id as string,
        subMeetingId: r.sub_meeting_id as string,
        meetingCode: (r.meeting_code ?? null) as string | null,
        subject: (r.subject ?? null) as string | null,
        hostUserId: (r.host_userid ?? null) as string | null,
        startTime: r.start_time === null ? null : Number(r.start_time),
        endTime: r.end_time === null ? null : Number(r.end_time),
      }
    },

    async assetsForMeeting(meetingId, subMeetingId) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT * FROM meeting_assets WHERE meeting_id=? AND sub_meeting_id=? ORDER BY id`,
        [meetingId, subMeetingId],
      )
      return rows as unknown as AssetRow[]
    },
  }
}

/**
 * 挑出「可领取集合里 id 最小的那条」并锁住它，返回它的 id。
 *
 * SQLite 版一条 `WHERE status='pending' OR (status='running' AND lease_expires_at < ?)
 * ORDER BY id LIMIT 1` 就够了。MySQL 这边**必须拆成两条单 status 的查询**，
 * 原因是加锁足迹会随执行计划翻转：
 *
 *   OR 形式在生产数据分布上（历史 completed 远多于待领）会走 range + filesort。
 *   为了排序，它必须把**整个可领取集合**读出来，而 `FOR UPDATE` 会把读到的每一行
 *   都锁上——实测 2 万行历史 + 200 条待领时，一次领取持有 400 把记录锁。
 *   于是并发 worker 的 `SKIP LOCKED` 把它们全跳过、拿到 null，而
 *   `runExecutor` 的 `if (!row) return` 会让 worker 就此退出：
 *   **队列里还有活，worker 却集体收工**。空表上测不出来，因为优化器那时选主键。
 *
 * 拆开之后两条都是 status 等值查询，配合 `idx_assets_claimable (status, id,
 * lease_expires_at)` 索引自带 id 序，不再 filesort，`LIMIT 1` 锁到第一条就停手
 * （同样数据下实测 2 把锁，且不随队列长度增长）。
 *
 * 取两条结果里 id 较小的那个，等价于原来的 `OR + ORDER BY id LIMIT 1`——
 * 可领取集合与优先级都没变，两个宿主不分叉。第二条查询即使这次用不上也照跑，
 * 就是为了保住这个「跨两个集合取全局最小 id」的语义；它多锁的那一行在几微秒后
 * 的 COMMIT 就释放，足迹依然是常数。
 *
 * **与 SQLite 单语句语义唯一残留的差别**：这是两条语句，而 READ COMMITTED 下每条
 * 语句取自己的快照，两条之间不共享。若恰好在 Q1 与 Q2 之间提交了一条 id 比 Q2 结果
 * 更小的 pending，本轮会领走 expired 那条而不是它。**只影响单轮的挑选顺序**——
 * 不会重复领取（行锁保证），也不会漏活（那条 pending 下一轮就取到了）。
 * 写在这里免得将来有人拿它当 bug 查。
 */
async function pickClaimable(conn: PoolConnection, now: number): Promise<number | undefined> {
  const [pending] = await conn.query<RowDataPacket[]>(
    `SELECT id FROM meeting_assets WHERE status='pending'
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
  )
  const [expired] = await conn.query<RowDataPacket[]>(
    `SELECT id FROM meeting_assets WHERE status='running' AND lease_expires_at < ?
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [now],
  )
  const ids = [pending[0]?.id as number | undefined, expired[0]?.id as number | undefined]
    .filter((v): v is number => v !== undefined)
  return ids.length > 0 ? Math.min(...ids) : undefined
}
