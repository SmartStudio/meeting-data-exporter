import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import { runMigrations, type Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createMeetingCacheStore } from '../../src/store/meetings'
import type { Meeting } from '../../src/domain/types'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

const meeting = (o: Partial<Meeting> = {}): Meeting => ({
  meetingId: 'm-1',
  subMeetingId: '',
  meetingRecordId: 'rec-1',
  meetingCode: '881',
  subject: '评审',
  hostUserId: 'tm-alice',
  startTime: 1000,
  endTime: 2000,
  state: 'completed',
  ...o,
})

test('未命中返回 null', async () => {
  const store = createMeetingCacheStore(pool)
  expect(await store.getByRecordId('does-not-exist')).toBeNull()
})

test('upsertMany 后可按 meetingRecordId 查回', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany([meeting()], 5000)
  const found = await store.getByRecordId('rec-1')
  expect(found).toEqual(meeting())
})

test('重复 upsert 同一 meetingRecordId 更新而非报错（幂等）', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany([meeting({ meetingRecordId: 'rec-2', subject: '旧主题' })], 1000)
  await store.upsertMany([meeting({ meetingRecordId: 'rec-2', subject: '新主题' })], 2000)

  const found = await store.getByRecordId('rec-2')
  expect(found?.subject).toBe('新主题')
})

test('中文与 emoji 主题正确往返（utf8mb4）', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany([meeting({ meetingRecordId: 'rec-3', subject: '季度评审 🎉' })], 1000)
  const found = await store.getByRecordId('rec-3')
  expect(found?.subject).toBe('季度评审 🎉')
})

test('upsertMany 一次写多条，同一批里重复的 meetingRecordId 以最后一条为准', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany(
    [
      meeting({ meetingRecordId: 'rec-batch-a', meetingId: 'm-batch-a' }),
      meeting({ meetingRecordId: 'rec-batch-b', meetingId: 'm-batch-b' }),
      // 窗口切分的边界会让同一场会议在一批里出现两次
      meeting({ meetingRecordId: 'rec-batch-a', meetingId: 'm-batch-a', subject: '后写的' }),
    ],
    1000,
  )
  expect((await store.getByRecordId('rec-batch-a'))?.subject).toBe('后写的')
  expect(await store.getByRecordId('rec-batch-b')).not.toBeNull()
})

test('upsertMany 空数组不发 SQL 也不报错', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany([], 1000)
})

// ---------------------------------------------------------------------------
// 精确查询的第一级：按 meeting_id / meeting_code 反查
//
// 语义必须与 tests/tencent/records.test.ts 里的 memCache 逐条一致——那份替身
// 打的就是这几个方法，两边口径漂了，单元测试全绿而真实环境照崩。
// ---------------------------------------------------------------------------

test('listByMeetingId 返回同一 meeting_id 的全部行（周期性会议复用同一 meeting_id）', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany(
    [
      meeting({ meetingRecordId: 'rec-p-1', meetingId: 'm-periodic', startTime: 1000, endTime: 1100 }),
      meeting({ meetingRecordId: 'rec-p-2', meetingId: 'm-periodic', startTime: 2000, endTime: 2100 }),
    ],
    1000,
  )
  const found = await store.listByMeetingId('m-periodic')
  expect(found.map((m) => m.meetingRecordId).sort()).toEqual(['rec-p-1', 'rec-p-2'])
})

test('listByMeetingCode 同样全部返回，不擅自择一', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany(
    [
      meeting({ meetingRecordId: 'rec-c-1', meetingId: 'm-c-1', meetingCode: '886' }),
      meeting({ meetingRecordId: 'rec-c-2', meetingId: 'm-c-2', meetingCode: '886' }),
    ],
    1000,
  )
  const found = await store.listByMeetingCode('886')
  expect(found).toHaveLength(2)
})

test('from / to 按 startTime 过滤，且只作用在给出来的那一侧边界上', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany(
    [
      meeting({ meetingRecordId: 'rec-t-1', meetingId: 'm-window', startTime: 100, endTime: 200 }),
      meeting({ meetingRecordId: 'rec-t-2', meetingId: 'm-window', startTime: 5000, endTime: 5100 }),
    ],
    1000,
  )
  expect((await store.listByMeetingId('m-window', 1000, 9000)).map((m) => m.meetingRecordId))
    .toEqual(['rec-t-2'])
  expect((await store.listByMeetingId('m-window', undefined, 1000)).map((m) => m.meetingRecordId))
    .toEqual(['rec-t-1'])
  expect((await store.listByMeetingId('m-window', 1000, undefined)).map((m) => m.meetingRecordId))
    .toEqual(['rec-t-2'])
  // 两侧都不给 ⇒ 不做时间过滤
  expect(await store.listByMeetingId('m-window')).toHaveLength(2)
})

test('查不到时返回空数组，不是 null', async () => {
  const store = createMeetingCacheStore(pool)
  expect(await store.listByMeetingId('m-nope')).toEqual([])
  expect(await store.listByMeetingCode('nope')).toEqual([])
})

test('migrations/010 真的把 meeting_code 的索引建出来了', async () => {
  // 没有它，「按会议号点名查」那一路是全表扫，而这张表只增不删（deploy.md §4-5）
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'meeting_cache'
        AND INDEX_NAME = 'idx_meeting_cache_meeting_code'`,
  )
  expect(rows.length).toBeGreaterThan(0)
})

test('迁移每次启动都重跑：再跑一遍不因索引已存在而报错', async () => {
  // runMigrations 没有版本表，它把 migrations/ 下每个文件每次都执行一遍。
  // MySQL 的 ADD KEY 没有 IF NOT EXISTS，010 的 information_schema 守卫要真的兜住
  await runMigrations(pool)
  await runMigrations(pool)
})

test('state 在缓存里往返不变形——corp 响应的 state 与网关语义值是同一套词汇', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsertMany(
    [meeting({ meetingRecordId: 'rec-s-1', meetingId: 'm-state', state: 'transcoding' })],
    1000,
  )
  expect((await store.listByMeetingId('m-state'))[0]!.state).toBe('transcoding')
  expect((await store.getByRecordId('rec-s-1'))?.state).toBe('transcoding')
})
