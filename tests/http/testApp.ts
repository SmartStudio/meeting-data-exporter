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

import { createPolicyStore } from '../../src/store/policy'
import { createPolicyEngine } from '../../src/policy/engine'
import { createAuditStore } from '../../src/store/audit'
import { createAuditRecorder } from '../../src/audit/recorder'
import { createAuthStore } from '../../src/store/auth'
import { createDeviceFlow } from '../../src/auth/device'
import { createServiceAuth } from '../../src/auth/service'
import { createIdentityMapper } from '../../src/auth/identity'
import { createMeetingCacheStore } from '../../src/store/meetings'
import { createStsStore } from '../../src/store/sts'
import { createStsManager } from '../../src/sts/manager'
import { verifySignature, decryptEvent, decryptCheckStr } from '../../src/sts/crypto'
import { createRecordsApi } from '../../src/tencent/records'
import { createAddressesApi } from '../../src/tencent/addresses'
import { createCatalog } from '../../src/catalog/index'
import { createApp, type AppDeps } from '../../src/http/router'
import { createLoginRateLimiter } from '../../src/http/ratelimit'

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
  const policyEngine = createPolicyEngine(policyStore)

  const auditStore = createAuditStore(pool)
  const auditRecorder = createAuditRecorder(auditStore, now)

  const authStore = createAuthStore(pool)
  const deviceFlow = createDeviceFlow({ store: authStore, baseUrl: 'https://gw.example', ttlSec: 300 })
  const wecomClient = stubWecomClient(
    opts.wecomExchangeCode ?? (async () => ({ userId: 'ww-default', email: null })),
  )
  const identityMapper = createIdentityMapper(opts.identityStrategy ?? 'direct', {
    lookupTable: async (id) => (await authStore.lookupIdentityMap(id))?.tmUserId ?? null,
    lookupByEmail: async (email) => (await authStore.lookupIdentityByEmail(email))?.tmUserId ?? null,
  })
  const serviceAuth = createServiceAuth({ store: authStore })
  const meetingsCache = createMeetingCacheStore(pool)

  const deps: AppDeps = {
    now,
    jwtSecret,
    gatewayBaseUrl: 'https://gw.example',
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
    // 每个测试 app 一个独立桶（不跨测试共享），保持测试间隔离
    loginRateLimiter: createLoginRateLimiter(),
    trustedProxyHops: 1,
  }

  return { app: createApp(deps), deps, pool }
}

export async function insertPolicyRule(
  pool: Pool,
  opts: {
    priority: number
    subjectType: string
    subjectValue: string
    resourceExpr: Record<string, unknown>
    assetTypes: string[]
    effect: string
    enabled?: number
  },
): Promise<void> {
  await pool.execute(
    `INSERT INTO policy_rules
       (priority, subject_type, subject_value, resource_expr, asset_types, effect, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      opts.priority,
      opts.subjectType,
      opts.subjectValue,
      JSON.stringify(opts.resourceExpr),
      JSON.stringify(opts.assetTypes),
      opts.effect,
      opts.enabled ?? 1,
    ],
  )
}
