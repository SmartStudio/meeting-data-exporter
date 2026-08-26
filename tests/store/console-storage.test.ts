/**
 * T8 新建的只读聚合 store。跟随 tests/store/ 的既有约定：store 层不 mock 数据库
 * ——这一层的价值几乎全在 SQL 语义里（三张表的自然键 join、local_purged_at 的
 * 取舍、SUM 的 DECIMAL 回程），mock 掉等于没测。
 */
import { expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import { createConsoleStorageStore } from '../../src/store/console-storage'
import type { Pool } from '../../src/store/db'

const NOW = 1_700_000_000

async function insertCompletedAsset(
  pool: Pool,
  a: {
    meetingId: string
    subMeetingId?: string
    assetType: string
    remoteId: string
    fileType?: string
    bytesExpected: number | null
    bytesWritten: number
    status?: string
  },
): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status,
        target_path, bytes_expected, bytes_written, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.meetingId,
      a.subMeetingId ?? '',
      a.assetType,
      a.remoteId,
      a.fileType ?? '',
      a.status ?? 'completed',
      `${a.meetingId}/${a.assetType}.bin`,
      a.bytesExpected,
      a.bytesWritten,
      NOW,
      NOW,
    ],
  )
}

async function insertArchivedAsset(
  pool: Pool,
  a: { meetingId: string; subMeetingId?: string; assetType: string; remoteId: string; fileType?: string },
): Promise<void> {
  await pool.execute(
    `INSERT INTO archived_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.meetingId,
      a.subMeetingId ?? '',
      a.assetType,
      a.remoteId,
      a.fileType ?? '',
      `${a.meetingId}/${a.assetType}.bin`,
      `/nas/${a.meetingId}/${a.assetType}.bin`,
      'h'.repeat(64),
      NOW,
    ],
  )
}

async function insertArchive(
  pool: Pool,
  a: { meetingId: string; subMeetingId?: string; localPurgedAt?: number | null },
): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_archives
       (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, extended_days,
        local_purged_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.meetingId, a.subMeetingId ?? '', `/nas/${a.meetingId}`, NOW, 30, 0, a.localPurgedAt ?? null, NOW, NOW],
  )
}

async function insertGrant(
  pool: Pool,
  a: { meetingId: string; subMeetingId?: string; programId: string; revokedAt?: number },
): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
    [a.meetingId, a.subMeetingId ?? '', a.programId, NOW, a.revokedAt ?? 0],
  )
}

test('空库：四个数全是 0，而不是 null 或字符串', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const agg = await createConsoleStorageStore(pool).aggregates()
    expect(agg).toEqual({ archivedMeetings: 0, nasBytes: 0, localBytes: 0, grantedLiveMeetings: 0 })
  } finally {
    await cleanup()
  }
})

test('已归档场次数按 (meeting_id, sub_meeting_id) 数，周期性会议的每一场各算一场', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await insertArchive(pool, { meetingId: 'm-1', subMeetingId: '' })
    await insertArchive(pool, { meetingId: 'm-1', subMeetingId: 'sub-2' })
    await insertArchive(pool, { meetingId: 'm-2', subMeetingId: '', localPurgedAt: NOW })
    const agg = await createConsoleStorageStore(pool).aggregates()
    // 本地已清理的那场仍然在 NAS 上，仍然算"已归档"
    expect(agg.archivedMeetings).toBe(3)
  } finally {
    await cleanup()
  }
})

test('NAS 占用数全部归档过的资产；本地占用只数本地文件还在的那些', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // m-live：本地还在
    await insertArchive(pool, { meetingId: 'm-live' })
    await insertCompletedAsset(pool, {
      meetingId: 'm-live',
      assetType: 'video',
      remoteId: 'r1',
      bytesExpected: 1_000,
      bytesWritten: 0,
    })
    await insertArchivedAsset(pool, { meetingId: 'm-live', assetType: 'video', remoteId: 'r1' })

    // m-purged：本地已清理，NAS 副本还在
    await insertArchive(pool, { meetingId: 'm-purged', localPurgedAt: NOW })
    await insertCompletedAsset(pool, {
      meetingId: 'm-purged',
      assetType: 'video',
      remoteId: 'r2',
      bytesExpected: 500,
      bytesWritten: 0,
    })
    await insertArchivedAsset(pool, { meetingId: 'm-purged', assetType: 'video', remoteId: 'r2' })

    const agg = await createConsoleStorageStore(pool).aggregates()
    expect(agg.nasBytes).toBe(1_500)
    expect(agg.localBytes).toBe(1_000)
  } finally {
    await cleanup()
  }
})

test('体积优先取 bytes_expected：bytes_written 是进度检查点，小文件恒为 0', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await insertArchive(pool, { meetingId: 'm-1' })
    // 小文件：平台声明 4KB，下载器的进度检查点停在 0
    await insertCompletedAsset(pool, {
      meetingId: 'm-1',
      assetType: 'ai_minutes',
      remoteId: 'r1',
      bytesExpected: 4_096,
      bytesWritten: 0,
    })
    await insertArchivedAsset(pool, { meetingId: 'm-1', assetType: 'ai_minutes', remoteId: 'r1' })
    // 平台没声明大小时才回退到 bytes_written
    await insertCompletedAsset(pool, {
      meetingId: 'm-1',
      assetType: 'transcript',
      remoteId: 'r2',
      bytesExpected: null,
      bytesWritten: 777,
    })
    await insertArchivedAsset(pool, { meetingId: 'm-1', assetType: 'transcript', remoteId: 'r2' })

    const agg = await createConsoleStorageStore(pool).aggregates()
    expect(agg.localBytes).toBe(4_096 + 777)
    expect(agg.nasBytes).toBe(4_096 + 777)
  } finally {
    await cleanup()
  }
})

test('还没归档的资产不计入 NAS 占用，也不计入本地占用', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await insertArchive(pool, { meetingId: 'm-1' })
    await insertCompletedAsset(pool, {
      meetingId: 'm-1',
      assetType: 'video',
      remoteId: 'r1',
      bytesExpected: 1_000,
      bytesWritten: 0,
    })
    await insertArchivedAsset(pool, { meetingId: 'm-1', assetType: 'video', remoteId: 'r1' })
    // 迟到的 AI 纪要：已下载完但还没归档 → archived_assets 里没有它
    await insertCompletedAsset(pool, {
      meetingId: 'm-1',
      assetType: 'ai_minutes',
      remoteId: 'r2',
      bytesExpected: 9_999,
      bytesWritten: 0,
    })

    const agg = await createConsoleStorageStore(pool).aggregates()
    expect(agg.nasBytes).toBe(1_000)
    expect(agg.localBytes).toBe(1_000)
  } finally {
    await cleanup()
  }
})

test('本地占用只认 status=completed 的资产行', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await insertArchive(pool, { meetingId: 'm-1' })
    // 归档记录在，但资产行后来不是 completed（异常数据）——本地占用不该照它记账
    await insertCompletedAsset(pool, {
      meetingId: 'm-1',
      assetType: 'video',
      remoteId: 'r1',
      bytesExpected: 1_000,
      bytesWritten: 0,
      status: 'failed',
    })
    await insertArchivedAsset(pool, { meetingId: 'm-1', assetType: 'video', remoteId: 'r1' })

    const agg = await createConsoleStorageStore(pool).aggregates()
    expect(agg.localBytes).toBe(0)
  } finally {
    await cleanup()
  }
})

test('「其中已授权」只数本地还在、且有未撤销授权的场次，一场只算一次', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 两个程序都授权了同一场 → 仍然只算一场
    await insertArchive(pool, { meetingId: 'm-granted' })
    await insertGrant(pool, { meetingId: 'm-granted', programId: 'p-1' })
    await insertGrant(pool, { meetingId: 'm-granted', programId: 'p-2' })

    // 授权已撤销 → 不算
    await insertArchive(pool, { meetingId: 'm-revoked' })
    await insertGrant(pool, { meetingId: 'm-revoked', programId: 'p-1', revokedAt: NOW })

    // 有授权但本地已清理 → 不在"保留期内"这一格里
    await insertArchive(pool, { meetingId: 'm-purged', localPurgedAt: NOW })
    await insertGrant(pool, { meetingId: 'm-purged', programId: 'p-1' })

    // 完全没授权
    await insertArchive(pool, { meetingId: 'm-plain' })

    const agg = await createConsoleStorageStore(pool).aggregates()
    expect(agg.grantedLiveMeetings).toBe(1)
    expect(agg.archivedMeetings).toBe(4)
  } finally {
    await cleanup()
  }
})

test('sub_meeting_id 参与自然键：同 meeting_id 的两场不会互相串账', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await insertArchive(pool, { meetingId: 'm-1', subMeetingId: 'a' })
    await insertArchive(pool, { meetingId: 'm-1', subMeetingId: 'b', localPurgedAt: NOW })

    await insertCompletedAsset(pool, {
      meetingId: 'm-1',
      subMeetingId: 'a',
      assetType: 'video',
      remoteId: 'r1',
      bytesExpected: 100,
      bytesWritten: 0,
    })
    await insertArchivedAsset(pool, { meetingId: 'm-1', subMeetingId: 'a', assetType: 'video', remoteId: 'r1' })

    await insertCompletedAsset(pool, {
      meetingId: 'm-1',
      subMeetingId: 'b',
      assetType: 'video',
      remoteId: 'r1',
      bytesExpected: 200,
      bytesWritten: 0,
    })
    await insertArchivedAsset(pool, { meetingId: 'm-1', subMeetingId: 'b', assetType: 'video', remoteId: 'r1' })

    const agg = await createConsoleStorageStore(pool).aggregates()
    expect(agg.nasBytes).toBe(300)
    // 只有 sub=a 的本地文件还在
    expect(agg.localBytes).toBe(100)
  } finally {
    await cleanup()
  }
})
