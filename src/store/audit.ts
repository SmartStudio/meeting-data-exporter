import type { RowDataPacket } from 'mysql2'
import type { Pool } from './db'

export interface AuditEntry {
  occurredAt: number
  actorType: string
  actorId: string
  action: string
  meetingId: string | null
  assetId: string | null
  assetType: string | null
  decision: 'allow' | 'deny'
  matchedRuleId: number | null
  clientKind: string | null
}

/**
 * 读出来的一条审计记录。比写侧的 `AuditEntry` 多一个自增 `id`——分页要一个稳定的
 * 次序键，`occurred_at` 是调用方给的毫秒时间戳，同一毫秒里挤进几条是常事
 * （一次批量下载就是），只按它排的话翻页会漏行或重行。
 *
 * `decision` 在这里放宽成 `string`，与写侧的 `'allow' | 'deny'` 不同，**这是故意的**：
 * 库里那一列是 VARCHAR，读侧碰上认不出的值时，映成 `allow` 是一次静默放行
 * （界面上那条记录会从红变成正常），映成 `deny` 是冤枉一条真发生过的放行。
 * 两个方向都在编造，所以原样带出，由展示侧决定怎么显示。
 * 同 `policy.ts` 对 `join_op` 脏数据不归一化的口径。
 */
export interface AuditRecord extends Omit<AuditEntry, 'decision'> {
  id: number
  decision: string
}

/**
 * 审计筛选条件（spec §4.10：按操作者 / 类型 / 时间范围筛选，外加把被拒绝的单独挑出来）。
 *
 * 时间范围是**半开区间 `[from, to)`**。闭区间会让「按天翻页」时边界那一毫秒的记录
 * 同时落进相邻两页——审计流里出现一条重复记录，看的人第一反应是「这个操作真做了两次」。
 *
 * `actorTypes` / `actions` 传空数组表示**一条都不匹配**，不是「不筛选」。
 * 「筛选条件为空就返回全部」是这类读侧最常见的静默放大：调用方把一次
 * 「映射之后一个候选都不剩」的结果当成了「没设条件」，于是管理员看到的是全表。
 * 不筛选请传 `undefined`（或整个字段不给）。
 */
export interface AuditQuery {
  actorId?: string
  actorTypes?: readonly string[]
  actions?: readonly string[]
  decision?: 'allow' | 'deny'
  /** 含 */
  from?: number
  /** 不含 */
  to?: number
  limit?: number
  offset?: number
}

export interface AuditPage {
  rows: AuditRecord[]
  total: number
}

/** 会议操作历史（详情抽屉底部）的选项 */
export interface MeetingHistoryOptions {
  /**
   * 只看这个时刻之后的记录（含）。**强烈建议传**——见 `listForMeeting` 的注释：
   * `audit_log` 上没有 `meeting_id` 的索引，不给下界这条查询就是一次全表扫。
   */
  since?: number
  limit?: number
}

/** 写侧。`src/audit/recorder.ts` 只依赖这一个，读侧另有 `AuditQueryStore` */
export interface AuditStore {
  record(entry: AuditEntry): Promise<void>
}

/**
 * 读侧（阶段 4 · T3）。
 *
 * **与写侧分成两个接口，不是把方法追加进 `AuditStore`。** 写侧的唯一消费者
 * `AuditRecorder` 只需要 `record` 一个方法，它的测试替身也只实现这一个；
 * 把读侧塞进同一个接口，等于逼着每一处只写不读的调用点去实现两个用不上的查询
 * ——而那种被迫补出来的实现（`throw new Error('not implemented')` 之类）
 * 一旦哪天真被调用，报出来的会是一个跟审计毫无关系的错。
 */
export interface AuditQueryStore {
  /** 分页筛选。`total` 是**去掉分页后**的命中总数，翻页时不变 */
  query(q?: AuditQuery): Promise<AuditPage>

  /**
   * 一场会议的操作历史，时间倒序。
   *
   * ⚠️ **`audit_log.meeting_id` 这一列有两种语义**（见 `migrations/001_init.sql`
   * 的列注释）：`action='issue_download_url'` 的记录里存的是 `meeting_record_id`
   * （record 维度），其余记录存的才是 `meeting_id`。所以这里**必须两者一起匹配**：
   * 只按 `meeting_id` 查的话，详情抽屉里这场会议的下载记录一条都不显示——
   * 而那恰恰是管理员最想看的几条（谁把这场会议的录像取走了）。
   *
   * record 维度的 ID 由 `meeting_cache` 反查（它是 `meeting_record_id` →
   * `meeting_id` 的唯一映射来源）。
   *
   * **两处已知的边界，都不在本函数能修的范围内：**
   *
   * 1. 缓存未命中时网关会记一条 deny（`http/handlers/meetings.ts` 的 `downloadUrl`），
   *    那一刻 `meeting_cache` 里没有对应行，事后也没有任何地方能把那个
   *    `meeting_record_id` 反查回会议。这类记录只在全局审计流里看得到，
   *    进不了任何一场会议的历史——因为**没有人知道它属于哪一场**，
   *    随便挂到某场会议上才是错的。
   * 2. 不按 `sub_meeting_id` 细分：`audit_log` 根本没有这一列，周期性会议的各场次
   *    在审计里本来就是同一个 `meeting_id`。假装能分是编出来的精度。
   */
  listForMeeting(meetingId: string, opts?: MeetingHistoryOptions): Promise<AuditRecord[]>
}

/** 不给 limit 时的页大小 */
export const AUDIT_DEFAULT_LIMIT = 50
/** 单页硬上限。导出是为了让 HTTP 层能校验并回一句说得清的错，而不是等这里默默钳制 */
export const AUDIT_MAX_LIMIT = 200
/** 会议操作历史的条数上限。抽屉里是一段列表，不分页 */
export const AUDIT_MEETING_HISTORY_LIMIT = 200

const SELECT_COLUMNS = `id, occurred_at, actor_type, actor_id, action, meeting_id,
          asset_id, asset_type, decision, matched_rule, client_kind`

/** 占位符能接的实参。审计查询的每一个条件值不是字符串就是毫秒时间戳，
 *  故意不放宽到 unknown——放宽了就等于把「这个值有没有被拼进 SQL」的检查交出去 */
type SqlParam = string | number

interface AuditSqlRow extends RowDataPacket {
  id: number
  occurred_at: number
  actor_type: string
  actor_id: string
  action: string
  meeting_id: string | null
  asset_id: string | null
  asset_type: string | null
  decision: string
  matched_rule: number | null
  client_kind: string | null
}

interface CountRow extends RowDataPacket {
  total: number
}

interface RecordIdRow extends RowDataPacket {
  meeting_record_id: string
}

function mapRow(r: AuditSqlRow): AuditRecord {
  return {
    id: Number(r.id),
    occurredAt: Number(r.occurred_at),
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    meetingId: r.meeting_id,
    assetId: r.asset_id,
    assetType: r.asset_type,
    decision: r.decision,
    matchedRuleId: r.matched_rule === null ? null : Number(r.matched_rule),
    clientKind: r.client_kind,
  }
}

/**
 * `LIMIT` / `OFFSET` **只能拼进 SQL 文本**，不能走占位符：mysql2 的 `execute()`
 * 按预处理协议发参数，MySQL 8.4 对 `LIMIT ?` 直接回
 * `Incorrect arguments to mysqld_stmt_execute`（本仓库实测）。
 *
 * 于是这两个值是本文件唯一拼进 SQL 的东西，拼之前必须先证明它是整数。
 * 不是整数时**当场抛**而不是退回默认值：`limit: NaN` 悄悄变成 50，调用方会以为
 * 「审计就这么多条」，那是一次看不见的截断。
 */
function safeCount(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`审计查询的 ${name} 必须是整数，收到 ${String(value)}`)
  }
  return Math.min(max, Math.max(min, value))
}

function pushIn(
  conds: string[],
  params: SqlParam[],
  column: string,
  values: readonly string[],
): void {
  // 空集合 = 一条都不匹配。MySQL 的 `IN ()` 是语法错误，所以写成恒假条件。
  // 详见 AuditQuery 的注释：这里绝不能退化成「不加这个条件」。
  if (values.length === 0) {
    conds.push('1 = 0')
    return
  }
  conds.push(`${column} IN (${values.map(() => '?').join(', ')})`)
  params.push(...values)
}

function buildWhere(q: AuditQuery): { clause: string; params: SqlParam[] } {
  const conds: string[] = []
  const params: SqlParam[] = []

  if (q.actorId !== undefined) {
    conds.push('actor_id = ?')
    params.push(q.actorId)
  }
  if (q.actorTypes !== undefined) pushIn(conds, params, 'actor_type', q.actorTypes)
  if (q.actions !== undefined) pushIn(conds, params, 'action', q.actions)
  if (q.decision !== undefined) {
    conds.push('decision = ?')
    params.push(q.decision)
  }
  // occurred_at 上不套任何函数（不做 FROM_UNIXTIME/DATE 之类的转换）：
  // 一旦套上，两个索引的 occurred_at 列就都用不成了，整张审计表退化成全表扫。
  // 时区、按天分桶这些事全部由调用方在传进来之前算成毫秒时间戳。
  if (q.from !== undefined) {
    conds.push('occurred_at >= ?')
    params.push(q.from)
  }
  if (q.to !== undefined) {
    conds.push('occurred_at < ?')
    params.push(q.to)
  }

  return { clause: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '', params }
}

/**
 * 次序键的方向**取决于会走哪个索引**，两个索引在这件事上要求相反。
 * 实测计划（MySQL 8.4，两万行）：
 *
 * | 查询 | ORDER BY | 计划 |
 * | --- | --- | --- |
 * | 带 actor_id | `occurred_at DESC, id DESC` | idx_audit_actor · Backward index scan |
 * | 带 actor_id | `occurred_at DESC, id ASC`  | idx_audit_actor · **Using filesort** |
 * | 不带 actor_id | `occurred_at DESC, id ASC`  | idx_audit_time · 无 filesort |
 * | 不带 actor_id | `occurred_at DESC, id DESC` | idx_audit_time · **Using filesort** |
 *
 * 原因是两个索引的物理顺序不同：`idx_audit_time` 建的是 `(occurred_at DESC)`，
 * InnoDB 在后面接上主键，实际是 `(occurred_at DESC, id ASC)`；
 * `idx_audit_actor (actor_id, occurred_at)` 是升序索引，倒着扫得到的是
 * `(occurred_at DESC, id DESC)`。没有一个方向能同时贴合两者。
 *
 * 带 LIMIT 的 filesort 不会撑爆内存（优先队列），但它**必须先把范围内的行全读出来**
 * 才能排——查一个月就是把这一个月全读一遍，再扔掉 49/50。这正是验收 1 要挡的。
 *
 * 代价写在这里免得以后当 bug 修：**同一毫秒内的几条记录，按操作者筛和不筛时
 * 相对顺序相反**。单次查询内部的顺序是完全确定的（分页需要的就是这个），
 * 跨筛选条件的并列顺序没有任何消费方依赖。
 */
function orderBy(q: AuditQuery): string {
  return q.actorId !== undefined
    ? 'ORDER BY occurred_at DESC, id DESC'
    : 'ORDER BY occurred_at DESC, id ASC'
}

/**
 * 拼出 `query()` 真正执行的那条 SQL。
 *
 * 单独导出是为了让测试能直接对**真正跑的那条语句**做 `EXPLAIN`（验收 1）。
 * 测试里另抄一条等价 SQL 去 EXPLAIN 是自欺：改了实现忘了改测试，测试照样绿。
 */
export function buildAuditQuerySql(q: AuditQuery = {}): { sql: string; params: SqlParam[] } {
  const { clause, params } = buildWhere(q)
  const limit = safeCount('limit', q.limit ?? AUDIT_DEFAULT_LIMIT, 1, AUDIT_MAX_LIMIT)
  const offset = safeCount('offset', q.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)

  return {
    sql: `SELECT ${SELECT_COLUMNS}
            FROM audit_log
            ${clause}
            ${orderBy(q)}
           LIMIT ${limit} OFFSET ${offset}`,
    params,
  }
}

/** 同上，`listForMeeting` 的那条。`meetingIds` 已经把两种语义的 ID 合过了 */
export function buildMeetingHistorySql(
  meetingIds: readonly string[],
  opts: MeetingHistoryOptions = {},
): { sql: string; params: SqlParam[] } {
  const conds: string[] = []
  const params: SqlParam[] = []
  pushIn(conds, params, 'meeting_id', meetingIds)
  if (opts.since !== undefined) {
    conds.push('occurred_at >= ?')
    params.push(opts.since)
  }
  const limit = safeCount(
    'limit',
    opts.limit ?? AUDIT_MEETING_HISTORY_LIMIT,
    1,
    AUDIT_MEETING_HISTORY_LIMIT,
  )

  return {
    // 这条查询没有 actor_id 条件，走的是 idx_audit_time，故次序键取 id ASC（见 orderBy）
    sql: `SELECT ${SELECT_COLUMNS}
            FROM audit_log
           WHERE ${conds.join(' AND ')}
           ORDER BY occurred_at DESC, id ASC
           LIMIT ${limit}`,
    params,
  }
}

export function createAuditStore(pool: Pool): AuditStore & AuditQueryStore {
  return {
    async record(e) {
      await pool.execute(
        `INSERT INTO audit_log
           (occurred_at, actor_type, actor_id, action, meeting_id, asset_id,
            asset_type, decision, matched_rule, client_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [e.occurredAt, e.actorType, e.actorId, e.action, e.meetingId, e.assetId,
         e.assetType, e.decision, e.matchedRuleId, e.clientKind],
      )
    },

    async query(q = {}) {
      const built = buildAuditQuerySql(q)
      const { clause, params } = buildWhere(q)

      // 两条往返而不是一条 SQL_CALC_FOUND_ROWS：后者在 MySQL 8.0.17 起已废弃，
      // 且它逼着优化器算完整个结果集，恰好抵消掉上面为 LIMIT 做的全部索引功夫。
      const [rows] = await pool.execute<AuditSqlRow[]>(built.sql, built.params)
      const [counted] = await pool.execute<CountRow[]>(
        `SELECT COUNT(*) AS total FROM audit_log ${clause}`,
        params,
      )

      return { rows: rows.map(mapRow), total: Number(counted[0]?.total ?? 0) }
    },

    async listForMeeting(meetingId, opts = {}) {
      const [cached] = await pool.execute<RecordIdRow[]>(
        `SELECT meeting_record_id FROM meeting_cache WHERE meeting_id = ?`,
        [meetingId],
      )
      // meetingId 本身永远在集合里：没有任何 meeting_cache 行的会议（缓存是网关
      // 列会议时机会性写的，不保证有）也必须能查出按 meeting_id 记的那些操作。
      const ids = [...new Set([meetingId, ...cached.map((r) => r.meeting_record_id)])]

      const built = buildMeetingHistorySql(ids, opts)
      const [rows] = await pool.execute<AuditSqlRow[]>(built.sql, built.params)
      return rows.map(mapRow)
    },
  }
}
