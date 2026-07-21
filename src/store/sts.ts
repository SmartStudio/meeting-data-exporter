import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import type { Pool } from './db'

export interface StsTokenRecord {
  reqId: string
  tokenCipher: string
  expireTs: number
}

export interface StsStore {
  createRequest(reqId: string, now: number): Promise<void>
  fulfill(reqId: string, tokenCipher: string, expireTs: number, now: number): Promise<void>
  /** 返回当前有效且过期最晚的 token；无有效 token 时返回 null */
  getActive(now: number): Promise<StsTokenRecord | null>
  expireStale(now: number): Promise<number>
  /** 是否存在「未超陈旧窗口（1h）」的在途 pending 申请，用于 ensureFresh 去重 */
  hasRecentPending(now: number): Promise<boolean>
}

interface StsRow extends RowDataPacket {
  req_id: string
  token_cipher: string
  expire_ts: number
}

export function createStsStore(pool: Pool): StsStore {
  return {
    async createRequest(reqId, now) {
      // INSERT IGNORE 等价于 PostgreSQL 的 ON CONFLICT DO NOTHING
      await pool.execute(
        `INSERT IGNORE INTO sts_token_requests (req_id, state, requested_at)
         VALUES (?, 'pending', ?)`,
        [reqId, now],
      )
    },

    async fulfill(reqId, tokenCipher, expireTs, now) {
      // MySQL 无 RETURNING，用 affectedRows 判断记录是否存在
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE sts_token_requests
            SET state = 'fulfilled', token_cipher = ?, expire_ts = ?, fulfilled_at = ?
          WHERE req_id = ?`,
        [tokenCipher, expireTs, now, reqId],
      )
      if (result.affectedRows === 0) throw new Error(`unknown req_id: ${reqId}`)
    },

    async getActive(now) {
      const [rows] = await pool.execute<StsRow[]>(
        `SELECT req_id, token_cipher, expire_ts
           FROM sts_token_requests
          WHERE state = 'fulfilled' AND expire_ts > ?
          ORDER BY expire_ts DESC
          LIMIT 1`,
        [now],
      )
      const r = rows[0]
      return r ? { reqId: r.req_id, tokenCipher: r.token_cipher, expireTs: Number(r.expire_ts) } : null
    },

    async expireStale(now) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE sts_token_requests SET state = 'expired'
          WHERE state = 'pending' AND requested_at < ?`,
        [now - 3600],
      )
      return result.affectedRows
    },

    async hasRecentPending(now) {
      // 与 expireStale 用同一个 1h 陈旧阈值：更早的 pending 视为已废弃（将被
      // expireStale 标记为 expired），不应再阻止发起新申请。
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT 1 FROM sts_token_requests
          WHERE state = 'pending' AND requested_at >= ?
          LIMIT 1`,
        [now - 3600],
      )
      return rows.length > 0
    },
  }
}
