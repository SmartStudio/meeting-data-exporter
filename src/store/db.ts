import { readdir } from 'node:fs/promises'
import mysql from 'mysql2/promise'

export type Pool = mysql.Pool

/**
 * 池上限。导出是因为**调用方的并发度必须对着它来定**：
 * `store-mysql.ts` 的 `claimNext` 在事务期间独占一条连接，归档 worker 的每个
 * 执行体在下载期间还压着一条未 await 的 `touchProgress`，所以
 * 「执行体数 × 2 ≤ 本上限」是 worker 启动时的硬校验（见 src/worker/index.ts）。
 *
 * ⚠️ **`× 2` 是稳态的典型值，不是最坏值。** `touchProgress` 不被 await，
 * 在途量的真实上界是**无界**的，由 `queueLimit` 兜（见 worker 侧的
 * `poolQueueLimitFor`）。这道硬校验挡的是「稳态就已经配过头」，
 * 挡不住在途堆积——两道闸门管的不是同一件事。
 */
export const POOL_CONNECTION_LIMIT = 10

export interface PoolTuning {
  /**
   * 连接都被占满后，最多允许多少个请求**排队**等连接。
   *
   * mysql2 的默认是 `0` = 不限队列，配合默认的 `waitForConnections: true`，
   * 池耗尽的表现是**无限期静默挂起**：没有超时、没有报错、没有日志，进程看起来
   * 活着但一件事都不干。
   *
   * ⚠️ **它限的是队列长度，不是等待时长**，而 mysql2 **没有取连接超时**。
   * 所以有限的 queueLimit 只能挡住「等待者无界堆积」，**挡不住「已经排上队的
   * 请求无限期地等」**——队列没满时行为与默认值完全一样。谁想靠它保证
   * 「池耗尽会喊出来」，会失望。归档 worker 用它兜的是 fire-and-forget 的
   * `touchProgress` 堆积（见 src/worker/index.ts 的 poolQueueLimitFor）。
   *
   * 而**一旦队列真的满了**，mysql2 对**所有**调用方一律以 `Queue limit reached.`
   * 拒绝，不区分是谁排上来的。对 worker 而言这意味着下一次 `claimNext` 当场抛出
   * ——整轮失败、退出码 1、已领取的行卡在 `running` 直到租约过期。
   * 这道闸门把「无界堆积到 OOM」换成了「一轮当场失败」，**不是**换成了
   * 「继续跑、只是多几行 warn」。
   *
   * 默认仍是 mysql2 的行为（不限），因为 HTTP 网关那边改成有限值意味着请求高峰
   * 期把「多等一会儿」换成「直接 500」，那是另一个需要单独权衡的决定，不在
   * 归档 worker 的射程内。worker 自己显式传一个够得着的有限值。
   */
  queueLimit?: number
}

/**
 * charset 必须显式设为 utf8mb4——MySQL 默认的 utf8 只有 3 字节，
 * 会议主题中的 emoji（4 字节）会插入失败。
 */
export function createPool(databaseUrl: string, tuning: PoolTuning = {}): Pool {
  return mysql.createPool({
    uri: databaseUrl,
    connectionLimit: POOL_CONNECTION_LIMIT,
    queueLimit: tuning.queueLimit ?? 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
  })
}

/**
 * 逐个执行 migrations/ 下的 .sql，按文件名升序（001、002、…）。
 * migration 文件含多条语句，逐条执行（连接池禁用 multipleStatements）。
 *
 * 切分方式是按分号朴素 split，所以 .sql 文件里除语句结束符外不许出现分号，
 * 注释里也不行。
 *
 * **全部语句跑在同一条连接上**，而不是每条各从池里取一条。会话变量（`SET @x`）
 * 与预处理语句（`PREPARE` / `EXECUTE`）都是**会话级**的，换一条连接就全没了。
 * 004 用这套写法实现幂等的条件 DDL（MySQL 的 ADD/DROP COLUMN 没有 IF EXISTS），
 * 靠池「多半会把刚归还的那条连接再发出来」是碰运气，一旦不成立，迁移会以
 * 「@变量是 NULL、条件判空、DDL 静默不执行」的方式失败——查不出来的那一种。
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const dir = `${import.meta.dir}/../../migrations`
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  const conn = await pool.getConnection()
  try {
    for (const name of files) {
      const sql = await Bun.file(`${dir}/${name}`).text()
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      for (const stmt of statements) {
        await conn.query(stmt)
      }
    }
  } finally {
    conn.release()
  }
}
