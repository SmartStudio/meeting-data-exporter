import { expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import { archiveStateKey, createArchivesStore } from '../../src/store/archives'
import type { Pool } from '../../src/store/db'

/**
 * 覆盖 ArchivesStore 每个方法的往返正确性，重点盯着两处容易埋雷的语义：
 * upsertMeetingArchive 的 ON DUPLICATE KEY UPDATE 绝不能碰 extended_days
 * （否则一次意外的重复归档调用会把管理员刚做的"延长 N 天"悄悄清零），
 * 以及 extendRetention 是累加不是覆盖。
 *
 * meeting_assets（002）是 ArchivesStore 的只读输入，本模块没有写它的方法，
 * 所以下面的 seedAsset 直接用 pool 写——与 tests/worker/e2e.test.ts 直接用
 * pool 读 meeting_assets 是同一种"这张表不归本模块写，但读的语义要验证"的处境。
 *
 * 每个用例各自持有一个隔离的测试库（跟随 tests/store/admin.test.ts 的约定），
 * 不共用 pool，避免同文件内其他用例的行污染基线（尤其是 countCompletedAssets/
 * listExpiredUnpurged 这类"数满足条件的行数"的断言）。
 */

interface SeedAssetInput {
  meetingId: string
  subMeetingId?: string
  assetType?: string
  remoteId?: string
  fileType?: string
  status?: 'pending' | 'completed' | 'failed' | 'skipped' | 'dead'
  targetPath?: string | null
  bytesWritten?: number
  /** 平台声明的大小；NAS sidecar 的 bytes 取这一列（不是 bytes_written，那是进度检查点） */
  bytesExpected?: number | null
  /** 下载器在本地算的整文件 sha256；视频/音频恒为 null */
  contentHash?: string | null
  /** 放弃原因，只有 skipped / dead 的行才有意义 */
  lastError?: string | null
}

async function seedAsset(pool: Pool, input: SeedAssetInput): Promise<void> {
  const {
    meetingId,
    subMeetingId = '',
    assetType = 'video',
    remoteId = 'remote-1',
    fileType = 'mp4',
    status = 'completed',
    targetPath = '2026/08/dir/video.mp4',
    bytesWritten = 1024,
    bytesExpected = null,
    contentHash = null,
    lastError = null,
  } = input
  await pool.execute(
    `INSERT INTO meeting_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path,
        bytes_written, bytes_expected, content_hash, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, 1000)`,
    [meetingId, subMeetingId, assetType, remoteId, fileType, status, targetPath,
     bytesWritten, bytesExpected, contentHash, lastError],
  )
}

test('listCompletedAssets 只返回 status=completed 的行，字段映射正确', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedAsset(pool, {
      meetingId: 'm-1', targetPath: '2026/08/dir/a.mp4', bytesWritten: 555,
      bytesExpected: 4096, contentHash: 'f'.repeat(64),
    })
    await seedAsset(pool, { meetingId: 'm-1', assetType: 'audio', remoteId: 'remote-2', status: 'pending' })

    const store = createArchivesStore(pool)
    const rows = await store.listCompletedAssets('m-1', '')
    expect(rows).toEqual([
      {
        meetingId: 'm-1',
        subMeetingId: '',
        assetType: 'video',
        remoteId: 'remote-1',
        fileType: 'mp4',
        targetPath: '2026/08/dir/a.mp4',
        bytesWritten: 555,
        // BIGINT 列必须是 number 而不是字符串：这个值会被写进 NAS 上的 JSON 清单，
        // 一个 "4096" 会让数年后读清单的脚本拿到另一种类型
        bytesExpected: 4096,
        contentHash: 'f'.repeat(64),
      },
    ])
  } finally {
    await cleanup()
  }
})

test('listCompletedAssets 对 target_path 为 NULL 的 completed 行显式报错（数据完整性不变量）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 正常流程里 setTargetPath 一定先于 markCompleted 跑，不会出现这种行；
    // 这里直接绕过 store 手写一条违反不变量的行，确认映射层不会把 NULL 悄悄
    // 当成 string 传下去——那会在 archive.ts 里变成 join(root, null) 这种更难查的错。
    await pool.execute(
      `INSERT INTO meeting_assets
         (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, bytes_written, created_at, updated_at)
       VALUES ('m-bad', '', 'video', 'r-1', 'mp4', 'completed', NULL, 0, 1000, 1000)`,
    )
    const store = createArchivesStore(pool)
    await expect(store.listCompletedAssets('m-bad', '')).rejects.toThrow(/target_path is NULL/)
  } finally {
    await cleanup()
  }
})

test('countCompletedAssets 只数 completed 的行，且按会议隔离', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedAsset(pool, { meetingId: 'm-4', assetType: 'video', remoteId: 'r-1', status: 'completed' })
    await seedAsset(pool, { meetingId: 'm-4', assetType: 'audio', remoteId: 'r-2', status: 'completed' })
    await seedAsset(pool, { meetingId: 'm-4', assetType: 'chat', remoteId: 'r-3', status: 'pending' })
    await seedAsset(pool, { meetingId: 'm-other', assetType: 'video', remoteId: 'r-4', status: 'completed' })

    const store = createArchivesStore(pool)
    expect(await store.countCompletedAssets('m-4', '')).toBe(2)
    expect(await store.countCompletedAssets('m-other', '')).toBe(1)
    expect(await store.countCompletedAssets('m-nonexistent', '')).toBe(0)
  } finally {
    await cleanup()
  }
})

test('recordArchivedAsset 落库后 isAssetArchived 与 countArchivedAssets 从 false/0 变为 true/1', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedAsset(pool, { meetingId: 'm-2', remoteId: 'r-1' })
    const store = createArchivesStore(pool)
    const key = { meetingId: 'm-2', subMeetingId: '', assetType: 'video', remoteId: 'r-1', fileType: 'mp4' }

    expect(await store.isAssetArchived(key)).toBe(false)
    expect(await store.countArchivedAssets('m-2', '')).toBe(0)

    await store.recordArchivedAsset({
      ...key,
      localPath: '2026/08/dir/video.mp4',
      nasPath: '/nas/2026/08/m-2/2026/08/dir/video.mp4',
      nasHash: 'deadbeef',
      archivedAt: 5000,
    })

    expect(await store.isAssetArchived(key)).toBe(true)
    expect(await store.countArchivedAssets('m-2', '')).toBe(1)
    // 另一个资产（不同 remoteId）不应被误判为已归档——isAssetArchived 必须按完整自然键匹配
    expect(await store.isAssetArchived({ ...key, remoteId: 'r-2' })).toBe(false)
  } finally {
    await cleanup()
  }
})

test('listArchivedAssetsForMeeting 返回该会议下全部已归档资产，字段完整往返，且不跨会议混入', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    await store.recordArchivedAsset({
      meetingId: 'm-3', subMeetingId: '', assetType: 'video', remoteId: 'r-1', fileType: 'mp4',
      localPath: 'a/video.mp4', nasPath: '/nas/a/video.mp4', nasHash: 'hash-1', archivedAt: 1000,
    })
    await store.recordArchivedAsset({
      meetingId: 'm-3', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-2', fileType: 'txt',
      localPath: 'a/summary.txt', nasPath: '/nas/a/summary.txt', nasHash: 'hash-2', archivedAt: 1000,
    })
    await store.recordArchivedAsset({
      meetingId: 'm-other', subMeetingId: '', assetType: 'video', remoteId: 'r-3', fileType: 'mp4',
      localPath: 'b/video.mp4', nasPath: '/nas/b/video.mp4', nasHash: 'hash-3', archivedAt: 1000,
    })

    const rows = await store.listArchivedAssetsForMeeting('m-3', '')
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.assetType).sort()).toEqual(['meeting_summary', 'video'])
    const video = rows.find((r) => r.assetType === 'video')
    expect(video).toEqual({
      meetingId: 'm-3', subMeetingId: '', assetType: 'video', remoteId: 'r-1', fileType: 'mp4',
      localPath: 'a/video.mp4', nasPath: '/nas/a/video.mp4', nasHash: 'hash-1', archivedAt: 1000,
    })
  } finally {
    await cleanup()
  }
})

test('upsertMeetingArchive 对同一会议调用两次不报错，nas_dir/archived_at/retention_days 取第二次的值', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    await store.upsertMeetingArchive({
      meetingId: 'm-5', subMeetingId: '', nasDir: '/nas/2026/08/m-5', archivedAt: 1000, retentionDays: 30, now: 1000,
    })
    await store.upsertMeetingArchive({
      meetingId: 'm-5', subMeetingId: '', nasDir: '/nas/2026/09/m-5', archivedAt: 2000, retentionDays: 45, now: 2000,
    })

    const rec = await store.findMeetingArchive('m-5', '')
    expect(rec).toEqual({
      meetingId: 'm-5', subMeetingId: '', nasDir: '/nas/2026/09/m-5',
      archivedAt: 2000, retentionDays: 45, extendedDays: 0, localPurgedAt: null,
    })
  } finally {
    await cleanup()
  }
})

test('upsertMeetingArchive 重复调用绝不清零 extended_days —— ON DUPLICATE KEY UPDATE 必须排除这一列', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    await store.upsertMeetingArchive({
      meetingId: 'm-6', subMeetingId: '', nasDir: '/nas/2026/08/m-6', archivedAt: 1000, retentionDays: 30, now: 1000,
    })
    await store.extendRetention('m-6', '', 30, 1500) // 管理员手动延长 30 天
    expect((await store.findMeetingArchive('m-6', ''))?.extendedDays).toBe(30)

    // 模拟"极端情况下并发跑了两次归档"：同一会议再次触发 upsertMeetingArchive
    await store.upsertMeetingArchive({
      meetingId: 'm-6', subMeetingId: '', nasDir: '/nas/2026/08/m-6', archivedAt: 3000, retentionDays: 30, now: 3000,
    })

    const rec = await store.findMeetingArchive('m-6', '')
    expect(rec?.extendedDays).toBe(30) // 没有被悄悄清零
    expect(rec?.archivedAt).toBe(3000) // 但其它列确实按第二次调用更新了
  } finally {
    await cleanup()
  }
})

test('extendRetention 累加，不是覆盖', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    await store.upsertMeetingArchive({
      meetingId: 'm-7', subMeetingId: '', nasDir: '/nas/m-7', archivedAt: 1000, retentionDays: 30, now: 1000,
    })
    await store.extendRetention('m-7', '', 10, 1100)
    expect((await store.findMeetingArchive('m-7', ''))?.extendedDays).toBe(10)

    await store.extendRetention('m-7', '', 5, 1200)
    expect((await store.findMeetingArchive('m-7', ''))?.extendedDays).toBe(15)
  } finally {
    await cleanup()
  }
})

test('findMeetingArchive 对不存在的会议返回 null', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    expect(await store.findMeetingArchive('never-existed', '')).toBeNull()
  } finally {
    await cleanup()
  }
})

test('markLocalPurged 写入 local_purged_at，findMeetingArchive 能读到新值', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    await store.upsertMeetingArchive({
      meetingId: 'm-8', subMeetingId: '', nasDir: '/nas/m-8', archivedAt: 1000, retentionDays: 30, now: 1000,
    })
    expect((await store.findMeetingArchive('m-8', ''))?.localPurgedAt).toBeNull()

    await store.markLocalPurged('m-8', '', 9999)
    expect((await store.findMeetingArchive('m-8', ''))?.localPurgedAt).toBe(9999)
  } finally {
    await cleanup()
  }
})

test('listExpiredUnpurged 只返回 local_purged_at 为空且 archived_at<=now 的会议', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    const now = 100_000

    // 已过期、未清理 —— 应该出现
    await store.upsertMeetingArchive({ meetingId: 'm-due', subMeetingId: '', nasDir: '/nas/due', archivedAt: 1000, retentionDays: 1, now: 1000 })
    // 已过期、但已清理 —— 不应出现
    await store.upsertMeetingArchive({ meetingId: 'm-purged', subMeetingId: '', nasDir: '/nas/purged', archivedAt: 1000, retentionDays: 1, now: 1000 })
    await store.markLocalPurged('m-purged', '', 5000)
    // archived_at 还在 now 之后（现实里不会发生，纯粹用来确认 SQL 侧的 archived_at<=now 过滤生效）—— 不应出现
    await store.upsertMeetingArchive({ meetingId: 'm-future', subMeetingId: '', nasDir: '/nas/future', archivedAt: now + 10_000, retentionDays: 1, now: 1000 })

    const rows = await store.listExpiredUnpurged(now)
    expect(rows.map((r) => r.meetingId)).toEqual(['m-due'])
  } finally {
    await cleanup()
  }
})

test('getSetting 对不存在的 key 返回 null；setSetting 后能读回；重复 setSetting 更新而不报错', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    expect(await store.getSetting('cleanup_paused')).toBeNull()

    await store.setSetting('cleanup_paused', '1', 1000)
    expect(await store.getSetting('cleanup_paused')).toBe('1')

    // 第二次 setSetting 是更新，不是报唯一键冲突
    await store.setSetting('cleanup_paused', '0', 2000)
    expect(await store.getSetting('cleanup_paused')).toBe('0')

    expect(await store.getSetting('default_retention_days')).toBeNull()
    await store.setSetting('default_retention_days', '45', 1000)
    expect(await store.getSetting('default_retention_days')).toBe('45')
  } finally {
    await cleanup()
  }
})

test('listMeetingsNeedingArchive 精确按 (meeting_id, sub_meeting_id) 枚举，不按 meeting_id 去重——同一 meeting_id 下多个 sub_meeting_id 都要出现', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 周期性会议的真实场景：同一 meeting_id，两个不同的 sub_meeting_id，各自都有
    // 已完成但还没归档的资产。这是钉住 review Critical 的用例——如果枚举源退化成
    // 按 meeting_id 去重（比如又被换回 Store.meetingsForPaths()），这里只会剩一行。
    await seedAsset(pool, { meetingId: 'm-periodic', subMeetingId: 's1', remoteId: 'r-1' })
    await seedAsset(pool, { meetingId: 'm-periodic', subMeetingId: 's2', remoteId: 'r-1' })

    const store = createArchivesStore(pool)
    const rows = await store.listMeetingsNeedingArchive()
    expect(rows).toEqual([
      { meetingId: 'm-periodic', subMeetingId: 's1' },
      { meetingId: 'm-periodic', subMeetingId: 's2' },
    ])
  } finally {
    await cleanup()
  }
})

test('listMeetingsNeedingArchive 只返回 completed 数量严格大于 archived 数量的会议——完全归档完/没有 completed 资产的不出现', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)

    // 有 completed 资产、还没归档任何一个——应该出现
    await seedAsset(pool, { meetingId: 'm-needs', remoteId: 'r-1' })

    // 有 completed 资产，且已经全部归档完——不应该出现（早退的核心）
    await seedAsset(pool, { meetingId: 'm-done', remoteId: 'r-1' })
    await store.recordArchivedAsset({
      meetingId: 'm-done', subMeetingId: '', assetType: 'video', remoteId: 'r-1', fileType: 'mp4',
      localPath: 'a.mp4', nasPath: '/nas/a.mp4', nasHash: 'h', archivedAt: 1000,
    })

    // 只有 pending 资产，没有任何 completed——不应该出现
    await seedAsset(pool, { meetingId: 'm-pending', remoteId: 'r-1', status: 'pending' })

    const rows = await store.listMeetingsNeedingArchive()
    expect(rows).toEqual([{ meetingId: 'm-needs', subMeetingId: '' }])
  } finally {
    await cleanup()
  }
})

test('listMissingAssets 只返回终态的 skipped / dead，pending / failed 一概不返回', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 「确认缺失」（skipped / dead）与「不知有无」（pending / running / failed）是两种
    // 状态——US-6.2 第三条验收标准要的正是这条区分。把还在流程里的状态写进清单，
    // 等于对着一个还会变的状态下结论。
    await seedAsset(pool, { meetingId: 'm-x', assetType: 'ai_minutes', remoteId: 'r-skip', fileType: '', status: 'skipped', targetPath: null, lastError: 'download_not_allowed' })
    await seedAsset(pool, { meetingId: 'm-x', assetType: 'ai_ds_minutes', remoteId: 'r-dead', fileType: '', status: 'dead', targetPath: null, lastError: 'upstream_timeout' })
    await seedAsset(pool, { meetingId: 'm-x', assetType: 'audio', remoteId: 'r-pending', status: 'pending', targetPath: null })
    await seedAsset(pool, { meetingId: 'm-x', assetType: 'transcript', remoteId: 'r-failed', status: 'failed', targetPath: null, lastError: 'ECONNRESET' })
    await seedAsset(pool, { meetingId: 'm-x', assetType: 'video', remoteId: 'r-done', status: 'completed' })
    // 另一场会议的 skipped 行不该串进来
    await seedAsset(pool, { meetingId: 'm-y', assetType: 'ai_minutes', remoteId: 'r-other', fileType: '', status: 'skipped', targetPath: null, lastError: 'download_not_allowed' })

    const store = createArchivesStore(pool)
    expect(await store.listMissingAssets('m-x', '')).toEqual([
      { meetingId: 'm-x', subMeetingId: '', assetType: 'ai_minutes', remoteId: 'r-skip', fileType: '', status: 'skipped', lastError: 'download_not_allowed' },
      { meetingId: 'm-x', subMeetingId: '', assetType: 'ai_ds_minutes', remoteId: 'r-dead', fileType: '', status: 'dead', lastError: 'upstream_timeout' },
    ])
  } finally {
    await cleanup()
  }
})

test('listMeetingArchives 一次问清一批，整行返回，且不混入没问的会议', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    await store.upsertMeetingArchive({ meetingId: 'm-a', subMeetingId: '', nasDir: '/nas/a', archivedAt: 1000, retentionDays: 30, now: 1000 })
    await store.upsertMeetingArchive({ meetingId: 'm-a', subMeetingId: 's1', nasDir: '/nas/a-s1', archivedAt: 1100, retentionDays: 45, now: 1100 })
    await store.upsertMeetingArchive({ meetingId: 'm-b', subMeetingId: '', nasDir: '/nas/b', archivedAt: 1200, retentionDays: 7, now: 1200 })
    await store.extendRetention('m-a', 's1', 60, 1300)
    await store.markLocalPurged('m-b', '', 1400)

    const rows = await store.listMeetingArchives([
      { meetingId: 'm-a', subMeetingId: '' },
      { meetingId: 'm-a', subMeetingId: 's1' },
      { meetingId: 'm-b', subMeetingId: '' },
      { meetingId: 'm-never', subMeetingId: '' },
    ])
    const byKey = new Map(rows.map((r) => [`${r.meetingId}/${r.subMeetingId}`, r]))

    expect(rows).toHaveLength(3)
    // 周期性会议的各场次必须各算各的——按 meeting_id 去重会让一个场次凭空消失
    expect(byKey.get('m-a/s1')).toEqual({
      meetingId: 'm-a', subMeetingId: 's1', nasDir: '/nas/a-s1',
      archivedAt: 1100, retentionDays: 45, extendedDays: 60, localPurgedAt: null,
    })
    // 采集清单判「在保留期内」看的就是这一列，所以它必须原样回来，不能被折成一个布尔
    expect(byKey.get('m-b/')?.localPurgedAt).toBe(1400)
    expect(byKey.get('m-a/')?.localPurgedAt).toBeNull()
  } finally {
    await cleanup()
  }
})

test('listMeetingArchives 传空数组不查库，直接返回空数组', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createArchivesStore(pool)
    await store.upsertMeetingArchive({ meetingId: 'm-a', subMeetingId: '', nasDir: '/nas/a', archivedAt: 1000, retentionDays: 30, now: 1000 })
    // 空的 `IN ()` 是语法错误，所以这条早退不是优化而是正确性
    expect(await store.listMeetingArchives([])).toEqual([])
  } finally {
    await cleanup()
  }
})

test('listMeetingsWithCompletedAssets 只认 completed，且按 (meeting_id, sub_meeting_id) 精确区分', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // m-1：两行 completed，DISTINCT 之后只该出一次
    await seedAsset(pool, { meetingId: 'm-1', assetType: 'video', remoteId: 'r1', status: 'completed' })
    await seedAsset(pool, { meetingId: 'm-1', assetType: 'audio', remoteId: 'r2', status: 'completed' })
    // m-2：只有还在流程里的与已放弃的行，本地没有任何可取的文件
    await seedAsset(pool, { meetingId: 'm-2', assetType: 'video', remoteId: 'r3', status: 'pending', targetPath: null })
    await seedAsset(pool, { meetingId: 'm-2', assetType: 'audio', remoteId: 'r4', status: 'dead', targetPath: null })
    // m-3 的两个场次：只有 s1 下完了
    await seedAsset(pool, { meetingId: 'm-3', subMeetingId: 's1', remoteId: 'r5', status: 'completed' })
    await seedAsset(pool, { meetingId: 'm-3', subMeetingId: 's2', remoteId: 'r6', status: 'failed', targetPath: null })

    const store = createArchivesStore(pool)
    const got = await store.listMeetingsWithCompletedAssets([
      { meetingId: 'm-1', subMeetingId: '' },
      { meetingId: 'm-2', subMeetingId: '' },
      { meetingId: 'm-3', subMeetingId: 's1' },
      { meetingId: 'm-3', subMeetingId: 's2' },
    ])

    expect(got).toEqual(new Set([archiveStateKey('m-1', ''), archiveStateKey('m-3', 's1')]))
  } finally {
    await cleanup()
  }
})

test('listMeetingsWithCompletedAssets 传空数组不查库，直接返回空集', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedAsset(pool, { meetingId: 'm-1', status: 'completed' })
    const store = createArchivesStore(pool)
    expect(await store.listMeetingsWithCompletedAssets([])).toEqual(new Set())
  } finally {
    await cleanup()
  }
})
