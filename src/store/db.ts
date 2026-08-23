import { readdir } from 'node:fs/promises'
import mysql from 'mysql2/promise'

export type Pool = mysql.Pool

/**
 * 池上限。导出是因为**调用方的并发度必须对着它来定**：
 * `store-mysql.ts` 的 `claimNext` 在事务期间独占一条连接，归档 worker 的每个
 * 执行体在最坏交错下还可能同时压着一条未 await 的 `touchProgress`，
 * 所以「执行体数 × 2 ≤ 本上限」是 worker 启动时的硬校验（见 src/worker/index.ts）。
 */
export const POOL_CONNECTION_LIMIT = 10

export interface PoolTuning {
  /**
   * 连接都被占满后，最多允许多少个请求排队等连接。
   *
   * mysql2 的默认是 `0` = **不限队列**，配合默认的 `waitForConnections: true`，
   * 池耗尽的表现是**无限期静默挂起**：没有超时、没有报错、没有日志，进程看起来
   * 活着但一件事都不干。给一个有限值，等于把这种故障从「装死」换成「会喊的错误」。
   *
   * 默认仍是 mysql2 的行为（不限），因为 HTTP 网关那边改成有限值意味着请求高峰
   * 期把「多等一会儿」换成「直接 500」，那是另一个需要单独权衡的决定，不在
   * 归档 worker 的射程内。worker 自己显式传一个有限值。
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
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const dir = `${import.meta.dir}/../../migrations`
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  for (const name of files) {
    const sql = await Bun.file(`${dir}/${name}`).text()
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const stmt of statements) {
      await pool.query(stmt)
    }
  }
}
