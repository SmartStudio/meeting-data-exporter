import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { assignDirOrdinals, meetingPathKey } from '@yaowu/mde-engine'
import type { AssetRow, AssetStatus, ProbeRow, Store } from '@yaowu/mde-engine'
import type { Pool } from '../store/db'

/**
 * 一条**此刻仍处于放弃状态**的资产（`deadAssets` 的返回形状）。
 *
 * 只带调度器落失败项要用的那几列，不给整行：这个方法的调用方是
 * `scheduler.ts` 的任务一，它要拼的是一句人读的话（哪场会议、哪类资产、
 * 最后一次错在哪）加一个真实的计数，拿整行只会让人以为自己可以顺手改点什么。
 */
export interface DeadAsset {
  meetingId: string
  subMeetingId: string
  assetType: string
  /** 平台侧的记录 id 与文件格式。失败项的技术明细靠这两个才能回库里定位到具体那一行 */
  remoteId: string
  fileType: string | null
  lastError: string | null
  /** 下载队列的真实尝试次数。dead 行上它就是上限——失败项的 attempts 照抄它，不累加 */
  attempts: number
}

/**
 * MySQL 宿主比引擎接口多出来的那部分。
 *
 * `deadAssets` 服务的是 `job_failures`——一张**只有网关侧才有**的表
 * （spec §4.8「失败项 · 需要处理」）。SQLite 宿主是管理员机器上的 mde CLI，
 * 那边没有调度器、没有运行记录、也没有失败项表，把这个方法塞进 `Store` 接口
 * 等于逼 CLI 实现一个它永远不会调的查询。所以它长在这一侧，而不是共用接口上。
 *
 * 返回类型放宽成 `MysqlStore` 对既有调用方是透明的：它们都把结果当 `Store` 用。
 */
export interface MysqlStore extends Store {
  /**
   * **此刻**全部 `dead` 行。**只读，给失败项用。**
   *
   * 是全部而不是"本轮新转的"：失败项要做「资产此刻是否 dead」的镜像——每轮重记
   * 一遍仍然 dead 的，它就一直开着；不再 dead 的不再记，`resolveStaleFailures`
   * 下一轮关掉它。理由的全文在 scheduler.ts 的 recordDeadAssets 上方。
   *
   * 为什么不复用 `failures()`：那个方法给的是 failed + dead。`failed` 现在是
   * 会按退避自动重试的中间态，不该惊动运维；只有 `dead`（重试用尽）才是。
   *
   * 带上 `attempts`：失败项的 attempts 要照抄它（绝对值），不能靠 upsert 累加。
   *
   * 索引：`idx_assets_claimable` 首列是 status，等值查得到。dead 行在健康的库里
   * 是个位数，而这个查询一轮只跑一次（对比 `claimNext` 是每领一条跑一次）。
   */
  deadAssets(): Promise<DeadAsset[]>
}

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
export function createMysqlStore(pool: Pool): MysqlStore {
  return {
    async upsertMeeting(m, now) {
      await pool.query(
        `INSERT INTO meetings (meeting_id,sub_meeting_id,meeting_code,subject,record_type,host_userid,start_time,end_time,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE
           meeting_code=new.meeting_code, subject=new.subject, record_type=new.record_type, host_userid=new.host_userid,
           start_time=new.start_time, end_time=new.end_time, updated_at=new.updated_at`,
        [m.meetingId, m.subMeetingId, m.meetingCode, m.subject, m.recordType ?? 0, m.hostUserId, m.startTime, m.endTime, now, now],
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

    // bytes_written 写的是 downloader 报回的真实文件大小，覆盖掉 touchProgress 留下的
    // 进度检查点——与 SQLite 版逐字一致。**两处必须一起改**：只改一处的话服务端会
    // 静默失效（下载照常成功、清单照常写出，只是 bytes 永远是 null，没有任何报错）。
    // 五个写回都带 `AND status='running' AND attempts=?` 的栅栏（语义见引擎侧 Store
    // 里 `claimedAttempts` 那一段，返回 false = 租约已被别人重领）。**两处必须一起改**：
    // 只改一边的话服务端照样会被「同一行领两次」互相覆盖，而且不报错。
    async markCompleted(id, h, bytes, now, claimed) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='completed', content_hash=?, bytes_written=?, completed_at=?, lease_expires_at=NULL, updated_at=? WHERE id=? AND status='running' AND attempts=?`,
        [h, bytes, now, now, id, claimed],
      )
      return res.affectedRows > 0
    },
    // lease_expires_at 写的是**最早可再领取时间**，不是租约——同一列在 running /
    // failed / 终态三种状态下三种读法，完整语义见引擎侧 `Store.markFailed` 的注释。
    // 退避曲线在 executor 的 `downloadBackoff` 里算好传进来，这里只负责写。
    // **两处必须一起改**（SQLite 版逐字同样）：只改一边的话，一个宿主会重试、
    // 另一个宿主的 failed 行永远卡死，而两边都不报错。
    async markFailed(id, e, now, retryAt, claimed) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='failed', last_error=?, lease_expires_at=?, updated_at=? WHERE id=? AND status='running' AND attempts=?`,
        [e, retryAt, now, id, claimed],
      )
      return res.affectedRows > 0
    },
    async markSkipped(id, r, now, claimed) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=? AND status='running' AND attempts=?`,
        [r, now, id, claimed],
      )
      return res.affectedRows > 0
    },
    // 不回退已完成的下载、不中断执行中的任务——与 SQLite 版逐字一致
    async markSkippedByKey(k, r, now) {
      await pool.query(
        `UPDATE meeting_assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=?
          WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND status NOT IN ('completed','running')`,
        [r, now, k.meetingId, k.subMeetingId, k.assetType],
      )
    },
    async markDead(id, e, now, claimed) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='dead', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=? AND status='running' AND attempts=?`,
        [e, now, id, claimed],
      )
      return res.affectedRows > 0
    },
    // `AND status='running'`：**两个宿主一起加的**，不是这一侧的分叉（SQLite 版
    // 同一条判定，见 packages/engine/src/store/index.ts）。这里曾经刻意不加，代价
    // 只是「已 completed 的行上有个脏的进度数」——没人读那一列，就先欠着。
    // 现在读它的人有了：`markCompleted` 把**真实文件大小**写进这一列，而清单在平台
    // 不给 bytes_expected 时（真实环境的常态）就取它，还会写进永久留在 NAS 上的那份。
    // 进度回写在 executor 里不 await，池化连接上一次慢的 UPDATE 完全可以落在
    // markCompleted 之后——那时脏数据就变成了一份撒谎的清单。终态行不再接受回写。
    // `AND attempts=?` 同理（栅栏）：租约过期被别人重领之后，这一次的进度回写就是
    // 在给别人的下载续租，续到的还是自己那份早就作废的进度。返回值只是「写没写进去」，
    // 调用方本来就是尽力而为，不据此中断下载。
    // ⚠️ MySQL 的 affectedRows 是**实际改动的行数**：同一个 now/bytes 连写两次，
    // 第二次会返回 false 而行其实是匹配上的。进度回写不看这个返回值，无碍；
    // 若将来有人据此判定「租约还在不在」，要么改看 changedRows 语义，要么换条件。
    async touchProgress(id, bytes, now, leaseSec, claimed) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET bytes_written=?, lease_expires_at=?, updated_at=? WHERE id=? AND status='running' AND attempts=?`,
        [bytes, now + leaseSec, now, id, claimed],
      )
      return res.affectedRows > 0
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
    // 只动 probing 行：语义与那个 WHERE 的理由写在 Store 接口上（packages/engine/src/store/index.ts）
    async abandonProbeIfProbing(k, r) {
      await pool.query(
        `UPDATE meeting_asset_probes SET state='abandoned', last_reason=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND state='probing'`,
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
    // 时间窗 + 只取这几列，理由见 MysqlStore.deadAssets。ORDER BY id 是为了让
    // 同一场会议的多条资产在拼那句失败原因时次序稳定（不然两轮跑出来的话不一样，
    // 界面上看起来像是又出了新问题）。
    async deadAssets() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, asset_type, remote_id, file_type, last_error, attempts
           FROM meeting_assets WHERE status='dead' ORDER BY id`,
      )
      return rows.map((r) => ({
        meetingId: r.meeting_id as string,
        subMeetingId: r.sub_meeting_id as string,
        assetType: r.asset_type as string,
        remoteId: r.remote_id as string,
        // 列是 NOT NULL DEFAULT ''，但读侧照样按可空处理：空串与 NULL 在
        // 「这条资产是什么格式」上是同一个答案（不知道），拼明细时都落成空
        fileType: (r.file_type ?? null) as string | null,
        lastError: (r.last_error ?? null) as string | null,
        attempts: Number(r.attempts),
      }))
    },
    // lease_expires_at 一并清掉：它对 failed 行是「最早可再领取时间」，行被打回
    // pending 之后那个值没有任何含义，留着只会让人对着一条 pending 行猜它在等什么。
    // 这个方法是**人工逃生口**（把 dead 打回队列），不是重试机制——重试是
    // markFailed 的退避加 claimNext 到点重领，见引擎侧 `Store.resetFailed` 的注释。
    async resetFailed(now) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='pending', last_error=NULL, lease_expires_at=NULL, updated_at=? WHERE status IN ('failed','dead')`,
        [now],
      )
      return res.affectedRows
    },

    // 与 SQLite 版逐字同义（表名不同）。**两处必须一起改**：只改一边的话
    // CLI 与服务器对同一个动作给出不同结果，而两边都不报错。
    // 语义（尤其是「为什么 retry 清零 attempts、ignore 只动 dead」）见引擎侧
    // `Store.retryMeetingAssets` / `Store.ignoreDeadAssets` 的注释。
    async retryMeetingAssets(k, now) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='pending', attempts=0, last_error=NULL, lease_expires_at=NULL, updated_at=?
          WHERE meeting_id=? AND sub_meeting_id=? AND status IN ('failed','dead')`,
        [now, k.meetingId, k.subMeetingId],
      )
      return res.affectedRows
    },
    async ignoreDeadAssets(k, now) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='skipped', last_error='ignored_by_admin', lease_expires_at=NULL, updated_at=?
          WHERE meeting_id=? AND sub_meeting_id=? AND status='dead'`,
        [now, k.meetingId, k.subMeetingId],
      )
      return res.affectedRows
    },

    /**
     * 键是 `meetingPathKey(meeting_id, sub_meeting_id)`，与 SQLite 宿主逐字同构。
     *
     * 2026-09-09 之前这里的键只有 meeting_id，后一行覆盖前一行——周期会议各场次共享
     * meeting_id、start_time 各不相同，而 start_time 进目录名，于是**所有场次的文件
     * 落进某一场次的目录**。那个洞随 sub_meeting_id = meeting_record_id 一起补掉。
     *
     * ORDER BY 留着：它让行序确定，出问题时两个宿主的输出可以逐行对。
     */
    async meetingsForPaths() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time, created_at
           FROM meetings ORDER BY meeting_id, sub_meeting_id`,
      )
      const meetings = rows.map((r) => ({
        meetingId: r.meeting_id as string,
        subMeetingId: r.sub_meeting_id as string,
        subject: (r.subject ?? null) as string | null,
        startTime: r.start_time === null ? null : Number(r.start_time),
        meetingCode: (r.meeting_code ?? null) as string | null,
        endTime: r.end_time === null ? null : Number(r.end_time),
        // created_at 是 BIGINT NOT NULL，与 start_time 一样显式 Number 化：这一列是
        // 目录序号的主序，混进一个字符串会让比较规则取决于驱动怎么返回 BIGINT，
        // 而序号定的是盘上的目录名，两个宿主必须给出同一个答案
        createdAt: Number(r.created_at),
      }))
      // 目录序号与 SQLite 宿主同一个函数、同一个位置算（见引擎侧 meetingsForPaths）。
      // 不靠上面那句 ORDER BY：排序归排序，序号的定义写在 assignDirOrdinals 里，
      // 两个宿主对同一批数据必须给出同一个答案。
      const ordinals = assignDirOrdinals(meetings)
      return new Map(meetings.map((m) => {
        const key = meetingPathKey(m.meetingId, m.subMeetingId)
        return [key, { ...m, dirOrdinal: ordinals.get(key) ?? 1 }]
      }))
    },

    // meetingsForPaths 之外**另开**一个按精确 (meeting_id, sub_meeting_id) 取的读法：
    // 前者虽然也按两段主键建键，却只带拼路径用得上的几列（没有 host_userid），
    // meeting.json 要写的是这一场会议的全部元数据，只能按真实主键取回整行。
    // 与 SQLite 版同一条语句、同一组列。
    async getMeeting(meetingId, subMeetingId) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, meeting_code, subject, record_type, host_userid, start_time, end_time
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
        recordType: Number(r.record_type ?? 0),
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
 * 可领取的是三类行（语义见引擎侧 `Store.claimNext`）：`pending`、租约过期的
 * `running`、退避到点的 `failed`。
 *
 * SQLite 版把三者写成一条带 OR 的 `WHERE … ORDER BY id LIMIT 1` 就够了。
 * MySQL 这边**必须拆成三条单 status 的查询**，原因是加锁足迹会随执行计划翻转：
 *
 *   OR 形式在生产数据分布上（历史 completed 远多于待领）会走 range + filesort。
 *   为了排序，它必须把**整个可领取集合**读出来，而 `FOR UPDATE` 会把读到的每一行
 *   都锁上——实测 2 万行历史 + 200 条待领时，一次领取持有 400 把记录锁。
 *   于是并发 worker 的 `SKIP LOCKED` 把它们全跳过、拿到 null，而
 *   `runExecutor` 的 `if (!row) return` 会让 worker 就此退出：
 *   **队列里还有活，worker 却集体收工**。空表上测不出来，因为优化器那时选主键。
 *
 * 拆开之后三条都是 status 等值查询，配合 `idx_assets_claimable (status, id,
 * lease_expires_at)` 索引自带 id 序，不再 filesort，`LIMIT 1` 锁到第一条就停手
 * （同样数据下实测 2 把锁，且不随队列长度增长）。
 *
 * 取三条结果里 id 最小的那个，等价于原来的 `OR + ORDER BY id LIMIT 1`——
 * 可领取集合与优先级都没变，两个宿主不分叉。用不上的那几条查询也照跑，
 * 就是为了保住这个「跨三个集合取全局最小 id」的语义；它们多锁的那一行在几微秒后
 * 的 COMMIT 就释放。
 *
 * 第三条（failed 重试）能塞进这个形状，靠的是 `lease_expires_at` 对 failed 行
 * 复用成「最早可再领取时间」（见 `markFailed`）：它与第二条**逐字同形**，走同一条
 * 索引、同样是 status 等值 + id 序 + LIMIT 1，没有新增索引、没有迁移。
 *
 * 它带来的唯一新增成本要说清楚：`lease_expires_at` 在索引里排在 id **之后**，
 * 所以「还没到点」的 failed 行只能靠索引条件下推逐行过滤，而锁定读会把扫过的
 * 索引记录一并锁上。上游长时间出问题、堆了 N 条未到点的 failed 时，这一条查询的
 * 加锁足迹是 O(N) 而不是常数。**不会退化成上面那个"worker 集体收工"的故障**：
 * 被锁住的都是本来就不可领的行，并发 worker 的 pending / expired 两条查询照常出活。
 * 真要按到点时间收窄，得把索引改成 (status, lease_expires_at, id)，而那会把
 * pending 那条查询的 id 序弄丢——那才是不能动的那一头。
 *
 * **与 SQLite 单语句语义唯一残留的差别**：这是三条语句，而 READ COMMITTED 下每条
 * 语句取自己的快照，相互之间不共享。若恰好在两条之间提交了一条 id 更小的可领行，
 * 本轮会领走后一条查出来的那个。**只影响单轮的挑选顺序**——不会重复领取
 * （行锁保证），也不会漏活（那条下一轮就取到了）。写在这里免得将来有人拿它当 bug 查。
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
  // `IS NULL` 那半句是给**本次改动之前**就躺在库里的 failed 行留的：那时 markFailed
  // 写的是 NULL，而 `NULL < ?` 不成立，不带这半句的话那些行会继续永远卡在 failed
  // ——正是这次要修的 bug，只是换成了存量数据，而服务端没有 `mde retry` 那个逃生口。
  // 新写入的 failed 行永远带着时间戳，走不到这个分支。
  const [retryable] = await conn.query<RowDataPacket[]>(
    `SELECT id FROM meeting_assets
      WHERE status='failed' AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [now],
  )
  const ids = [
    pending[0]?.id as number | undefined,
    expired[0]?.id as number | undefined,
    retryable[0]?.id as number | undefined,
  ].filter((v): v is number => v !== undefined)
  return ids.length > 0 ? Math.min(...ids) : undefined
}
