import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import type { Pool } from './db'

export interface DeviceAuth {
  deviceCode: string
  userCode: string
  state: string
  status: string
  wecomUserId: string | null
  tmUserId: string | null
  expiresAt: number
  lastPolledAt: number | null
  createdAt: number
}

export interface RefreshTokenRecord {
  id: number
  tokenHash: string
  wecomUserId: string
  tmUserId: string
  familyId: string
  revoked: boolean
  expiresAt: number
  createdAt: number
}

export interface ServiceAccount {
  id: string
  name: string
  secretHash: string
  tmUserId: string
  enabled: boolean
  expiresAt: number | null
  createdAt: number
}

export interface IdentityMapping {
  wecomUserId: string
  tmUserId: string
  email: string | null
  updatedAt: number
}

export interface AuthStore {
  createDeviceAuth(input: {
    deviceCode: string
    userCode: string
    state: string
    expiresAt: number
    now: number
  }): Promise<void>

  findByState(state: string): Promise<DeviceAuth | null>

  /**
   * 仅对 status = 'pending' 的记录生效，返回 affectedRows === 1。
   * 这个条件是防重放的关键：已授权的 state 再次提交将影响 0 行，返回 false。
   */
  authorize(state: string, wecomUserId: string, tmUserId: string): Promise<boolean>

  /**
   * 设备端轮询：记录本次轮询（写入 last_polled_at = now），返回的是
   * 【本次轮询之前】查到的状态——尤其是 last_polled_at，返回的是上一次
   * 轮询的时间，而不是本次的 now。调用方（device.ts 的限速判断）依赖的
   * 正是「上一次轮询是什么时候」这个信息；如果把返回值里的 last_polled_at
   * 也替换成本次的 now，这个信息就永久丢失，字段就失去了意义。
   */
  pollDevice(deviceCode: string, now: number): Promise<DeviceAuth | null>

  saveRefreshToken(input: {
    tokenHash: string
    wecomUserId: string
    tmUserId: string
    familyId: string
    expiresAt: number
    now: number
  }): Promise<void>

  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>

  /** 吊销整条轮换链（refresh token 复用检测后的连坐吊销） */
  revokeFamily(familyId: string): Promise<number>

  findServiceAccount(id: string): Promise<ServiceAccount | null>

  lookupIdentityMap(wecomUserId: string): Promise<IdentityMapping | null>

  lookupIdentityByEmail(email: string): Promise<IdentityMapping | null>
}

interface DeviceAuthRow extends RowDataPacket {
  device_code: string
  user_code: string
  state: string
  status: string
  wecom_userid: string | null
  tm_userid: string | null
  expires_at: number
  last_polled_at: number | null
  created_at: number
}

interface RefreshTokenRow extends RowDataPacket {
  id: number
  token_hash: string
  wecom_userid: string
  tm_userid: string
  family_id: string
  revoked: number
  expires_at: number
  created_at: number
}

interface ServiceAccountRow extends RowDataPacket {
  id: string
  name: string
  secret_hash: string
  tm_userid: string
  enabled: number
  expires_at: number | null
  created_at: number
}

interface IdentityMapRow extends RowDataPacket {
  wecom_userid: string
  tm_userid: string
  email: string | null
  updated_at: number
}

function mapDeviceAuthRow(r: DeviceAuthRow): DeviceAuth {
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    state: r.state,
    status: r.status,
    wecomUserId: r.wecom_userid,
    tmUserId: r.tm_userid,
    expiresAt: Number(r.expires_at),
    lastPolledAt: r.last_polled_at === null ? null : Number(r.last_polled_at),
    createdAt: Number(r.created_at),
  }
}

function mapRefreshTokenRow(r: RefreshTokenRow): RefreshTokenRecord {
  return {
    id: Number(r.id),
    tokenHash: r.token_hash,
    wecomUserId: r.wecom_userid,
    tmUserId: r.tm_userid,
    familyId: r.family_id,
    revoked: r.revoked === 1,
    expiresAt: Number(r.expires_at),
    createdAt: Number(r.created_at),
  }
}

function mapServiceAccountRow(r: ServiceAccountRow): ServiceAccount {
  return {
    id: r.id,
    name: r.name,
    secretHash: r.secret_hash,
    tmUserId: r.tm_userid,
    enabled: r.enabled === 1,
    expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    createdAt: Number(r.created_at),
  }
}

function mapIdentityMapRow(r: IdentityMapRow): IdentityMapping {
  return {
    wecomUserId: r.wecom_userid,
    tmUserId: r.tm_userid,
    email: r.email,
    updatedAt: Number(r.updated_at),
  }
}

export function createAuthStore(pool: Pool): AuthStore {
  return {
    async createDeviceAuth({ deviceCode, userCode, state, expiresAt, now }) {
      // 普通 INSERT：user_code / state 的唯一冲突要直接抛出，碰撞应当被感知，不可静默重试
      await pool.execute(
        `INSERT INTO device_authorizations
           (device_code, user_code, state, status, expires_at, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
        [deviceCode, userCode, state, expiresAt, now],
      )
    },

    async findByState(state) {
      const [rows] = await pool.execute<DeviceAuthRow[]>(
        `SELECT device_code, user_code, state, status, wecom_userid, tm_userid,
                expires_at, last_polled_at, created_at
           FROM device_authorizations
          WHERE state = ?`,
        [state],
      )
      const r = rows[0]
      return r ? mapDeviceAuthRow(r) : null
    },

    async authorize(state, wecomUserId, tmUserId) {
      // status = 'pending' 条件防重放：已授权的 state 再次提交影响 0 行
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE device_authorizations
            SET status = 'authorized', wecom_userid = ?, tm_userid = ?
          WHERE state = ? AND status = 'pending'`,
        [wecomUserId, tmUserId, state],
      )
      return result.affectedRows === 1
    },

    async pollDevice(deviceCode, now) {
      const [rows] = await pool.execute<DeviceAuthRow[]>(
        `SELECT device_code, user_code, state, status, wecom_userid, tm_userid,
                expires_at, last_polled_at, created_at
           FROM device_authorizations
          WHERE device_code = ?`,
        [deviceCode],
      )
      const r = rows[0]
      if (!r) return null
      await pool.execute(
        `UPDATE device_authorizations SET last_polled_at = ? WHERE device_code = ?`,
        [now, deviceCode],
      )
      // 返回 UPDATE 之前 SELECT 到的原始行：调用方需要的是「上一次轮询的时间」，
      // 把它替换成本次的 now 会让限速判断的差值恒为 0，永远触发 slow_down。
      return mapDeviceAuthRow(r)
    },

    async saveRefreshToken({ tokenHash, wecomUserId, tmUserId, familyId, expiresAt, now }) {
      // 普通 INSERT：token_hash 唯一冲突直接抛出
      await pool.execute(
        `INSERT INTO refresh_tokens
           (token_hash, wecom_userid, tm_userid, family_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tokenHash, wecomUserId, tmUserId, familyId, expiresAt, now],
      )
    },

    async findRefreshToken(tokenHash) {
      const [rows] = await pool.execute<RefreshTokenRow[]>(
        `SELECT id, token_hash, wecom_userid, tm_userid, family_id, revoked, expires_at, created_at
           FROM refresh_tokens
          WHERE token_hash = ?`,
        [tokenHash],
      )
      const r = rows[0]
      return r ? mapRefreshTokenRow(r) : null
    },

    async revokeFamily(familyId) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE refresh_tokens SET revoked = 1 WHERE family_id = ?`,
        [familyId],
      )
      return result.affectedRows
    },

    async findServiceAccount(id) {
      const [rows] = await pool.execute<ServiceAccountRow[]>(
        `SELECT id, name, secret_hash, tm_userid, enabled, expires_at, created_at
           FROM service_accounts
          WHERE id = ?`,
        [id],
      )
      const r = rows[0]
      return r ? mapServiceAccountRow(r) : null
    },

    async lookupIdentityMap(wecomUserId) {
      const [rows] = await pool.execute<IdentityMapRow[]>(
        `SELECT wecom_userid, tm_userid, email, updated_at
           FROM identity_map
          WHERE wecom_userid = ?`,
        [wecomUserId],
      )
      const r = rows[0]
      return r ? mapIdentityMapRow(r) : null
    },

    // identity_map.email 没有唯一约束（仅普通索引），且表使用 utf8mb4_unicode_ci
    // 排序规则（大小写不敏感），碰撞面比预期大（离职员工邮箱回收、身份同步竞态写入
    // 都可能产生重复 email）。这里的结果直接决定策略引擎按谁的身份判权限，多条命中
    // 时必须有确定性排序，不能依赖查询计划的偶然顺序——否则可能把甲的操作权限记到
    // 乙头上，造成越权。约定语义为「最新的映射生效」：按 updated_at 降序取最新一条，
    // updated_at 相同时以 wecom_userid 升序做稳定 tie-break。
    async lookupIdentityByEmail(email) {
      const [rows] = await pool.execute<IdentityMapRow[]>(
        `SELECT wecom_userid, tm_userid, email, updated_at
           FROM identity_map
          WHERE email = ?
          ORDER BY updated_at DESC, wecom_userid ASC
          LIMIT 1`,
        [email],
      )
      const r = rows[0]
      return r ? mapIdentityMapRow(r) : null
    },
  }
}
