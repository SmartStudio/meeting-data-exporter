import { expect, test } from 'bun:test'
import { createRecordsApi, MeetingNotFoundInRangeError } from '../../src/tencent/records'
import type { QueryParams } from '../../src/tencent/url'
import type { TencentClient } from '../../src/tencent/client'

const NOW = 1_800_000_000

function stubClient(pages: unknown[]): { client: TencentClient; queries: QueryParams[] } {
  const queries: QueryParams[] = []
  let i = 0
  return {
    queries,
    client: {
      get: async <T,>(_p: string, q: QueryParams) => {
        queries.push(q)
        return (pages[Math.min(i++, pages.length - 1)] ?? {}) as T
      },
      post: async <T,>() => ({}) as T,
      currentQps: () => 5,
    },
  }
}

const onePage = (meetings: unknown[]) => ({
  total_count: meetings.length, current_size: meetings.length,
  current_page: 1, total_page: 1, record_meetings: meetings,
})

const rawMeeting = {
  meeting_record_id: 'rec-1', meeting_id: 'm-1', meeting_code: '88123456',
  host_user_id: 'tm-alice', media_start_time: 1767225600000, subject: '评审',
  state: 3, record_type: 0, record_files: [],
}

test('毫秒时间戳被归一为秒', async () => {
  const { client } = stubClient([onePage([rawMeeting])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.startTime).toBe(1767225600)
})

test('state 数字映射为语义值', async () => {
  const { client } = stubClient([onePage([{ ...rawMeeting, state: 2 }])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.state).toBe('transcoding')
})

test('查询携带 operator_id 与 operator_id_type=1', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin-uid')
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries[0]!.operator_id).toBe('admin-uid')
  expect(queries[0]!.operator_id_type).toBe(1)
})

test('page_size 不超过 20', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(Number(queries[0]!.page_size)).toBeLessThanOrEqual(20)
})

test('90 天范围触发 3 次窗口查询', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'range', from: 0, to: 90 * 86400 }, NOW)
  expect(queries).toHaveLength(3)
})

test('多页时自动翻页', async () => {
  const { client, queries } = stubClient([
    { total_count: 25, current_size: 20, current_page: 1, total_page: 2, record_meetings: [rawMeeting] },
    { total_count: 25, current_size: 5, current_page: 2, total_page: 2, record_meetings: [rawMeeting] },
  ])
  const api = createRecordsApi(client, 'admin')
  const ms = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries).toHaveLength(2)
  expect(ms).toHaveLength(2)
})

test('未指定时间时按会议号查，默认取最近 31 天', async () => {
  const { client, queries } = stubClient([onePage([rawMeeting])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(queries[0]!.meeting_code).toBe('88123456')
  expect(Number(queries[0]!.end_time)).toBe(NOW)
  expect(Number(queries[0]!.start_time)).toBe(NOW - 31 * 86400)
})

test('会议号命中多场时全部返回，不擅自择一', async () => {
  const { client } = stubClient([
    onePage([rawMeeting, { ...rawMeeting, meeting_id: 'm-2', meeting_record_id: 'rec-2' }]),
  ])
  const api = createRecordsApi(client, 'admin')
  const ms = await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(ms).toHaveLength(2)
})

test('按 ID 查询但范围内无结果时抛出可区分的错误', async () => {
  const { client } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await expect(api.listMeetings({ kind: 'id', meetingId: 'm-x' }, NOW))
    .rejects.toThrow(MeetingNotFoundInRangeError)
})
