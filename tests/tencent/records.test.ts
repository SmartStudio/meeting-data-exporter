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

// ---------------------------------------------------------------------------
// 会议结束时间（M3.5 联调对真实响应核实后修正）
// /v1/records 的 record_meetings[] 没有会议级结束时间，真实结束时刻在同一条
// 响应的 record_files[].record_end_time 里。原实现拿 media_start_time 充当
// end_time，会让客户端的 deadline_at 凭空少掉一整个会议时长。
// ---------------------------------------------------------------------------

test('endTime 取 record_files 里最大的 record_end_time，而不是开始时间', async () => {
  const meeting = {
    ...rawMeeting,
    media_start_time: 1767225600000,
    record_files: [
      { record_file_id: 'f1', record_start_time: 1767225610000, record_end_time: 1767227400000 },
      { record_file_id: 'f2', record_start_time: 1767227400000, record_end_time: 1767229200000 },
    ],
  }
  const { client } = stubClient([onePage([meeting])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)

  expect(m!.startTime).toBe(1767225600)
  expect(m!.endTime).toBe(1767229200) // 第二段的结束时间，非第一段、非开始时间
  expect(m!.endTime).toBeGreaterThan(m!.startTime)
})

test('record_files 为空时回退到 media_start_time，不抛错', async () => {
  const { client } = stubClient([onePage([{ ...rawMeeting, record_files: [] }])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.endTime).toBe(1767225600)
})

test('record_files 缺失该字段时同样回退，不产生 NaN', async () => {
  const meeting = { ...rawMeeting, record_files: [{ record_file_id: 'f1' }] }
  const { client } = stubClient([onePage([meeting])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.endTime).toBe(1767225600)
  expect(Number.isNaN(m!.endTime)).toBe(false)
})
