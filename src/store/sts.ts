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
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE sts_token_requests
            SET state = 'fulfilled', token_cipher = ?, expire_ts = ?, fulfilled_at = ?
          WHERE req_id = ?`,
        [tokenCipher, expireTs, now, reqId],
      )
      if (result.affectedRows > 0) return

      // affectedRows === 0 有两种成因，必须分开处理：
      //
      // 1. 该 req_id 根本不存在——不是我们发起的申请，必须显式报错，不能静默接受
      //    一个来路不明的 STS-Token。
      // 2. 行存在但**没有任何列发生变化**——MySQL 的 affectedRows 统计的是实际
      //    变更的行数（非 CLIENT_FOUND_ROWS 语义），重复投递同一份回调时
      //    state/token_cipher/expire_ts/fulfilled_at 全都一样，于是返回 0。
      //
      // 把第 2 种当成第 1 种的代价在真实环境里很具体：腾讯对非 200 响应会在
      // 1/3/6 分钟后各重试一次（《回调服务要求》），而重复投递本就是回调的常态，
      // 于是每次都变成 4 次投递 + 3 条 500 日志。M3.5 联调实测到该现象。
      const [rows] = await pool.execute<StsRow[]>(
        'SELECT req_id, token_cipher, expire_ts FROM sts_token_requests WHERE req_id = ?',
        [reqId],
      )
      if (rows.length === 0) throw new Error(`unknown req_id: ${reqId}`)
      // 行存在 = 已经配对过，重复投递按幂等处理（no-op），让路由层回 200
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
