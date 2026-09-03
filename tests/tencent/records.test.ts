import { expect, test } from 'bun:test'
import {
  CORP_RECORDS_PATH,
  createCorpRecordsApi,
  createRecordsApi,
  MeetingNotFoundInRangeError,
  type MeetingCacheLookup,
} from '../../src/tencent/records'
import type { Meeting } from '../../src/domain/types'
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

/**
 * `meeting_cache` 的进程内替身。语义逐条对着 `src/store/meetings.ts` 的 SQL 写：
 * 主键是 meetingRecordId、时间过滤只作用在**给出来的那一侧**边界上、
 * 同一个 meeting_id 可以有多行（周期性会议复用同一 meeting_id）。
 *
 * 打桩的是**存储**，不是被测逻辑本身——解析顺序（先缓存、再 corp 全窗口、再报错）
 * 完全跑在真的 `createRecordsApi` 里。SQL 那一侧由 tests/store/meetings.test.ts
 * 对着真库钉住，两边的口径必须一致。
 */
function memCache(seed: readonly Meeting[] = []): MeetingCacheLookup & {
  rows: Map<string, Meeting>
} {
  const rows = new Map<string, Meeting>()
  for (const m of seed) rows.set(m.meetingRecordId, m)
  const within = (m: Meeting, from?: number, to?: number): boolean =>
    (from === undefined || m.startTime >= from) && (to === undefined || m.startTime <= to)
  return {
    rows,
    async listByMeetingId(meetingId, from, to) {
      return [...rows.values()].filter((m) => m.meetingId === meetingId && within(m, from, to))
    },
    async listByMeetingCode(meetingCode, from, to) {
      return [...rows.values()].filter((m) => m.meetingCode === meetingCode && within(m, from, to))
    },
    async upsertMany(meetings) {
      for (const m of meetings) rows.set(m.meetingRecordId, m)
    },
  }
}

/** 网关侧的 Meeting——缓存里存的就是这个形状 */
const cached = (o: Partial<Meeting> = {}): Meeting => ({
  meetingId: 'm-1',
  subMeetingId: '',
  meetingRecordId: 'rec-1',
  meetingCode: '88123456',
  subject: '评审',
  hostUserId: 'tm-alice',
  startTime: 1767225600,
  endTime: 1767229200,
  state: 'completed',
  ...o,
})

const onePage = (meetings: unknown[]) => ({
  total_count: meetings.length, current_size: meetings.length,
  current_page: 1, total_page: 1, record_meetings: meetings,
})

/**
 * `/v1/corp/records` 的条目：主持人字段是 `userid`，**不是** host_user_id。
 *
 * 这份 fixture 只剩企业维度一种形状——`/v1/records`（用户维度、`host_user_id`）
 * 整条路径已经删除，理由见 src/tencent/records.ts 的文件头。
 */
const corpMeeting = {
  meeting_record_id: 'rec-1', meeting_id: 'm-1', meeting_code: '88123456',
  media_start_time: 1767225600000, subject: '评审',
  state: 3, record_type: 0, record_files: [], userid: 'tm-alice',
}

test('毫秒时间戳被归一为秒', async () => {
  const { client } = stubClient([onePage([corpMeeting])])
  const api = createRecordsApi(client, 'admin', memCache())
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.startTime).toBe(1767225600)
})

test('state 数字映射为语义值', async () => {
  const { client } = stubClient([onePage([{ ...corpMeeting, state: 2 }])])
  const api = createRecordsApi(client, 'admin', memCache())
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.state).toBe('transcoding')
})

test('查询携带 operator_id 与 operator_id_type=1', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin-uid', memCache())
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries[0]!.operator_id).toBe('admin-uid')
  expect(queries[0]!.operator_id_type).toBe(1)
})

test('page_size 不超过 20', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache())
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(Number(queries[0]!.page_size)).toBeLessThanOrEqual(20)
})

test('90 天范围触发 3 次窗口查询', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache())
  await api.listMeetings({ kind: 'range', from: 0, to: 90 * 86400 }, NOW)
  expect(queries).toHaveLength(3)
})

test('多页时自动翻页', async () => {
  const { client, queries } = stubClient([
    { total_count: 25, current_size: 20, current_page: 1, total_page: 2, record_meetings: [corpMeeting] },
    {
      total_count: 25, current_size: 5, current_page: 2, total_page: 2,
      record_meetings: [{ ...corpMeeting, meeting_record_id: 'rec-2' }],
    },
  ])
  const api = createRecordsApi(client, 'admin', memCache())
  const ms = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries).toHaveLength(2)
  expect(ms).toHaveLength(2)
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
  const api = createRecordsApi(client, 'admin', memCache())
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)

  expect(m!.startTime).toBe(1767225600)
  expect(m!.endTime).toBe(1767229200) // 第二段的结束时间，非第一段、非开始时间
  expect(m!.endTime).toBeGreaterThan(m!.startTime)
})

test('record_files 为空时回退到 media_start_time，不抛错', async () => {
  const { client } = stubClient([onePage([{ ...corpMeeting, record_files: [] }])])
  const api = createRecordsApi(client, 'admin', memCache())
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.endTime).toBe(1767225600)
})

test('record_files 缺失该字段时同样回退，不产生 NaN', async () => {
  const meeting = { ...corpMeeting, record_files: [{ record_file_id: 'f1' }] }
  const { client } = stubClient([onePage([meeting])])
  const api = createRecordsApi(client, 'admin', memCache())
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
// 不决定返回谁的。全公司归档必须走 `/v1/corp/records`（账户级）。
// ---------------------------------------------------------------------------

test('范围查询打的是 /v1/corp/records（账户级）', async () => {
  const { client, paths } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache())
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(paths).toEqual([CORP_RECORDS_PATH])
})

test('范围查询显式传 query_record_type=0——该接口默认 1（只有云录制），不传就漏掉上传录制与客户端录制', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache())
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries[0]!.query_record_type).toBe(0)
})

test('/v1/corp/records 没有 meeting_id / meeting_code 参数，任何查询都不得捎带它们', async () => {
  const { client, queries } = stubClient([onePage([corpMeeting])])
  const api = createRecordsApi(client, 'admin', memCache())
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  await api.listMeetings({ kind: 'id', meetingId: 'm-1' }, NOW)
  expect(queries.length).toBeGreaterThan(0)
  for (const q of queries) {
    expect(q.meeting_id).toBeUndefined()
    expect(q.meeting_code).toBeUndefined()
  }
})

test('企业维度响应的主持人字段是 userid——照搬 host_user_id 会让主持人静默变成 undefined', async () => {
  const { client } = stubClient([
    onePage([{ ...corpMeeting, userid: 'tm-bob', host_user_id: undefined }]),
  ])
  const api = createRecordsApi(client, 'admin', memCache())
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
  const api = createRecordsApi(client, 'admin', memCache())
  const ms = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(ms.map((m) => m.hostUserId)).toEqual(['tm-alice', 'tm-bob', 'tm-carol'])
})

test('userid 是空串（设备账号发起的快速会议）：放行成「没有主持人」，同一页其余会议照常', async () => {
  // 2026-09-03 实测形状：字段在，值是 ""，host_user_id 也是 ""。它曾让全公司的拉取整轮中止。
  const device = { ...corpMeeting, meeting_record_id: 'rec-device', meeting_id: 'm-device', subject: '擎天柱的快速会议', userid: '', host_user_id: '' }
  const { client } = stubClient([
    onePage([{ ...corpMeeting, meeting_record_id: 'rec-a', userid: 'tm-alice' }, device, { ...corpMeeting, meeting_record_id: 'rec-c', meeting_id: 'm-c', userid: 'tm-carol' }]),
  ])
  const ms = await createRecordsApi(client, 'admin', memCache()).listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(ms.map((m) => [m.meetingRecordId, m.hostUserId])).toEqual([['rec-a', 'tm-alice'], ['rec-device', ''], ['rec-c', 'tm-carol']])
})

test('企业维度响应**没有** userid 字段时抛错——那是接口形状变了，不静默产出整批没有主持人的会议', async () => {
  const noHost = { ...corpMeeting, meeting_record_id: 'rec-nohost', userid: undefined }

  const first = stubClient([onePage([noHost])])
  await expect(
    createRecordsApi(first.client, 'admin', memCache()).listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW),
  ).rejects.toThrow(/rec-nohost/)

  const second = stubClient([onePage([noHost])])
  await expect(
    createRecordsApi(second.client, 'admin', memCache()).listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW),
  ).rejects.toThrow(/userid/)
})

// ---------------------------------------------------------------------------
// 精确查询（kind: 'code' / 'id'）的解析顺序
//
// 2026-08-27 真实环境的 P0：范围查询改走 corp 之后 worker 一跑就崩——引擎拿着
// corp 发现的（别人主持的）meetingId 回头精确查一次，那一次走的还是
// `/v1/records`，看不见别人主持的会议，抛 MeetingNotFoundInRangeError 中止整轮。
//
// 现在的解析顺序：meeting_cache → `/v1/corp/records` 全窗口枚举 + 本地过滤 → 报错。
// `/v1/records` 整条路径已删除。
// ---------------------------------------------------------------------------

test('精确查询命中 meeting_cache 时一次 API 都不打', async () => {
  const { client, paths } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache([cached()]))

  const byId = await api.listMeetings({ kind: 'id', meetingId: 'm-1' }, NOW)
  const byCode = await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)

  expect(byId).toEqual([cached()])
  expect(byCode).toEqual([cached()])
  expect(paths).toEqual([]) // 零调用，配额一滴不花
})

test('精确查询命中缓存的多条（周期性会议复用同一 meeting_id）时全部返回，不擅自择一', async () => {
  const a = cached({ meetingRecordId: 'rec-a', startTime: 1000, endTime: 2000 })
  const b = cached({ meetingRecordId: 'rec-b', startTime: 3000, endTime: 4000 })
  const { client } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache([a, b]))

  const ms = await api.listMeetings({ kind: 'id', meetingId: 'm-1' }, NOW)
  expect(ms.map((m) => m.meetingRecordId).sort()).toEqual(['rec-a', 'rec-b'])
})

test('精确查询未命中缓存时回退到 /v1/corp/records 全窗口枚举，再本地按 id 过滤', async () => {
  const { client, paths } = stubClient([
    onePage([
      { ...corpMeeting, meeting_record_id: 'rec-a', meeting_id: 'm-a', userid: 'tm-alice' },
      { ...corpMeeting, meeting_record_id: 'rec-b', meeting_id: 'm-b', userid: 'tm-bob' },
    ]),
  ])
  const api = createRecordsApi(client, 'admin', memCache())

  const ms = await api.listMeetings({ kind: 'id', meetingId: 'm-b' }, NOW)
  expect(paths).toEqual([CORP_RECORDS_PATH])
  expect(ms.map((m) => m.meetingId)).toEqual(['m-b'])
  // 这一场是**别人**主持的——今天那个 P0 就死在这里
  expect(ms[0]!.hostUserId).toBe('tm-bob')
})

test('精确查询的回退把整窗口的会议全部写回缓存，不只是命中的那一场', async () => {
  const { client } = stubClient([
    onePage([
      { ...corpMeeting, meeting_record_id: 'rec-a', meeting_id: 'm-a', userid: 'tm-alice' },
      { ...corpMeeting, meeting_record_id: 'rec-b', meeting_id: 'm-b', userid: 'tm-bob' },
      { ...corpMeeting, meeting_record_id: 'rec-c', meeting_id: 'm-c', userid: 'tm-carol' },
    ]),
  ])
  const cache = memCache()
  const api = createRecordsApi(client, 'admin', cache)

  await api.listMeetings({ kind: 'id', meetingId: 'm-a' }, NOW)
  // 一次点名查询的代价是一整窗口的枚举，那一窗口的会议就必须全部进缓存，
  // 否则下一个人点名查另一场时又要把同样的配额再花一遍
  expect([...cache.rows.keys()].sort()).toEqual(['rec-a', 'rec-b', 'rec-c'])
})

test('回退之后再查同一场：第二次零调用（缓存已被上一次的枚举填满）', async () => {
  const { client, paths } = stubClient([
    onePage([{ ...corpMeeting, meeting_record_id: 'rec-a', meeting_id: 'm-a', userid: 'tm-bob' }]),
  ])
  const api = createRecordsApi(client, 'admin', memCache())

  await api.listMeetings({ kind: 'id', meetingId: 'm-a' }, NOW)
  expect(paths).toHaveLength(1)
  await api.listMeetings({ kind: 'id', meetingId: 'm-a' }, NOW)
  expect(paths).toHaveLength(1) // 没有第二次
})

test('范围查询把拉到的会议写进 meeting_cache——worker 的 discovery 一步喂饱后续所有点名查询', async () => {
  const { client } = stubClient([
    onePage([
      { ...corpMeeting, meeting_record_id: 'rec-a', meeting_id: 'm-a', userid: 'tm-alice' },
      { ...corpMeeting, meeting_record_id: 'rec-b', meeting_id: 'm-b', userid: 'tm-bob' },
    ]),
  ])
  const cache = memCache()
  const api = createRecordsApi(client, 'admin', cache)
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect([...cache.rows.keys()].sort()).toEqual(['rec-a', 'rec-b'])
})

test('缓存里 startTime 落在 from/to 之外的行不算命中——命中与回退的时间口径要一致', async () => {
  const { client, paths } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache([cached({ startTime: 500 })]))

  await expect(
    api.listMeetings({ kind: 'id', meetingId: 'm-1', from: 1000, to: 2000 }, NOW),
  ).rejects.toThrow(MeetingNotFoundInRangeError)
  // 缓存判不命中之后确实去问了平台，不是直接报错
  expect(paths).toEqual([CORP_RECORDS_PATH])
})

test('未给 from/to 时缓存不做时间过滤——调用方没画范围，就不该被默认窗口挡掉', async () => {
  // 引擎在 range 模式下调 listAssets 时 from/to 就是 undefined
  // （packages/engine/src/discovery/index.ts），而被发现的会议可能远在默认 31 天窗口之外
  const old = cached({ startTime: NOW - 400 * 86400, endTime: NOW - 400 * 86400 + 3600 })
  const { client, paths } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache([old]))

  const ms = await api.listMeetings({ kind: 'id', meetingId: 'm-1' }, NOW)
  expect(ms).toEqual([old])
  expect(paths).toEqual([])
})

test('回退窗口在未指定 from/to 时取最近 31 天', async () => {
  const { client, queries } = stubClient([onePage([corpMeeting])])
  const api = createRecordsApi(client, 'admin', memCache())
  await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(Number(queries[0]!.end_time)).toBe(NOW)
  expect(Number(queries[0]!.start_time)).toBe(NOW - 31 * 86400)
})

test('会议号命中多场时全部返回，不擅自择一（回退路径）', async () => {
  const { client } = stubClient([
    onePage([corpMeeting, { ...corpMeeting, meeting_id: 'm-2', meeting_record_id: 'rec-2' }]),
  ])
  const api = createRecordsApi(client, 'admin', memCache())
  const ms = await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(ms).toHaveLength(2)
})

test('会议号带分隔符时按去掉分隔符后比对——过去这一步是平台做的，改成本地过滤后必须自己做', async () => {
  const { client } = stubClient([onePage([corpMeeting])])
  const api = createRecordsApi(client, 'admin', memCache())
  const ms = await api.listMeetings({ kind: 'code', meetingCode: '881-234-56' }, NOW)
  expect(ms.map((m) => m.meetingCode)).toEqual(['88123456'])
})

test('按 ID 查询但范围内无结果时抛出可区分的错误', async () => {
  const { client } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache())
  await expect(api.listMeetings({ kind: 'id', meetingId: 'm-x' }, NOW))
    .rejects.toThrow(MeetingNotFoundInRangeError)
})

test('未命中的理由说的是「这个时间窗里没有」，且不得再说「只看得到 operator 自己的会议」', async () => {
  const { client } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin', memCache())
  const err = await api
    .listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
    .then(() => null)
    .catch((e: unknown) => e as Error)

  expect(err).toBeInstanceOf(MeetingNotFoundInRangeError)
  const msg = err!.message
  // 可回溯要素：查的是谁、查了哪个窗口、走过哪两级（缓存 + 企业维度全窗口枚举）
  expect(msg).toContain('88123456')
  expect(msg).toContain(String(NOW - 31 * 86400))
  expect(msg).toContain(CORP_RECORDS_PATH)
  expect(msg).toContain('meeting_cache')
  // 这条限制已经不成立了：精确查询不再走用户维度接口
  expect(msg).not.toContain('/v1/records')
  expect(msg).not.toMatch(/operator/i)
})

// ---------------------------------------------------------------------------
// 只做窗口枚举的那一层（createCorpRecordsApi）：preflight 用它探权限，
// 那里没有、也不该有一个数据库缓存
// ---------------------------------------------------------------------------

test('createCorpRecordsApi 只做窗口枚举，自己会切 31 天窗口', async () => {
  const { client, paths, queries } = stubClient([onePage([corpMeeting])])
  const corp = createCorpRecordsApi(client, 'admin')
  const ms = await corp.listRange(0, 90 * 86400)
  expect(paths).toEqual([CORP_RECORDS_PATH, CORP_RECORDS_PATH, CORP_RECORDS_PATH])
  expect(queries).toHaveLength(3)
  expect(ms).toHaveLength(3)
})
