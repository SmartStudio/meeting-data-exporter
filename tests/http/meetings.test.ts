import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import type { QueryParams } from '../../src/tencent/url'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp, insertPolicyRule, JWT_SECRET } from './testApp'
import { signAccessToken } from '../../src/auth/tokens'
import type { ActorIdentity } from '../../src/domain/types'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

const NOW = 1_700_000_000

function rawMeeting(o: {
  meeting_record_id: string
  meeting_id: string
  meeting_code: string
  host_user_id: string
  subject?: string
  state?: number
}): unknown {
  return {
    meeting_record_id: o.meeting_record_id,
    meeting_id: o.meeting_id,
    meeting_code: o.meeting_code,
    host_user_id: o.host_user_id,
    media_start_time: NOW * 1000,
    subject: o.subject ?? '测试会议',
    state: o.state ?? 3,
    record_type: 0,
    record_files: [],
  }
}

function recordsPage(meetings: unknown[]): unknown {
  return { total_page: 1, record_meetings: meetings }
}

function addressesPage(files: unknown[]): unknown {
  return { total_page: 1, record_files: files }
}

function bearer(identity: ActorIdentity, now = NOW): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken(identity, JWT_SECRET, now)}` }
}

test('列表按策略过滤，被拒的会议不出现', async () => {
  const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-alice-1', tmUserId: 'tm-alice-1' }
  const meetingA = rawMeeting({
    meeting_record_id: 'rec-a-1', meeting_id: 'm-a-1', meeting_code: '881', host_user_id: 'tm-alice-1',
  })
  const meetingB = rawMeeting({
    meeting_record_id: 'rec-b-1', meeting_id: 'm-b-1', meeting_code: '882', host_user_id: 'tm-bob-1',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (path === '/v1/records' ? recordsPage([meetingA, meetingB]) : {}),
  })
  await insertPolicyRule(pool, {
    priority: 10, subjectType: 'user', subjectValue: 'tm-alice-1',
    resourceExpr: { host_userid: 'tm-alice-1' }, assetTypes: ['*'], effect: 'allow',
  })

  const res = await app(new Request('https://gw/api/v1/meetings', { headers: bearer(alice) }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { meetings: Array<{ meeting_id: string }> }
  expect(body.meetings.map((m) => m.meeting_id)).toEqual(['m-a-1'])
})

test('download-url 对无权资产返回 403 且写审计', async () => {
  const carol: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-carol-1', tmUserId: 'tm-carol-1' }
  const meeting = rawMeeting({
    meeting_record_id: 'rec-carol-1', meeting_id: 'm-carol-1', meeting_code: '883', host_user_id: 'tm-carol-1',
  })
  const addressFile = {
    record_file_id: 'file-carol-1', download_address: 'https://cos/carol.mp4', download_address_file_type: 'mp4',
  }

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => {
      if (path === '/v1/records') return recordsPage([meeting])
      if (path === '/v1/addresses') return addressesPage([addressFile])
      return {}
    },
  })
  // 有意不插入任何策略规则：默认 deny

  const headers = bearer(carol)

  // 先列资产，使 meeting 元数据写入缓存（真实客户端流程必然先看到 assetId）
  const listRes = await app(new Request('https://gw/api/v1/meetings/m-carol-1/assets', { headers }))
  expect(listRes.status).toBe(200)
  const listBody = (await listRes.json()) as { assets: unknown[] }
  expect(listBody.assets).toEqual([]) // 列资产同样过滤：无权限的资产不展示

  const assetId = 'rec-carol-1:file-carol-1:video:0'
  const dlRes = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(dlRes.status).toBe(403)
  expect((await dlRes.json()).error).toBe('forbidden')

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT decision, actor_id, action FROM audit_log WHERE asset_id = ?',
    [assetId],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]!.decision).toBe('deny')
  expect(rows[0]!.actor_id).toBe('tm-carol-1')
  expect(rows[0]!.action).toBe('issue_download_url')
})

test('download-url 对越权构造的 assetId 返回 403（不是 404）', async () => {
  const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-alice-2', tmUserId: 'tm-alice-2' }
  const meetingA = rawMeeting({
    meeting_record_id: 'rec-a-2', meeting_id: 'm-a-2', meeting_code: '884', host_user_id: 'tm-alice-2',
  })
  const meetingB = rawMeeting({
    meeting_record_id: 'rec-b-2', meeting_id: 'm-b-2', meeting_code: '885', host_user_id: 'tm-bob-2',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (path === '/v1/records' ? recordsPage([meetingA, meetingB]) : {}),
  })
  await insertPolicyRule(pool, {
    priority: 10, subjectType: 'user', subjectValue: 'tm-alice-2',
    resourceExpr: { host_userid: 'tm-alice-2' }, assetTypes: ['*'], effect: 'allow',
  })

  const headers = bearer(alice)
  // 列会议使 meetingB 也进入 meeting_cache（尽管它对 alice 不可见——缓存写入
  // 与展示过滤是两回事，见 http/handlers/meetings.ts 的注释）
  await app(new Request('https://gw/api/v1/meetings', { headers }))

  // alice 构造出她从未被授权查看的 meetingB 下某资产的 assetId
  const foreignAssetId = 'rec-b-2:file-b-2:video:0'
  const res = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(foreignAssetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(res.status).toBe(403)
  expect((await res.json()).error).toBe('forbidden')
})

test('download-url 对从未被任何人列出过的 meetingRecordId 同样返回 403 而非 404', async () => {
  const henry: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-henry-1', tmUserId: 'tm-henry-1' }
  const { app } = buildTestApp(pool, { now: () => NOW })

  const res = await app(
    new Request('https://gw/api/v1/assets/never-cached-rec:file-x:video:0/download-url', {
      method: 'POST',
      headers: bearer(henry),
    }),
  )
  expect(res.status).toBe(403)
  expect((await res.json()).error).toBe('forbidden')
})

test('未传 from/to 时默认最近 31 天', async () => {
  const dave: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-dave-1', tmUserId: 'tm-dave-1' }
  const queries: QueryParams[] = []
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path, query) => {
      if (path === '/v1/records') {
        queries.push(query)
        return recordsPage([])
      }
      return {}
    },
  })

  const res = await app(new Request('https://gw/api/v1/meetings', { headers: bearer(dave) }))
  expect(res.status).toBe(200)
  expect(queries).toHaveLength(1)
  expect(Number(queries[0]!.start_time)).toBe(NOW - 31 * 86400)
  expect(Number(queries[0]!.end_time)).toBe(NOW)
})

test('meeting_code 命中多场时返回数组而非单个对象', async () => {
  const erin: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-erin-1', tmUserId: 'tm-erin-1' }
  const m1 = rawMeeting({
    meeting_record_id: 'rec-e-1', meeting_id: 'm-e-1', meeting_code: '886', host_user_id: 'tm-erin-1',
  })
  const m2 = rawMeeting({
    meeting_record_id: 'rec-e-2', meeting_id: 'm-e-2', meeting_code: '886', host_user_id: 'tm-erin-1',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (path === '/v1/records' ? recordsPage([m1, m2]) : {}),
  })
  await insertPolicyRule(pool, {
    priority: 10, subjectType: 'user', subjectValue: 'tm-erin-1',
    resourceExpr: {}, assetTypes: ['*'], effect: 'allow',
  })

  const res = await app(
    new Request('https://gw/api/v1/meetings?meeting_code=886', { headers: bearer(erin) }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { meetings: Array<{ meeting_code: string }> }
  expect(body.meetings).toHaveLength(2)
  expect(body.meetings.every((m) => m.meeting_code === '886')).toBe(true)
})

test('范围外未命中返回 404 且 error 为 meeting_not_found_in_range（单场详情端点）', async () => {
  const frank: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-frank-1', tmUserId: 'tm-frank-1' }
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (path === '/v1/records' ? recordsPage([]) : {}),
  })

  const res = await app(
    new Request('https://gw/api/v1/meetings/m-does-not-exist', { headers: bearer(frank) }),
  )
  expect(res.status).toBe(404)
  expect((await res.json()).error).toBe('meeting_not_found_in_range')
})

test('范围外未命中返回 404（列表端点携带 meeting_id 过滤时同样适用）', async () => {
  const frank2: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-frank-2', tmUserId: 'tm-frank-2' }
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (path === '/v1/records' ? recordsPage([]) : {}),
  })

  const res = await app(
    new Request('https://gw/api/v1/meetings?meeting_id=m-does-not-exist', { headers: bearer(frank2) }),
  )
  expect(res.status).toBe(404)
  expect((await res.json()).error).toBe('meeting_not_found_in_range')
})

test('STS-Token 不可用时 ai_* 资产不出现，video 仍可下载', async () => {
  const grace: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-grace-1', tmUserId: 'tm-grace-1' }
  const meeting = rawMeeting({
    meeting_record_id: 'rec-g-1', meeting_id: 'm-g-1', meeting_code: '887', host_user_id: 'tm-grace-1',
  })
  const addressFile = {
    record_file_id: 'file-g-1', download_address: 'https://cos/video.mp4', download_address_file_type: 'mp4',
  }
  let detailCalls = 0

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => {
      if (path === '/v1/records') return recordsPage([meeting])
      if (path === '/v1/addresses') return addressesPage([addressFile])
      if (path.startsWith('/v1/addresses/')) {
        detailCalls += 1
        return {}
      }
      return {}
    },
  })
  await insertPolicyRule(pool, {
    priority: 10, subjectType: 'user', subjectValue: 'tm-grace-1',
    resourceExpr: {}, assetTypes: ['*'], effect: 'allow',
  })

  const headers = bearer(grace)
  const res = await app(new Request('https://gw/api/v1/meetings/m-g-1/assets', { headers }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { assets: Array<{ asset_type: string }> }
  expect(body.assets.map((a) => a.asset_type)).toEqual(['video'])
  // STS 不可用时 tryGetToken 提前短路，详情接口（AI 纪要来源）完全不应被调用
  expect(detailCalls).toBe(0)

  const assetId = 'rec-g-1:file-g-1:video:0'
  const dlRes = await app(
    new Request(`https://gw/api/v1/assets/${assetId}/download-url`, { method: 'POST', headers }),
  )
  expect(dlRes.status).toBe(200)
  const dlBody = (await dlRes.json()) as { url: string; expires_at: number }
  expect(dlBody.url).toBe('https://cos/video.mp4')
  expect(dlBody.expires_at).toBeGreaterThan(NOW)
})

test('STS-Token 不可用时请求 ai_* 资产的 download-url 返回 503（而非崩溃或误签发）', async () => {
  const ivan: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-ivan-1', tmUserId: 'tm-ivan-1' }
  const meeting = rawMeeting({
    meeting_record_id: 'rec-i-1', meeting_id: 'm-i-1', meeting_code: '888', host_user_id: 'tm-ivan-1',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (path === '/v1/records' ? recordsPage([meeting]) : {}),
  })
  await insertPolicyRule(pool, {
    priority: 10, subjectType: 'user', subjectValue: 'tm-ivan-1',
    resourceExpr: {}, assetTypes: ['*'], effect: 'allow',
  })

  const headers = bearer(ivan)
  // 先让 meeting 进入缓存（不依赖 /assets 列表，直接用 /meetings 即可）
  await app(new Request('https://gw/api/v1/meetings', { headers }))

  const assetId = 'rec-i-1:file-i-1:ai_minutes:0'
  const dlRes = await app(
    new Request(`https://gw/api/v1/assets/${assetId}/download-url`, { method: 'POST', headers }),
  )
  expect(dlRes.status).toBe(503)
  expect((await dlRes.json()).error).toBe('sts_token_unavailable')
})

test('malformed assetId 返回 400 invalid_asset_id', async () => {
  const judy: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-judy-1', tmUserId: 'tm-judy-1' }
  const { app } = buildTestApp(pool, { now: () => NOW })

  const res = await app(
    new Request('https://gw/api/v1/assets/not-a-valid-asset-id/download-url', {
      method: 'POST',
      headers: bearer(judy),
    }),
  )
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('invalid_asset_id')
})

test('GET /healthz 无需鉴权，返回 200', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(new Request('https://gw/healthz'))
  expect(res.status).toBe(200)
  expect((await res.json()).status).toBe('ok')
})

test('未知路径返回 404', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(new Request('https://gw/api/v1/does-not-exist'))
  expect(res.status).toBe(404)
})
