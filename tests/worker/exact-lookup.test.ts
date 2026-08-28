import { afterAll, beforeAll, expect, test } from 'bun:test'
import { discover, type AssetKey, type MeetingSelector } from '@yaowu/mde-engine'
import type { Pool } from '../../src/store/db'
import type { QueryParams } from '../../src/tencent/url'
import type { TencentClient } from '../../src/tencent/client'
import type { Asset, Meeting } from '../../src/domain/types'
import { withTestDb } from '../helpers/testdb'
import { createMeetingCacheStore } from '../../src/store/meetings'
import { CORP_RECORDS_PATH, createRecordsApi } from '../../src/tencent/records'
import { createInProcSource } from '../../src/worker/source-inproc'
import { createMysqlStore } from '../../src/worker/store-mysql'

/**
 * 2026-08-27 的 P0，用真库跑一遍。
 *
 * ## 故障原样
 *
 * 范围查询改走 `/v1/corp/records`（全公司）之后 worker 一跑就崩：
 *
 *   corp 发现一场**别人主持的**会议
 *     → 引擎按拉取规则决定要拉它
 *     → `source-inproc` 的 `meetingsById` 拿 `{ kind: 'id' }` 回头精确查一次
 *       （catalog.listAssets 要完整的 Meeting，含 meetingRecordId，引擎只握着 meetingId）
 *     → 那一次走 `/v1/records`（用户维度，只看得见 operator 自己主持的）
 *     → 查不到 → MeetingNotFoundInRangeError → **整轮 worker 中止**
 *
 * 不是跳过一场，是整轮崩，而且只要拉到任何一场别人主持的会议就必然发生。
 *
 * ## 这个用例为什么能钉住它
 *
 * 打桩的腾讯客户端**按 path 分流**，并且把 `/v1/records` 实现成它在真实环境里
 * 的样子——空列表（operator 看不见别人主持的会议）。所以修复前这条用例会以
 * MeetingNotFoundInRangeError 失败，而不是"碰巧过了"。
 *
 * 缓存是**真的** `meeting_cache`（真库），不是内存替身：这次修复的成败全押在
 * 「discovery 那一步写进去的行，listAssets 那一步查得回来」上，这一步用替身
 * 测就等于没测。
 */

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

const NOW = 1_800_000_000
const OPERATOR = 'tm-operator'
const KEYS: AssetKey[] = ['video']

/** 一页 `/v1/corp/records` 响应。主持人字段是 `userid`，不是 host_user_id */
function corpMeeting(o: { recordId: string; meetingId: string; code: string; host: string }): Record<string, unknown> {
  return {
    meeting_record_id: o.recordId,
    meeting_id: o.meetingId,
    meeting_code: o.code,
    subject: '别人主持的评审会',
    media_start_time: (NOW - 3600) * 1000,
    state: 3,
    userid: o.host,
    record_files: [{ record_file_id: `f-${o.recordId}`, record_end_time: NOW * 1000 }],
  }
}

interface StubCalls {
  client: TencentClient
  paths: string[]
  corpQueries: QueryParams[]
}

/**
 * 按 path 分流的腾讯客户端。
 *
 * `/v1/records` 返回**空列表**——那正是真实环境里它对别人主持的会议的回答，
 * 也正是这次 P0 的成因。留着这一条不是为了兼容，是为了让"精确查询偷偷退回
 * 用户维度接口"这件事在测试里当场失败。
 */
function stubClient(pages: Record<string, unknown>[][]): StubCalls {
  const paths: string[] = []
  const corpQueries: QueryParams[] = []
  let corpCall = 0
  return {
    paths,
    corpQueries,
    client: {
      get: async <T,>(path: string, query: QueryParams): Promise<T> => {
        paths.push(path)
        if (path === CORP_RECORDS_PATH) {
          corpQueries.push(query)
          const page = pages[Math.min(corpCall++, pages.length - 1)] ?? []
          return {
            total_page: pages.length,
            record_meetings: page,
          } as T
        }
        if (path === '/v1/records') return { total_page: 1, record_meetings: [] } as T
        return {} as T
      },
      post: async <T,>() => ({}) as T,
      currentQps: () => 5,
    },
  }
}

/** 每场会议一条 video 资产，够 discover 建出下载任务即可 */
function stubCatalog(): { listAssets: (m: Meeting) => Promise<Asset[]>; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    listAssets: async (m: Meeting) => {
      // catalog 要的是**完整的** Meeting：meetingRecordId 缺了就解析不出下载地址
      expect(m.meetingRecordId).not.toBe('')
      seen.push(m.meetingRecordId)
      return [
        {
          assetId: `${m.meetingRecordId}:f-${m.meetingRecordId}:video:0`,
          meetingId: m.meetingId,
          subMeetingId: m.subMeetingId,
          assetType: 'video',
          recordFileId: `f-${m.meetingRecordId}`,
          fileType: 'mp4',
          bytesExpected: 1024,
          allowDownload: true,
        },
      ]
    },
  }
}

function buildSource(client: TencentClient, catalog: ReturnType<typeof stubCatalog>) {
  const recordsApi = createRecordsApi(client, OPERATOR, createMeetingCacheStore(pool))
  return createInProcSource({
    recordsApi,
    catalog: { listAssets: catalog.listAssets, resolveDownloadUrl: async () => ({ url: 'x', expiresAt: 0 }) },
    now: () => NOW,
  })
}

const RANGE: MeetingSelector = { kind: 'range', from: NOW - 86400, to: NOW }

test('P0 回归：corp 发现一场别人主持的会议，走完 listAssets 不抛 MeetingNotFoundInRangeError', async () => {
  const stub = stubClient([
    [corpMeeting({ recordId: 'rec-bob-1', meetingId: 'm-bob-1', code: '900000001', host: 'tm-bob' })],
  ])
  const catalog = stubCatalog()
  const source = buildSource(stub.client, catalog)

  const res = await discover({ gw: source, store: createMysqlStore(pool) }, RANGE, KEYS, NOW)

  // 崩溃的那一轮在这里抛错并中止；现在它把这场会议的资产建成了任务
  expect(res.meetings).toBe(1)
  expect(res.tasks).toBe(1)
  expect(catalog.seen).toEqual(['rec-bob-1'])
  // 精确反查一次都没退回用户维度接口
  expect(stub.paths).not.toContain('/v1/records')
})

test('一轮里 corp 只被调用分页所需的次数——listAssets 不额外打一次（10次/min 的配额押在这上面）', async () => {
  const meetings = Array.from({ length: 5 }, (_, i) =>
    corpMeeting({
      recordId: `rec-q-${i}`,
      meetingId: `m-q-${i}`,
      code: `90001000${i}`,
      host: `tm-host-${i}`, // 五个人各主持一场，没有一场是 operator 自己的
    }),
  )
  const stub = stubClient([meetings])
  const catalog = stubCatalog()
  const source = buildSource(stub.client, catalog)

  const res = await discover({ gw: source, store: createMysqlStore(pool) }, RANGE, KEYS, NOW)

  expect(res.meetings).toBe(5)
  expect(res.tasks).toBe(5)
  // 一个 31 天以内的窗口 + 单页 ⇒ 分页需要的次数就是 1。五场会议的 listAssets
  // 全部由 discovery 那一步写进 meeting_cache 的行喂饱，一次额外调用都没有。
  const corpCalls = stub.paths.filter((p) => p === CORP_RECORDS_PATH)
  expect(corpCalls).toHaveLength(1)
  expect(stub.paths).not.toContain('/v1/records')
})

test('分页多页时 corp 的调用次数等于页数，仍然不因 listAssets 增加', async () => {
  const stub = stubClient([
    [corpMeeting({ recordId: 'rec-pg-1', meetingId: 'm-pg-1', code: '900002001', host: 'tm-x' })],
    [corpMeeting({ recordId: 'rec-pg-2', meetingId: 'm-pg-2', code: '900002002', host: 'tm-y' })],
  ])
  const catalog = stubCatalog()
  const source = buildSource(stub.client, catalog)

  const res = await discover({ gw: source, store: createMysqlStore(pool) }, RANGE, KEYS, NOW)

  expect(res.meetings).toBe(2)
  expect(stub.paths.filter((p) => p === CORP_RECORDS_PATH)).toHaveLength(2)
})
