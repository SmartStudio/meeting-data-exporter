/**
 * 端到端测试（design doc §5.10）：真网关 + 真库 + 真盘。
 *
 * 采集程序走的整条链路（登录 → 列会议 → 取资产 → 换下载地址 → 取字节）
 * 现在只碰网关自己的库与归档目录，一次腾讯都不调（spec 2026-09-20 §2）。
 * 所以这里没有假腾讯服务：会议由 `seedMeeting` 写进 `meeting_cache`（调度器
 * 每轮写透的就是这张表），资产由 `seedCompletedAsset` 标成 `completed` 并在
 * 临时目录放真实文件。除此之外全部走真实实现：真实 HTTP 路由
 * （src/http/router.ts）、真实 store、真实 MySQL（withTestDb）、真实策略引擎、
 * 真实审计、真实的下载令牌签发与文件直出。唯一的桩是企业微信 exchangeCode。
 *
 * 与 tests/http/*.test.ts 的区别：那里自己签 JWT；这里令牌都是从
 * `POST /api/v1/auth/service-token` / 设备授权流程真换出来的。
 *
 * 腾讯签名那一层（src/tencent/signer.ts）与假腾讯服务只剩最后一条用例在用，
 * 它验的是调度器那条活路的 client，与网关无关。
 */
import { afterEach, beforeAll, afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import type { WecomUser } from '../../src/auth/wecom'
import type { IdentityStrategy } from '../../src/config'
import { withTestDb } from '../helpers/testdb'
import {
  JWT_SECRET,
  OPERATOR_ID,
  stubWecomClient,
  insertPolicyRule,
  seedCompletedAsset,
  seedMeeting,
  writeArchiveFile,
} from '../http/testApp'
import { createTencentClient } from '../../src/tencent/client'
import { TencentApiError } from '../../src/tencent/errors'
import { createStoredRecordsApi } from '../../src/store/stored-records'
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
import { createMysqlStore } from '../../src/worker/store-mysql'
import { startFakeTencentServer, createFakeTencentState } from '../fake-tencent/server'

let pool: Pool
let cleanup: () => Promise<void>
let archiveRoot: string

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
  archiveRoot = mkdtempSync(join(tmpdir(), 'mde-e2e-archive-'))
})
afterAll(async () => {
  await cleanup()
  rmSync(archiveRoot, { recursive: true, force: true })
})

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
}

/**
 * 装配一个真网关实例：与 src/index.ts 使用完全相同的装配方式（同一套 create*
 * 工厂函数），区别只有 wecomClient 用 stub（企微不在本任务范围）、归档根指向
 * 本文件的临时目录。
 */
function buildE2eApp(dbPool: Pool, opts: E2eAppOptions = {}): E2eApp {
  const now = opts.now ?? (() => NOW)

  const meetingsCache = createMeetingCacheStore(dbPool)
  const recordsApi = createStoredRecordsApi(meetingsCache)

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
    localArchiveRoot: archiveRoot,
    nasRoot: null,
    accessGate,
    archives: archivesStore,
    auditRecorder,
    deviceFlow,
    wecomClient,
    identityMapper,
    serviceAuth,
    authStore,
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
      // 失败项动作的写侧，跟随 src/index.ts：真实 Store 接同一个 e2e 库
      assets: createMysqlStore(dbPool),
      tzOffsetSec: 0,
      fetchLookbackHours: DEFAULT_FETCH_LOOKBACK_HOURS,
    },
  }

  return { app: createApp(deps), deps }
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

function downloadUrlRequest(assetId: string, headers: Record<string, string>): Request {
  return new Request(`https://gw/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, {
    method: 'POST',
    headers,
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

/**
 * 三个「与」的第一个：把一场会议授权给这个采集程序（阶段 6，spec §1.3）。
 *
 * **一条 allow 规则不足以让网关放行**——`AccessGate` 在套完人工改写之后还要过一道
 * 授权行，没有授权的会议判成 `not_granted`（见 src/policy/grant.ts）。所以本文件里
 * 凡是断言「取得到」的链路，除了造规则还要造授权。
 *
 * 走真实的 `GrantsStore.grant`（控制台按下「授权」时跑的就是这一段），
 * 不往表里塞 SQL——本文件的规矩是「真网关」，写侧同样要是真的。
 *
 * `assetTypes: null` = 不额外限制资产范围，判定完全由规则那一栈说了算。
 */
async function grantMeeting(
  meetingId: string,
  programId: string,
  subMeetingId: string,
): Promise<void> {
  await createGrantsStore(pool).grant({
    meetingId,
    // 场次 id = record id（spec §2.1）。授权挂在**场次**上，挂在空串上等于挂在一场
    // 不存在的会议上——判定会安静地变成「没有授权」
    subMeetingId,
    programId,
    assetTypes: null,
    now: NOW * 1000,
  })
}

test('完整流程：采集程序登录 → 列会议 → 取资产 → 换下载地址 → 从网关取回字节', async () => {
  const clock = stepClock(NOW)
  const meetingRecordId = 'rec-e2e-full-1'
  const meetingId = 'm-e2e-full-1'
  const fileId = 'file-e2e-full-1'

  const { app } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-full-1', email: null }),
  })

  await seedMeeting(pool, {
    meetingRecordId, meetingId, meetingCode: '700001',
    hostUserId: 'ww-e2e-full-1', // identity strategy 'direct' ⇒ tmUserId === wecomUserId
    startTime: NOW, subject: '端到端全流程验证会议',
  })
  const videoBytes = 'e2e-video-bytes-0123456789'
  const minutesText = '## 会议摘要\n\n正文\n'
  writeArchiveFile(archiveRoot, 'full/video.mp4', videoBytes)
  writeArchiveFile(archiveRoot, 'full/audio.m4a', 'e2e-audio')
  writeArchiveFile(archiveRoot, 'full/minutes.md', minutesText)
  for (const [assetType, fileType, targetPath] of [
    ['video', 'mp4', 'full/video.mp4'],
    ['audio', 'm4a', 'full/audio.m4a'],
    ['ai_minutes', 'md', 'full/minutes.md'],
  ] as const) {
    await seedCompletedAsset(pool, { meetingId, subMeetingId: meetingRecordId, assetType, remoteId: fileId, fileType, targetPath })
  }

  await insertPolicyRule(pool, {
    priority: 10,
    programId: 'prog-e2e-full-1',
    assetTypes: ['*'],
    effect: 'allow',
    note: '放行 e2e 全流程采集程序',
  })
  await grantMeeting(meetingId, 'prog-e2e-full-1', meetingRecordId)

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
    .toEqual(['ai_minutes', 'audio', 'video'])

  const videoAsset = assetsBody.assets.find((a) => a.asset_type === 'video')!
  const minutesAsset = assetsBody.assets.find((a) => a.asset_type === 'ai_minutes')!

  // 4. 换下载地址：两类都指回网关自己的 content 端点，15 分钟时效
  const videoDl = await app(downloadUrlRequest(videoAsset.asset_id, headers))
  expect(videoDl.status).toBe(200)
  const videoDlBody = (await videoDl.json()) as { url: string; expires_at: number }
  expect(videoDlBody.url.startsWith('https://gw.e2e.example/api/v1/assets/')).toBe(true)
  expect(videoDlBody.expires_at - clock.now()).toBe(900)

  const minutesDl = await app(downloadUrlRequest(minutesAsset.asset_id, headers))
  expect(minutesDl.status).toBe(200)
  const minutesDlBody = (await minutesDl.json()) as { url: string }

  // 5. 引擎的下载器拿这条 URL 直接取：不带 Bearer，带 Range 续传
  const videoRes = await app(new Request(videoDlBody.url))
  expect(videoRes.status).toBe(200)
  expect(await videoRes.text()).toBe(videoBytes)

  const resumed = await app(new Request(videoDlBody.url, { headers: { range: 'bytes=16-' } }))
  expect(resumed.status).toBe(206)
  expect(resumed.headers.get('content-range')).toBe(`bytes 16-${videoBytes.length - 1}/${videoBytes.length}`)
  expect(await resumed.text()).toBe(videoBytes.slice(16))

  expect(await (await app(new Request(minutesDlBody.url))).text()).toBe(minutesText)

  // 审计留痕：两次下载地址签发都记为 allow
  const [auditRows] = await pool.execute<RowDataPacket[]>(
    "SELECT decision FROM audit_log WHERE action = 'issue_download_url' AND meeting_id = ?",
    [meetingRecordId],
  )
  expect(auditRows).toHaveLength(2)
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

  const { app } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-person-1', email: null }),
  })

  await seedMeeting(pool, {
    meetingRecordId, meetingId, meetingCode: '700005', hostUserId: 'ww-e2e-person-1',
    startTime: NOW, subject: '企微用户看不到的会议',
  })
  const assetId = await seedCompletedAsset(pool, {
    meetingId, subMeetingId: meetingRecordId, assetType: 'video', remoteId: fileId, targetPath: 'person/video.mp4',
  })

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

  // 会议在库里，所以下面这个 assetId 走的是「命中 + 判定为拒绝」那条路径，不是「查不到」。
  const dlRes = await app(downloadUrlRequest(assetId, headers))
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

  const { app } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-deny-1', email: null }),
  })

  await seedMeeting(pool, {
    meetingRecordId, meetingId, meetingCode: '700002', hostUserId: 'ww-e2e-deny-1',
    startTime: NOW, subject: '仅放行 video 的会议',
  })
  await seedCompletedAsset(pool, {
    meetingId, subMeetingId: meetingRecordId, assetType: 'video', remoteId: fileId, targetPath: 'deny/video.mp4',
  })
  const audioAssetId = await seedCompletedAsset(pool, {
    meetingId, subMeetingId: meetingRecordId, assetType: 'audio', remoteId: fileId, fileType: 'm4a', targetPath: 'deny/audio.m4a',
  })

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
  await grantMeeting(meetingId, 'prog-e2e-deny-1', meetingRecordId)

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
  const videoDl = await app(downloadUrlRequest(videoAssetId, headers))
  expect(videoDl.status).toBe(200)

  // audio：清单里已经看不到，但客户端仍可能持有一份旧清单缓存并据此构造出这个
  // assetId——download-url 端点必须独立重新判定策略（而不是信任清单已经把关过），
  // 在这里被拦截。
  const audioDl = await app(downloadUrlRequest(audioAssetId, headers))
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

  const { app } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-ovr-1', email: null }),
  })

  await seedMeeting(pool, {
    meetingRecordId, meetingId, meetingCode: '700009', hostUserId: 'ww-e2e-ovr-1',
    startTime: NOW, subject: '法务要求不外发的会议',
  })
  await seedCompletedAsset(pool, {
    meetingId, subMeetingId: meetingRecordId, assetType: 'video', remoteId: fileId, targetPath: 'ovr/video.mp4',
  })

  // 规则本身是放行的——本用例要证明的正是「规则说可以，改写说不行，以改写为准」
  await insertPolicyRule(pool, {
    priority: 10,
    programId: 'prog-e2e-ovr-1',
    assetTypes: ['*'],
    effect: 'allow',
    note: '全部放行',
  })
  // 授权也给上：这条用例要证明的是「改写压过规则」，不能让「没授权」抢在前面
  await grantMeeting(meetingId, 'prog-e2e-ovr-1', meetingRecordId)

  const { access_token } = await serviceLogin(app, 'prog-e2e-ovr-1', 'ww-e2e-ovr-1')
  const headers = { Authorization: `Bearer ${access_token}` }

  // ① 没有改写时：列得出、取得到
  const before = await app(new Request('https://gw/api/v1/meetings?meeting_code=700009', { headers }))
  expect(((await before.json()) as { meetings: unknown[] }).meetings).toHaveLength(1)

  const assetsRes = await app(new Request(`https://gw/api/v1/meetings/${meetingId}/assets`, { headers }))
  const assetsBody = (await assetsRes.json()) as { assets: Array<{ asset_id: string }> }
  const assetId = assetsBody.assets[0]!.asset_id

  const okDl = await app(downloadUrlRequest(assetId, headers))
  expect(okDl.status).toBe(200)

  // ② 管理员按下「这场不许取」。改写优先于所有规则（spec §5.4），而且必须在
  //    **数据出境的那道闸门**上生效——只在采集清单里生效的话，它就不是一条
  //    安全规则，只是一个展示效果
  await createGrantsStore(pool).putOverride({
    meetingId,
    subMeetingId: meetingRecordId,
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
  const deniedDl = await app(downloadUrlRequest(assetId, headers))
  expect(deniedDl.status).toBe(403)
  expect((await deniedDl.json()).error).toBe('forbidden')

  // ⑤ 撤销改写后回落到规则判定
  await createGrantsStore(pool).revokeOverride(meetingId, meetingRecordId, 'allow', NOW * 1000 + 1)
  const restoredDl = await app(downloadUrlRequest(assetId, headers))
  expect(restoredDl.status).toBe(200)
})

test('会议号命中多场时列出候选', async () => {
  const clock = stepClock(NOW)
  const meetingCode = '700004'

  const { app } = buildE2eApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-e2e-multi-1', email: null }),
  })

  await seedMeeting(pool, {
    meetingRecordId: 'rec-e2e-multi-1', meetingId: 'm-e2e-multi-1', meetingCode, hostUserId: 'ww-e2e-multi-1',
    startTime: NOW, subject: '周期会议第一次',
  })
  await seedMeeting(pool, {
    meetingRecordId: 'rec-e2e-multi-2', meetingId: 'm-e2e-multi-2', meetingCode, hostUserId: 'ww-e2e-multi-1',
    // 查询窗口的右边界是请求发生时的 now，不能晚于它——用早于 NOW 的时间点
    // 才稳妥地落在 [now - 31天, now] 窗口内。
    startTime: NOW - 3600, subject: '周期会议第二次',
  })

  await insertPolicyRule(pool, {
    priority: 10,
    programId: 'prog-e2e-multi-1',
    assetTypes: ['*'],
    effect: 'allow',
  })
  await grantMeeting('m-e2e-multi-1', 'prog-e2e-multi-1', 'rec-e2e-multi-1')
  await grantMeeting('m-e2e-multi-2', 'prog-e2e-multi-1', 'rec-e2e-multi-2')

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

test('假腾讯服务对签名不匹配的请求返回 9042，调度器用的 client 判定为致命错误并立即失败（不重试）', async () => {
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
