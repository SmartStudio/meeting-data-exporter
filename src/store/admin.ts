import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import type { Pool } from './db'

/**
 * 管理员角色（migrations/009，spec §2「角色与权限」）。
 *
 *   admin     全部：改规则、改授权、延长保留、手动触发任务、看内容
 *   readonly  只能看，不能改任何状态
 *
 * 定义放在 store 这一层而不是 `src/auth/admin.ts`：`auth/admin.ts` 已经
 * `import type` 依赖本文件，反向再依赖回去就成了环。这里是它入库的地方，
 * 也是它从库里出来要被折叠的地方，定义跟着数据走。
 */
export type AdminRole = 'admin' | 'readonly'

/**
 * 把库里那一列折成两个取值之一。**除 `'admin'` 之外的一切都是 `readonly`。**
 *
 * 这一列是 VARCHAR(16) 不是 ENUM（见 009 的表头：为了让「将来多一个角色」不必
 * 再开一次 DDL），所以库拦不住手工 UPDATE 写错的值、也拦不住降级回滚留下的
 * 旧角色名。拦得住的只有这里。
 *
 * 方向必须是这一个：认不出来按**最小权限**处理。反过来写（认不出来当 admin）
 * 是一次静默提权，而且它的表现是「一个本该只读的账号能改规则，不会有任何报错」。
 */
export function parseAdminRole(raw: unknown): AdminRole {
  return raw === 'admin' ? 'admin' : 'readonly'
}

export interface AdminAccount {
  id: string
  username: string
  passwordHash: string
  createdAt: number
  /**
   * 角色（migrations/009，spec §2）。**读侧永远是 `admin` / `readonly` 之一**——
   * 库里那一列是 VARCHAR，装得下第三个值，折叠发生在 `mapAdminAccountRow` 里，
   * 走 `parseAdminRole`（认不出来一律 readonly）。下游因此不必各自防一次。
   */
  role: AdminRole
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
  /** `role` 省略 = `'admin'`，与 009 那一列的默认值同一个理由（见迁移表头） */
  createAccount(input: {
    id: string
    username: string
    passwordHash: string
    now: number
    role?: AdminRole
  }): Promise<void>
  /**
   * 换掉密码哈希（阶段 5 · A8，spec §11 缺口 5）。返回是否真的改到了一行——
   * 账号在改密码的这一瞬间被别人删掉是可能的，此时不能当成"改成功了"。
   *
   * 只写 `password_hash` 一列：角色、用户名、建号时刻一个都不碰。
   */
  updatePassword(id: string, passwordHash: string): Promise<boolean>
  /**
   * 换掉角色。返回是否真的改到了一行（语义同 `updatePassword`）。
   *
   * 在这个方法出现之前，角色**只能在建号那一刻定死**：一个只读账号撞上 403 时，
   * 响应里那句「请让管理员把角色改成 admin」在产品里没有任何路径能执行，
   * 只能手工 UPDATE 库。一条指向不存在的操作的提示语比不给提示更糟。
   *
   * 只写 `role` 一列：用户名、密码哈希、建号时刻一个都不碰。
   *
   * **它不判「这是不是最后一个管理员」**——那条判据是 `isLastAdminAccount`，
   * 由调用方在降级前问一次。理由见那个方法。
   */
  updateRole(id: string, role: AdminRole): Promise<boolean>
  /** 返回是否真的删到了一行（供 handler 判断"账号不存在"与"删成功"） */
  deleteAccount(id: string): Promise<boolean>
  /**
   * 这个账号是不是库里**唯一一个** `admin` 角色的账号（US-3.5「不能把自己
   * 锁在外面」）。
   *
   * ## 为什么不是「至少保留一个账号」
   *
   * 从前那条守卫数的是 `countAccounts() <= 1`，**不分角色**。于是库里
   * 1 个 admin + 1 个 readonly 时，那个 admin 删掉自己是放行的（2 > 1）。
   * 删完之后：19 条写端点全部要 admin 角色，没人能写；建号本身就是写端点，
   * 没人能建号；`scripts/admin-bootstrap.ts` 只在空表时可用，而表里还躺着
   * 那个 readonly——**系统进入一个没有任何产品路径能退出的状态**，
   * 正是这条验收标准要防的那件事。
   *
   * ## 为什么删号与降级共用这一个方法
   *
   * 「删掉最后一个 admin」与「把最后一个 admin 降成 readonly」的后果一模一样。
   * 两条路径各写一份判据，迟早分叉——而分叉的方向一定是「有一条忘了拦」。
   *
   * ## 为什么在 TS 里折叠角色，而不是 `WHERE role = 'admin'`
   *
   * 这一列是 VARCHAR，MySQL 默认排序规则又不区分大小写：一行手工写成
   * `'ADMIN'` 的记录会被 SQL 数成第二个管理员，而 `parseAdminRole`
   * （`=== 'admin'`）把它折成 readonly——它一个写端点都调不动。两处不一致的
   * 代价正好落在最坏的方向：真正的最后一个管理员被当成「还有别人」放走。
   * 判据必须与**认证链上那份折叠**是同一份，所以这里把行读出来，用同一个函数折。
   * 表的规模是运维人员数（十几行），全表扫一次不值得为它引入第二套判定。
   *
   * ## 它不是原子的
   *
   * 两个管理员在同一瞬间各删掉对方，两次调用都可能看到「还有别人」。
   * 这个窗口在旧守卫里同样存在，本次不扩大也不收窄它；真要根除得靠一次
   * 带 `FOR UPDATE` 的事务，而账号变更是人手点出来的低频操作，
   * 为它常驻一条独占连接不划算。
   */
  isLastAdminAccount(id: string): Promise<boolean>
  createSession(input: { tokenHash: string; adminId: string; expiresAt: number; now: number }): Promise<void>
  findSessionByTokenHash(tokenHash: string): Promise<AdminSession | null>
  touchSessionExpiry(tokenHash: string, newExpiresAt: number): Promise<void>
  deleteSession(tokenHash: string): Promise<void>
  /** 账号被移除时级联撤销；返回撤销的会话数（仅用于日志，非行为依据） */
  deleteSessionsByAdminId(adminId: string): Promise<number>
  /**
   * 改密码之后吊销**其它**会话（阶段 5 · A8，spec §11 缺口 5），返回撤销条数。
   *
   * `keepTokenHash` 是发起这次改密的那一条。留着它是刻意的：全撤的话，用户
   * 改完密码的下一个请求就是 401，界面把一次成功的操作显示成"被踢出去了"，
   * 于是没有人敢改第二次。要被撤的是**别处**那些还拿着旧密码换来的会话。
   */
  deleteSessionsByAdminIdExcept(adminId: string, keepTokenHash: string): Promise<number>
}

interface AdminAccountRow extends RowDataPacket {
  id: string
  username: string
  password_hash: string
  created_at: number
  role: string
}

/** `isLastAdminAccount` 用的窄行：判「还剩几个管理员」只需要 id 与角色两列 */
interface AdminRoleRow extends RowDataPacket {
  id: string
  role: string
}

/** 四个 SELECT 共用同一份列清单——漏掉 `role` 的那一条会静默地把账号读成只读 */
const ACCOUNT_COLS = 'id, username, password_hash, created_at, `role`'

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
    role: parseAdminRole(r.role),
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
        `SELECT ${ACCOUNT_COLS}
           FROM admin_accounts
          WHERE username = ?`,
        [username],
      )
      const r = rows[0]
      return r ? mapAdminAccountRow(r) : null
    },

    async findById(id) {
      const [rows] = await pool.execute<AdminAccountRow[]>(
        `SELECT ${ACCOUNT_COLS}
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
        `SELECT ${ACCOUNT_COLS}
           FROM admin_accounts
          ORDER BY created_at ASC, id ASC`,
      )
      return rows.map(mapAdminAccountRow)
    },

    async createAccount({ id, username, passwordHash, now, role }) {
      // 普通 INSERT：username 唯一冲突直接抛出，不做 upsert（账号是被人为创建的，
      // 撞名应当被感知而不是静默覆盖）
      //
      // role 显式写进 INSERT 而不是靠列默认值：漏传时这里补 'admin'，与 009 的
      // DEFAULT 是同一个值。两处同值不是重复——列默认值管的是「009 之前建的行」，
      // 这里管的是「今天新建的行」，缺一个都会让另一条路径上的账号角色不明。
      await pool.execute(
        `INSERT INTO admin_accounts (id, username, password_hash, created_at, \`role\`)
         VALUES (?, ?, ?, ?, ?)`,
        [id, username, passwordHash, now, role ?? 'admin'],
      )
    },

    async updatePassword(id, passwordHash) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE admin_accounts SET password_hash = ? WHERE id = ?`,
        [passwordHash, id],
      )
      // affectedRows 而不是 changedRows：新旧哈希理论上可能相同（argon2id 带盐，
      // 实际不会），而"改到了这一行"才是调用方要问的事
      return result.affectedRows === 1
    },

    async updateRole(id, role) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE admin_accounts SET \`role\` = ? WHERE id = ?`,
        [role, id],
      )
      // affectedRows 而不是 changedRows：把角色改成它已经是的那个值，
      // changedRows 会是 0，而调用方问的是"这一行还在不在"
      return result.affectedRows === 1
    },

    async deleteAccount(id) {
      const [result] = await pool.execute<ResultSetHeader>(
        `DELETE FROM admin_accounts WHERE id = ?`,
        [id],
      )
      return result.affectedRows === 1
    },

    async isLastAdminAccount(id) {
      // 只取 id 与 role 两列：这里不需要密码哈希，读出来只是让它多在内存里
      // 待一会儿。折叠用 parseAdminRole，理由写在接口那一侧
      const [rows] = await pool.execute<AdminRoleRow[]>(
        'SELECT id, `role` FROM admin_accounts',
      )
      const adminIds = rows.filter((r) => parseAdminRole(r.role) === 'admin').map((r) => r.id)
      // 恰好一个、且就是它。零个管理员时回 false：那种库（只剩只读账号）已经
      // 没有什么可保护的了，把删除也拦下来只会连"清空表之后用 admin-bootstrap
      // 重建"这条唯一的出路一起堵死
      return adminIds.length === 1 && adminIds[0] === id
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

    async deleteSessionsByAdminIdExcept(adminId, keepTokenHash) {
      const [result] = await pool.execute<ResultSetHeader>(
        `DELETE FROM admin_sessions WHERE admin_id = ? AND token_hash <> ?`,
        [adminId, keepTokenHash],
      )
      return result.affectedRows
    },
  }
}
