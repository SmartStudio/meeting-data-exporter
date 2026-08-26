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
import { createStsStore } from '../../src/store/sts'
import { createStsManager } from '../../src/sts/manager'
import { verifySignature, decryptEvent, decryptCheckStr } from '../../src/sts/crypto'
import { createRecordsApi } from '../../src/tencent/records'
import { createAddressesApi } from '../../src/tencent/addresses'
import { createCatalog } from '../../src/catalog/index'
import { createApp, type AppDeps } from '../../src/http/router'
import { createLoginRateLimiter } from '../../src/http/ratelimit'
import { createAuditMeetingLookup } from '../../src/http/handlers/console/audit'

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
  const recordsApi = createRecordsApi(tencentClient, OPERATOR_ID)
  const addressesApi = createAddressesApi(tencentClient, OPERATOR_ID)

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

  const catalog = createCatalog({ addressesApi, stsManager, now })

  const policyStore = createPolicyStore(pool)
  const accessGate = createAccessGate({ store: policyStore, grants: createGrantsStore(pool) })
  const archivesStore = createArchivesStore(pool)

  const auditStore = createAuditStore(pool)
  const auditRecorder = createAuditRecorder(auditStore, now)

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
  const meetingsCache = createMeetingCacheStore(pool)

  // 管理员会话与账号管理（Task 3，A1）——与上面企微/服务账号认证线完全独立，
  // 装配方式跟随 src/index.ts：真实 AdminStore/AdminAuth，接到同一个测试库
  const adminStore = createAdminStore(pool)
  const adminAuth = createAdminAuth({ store: adminStore })
  const gatewayBaseUrl = 'https://gw.example'

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
    // 审计读侧（阶段 4 · A5）：与 auditRecorder 同源，装配方式跟随 src/index.ts
    auditQuery: auditStore,
    auditMeetings: createAuditMeetingLookup(pool),
  }

  return { app: createApp(deps), deps, pool }
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
