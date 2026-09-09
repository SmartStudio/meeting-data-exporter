import type { Database } from 'bun:sqlite'
import { meetingPathKey, type Meeting, type AssetStatus, type ProbeState } from '../domain/types'
import { assignDirOrdinals } from '../domain/dir-ordinal'

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

/** 一场会议（精确到场次）。失败项动作作用在这个粒度上，不是单条资产 */
export interface MeetingAssetsKey { meetingId: string; subMeetingId: string }

/** `meetingsForPaths()` 的值：拼目录名要的三列，加上两段主键原文与目录序号 */
export interface MeetingPathRow {
  meetingId: string
  subMeetingId: string
  subject: string | null
  startTime: number | null
  meetingCode: string | null
  endTime: number | null
  /**
   * 这一行**第一次**被写进库的时刻（`meetings.created_at`；两个宿主的
   * `upsertMeeting` 在冲突时都只改 `updated_at`）。目录序号的主序就是它——
   * 晚一轮才被发现的兄弟场次不许把先到者从它的目录里挤走，见 `assignDirOrdinals`。
   */
  createdAt: number
  /**
   * 这条录制记录在**算出同名目录的兄弟记录**中的 1-based 序号，传给
   * `meetingDirPath` 的第三个参数（1 不加后缀，2 起追加 `_<n>`）。
   *
   * 由 `assignDirOrdinals` 在 `meetingsForPaths()` 里**算一次**、随值带走：
   * 序号是一批行之间的关系，单看一行算不出来，而 executor 与 manifest 各自只
   * 拿得到一行。两处若各自去查一遍兄弟，就是同一份规则的第二份实现。
   */
  dirOrdinal: number
}

export interface Store {
  upsertMeeting(m: Meeting, now: number): Promise<void>
  upsertAsset(a: AssetUpsert, now: number): Promise<void>
  /**
   * 领一条可干的活。可领取集合是三类行，取其中 id 最小的那条：
   *
   *   - `pending`：还没人碰过
   *   - `running` 且 `lease_expires_at < now`：上一个执行者崩了，租约过期
   *   - `failed` 且 `lease_expires_at < now`：失败过，退避时间到了（见 `markFailed`）
   *
   * 后两类**形状完全相同**，这是刻意的：MySQL 宿主靠 `(status, id, lease_expires_at)`
   * 这条索引把它们都走成「status 等值 + id 序 + LIMIT 1」，加锁足迹不随队列长度膨胀
   * （见 src/worker/store-mysql.ts 的 `pickClaimable`）。
   */
  claimNext(now: number, leaseSec: number): Promise<AssetRow | null>
  /**
   * 收尾一条下载完成的资产。`bytesWritten` 是 downloader 报回的**真实文件大小**
   * （逐 chunk 累加、且过了尺寸校验那道关），它会覆盖 `touchProgress` 一路写下的
   * 进度检查点——**一个 completed 行的 `bytes_written` 从此就是文件大小**。
   * 语义边界与它为什么值得信，见 domain/manifest.ts 里 `bytes` 字段的注释。
   */
  markCompleted(id: number, contentHash: string | null, bytesWritten: number, now: number): Promise<void>
  /**
   * 一次下载没成，但还没到放弃的时候。
   *
   * `retryAt` 写进 `lease_expires_at`——**这一列对 `failed` 行的含义是「最早什么
   * 时候可以再被领取」**，不是租约。同一列在三种状态下三种读法：
   *
   *   - `running`  ：租约到期时间（过了就认为执行者死了，可以抢）
   *   - `failed`   ：重试不早于此时（本次改动新增）
   *   - 终态       ：NULL（completed / skipped / dead）
   *
   * 复用这一列不是省事：`claimNext` 对「过期的 running」和「到点的 failed」因此
   * 是同一个形状的条件，两者共用 `(status, id, lease_expires_at)` 索引，MySQL 宿主
   * 那边一条领取语句的加锁足迹不变（见 src/worker/store-mysql.ts 的 `pickClaimable`）。
   * 另开一列 `retry_after` 要加迁移、要再加一条索引，换来的语义完全一样。
   *
   * 退避曲线由调用方算好传进来（executor 的 `downloadBackoff`），store 只负责写：
   * 「隔多久重试」是执行策略，不是存储的事，而两个宿主必须用同一条曲线。
   */
  markFailed(id: number, err: string, now: number, retryAt: number): Promise<void>
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
  /**
   * **人工逃生口**：把 failed / dead 一把打回 pending。CLI 的 `mde retry`
   * （client/src/cli/commands/retry.ts）是它唯一的调用方。
   *
   * 它**不是**重试机制——重试是 `markFailed` 的退避 + `claimNext` 到点重领，
   * 自动、逐条、带上限。这个方法存在是为了另一件事：`dead` 是终态，队列再也不会
   * 碰它，而「上游那会儿抽风、现在好了」只能由人来判断。清掉 `last_error` 与
   * `lease_expires_at`，让这些行回到和新发现的资产一模一样的形状。
   *
   * `attempts` **不清零**（现状，本次没改）：它是「这条资产被领过多少次」的事实。
   * 代价要知道——一条 attempts 已经到 5 的 dead 行被打回来之后只剩**一次**机会，
   * 再失败就直接又是 dead（`claimNext` 领它时 attempts 变 6，越过 MAX_ATTEMPTS）。
   * 对「上游修好了，再试一把」这个用途够用；想要完整的五次，得先想清楚
   * 「重试了几次」这个数字还要不要能对外解释。
   */
  resetFailed(now: number): Promise<number>
  /**
   * 把**一场会议**的 failed / dead 打回队列，返回改了几行（规格 2026-09-09 §2.3）。
   *
   * 与 `resetFailed` 的分工要分清，两者不能互相替代：
   *
   *   - `resetFailed`：**整库**、给 CLI 的 `mde retry`，且刻意**不清** attempts
   *   - 这一个：**一场会议**、由控制台失败项表上的「重试」驱动，**清零** attempts
   *
   * 清零是这条路径的必要条件，不是顺手：一条 attempts 已经到 5 的 dead 行不清零
   * 就打回队列，`claimNext` 领它时 attempts 变 6、越过 MAX_ATTEMPTS，第一次失败
   * 就直接又是 dead。界面上表现为「点了重试，过一会儿它又出现了」——而运维没有
   * 任何办法看出这是设计如此。清零之后它拿到的是完整的五次。
   *
   * 按**精确的 (meeting_id, sub_meeting_id)** 筛：周期性会议各场次共用 meeting_id，
   * 只按前一段筛会把别的场次一起打回队列。
   */
  retryMeetingAssets(k: MeetingAssetsKey, now: number): Promise<number>
  /**
   * 把**一场会议**的 dead 判成「不用管了」（`skipped` + `last_error='ignored_by_admin'`），
   * 返回改了几行。
   *
   * 只动 `dead`，不动 `failed`：failed 还在自动退避重试中（`markFailed` 写的
   * lease_expires_at 就是下次可领时间），把它一并按掉等于替队列做了一个它没做的
   * 决定。而 dead 是终态，队列从此不再碰它——「忽略」在那上面才是一个真实的动作。
   *
   * 转 `skipped` 而不是删行：`_manifest.json` 要答得出「哪些资产是确认取不到的、
   * 为什么」，`ignored_by_admin` 就是那个为什么。删掉等于把这场会议的缺口说成
   * 「不知有无」。资产不再是 dead，下一轮 `recordDeadAssets` 也不会再登记它。
   */
  ignoreDeadAssets(k: MeetingAssetsKey, now: number): Promise<number>
  /**
   * 拼落盘路径要用的会议元数据，键为 `meetingPathKey(meeting_id, sub_meeting_id)`。
   *
   * 键是两段的，不是 meeting_id：周期会议的每个场次各有自己的 start_time，也就各有
   * 自己的目录。值里带回 `meetingId` / `subMeetingId` 两段原文，调用方（executor 拼
   * 路径、manifest 逐场写 sidecar）因此不必再去拆键。
   *
   * 新增这个方法不是顺手加功能——`client/src/cli/commands/{run,execute}.ts` 各有一份
   * **逐字重复**的 `loadMeetings(db)`，都绕过 Store 直接查 SQLite 的 `db`，且全程 `any`。
   * 那条路在 MySQL 宿主下根本不存在，必须收进接口。
   */
  meetingsForPaths(): Promise<Map<string, MeetingPathRow>>
  /**
   * 单场会议的完整元数据，按**精确的 (meeting_id, sub_meeting_id)** 取；没有则 null。
   *
   * 与 `meetingsForPaths()` 是两件事，不要用后者代替：那个方法虽然也按两段主键建键，
   * 却刻意只带拼路径用得上的几列，没有 `host_userid`。`meeting.json` 要写的是这一场
   * 会议的全部元数据，只能按真实主键取回整行。
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
  // 三类可领取的行，取 id 最小的那条（语义见 Store.claimNext）。第三条是失败重试：
  // `failed` 行的 lease_expires_at 是 markFailed 写下的「最早可再领取时间」，
  // 所以它与上一条（过期的 running）逐字同形，`?2` 也是同一个 now。
  //
  // `IS NULL` 那半句是给**本次改动之前**就已经躺在库里的 failed 行留的：那时
  // markFailed 写的是 NULL，而 `NULL < ?2` 在 SQL 里是 NULL（不成立），不带这半句
  // 的话那些行会继续永远卡在 failed——正是这次要修的那个 bug，只是换成了存量数据。
  // 新写入的 failed 行永远带着时间戳，走不到这个分支。
  //
  // UPDATE 那一句不用改：它已经是 attempts+1 且重写 lease_expires_at，
  // 一条 failed 行被领走的瞬间就变回带租约的 running。
  const claimStmt = db.query<AssetRow, [number, number, number]>(`
    UPDATE assets SET status='running', lease_expires_at=?1, attempts=attempts+1, updated_at=?3
    WHERE id = (SELECT id FROM assets
                WHERE status='pending'
                   OR (status='running' AND lease_expires_at < ?2)
                   OR (status='failed' AND (lease_expires_at IS NULL OR lease_expires_at < ?2))
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
    // lease_expires_at 在这里写的是**最早可再领取时间**（不是租约），语义见
    // Store.markFailed。MySQL 版逐字同样，别只改一处：只改一边的话，
    // 两个宿主一边会重试一边永远卡死，而且都不报错。
    async markFailed(id, e, now, retryAt) { db.query(`UPDATE assets SET status='failed', last_error=?, lease_expires_at=?, updated_at=? WHERE id=?`).run(e, retryAt, now, id) },
    async markSkipped(id, r, now) { db.query(`UPDATE assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(r, now, id) },
    async markSkippedByKey(k, r, now) { db.query(`UPDATE assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND status NOT IN ('completed','running')`).run(r, now, k.meetingId, k.subMeetingId, k.assetType) }, // 不回退已完成的下载、不中断执行中的任务
    async markDead(id, e, now) { db.query(`UPDATE assets SET status='dead', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(e, now, id) },
    // `AND status='running'`：进度回写在 executor 里是**不 await 的**，一次慢的写库
    // 可以落在 markCompleted 之后。终态行不接受进度回写，否则一个迟到的 8MB 检查点
    // 会盖掉 markCompleted 刚写下的真实文件大小——而那个值会被写进永久留在 NAS 上的
    // 清单（见 domain/manifest.ts 的 bytes 字段注释）。MySQL 版逐字同样，别只改一处。
    async touchProgress(id, bytes, now, leaseSec) { db.query(`UPDATE assets SET bytes_written=?, lease_expires_at=?, updated_at=? WHERE id=? AND status='running'`).run(bytes, now + leaseSec, now, id) },
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
    // lease_expires_at 一并清掉：它对 failed 行是「最早可再领取时间」，行被打回
    // pending 之后那个时间没有任何含义，留着只会让人对着一条 pending 行猜它是不是
    // 还在等什么。三种状态各自的读法见 Store.markFailed。
    async resetFailed(now) { return db.query(`UPDATE assets SET status='pending', last_error=NULL, lease_expires_at=NULL, updated_at=?  WHERE status IN ('failed','dead')`).run(now).changes },
    async retryMeetingAssets(k, now) {
      return db.query(`UPDATE assets SET status='pending', attempts=0, last_error=NULL, lease_expires_at=NULL, updated_at=?
                        WHERE meeting_id=? AND sub_meeting_id=? AND status IN ('failed','dead')`)
        .run(now, k.meetingId, k.subMeetingId).changes
    },
    async ignoreDeadAssets(k, now) {
      return db.query(`UPDATE assets SET status='skipped', last_error='ignored_by_admin', lease_expires_at=NULL, updated_at=?
                        WHERE meeting_id=? AND sub_meeting_id=? AND status='dead'`)
        .run(now, k.meetingId, k.subMeetingId).changes
    },
    async meetingsForPaths() {
      const rows = db.query<{ meeting_id: string; sub_meeting_id: string; subject: string | null;
                              meeting_code: string | null; start_time: number | null; end_time: number | null;
                              created_at: number }, []>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time, created_at FROM meetings`,
      ).all()
      const meetings = rows.map((r) => ({
        meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id,
        subject: r.subject, startTime: r.start_time, meetingCode: r.meeting_code,
        endTime: r.end_time, createdAt: r.created_at,
      }))
      // 目录序号要看到**全部**行才算得出来（同名目录的兄弟是谁），所以在这里算一次、
      // 随值带走。两个宿主共用 assignDirOrdinals，不许各写一份。
      const ordinals = assignDirOrdinals(meetings)
      return new Map(meetings.map((m) => {
        const key = meetingPathKey(m.meetingId, m.subMeetingId)
        // assignDirOrdinals 对每一行都给了值，`?? 1` 只是让类型不带 undefined
        return [key, { ...m, dirOrdinal: ordinals.get(key) ?? 1 }]
      }))
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
