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
import { createHash, createCipheriv } from 'node:crypto'
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
import { createSmartApi } from '../../src/tencent/smart'
import { createCatalog } from '../../src/catalog/index'
import { createStsStore } from '../../src/store/sts'
import { createStsManager } from '../../src/sts/manager'
import { verifySignature, decryptEvent, decryptCheckStr } from '../../src/sts/crypto'
import { createGrantsStore } from '../../src/store/grants'
import { createPolicyStore } from '../../src/store/policy'
import { createAccessGate } from '../../src/policy/access'
import { createArchivesStore } from '../../src/store/archives'
import { createAuditStore } from '../../src/store/audit'
import { createConsoleMeetingsStore } from '../../src/store/console-meetings'
import type { VisibilityDeps } from '../../src/worker/visibility'
import { createAuditRecorder } from '../../src/audit/recorder'
import { createAuthStore } from '../../src/store/auth'
import { createDeviceFlow } from '../../src/auth/device'
import { createIdentityMapper } from '../../src/auth/identity'
import { createServiceAuth } from '../../src/auth/service'
import { createAdminStore } from '../../src/store/admin'
import { createAdminAuth } from '../../src/auth/admin'
import { createMeetingCacheStore } from '../../src/store/meetings'
import { createApp, type AppDeps } from '../../src/http/router'
import { createLoginRateLimiter } from '../../src/http/ratelimit'
import { createProgramsStore } from '../../src/store/programs'
import { DEFAULT_FETCH_LOOKBACK_HOURS, createJobsStore } from '../../src/store/jobs'
import { createConsoleStorageStore } from '../../src/store/console-storage'
import { createAuditMeetingLookup } from '../../src/http/handlers/console/audit'
import { createContentLookup } from '../../src/http/handlers/console/content'
// 阶段 4 · T6（A3 规则 API）新增的一条依赖，装配方式跟随 src/index.ts
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

  let fakeMs = Date.now()
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
    // 令牌桶与 `/v1/corp/records` 的分钟级配额都按毫秒计时：这里必须给毫秒时钟，
    // 给秒级的 now 会让补充速率慢 1000 倍。
    //
    // 用**假的**毫秒时钟、由 sleep 往前拨，而不是 Date.now + 空 sleep：corp 的配额
    // 是零突发的 10次/min，一个测试里第二次 corp 调用要隔满 6 秒。真睡就是慢 6 秒，
    // 而 sleep 直接 resolve 会让 client 里那个 `for(;;) { tryTake; await sleep }`
    // 空转 6 秒真实时间——微任务连轴转，把同进程里 Bun.serve 的连接直接饿死
    // （表现是「Unable to connect」，看起来像假服务挂了）。
    { fetch, sleep: (ms) => { fakeMs += ms; return Promise.resolve() }, nowMs: () => fakeMs },
  )

  // 顺序跟随 src/index.ts：meeting_cache 是精确查询的第一级，得先有它
  const meetingsCache = createMeetingCacheStore(dbPool)
  const recordsApi = createRecordsApi(tencentClient, OPERATOR_ID, meetingsCache)
  const addressesApi = createAddressesApi(tencentClient, OPERATOR_ID)
  // 智能纪要/章节走 AK/SK 直调，同一个真实 client 打到假服务上（没登记的文件回 500182）
  const smartApi = createSmartApi(tencentClient, OPERATOR_ID)

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
    decryptCheckStr,
  })

  const catalog = createCatalog({ addressesApi, smartApi, stsManager, now })

  const policyStore = createPolicyStore(dbPool)
  // 与 src/index.ts / testApp.ts 同一个实例口径
  const consoleMeetings = createConsoleMeetingsStore(dbPool, { policy: policyStore })
  const grantsStore = createGrantsStore(dbPool)
  // 跟随 src/index.ts（阶段 5 · A8）：判定读同一个 programsStore
  const programsStore = createProgramsStore(dbPool)
  const accessGate = createAccessGate({
    store: policyStore,
    // 跟随 src/index.ts：同一个 store 按两个接口递进去，改写与授权分得开（阶段 6）
    overrides: grantsStore,
    grants: grantsStore,
    programs: { isProgramEnabled: async (id) => (await programsStore.find(id))?.enabled === true },
  })
  const archivesStore = createArchivesStore(dbPool)

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

  // 管理员会话与账号管理（Task 3，A1）——与上面企微/服务账号认证线完全独立，
  // 装配方式跟随 src/index.ts：真实 AdminStore/AdminAuth，接到同一个测试库
  const adminStore = createAdminStore(dbPool)
  const adminAuth = createAdminAuth({ store: adminStore })
  const gatewayBaseUrl = 'https://gw.e2e.example'

  // 控制台会议查询（阶段 4 · T5，A2）。装配方式跟随 src/index.ts
  const meetingVisibility: VisibilityDeps = {
    policy: policyStore,
    grants: createGrantsStore(dbPool),
    archives: archivesStore,
    getMeetings: (keys) => consoleMeetings.getMeetings(keys),
  }

  const deps: AppDeps = {
    now,
    jwtSecret: JWT_SECRET,
    gatewayBaseUrl,
    recordsApi,
    catalog,
    accessGate,
    archives: archivesStore,
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
    adminAuth,
    adminStore,
    // 跟随 src/index.ts 同一条推导规则：gatewayBaseUrl 是 https 即为 true
    cookieSecure: new URL(gatewayBaseUrl).protocol === 'https:',
    consoleStatic: null,
    // 阶段 4 · T7（A3 采集授权）：真实模块，接到同一个 e2e 测试库
    programs: programsStore,
    grantsStore,
    policyStore,
    archivesStore,
    auditStore,
    getMeetings: consoleMeetings.getMeetings,
    // 归档存储页（阶段 4 · T8）。e2e 这条流程不覆盖它，这里只需满足 AppDeps 契约：
    // 没有真实 NAS 挂载点，因此探测固定回"不可达"、清理注入 null——两者都是
    // handler 的显式降级分支，不是会让别的用例静默出错的假实现。
    storage: {
      nasRoot: null,
      probeNas: async () => ({
        reachable: false,
        checkedAt: now(),
        latencyMs: 0,
        totalBytes: null,
        availableBytes: null,
        error: 'e2e 环境未挂载 NAS',
      }),
      stats: createConsoleStorageStore(dbPool),
      archives: archivesStore,
      audit: auditStore,
      cleanup: null,
      // 阶段 5 · A8：真实实现接同一个 e2e 库，跟随 src/index.ts
      jobFailures: createJobsStore(dbPool),
    },
    // 阶段 6 · 管理端媒体流。跟随 src/index.ts：**与 storage.nasRoot 是同一个值**。
    // 这里没有 NAS 挂载点，所以是 null——端点据此返回 503 nas_root_unset（一条
    // handler 的显式降级分支），而不是静默 404 让人以为是文件不见了。
    // 真要跑流式读的用例在 tests/http/console-media.test.ts 里注入自己的临时目录。
    media: { nasRoot: null },
    // 审计读侧（阶段 4 · A5）：与 auditRecorder 同源，装配方式跟随 src/index.ts
    auditQuery: auditStore,
    auditMeetings: createAuditMeetingLookup(dbPool),
    // 阶段 4 · T6（A3 规则 API）。跟随 src/index.ts：会议查询 store 与 getMeetings
    // 用同一个实例，注入的 policy 也是同一份
    consoleMeetings,
    meetingVisibility,
    meetingHistory: auditStore,
    // 归档失败的真原因（阶段 5 · D-4）：真实实现接同一个 e2e 库
    archiveFailures: createJobsStore(dbPool),
    // 内容预览（阶段 4 · T10）。装配方式跟随 src/index.ts
    contents: createContentLookup(dbPool),
    // 阶段 4 · T11（A4 定时任务）：网关只装读侧与手动触发的排队，
    // 调度器在 worker 进程里，不进这条端到端链路
    // fetchLookbackHours 跟随 src/index.ts 的默认值：真实装配读的是
    // MDE_SCHEDULER_FETCH_LOOKBACK_HOURS，e2e 这里没有配置它，就是默认的 24
    jobs: {
      jobs: createJobsStore(dbPool),
      audit: auditStore,
      tzOffsetSec: 0,
      fetchLookbackHours: DEFAULT_FETCH_LOOKBACK_HOURS,
    },
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

/**
 * 建一个采集程序（`service_accounts` 里一行）并换出访问令牌，走的是真实的
 * `POST /api/v1/auth/service-token`：真 argon2 校验、真签发。
 *
 * 取数据的链路一律用它，**不用设备登录**：阶段 3 之后采集权限规则的主体是
 * 采集程序（`service_accounts.id`），企微用户登录的是人，没有采集程序身份，
 * 走到 allow 栈会被显式拒绝（见下面那条专门盯这件事的用例）。
 */
async function serviceLogin(
  app: (req: Request) => Promise<Response>,
  clientId: string,
  tmUserId: string,
): Promise<{ access_token: string }> {
  const secret = `secret-${clientId}`
  const hash = await Bun.password.hash(secret, { algorithm: 'argon2id' })
  await pool.execute(
    `INSERT INTO service_accounts (id, name, secret_hash, tm_userid, enabled, expires_at, created_at)
     VALUES (?, ?, ?, ?, 1, NULL, 0)
     ON DUPLICATE KEY UPDATE secret_hash = VALUES(secret_hash), tm_userid = VALUES(tm_userid)`,
    [clientId, `e2e ${clientId}`, hash, tmUserId],
  )
  const res = await app(
    new Request('https://gw/api/v1/auth/service-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: secret }),
    }),
  )
  if (res.status !== 200) {
    throw new Error(`e2e service token exchange failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as { access_token: string }
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
  // 官方《事件加解密》的明文结构：`msg + $key`——JSON 之后直接拼 $key，
  // 没有企业微信那套 16 随机字节 + 4 字节长度头的前缀
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const plain = Buffer.from(`${json}TailKey0123456789`, 'utf8')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

/** 官方契约：验签三参数在 Header，密文在 body 的 `data` 字段 */
function webhookRequest(encrypted: string, now: number): Request {
  const timestamp = String(now)
  const nonce = 'nonce-e2e'
  return new Request('https://gw/webhook/tencent-meeting', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      timestamp,
      nonce,
      signature: makeWebhookSignature(WEBHOOK_TOKEN, timestamp, nonce, encrypted),
    },
    body: JSON.stringify({ data: encrypted }),
  })
}

/**
 * 三个「与」的第一个：把一场会议授权给这个采集程序（阶段 6，spec §1.3）。
 *
 * **一条 allow 规则不足以让网关放行**——`AccessGate` 在套完人工改写之后还要过一道
 * 授权行，没有授权的会议判成 `not_granted`（见 src/policy/grant.ts）。所以本文件里
 * 凡是断言「取得到」的链路，除了造规则还要造授权。
 *
 * 走真实的 `GrantsStore.grant`（控制台按下「授权」时跑的就是这一段），
 * 不往表里塞 SQL——本文件的规矩是「假腾讯 API + 真网关」，写侧同样要是真的。
 *
 * `assetTypes: null` = 不额外限制资产范围，判定完全由规则那一栈说了算。
 */
async function grantMeeting(meetingId: string, programId: string): Promise<void> {
  await createGrantsStore(pool).grant({
    meetingId,
    subMeetingId: '',
    programId,
    assetTypes: null,
    now: NOW * 1000,
  })
}

test('完整流程：采集程序登录 → 列会议 → 取资产 → 换下载地址', async () => {
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
    // 详情接口（要 STS）下剩的那一类：优化版逐字稿。纪要改走智能接口，见下一行
    ai_meeting_transcripts: [
      { download_address: 'https://cos.example/full-ai-transcript.docx', file_type: 'docx' },
    ],
  })
  // 纪要走智能接口：正文由网关取回后内嵌成 data: URL，平台不签发链接
  fakeState.smartMinutesByFileId.set(fileId, '## 会议摘要\n\n正文\n')
  fakeState.stsReqId = reqId

  await insertPolicyRule(pool, {
    priority: 10,
    programId: 'prog-e2e-full-1',
    assetTypes: ['*'],
    effect: 'allow',
    note: '放行 e2e 全流程采集程序',
  })
  await grantMeeting(meetingId, 'prog-e2e-full-1')

  // STS-Token 就位：真实发起 ensureFresh（对假服务的一次真实带签名 HTTP 调用），
  // 再用真实的 webhook 端点投递回调完成续期——不是直接往 DB 里塞一条 fulfilled 记录。
  await deps.stsManager.ensureFresh(clock.now())
  const encrypted = encryptStsEvent(WEBHOOK_AES_KEY, reqId, 'sts-tok-full-1', clock.now() + 3600)
  const webhookRes = await app(webhookRequest(encrypted, clock.now()))
  expect(webhookRes.status).toBe(200)

  // 1. 采集程序登录（真 argon2 校验 + 真签发）
  const { access_token } = await serviceLogin(app, 'prog-e2e-full-1', 'ww-e2e-full-1')
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
  expect(assetsBody.assets.map((a) => a.asset_type).sort())
    .toEqual(['ai_meeting_transcripts', 'ai_minutes', 'audio', 'video'])

  const videoAsset = assetsBody.assets.find((a) => a.asset_type === 'video')!
  const aiAsset = assetsBody.assets.find((a) => a.asset_type === 'ai_meeting_transcripts')!
  const minutesAsset = assetsBody.assets.find((a) => a.asset_type === 'ai_minutes')!

  // 4. 换下载地址：video 走批量接口（6 小时时效），优化版逐字稿走详情接口
  //    （5 分钟时效，需 STS-Token），纪要走智能接口（data: URL，完全不碰 STS）
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
  expect(aiDlBody.url).toBe('https://cos.example/full-ai-transcript.docx')
  expect(aiDlBody.expires_at - clock.now()).toBe(5 * 60)

  const minutesDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(minutesAsset.asset_id)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(minutesDl.status).toBe(200)
  const minutesDlBody = (await minutesDl.json()) as { url: string }
  // 正文内嵌在 URL 里——对它做一次普通 fetch 就该拿回假服务登记的那份 markdown
  expect(await (await fetch(minutesDlBody.url)).text()).toBe('## 会议摘要\n\n正文\n')

  // 假腾讯服务确实被真实、带正确签名地调用过（不是从未走网络的旁路）
  const hitPaths = new Set(requestLog.filter((r) => r.signatureValid).map((r) => r.path))
  expect(hitPaths.has('/v1/app/sts-token')).toBe(true)
  expect(hitPaths.has('/v1/corp/records')).toBe(true)
  expect(hitPaths.has('/v1/addresses')).toBe(true)
  expect(hitPaths.has(`/v1/addresses/${fileId}`)).toBe(true)
  expect(hitPaths.has(`/v1/smart/minutes/${fileId}`)).toBe(true)
  expect(requestLog.every((r) => r.signatureValid)).toBe(true) // 全程签名均正确、无一次被假服务拒绝

  // 审计留痕：三次下载地址签发都记为 allow
  const [auditRows] = await pool.execute<RowDataPacket[]>(
    "SELECT decision FROM audit_log WHERE action = 'issue_download_url' AND meeting_id = ?",
    [meetingRecordId],
  )
  expect(auditRows).toHaveLength(3)
  expect(auditRows.every((r) => r.decision === 'allow')).toBe(true)
})

/**
 * 阶段 3 的语义变更，用一条端到端用例钉死：**设备授权登录仍然走得通，但登录的是
 * 人，不是采集程序。** 采集权限规则（allow 栈）的主体是 `service_accounts.id`，
 * 企微用户没有这个身份，所以规则怎么建都取不到数据。
 *
 * 这不是「恰好没有匹配的规则」——建一条主体写成腾讯会议 userid 的规则（旧库里
 * 就是这个形状）在这里同样无效，正是迁移时**不自动转换语义**的直接后果。
 */
test('设备授权登录成功，但企微用户不是采集程序，一场会议都取不到', async () => {
  const clock = stepClock(NOW)
  const meetingRecordId = 'rec-e2e-person-1'
  const meetingId = 'm-e2e-person-1'
  const fileId = 'file-e2e-person-1'

  const { app, fakeState } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-person-1', email: null }),
  })

  fakeState.records.push({
    meeting_record_id: meetingRecordId,
    meeting_id: meetingId,
    meeting_code: '700005',
    host_user_id: 'ww-e2e-person-1',
    media_start_time: NOW * 1000,
    subject: '企微用户看不到的会议',
    state: 3,
  })
  fakeState.addressesByRecordId.set(meetingRecordId, [
    {
      record_file_id: fileId,
      download_address: 'https://cos.example/person-video.mp4',
      download_address_file_type: 'mp4',
      allow_download: true,
    },
  ])

  // 旧形状的规则：主体是人（腾讯会议 userid）。换语义后它对任何身份都不生效。
  await insertPolicyRule(pool, {
    priority: 100,
    subjectType: 'user',
    subjectValue: 'ww-e2e-person-1',
    assetTypes: ['*'],
    effect: 'allow',
    note: '旧形状：主体是人',
  })

  // 登录本身照常成功——被拒的是取数据，不是登录
  const { access_token } = await deviceLogin(app, clock)
  const headers = { Authorization: `Bearer ${access_token}` }

  const listRes = await app(new Request('https://gw/api/v1/meetings?meeting_code=700005', { headers }))
  expect(listRes.status).toBe(200)
  expect(((await listRes.json()) as { meetings: unknown[] }).meetings).toEqual([])

  // 列会议这一步已经把 meeting 写进了 meeting_cache（缓存写入与展示过滤是两回事），
  // 所以下面这个 assetId 走的是「缓存命中 + 判定为拒绝」那条路径，不是「查不到」。
  const assetId = `${meetingRecordId}:${fileId}:video:0`
  const dlRes = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(dlRes.status).toBe(403)
  expect((await dlRes.json()).error).toBe('forbidden')

  const [auditRows] = await pool.execute<RowDataPacket[]>(
    'SELECT decision, matched_rule FROM audit_log WHERE asset_id = ?',
    [assetId],
  )
  expect(auditRows).toHaveLength(1)
  expect(auditRows[0]!.decision).toBe('deny')
  // 没有任何规则参与这次判定：拒绝的理由是「这个身份不是采集程序」，
  // 不是「某条规则说了 deny」
  expect(auditRows[0]!.matched_rule).toBeNull()
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

  // 只放行 video；audio（及其余类型）取不到——命中的规则只放行 video 这一类，
  // 这与「一条规则都没命中走兜底 deny」是两种不同的拒绝（计划 §3.4.1 D-e）
  await insertPolicyRule(pool, {
    priority: 10,
    programId: 'prog-e2e-deny-1',
    assetTypes: ['video'],
    effect: 'allow',
    note: '只放行录像',
  })
  // 授权不限制范围：这条用例要拦住 audio 的是**规则**，不是授权
  await grantMeeting(meetingId, 'prog-e2e-deny-1')

  const { access_token } = await serviceLogin(app, 'prog-e2e-deny-1', 'ww-e2e-deny-1')
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

test('人工改写 deny 拦得住 download-url——改写要到达真正的安全边界', async () => {
  const clock = stepClock(NOW)
  const meetingRecordId = 'rec-e2e-ovr-1'
  const meetingId = 'm-e2e-ovr-1'
  const fileId = 'file-e2e-ovr-1'

  const { app, fakeState } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-ovr-1', email: null }),
  })

  fakeState.records.push({
    meeting_record_id: meetingRecordId,
    meeting_id: meetingId,
    meeting_code: '700009',
    host_user_id: 'ww-e2e-ovr-1',
    media_start_time: NOW * 1000,
    subject: '法务要求不外发的会议',
    state: 3,
  })
  fakeState.addressesByRecordId.set(meetingRecordId, [
    {
      record_file_id: fileId,
      download_address: 'https://cos.example/ovr-video.mp4',
      download_address_file_type: 'mp4',
      allow_download: true,
    },
  ])

  // 规则本身是放行的——本用例要证明的正是「规则说可以，改写说不行，以改写为准」
  await insertPolicyRule(pool, {
    priority: 10,
    programId: 'prog-e2e-ovr-1',
    assetTypes: ['*'],
    effect: 'allow',
    note: '全部放行',
  })
  // 授权也给上：这条用例要证明的是「改写压过规则」，不能让「没授权」抢在前面
  await grantMeeting(meetingId, 'prog-e2e-ovr-1')

  const { access_token } = await serviceLogin(app, 'prog-e2e-ovr-1', 'ww-e2e-ovr-1')
  const headers = { Authorization: `Bearer ${access_token}` }

  // ① 没有改写时：列得出、取得到
  const before = await app(new Request('https://gw/api/v1/meetings?meeting_code=700009', { headers }))
  expect(((await before.json()) as { meetings: unknown[] }).meetings).toHaveLength(1)

  const assetsRes = await app(new Request(`https://gw/api/v1/meetings/${meetingId}/assets`, { headers }))
  const assetsBody = (await assetsRes.json()) as { assets: Array<{ asset_id: string }> }
  const assetId = assetsBody.assets[0]!.asset_id

  const okDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(okDl.status).toBe(200)

  // ② 管理员按下「这场不许取」。改写优先于所有规则（spec §5.4），而且必须在
  //    **数据出境的那道闸门**上生效——只在采集清单里生效的话，它就不是一条
  //    安全规则，只是一个展示效果
  await createGrantsStore(pool).putOverride({
    meetingId,
    subMeetingId: '',
    kind: 'allow',
    effect: 'deny',
    assetTypes: null,
    reason: '法务要求这场不外发',
    now: NOW * 1000,
  })

  // ③ 会议从列表里消失
  const after = await app(new Request('https://gw/api/v1/meetings?meeting_code=700009', { headers }))
  expect(((await after.json()) as { meetings: unknown[] }).meetings).toHaveLength(0)

  // ④ 客户端拿着改写之前缓存下来的 assetId 直接换下载地址——被拦住。
  //    这一条才是真正要紧的：清单过滤是 UI 便利，download-url 才是安全边界
  const deniedDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(deniedDl.status).toBe(403)
  expect((await deniedDl.json()).error).toBe('forbidden')

  // ⑤ 撤销改写后回落到规则判定
  await createGrantsStore(pool).revokeOverride(meetingId, '', 'allow', NOW * 1000 + 1)
  const restoredDl = await app(
    new Request(`https://gw/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, {
      method: 'POST',
      headers,
    }),
  )
  expect(restoredDl.status).toBe(200)
})

test('STS-Token 未就位时，video 可下载而优化版逐字稿返回 unavailable', async () => {
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
    programId: 'prog-e2e-sts-1',
    assetTypes: ['*'],
    effect: 'allow',
  })
  await grantMeeting(meetingId, 'prog-e2e-sts-1')

  const { access_token } = await serviceLogin(app, 'prog-e2e-sts-1', 'ww-e2e-sts-1')
  const headers = { Authorization: `Bearer ${access_token}` }

  const assetsRes = await app(new Request(`https://gw/api/v1/meetings/${meetingId}/assets`, { headers }))
  expect(assetsRes.status).toBe(200)
  const assetsBody = (await assetsRes.json()) as { assets: Array<{ asset_id: string; asset_type: string }> }
  // ai_meeting_transcripts 因 STS-Token 不可用被 catalog 直接排除，video 不受影响；
  // 纪要与时间轴这次也没有，是因为假服务对没登记的文件回 500182（没开智能录制）
  expect(assetsBody.assets.map((a) => a.asset_type)).toEqual(['video'])
  // STS 不可用时 tryGetToken 提前短路：详情端点（优化版逐字稿的唯一来源）完全不应被真实调用
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

  const aiAssetId = `${meetingRecordId}:${fileId}:ai_meeting_transcripts:docx`
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
    programId: 'prog-e2e-multi-1',
    assetTypes: ['*'],
    effect: 'allow',
  })
  await grantMeeting('m-e2e-multi-1', 'prog-e2e-multi-1')
  await grantMeeting('m-e2e-multi-2', 'prog-e2e-multi-1')

  const { access_token } = await serviceLogin(app, 'prog-e2e-multi-1', 'ww-e2e-multi-1')
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
    "SELECT decision, asset_type, detail FROM audit_log WHERE actor_id = ? AND action = 'login'",
    ['ww-e2e-unmapped-1'],
  )
  expect(auditRows).toHaveLength(1)
  expect(auditRows[0]!.decision).toBe('deny')
  // 登录失败原因在 detail 列（migrations/008）；从前它被塞在 asset_type 上
  expect(auditRows[0]!.detail).toBe('account_not_provisioned')
  expect(auditRows[0]!.asset_type).toBeNull()

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
    { fetch, sleep: () => Promise.resolve(), nowMs: Date.now },
  )

  let caught: unknown = null
  try {
    await client.get('/v1/corp/records', {
      operator_id: OPERATOR_ID,
      operator_id_type: 1,
      start_time: NOW - 60,
      end_time: NOW,
      page: 1,
      page_size: 20,
      query_record_type: 0,
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

/**
 * **全公司归档的数据来源**（spec §1.2 · US-5.1），端到端钉死。
 *
 * 2026-08-27 真实环境实测：走 `/v1/records` 拉最近 31 天，7 场会议的
 * host_userid 全是 TM_OPERATOR_ID 本人——官方文档对该接口的原话是「查询**用户**
 * 所有会议的录制列表」，参数表里根本没有指定查谁的参数，应用配了「查看企业录制」
 * 权限也改变不了。范围查询因此改走账户级的 `/v1/corp/records`。
 *
 * 这条用例走真网关 + 真签名 + 假腾讯 HTTP 服务，验三件事：
 *   1. 范围查询打的是 `/v1/corp/records`，一次都没打 `/v1/records`；
 *   2. 拿得到**别人主持的**会议，主持人不再恒等于 operator；
 *   3. `userid` → hostUserId 的映射真的接通了。
 */
test('范围查询经 /v1/corp/records 拿到别人主持的会议——不再只看得到 operator 自己的', async () => {
  const clock = stepClock(NOW)
  const { app, fakeState, requestLog } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-corp-1', email: null }),
  })

  // 三场会议，主持人各不相同，且**没有一个**是网关的 operator。
  // 走旧的 /v1/records 时这三场一场都拉不到。
  const hosts = ['ww-e2e-corp-alice', 'ww-e2e-corp-bob', 'ww-e2e-corp-carol']
  hosts.forEach((host, i) => {
    fakeState.records.push({
      meeting_record_id: 'rec-e2e-corp-' + i,
      meeting_id: 'm-e2e-corp-' + i,
      meeting_code: '70011' + i,
      host_user_id: host,
      media_start_time: NOW * 1000,
      subject: '别人主持的会议 ' + i,
      state: 3,
    })
  })
  expect(fakeState.records.every((r) => r.host_user_id !== OPERATOR_ID)).toBe(true)

  await insertPolicyRule(pool, {
    priority: 10,
    programId: 'prog-e2e-corp-1',
    assetTypes: ['*'],
    effect: 'allow',
    note: '放行 e2e 企业维度采集程序',
  })
  for (let i = 0; i < hosts.length; i++) await grantMeeting('m-e2e-corp-' + i, 'prog-e2e-corp-1')

  const { access_token } = await serviceLogin(app, 'prog-e2e-corp-1', 'ww-e2e-corp-1')
  const headers = { Authorization: 'Bearer ' + access_token }

  // 不带 meeting_code / meeting_id ⇒ 范围查询（worker 的主路径）
  const res = await app(new Request('https://gw/api/v1/meetings', { headers }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    meetings: Array<{ meeting_id: string; host_user_id: string }>
  }

  expect(body.meetings.map((m) => m.meeting_id).sort()).toEqual([
    'm-e2e-corp-0', 'm-e2e-corp-1', 'm-e2e-corp-2',
  ])
  // userid → hostUserId 的映射真的接通了；照搬 host_user_id 时这里全是 undefined
  expect(body.meetings.map((m) => m.host_user_id).sort()).toEqual(hosts)
  expect(body.meetings.every((m) => m.host_user_id !== OPERATOR_ID)).toBe(true)

  const hitPaths = requestLog.filter((r) => r.signatureValid).map((r) => r.path)
  expect(hitPaths).toContain('/v1/corp/records')
  expect(hitPaths).not.toContain('/v1/records') // 范围查询一次都不该打用户维度接口
  expect(requestLog.every((r) => r.signatureValid)).toBe(true) // 新路径的签名同样正确
})

/**
 * 与上一条互补：精确查询（`mde get --code` 依赖的那条路）**也**走 `/v1/corp/records`。
 *
 * 2026-08-27 之前它走 `/v1/records`，那是个只看得到 operator 自己会议的接口，
 * 于是范围查询改走 corp 之后当场炸出 P0（见 tencent/records.ts 的文件头）。
 * 现在的解析顺序是「meeting_cache → corp 全窗口枚举 + 本地过滤 → 报错」，
 * 这条用例逐级钉住：**别人主持的会议按会议号查得到**、缓存热了之后零调用、
 * 未命中的理由说的是时间窗而不是可见范围。
 */
test('精确查询走 corp + meeting_cache：查得到别人主持的会议，缓存热了之后零调用', async () => {
  const clock = stepClock(NOW)
  const { app, fakeState, requestLog } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-exact-1', email: null }),
  })

  fakeState.records.push({
    meeting_record_id: 'rec-e2e-exact-1',
    meeting_id: 'm-e2e-exact-1',
    meeting_code: '700120',
    // 主持人**不是**登录的这个采集程序对应的人，也不是 OPERATOR_ID：
    // 旧实现（走 /v1/records）在真实环境里根本看不见这一场
    host_user_id: 'ww-e2e-someone-else',
    media_start_time: NOW * 1000,
    subject: '按会议号点名查询',
    state: 3,
  })

  await insertPolicyRule(pool, {
    priority: 10, programId: 'prog-e2e-exact-1', assetTypes: ['*'], effect: 'allow',
  })
  await grantMeeting('m-e2e-exact-1', 'prog-e2e-exact-1')
  const { access_token } = await serviceLogin(app, 'prog-e2e-exact-1', 'ww-e2e-exact-1')
  const headers = { Authorization: 'Bearer ' + access_token }

  const hitRes = await app(new Request('https://gw/api/v1/meetings?meeting_code=700120', { headers }))
  expect(hitRes.status).toBe(200)
  const hitBody = (await hitRes.json()) as { meetings: Array<{ meeting_id: string; host_user_id: string }> }
  expect(hitBody.meetings.map((m) => m.meeting_id)).toEqual(['m-e2e-exact-1'])
  expect(hitBody.meetings[0]!.host_user_id).toBe('ww-e2e-someone-else')

  const afterFirst = requestLog.filter((r) => r.signatureValid).map((r) => r.path)
  expect(afterFirst).toContain('/v1/corp/records')
  // `/v1/records` 在假服务那边是个会报错的陷阱，走上去这条断言之前就红了
  expect(afterFirst).not.toContain('/v1/records')
  const corpCallsAfterFirst = afterFirst.filter((p) => p === '/v1/corp/records').length

  // 第二次同样的点名查询：上一次的全窗口枚举已经把这一场写进 meeting_cache，
  // 这一次一个字节都不该再发给腾讯
  const againRes = await app(new Request('https://gw/api/v1/meetings?meeting_code=700120', { headers }))
  expect(againRes.status).toBe(200)
  const corpCallsAfterSecond = requestLog
    .filter((r) => r.signatureValid)
    .filter((r) => r.path === '/v1/corp/records').length
  expect(corpCallsAfterSecond).toBe(corpCallsAfterFirst)

  // 未命中：错误提示要能让人查下去，而不是只丢一句「没找到」
  const missRes = await app(new Request('https://gw/api/v1/meetings?meeting_code=700999', { headers }))
  expect(missRes.status).toBe(404)
  const missBody = (await missRes.json()) as { error: string; message: string }
  expect(missBody.error).toBe('meeting_not_found_in_range')
  expect(missBody.message).toContain('700999')
  expect(missBody.message).toContain('meeting_cache')
  expect(missBody.message).toContain('/v1/corp/records')
  // 「只看得到 operator 自己的会议」这条限制已经不存在了，提示里不许再说
  expect(missBody.message).not.toMatch(/operator/i)
})
