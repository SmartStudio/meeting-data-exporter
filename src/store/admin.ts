import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import type { Pool } from './db'

export interface AdminAccount {
  id: string
  username: string
  passwordHash: string
  createdAt: number
}

export interface AdminSession {
  adminId: string
  expiresAt: number
  /** 签发时刻。与 expiresAt 一起才能还原出"当初签的是多长的窗口"——
   *  AdminAuth.verifySession 靠 expiresAt - createdAt 判断这是不是一个
   *  "记住此设备"的长会话，从而不把短会话悄悄续成长会话（见 src/auth/admin.ts）。 */
  createdAt: number
}

export interface AdminStore {
  countAccounts(): Promise<number>
  findByUsername(username: string): Promise<AdminAccount | null>
  findById(id: string): Promise<AdminAccount | null>
  listAccounts(): Promise<AdminAccount[]>
  createAccount(input: { id: string; username: string; passwordHash: string; now: number }): Promise<void>
  /** 返回是否真的删到了一行（供 handler 判断"账号不存在"与"删成功"） */
  deleteAccount(id: string): Promise<boolean>
  createSession(input: { tokenHash: string; adminId: string; expiresAt: number; now: number }): Promise<void>
  findSessionByTokenHash(tokenHash: string): Promise<AdminSession | null>
  touchSessionExpiry(tokenHash: string, newExpiresAt: number): Promise<void>
  deleteSession(tokenHash: string): Promise<void>
  /** 账号被移除时级联撤销；返回撤销的会话数（仅用于日志，非行为依据） */
  deleteSessionsByAdminId(adminId: string): Promise<number>
}

interface AdminAccountRow extends RowDataPacket {
  id: string
  username: string
  password_hash: string
  created_at: number
}

interface AdminSessionRow extends RowDataPacket {
  admin_id: string
  expires_at: number
  created_at: number
}

interface CountRow extends RowDataPacket {
  cnt: number
}

function mapAdminAccountRow(r: AdminAccountRow): AdminAccount {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    createdAt: Number(r.created_at),
  }
}

function mapAdminSessionRow(r: AdminSessionRow): AdminSession {
  return {
    adminId: r.admin_id,
    expiresAt: Number(r.expires_at),
    createdAt: Number(r.created_at),
  }
}

export function createAdminStore(pool: Pool): AdminStore {
  return {
    async countAccounts() {
      const [rows] = await pool.execute<CountRow[]>(`SELECT COUNT(*) AS cnt FROM admin_accounts`)
      return Number(rows[0]?.cnt ?? 0)
    },

    async findByUsername(username) {
      const [rows] = await pool.execute<AdminAccountRow[]>(
        `SELECT id, username, password_hash, created_at
           FROM admin_accounts
          WHERE username = ?`,
        [username],
      )
      const r = rows[0]
      return r ? mapAdminAccountRow(r) : null
    },

    async findById(id) {
      const [rows] = await pool.execute<AdminAccountRow[]>(
        `SELECT id, username, password_hash, created_at
           FROM admin_accounts
          WHERE id = ?`,
        [id],
      )
      const r = rows[0]
      return r ? mapAdminAccountRow(r) : null
    },

    async listAccounts() {
      // 按创建时间升序、id 兜底 tie-break：列表顺序需确定性（同一批建号时
      // created_at 可能相同），不能依赖查询计划的偶然顺序。
      const [rows] = await pool.execute<AdminAccountRow[]>(
        `SELECT id, username, password_hash, created_at
           FROM admin_accounts
          ORDER BY created_at ASC, id ASC`,
      )
      return rows.map(mapAdminAccountRow)
    },

    async createAccount({ id, username, passwordHash, now }) {
      // 普通 INSERT：username 唯一冲突直接抛出，不做 upsert（账号是被人为创建的，
      // 撞名应当被感知而不是静默覆盖）
      await pool.execute(
        `INSERT INTO admin_accounts (id, username, password_hash, created_at)
         VALUES (?, ?, ?, ?)`,
        [id, username, passwordHash, now],
      )
    },

    async deleteAccount(id) {
      const [result] = await pool.execute<ResultSetHeader>(
        `DELETE FROM admin_accounts WHERE id = ?`,
        [id],
      )
      return result.affectedRows === 1
    },

    async createSession({ tokenHash, adminId, expiresAt, now }) {
      // 普通 INSERT：token_hash 唯一冲突直接抛出，不做 upsert
      await pool.execute(
        `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
        [tokenHash, adminId, expiresAt, now],
      )
    },

    async findSessionByTokenHash(tokenHash) {
      const [rows] = await pool.execute<AdminSessionRow[]>(
        `SELECT admin_id, expires_at, created_at
           FROM admin_sessions
          WHERE token_hash = ?`,
        [tokenHash],
      )
      const r = rows[0]
      return r ? mapAdminSessionRow(r) : null
    },

    async touchSessionExpiry(tokenHash, newExpiresAt) {
      await pool.execute(
        `UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?`,
        [newExpiresAt, tokenHash],
      )
    },

    async deleteSession(tokenHash) {
      await pool.execute(`DELETE FROM admin_sessions WHERE token_hash = ?`, [tokenHash])
    },

    async deleteSessionsByAdminId(adminId) {
      const [result] = await pool.execute<ResultSetHeader>(
        `DELETE FROM admin_sessions WHERE admin_id = ?`,
        [adminId],
      )
      return result.affectedRows
    },
  }
}
