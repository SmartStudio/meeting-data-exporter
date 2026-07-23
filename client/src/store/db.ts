import { Database } from 'bun:sqlite'

export function openDb(path: string): Database {
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
      file_type TEXT, bytes_expected INTEGER, bytes_written INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT, download_url TEXT, download_url_expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
      last_error TEXT, completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (meeting_id, sub_meeting_id, asset_type, remote_id)
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
}
