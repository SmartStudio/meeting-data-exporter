import mysql from 'mysql2/promise'
import { runMigrations, type Pool } from '../../src/store/db'

/**
 * store 层不 mock 数据库——这一层的价值几乎全在 SQL 语义里
 * （唯一约束冲突、affectedRows、JSON 列往返），mock 掉等于没测。
 *
 * MySQL 没有 PostgreSQL 的 schema 概念，用独立 database 做隔离。
 * 需要 TEST_DATABASE_URL 指向一个有 CREATE DATABASE 权限的实例。
 */
/**
 * 取测试库连接串，未设置时给一句**说得清**的错。
 *
 * 单独导出而不是留在 withTestDb 里，是因为有的用例需要自己建池
 * （例如验证连接池耗尽时的表现，那要传非默认的 queueLimit），直接读
 * `process.env.TEST_DATABASE_URL!` 会在未设置时抛一句 mysql 内部错误，
 * 把「没配测试库」伪装成「数据库有问题」。全局约束里记的「未设该变量时有 28 个
 * 网关库失败」也会因此变成原因不明的更多条。
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL not set')
  return url
}

export async function withTestDb(): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const url = requireTestDatabaseUrl()

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
