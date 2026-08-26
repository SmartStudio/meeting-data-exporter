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
      // 008 的表（阶段 4 · T11）
      expect(names).toContain('job_runs')
      expect(names).toContain('job_failures')

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

  test('008 给 audit_log 补上 detail 列，且重复执行不报错（ADD COLUMN 没有 IF NOT EXISTS）', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const { runMigrations } = await import('../../src/store/db')
      // 第二遍必须走 information_schema 守卫的 DO 0 分支，而不是撞 ER_DUP_FIELDNAME
      await runMigrations(pool)

      const [cols] = await pool.query<any[]>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'audit_log' AND column_name = 'detail'`,
      )
      expect(cols).toHaveLength(1)
      // TEXT 而不是 VARCHAR(N)：它要装的是「一条规则的全文」/「一句拒绝原因」，
      // 长度由管理员写的内容决定，挑任何一个 N 都是在赌（见 008 表头第四节）
      expect((cols[0].data_type ?? cols[0].DATA_TYPE) as string).toBe('text')
      // 可空：现存记录写下时还没有这一列，NULL 与空串是两回事
      expect((cols[0].is_nullable ?? cols[0].IS_NULLABLE) as string).toBe('YES')
    } finally {
      await cleanup()
    }
  })

  // ── 009（阶段 5 · A8）：admin_accounts 的 role 列 ────────────────────

  test('009 给 admin_accounts 补上 role 列，默认 admin，且重复执行不报错', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const { runMigrations } = await import('../../src/store/db')
      // 第二遍必须走 information_schema 守卫的 DO 0 分支，而不是撞 ER_DUP_FIELDNAME
      await runMigrations(pool)

      const [cols] = await pool.query<any[]>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'admin_accounts'
            AND column_name = 'role'`,
      )
      expect(cols).toHaveLength(1)
      expect((cols[0].data_type ?? cols[0].DATA_TYPE) as string).toBe('varchar')
      expect((cols[0].is_nullable ?? cols[0].IS_NULLABLE) as string).toBe('NO')
      expect((cols[0].column_default ?? cols[0].COLUMN_DEFAULT) as string).toBe('admin')
    } finally {
      await cleanup()
    }
  })

  test('009 的默认值必须是 admin：已有账号不会因为加了一列就全变成只读', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      // 模拟「009 之前建的账号」：不写 role 这一列，让默认值说话
      await pool.execute(
        `INSERT INTO admin_accounts (id, username, password_hash, created_at)
         VALUES ('legacy-1', 'legacy', 'hash', 1000)`,
      )
      // 迁移重跑一遍也不该改动它
      const { runMigrations } = await import('../../src/store/db')
      await runMigrations(pool)

      const [rows] = await pool.query<any[]>(
        `SELECT \`role\` FROM admin_accounts WHERE id = 'legacy-1'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].role as string).toBe('admin')
    } finally {
      await cleanup()
    }
  })

  test('008 只加列、不动任何现有写入方：audit_log 原有的列一个不少', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [cols] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'audit_log'`,
      )
      const names = cols.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      for (const c of [
        'id', 'occurred_at', 'actor_type', 'actor_id', 'action',
        'meeting_id', 'asset_id', 'asset_type', 'decision', 'matched_rule', 'client_kind',
      ]) {
        expect(names).toContain(c)
      }
    } finally {
      await cleanup()
    }
  })

  test('job_failures 的 (job_name, target) 唯一键生效——重复失败是累加不是新增', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const insert = (): Promise<unknown> =>
        pool.execute(
          `INSERT INTO job_failures
             (job_name, target, reason, impact, max_attempts, first_failed_at, last_failed_at)
           VALUES ('archive_nas', 'm-1|', 'x', 'y', 5, 1, 1)`,
        )
      await insert()
      await expect(insert()).rejects.toThrow()
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
      const now = Math.floor(Date.now() / 1000)
      await pool.query(
        `INSERT INTO admin_accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
        ['admin1', 'testuser', 'hash1', now],
      )
      await expect(
        pool.query(
          `INSERT INTO admin_accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
          ['admin2', 'testuser', 'hash2', now],
        ),
      ).rejects.toThrow(/duplicate|unique/i)
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
      const now = Math.floor(Date.now() / 1000)
      const expiresAt = now + 3600
      await pool.query(
        `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
        ['token_hash_1', 'admin1', expiresAt, now],
      )
      await expect(
        pool.query(
          `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
          ['token_hash_1', 'admin2', expiresAt, now],
        ),
      ).rejects.toThrow(/duplicate|unique/i)
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
      const now = Math.floor(Date.now() / 1000)
      await pool.query(
        `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['meet1', '', 'video', 'remote1', 'mp4', 'local.mp4', 'nas.mp4', 'hash1', now],
      )
      await expect(
        pool.query(
          `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ['meet1', '', 'video', 'remote1', 'mp4', 'local2.mp4', 'nas2.mp4', 'hash2', now],
        ),
      ).rejects.toThrow(/duplicate|unique/i)
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

/**
 * 004（阶段 3 · T1）：policy_rules 换成三栈结构，旧行搬进 policy_rules_legacy。
 *
 * 迁移本身要有测试，理由不是「覆盖率」：runMigrations 每次进程启动都会把
 * migrations/ 全跑一遍，004 又是唯一一个会 DROP 现有表的迁移。它幂等这件事
 * 若只靠读代码确认，代价是某次重启把管理员建的规则全清掉——而表现是
 * 「所有采集程序突然什么都取不到」，与「腾讯侧挂了」在现场看起来一模一样。
 */
describe('004 三栈规则模型迁移', () => {
  test('policy_rules 换成三栈结构：新增 kind/join_op/conds/note/created_by，删掉 resource_expr', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [rows] = await pool.query<any[]>(
        `SELECT column_name, data_type, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'policy_rules'`,
      )
      const cols = new Map<string, any>(
        rows.map((r) => [(r.column_name ?? r.COLUMN_NAME) as string, r]),
      )

      for (const name of ['kind', 'join_op', 'conds', 'note', 'created_by']) {
        expect(cols.has(name)).toBe(true)
      }
      // 换表示法，不做双向转换：旧列必须真的不在了，否则两套语义会同时活着
      expect(cols.has('resource_expr')).toBe(false)
      // 保留复用的列
      expect(cols.has('asset_types')).toBe(true)
      expect(cols.has('subject_type')).toBe(true)

      const conds = cols.get('conds')
      expect((conds.data_type ?? conds.DATA_TYPE) as string).toBe('json')

      // archive 栈的 effect 是目录模板，8 字符装不下
      const effect = cols.get('effect')
      expect(Number(effect.character_maximum_length ?? effect.CHARACTER_MAXIMUM_LENGTH)).toBe(255)
    } finally {
      await cleanup()
    }
  })

  test('idx_policy_lookup 改成 (kind, enabled, priority, id)：三栈各取自己那批', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const [rows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'policy_rules'
            AND index_name = 'idx_policy_lookup' ORDER BY seq_in_index`,
      )
      const cols = rows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(cols).toEqual(['kind', 'enabled', 'priority', 'id'])
    } finally {
      await cleanup()
    }
  })

  test('effect 装得下一段归档目录模板（archive 栈）', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const template = '/nas/meetings-finance/{年}/{月}/{会议号}_{标题}'
      await pool.execute(
        `INSERT INTO policy_rules
           (kind, priority, join_op, conds, asset_types, effect, note, enabled, created_at, updated_at)
         VALUES ('archive', 10, 'and', JSON_ARRAY(), JSON_ARRAY(), ?, '财务会议单独归档', 1, 0, 0)`,
        [template],
      )
      const [rows] = await pool.query<any[]>(`SELECT effect FROM policy_rules WHERE kind = 'archive'`)
      expect(rows[0].effect).toBe(template)
    } finally {
      await cleanup()
    }
  })

  test('旧结构的规则被整表搬进 policy_rules_legacy，policy_rules 清空且不自动转换语义', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const { runMigrations } = await import('../../src/store/db')

      // 造一个「004 还没跑过」的库：把 policy_rules 还原成 001 的旧结构，
      // 塞一条与生产库同形状的规则（subject_type='user'，主体是人），再删掉 legacy。
      await pool.query('DROP TABLE IF EXISTS policy_rules_legacy')
      await pool.query('DROP TABLE policy_rules')
      await pool.query(`CREATE TABLE policy_rules (
        id            BIGINT       NOT NULL AUTO_INCREMENT,
        priority      INT          NOT NULL,
        subject_type  VARCHAR(16)  NOT NULL,
        subject_value VARCHAR(128) NOT NULL,
        resource_expr JSON         NOT NULL,
        asset_types   JSON         NOT NULL,
        effect        VARCHAR(8)   NOT NULL,
        enabled       TINYINT(1)   NOT NULL DEFAULT 1,
        created_at    BIGINT       NOT NULL,
        updated_at    BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_policy_lookup (enabled, priority, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
      await pool.execute(
        `INSERT INTO policy_rules
           (id, priority, subject_type, subject_value, resource_expr, asset_types, effect, enabled, created_at, updated_at)
         VALUES (7, 100, 'user', 'tm-admin-1', JSON_OBJECT(), JSON_ARRAY('*'), 'allow', 1, 1, 1)`,
      )

      await runMigrations(pool)

      // 不丢数据：那一行原样在 legacy 里，主体仍是人
      const [legacy] = await pool.query<any[]>(
        'SELECT id, subject_type, subject_value, effect FROM policy_rules_legacy',
      )
      expect(legacy).toHaveLength(1)
      expect(legacy[0].id).toBe(7)
      expect(legacy[0].subject_type).toBe('user')
      expect(legacy[0].subject_value).toBe('tm-admin-1')

      // 也不假装能自动转换语义：新表是空的，等管理员按新语义重建。
      // 空规则集 = allow 栈兜底 deny = 谁都取不走，这是安全侧。
      const [fresh] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM policy_rules')
      expect(Number(fresh[0].n)).toBe(0)

      const [cols] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'policy_rules'`,
      )
      const names = cols.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(names).toContain('kind')
      expect(names).not.toContain('resource_expr')
    } finally {
      await cleanup()
    }
  })

  test('重复执行不会清掉管理员后来新建的规则（004 幂等）', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      const { runMigrations } = await import('../../src/store/db')
      await pool.execute(
        `INSERT INTO policy_rules
           (kind, priority, join_op, conds, subject_type, subject_value, asset_types, effect,
            note, created_by, enabled, created_at, updated_at)
         VALUES ('allow', 50, 'and', JSON_ARRAY(), 'program', 'mde-local', JSON_ARRAY('*'), 'allow',
                 '放行本地采集程序', 'admin-1', 1, 0, 0)`,
      )

      await runMigrations(pool)
      await runMigrations(pool)

      const [rows] = await pool.query<any[]>(
        `SELECT kind, subject_value, note FROM policy_rules`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].kind).toBe('allow')
      expect(rows[0].subject_value).toBe('mde-local')
      expect(rows[0].note).toBe('放行本地采集程序')
    } finally {
      await cleanup()
    }
  })
})
