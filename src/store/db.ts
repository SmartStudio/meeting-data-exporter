import mysql from 'mysql2/promise'

export type Pool = mysql.Pool

/**
 * charset 必须显式设为 utf8mb4——MySQL 默认的 utf8 只有 3 字节，
 * 会议主题中的 emoji（4 字节）会插入失败。
 */
export function createPool(databaseUrl: string): Pool {
  return mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
  })
}

/** migration 文件含多条语句，逐条执行（连接池禁用 multipleStatements） */
export async function runMigrations(pool: Pool): Promise<void> {
  const file = Bun.file(`${import.meta.dir}/../../migrations/001_init.sql`)
  const sql = await file.text()
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const stmt of statements) {
    await pool.query(stmt)
  }
}
