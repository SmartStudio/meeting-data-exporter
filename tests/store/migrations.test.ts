import { describe, expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'

describe('runMigrations', () => {
  test('执行 migrations 目录下的全部 .sql，不只是 001', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [rows] = await pool.query<any[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`,
      )
      const names = rows.map((r) => (r.table_name ?? r.TABLE_NAME) as string)
      // 001 的表
      expect(names).toContain('policy_rules')
      // 002 的表
      expect(names).toContain('meetings')
      expect(names).toContain('meeting_assets')
      expect(names).toContain('meeting_asset_probes')
    } finally {
      await cleanup()
    }
  })

  test('meeting_assets 的唯一键含 file_type', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [rows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'meeting_assets'
            AND index_name = 'uk_asset' ORDER BY seq_in_index`,
      )
      const cols = rows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(cols).toEqual(['meeting_id', 'sub_meeting_id', 'asset_type', 'remote_id', 'file_type'])
    } finally {
      await cleanup()
    }
  })

  test('migrations 可在同一个库上重复执行且结果一致（幂等）', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      // withTestDb 已经跑过一次 migrations；这里对同一个库再跑一次，
      // 必须成功（CREATE TABLE IF NOT EXISTS）且表结构不变。
      const { runMigrations } = await import('../../src/store/db')
      await runMigrations(pool)
      await runMigrations(pool)

      const [rows] = await pool.query<any[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`,
      )
      const names = rows.map((r) => (r.table_name ?? r.TABLE_NAME) as string)
      expect(names).toContain('meetings')
      expect(names).toContain('meeting_assets')
      expect(names).toContain('meeting_asset_probes')
      expect(names).toContain('policy_rules')

      const [uk] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'meeting_assets'
            AND index_name = 'uk_asset' ORDER BY seq_in_index`,
      )
      const ukCols = uk.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(ukCols).toEqual(['meeting_id', 'sub_meeting_id', 'asset_type', 'remote_id', 'file_type'])
    } finally {
      await cleanup()
    }
  })
})
