import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 当前 schema 版本。**每次改动表结构都必须 +1 并在 migrate() 里补一段升级逻辑**——
 * 全部建表语句都是 `CREATE TABLE IF NOT EXISTS`，对已存在的库不会生效，光改建表语句
 * 只会让新库和旧库悄悄跑在两套结构上。
 *
 * v1：初版（M3）
 * v2：assets 的唯一键加入 file_type（M3.5）——腾讯对同一份录制会同时给出多种格式
 *     （txt/docx/pdf）且共享同一个 record_file_id，旧唯一键区分不了它们，三条记录
 *     折叠成一条；又因平台返回顺序不稳定，同一条命令重复执行会拿到不同格式的文件。
 */
const SCHEMA_VERSION = 2

export function openDb(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })  // 首次运行时 dbPath 父目录（如 <out>/.mde）尚不存在
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      meeting_id TEXT NOT NULL, sub_meeting_id TEXT NOT NULL DEFAULT '',
      meeting_code TEXT, subject TEXT, host_userid TEXT,
      start_time INTEGER, end_time INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (meeting_id, sub_meeting_id)
    );
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL, sub_meeting_id TEXT NOT NULL DEFAULT '',
      asset_type TEXT NOT NULL, remote_id TEXT NOT NULL,
      asset_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      storage_target TEXT NOT NULL DEFAULT 'local', target_path TEXT,
      file_type TEXT NOT NULL DEFAULT '', bytes_expected INTEGER, bytes_written INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT, download_url TEXT, download_url_expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
      last_error TEXT, completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      -- file_type 参与唯一键：同一份录制的多种导出格式共享 record_file_id，
      -- 只有格式能区分它们。故 file_type 声明为 NOT NULL DEFAULT ''——SQLite 的
      -- UNIQUE 把每个 NULL 视为互不相同，可空列进唯一键等于没有约束。
      UNIQUE (meeting_id, sub_meeting_id, asset_type, remote_id, file_type)
    );
    CREATE INDEX IF NOT EXISTS idx_assets_claimable ON assets (status, lease_expires_at);
    CREATE TABLE IF NOT EXISTS asset_probes (
      meeting_id TEXT NOT NULL, sub_meeting_id TEXT NOT NULL DEFAULT '',
      asset_type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'probing',
      attempts INTEGER NOT NULL DEFAULT 0, probe_after INTEGER NOT NULL DEFAULT 0,
      deadline_at INTEGER NOT NULL, last_reason TEXT,
      PRIMARY KEY (meeting_id, sub_meeting_id, asset_type)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL,
      finished_at INTEGER, mode TEXT NOT NULL,
      window_from INTEGER, window_to INTEGER, summary TEXT
    );
  `)

  upgrade(db)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
}

/**
 * 已存在的库的结构升级。
 *
 * `user_version` 在 M3 首版里没有被写入，所以老库读出来是 0——这里把 0 与 1 一并
 * 视为「v1 结构」。判据不只看版本号：还实际检查一次唯一键是否已含 file_type，
 * 使误标版本号的库也能自愈。
 */
function upgrade(db: Database): void {
  // 判据用**结构本身**而不是版本号：M3 首版从未写过 user_version，老库读出来是 0；
  // 而结构检查对「版本号被误标」的库同样有效，天然自愈。版本号只作记录。
  if (assetsUniqueHasFileType(db)) return

  // SQLite 无法给已存在的表增删 UNIQUE 约束，只能重建后搬运数据。
  // 老库里同一 (meeting, sub, asset_type, remote_id) 只留下了一条记录（其余格式
  // 在写入时就被折叠掉了），搬过来即可；缺失的那些格式会在下次 discover 时补齐。
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE assets_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL, sub_meeting_id TEXT NOT NULL DEFAULT '',
        asset_type TEXT NOT NULL, remote_id TEXT NOT NULL,
        asset_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        storage_target TEXT NOT NULL DEFAULT 'local', target_path TEXT,
        file_type TEXT NOT NULL DEFAULT '', bytes_expected INTEGER, bytes_written INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT, download_url TEXT, download_url_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
        last_error TEXT, completed_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (meeting_id, sub_meeting_id, asset_type, remote_id, file_type)
      );
      INSERT INTO assets_v2
        SELECT id, meeting_id, sub_meeting_id, asset_type, remote_id, asset_id, status,
               storage_target, target_path, COALESCE(file_type, ''), bytes_expected, bytes_written,
               content_hash, download_url, download_url_expires_at, attempts, lease_expires_at,
               last_error, completed_at, created_at, updated_at
          FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v2 RENAME TO assets;
      CREATE INDEX IF NOT EXISTS idx_assets_claimable ON assets (status, lease_expires_at);
    `)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 唯一键里是否已经包含 file_type——用于让误标版本号的库也能自愈 */
function assetsUniqueHasFileType(db: Database): boolean {
  const indexes = db.query<{ name: string; unique: number }, []>('PRAGMA index_list(assets)').all()
  for (const idx of indexes) {
    if (idx.unique !== 1) continue
    const cols = db.query<{ name: string }, []>(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all()
    if (cols.some((c) => c.name === 'file_type')) return true
  }
  return false
}
