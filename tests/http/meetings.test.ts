import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import type { QueryParams } from '../../src/tencent/url'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp, insertGrant, insertPolicyRule, insertServiceProgram, JWT_SECRET } from './testApp'
import { signAccessToken } from '../../src/auth/tokens'
import type { ActorIdentity } from '../../src/domain/types'

let pool: Pool
let cleanup: () => Promise<void>

/**
 * 本文件用到的全部采集程序（阶段 5 · A8）。
 *
 * **一条 allow 规则不足以让判定放行**：AccessGate 在读规则之前先问
 * `service_accounts.enabled`——查不到这个 id 或者它被停用了，一律拒绝，
 * 且理由里写明是「程序已停用」而不是「没有规则匹配」（见 src/policy/access.ts
 * 的 programDisabled）。这条判断必须在判定层而不是只在换令牌那一层：
 * 本文件的用例正是自己签 JWT、不走 POST /auth/service-token 的那条路，
 * 而线上「停用之后还没过期的令牌」走的也是同一条路。
 *
 * 所以这里一次性把它们建出来。停用的表现由 tests/policy/access.test.ts
 * 与 tests/http/console-grants.test.ts 覆盖，本文件只需要它们都是启用的。
 *
 * **同理，一条 allow 规则也不足以让判定放行**（阶段 6）：AccessGate 在套完人工改写
 * 之后还要过一道逐会议授权（`meeting_grants`，spec §1.3 三个「与」的第一个）。
 * 所以本文件里凡是断言「取得到」的用例，除了造规则还要 `insertGrant`——
 * 两个条件分别由不同的人在不同的页面维护，测试里也就得分别造。
 */
const TEST_PROGRAM_IDS = [
    'prog-alice-1',
    'prog-alice-2',
    'prog-carol-1',
    'prog-dave-1',
    'prog-erin-1',
    'prog-frank-1',
    'prog-frank-2',
    'prog-grace-1',
    'prog-henry-1',
    'prog-ivan-1',
    'prog-judy-1',
    'prog-kate-1',
    'prog-lena-1',
    'prog-noaccess-1',
] as const

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
  for (const id of TEST_PROGRAM_IDS) await insertServiceProgram(pool, { id })
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

/**
 * 供给 `/v1/corp/records`——网关唯一会调的会议列表接口（范围查询与精确查询都走它，
 * 见 src/tencent/records.ts 的文件头）。
 *
 * fixture 里主持人写作 `host_user_id`，这里改名成 `userid` 再吐出去：那个接口的
 * wire 形状就是这样，照搬 host_user_id 会让主持人静默变成 undefined。故意让两个
 * 名字不同，这个 bug 才不会在测试里蒙混过关。
 *
 * 返回 null 表示该 path 不是会议列表接口，调用方继续往下判断。
 */
function recordsFor(path: string, meetings: unknown[]): unknown | null {
  if (path !== '/v1/corp/records') return null
  return recordsPage(
    meetings.map((m) => {
      const { host_user_id: host, ...rest } = m as Record<string, unknown>
      return { ...rest, userid: host }
    }),
  )
}

function addressesPage(files: unknown[]): unknown {
  return { total_page: 1, record_files: files }
}

function bearer(identity: ActorIdentity, now = NOW): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken(identity, JWT_SECRET, now)}` }
}

test('列表按策略过滤，被拒的会议不出现', async () => {
  const alice: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-alice-1', programId: 'prog-alice-1',
  }
  const meetingA = rawMeeting({
    meeting_record_id: 'rec-a-1', meeting_id: 'm-a-1', meeting_code: '881', host_user_id: 'tm-alice-1',
  })
  const meetingB = rawMeeting({
    meeting_record_id: 'rec-b-1', meeting_id: 'm-b-1', meeting_code: '882', host_user_id: 'tm-bob-1',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (recordsFor(path, [meetingA, meetingB]) ?? {}),
  })
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-alice-1',
    conds: [{ f: 'host', op: 'is', v: 'tm-alice-1' }], assetTypes: ['*'], effect: 'allow',
  })
  // 两场都授权，这条用例问的才是「规则把 B 过滤掉了」——只授权 A 的话，
  // B 不出现在列表里也可能只是因为它没授权，规则那一半就再也没被验证过
  await insertGrant(pool, { meetingId: 'm-a-1', programId: 'prog-alice-1' })
  await insertGrant(pool, { meetingId: 'm-b-1', programId: 'prog-alice-1' })

  const res = await app(new Request('https://gw/api/v1/meetings', { headers: bearer(alice) }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { meetings: Array<{ meeting_id: string }> }
  expect(body.meetings.map((m) => m.meeting_id)).toEqual(['m-a-1'])
})

test('单场详情对无可见权限的会议返回 404，且不泄露会议属性（不是无条件全量返回）', async () => {
  const noAccess: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-noaccess-1', programId: 'prog-noaccess-1',
  }
  const secretMeeting = rawMeeting({
    meeting_record_id: 'rec-secret-1',
    meeting_id: 'm-secret-1',
    meeting_code: '999',
    host_user_id: 'tm-owner-1',
    subject: '并购谈判纪要',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (recordsFor(path, [secretMeeting]) ?? {}),
  })
  // 有意不插入任何策略规则：noAccess 对该会议的任何资产类型都判定为 deny，
  // 因此按 listMeetings 相同口径，这场会议对她不可见。

  // 对照：列表端点对同一场会议已经正确过滤为 0 条（回归锚点）。
  const listRes = await app(new Request('https://gw/api/v1/meetings', { headers: bearer(noAccess) }))
  expect(listRes.status).toBe(200)
  expect(((await listRes.json()) as { meetings: unknown[] }).meetings).toEqual([])

  // 漏洞点：直接按 meeting_id 查详情，此前会绕过可见性检查直接吐出会议属性。
  const res = await app(
    new Request('https://gw/api/v1/meetings/m-secret-1', { headers: bearer(noAccess) }),
  )
  expect(res.status).toBe(404)
  const body = (await res.json()) as Record<string, unknown>
  expect(body.error).toBe('meeting_not_found_in_range')
  // 响应体不得包含该会议的任何属性——subject 这类元数据本身可能敏感
  expect(body.subject).toBeUndefined()
  expect(body.host_user_id).toBeUndefined()
  expect(body.start_time).toBeUndefined()
  expect(body.end_time).toBeUndefined()
  expect(body.assets).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain('并购谈判纪要')
  expect(JSON.stringify(body)).not.toContain('tm-owner-1')
})

test('download-url 对无权资产返回 403 且写审计', async () => {
  const carol: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-carol-1', programId: 'prog-carol-1',
  }
  const meeting = rawMeeting({
    meeting_record_id: 'rec-carol-1', meeting_id: 'm-carol-1', meeting_code: '883', host_user_id: 'tm-carol-1',
  })
  const addressFile = {
    record_file_id: 'file-carol-1', download_address: 'https://cos/carol.mp4', download_address_file_type: 'mp4',
  }

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => {
      const meetingsRes = recordsFor(path, [meeting])
      if (meetingsRes) return meetingsRes
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
  const alice: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-alice-2', programId: 'prog-alice-2',
  }
  const meetingA = rawMeeting({
    meeting_record_id: 'rec-a-2', meeting_id: 'm-a-2', meeting_code: '884', host_user_id: 'tm-alice-2',
  })
  const meetingB = rawMeeting({
    meeting_record_id: 'rec-b-2', meeting_id: 'm-b-2', meeting_code: '885', host_user_id: 'tm-bob-2',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (recordsFor(path, [meetingA, meetingB]) ?? {}),
  })
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-alice-2',
    conds: [{ f: 'host', op: 'is', v: 'tm-alice-2' }], assetTypes: ['*'], effect: 'allow',
  })
  // 同上：两场都授权，这条 403 才确实是「规则不放行别人主持的会议」，
  // 而不是「m-b-2 恰好没授权」
  await insertGrant(pool, { meetingId: 'm-a-2', programId: 'prog-alice-2' })
  await insertGrant(pool, { meetingId: 'm-b-2', programId: 'prog-alice-2' })

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
  const henry: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-henry-1', programId: 'prog-henry-1',
  }
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

test('download-url 写入 audit_log.meeting_id 在缓存命中/未命中两条路径下语义一致（均为 meetingRecordId 维度）', async () => {
  const kate: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-kate-1', programId: 'prog-kate-1',
  }
  const meeting = rawMeeting({
    meeting_record_id: 'rec-kate-1', meeting_id: 'm-kate-1', meeting_code: '890', host_user_id: 'tm-kate-1',
  })
  const addressFile = {
    record_file_id: 'file-kate-1', download_address: 'https://cos/kate.mp4', download_address_file_type: 'mp4',
  }

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => {
      const meetingsRes = recordsFor(path, [meeting])
      if (meetingsRes) return meetingsRes
      if (path === '/v1/addresses') return addressesPage([addressFile])
      return {}
    },
  })
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-kate-1', assetTypes: ['*'], effect: 'allow',
  })
  await insertGrant(pool, { meetingId: 'm-kate-1', programId: 'prog-kate-1' })

  const headers = bearer(kate)

  // 缓存未命中分支：meetingRecordId 从未被任何人列出过，网关根本拿不到真正的
  // Tencent meeting_id，只有 record_id 可用。
  const missAssetId = 'rec-never-listed-kate:file-x:video:0'
  const missRes = await app(
    new Request(`https://gw/api/v1/assets/${missAssetId}/download-url`, { method: 'POST', headers }),
  )
  expect(missRes.status).toBe(403) // 未命中一律 deny（见 downloadUrl 注释）

  // 缓存命中分支：先列会议使其进入 meeting_cache，此时网关同时知道
  // meetingRecordId 与真正的 meeting_id 两者。
  await app(new Request('https://gw/api/v1/meetings', { headers }))
  const hitAssetId = 'rec-kate-1:file-kate-1:video:0'
  const hitRes = await app(
    new Request(`https://gw/api/v1/assets/${hitAssetId}/download-url`, { method: 'POST', headers }),
  )
  expect(hitRes.status).toBe(200)

  const [missRows] = await pool.execute<RowDataPacket[]>(
    'SELECT meeting_id FROM audit_log WHERE asset_id = ?',
    [missAssetId],
  )
  const [hitRows] = await pool.execute<RowDataPacket[]>(
    'SELECT meeting_id FROM audit_log WHERE asset_id = ?',
    [hitAssetId],
  )
  expect(missRows).toHaveLength(1)
  expect(hitRows).toHaveLength(1)

  // 两条路径统一填 meetingRecordId（record 维度），而不是一边 record_id
  // 一边 Tencent meeting_id——否则合规人员按 meeting_id 聚合分析时会被误导。
  expect(missRows[0]!.meeting_id).toBe('rec-never-listed-kate')
  expect(hitRows[0]!.meeting_id).toBe('rec-kate-1')
  expect(hitRows[0]!.meeting_id).not.toBe('m-kate-1') // 不再是 Tencent meeting_id
})

test('未传 from/to 时默认最近 31 天', async () => {
  const dave: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-dave-1', programId: 'prog-dave-1',
  }
  const queries: QueryParams[] = []
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path, query) => {
      const meetingsRes = recordsFor(path, [])
      if (meetingsRes) {
        queries.push(query)
        return meetingsRes
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
  const erin: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-erin-1', programId: 'prog-erin-1',
  }
  const m1 = rawMeeting({
    meeting_record_id: 'rec-e-1', meeting_id: 'm-e-1', meeting_code: '886', host_user_id: 'tm-erin-1',
  })
  const m2 = rawMeeting({
    meeting_record_id: 'rec-e-2', meeting_id: 'm-e-2', meeting_code: '886', host_user_id: 'tm-erin-1',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (recordsFor(path, [m1, m2]) ?? {}),
  })
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-erin-1', assetTypes: ['*'], effect: 'allow',
  })
  await insertGrant(pool, { meetingId: 'm-e-1', programId: 'prog-erin-1' })
  await insertGrant(pool, { meetingId: 'm-e-2', programId: 'prog-erin-1' })

  const res = await app(
    new Request('https://gw/api/v1/meetings?meeting_code=886', { headers: bearer(erin) }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { meetings: Array<{ meeting_code: string }> }
  expect(body.meetings).toHaveLength(2)
  expect(body.meetings.every((m) => m.meeting_code === '886')).toBe(true)
})

test('范围外未命中返回 404 且 error 为 meeting_not_found_in_range（单场详情端点）', async () => {
  const frank: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-frank-1', programId: 'prog-frank-1',
  }
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (recordsFor(path, []) ?? {}),
  })

  const res = await app(
    new Request('https://gw/api/v1/meetings/m-does-not-exist', { headers: bearer(frank) }),
  )
  expect(res.status).toBe(404)
  expect((await res.json()).error).toBe('meeting_not_found_in_range')
})

test('范围外未命中返回 404（列表端点携带 meeting_id 过滤时同样适用）', async () => {
  const frank2: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-frank-2', programId: 'prog-frank-2',
  }
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (recordsFor(path, []) ?? {}),
  })

  const res = await app(
    new Request('https://gw/api/v1/meetings?meeting_id=m-does-not-exist', { headers: bearer(frank2) }),
  )
  expect(res.status).toBe(404)
  expect((await res.json()).error).toBe('meeting_not_found_in_range')
})

test('STS-Token 不可用时 ai_* 资产不出现，video 仍可下载', async () => {
  const grace: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-grace-1', programId: 'prog-grace-1',
  }
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
      const meetingsRes = recordsFor(path, [meeting])
      if (meetingsRes) return meetingsRes
      if (path === '/v1/addresses') return addressesPage([addressFile])
      if (path.startsWith('/v1/addresses/')) {
        detailCalls += 1
        return {}
      }
      return {}
    },
  })
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-grace-1', assetTypes: ['*'], effect: 'allow',
  })
  await insertGrant(pool, { meetingId: 'm-g-1', programId: 'prog-grace-1' })

  const headers = bearer(grace)
  const res = await app(new Request('https://gw/api/v1/meetings/m-g-1/assets', { headers }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { assets: Array<{ asset_type: string; remote_id: string }> }
  expect(body.assets.map((a) => a.asset_type)).toEqual(['video'])
  // remote_id 必须是 recordFileId（腾讯会议 record_file_id），而非整个自包含的 asset_id
  expect(body.assets.map((a) => a.remote_id)).toEqual(['file-g-1'])
  // STS 不可用时 tryGetToken 提前短路，详情接口（优化版逐字稿的唯一来源）完全不应被调用
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

test('STS-Token 不可用时请求优化版逐字稿的 download-url 返回 503（而非崩溃或误签发）', async () => {
  const ivan: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-ivan-1', programId: 'prog-ivan-1',
  }
  const meeting = rawMeeting({
    meeting_record_id: 'rec-i-1', meeting_id: 'm-i-1', meeting_code: '888', host_user_id: 'tm-ivan-1',
  })

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => (recordsFor(path, [meeting]) ?? {}),
  })
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-ivan-1', assetTypes: ['*'], effect: 'allow',
  })
  await insertGrant(pool, { meetingId: 'm-i-1', programId: 'prog-ivan-1' })

  const headers = bearer(ivan)
  // 先让 meeting 进入缓存（不依赖 /assets 列表，直接用 /meetings 即可）
  await app(new Request('https://gw/api/v1/meetings', { headers }))

  // 详情接口那一类（要 STS）现在只剩优化版逐字稿；纪要与时间轴走智能接口，
  // 不依赖 STS，拿它们来测这条会测不出东西
  const assetId = 'rec-i-1:file-i-1:ai_meeting_transcripts:docx'
  const dlRes = await app(
    new Request(`https://gw/api/v1/assets/${assetId}/download-url`, { method: 'POST', headers }),
  )
  expect(dlRes.status).toBe(503)
  expect((await dlRes.json()).error).toBe('sts_token_unavailable')
})

test('malformed assetId 返回 400 invalid_asset_id', async () => {
  const judy: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-judy-1', programId: 'prog-judy-1',
  }
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

// ── 三个「与」的第一个：逐会议授权（阶段 6，2026-09-03）────────────────────
//
// 此前网关只判第三个「与」（采集权限规则）。于是**只要库里有一条 allow 规则**，
// 任何启用中的采集程序不需要任何授权就能列出会议、拿到下载地址，而采集授权页
// 按授权行枚举，同一场会议在那边显示「0 场对它开放」——控制台说 0、程序实际取得到。
// 这一条端到端地钉住那道闸门：规则放行了，没有授权行照样一个字节都出不去。

test('有 allow 规则但没有授权行：列不出来、详情 404、download-url 403 且审计说得出是授权', async () => {
  const lena: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-lena-1', programId: 'prog-lena-1',
  }
  const meeting = rawMeeting({
    meeting_record_id: 'rec-l-1', meeting_id: 'm-l-1', meeting_code: '891', host_user_id: 'tm-lena-1',
  })
  const addressFile = {
    record_file_id: 'file-l-1', download_address: 'https://cos/lena.mp4', download_address_file_type: 'mp4',
  }

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => {
      const meetingsRes = recordsFor(path, [meeting])
      if (meetingsRes) return meetingsRes
      if (path === '/v1/addresses') return addressesPage([addressFile])
      return {}
    },
  })
  // 规则放行全部八类，但一条授权行都没有
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-lena-1', assetTypes: ['*'], effect: 'allow',
  })

  const headers = bearer(lena)

  const listRes = await app(new Request('https://gw/api/v1/meetings', { headers }))
  expect(listRes.status).toBe(200)
  expect(((await listRes.json()) as { meetings: unknown[] }).meetings).toEqual([])

  // 详情走的是 decide 而不是 decideMany——两条路径判得一样，列表里没有的这里也进不去
  const detailRes = await app(new Request('https://gw/api/v1/meetings/m-l-1', { headers }))
  expect(detailRes.status).toBe(404)

  const assetId = 'rec-l-1:file-l-1:video:0'
  const dlRes = await app(
    new Request(`https://gw/api/v1/assets/${assetId}/download-url`, { method: 'POST', headers }),
  )
  expect(dlRes.status).toBe(403)

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT decision, matched_rule, detail FROM audit_log WHERE asset_id = ?',
    [assetId],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]!.decision).toBe('deny')
  // matched_rule 仍是那条放行的规则：事后看得出「规则放行了、是授权没给」，
  // 这两句话去的是两个不同的页面（自动规则页 / 采集授权页）
  expect(rows[0]!.matched_rule).not.toBeNull()
  expect(String(rows[0]!.detail)).toContain('授权')
  expect(String(rows[0]!.detail)).toContain('prog-lena-1')
})

test('补上授权行之后，同一场会议立刻列得出来、下载地址也签得出来', async () => {
  const lena: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-lena-1', programId: 'prog-lena-1',
  }
  const meeting = rawMeeting({
    meeting_record_id: 'rec-l-2', meeting_id: 'm-l-2', meeting_code: '892', host_user_id: 'tm-lena-1',
  })
  const addressFile = {
    record_file_id: 'file-l-2', download_address: 'https://cos/lena2.mp4', download_address_file_type: 'mp4',
  }

  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: (path) => {
      const meetingsRes = recordsFor(path, [meeting])
      if (meetingsRes) return meetingsRes
      if (path === '/v1/addresses') return addressesPage([addressFile])
      return {}
    },
  })
  // 与上一条用例逐字相同的规则（不靠它跑在前面：用例之间不该有执行顺序上的依赖）。
  // 这次多出来的只有授权行——两条用例之间**唯一**的差别就是它
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-lena-1', assetTypes: ['*'], effect: 'allow',
  })
  await insertGrant(pool, { meetingId: 'm-l-2', programId: 'prog-lena-1' })

  const headers = bearer(lena)

  const listRes = await app(new Request('https://gw/api/v1/meetings', { headers }))
  expect(listRes.status).toBe(200)
  const body = (await listRes.json()) as { meetings: Array<{ meeting_id: string }> }
  expect(body.meetings.map((m) => m.meeting_id)).toEqual(['m-l-2'])

  const detailRes = await app(new Request('https://gw/api/v1/meetings/m-l-2', { headers }))
  expect(detailRes.status).toBe(200)

  const dlRes = await app(
    new Request('https://gw/api/v1/assets/rec-l-2:file-l-2:video:0/download-url', {
      method: 'POST', headers,
    }),
  )
  expect(dlRes.status).toBe(200)
  expect(((await dlRes.json()) as { url: string }).url).toBe('https://cos/lena2.mp4')
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
