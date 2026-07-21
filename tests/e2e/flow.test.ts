/**
 * 端到端测试（design doc §5.10）："端到端：假腾讯 API + 真网关"。
 *
 * 与 tests/http/*.test.ts（Task 14）的关键区别：那里用 tests/http/testApp.ts
 * 的 stubTencentClient 在内存里直接返回 fixture，TencentClient 这一层本身
 * 完全没有被跑到——签名的构造/校验逻辑因此从未在集成层面被真正验证过。
 *
 * 这里改用真实的 createTencentClient，指向本文件启动的假腾讯服务
 * （tests/fake-tencent/server.ts），后者会用 src/tencent/signer.ts 的同一套
 * 算法重新计算签名，不匹配则拒绝。除此之外全部走真实实现：真实 HTTP 路由
 * （src/http/router.ts）、真实 store、真实 MySQL（withTestDb）、真实策略引擎、
 * 真实审计、真实 STS-Token 生命周期。唯一的桩是企业微信 exchangeCode
 * （与 Task 14 一致——WeCom 侧本就不在本任务范围内）。
 */
import { afterEach, beforeAll, afterAll, expect, test } from 'bun:test'
import { createHash, createCipheriv, randomBytes } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import type { WecomUser } from '../../src/auth/wecom'
import type { IdentityStrategy } from '../../src/config'
import { withTestDb } from '../helpers/testdb'
import {
  JWT_SECRET,
  WEBHOOK_TOKEN,
  WEBHOOK_AES_KEY,
  OPERATOR_ID,
  stubWecomClient,
  insertPolicyRule,
} from '../http/testApp'
import { createTencentClient } from '../../src/tencent/client'
import { TencentApiError } from '../../src/tencent/errors'
import { createRecordsApi } from '../../src/tencent/records'
import { createAddressesApi } from '../../src/tencent/addresses'
import { createCatalog } from '../../src/catalog/index'
import { createStsStore } from '../../src/store/sts'
import { createStsManager } from '../../src/sts/manager'
import { verifySignature, decryptEvent } from '../../src/sts/crypto'
import { createPolicyStore } from '../../src/store/policy'
import { createPolicyEngine } from '../../src/policy/engine'
import { createAuditStore } from '../../src/store/audit'
import { createAuditRecorder } from '../../src/audit/recorder'
import { createAuthStore } from '../../src/store/auth'
import { createDeviceFlow } from '../../src/auth/device'
import { createIdentityMapper } from '../../src/auth/identity'
import { createServiceAuth } from '../../src/auth/service'
import { createMeetingCacheStore } from '../../src/store/meetings'
import { createApp, type AppDeps } from '../../src/http/router'
import { createLoginRateLimiter } from '../../src/http/ratelimit'
import {
  startFakeTencentServer,
  createFakeTencentState,
  type FakeTencentState,
  type FakeTencentRequestLogEntry,
} from '../fake-tencent/server'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

const NOW = 1_700_000_000

/** 假腾讯服务用的固定测试凭证——只需要与传给 createTencentClient 的配置一致 */
const TENCENT_SECRET_ID = 'AKIDe2eFakeSecretId'
const TENCENT_SECRET_KEY = 'e2e-fake-secret-key-not-a-real-one'

/** 每个测试各自持有一个假服务实例；afterEach 统一关闭，避免端口泄漏到下一个测试 */
const runningServers: Array<() => void> = []
afterEach(() => {
  while (runningServers.length > 0) runningServers.pop()!()
})

function stepClock(start: number): { now: () => number; advance: (sec: number) => void } {
  let t = start
  return { now: () => t, advance: (sec: number) => { t += sec } }
}

interface E2eAppOptions {
  now?: () => number
  wecomExchangeCode?: (code: string) => Promise<WecomUser>
  identityStrategy?: IdentityStrategy
}

interface E2eApp {
  app: (req: Request) => Promise<Response>
  deps: AppDeps
  fakeState: FakeTencentState
  requestLog: FakeTencentRequestLogEntry[]
}

/**
 * 装配一个"真网关 + 假腾讯 HTTP 服务"的实例：与 src/index.ts 使用完全相同的
 * 装配方式（同一套 create* 工厂函数），唯一区别是 TencentClient 指向本地假
 * 服务而不是 api.meeting.qq.com，且 wecomClient 用 stub（企微不在本任务范围）。
 */
function buildE2eApp(dbPool: Pool, opts: E2eAppOptions = {}): E2eApp {
  const now = opts.now ?? (() => NOW)

  const fakeState = createFakeTencentState()
  const fakeServer = startFakeTencentServer(
    { secretId: TENCENT_SECRET_ID, secretKey: TENCENT_SECRET_KEY },
    fakeState,
  )
  runningServers.push(fakeServer.stop)

  const tencentClient = createTencentClient(
    {
      appId: 'app-e2e',
      sdkId: 'sdk-e2e',
      secretId: TENCENT_SECRET_ID,
      secretKey: TENCENT_SECRET_KEY,
      operatorId: OPERATOR_ID,
      qps: 50,
      baseUrl: fakeServer.url,
    },
    { fetch, sleep: () => Promise.resolve(), now },
  )

  const recordsApi = createRecordsApi(tencentClient, OPERATOR_ID)
  const addressesApi = createAddressesApi(tencentClient, OPERATOR_ID)

  const stsStore = createStsStore(dbPool)
  const stsManager = createStsManager({
    store: stsStore,
    client: tencentClient,
    operatorId: OPERATOR_ID,
    webhookToken: WEBHOOK_TOKEN,
    aesKey: WEBHOOK_AES_KEY,
    encrypt: (s) => `enc(${s})`,
    decrypt: (s) => s.replace(/^enc\(/, '').replace(/\)$/, ''),
    verify: verifySignature,
    decryptEvent,
  })

  const catalog = createCatalog({ addressesApi, stsManager, now })

  const policyStore = createPolicyStore(dbPool)
  const policyEngine = createPolicyEngine(policyStore)

  const auditStore = createAuditStore(dbPool)
  const auditRecorder = createAuditRecorder(auditStore, now)

  const authStore = createAuthStore(dbPool)
  const deviceFlow = createDeviceFlow({ store: authStore, baseUrl: 'https://gw.e2e.example', ttlSec: 300 })
  const wecomClient = stubWecomClient(
    opts.wecomExchangeCode ?? (async () => ({ userId: 'ww-e2e-default', email: null })),
  )
  const identityMapper = createIdentityMapper(opts.identityStrategy ?? 'direct', {
    lookupTable: async (id) => (await authStore.lookupIdentityMap(id))?.tmUserId ?? null,
    lookupByEmail: async (email) => (await authStore.lookupIdentityByEmail(email))?.tmUserId ?? null,
  })
  const serviceAuth = createServiceAuth({ store: authStore })
  const meetingsCache = createMeetingCacheStore(dbPool)

  const deps: AppDeps = {
    now,
    jwtSecret: JWT_SECRET,
    gatewayBaseUrl: 'https://gw.e2e.example',
    recordsApi,
    catalog,
    policyEngine,
    auditRecorder,
    deviceFlow,
    wecomClient,
    identityMapper,
    serviceAuth,
    authStore,
    stsManager,
    meetingsCache,
    // e2e 测试重点不在限流本身（那是 tests/http/ratelimit.test.ts 的职责），
    // 这里只需满足 AppDeps 契约，给每个 app 实例一个独立桶。
    loginRateLimiter: createLoginRateLimiter(),
    trustedProxyHops: 1,
  }

  return { app: createApp(deps), deps, fakeState, requestLog: fakeServer.requestLog }
}

async function lookupDeviceState(deviceCode: string): Promise<string> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT state FROM device_authorizations WHERE device_code = ?',
    [deviceCode],
  )
  return rows[0]!.state as string
}

function deviceTokenRequest(deviceCode: string): Request {
  return new Request('https://gw/api/v1/auth/device/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  })
}

/** 走完设备授权流程的通用部分：发码 → 企微回调 → 轮询取得令牌。用于登录本身不是被测重点的用例。 */
async function deviceLogin(
  app: (req: Request) => Promise<Response>,
  clock: { now: () => number; advance: (sec: number) => void },
): Promise<{ access_token: string; refresh_token: string }> {
  const codeRes = await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  const codeBody = (await codeRes.json()) as { device_code: string }

  const state = await lookupDeviceState(codeBody.device_code)
  const cbRes = await app(new Request(`https://gw/auth/wecom/callback?code=e2e-code&state=${state}`))
  if (cbRes.status !== 200) {
    throw new Error(`e2e device login callback failed: ${cbRes.status} ${await cbRes.text()}`)
  }

  clock.advance(10) // 越过 poll interval（5s），避免 slow_down
  const tokenRes = await app(deviceTokenRequest(codeBody.device_code))
  if (tokenRes.status !== 200) {
    throw new Error(`e2e device token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`)
  }
  return (await tokenRes.json()) as { access_token: string; refresh_token: string }
}

/** 复刻 src/sts/crypto.ts 的加解密/签名算法（同 tests/http/webhook.test.ts 的做法），构造真实可通过验签的 webhook 回调 */
function makeWebhookSignature(token: string, ts: string, nonce: string, data: string): string {
  return createHash('sha1').update([token, ts, nonce, data].sort().join('')).digest('hex')
}

function encryptStsEvent(aesKey: string, reqId: string, stsToken: string, expireTs: number): string {
  const json = JSON.stringify({
    event: 'common.sts-token',
    trace_id: 'trace-e2e',
    payload: [
      {
        operate_time: NOW * 1000,
        operator: { userid: OPERATOR_ID, user_name: 'operator' },
        token_info: { req_id: reqId, sts_token: stsToken, expire_ts: expireTs },
      },
    ],
  })
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const msg = Buffer.from(json, 'utf8')
  const msgLen = Buffer.alloc(4)
  msgLen.writeUInt32BE(msg.length, 0)
  const plain = Buffer.concat([randomBytes(16), msgLen, msg, Buffer.from('tail-corpid', 'utf8')])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

function webhookRequest(encrypted: string, now: number): Request {
  const timestamp = String(now)
  const nonce = 'nonce-e2e'
  const url = new URL('https://gw/webhook/tencent-meeting')
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('signature', makeWebhookSignature(WEBHOOK_TOKEN, timestamp, nonce, encrypted))
  return new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypt: encrypted }),
  })
}

test('完整流程：设备登录 → 列会议 → 取资产 → 换下载地址', async () => {
  const clock = stepClock(NOW)
  const meetingRecordId = 'rec-e2e-full-1'
  const meetingId = 'm-e2e-full-1'
  const fileId = 'file-e2e-full-1'
  const reqId = 'req-e2e-full-1'

  const { app, fakeState, deps, requestLog } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-full-1', email: null }),
  })

  fakeState.records.push({
    meeting_record_id: meetingRecordId,
    meeting_id: meetingId,
    meeting_code: '700001',
    host_user_id: 'ww-e2e-full-1', // identity strategy 'direct' ⇒ tmUserId === wecomUserId
    media_start_time: NOW * 1000,
    subject: '端到端全流程验证会议',
    state: 3,
  })
  fakeState.addressesByRecordId.set(meetingRecordId, [
    {
      record_file_id: fileId,
      download_address: 'https://cos.example/full-video.mp4',
      download_address_file_type: 'mp4',
      audio_address: 'https://cos.example/full-audio.m4a',
      audio_address_file_type: 'm4a',
      allow_download: true,
    },
  ])
  fakeState.addressDetailByFileId.set(fileId, {
    record_file_id: fileId,
    ai_minutes: [{ download_address: 'https://cos.example/full-ai-minutes.docx', file_type: 'docx' }],
  })
  fakeState.stsReqId = reqId

  await insertPolicyRule(pool, {
    priority: 10,
    subjectType: 'user',
    subjectValue: 'ww-e2e-full-1',
    resourceExpr: {},
    assetTypes: ['*'],
    effect: 'allow',
  })

  // STS-Token 就位：真实发起 ensureFresh（对假服务的一次真实带签名 HTTP 调用），
  // 再用真实的 webhook 端点投递回调完成续期——不是直接往 DB 里塞一条 fulfilled 记录。
  await deps.stsManager.ensureFresh(clock.now())
  const encrypted = encryptStsEvent(WEBHOOK_AES_KEY, reqId, 'sts-tok-full-1', clock.now() + 3600)
  const webhookRes = await app(webhookRequest(encrypted, clock.now()))
  expect(webhookRes.status).toBe(200)

  // 1. 设备登录
  const codeRes = await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  expect(codeRes.status).toBe(200)
  const codeBody = (await codeRes.json()) as { device_code: string }

  clock.advance(1)
  const pendingRes = await app(deviceTokenRequest(codeBody.device_code))
  expect(pendingRes.status).toBe(400)
  expect((await pendingRes.json()).error).toBe('authorization_pending')

  const state = await lookupDeviceState(codeBody.device_code)
  clock.advance(1)
  const cbRes = await app(new Request(`https://gw/auth/wecom/callback?code=e2e-code&state=${state}`))
  expect(cbRes.status).toBe(200)
  expect(await cbRes.text()).toContain('登录成功')

  clock.advance(10)
  const tokenRes = await app(deviceTokenRequest(codeBody.device_code))
  expect(tokenRes.status).toBe(200)
  const { access_token } = (await tokenRes.json()) as { access_token: string }
  const headers = { Authorization: `Bearer ${access_token}` }

  // 2. 列会议
  const listRes = await app(new Request('https://gw/api/v1/meetings?meeting_code=700001', { headers }))
  expect(listRes.status).toBe(200)
  const listBody = (await listRes.json()) as { meetings: Array<{ meeting_id: string; subject: string }> }
  expect(listBody.meetings.map((m) => m.meeting_id)).toEqual([meetingId])
  expect(listBody.meetings[0]!.subject).toBe('端到端全流程验证会议')

  // 3. 取资产
  const assetsRes = await app(new Request(`https://gw/api/v1/meetings/${meetingId}/assets`, { headers }))
  expect(assetsRes.status).toBe(200)
  const assetsBody = (await assetsRes.json()) as {
    assets: Array<{ asset_id: string; asset_type: string }>
  }
  expect(assetsBody.assets.map((a) => a.asset_type).sort()).toEqual(['ai_minutes', 'audio', 'video'])

  const videoAsset = assetsBody.assets.find((a) => a.asset_type === 'video')!
  const aiAsset = assetsBody.assets.find((a) => a.asset_type === 'ai_minutes')!

  // 4. 换下载地址：video 走批量接口（6 小时时效），ai_minutes 走详情接口（5 分钟时效，需 STS-Token）
  const videoDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(videoAsset.asset_id)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(videoDl.status).toBe(200)
  const videoDlBody = (await videoDl.json()) as { url: string; expires_at: number }
  expect(videoDlBody.url).toBe('https://cos.example/full-video.mp4')
  expect(videoDlBody.expires_at - clock.now()).toBe(6 * 3600)

  const aiDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(aiAsset.asset_id)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(aiDl.status).toBe(200)
  const aiDlBody = (await aiDl.json()) as { url: string; expires_at: number }
  expect(aiDlBody.url).toBe('https://cos.example/full-ai-minutes.docx')
  expect(aiDlBody.expires_at - clock.now()).toBe(5 * 60)

  // 假腾讯服务确实被真实、带正确签名地调用过（不是从未走网络的旁路）
  const hitPaths = new Set(requestLog.filter((r) => r.signatureValid).map((r) => r.path))
  expect(hitPaths.has('/v1/app/sts-token')).toBe(true)
  expect(hitPaths.has('/v1/records')).toBe(true)
  expect(hitPaths.has('/v1/addresses')).toBe(true)
  expect(hitPaths.has(`/v1/addresses/${fileId}`)).toBe(true)
  expect(requestLog.every((r) => r.signatureValid)).toBe(true) // 全程签名均正确、无一次被假服务拒绝

  // 审计留痕：两次下载地址签发都记为 allow
  const [auditRows] = await pool.execute<RowDataPacket[]>(
    "SELECT decision FROM audit_log WHERE action = 'issue_download_url' AND meeting_id = ?",
    [meetingRecordId],
  )
  expect(auditRows).toHaveLength(2)
  expect(auditRows.every((r) => r.decision === 'allow')).toBe(true)
})

test('策略拒绝时整条链路在 download-url 处被拦截', async () => {
  const clock = stepClock(NOW)
  const meetingRecordId = 'rec-e2e-deny-1'
  const meetingId = 'm-e2e-deny-1'
  const fileId = 'file-e2e-deny-1'

  const { app, fakeState } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-deny-1', email: null }),
  })

  fakeState.records.push({
    meeting_record_id: meetingRecordId,
    meeting_id: meetingId,
    meeting_code: '700002',
    host_user_id: 'ww-e2e-deny-1',
    media_start_time: NOW * 1000,
    subject: '仅放行 video 的会议',
    state: 3,
  })
  fakeState.addressesByRecordId.set(meetingRecordId, [
    {
      record_file_id: fileId,
      download_address: 'https://cos.example/deny-video.mp4',
      download_address_file_type: 'mp4',
      audio_address: 'https://cos.example/deny-audio.m4a',
      audio_address_file_type: 'm4a',
      allow_download: true,
    },
  ])

  // 只放行 video；audio（及其余类型）在策略层面被拒——默认 deny
  await insertPolicyRule(pool, {
    priority: 10,
    subjectType: 'user',
    subjectValue: 'ww-e2e-deny-1',
    resourceExpr: {},
    assetTypes: ['video'],
    effect: 'allow',
  })

  const { access_token } = await deviceLogin(app, clock)
  const headers = { Authorization: `Bearer ${access_token}` }

  // 链路前半段（登录、列会议、取资产清单）全部正常返回 200——
  // "拦截"恰好发生在 download-url 这一步，不是提前在前面几步就失败。
  const listRes = await app(new Request('https://gw/api/v1/meetings?meeting_code=700002', { headers }))
  expect(listRes.status).toBe(200)
  expect(((await listRes.json()) as { meetings: unknown[] }).meetings).toHaveLength(1)

  const assetsRes = await app(new Request(`https://gw/api/v1/meetings/${meetingId}/assets`, { headers }))
  expect(assetsRes.status).toBe(200)
  const assetsBody = (await assetsRes.json()) as { assets: Array<{ asset_id: string; asset_type: string }> }
  expect(assetsBody.assets.map((a) => a.asset_type)).toEqual(['video']) // audio 已被清单过滤
  const videoAssetId = assetsBody.assets[0]!.asset_id

  // video：策略允许，download-url 正常放行
  const videoDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(videoAssetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(videoDl.status).toBe(200)

  // audio：清单里已经看不到，但客户端仍可能持有一份旧清单缓存并据此构造出这个
  // assetId——download-url 端点必须独立重新判定策略（而不是信任清单已经把关过），
  // 在这里被拦截。
  const audioAssetId = `${meetingRecordId}:${fileId}:audio:0`
  const audioDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(audioAssetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(audioDl.status).toBe(403)
  expect((await audioDl.json()).error).toBe('forbidden')

  const [auditRows] = await pool.execute<RowDataPacket[]>(
    "SELECT decision, action FROM audit_log WHERE asset_id = ?",
    [audioAssetId],
  )
  expect(auditRows).toHaveLength(1)
  expect(auditRows[0]!.decision).toBe('deny')
  expect(auditRows[0]!.action).toBe('issue_download_url')
})

test('STS-Token 未就位时，video 可下载而 ai_minutes 返回 unavailable', async () => {
  // sts_token_requests 是本测试文件内跨用例共享的同一张表（withTestDb 每个
  // *文件* 一个隔离库，同一文件内的多个 test 共用同一个库，见 tests/helpers/testdb.ts）。
  // "完整流程" 用例会真的续期出一个 fulfilled token（有效期到 NOW+3600），
  // 若本用例仍用 NOW 起步，getActive() 会把那个 token 当作"当前有效"从而
  // 误判为已就位。用一个明显晚于该 token 过期时间的起点，确保这里断言的
  // "STS-Token 未就位" 是真的未就位，而不是被前一个用例的状态污染。
  const STS_TEST_NOW = NOW + 50_000
  const clock = stepClock(STS_TEST_NOW)
  const meetingRecordId = 'rec-e2e-sts-1'
  const meetingId = 'm-e2e-sts-1'
  const fileId = 'file-e2e-sts-1'

  const { app, fakeState, requestLog } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-sts-1', email: null }),
  })

  fakeState.records.push({
    meeting_record_id: meetingRecordId,
    meeting_id: meetingId,
    meeting_code: '700003',
    host_user_id: 'ww-e2e-sts-1',
    media_start_time: STS_TEST_NOW * 1000,
    subject: 'STS 未就位测试会议',
    state: 3,
  })
  fakeState.addressesByRecordId.set(meetingRecordId, [
    {
      record_file_id: fileId,
      download_address: 'https://cos.example/sts-video.mp4',
      download_address_file_type: 'mp4',
      allow_download: true,
    },
  ])
  // 有意不调用 ensureFresh、不投递 webhook、不注册 addressDetailByFileId——
  // STS-Token 从未就位，且详情端点理应完全不会被调用（见下方断言）。

  await insertPolicyRule(pool, {
    priority: 10,
    subjectType: 'user',
    subjectValue: 'ww-e2e-sts-1',
    resourceExpr: {},
    assetTypes: ['*'],
    effect: 'allow',
  })

  const { access_token } = await deviceLogin(app, clock)
  const headers = { Authorization: `Bearer ${access_token}` }

  const assetsRes = await app(new Request(`https://gw/api/v1/meetings/${meetingId}/assets`, { headers }))
  expect(assetsRes.status).toBe(200)
  const assetsBody = (await assetsRes.json()) as { assets: Array<{ asset_id: string; asset_type: string }> }
  // ai_minutes 因 STS-Token 不可用被 catalog 直接排除，video 不受影响
  expect(assetsBody.assets.map((a) => a.asset_type)).toEqual(['video'])
  // STS 不可用时 tryGetToken 提前短路：详情端点（ai_* 系列的唯一来源）完全不应被真实调用
  expect(requestLog.some((r) => r.path === `/v1/addresses/${fileId}`)).toBe(false)

  const videoAssetId = assetsBody.assets[0]!.asset_id
  const videoDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(videoAssetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(videoDl.status).toBe(200)
  expect(((await videoDl.json()) as { url: string }).url).toBe('https://cos.example/sts-video.mp4')

  const aiAssetId = `${meetingRecordId}:${fileId}:ai_minutes:0`
  const aiDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(aiAssetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(aiDl.status).toBe(503)
  expect((await aiDl.json()).error).toBe('sts_token_unavailable')
})

test('会议号命中多场时列出候选', async () => {
  const clock = stepClock(NOW)
  const meetingCode = '700004'

  const { app, fakeState } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-multi-1', email: null }),
  })

  fakeState.records.push(
    {
      meeting_record_id: 'rec-e2e-multi-1',
      meeting_id: 'm-e2e-multi-1',
      meeting_code: meetingCode,
      host_user_id: 'ww-e2e-multi-1',
      media_start_time: NOW * 1000,
      subject: '周期会议第一次',
      state: 3,
    },
    {
      meeting_record_id: 'rec-e2e-multi-2',
      meeting_id: 'm-e2e-multi-2',
      meeting_code: meetingCode,
      host_user_id: 'ww-e2e-multi-1',
      // 查询窗口的右边界是请求发生时的 now（会随设备登录流程的 clock.advance
      // 略微前移），不能晚于它——用早于 NOW 的时间点，而不是晚于，才稳妥地落在
      // [now - 31天, now] 窗口内。
      media_start_time: (NOW - 3600) * 1000,
      subject: '周期会议第二次',
      state: 3,
    },
  )

  await insertPolicyRule(pool, {
    priority: 10,
    subjectType: 'user',
    subjectValue: 'ww-e2e-multi-1',
    resourceExpr: {},
    assetTypes: ['*'],
    effect: 'allow',
  })

  const { access_token } = await deviceLogin(app, clock)
  const headers = { Authorization: `Bearer ${access_token}` }

  const res = await app(new Request(`https://gw/api/v1/meetings?meeting_code=${meetingCode}`, { headers }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { meetings: Array<{ meeting_id: string; meeting_code: string }> }
  expect(body.meetings).toHaveLength(2)
  expect(body.meetings.map((m) => m.meeting_id).sort()).toEqual(['m-e2e-multi-1', 'm-e2e-multi-2'])
  expect(body.meetings.every((m) => m.meeting_code === meetingCode)).toBe(true)
})

test('身份映射失败时登录被拒，错误码为 account_not_provisioned', async () => {
  const clock = stepClock(NOW)
  const { app } = buildE2eApp(pool, {
    now: clock.now,
    identityStrategy: 'table', // ww-e2e-unmapped-1 不在 identity_map 表中 ⇒ 必然映射失败
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-unmapped-1', email: null }),
  })

  const codeRes = await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  const codeBody = (await codeRes.json()) as { device_code: string }
  const state = await lookupDeviceState(codeBody.device_code)

  const cbRes = await app(new Request(`https://gw/auth/wecom/callback?code=any-code&state=${state}`))
  expect(cbRes.status).toBe(403)
  const text = await cbRes.text()
  expect(text).toContain('account_not_provisioned')

  // 设备记录不应被标记为已授权——映射失败等于登录失败，不能悄悄放行
  const [deviceRows] = await pool.execute<RowDataPacket[]>(
    'SELECT status FROM device_authorizations WHERE device_code = ?',
    [codeBody.device_code],
  )
  expect(deviceRows[0]!.status).toBe('pending')

  const [auditRows] = await pool.execute<RowDataPacket[]>(
    "SELECT decision, asset_type FROM audit_log WHERE actor_id = ? AND action = 'login'",
    ['ww-e2e-unmapped-1'],
  )
  expect(auditRows).toHaveLength(1)
  expect(auditRows[0]!.decision).toBe('deny')
  expect(auditRows[0]!.asset_type).toBe('account_not_provisioned')

  // 整条链路确实被卡住：拿这个 device_code 去轮询依旧是 pending，换不到任何令牌
  const tokenRes = await app(deviceTokenRequest(codeBody.device_code))
  expect(tokenRes.status).toBe(400)
  expect((await tokenRes.json()).error).toBe('authorization_pending')
})

test('假腾讯服务对签名不匹配的请求返回 9042，网关判定为致命错误并立即失败（不重试）', async () => {
  const fakeState = createFakeTencentState()
  const fakeServer = startFakeTencentServer(
    { secretId: TENCENT_SECRET_ID, secretKey: TENCENT_SECRET_KEY },
    fakeState,
  )
  runningServers.push(fakeServer.stop)

  fakeState.records.push({
    meeting_record_id: 'rec-e2e-badsig-1',
    meeting_id: 'm-e2e-badsig-1',
    meeting_code: '700099',
    host_user_id: 'tm-whoever',
    media_start_time: NOW * 1000,
    subject: '不应被读到的会议',
    state: 3,
  })

  // 故意用错误的 secretKey 签名，模拟配置错误/凭证泄露后被篡改一类场景。
  const client = createTencentClient(
    {
      appId: 'app-e2e',
      sdkId: 'sdk-e2e',
      secretId: TENCENT_SECRET_ID,
      secretKey: 'this-is-the-wrong-secret-key',
      operatorId: OPERATOR_ID,
      qps: 50,
      baseUrl: fakeServer.url,
    },
    { fetch, sleep: () => Promise.resolve(), now: () => NOW },
  )

  let caught: unknown = null
  try {
    await client.get('/v1/records', {
      operator_id: OPERATOR_ID,
      operator_id_type: 1,
      start_time: NOW - 60,
      end_time: NOW,
      page: 1,
      page_size: 20,
    })
  } catch (err) {
    caught = err
  }

  expect(caught).toBeInstanceOf(TencentApiError)
  const apiError = caught as TencentApiError
  expect(apiError.errorCode).toBe(9042)
  expect(apiError.classification).toBe('fatal')

  // fatal 分类的既有约定是不重试（见 src/tencent/client.ts）：假服务应当只被真实打过一次。
  expect(fakeServer.requestLog).toHaveLength(1)
  expect(fakeServer.requestLog[0]!.signatureValid).toBe(false)
})
