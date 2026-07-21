import mysql from 'mysql2/promise'
import { runMigrations, type Pool } from '../../src/store/db'

/**
 * store 层不 mock 数据库——这一层的价值几乎全在 SQL 语义里
 * （唯一约束冲突、affectedRows、JSON 列往返），mock 掉等于没测。
 *
 * MySQL 没有 PostgreSQL 的 schema 概念，用独立 database 做隔离。
 * 需要 TEST_DATABASE_URL 指向一个有 CREATE DATABASE 权限的实例。
 */
export async function withTestDb(): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL not set')

  const dbName = `t_${Math.random().toString(36).slice(2, 10)}`
  const admin = await mysql.createConnection({ uri: url, charset: 'utf8mb4' })
  await admin.query(
    `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  )
  await admin.end()

  const base = new URL(url)
  base.pathname = `/${dbName}`
  const pool = await import('../../src/store/db').then((m) => m.createPool(base.toString()))
  await runMigrations(pool)

  return {
    pool,
    cleanup: async () => {
      await pool.end()
      const c = await mysql.createConnection({ uri: url })
      await c.query(`DROP DATABASE \`${dbName}\``)
      await c.end()
    },
  }
}
