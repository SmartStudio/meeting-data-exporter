import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store/index'

/**
 * v1 → v2 结构升级。
 *
 * M3 首版所有建表语句都是 `CREATE TABLE IF NOT EXISTS`，对已存在的库不会生效——
 * 光改建表语句只会让新库和旧库悄悄跑在两套结构上：老用户的 `<out>/.mde/queue.sqlite`
 * 会继续用旧唯一键，多格式继续被折叠，而且**毫无征兆**。
 *
 * 这里手工造一个 v1 结构的库（含数据），走一遍 openDb，验证结构被就地升级且
 * 原有记录不丢。
 */
function makeV1Db(path: string): void {
  const db = new Database(path, { create: true })
  db.exec(`
    CREATE TABLE assets (
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
    INSERT INTO assets (meeting_id, sub_meeting_id, asset_type, remote_id, status,
                        target_path, file_type, content_hash, created_at, updated_at)
    VALUES ('m1','','meeting_summary','rf1','completed','2026/08/x/transcript.pdf','pdf','hash-1',1,1),
           ('m1','','video','rf1','pending',NULL,NULL,NULL,1,1);
  `)
  db.close()
}

async function withTmpDb(fn: (path: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mde-mig-'))
  try {
    await fn(join(dir, 'queue.sqlite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('v1 老库被就地升级为 v2：唯一键含 file_type', async () => {
  await withTmpDb((path) => {
    makeV1Db(path)
    const db = openDb(path)

    const uniqueCols: string[] = []
    for (const idx of db.query<{ name: string; unique: number }, []>('PRAGMA index_list(assets)').all()) {
      if (idx.unique !== 1) continue
      for (const c of db.query<{ name: string }, []>(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all()) {
        uniqueCols.push(c.name)
      }
    }
    expect(uniqueCols).toContain('file_type')
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(2)
  })
})

test('升级不丢数据：已完成记录的状态、路径、哈希原样保留', async () => {
  await withTmpDb((path) => {
    makeV1Db(path)
    const db = openDb(path)
    const rows = db.query<{ asset_type: string; status: string; target_path: string | null; content_hash: string | null; file_type: string }, []>(
      'SELECT asset_type, status, target_path, content_hash, file_type FROM assets ORDER BY asset_type',
    ).all()

    expect(rows).toHaveLength(2)
    const summary = rows.find((r) => r.asset_type === 'meeting_summary')!
    expect(summary.status).toBe('completed')
    expect(summary.target_path).toBe('2026/08/x/transcript.pdf')
    expect(summary.content_hash).toBe('hash-1')
    // 原本为 NULL 的 file_type 归一成 ''（新列 NOT NULL DEFAULT ''）
    expect(rows.find((r) => r.asset_type === 'video')!.file_type).toBe('')
  })
})

test('升级后老库立刻具备多格式能力，且不重下已完成的那一份', async () => {
  await withTmpDb(async (path) => {
    makeV1Db(path)
    const store = createStore(openDb(path))

    // 老库里只有 pdf 这一份；补齐另外两种格式
    for (const ft of ['txt', 'docx']) {
      await store.upsertAsset(
        { meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'rf1', fileType: ft },
        2,
      )
    }
    // 已完成的 pdf 再 upsert 一次也不该被翻回 pending
    await store.upsertAsset(
      { meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'rf1', fileType: 'pdf' },
      2,
    )

    const counts = await store.counts()
    expect(counts.completed).toBe(1)
    // video(1，老库遗留) + 新增的 txt/docx(2) = 3 条待办
    expect(counts.pending).toBe(3)
  })
})

test('重复调用 openDb 幂等：已是 v2 的库不再重建表', async () => {
  await withTmpDb((path) => {
    makeV1Db(path)
    openDb(path).close()
    const db = openDb(path)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM assets').get()?.n).toBe(2)
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(2)
  })
})
