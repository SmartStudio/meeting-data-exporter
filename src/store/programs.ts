import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Pool } from './db'

/**
 * 采集程序（`service_accounts` 表）的控制台侧读写（阶段 4 · T7）。
 *
 * ## 为什么现在才有这个 store
 *
 * 这张表此前只有两个访问点：`src/store/auth.ts` 的 `findServiceAccount`（认证路径，
 * 要读 `secret_hash`）和 `scripts/seed-dev.ts` 里手写的那段 SQL（建号）。spec §4.5 的
 * 「接入新程序」把建号搬进了控制台，于是那段手写 SQL 需要一个有测试、有类型的家。
 *
 * ## 一、读侧的返回值里**没有** `secret_hash` 这个字段
 *
 * 不是「记得别下发」，是**类型上不存在**：`ServiceProgram` 没有这个键，SELECT 也不取
 * 这一列。凭据哈希只有认证路径（`src/auth/service.ts` → `AuthStore.findServiceAccount`）
 * 需要，控制台这一侧从头到尾用不上它。
 *
 * 靠 handler 里一句「passwordHash 绝不出现在响应里」的注释来防（`handlers/console/auth.ts`
 * 的 listAccounts 就是那么写的）在只有一个调用点时够用，但采集授权页会有列表、详情、
 * 向导好几个出口，每个出口都记得挑字段是靠不住的。**在 store 这一层把它摘干净，
 * 下游想漏也漏不出去。**
 *
 * ## 二、`create` 撞 id 时返回 false，**绝不 UPSERT**
 *
 * `seed-dev.ts` 用的是 `ON DUPLICATE KEY UPDATE secret_hash = VALUES(secret_hash)`，
 * 那对一个「重跑即轮换」的开发脚本是对的行为。**控制台这条路上是错的**：
 * 管理员在向导里填了一个已经存在的 id，UPSERT 会把那个**正在跑的采集程序**的凭据
 * 悄悄换掉——旧凭据当场失效、对接方的定时任务开始 401，而管理员那边显示的是
 * 「接入成功，这是你的新凭据」。谁都不会把两件事联系起来。
 *
 * 所以这里靠主键冲突挡回去，由 handler 报 409。**轮换凭据是另一个动作**，
 * 该有自己的端点和自己的审计记录，不能是「建号恰好撞了名字」的副作用。
 */

/**
 * 一个采集程序，控制台视角。
 *
 * 与 `src/store/auth.ts` 的 `ServiceAccount` 是同一张表的两个投影，故意不复用：
 * 那一个带 `secretHash`（认证要）、这一个不带（控制台不要）。合并成一个类型的话，
 * 「不下发哈希」就重新变成一件每个调用点各自记得的事。
 */
export interface ServiceProgram {
  /** 也是采集权限规则（allow 栈）的主体值，见 `scripts/seed-dev.ts` 的文件头 */
  id: string
  name: string
  /** 这个程序调腾讯 API 与留痕时的操作者身份。**不参与策略判定** */
  tmUserId: string
  enabled: boolean
  /** unix 秒；null = 不过期 */
  expiresAt: number | null
  createdAt: number
}

export interface ProgramsStore {
  /** 全部采集程序，顺序稳定（见实现里的 ORDER BY 注释）。spec §4.5 一张卡片一个 */
  list(): Promise<ServiceProgram[]>
  find(id: string): Promise<ServiceProgram | null>
  /**
   * 接入新程序。**id 已存在时返回 false 且一个字节都不改**（见文件头第二节）。
   *
   * 传进来的是**哈希**不是明文：明文只在 handler 那一次响应里出现，不进这一层，
   * 也就不可能被哪个日志或异常栈捎带出去。
   */
  create(input: {
    id: string
    name: string
    secretHash: string
    tmUserId: string
    expiresAt: number | null
    now: number
  }): Promise<boolean>
  /**
   * 停用 / 启用一个程序（阶段 5 · A8，spec §11 缺口 4）。
   * 返回是否真的改到了一行——id 不存在时 false，由 handler 报 404。
   *
   * **停用不动它的授权。** 停用是一个可逆动作，连带删授权会让「停用再启用」
   * 变成一次不可逆的数据丢失（几十场逐会议授权没有地方可以恢复）。
   * 「停用之后取不到数据」由 `src/policy/access.ts` 的 AccessGate 保证，
   * 它在读规则和改写**之前**就因 `enabled = 0` 拒绝。
   */
  setEnabled(id: string, enabled: boolean): Promise<boolean>
  /**
   * 轮换凭据（阶段 5 · A8，spec §11 缺口 4）。返回是否真的改到了一行。
   *
   * 传进来的是**哈希**不是明文，与 `create` 同一个理由：明文只在 handler 那一次
   * 响应里出现，不进这一层，也就不可能被哪个日志或异常栈捎带出去。
   *
   * **没有配套的"再看一次"方法，也不会有。** 库里只有哈希，服务端此后无从还原
   * ——那正是哈希存储的意义。想找回只能再轮换一次。
   */
  rotateSecret(id: string, secretHash: string): Promise<boolean>
}

/** SELECT 列表里**没有 secret_hash**，这是本模块的核心约束，不是省了一列 */
const COLS = 'id, name, tm_userid, enabled, expires_at, created_at'

interface ProgramRow extends RowDataPacket {
  id: string
  name: string
  tm_userid: string
  enabled: number
  expires_at: number | null
  created_at: number
}

function mapRow(r: ProgramRow): ServiceProgram {
  return {
    id: r.id,
    name: r.name,
    tmUserId: r.tm_userid,
    // TINYINT(1) 过来是 0/1。原样下发会让前端拿到一个数字当布尔用，
    // 而 `0` 在 JSON 里既不是 false 也不是 true（`!0` 才是）
    enabled: Number(r.enabled) !== 0,
    // BIGINT 在部分驱动配置下是字符串；expires_at 会参与 `now >= expiresAt` 比较，
    // 字符串比较出来的结果是另一回事
    expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    createdAt: Number(r.created_at),
  }
}

function isDuplicateEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY'
}

export function createProgramsStore(pool: Pool): ProgramsStore {
  return {
    async list() {
      // created_at 升序 = 接入顺序，与 §4.5 卡片从上到下的阅读顺序一致；
      // 同一秒建的两个程序（脚本批量接入时很常见）再按 id 定序——不加第二键的话，
      // 列表顺序会跟着执行计划变，管理员每刷新一次卡片就换个位置
      const [rows] = await pool.execute<ProgramRow[]>(
        `SELECT ${COLS} FROM service_accounts ORDER BY created_at ASC, id ASC`,
      )
      return rows.map(mapRow)
    },

    async find(id) {
      const [rows] = await pool.execute<ProgramRow[]>(
        `SELECT ${COLS} FROM service_accounts WHERE id = ?`,
        [id],
      )
      return rows[0] ? mapRow(rows[0]) : null
    },

    async create(input) {
      try {
        const [res] = await pool.execute<ResultSetHeader>(
          `INSERT INTO service_accounts
             (id, name, secret_hash, tm_userid, enabled, expires_at, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [input.id, input.name, input.secretHash, input.tmUserId, input.expiresAt, input.now],
        )
        return res.affectedRows > 0
      } catch (err) {
        // 主键冲突是**预期内**的一种结果（管理员填了个已存在的 id），不是故障：
        // 返回 false 让 handler 报 409。其余错误照抛——把它们一起吞成 false，
        // 会让一次真正的写库失败显示成「这个 id 已被占用」，管理员换个名字再试，
        // 然后再失败一次，永远查不到原因
        if (isDuplicateEntry(err)) return false
        throw err
      }
    },

    async setEnabled(id, enabled) {
      const [res] = await pool.execute<ResultSetHeader>(
        `UPDATE service_accounts SET enabled = ? WHERE id = ?`,
        [enabled ? 1 : 0, id],
      )
      // affectedRows 而不是 changedRows：把一个已经停用的程序再停用一次，
      // changedRows 是 0 而这一行确实存在。调用方要区分的是「有没有这个程序」，
      // 不是「值有没有变」——用 changedRows 会让重复点一次停用报 404
      return res.affectedRows === 1
    },

    async rotateSecret(id, secretHash) {
      const [res] = await pool.execute<ResultSetHeader>(
        `UPDATE service_accounts SET secret_hash = ? WHERE id = ?`,
        [secretHash, id],
      )
      // 只写 secret_hash 一列：enabled / expires_at / name 一个都不碰。
      // 轮换凭据不该顺手把一个停用的程序启用回来
      return res.affectedRows === 1
    },
  }
}
