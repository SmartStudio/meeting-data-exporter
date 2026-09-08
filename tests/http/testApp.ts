/**
 * http/ 层的测试哲学（design doc §5.10）："端到端：假腾讯 API + 真网关"——
 * 只在 TencentClient（get/post）这一个边界上打桩，其余全部模块（store、
 * policy、audit、auth、sts、catalog）都是真实实现，连接真实的隔离测试数据库。
 */
import type { Pool } from '../../src/store/db'
import type { TencentClient, RequestOptions } from '../../src/tencent/client'
import type { QueryParams } from '../../src/tencent/url'
import type { WecomClient, WecomUser } from '../../src/auth/wecom'
import type { IdentityStrategy } from '../../src/config'
import type { RuleCond } from '../../src/policy/conds'

import { createGrantsStore } from '../../src/store/grants'
import { createPolicyStore } from '../../src/store/policy'
import { createAccessGate } from '../../src/policy/access'
import { createArchivesStore } from '../../src/store/archives'
import { createAuditStore } from '../../src/store/audit'
import { createAuditRecorder } from '../../src/audit/recorder'
import { createAuthStore } from '../../src/store/auth'
import { createDeviceFlow } from '../../src/auth/device'
import { createServiceAuth } from '../../src/auth/service'
import { createIdentityMapper } from '../../src/auth/identity'
import { createAdminStore } from '../../src/store/admin'
import { createAdminAuth } from '../../src/auth/admin'
import { createMeetingCacheStore } from '../../src/store/meetings'
import { createConsoleMeetingsStore } from '../../src/store/console-meetings'
import { createStsStore } from '../../src/store/sts'
import { createStsManager } from '../../src/sts/manager'
import { verifySignature, decryptEvent, decryptCheckStr } from '../../src/sts/crypto'
import { createRecordsApi } from '../../src/tencent/records'
import { createAddressesApi } from '../../src/tencent/addresses'
import { createSmartApi } from '../../src/tencent/smart'
import { createCatalog } from '../../src/catalog/index'
import { createApp, type AppDeps } from '../../src/http/router'
import { createLoginRateLimiter } from '../../src/http/ratelimit'
import { createProgramsStore } from '../../src/store/programs'
import { DEFAULT_FETCH_LOOKBACK_HOURS, createJobsStore } from '../../src/store/jobs'
import type { MeetingKey } from '../../src/store/grants'
import type { Meeting } from '../../src/domain/types'
import type { RowDataPacket } from 'mysql2/promise'
import { createConsoleStorageStore } from '../../src/store/console-storage'
import type { StorageDeps } from '../../src/http/handlers/console/storage'
import { createAuditMeetingLookup } from '../../src/http/handlers/console/audit'
import { createContentLookup } from '../../src/http/handlers/console/content'
import type { VisibilityDeps } from '../../src/worker/visibility'

export const JWT_SECRET = 'test-jwt-secret-32-bytes-minimum'
export const WEBHOOK_TOKEN = 'a'.repeat(25)
export const OPERATOR_ID = 'operator-1'

/**
 * 43 字符合法 EncodingAESKey：32 随机字节 base64 后恰好 44 字符（末尾 1 个 '='
 * padding），去掉该 padding 得 43 字符——与 decryptEvent 的还原方式对应
 * （复刻 tests/sts/crypto.test.ts 的 makeAesKey，webhook 测试需要用同一把
 * 密钥加密测试载荷，因此在这里固定导出，而不是每次随机生成）。
 */
export const WEBHOOK_AES_KEY = Buffer.alloc(32, 7).toString('base64').slice(0, -1)


export function stubTencentClient(handlers: {
  get?: (path: string, query: QueryParams, opts?: RequestOptions) => unknown
  post?: (path: string, body: object) => unknown
}): TencentClient {
  return {
    get: async <T,>(path: string, query: QueryParams, opts?: RequestOptions) =>
      (handlers.get?.(path, query, opts) ?? {}) as T,
    post: async <T,>(path: string, body: object) => (handlers.post?.(path, body) ?? {}) as T,
    currentQps: () => 5,
  }
}

export function stubWecomClient(exchangeCode: (code: string) => Promise<WecomUser>): WecomClient {
  return {
    buildAuthorizeUrl: (redirectUri, state) =>
      `https://wecom.example/authorize?state=${state}&redirect=${encodeURIComponent(redirectUri)}`,
    exchangeCode,
  }
}

export interface TestAppOptions {
  now?: () => number
  tencentGet?: (path: string, query: QueryParams, opts?: RequestOptions) => unknown
  tencentPost?: (path: string, body: object) => unknown
  wecomExchangeCode?: (code: string) => Promise<WecomUser>
  /** 置 true 模拟「本部署未配置企业微信」（config.wecom === null 的运行时形态） */
  wecomDisabled?: boolean
  identityStrategy?: IdentityStrategy
  jwtSecret?: string
}

export interface TestApp {
  app: (req: Request) => Promise<Response>
  deps: AppDeps
  pool: Pool
}

export function buildTestApp(pool: Pool, opts: TestAppOptions = {}): TestApp {
  const now = opts.now ?? (() => 1_700_000_000)
  const jwtSecret = opts.jwtSecret ?? JWT_SECRET

  const tencentClient = stubTencentClient({ get: opts.tencentGet, post: opts.tencentPost })
  // 顺序跟随 src/index.ts：meeting_cache 是精确查询的第一级，得先有它
  const meetingsCache = createMeetingCacheStore(pool)
  const recordsApi = createRecordsApi(tencentClient, OPERATOR_ID, meetingsCache)
  const addressesApi = createAddressesApi(tencentClient, OPERATOR_ID)
  // 与 addressesApi 同一口径：真实构造 + 同一个 stub client。桩里没登记 /v1/smart/*
  // 的用例会拿到空对象，getMinutes/getChapters 于是返回 null（「这一类不存在」）
  const smartApi = createSmartApi(tencentClient, OPERATOR_ID)

  const stsStore = createStsStore(pool)
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

  const policyStore = createPolicyStore(pool)
  // 会议查询 store（T1）。getMeetings 与规则页的影响预览用的是同一个实例，
  // 与 src/index.ts 逐字一致——测试里另建一份，等于让端到端测试验证的不是
  // 生产上真正跑的那段装配
  const consoleMeetings = createConsoleMeetingsStore(pool, { policy: policyStore })
  const grantsStore = createGrantsStore(pool)
  // 跟随 src/index.ts：判定要问 programsStore「这个程序还启用着吗」，
  // 用的是控制台改的那同一张表、同一个实例（阶段 5 · A8）
  const programsStore = createProgramsStore(pool)
  const accessGate = createAccessGate({
    store: policyStore,
    // 跟随 src/index.ts：同一个 store 按两个接口递进去，改写与授权分得开（阶段 6）
    overrides: grantsStore,
    grants: grantsStore,
    programs: { isProgramEnabled: async (id) => (await programsStore.find(id))?.enabled === true },
  })
  const archivesStore = createArchivesStore(pool)

  const auditStore = createAuditStore(pool)
  const auditRecorder = createAuditRecorder(auditStore, now)
  // 跟随 src/index.ts：一个实例给「定时任务页」与「归档存储页的失败数」两处用
  const jobsStore = createJobsStore(pool)

  const authStore = createAuthStore(pool)
  const deviceFlow = createDeviceFlow({ store: authStore, baseUrl: 'https://gw.example', ttlSec: 300 })
  const wecomClient = opts.wecomDisabled === true ? null : stubWecomClient(
    opts.wecomExchangeCode ?? (async () => ({ userId: 'ww-default', email: null })),
  )
  const identityMapper = createIdentityMapper(opts.identityStrategy ?? 'direct', {
    lookupTable: async (id) => (await authStore.lookupIdentityMap(id))?.tmUserId ?? null,
    lookupByEmail: async (email) => (await authStore.lookupIdentityByEmail(email))?.tmUserId ?? null,
  })
  const serviceAuth = createServiceAuth({ store: authStore })

  // 管理员会话与账号管理（Task 3，A1）——与上面企微/服务账号认证线完全独立，
  // 装配方式跟随 src/index.ts：真实 AdminStore/AdminAuth，接到同一个测试库
  const adminStore = createAdminStore(pool)
  const adminAuth = createAdminAuth({ store: adminStore })
  const gatewayBaseUrl = 'https://gw.example'

  // 控制台会议查询（阶段 4 · T5，A2）。装配方式跟随 src/index.ts：
  // meetingVisibility 与 worker 的采集清单重算共用同一组读法，两处不各判一遍
  const meetingVisibility: VisibilityDeps = {
    policy: policyStore,
    grants: createGrantsStore(pool),
    archives: archivesStore,
    getMeetings: (keys) => consoleMeetings.getMeetings(keys),
  }

  const deps: AppDeps = {
    now,
    jwtSecret,
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
    // 每个测试 app 一个独立桶（不跨测试共享），保持测试间隔离
    loginRateLimiter: createLoginRateLimiter(),
    trustedProxyHops: 1,
    adminAuth,
    adminStore,
    // 跟随 src/index.ts 同一条推导规则：gatewayBaseUrl 是 https 即为 true
    cookieSecure: new URL(gatewayBaseUrl).protocol === 'https:',
    // http 层测试不发页面；静态服务由 tests/http/static.test.ts 单独盯
    consoleStatic: null,
    // 阶段 4 · T7（A3 采集授权）：与上面几行同样是真实模块接到同一个测试库
    programs: programsStore,
    grantsStore,
    policyStore,
    archivesStore,
    auditStore,
    getMeetings: consoleMeetings.getMeetings,
    // 归档存储页（阶段 4 · T8）。这一层的端到端测试里没有真实 NAS 挂载点，
    // 所以探测固定回"不可达"、清理注入 null——两者都是 handler 显式处理的降级
    // 分支（页面显示 NAS 不可达 / 清理端点 503），不是能让别的用例静默出错的假实现。
    // 需要真跑这两条路径的用例在 tests/http/console-storage.test.ts 里注入自己的假件。
    storage: {
      nasRoot: null,
      probeNas: async () => ({
        reachable: false,
        checkedAt: now(),
        latencyMs: 0,
        totalBytes: null,
        availableBytes: null,
        error: '测试环境未挂载 NAS（tests/http/testApp.ts）',
      }),
      stats: createConsoleStorageStore(pool),
      archives: archivesStore,
      audit: auditStore,
      cleanup: null,
      // 跟随 src/index.ts：归档存储页的「归档失败 N 场」与定时任务页读的是
      // 同一张 job_failures、同一个实例（阶段 5 · A8）
      jobFailures: jobsStore,
    } satisfies StorageDeps,
    // 阶段 6 · 管理端媒体流。跟随 src/index.ts：**与 storage.nasRoot 是同一个值**。
    // 这里没有 NAS 挂载点，所以是 null——端点据此返回 503 nas_root_unset（一条
    // handler 的显式降级分支），而不是静默 404 让人以为是文件不见了。
    // 真要跑流式读的用例在 tests/http/console-media.test.ts 里注入自己的临时目录。
    media: { nasRoot: null },
    // 审计读侧（阶段 4 · A5）：与 auditRecorder 同源，装配方式跟随 src/index.ts
    auditQuery: auditStore,
    auditMeetings: createAuditMeetingLookup(pool),
    // 阶段 4 · T6（A3 规则 API）。跟随 src/index.ts：会议查询 store 与 getMeetings
    // 用同一个实例，注入的 policy 也是同一份
    consoleMeetings,
    meetingVisibility,
    meetingHistory: auditStore,
    // 归档失败的真原因（阶段 5 · D-4）。跟随 src/index.ts：与定时任务页、
    // 归档存储页读同一张 job_failures、同一个实例
    archiveFailures: jobsStore,
    // 内容预览（阶段 4 · T10）。装配方式跟随 src/index.ts：真实实现接同一个测试库
    contents: createContentLookup(pool),
    // 阶段 4 · T11（A4 定时任务）。跟随 src/index.ts：网关只装读侧与手动触发的
    // 排队，调度器不在这里（它属于 worker 进程）。时区固定 0（UTC），与测试里
    // 其它时间戳同口径
    jobs: {
      jobs: jobsStore,
      audit: auditStore,
      tzOffsetSec: 0,
      // 跟随 src/index.ts 的默认值：真实装配读的是 MDE_SCHEDULER_FETCH_LOOKBACK_HOURS，
      // 测试固定用同一个常量，需要非默认值的用例自己覆盖（见 console-jobs.test.ts）
      fetchLookbackHours: DEFAULT_FETCH_LOOKBACK_HOURS,
    },
  }

  return { app: createApp(deps), deps, pool }
}

/**
 * 往 `service_accounts` 插一个采集程序（阶段 5 · A8）。
 *
 * **一条 allow 规则不足以让判定放行**：AccessGate 在读规则之前先问
 * 「这个程序还启用着吗」，查不到或 `enabled = 0` 一律拒绝（spec §11 缺口 4：
 * 停用之后已签发、还没过期的访问令牌也必须失效）。所以凡是断言「取得到」的
 * 端到端用例，除了 `insertPolicyRule` 之外还要有这一行。
 *
 * `enabled: false` 就是「停用了的程序」，用来验证那条拒绝真的生效。
 * 凭据哈希填一个占位值：走这条路的用例都是自己签 JWT 的，不经过
 * `POST /auth/service-token`，那一列在这里不参与任何判定。
 */
export async function insertServiceProgram(
  pool: Pool,
  opts: { id: string; name?: string; tmUserId?: string; enabled?: boolean; expiresAt?: number | null },
): Promise<void> {
  await pool.execute(
    `INSERT INTO service_accounts (id, name, secret_hash, tm_userid, enabled, expires_at, created_at)
     VALUES (?, ?, 'not-a-real-hash-tests-sign-their-own-jwt', ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
    [
      opts.id,
      opts.name ?? opts.id,
      opts.tmUserId ?? `tm-${opts.id}`,
      opts.enabled === false ? 0 : 1,
      opts.expiresAt ?? null,
    ],
  )
}

/**
 * 往 meeting_grants 插一条逐会议授权（spec §1.3 三个「与」的**第一个**，阶段 6）。
 *
 * **一条 allow 规则不足以让网关放行**：`AccessGate` 在套完人工改写之后还要过一道
 * 授权行，没有授权的会议判成 `not_granted`（见 src/policy/grant.ts）。所以端到端
 * 用例造完规则还得造授权——两者分别由不同的人在不同的页面维护，测试里也就得分别造。
 *
 * `assetTypes` 三态与库里一致：`null` = 不额外限制（**默认**，绝大多数用例问的是
 * 规则怎么判）· 非空数组 = 白名单 · `[]` = 什么都不授权。**空数组不是不限制**，
 * 所以这里用 `undefined` 表示「不传」，不能拿 `?? []` 兜底。
 */
export async function insertGrant(
  pool: Pool,
  opts: {
    meetingId: string
    subMeetingId?: string
    programId: string
    assetTypes?: string[] | null
    grantedAt?: number
  },
): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_grants
       (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE asset_types = VALUES(asset_types)`,
    [
      opts.meetingId,
      opts.subMeetingId ?? '',
      opts.programId,
      opts.assetTypes === undefined || opts.assetTypes === null
        ? null
        : JSON.stringify(opts.assetTypes),
      opts.grantedAt ?? 0,
    ],
  )
}

/**
 * 往 policy_rules 插一条规则。**默认是 allow 栈**——网关只判第三栈，
 * 端到端测试造的规则九成九是它。
 *
 * `programId` 是主体（`service_accounts.id`），不是腾讯会议 userid：
 * 阶段 3 之后采集权限规则的主体是采集程序，不是人。要造一条主体写错的规则
 * （比如验证旧的 `subject_type='user'` 已经不生效），显式传 subjectType /
 * subjectValue 覆盖即可。
 *
 * `assetTypes` 用 `AssetKey` 词汇（`transcript` / `ai_transcript`），不是网关的
 * `asset_type`（`meeting_summary` / `ai_meeting_transcripts`）——两套词汇的换算在
 * `policy/access.ts`。
 */
export async function insertPolicyRule(
  pool: Pool,
  opts: {
    kind?: 'fetch' | 'archive' | 'allow'
    priority: number
    join?: 'and' | 'or'
    conds?: RuleCond[]
    /** allow 栈的主体：采集程序 id */
    programId?: string
    subjectType?: string
    subjectValue?: string
    assetTypes: string[]
    effect: string
    note?: string | null
    enabled?: number
  },
): Promise<void> {
  const kind = opts.kind ?? 'allow'
  const subjectType = opts.subjectType ?? (kind === 'allow' ? 'program' : '')
  const subjectValue = opts.subjectValue ?? opts.programId ?? ''
  await pool.execute(
    `INSERT INTO policy_rules
       (kind, priority, join_op, conds, subject_type, subject_value, asset_types, effect,
        note, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      kind,
      opts.priority,
      opts.join ?? 'and',
      JSON.stringify(opts.conds ?? []),
      subjectType,
      subjectValue,
      JSON.stringify(opts.assetTypes),
      opts.effect,
      opts.note ?? null,
      opts.enabled ?? 1,
    ],
  )
}
