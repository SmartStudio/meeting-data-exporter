import { expect, test } from 'bun:test'
import {
  CORP_RECORDS_PATH,
  createRecordsApi,
  MeetingNotFoundInRangeError,
  USER_RECORDS_PATH,
} from '../../src/tencent/records'
import type { QueryParams } from '../../src/tencent/url'
import type { TencentClient } from '../../src/tencent/client'

const NOW = 1_800_000_000

function stubClient(pages: unknown[]): {
  client: TencentClient
  queries: QueryParams[]
  paths: string[]
} {
  const queries: QueryParams[] = []
  const paths: string[] = []
  let i = 0
  return {
    queries,
    paths,
    client: {
      get: async <T,>(p: string, q: QueryParams) => {
        paths.push(p)
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

/**
 * 两个列表接口的 wire 形状**不同**，fixture 也必须分开——共用一份就等于把
 * 「主持人字段改名了」这件事从测试里抹掉（M3.5 的 asset_type 词汇表栽过同一类）。
 */
const baseMeeting = {
  meeting_record_id: 'rec-1', meeting_id: 'm-1', meeting_code: '88123456',
  media_start_time: 1767225600000, subject: '评审',
  state: 3, record_type: 0, record_files: [],
}
/** `/v1/records`（用户维度）：主持人字段是 `host_user_id` */
const userMeeting = { ...baseMeeting, host_user_id: 'tm-alice' }
/** `/v1/corp/records`（企业维度）：主持人字段是 `userid`，**不是** host_user_id */
const corpMeeting = { ...baseMeeting, userid: 'tm-alice' }

test('毫秒时间戳被归一为秒', async () => {
  const { client } = stubClient([onePage([corpMeeting])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.startTime).toBe(1767225600)
})

test('state 数字映射为语义值', async () => {
  const { client } = stubClient([onePage([{ ...corpMeeting, state: 2 }])])
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
    { total_count: 25, current_size: 20, current_page: 1, total_page: 2, record_meetings: [corpMeeting] },
    { total_count: 25, current_size: 5, current_page: 2, total_page: 2, record_meetings: [corpMeeting] },
  ])
  const api = createRecordsApi(client, 'admin')
  const ms = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries).toHaveLength(2)
  expect(ms).toHaveLength(2)
})

test('未指定时间时按会议号查，默认取最近 31 天', async () => {
  const { client, queries } = stubClient([onePage([userMeeting])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(queries[0]!.meeting_code).toBe('88123456')
  expect(Number(queries[0]!.end_time)).toBe(NOW)
  expect(Number(queries[0]!.start_time)).toBe(NOW - 31 * 86400)
})

test('会议号命中多场时全部返回，不擅自择一', async () => {
  const { client } = stubClient([
    onePage([userMeeting, { ...userMeeting, meeting_id: 'm-2', meeting_record_id: 'rec-2' }]),
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
// record_meetings[] 没有会议级结束时间，真实结束时刻在同一条响应的
// record_files[].record_end_time 里。原实现拿 media_start_time 充当 end_time，
// 会让客户端的 deadline_at 凭空少掉一整个会议时长。
// ---------------------------------------------------------------------------

test('endTime 取 record_files 里最大的 record_end_time，而不是开始时间', async () => {
  const meeting = {
    ...corpMeeting,
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
  const { client } = stubClient([onePage([{ ...corpMeeting, record_files: [] }])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.endTime).toBe(1767225600)
})

test('record_files 缺失该字段时同样回退，不产生 NaN', async () => {
  const meeting = { ...corpMeeting, record_files: [{ record_file_id: 'f1' }] }
  const { client } = stubClient([onePage([meeting])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.endTime).toBe(1767225600)
  expect(Number.isNaN(m!.endTime)).toBe(false)
})

// ---------------------------------------------------------------------------
// 企业维度枚举（全公司归档的数据来源）
//
// 实测（2026-08-27，真实腾讯 API）：走 `/v1/records` 拉最近 31 天，7 场会议的
// host_userid 全是 TM_OPERATOR_ID 本人。官方文档对该接口的原话是「查询**用户**
// 所有会议的录制列表」，参数表里根本没有「查谁」的参数——权限只决定能不能调，
// 不决定返回谁的。全公司归档必须改走 `/v1/corp/records`（账户级）。
// ---------------------------------------------------------------------------

test('范围查询打的是 /v1/corp/records（账户级），不是只能看到 operator 自己的 /v1/records', async () => {
  const { client, paths } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(paths).toEqual([CORP_RECORDS_PATH])
  expect(paths).not.toContain(USER_RECORDS_PATH)
})

test('范围查询显式传 query_record_type=0——该接口默认 1（只有云录制），不传就漏掉上传录制与客户端录制', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries[0]!.query_record_type).toBe(0)
})

test('/v1/corp/records 没有 meeting_id / meeting_code 参数，范围查询不得捎带它们', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries[0]!.meeting_id).toBeUndefined()
  expect(queries[0]!.meeting_code).toBeUndefined()
})

test('企业维度响应的主持人字段是 userid——照搬 host_user_id 会让主持人静默变成 undefined', async () => {
  const { client } = stubClient([
    onePage([{ ...corpMeeting, userid: 'tm-bob', host_user_id: undefined }]),
  ])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.hostUserId).toBe('tm-bob')
})

test('企业维度能拉到别人主持的会议——主持人不再恒等于 operator', async () => {
  const { client } = stubClient([
    onePage([
      { ...corpMeeting, meeting_record_id: 'rec-a', userid: 'tm-alice' },
      { ...corpMeeting, meeting_record_id: 'rec-b', userid: 'tm-bob' },
      { ...corpMeeting, meeting_record_id: 'rec-c', userid: 'tm-carol' },
    ]),
  ])
  const api = createRecordsApi(client, 'admin')
  const ms = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(ms.map((m) => m.hostUserId)).toEqual(['tm-alice', 'tm-bob', 'tm-carol'])
})

test('企业维度响应缺 userid 时抛错，不静默产出一场没有主持人的会议', async () => {
  const { client } = stubClient([onePage([{ ...baseMeeting, meeting_record_id: 'rec-nohost' }])])
  const api = createRecordsApi(client, 'admin')
  await expect(api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW))
    .rejects.toThrow(/rec-nohost/)
  await expect(api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW))
    .rejects.toThrow(/userid/)
})

test('精确查询（code / id）仍走 /v1/records——该接口才有 meeting_code / meeting_id 参数', async () => {
  const byCode = stubClient([onePage([userMeeting])])
  const api1 = createRecordsApi(byCode.client, 'admin')
  await api1.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(byCode.paths).toEqual([USER_RECORDS_PATH])

  const byId = stubClient([onePage([userMeeting])])
  const api2 = createRecordsApi(byId.client, 'admin')
  await api2.listMeetings({ kind: 'id', meetingId: 'm-1' }, NOW)
  expect(byId.paths).toEqual([USER_RECORDS_PATH])
})

test('精确查询读的仍是 host_user_id（/v1/records 的字段名），不是 userid', async () => {
  const { client } = stubClient([
    onePage([{ ...userMeeting, host_user_id: 'tm-dave', userid: undefined }]),
  ])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(m!.hostUserId).toBe('tm-dave')
})

test('精确查询未命中时，提示要说出「只看得到 operator 自己的会议」这条限制，不能只说未找到', async () => {
  const { client } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  const err = await api
    .listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
    .then(() => null)
    .catch((e: unknown) => e as Error)

  expect(err).toBeInstanceOf(MeetingNotFoundInRangeError)
  const msg = err!.message
  expect(msg).toContain('88123456')
  // 三条可回溯要素：走的是哪个接口、可见范围是什么、有没有别的路子
  expect(msg).toContain(USER_RECORDS_PATH)
  expect(msg).toMatch(/operator/i)
  expect(msg).toContain(CORP_RECORDS_PATH)
})
