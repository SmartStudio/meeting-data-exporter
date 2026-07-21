import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
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

test('upsert 后可按 meetingRecordId 查回', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsert(meeting(), 5000)
  const found = await store.getByRecordId('rec-1')
  expect(found).toEqual(meeting())
})

test('重复 upsert 同一 meetingRecordId 更新而非报错（幂等）', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsert(meeting({ meetingRecordId: 'rec-2', subject: '旧主题' }), 1000)
  await store.upsert(meeting({ meetingRecordId: 'rec-2', subject: '新主题' }), 2000)

  const found = await store.getByRecordId('rec-2')
  expect(found?.subject).toBe('新主题')
})

test('中文与 emoji 主题正确往返（utf8mb4）', async () => {
  const store = createMeetingCacheStore(pool)
  await store.upsert(meeting({ meetingRecordId: 'rec-3', subject: '季度评审 🎉' }), 1000)
  const found = await store.getByRecordId('rec-3')
  expect(found?.subject).toBe('季度评审 🎉')
})
