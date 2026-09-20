import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createMeetingCacheStore } from '../../src/store/meetings'
import { createStoredRecordsApi } from '../../src/store/stored-records'
import { MeetingNotFoundInRangeError } from '../../src/tencent/records'
import type { Meeting } from '../../src/domain/types'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
  await createMeetingCacheStore(pool).upsertMany([
    meeting({ meetingRecordId: 'rec-s-1', meetingId: 'm-s-1', meetingCode: '123456789', startTime: 1000 }),
    meeting({ meetingRecordId: 'rec-s-2', meetingId: 'm-s-2', meetingCode: '987654321', startTime: 3000 }),
  ], 5000)
})
afterAll(() => cleanup())

const meeting = (o: Partial<Meeting> = {}): Meeting => ({
  meetingId: 'm-1',
  subMeetingId: '',
  meetingRecordId: 'rec-1',
  recordType: 0,
  meetingCode: '881',
  subject: '评审',
  hostUserId: 'tm-alice',
  startTime: 1000,
  endTime: 2000,
  state: 'completed',
  ...o,
})

test('范围查询直接读缓存：窗口内的全部返回，窗口外的不返回', async () => {
  const api = createStoredRecordsApi(createMeetingCacheStore(pool))
  const rows = await api.listMeetings({ kind: 'range', from: 2000, to: 4000 }, 9000)
  expect(rows.map((m) => m.meetingRecordId)).toEqual(['rec-s-2'])
})

test('会议号带横杠也查得到：与调度器写入时同一条归一', async () => {
  const api = createStoredRecordsApi(createMeetingCacheStore(pool))
  const rows = await api.listMeetings({ kind: 'code', meetingCode: '123-456-789' }, 9000)
  expect(rows.map((m) => m.meetingId)).toEqual(['m-s-1'])
})

test('未命中抛 MeetingNotFoundInRangeError，提示里说要靠调度器补跑，不带不存在的时间窗', async () => {
  const api = createStoredRecordsApi(createMeetingCacheStore(pool))
  let caught: unknown = null
  try {
    await api.listMeetings({ kind: 'id', meetingId: 'm-nope' }, 9000)
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(MeetingNotFoundInRangeError)
  const message = (caught as Error).message
  expect(message).toContain('scheduler')
  expect(message).not.toContain('within')
})
