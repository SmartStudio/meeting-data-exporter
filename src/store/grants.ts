import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Pool } from './db'
import type { StackKind } from '../policy/stacks'

/**
 * 逐会议授权与单场会议的人工改写。表结构与全部设计理由见
 * `migrations/005_meeting_grants.sql` 的表头注释，这里只记与代码有关的几条。
 *
 * 本模块管的是 spec §1.3 三个「与」里的**第一个**：「这场会议授权给了这个程序」。
 * 另外两个（在保留期内 / 规则允许）分别归 `archives.ts` 与 `src/policy/`，
 * 本模块一律不碰——三个条件求交是调用方的事，不是这里的事。
 *
 * 人工改写（§5.4）同样只做存储。「改写优先于所有规则」这层覆盖语义**在引擎之外**，
 * 由求值侧实现，`src/policy/` 下不会因为这张表多一行代码。
 */

/** 改写作用于哪一栈。直接复用 `StackKind` 而不是另抄一份三元组：
 *  两处各写一份字面量早晚会分叉，type-only import 让编译器替我们钉住这条一致性，
 *  运行时不引入对 `src/policy/` 的任何依赖。 */
export type OverrideKind = StackKind

/**
 * 一条授权。
 *
 * `assetTypes` 三态，**读写两侧都不许合并**：
 * - `null` 本条不额外限制资产类型，以规则栈的判定为准
 * - 非空数组 白名单，只授权数组里列的这几类
 * - `[]` 什么都不授权（**不是**「不限制」）
 *
 * `revokedAt` 用 `null` 表示未撤销，库里那一列则是哨兵 `0`——哨兵存在只是为了让
 * 唯一索引真的能挡住第二条生效行（MySQL 唯一索引里 NULL 互不相等），
 * 域模型不必背着它，所以在这里换回 `null`。
 */
export interface MeetingGrant {
  id: number
  meetingId: string
  subMeetingId: string
  programId: string
  assetTypes: string[] | null
  grantedAt: number
  revokedAt: number | null
}

/** 一条人工改写。`effect` 的取值随 `kind` 变：fetch 是 all/skip、allow 是 allow/deny、
 *  archive 是目录模板。这里原样存取，合法性由求值侧的 stacks.ts 判（它已经有一整套
 *  「effect 是脏数据就落到本栈安全侧并记 issues」的处理，本模块不重复一遍）。 */
export interface MeetingOverride {
  id: number
  meetingId: string
  subMeetingId: string
  kind: OverrideKind
  effect: string
  assetTypes: string[] | null
  reason: string
  createdAt: number
  revokedAt: number | null
}

/** 一场会议（含周期性会议的具体场次）。sub_meeting_id 为空串是主场次 */
export interface MeetingKey {
  meetingId: string
  subMeetingId: string
}

export interface GrantsStore {
  /**
   * 把一场会议授权给一个程序，返回当前生效的那一条。
   *
   * 幂等的边界在 `assetTypes` 上：已有生效授权**且资产范围相同**时不插新行，
   * 原样返回旧的。范围不同则是一次**变更**，撤旧行、插新行——不是「已经有了就不管」。
   * 后者在管理员**收窄**白名单时会把这次收窄静默丢弃、让更宽的旧授权继续生效，
   * 那是一次静默放行。
   */
  grant(input: MeetingKey & {
    programId: string
    assetTypes: string[] | null
    now: number
  }): Promise<MeetingGrant>

  /** 撤销一条授权（软删除）。已撤销或从未授权时是无操作，返回 false，不抛错 */
  revoke(meetingId: string, subMeetingId: string, programId: string, now: number): Promise<boolean>

  /** 某程序当前生效的全部授权。spec §4.5 那句「现在可取走 N 场会议」拿它去与
   *  保留期、规则判定求交——本方法只出第一个「与」的那一份集合 */
  listActiveGrantsForProgram(programId: string): Promise<MeetingGrant[]>

  /** 这场会议当前授权给了哪些程序。会议详情抽屉用 */
  listActiveGrantsForMeeting(meetingId: string, subMeetingId: string): Promise<MeetingGrant[]>

  /** 三个「与」的第一个「与」，判定路径用。含 assetTypes */
  findActiveGrant(meetingId: string, subMeetingId: string, programId: string): Promise<MeetingGrant | null>

  /** 写入一条人工改写，返回当前生效的那一条。与 `grant` 同样的幂等边界：
   *  内容完全相同不插新行，任何一项不同都是撤旧插新 */
  putOverride(input: MeetingKey & {
    kind: OverrideKind
    effect: string
    assetTypes: string[] | null
    reason: string
    now: number
  }): Promise<MeetingOverride>

  /** 撤销一条改写。幂等，语义同 `revoke` */
  revokeOverride(meetingId: string, subMeetingId: string, kind: OverrideKind, now: number): Promise<boolean>

  /** 这场会议某一栈当前生效的改写。求值侧按 kind 问的就是这个 */
  findActiveOverride(meetingId: string, subMeetingId: string, kind: OverrideKind): Promise<MeetingOverride | null>

  /** 这场会议当前生效的全部改写，至多三条（每个 kind 一条）。会议详情抽屉用 */
  listActiveOverrides(meetingId: string, subMeetingId: string): Promise<MeetingOverride[]>

  /** 一批会议当前生效的改写，只返回真有改写的那些（没有的会议不占位）。
   *  影响预览（§5.5）要把改写过的会议排除在「会被改变」之外，一场一场查就是 N+1 */
  listActiveOverridesForMeetings(keys: MeetingKey[]): Promise<MeetingOverride[]>
}

// ── 内部工具 ────────────────────────────────────────────────────────────

type Queryable = Pick<Pool, 'execute' | 'query'>

interface GrantRow extends RowDataPacket {
  id: number
  meeting_id: string
  sub_meeting_id: string
  program_id: string
  asset_types: unknown
  granted_at: number
  revoked_at: number
}

interface OverrideRow extends RowDataPacket {
  id: number
  meeting_id: string
  sub_meeting_id: string
  kind: string
  effect: string
  asset_types: unknown
  reason: string
  created_at: number
  revoked_at: number
}

const GRANT_COLS =
  'id, meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at'
const OVERRIDE_COLS =
  'id, meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at'

/**
 * 读 `asset_types` 列。**NULL 与 `[]` 是两个不同的答案，不许合并**，所以不能复用
 * `policy.ts` 的 `parseJsonColumn`——那个函数对 NULL 和解析失败一律给同一个兜底值。
 *
 * 坏数据（不是数组、或根本不是合法 JSON）**抛错**，不落任何一侧默认值：
 * 落到 null（不限制）是静默放行，落到 `[]`（什么都不放行）是没人知道原因的静默拒绝。
 * 本模块自己只会写合法的 JSON 数组，出现坏数据意味着库外有别的写入者或数据损坏，
 * 那是该被看见的事故，与 `archives.ts` 里 `target_path` 为 NULL 时的处理同一个理由。
 */
function parseAssetTypes(value: unknown, where: string): string[] | null {
  if (value === null || value === undefined) return null

  let parsed: unknown = value
  if (typeof value === 'string') {
    // mysql2 对 JSON 列通常已经解析好，但驱动版本差异下可能返回字符串
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`asset_types is not valid JSON (${where}): ${value}`)
    }
  }
  if (parsed === null) return null
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    throw new Error(
      `asset_types must be NULL or a JSON array of strings (${where}), got: ${JSON.stringify(parsed)}`,
    )
  }
  return parsed as string[]
}

function mapGrant(r: GrantRow): MeetingGrant {
  const where = `meeting_grants#${r.id}`
  return {
    id: Number(r.id),
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    programId: r.program_id,
    assetTypes: parseAssetTypes(r.asset_types, where),
    grantedAt: Number(r.granted_at),
    revokedAt: unsentinel(r.revoked_at),
  }
}

function mapOverride(r: OverrideRow): MeetingOverride {
  const where = `meeting_overrides#${r.id}`
  return {
    id: Number(r.id),
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    kind: r.kind as OverrideKind,
    effect: r.effect,
    assetTypes: parseAssetTypes(r.asset_types, where),
    reason: r.reason,
    createdAt: Number(r.created_at),
    revokedAt: unsentinel(r.revoked_at),
  }
}

/** 库里的 0 哨兵换回域模型的 null（「未撤销」） */
function unsentinel(revokedAt: number): number | null {
  const n = Number(revokedAt)
  return n === 0 ? null : n
}

/** 写库时 `null` → SQL NULL，数组 → JSON 文本。`[]` 必须原样落成 `[]`，不能变 NULL */
function serializeAssetTypes(v: string[] | null): string | null {
  return v === null ? null : JSON.stringify(v)
}

/** 两份资产范围是不是同一个意思。null 只等于 null（「不限制」≠「白名单恰好列全」），
 *  数组按集合比（顺序只是录入顺序，不是语义） */
function sameAssetTypes(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((v, i) => v === y[i])
}

function isDuplicateEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY'
}

/**
 * 撤销时如果撞上唯一键，最多把 `revoked_at` 往后让多少格（毫秒）。
 *
 * 撞的原因是同一 (会议, 场次, 主体) 下**另一行**已经在这一毫秒被撤销过
 * （授权→撤销→重新授权→再撤销，两次撤销落在同一毫秒）。真实场景下最多让一两格，
 * 上限只是防止某种没预料到的情形把这里变成死循环。
 */
const REVOKE_MAX_STEPS = 64

/**
 * 撤销一条生效行。返回是否真的撤掉了一行。
 *
 * **绝不允许把唯一键冲突吞掉当无事发生**——那会让一条管理员明确要求撤销的授权
 * 继续生效，是这套东西最不能出的事故。冲突时把 `revoked_at` 让开一格重试：
 * 撤销时刻差 1ms 无伤大雅，丢掉一次撤销才有伤。让满 `REVOKE_MAX_STEPS` 仍不成功
 * 就抛出去——响亮地失败也好过悄悄地没撤。
 *
 * 「重复撤销」（这条已经撤过了）走不到冲突这一步：`WHERE revoked_at = 0` 一行都匹配不上，
 * 天然是无操作，返回 false。
 */
async function revokeActive(
  conn: Queryable,
  sql: string,
  keyParams: (string | number)[],
  now: number,
  where: string,
): Promise<boolean> {
  // now 必须为正：0 正是「未撤销」那个哨兵，用 0 去撤销会写出一行看起来仍然生效的
  // 记录——一次静默的不撤销。负数同理没有意义。宁可当场报错。
  if (!Number.isFinite(now) || now <= 0) {
    throw new Error(`revoke requires a positive timestamp (${where}), got: ${now}`)
  }

  for (let step = 0; step <= REVOKE_MAX_STEPS; step++) {
    try {
      const [res] = await conn.execute<ResultSetHeader>(sql, [now + step, ...keyParams])
      return res.affectedRows > 0
    } catch (err) {
      if (!isDuplicateEntry(err)) throw err
      // 同一毫秒里这个键已经有一行被撤销过，让开一格再试
    }
  }
  throw new Error(
    `failed to revoke after ${REVOKE_MAX_STEPS} timestamp shifts (${where}) — ` +
      'refusing to leave the row active',
  )
}

const REVOKE_GRANT_SQL =
  `UPDATE meeting_grants SET revoked_at = ?
    WHERE meeting_id = ? AND sub_meeting_id = ? AND program_id = ? AND revoked_at = 0`

const REVOKE_OVERRIDE_SQL =
  `UPDATE meeting_overrides SET revoked_at = ?
    WHERE meeting_id = ? AND sub_meeting_id = ? AND kind = ? AND revoked_at = 0`

/**
 * 改写行的三个合法 kind。**与 `StackKind` 逐字一致**，不是巧合：
 * `OverrideKind` 就是 `StackKind` 的别名，这里只是把类型系统的约束落到运行时。
 */
const OVERRIDE_KINDS: ReadonlySet<string> = new Set(['fetch', 'archive', 'allow'])

/**
 * 写入/撤销改写前把 kind 拦一道。TypeScript 管得住我们自己的调用点，管不住
 * 从 HTTP 请求体反序列化出来的值。
 *
 * 为什么必须响亮地抛而不是当无事发生（T7 落地时发现，计划 §3.4 的 D-u）：
 * kind 是改写行上**唯一没有安全侧可落**的字段。
 *   - 填成另一栈：一条 fetch 改写（effect `all`）套到归档栈上时，
 *     `normalizeEffect('archive', 'all')` 会认为 `all` 是一段合法的目录模板，
 *     于是录像被归档进一个叫 all 的目录。求值层复用的那个规范化函数
 *     无从知道这一行原本是为哪一栈写的，拦不住。
 *   - 填成三栈之外：没有任何一栈认领，`indexOverrides` 只能丢掉，
 *     管理员明确做出的决定变成一次界面上毫无痕迹的空操作。
 *
 * 数据库那边还有一条 CHECK（migrations/006）管住绕开本 store 的直接 SQL。
 * 两道都要，因为这是授权中枢。
 */
function assertOverrideKind(kind: string, where: string): void {
  if (!OVERRIDE_KINDS.has(kind)) {
    throw new Error(
      `meeting_overrides.kind must be one of fetch / archive / allow (${where}), got: ${kind}`,
    )
  }
}


/** 在一条连接上开事务跑一段，出错回滚。回滚失败不许盖掉真正的根因
 *  （与 src/worker/store-mysql.ts 的 claimNext 同一种处理）。 */
async function inTransaction<T>(pool: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const out = await fn(conn)
    await conn.commit()
    return out
  } catch (err) {
    try { await conn.rollback() } catch { /* 忽略：根因是 err */ }
    throw err
  } finally {
    conn.release()
  }
}

export function createGrantsStore(pool: Pool): GrantsStore {
  async function selectActiveGrant(
    conn: Queryable, meetingId: string, subMeetingId: string, programId: string, forUpdate = false,
  ): Promise<MeetingGrant | null> {
    const [rows] = await conn.execute<GrantRow[]>(
      `SELECT ${GRANT_COLS} FROM meeting_grants
        WHERE meeting_id = ? AND sub_meeting_id = ? AND program_id = ? AND revoked_at = 0
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [meetingId, subMeetingId, programId],
    )
    return rows[0] ? mapGrant(rows[0]) : null
  }

  async function selectActiveOverride(
    conn: Queryable, meetingId: string, subMeetingId: string, kind: OverrideKind, forUpdate = false,
  ): Promise<MeetingOverride | null> {
    const [rows] = await conn.execute<OverrideRow[]>(
      `SELECT ${OVERRIDE_COLS} FROM meeting_overrides
        WHERE meeting_id = ? AND sub_meeting_id = ? AND kind = ? AND revoked_at = 0
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [meetingId, subMeetingId, kind],
    )
    return rows[0] ? mapOverride(rows[0]) : null
  }

  async function grantOnce(input: Parameters<GrantsStore['grant']>[0]): Promise<MeetingGrant> {
    const { meetingId, subMeetingId, programId, assetTypes, now } = input
    return inTransaction(pool, async (conn) => {
      const existing = await selectActiveGrant(conn, meetingId, subMeetingId, programId, true)
      // 已有生效授权且范围一致：这次调用什么都没改，原样返回，不推进 granted_at
      if (existing && sameAssetTypes(existing.assetTypes, assetTypes)) return existing
      // 范围变了：撤旧插新。不 UPDATE 旧行的 asset_types——那会把「当时授权的是什么范围」
      // 从库里抹掉，审计再也说不出这场会议曾经放行过哪几类
      if (existing) {
        await revokeActive(conn, REVOKE_GRANT_SQL, [meetingId, subMeetingId, programId], now,
          `meeting_grants ${meetingId}/${subMeetingId}/${programId}`)
      }
      const [res] = await conn.execute<ResultSetHeader>(
        `INSERT INTO meeting_grants
           (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [meetingId, subMeetingId, programId, serializeAssetTypes(assetTypes), now],
      )
      const [rows] = await conn.execute<GrantRow[]>(
        `SELECT ${GRANT_COLS} FROM meeting_grants WHERE id = ?`, [res.insertId],
      )
      return mapGrant(rows[0]!)
    })
  }

  async function putOverrideOnce(
    input: Parameters<GrantsStore['putOverride']>[0],
  ): Promise<MeetingOverride> {
    const { meetingId, subMeetingId, kind, effect, assetTypes, reason, now } = input
    return inTransaction(pool, async (conn) => {
      const existing = await selectActiveOverride(conn, meetingId, subMeetingId, kind, true)
      const unchanged = existing
        && existing.effect === effect
        && existing.reason === reason
        && sameAssetTypes(existing.assetTypes, assetTypes)
      if (unchanged) return existing
      if (existing) {
        await revokeActive(conn, REVOKE_OVERRIDE_SQL, [meetingId, subMeetingId, kind], now,
          `meeting_overrides ${meetingId}/${subMeetingId}/${kind}`)
      }
      const [res] = await conn.execute<ResultSetHeader>(
        `INSERT INTO meeting_overrides
           (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [meetingId, subMeetingId, kind, effect, serializeAssetTypes(assetTypes), reason, now],
      )
      const [rows] = await conn.execute<OverrideRow[]>(
        `SELECT ${OVERRIDE_COLS} FROM meeting_overrides WHERE id = ?`, [res.insertId],
      )
      return mapOverride(rows[0]!)
    })
  }

  /**
   * 两个并发调用可能都读到「没有生效行」然后都去插——唯一键会挡下后到的那个。
   * `FOR UPDATE` 在 REPEATABLE READ 下靠间隙锁把它们串起来，但这个池上的隔离级别
   * 未必总是 RR（`src/worker/store-mysql.ts` 的 claimNext 会给连接 arm 一次
   * READ COMMITTED，那条注释预告过「以后有别的事务写入者共用这个池时这句话就有用了」
   * ——本模块就是那个写入者）。所以不依赖间隙锁，撞了就整体重来一次：
   * 那时先到的行已经落库，重来的这次会读到它，走幂等分支或撤旧插新分支。
   */
  async function withDuplicateRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (!isDuplicateEntry(err)) throw err
      return await run()
    }
  }

  return {
    grant: (input) => withDuplicateRetry(() => grantOnce(input)),

    async revoke(meetingId, subMeetingId, programId, now) {
      return revokeActive(pool, REVOKE_GRANT_SQL, [meetingId, subMeetingId, programId], now,
        `meeting_grants ${meetingId}/${subMeetingId}/${programId}`)
    },

    async listActiveGrantsForProgram(programId) {
      const [rows] = await pool.execute<GrantRow[]>(
        `SELECT ${GRANT_COLS} FROM meeting_grants
          WHERE program_id = ? AND revoked_at = 0
          ORDER BY meeting_id, sub_meeting_id`,
        [programId],
      )
      return rows.map(mapGrant)
    },

    async listActiveGrantsForMeeting(meetingId, subMeetingId) {
      const [rows] = await pool.execute<GrantRow[]>(
        `SELECT ${GRANT_COLS} FROM meeting_grants
          WHERE meeting_id = ? AND sub_meeting_id = ? AND revoked_at = 0
          ORDER BY program_id`,
        [meetingId, subMeetingId],
      )
      return rows.map(mapGrant)
    },

    findActiveGrant(meetingId, subMeetingId, programId) {
      return selectActiveGrant(pool, meetingId, subMeetingId, programId)
    },

    // 声明成 async 而不是同步箭头：校验失败要**拒绝 promise**，不是同步抛。
    // 同步抛会绕过调用方的 .catch()，在一个全是 async 方法的接口里制造一个例外
    async putOverride(input) {
      assertOverrideKind(input.kind, `${input.meetingId}/${input.subMeetingId}`)
      return withDuplicateRetry(() => putOverrideOnce(input))
    },

    async revokeOverride(meetingId, subMeetingId, kind, now) {
      // 撤销一个不存在的 kind 会匹配到零行、返回 false——看起来像「本来就没有改写」，
      // 实际是调用方拼错了字段。这条路径上「没撤到」与「不用撤」必须分得开
      assertOverrideKind(kind, `${meetingId}/${subMeetingId}`)
      return revokeActive(pool, REVOKE_OVERRIDE_SQL, [meetingId, subMeetingId, kind], now,
        `meeting_overrides ${meetingId}/${subMeetingId}/${kind}`)
    },

    findActiveOverride(meetingId, subMeetingId, kind) {
      return selectActiveOverride(pool, meetingId, subMeetingId, kind)
    },

    async listActiveOverrides(meetingId, subMeetingId) {
      const [rows] = await pool.execute<OverrideRow[]>(
        `SELECT ${OVERRIDE_COLS} FROM meeting_overrides
          WHERE meeting_id = ? AND sub_meeting_id = ? AND revoked_at = 0
          ORDER BY kind`,
        [meetingId, subMeetingId],
      )
      return rows.map(mapOverride)
    },

    async listActiveOverridesForMeetings(keys) {
      // 空输入必须早退：`IN ()` 是语法错，不是空集合
      if (keys.length === 0) return []
      // 行构造器 IN 需要 mysql2 把嵌套数组展开成 ((a,b),(c,d))，那是 query 的能力，
      // execute 走预处理语句不做这层展开
      const [rows] = await pool.query<OverrideRow[]>(
        `SELECT ${OVERRIDE_COLS} FROM meeting_overrides
          WHERE revoked_at = 0 AND (meeting_id, sub_meeting_id) IN (?)
          ORDER BY meeting_id, sub_meeting_id, kind`,
        [keys.map((k) => [k.meetingId, k.subMeetingId])],
      )
      return rows.map(mapOverride)
    },
  }
}
