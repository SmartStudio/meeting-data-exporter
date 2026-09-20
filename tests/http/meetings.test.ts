import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import {
  buildTestApp,
  insertGrant,
  insertPolicyRule,
  insertServiceProgram,
  seedCompletedAsset,
  seedMeeting,
  writeArchiveFile,
  JWT_SECRET,
} from './testApp'
import { signAccessToken, signDownloadToken } from '../../src/auth/tokens'
import { createArchivesStore } from '../../src/store/archives'
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
    'prog-henry-1',
    'prog-judy-1',
    'prog-kate-1',
    'prog-lena-1',
    'prog-mike-1',
    'prog-noaccess-1',
] as const

let archiveRoot: string
let nasRoot: string

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
  for (const id of TEST_PROGRAM_IDS) await insertServiceProgram(pool, { id })
  archiveRoot = mkdtempSync(join(tmpdir(), 'mde-archive-'))
  nasRoot = mkdtempSync(join(tmpdir(), 'mde-nas-'))
})
afterAll(async () => {
  await cleanup()
  rmSync(archiveRoot, { recursive: true, force: true })
  rmSync(nasRoot, { recursive: true, force: true })
})

const NOW = 1_700_000_000

function bearer(identity: ActorIdentity, now = NOW): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken(identity, JWT_SECRET, now)}` }
}

function program(n: string): ActorIdentity {
  return { kind: 'service_account', wecomUserId: null, tmUserId: `tm-${n}`, programId: `prog-${n}` }
}

function downloadUrlReq(assetId: string, headers: Record<string, string>): Request {
  return new Request(`https://gw/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, {
    method: 'POST',
    headers,
  })
}

test('列表按策略过滤，被拒的会议不出现', async () => {
  const alice = program('alice-1')
  await seedMeeting(pool, { meetingRecordId: 'rec-a-1', meetingId: 'm-a-1', meetingCode: '881', hostUserId: 'tm-alice-1' })
  await seedMeeting(pool, { meetingRecordId: 'rec-b-1', meetingId: 'm-b-1', meetingCode: '882', hostUserId: 'tm-bob-1' })

  const { app } = buildTestApp(pool, { now: () => NOW })
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-alice-1',
    conds: [{ f: 'host', op: 'is', v: 'tm-alice-1' }], assetTypes: ['*'], effect: 'allow',
  })
  // 两场都授权，这条用例问的才是「规则把 B 过滤掉了」——只授权 A 的话，
  // B 不出现在列表里也可能只是因为它没授权，规则那一半就再也没被验证过
  await insertGrant(pool, { meetingId: 'm-a-1', subMeetingId: 'rec-a-1', programId: 'prog-alice-1' })
  await insertGrant(pool, { meetingId: 'm-b-1', subMeetingId: 'rec-b-1', programId: 'prog-alice-1' })

  const res = await app(new Request('https://gw/api/v1/meetings', { headers: bearer(alice) }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { meetings: Array<{ meeting_id: string }> }
  expect(body.meetings.map((m) => m.meeting_id)).toEqual(['m-a-1'])
})

test('单场详情对无可见权限的会议返回 404，且不泄露会议属性（不是无条件全量返回）', async () => {
  const noAccess = program('noaccess-1')
  await seedMeeting(pool, {
    meetingRecordId: 'rec-secret-1', meetingId: 'm-secret-1', meetingCode: '999', hostUserId: 'tm-owner-1',
    subject: '并购谈判纪要',
  })

  const { app } = buildTestApp(pool, { now: () => NOW })
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

  // 资产清单端点同一口径：此前对被拒的会议回 200 加空列表，而不存在的 id 回 404，
  // 两者一对照就能推断出「这场会议存在但我没权限」
  const assetsRes = await app(
    new Request('https://gw/api/v1/meetings/m-secret-1/assets', { headers: bearer(noAccess) }),
  )
  expect(assetsRes.status).toBe(404)
  const assetsBody = (await assetsRes.json()) as Record<string, unknown>
  expect(assetsBody.error).toBe('meeting_not_found_in_range')
  expect(assetsBody.assets).toBeUndefined()
  const missingRes = await app(
    new Request('https://gw/api/v1/meetings/m-does-not-exist/assets', { headers: bearer(noAccess) }),
  )
  expect(missingRes.status).toBe(404)
  expect(((await missingRes.json()) as Record<string, unknown>).error).toBe('meeting_not_found_in_range')
})

test('download-url 对无权资产返回 403 且写审计', async () => {
  const carol = program('carol-1')
  await seedMeeting(pool, { meetingRecordId: 'rec-carol-1', meetingId: 'm-carol-1', meetingCode: '883', hostUserId: 'tm-carol-1' })
  const assetId = await seedCompletedAsset(pool, {
    meetingId: 'm-carol-1', subMeetingId: 'rec-carol-1', assetType: 'video', remoteId: 'file-carol-1',
    targetPath: 'carol/video.mp4',
  })

  const { app } = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot })
  // 有意不插入任何策略规则：默认 deny

  const headers = bearer(carol)

  // 列资产同样过滤：被拒的会议与不存在的会议同一个 404，不给出「存在但无权」的信号
  const listRes = await app(new Request('https://gw/api/v1/meetings/m-carol-1/assets', { headers }))
  expect(listRes.status).toBe(404)

  const dlRes = await app(downloadUrlReq(assetId, headers))
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
  const alice = program('alice-2')
  await seedMeeting(pool, { meetingRecordId: 'rec-a-2', meetingId: 'm-a-2', meetingCode: '884', hostUserId: 'tm-alice-2' })
  await seedMeeting(pool, { meetingRecordId: 'rec-b-2', meetingId: 'm-b-2', meetingCode: '885', hostUserId: 'tm-bob-2' })

  const { app } = buildTestApp(pool, { now: () => NOW })
  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-alice-2',
    conds: [{ f: 'host', op: 'is', v: 'tm-alice-2' }], assetTypes: ['*'], effect: 'allow',
  })
  // 同上：两场都授权，这条 403 才确实是「规则不放行别人主持的会议」，
  // 而不是「m-b-2 恰好没授权」
  await insertGrant(pool, { meetingId: 'm-a-2', subMeetingId: 'rec-a-2', programId: 'prog-alice-2' })
  await insertGrant(pool, { meetingId: 'm-b-2', subMeetingId: 'rec-b-2', programId: 'prog-alice-2' })

  // alice 构造出她从未被授权查看的 meetingB 下某资产的 assetId
  const res = await app(downloadUrlReq('rec-b-2:file-b-2:video:0', bearer(alice)))
  expect(res.status).toBe(403)
  expect((await res.json()).error).toBe('forbidden')
})

test('download-url 对从未入库的 meetingRecordId 同样返回 403 而非 404', async () => {
  const henry = program('henry-1')
  const { app } = buildTestApp(pool, { now: () => NOW })

  const res = await app(downloadUrlReq('never-cached-rec:file-x:video:0', bearer(henry)))
  expect(res.status).toBe(403)
  expect((await res.json()).error).toBe('forbidden')
})

test('download-url 写入 audit_log.meeting_id 在缓存命中/未命中两条路径下语义一致（均为 meetingRecordId 维度）', async () => {
  const kate = program('kate-1')
  await seedMeeting(pool, { meetingRecordId: 'rec-kate-1', meetingId: 'm-kate-1', meetingCode: '890', hostUserId: 'tm-kate-1' })
  const hitAssetId = await seedCompletedAsset(pool, {
    meetingId: 'm-kate-1', subMeetingId: 'rec-kate-1', assetType: 'video', remoteId: 'file-kate-1',
    targetPath: 'kate/video.mp4',
  })

  const { app } = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot })
  await insertPolicyRule(pool, { priority: 10, programId: 'prog-kate-1', assetTypes: ['*'], effect: 'allow' })
  await insertGrant(pool, { meetingId: 'm-kate-1', subMeetingId: 'rec-kate-1', programId: 'prog-kate-1' })

  const headers = bearer(kate)

  // 缓存未命中分支：meetingRecordId 从未入库，网关根本拿不到真正的
  // Tencent meeting_id，只有 record_id 可用。
  const missAssetId = 'rec-never-listed-kate:file-x:video:0'
  const missRes = await app(downloadUrlReq(missAssetId, headers))
  expect(missRes.status).toBe(403) // 未命中一律 deny（见 downloadUrl 注释）

  const hitRes = await app(downloadUrlReq(hitAssetId, headers))
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

test('未传 from/to 时默认最近 31 天：窗口内的列出来，早一秒的不列', async () => {
  const dave = program('dave-1')
  const edge = NOW - 31 * 86400
  await seedMeeting(pool, {
    meetingRecordId: 'rec-dave-in', meetingId: 'm-dave-in', meetingCode: '870', hostUserId: 'tm-dave-1', startTime: edge,
  })
  await seedMeeting(pool, {
    meetingRecordId: 'rec-dave-out', meetingId: 'm-dave-out', meetingCode: '871', hostUserId: 'tm-dave-1', startTime: edge - 1,
  })
  const { app } = buildTestApp(pool, { now: () => NOW })
  await insertPolicyRule(pool, { priority: 10, programId: 'prog-dave-1', assetTypes: ['*'], effect: 'allow' })
  await insertGrant(pool, { meetingId: 'm-dave-in', subMeetingId: 'rec-dave-in', programId: 'prog-dave-1' })
  await insertGrant(pool, { meetingId: 'm-dave-out', subMeetingId: 'rec-dave-out', programId: 'prog-dave-1' })

  const res = await app(new Request('https://gw/api/v1/meetings', { headers: bearer(dave) }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { meetings: Array<{ meeting_id: string }> }
  expect(body.meetings.map((m) => m.meeting_id)).toEqual(['m-dave-in'])
})

test('meeting_code 命中多场时返回数组而非单个对象', async () => {
  const erin = program('erin-1')
  await seedMeeting(pool, { meetingRecordId: 'rec-e-1', meetingId: 'm-e-1', meetingCode: '886', hostUserId: 'tm-erin-1' })
  await seedMeeting(pool, { meetingRecordId: 'rec-e-2', meetingId: 'm-e-2', meetingCode: '886', hostUserId: 'tm-erin-1' })

  const { app } = buildTestApp(pool, { now: () => NOW })
  await insertPolicyRule(pool, { priority: 10, programId: 'prog-erin-1', assetTypes: ['*'], effect: 'allow' })
  await insertGrant(pool, { meetingId: 'm-e-1', subMeetingId: 'rec-e-1', programId: 'prog-erin-1' })
  await insertGrant(pool, { meetingId: 'm-e-2', subMeetingId: 'rec-e-2', programId: 'prog-erin-1' })

  const res = await app(
    new Request('https://gw/api/v1/meetings?meeting_code=886', { headers: bearer(erin) }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { meetings: Array<{ meeting_code: string }> }
  expect(body.meetings).toHaveLength(2)
  expect(body.meetings.every((m) => m.meeting_code === '886')).toBe(true)
})

test('范围外未命中返回 404 且 error 为 meeting_not_found_in_range，提示里说明要靠调度器补跑（单场详情端点）', async () => {
  const frank = program('frank-1')
  const { app } = buildTestApp(pool, { now: () => NOW })

  const res = await app(
    new Request('https://gw/api/v1/meetings/m-does-not-exist', { headers: bearer(frank) }),
  )
  expect(res.status).toBe(404)
  const body = (await res.json()) as { error: string; message: string }
  expect(body.error).toBe('meeting_not_found_in_range')
  expect(body.message).toContain('scheduler')
})

test('范围外未命中返回 404（列表端点携带 meeting_id 过滤时同样适用）', async () => {
  const frank2 = program('frank-2')
  const { app } = buildTestApp(pool, { now: () => NOW })

  const res = await app(
    new Request('https://gw/api/v1/meetings?meeting_id=m-does-not-exist', { headers: bearer(frank2) }),
  )
  expect(res.status).toBe(404)
  expect((await res.json()).error).toBe('meeting_not_found_in_range')
})

test('malformed assetId 返回 400 invalid_asset_id', async () => {
  const judy = program('judy-1')
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
  const lena = program('lena-1')
  await seedMeeting(pool, { meetingRecordId: 'rec-l-1', meetingId: 'm-l-1', meetingCode: '891', hostUserId: 'tm-lena-1' })
  const assetId = await seedCompletedAsset(pool, {
    meetingId: 'm-l-1', subMeetingId: 'rec-l-1', assetType: 'video', remoteId: 'file-l-1', targetPath: 'lena/1.mp4',
  })

  const { app } = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot })
  // 规则放行全部八类，但一条授权行都没有
  await insertPolicyRule(pool, { priority: 10, programId: 'prog-lena-1', assetTypes: ['*'], effect: 'allow' })

  const headers = bearer(lena)

  const listRes = await app(new Request('https://gw/api/v1/meetings', { headers }))
  expect(listRes.status).toBe(200)
  expect(((await listRes.json()) as { meetings: unknown[] }).meetings).toEqual([])

  // 详情走的是 decide 而不是 decideMany——两条路径判得一样，列表里没有的这里也进不去
  const detailRes = await app(new Request('https://gw/api/v1/meetings/m-l-1', { headers }))
  expect(detailRes.status).toBe(404)

  const dlRes = await app(downloadUrlReq(assetId, headers))
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

test('补上授权行之后，同一场会议列得出来、清单来自 meeting_assets、下载地址指回网关并能取到字节', async () => {
  const lena = program('lena-1')
  await seedMeeting(pool, { meetingRecordId: 'rec-l-2', meetingId: 'm-l-2', meetingCode: '892', hostUserId: 'tm-lena-1' })
  const assetId = await seedCompletedAsset(pool, {
    meetingId: 'm-l-2', subMeetingId: 'rec-l-2', assetType: 'video', remoteId: 'file-l-2',
    targetPath: 'lena/2.mp4', bytesExpected: 26,
  })
  // 一条 completed 但没有 asset_id 的旧行：网关签不出它的地址，清单里不该有它
  await pool.execute(
    `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, created_at, updated_at)
     VALUES ('m-l-2', 'rec-l-2', 'audio', 'file-l-2', 'm4a', 'completed', 'lena/2.m4a', 0, 0)`,
  )
  // 还没下完的资产也不在清单里：发出去是半个文件
  await pool.execute(
    `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, asset_id, file_type, status, created_at, updated_at)
     VALUES ('m-l-2', 'rec-l-2', 'ai_minutes', 'file-l-2', 'rec-l-2:file-l-2:ai_minutes:0', 'md', 'pending', 0, 0)`,
  )
  writeArchiveFile(archiveRoot, 'lena/2.mp4', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')

  const { app } = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot })
  // 与上一条用例逐字相同的规则（不靠它跑在前面：用例之间不该有执行顺序上的依赖）。
  // 这次多出来的只有授权行——两条用例之间**唯一**的差别就是它
  await insertPolicyRule(pool, { priority: 10, programId: 'prog-lena-1', assetTypes: ['*'], effect: 'allow' })
  await insertGrant(pool, { meetingId: 'm-l-2', subMeetingId: 'rec-l-2', programId: 'prog-lena-1' })

  const headers = bearer(lena)

  const listRes = await app(new Request('https://gw/api/v1/meetings', { headers }))
  expect(listRes.status).toBe(200)
  const body = (await listRes.json()) as { meetings: Array<{ meeting_id: string }> }
  expect(body.meetings.map((m) => m.meeting_id)).toEqual(['m-l-2'])

  const detailRes = await app(new Request('https://gw/api/v1/meetings/m-l-2', { headers }))
  expect(detailRes.status).toBe(200)
  const detail = (await detailRes.json()) as { assets: Array<Record<string, unknown>> }
  expect(detail.assets).toEqual([
    {
      asset_id: assetId,
      meeting_id: 'm-l-2',
      sub_meeting_id: 'rec-l-2',
      asset_type: 'video',
      remote_id: 'file-l-2',
      file_type: 'mp4',
      bytes_expected: 26,
      allow_download: true,
    },
  ])

  const dlRes = await app(downloadUrlReq(assetId, headers))
  expect(dlRes.status).toBe(200)
  const dl = (await dlRes.json()) as { url: string; expires_at: number }
  expect(dl.url.startsWith(`https://gw.example/api/v1/assets/${encodeURIComponent(assetId)}/content?token=`)).toBe(true)
  expect(dl.expires_at).toBe(NOW + 900)

  // 引擎下载器就是这么用这条 URL 的：不带 Bearer，直接 fetch
  const full = await app(new Request(dl.url))
  expect(full.status).toBe(200)
  expect(full.headers.get('accept-ranges')).toBe('bytes')
  expect(full.headers.get('content-length')).toBe('26')
  expect(await full.text()).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ')

  // 断点续传：206 + Content-Range，只发后半段
  const resumed = await app(new Request(dl.url, { headers: { range: 'bytes=10-' } }))
  expect(resumed.status).toBe(206)
  expect(resumed.headers.get('content-range')).toBe('bytes 10-25/26')
  expect(resumed.headers.get('content-length')).toBe('16')
  expect(await resumed.text()).toBe('KLMNOPQRSTUVWXYZ')

  // 起点越界：416，让下载器丢掉 .part 重来
  const beyond = await app(new Request(dl.url, { headers: { range: 'bytes=26-' } }))
  expect(beyond.status).toBe(416)
  expect(beyond.headers.get('content-range')).toBe('bytes */26')
})

// ── GET /api/v1/assets/:assetId/content 的凭证与路径边界 ───────────────────

function contentUrl(assetId: string, token: string): string {
  return `https://gw/api/v1/assets/${encodeURIComponent(assetId)}/content?token=${token}`
}

test('content 端点：没有令牌、签名不对、过期、令牌指向别的资产，一律 403 且一个字节都不发', async () => {
  await seedMeeting(pool, { meetingRecordId: 'rec-m-1', meetingId: 'm-m-1', meetingCode: '893', hostUserId: 'tm-mike-1' })
  const assetId = await seedCompletedAsset(pool, {
    meetingId: 'm-m-1', subMeetingId: 'rec-m-1', assetType: 'video', remoteId: 'file-m-1', targetPath: 'mike/1.mp4',
  })
  const otherAssetId = await seedCompletedAsset(pool, {
    meetingId: 'm-m-1', subMeetingId: 'rec-m-1', assetType: 'audio', remoteId: 'file-m-1', fileType: 'm4a', targetPath: 'mike/1.m4a',
  })
  writeArchiveFile(archiveRoot, 'mike/1.mp4', 'video-bytes')
  writeArchiveFile(archiveRoot, 'mike/1.m4a', 'audio-bytes')

  const { app } = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot })
  const good = signDownloadToken(assetId, JWT_SECRET, NOW)

  // 对照：这张令牌本身是好的
  expect((await app(new Request(contentUrl(assetId, good)))).status).toBe(200)

  const cases: Array<[string, string]> = [
    ['没有令牌', `https://gw/api/v1/assets/${encodeURIComponent(assetId)}/content`],
    ['签名被改', contentUrl(assetId, good.slice(0, -2) + 'xx')],
    ['别的密钥签的', contentUrl(assetId, signDownloadToken(assetId, 'another-secret-that-is-long-enough', NOW))],
    ['过期', contentUrl(assetId, signDownloadToken(assetId, JWT_SECRET, NOW - 900))],
    ['令牌是给另一份资产的', contentUrl(assetId, signDownloadToken(otherAssetId, JWT_SECRET, NOW))],
  ]
  for (const [label, url] of cases) {
    const res = await app(new Request(url))
    expect(res.status, label).toBe(403)
    expect(((await res.json()) as { error: string }).error, label).toBe('forbidden')
  }
})

test('content 端点：没配 MDE_ARCHIVE_ROOT 回 503；令牌合法但库里没有这份 completed 资产回 404', async () => {
  const assetId = 'rec-nowhere:file-x:video:0'
  const token = signDownloadToken(assetId, JWT_SECRET, NOW)

  const unconfigured = buildTestApp(pool, { now: () => NOW })
  const res503 = await unconfigured.app(new Request(contentUrl(assetId, token)))
  expect(res503.status).toBe(503)
  expect(((await res503.json()) as { error: string }).error).toBe('archive_root_unconfigured')

  const configured = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot })
  const res404 = await configured.app(new Request(contentUrl(assetId, token)))
  expect(res404.status).toBe(404)
  expect(((await res404.json()) as { error: string }).error).toBe('asset_not_found')
})

test('content 端点：记录里的路径解析到根目录之外（../ 或前缀相似的兄弟目录）回 404，不读那个文件', async () => {
  // 根目录旁边放一个同前缀的兄弟目录：纯 startsWith 会把它放进来
  const evilSibling = `${archiveRoot}-evil`
  writeArchiveFile(evilSibling, 'leak.txt', 'must-not-be-served')
  writeArchiveFile(archiveRoot, 'outside-marker.txt', 'in-root')
  try {
    const dotdot = await seedCompletedAsset(pool, {
      meetingId: 'm-m-2', subMeetingId: 'rec-m-2', assetType: 'video', remoteId: 'file-dotdot',
      targetPath: `../${archiveRoot.split('/').pop()}-evil/leak.txt`,
    })
    const sibling = await seedCompletedAsset(pool, {
      meetingId: 'm-m-2', subMeetingId: 'rec-m-2', assetType: 'audio', remoteId: 'file-sibling',
      targetPath: `${evilSibling}/leak.txt`,
    })
    const { app } = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot })

    for (const assetId of [dotdot, sibling]) {
      const res = await app(new Request(contentUrl(assetId, signDownloadToken(assetId, JWT_SECRET, NOW))))
      expect(res.status, assetId).toBe(404)
      expect(((await res.json()) as { error: string }).error, assetId).toBe('asset_not_found')
    }
  } finally {
    rmSync(evilSibling, { recursive: true, force: true })
  }
})

test('content 端点：本地副本被清掉后回退到 NAS 上归档的那一份；两处都没有回 404', async () => {
  await seedMeeting(pool, { meetingRecordId: 'rec-m-3', meetingId: 'm-m-3', meetingCode: '894', hostUserId: 'tm-mike-1' })
  const assetId = await seedCompletedAsset(pool, {
    meetingId: 'm-m-3', subMeetingId: 'rec-m-3', assetType: 'video', remoteId: 'file-m-3', targetPath: 'mike/3.mp4',
  })
  await createArchivesStore(pool).recordArchivedAsset({
    meetingId: 'm-m-3', subMeetingId: 'rec-m-3', assetType: 'video', remoteId: 'file-m-3', fileType: 'mp4',
    localPath: 'mike/3.mp4', nasPath: 'archived/m-m-3/3.mp4', nasHash: 'deadbeef', archivedAt: NOW,
  })
  const token = signDownloadToken(assetId, JWT_SECRET, NOW)

  // 本地那份从未存在（被保留策略清掉了），NAS 那份在
  writeArchiveFile(nasRoot, 'archived/m-m-3/3.mp4', 'from-nas')
  const withNas = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot, nasRoot })
  const res = await withNas.app(new Request(contentUrl(assetId, token), { headers: { range: 'bytes=5-' } }))
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe('bytes 5-7/8')
  expect(await res.text()).toBe('nas')

  // 没挂 NAS 的进程回 404：它确实发不出这份文件
  const withoutNas = buildTestApp(pool, { now: () => NOW, localArchiveRoot: archiveRoot })
  const miss = await withoutNas.app(new Request(contentUrl(assetId, token)))
  expect(miss.status).toBe(404)
  expect(((await miss.json()) as { error: string }).error).toBe('asset_not_found')
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

test('单场详情与资产清单可按 sub_meeting_id 点名要某一场，未命中 404', async () => {
  const judy = program('judy-1')
  // 同一个 meeting_id 的两条录制记录 = 周期会议的两场
  await seedMeeting(pool, {
    meetingRecordId: 'rec-j-1', meetingId: 'm-j-1', meetingCode: '893', hostUserId: 'tm-judy-1', subject: '第一场',
  })
  await seedMeeting(pool, {
    meetingRecordId: 'rec-j-2', meetingId: 'm-j-1', meetingCode: '893', hostUserId: 'tm-judy-1', subject: '第二场',
    startTime: NOW + 3600, // 更晚的一场：不带参数时它胜出
  })

  const { app } = buildTestApp(pool, { now: () => NOW + 7200 })
  await insertPolicyRule(pool, { priority: 10, programId: 'prog-judy-1', assetTypes: ['*'], effect: 'allow' })
  await insertGrant(pool, { meetingId: 'm-j-1', subMeetingId: 'rec-j-1', programId: 'prog-judy-1' })
  await insertGrant(pool, { meetingId: 'm-j-1', subMeetingId: 'rec-j-2', programId: 'prog-judy-1' })
  const headers = bearer(judy, NOW + 7200)

  // ① 不给 sub_meeting_id：保持旧口径，取 startTime 最新的一条
  const latest = await app(new Request('https://gw/api/v1/meetings/m-j-1', { headers }))
  expect(latest.status).toBe(200)
  expect(((await latest.json()) as { subject: string }).subject).toBe('第二场')

  // ② 给了就取那一条
  const pinned = await app(
    new Request('https://gw/api/v1/meetings/m-j-1?sub_meeting_id=rec-j-1', { headers }),
  )
  expect(pinned.status).toBe(200)
  const pinnedBody = (await pinned.json()) as { subject: string; sub_meeting_id: string }
  expect(pinnedBody.subject).toBe('第一场')
  expect(pinnedBody.sub_meeting_id).toBe('rec-j-1')

  // ③ 没命中：404，与「范围外未命中」同一个形状
  const miss = await app(
    new Request('https://gw/api/v1/meetings/m-j-1?sub_meeting_id=rec-nope', { headers }),
  )
  expect(miss.status).toBe(404)
  expect(((await miss.json()) as { error: string }).error).toBe('meeting_not_found_in_range')

  // ④ 资产端点同样认这个参数
  const assets = await app(
    new Request('https://gw/api/v1/meetings/m-j-1/assets?sub_meeting_id=rec-nope', { headers }),
  )
  expect(assets.status).toBe(404)
})
