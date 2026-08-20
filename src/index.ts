import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { loadConfig } from './config'
import { createPool, runMigrations } from './store/db'
import { createStsStore } from './store/sts'
import { createPolicyStore } from './store/policy'
import { createAuthStore } from './store/auth'
import { createAuditStore } from './store/audit'
import { createMeetingCacheStore } from './store/meetings'
import { createTencentClient } from './tencent/client'
import { createRecordsApi } from './tencent/records'
import { createAddressesApi } from './tencent/addresses'
import { createCatalog } from './catalog/index'
import { createStsManager } from './sts/manager'
import { verifySignature, decryptEvent, decryptCheckStr } from './sts/crypto'
import { createPolicyEngine } from './policy/engine'
import { createAuditRecorder } from './audit/recorder'
import { createDeviceFlow } from './auth/device'
import { createWecomClient } from './auth/wecom'
import { createIdentityMapper } from './auth/identity'
import { createServiceAuth } from './auth/service'
import { createApp, type AppDeps } from './http/router'
import { createLoginRateLimiter } from './http/ratelimit'

/** STS-Token 续期检查间隔：剩余有效期低于 1/3 时才会真正发起申请（见 sts/manager.ts） */
const STS_RENEW_CHECK_INTERVAL_MS = 5 * 60 * 1000

/**
 * STS-Token 落库前的对称加密。设计文档 §5.8 建议用阿里云 KMS 托管或等效的
 * 密文存储——本实现用一把【独立于 JWT_SECRET】的密钥（STS_ENC_KEY）派生
 * AES-256-GCM 密钥，使会话签名域与 STS 加密域互不牵连：任一密钥泄露不会同时
 * 危及另一域。生产部署前仍建议替换为真正的 KMS 密钥托管。
 */
function createTokenCipher(secret: string): { encrypt: (plain: string) => string; decrypt: (cipher: string) => string } {
  const key = createHash('sha256').update(secret).digest()

  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, tag, encrypted]).toString('base64')
    },
    decrypt(cipherText) {
      const buf = Buffer.from(cipherText, 'base64')
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(12, 28)
      const encrypted = buf.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    },
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const pool = createPool(config.databaseUrl)
  await runMigrations(pool)

  const now = (): number => Math.floor(Date.now() / 1000)

  const tencentClient = createTencentClient(config.tencent, {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now,
  })
  const recordsApi = createRecordsApi(tencentClient, config.tencent.operatorId)
  const addressesApi = createAddressesApi(tencentClient, config.tencent.operatorId)

  const stsStore = createStsStore(pool)
  const tokenCipher = createTokenCipher(config.stsEncKey)
  const stsManager = createStsManager({
    store: stsStore,
    client: tencentClient,
    operatorId: config.tencent.operatorId,
    webhookToken: config.webhook.token,
    aesKey: config.webhook.aesKey,
    encrypt: tokenCipher.encrypt,
    decrypt: tokenCipher.decrypt,
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
  const deviceFlow = createDeviceFlow({ store: authStore, baseUrl: config.gatewayBaseUrl })
  const wecomClient = createWecomClient(config.wecom, { fetch, now })
  const identityMapper = createIdentityMapper(config.identityStrategy, {
    lookupTable: async (wecomUserId) => (await authStore.lookupIdentityMap(wecomUserId))?.tmUserId ?? null,
    lookupByEmail: async (email) => (await authStore.lookupIdentityByEmail(email))?.tmUserId ?? null,
  })
  const serviceAuth = createServiceAuth({ store: authStore })
  const meetingsCache = createMeetingCacheStore(pool)
  const loginRateLimiter = createLoginRateLimiter()

  const deps: AppDeps = {
    now,
    jwtSecret: config.jwtSecret,
    gatewayBaseUrl: config.gatewayBaseUrl,
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
    loginRateLimiter,
    trustedProxyHops: config.trustedProxyHops,
  }

  const app = createApp(deps)
  const port = Number(process.env.PORT ?? 3000)
  const server = Bun.serve({ port, fetch: app })
  console.log(`meeting-export-gateway listening on :${server.port}`)

  // 回调是异步的——不能等到过期才申请（design doc §5.3）。启动时先跑一次，
  // 随后每 5 分钟检查一次剩余有效期，真正发起续期申请的频率由 ensureFresh
  // 内部的 1/3 阈值判断决定，这里只负责定期"问一下要不要续"。
  const renewLoop = (): void => {
    const t = now()
    stsManager.ensureFresh(t).catch((err: unknown) => {
      console.error('sts ensureFresh failed', err)
    })
    // 看门狗另一半：清理超时未回调的 pending，防止其无界增长
    stsManager.pruneStale(t).catch((err: unknown) => {
      console.error('sts pruneStale failed', err)
    })
  }
  renewLoop()
  setInterval(renewLoop, STS_RENEW_CHECK_INTERVAL_MS)
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err)
  process.exit(1)
})
