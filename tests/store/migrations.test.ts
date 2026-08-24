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
      // 003 的表
      expect(names).toContain('admin_accounts')
      expect(names).toContain('admin_sessions')
      expect(names).toContain('archived_assets')
      expect(names).toContain('meeting_archives')
      expect(names).toContain('system_settings')

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

  test('admin_accounts 的 username 唯一键生效', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [ukRows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'admin_accounts'
            AND index_name = 'uk_admin_username' ORDER BY seq_in_index`,
      )
      const cols = ukRows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(cols).toEqual(['username'])

      // 测试重复插入会报错
      await pool.query(
        `INSERT INTO admin_accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
        ['admin1', 'testuser', 'hash1', Date.now()],
      )
      try {
        await pool.query(
          `INSERT INTO admin_accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
          ['admin2', 'testuser', 'hash2', Date.now()],
        )
        throw new Error('should have failed on duplicate username')
      } catch (e: any) {
        expect(e.message).toMatch(/duplicate|unique/i)
      }
    } finally {
      await cleanup()
    }
  })

  test('admin_sessions 的 token_hash 唯一键生效', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [ukRows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'admin_sessions'
            AND index_name = 'uk_admin_session_token' ORDER BY seq_in_index`,
      )
      const cols = ukRows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(cols).toEqual(['token_hash'])

      // 测试重复插入会报错
      await pool.query(
        `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
        ['token_hash_1', 'admin1', Date.now() + 3600000, Date.now()],
      )
      try {
        await pool.query(
          `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
          ['token_hash_1', 'admin2', Date.now() + 3600000, Date.now()],
        )
        throw new Error('should have failed on duplicate token_hash')
      } catch (e: any) {
        expect(e.message).toMatch(/duplicate|unique/i)
      }
    } finally {
      await cleanup()
    }
  })

  test('archived_assets 的自然键唯一性生效', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [pkRows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'archived_assets'
            AND index_name = 'PRIMARY' ORDER BY seq_in_index`,
      )
      const cols = pkRows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(cols).toEqual(['meeting_id', 'sub_meeting_id', 'asset_type', 'remote_id', 'file_type'])

      // 测试重复插入会报错
      await pool.query(
        `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['meet1', '', 'video', 'remote1', 'mp4', 'local.mp4', 'nas.mp4', 'hash1', Date.now()],
      )
      try {
        await pool.query(
          `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ['meet1', '', 'video', 'remote1', 'mp4', 'local2.mp4', 'nas2.mp4', 'hash2', Date.now()],
        )
        throw new Error('should have failed on duplicate natural key')
      } catch (e: any) {
        expect(e.message).toMatch(/duplicate|unique/i)
      }
    } finally {
      await cleanup()
    }
  })

  test('meeting_archives 的主键和索引存在', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [pkRows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'meeting_archives'
            AND index_name = 'PRIMARY' ORDER BY seq_in_index`,
      )
      const pkCols = pkRows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(pkCols).toEqual(['meeting_id', 'sub_meeting_id'])

      const [idxRows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'meeting_archives'
            AND index_name = 'idx_archives_expiry' ORDER BY seq_in_index`,
      )
      const idxCols = idxRows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(idxCols).toEqual(['local_purged_at', 'archived_at'])
    } finally {
      await cleanup()
    }
  })

  test('system_settings 的主键存在', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [pkRows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'system_settings'
            AND index_name = 'PRIMARY' ORDER BY seq_in_index`,
      )
      const cols = pkRows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(cols).toEqual(['setting_key'])
    } finally {
      await cleanup()
    }
  })
})
