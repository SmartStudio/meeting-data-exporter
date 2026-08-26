import { loadConfig } from './config'
import { createPool, runMigrations } from './store/db'
import { createStsStore } from './store/sts'
import { createGrantsStore } from './store/grants'
import { createPolicyStore } from './store/policy'
import { createAuthStore } from './store/auth'
import { createAdminStore } from './store/admin'
import { createAuditStore } from './store/audit'
import { createMeetingCacheStore } from './store/meetings'
import { createTencentClient } from './tencent/client'
import { createRecordsApi } from './tencent/records'
import { createAddressesApi } from './tencent/addresses'
import { createCatalog } from './catalog/index'
import { createStsManager } from './sts/manager'
import { createTokenCipher } from './sts/cipher'
import { verifySignature, decryptEvent, decryptCheckStr } from './sts/crypto'
import { createAccessGate } from './policy/access'
import { createArchivesStore } from './store/archives'
import { createAuditRecorder } from './audit/recorder'
import { createDeviceFlow } from './auth/device'
import { createWecomClient } from './auth/wecom'
import { createIdentityMapper } from './auth/identity'
import { createServiceAuth } from './auth/service'
import { createAdminAuth } from './auth/admin'
import { createApp, type AppDeps } from './http/router'
import { createLoginRateLimiter } from './http/ratelimit'
import { createConsoleMeetingsStore } from './store/console-meetings'
import type { VisibilityDeps } from './worker/visibility'

/** STS-Token 续期检查间隔：剩余有效期低于 1/3 时才会真正发起申请（见 sts/manager.ts） */
const STS_RENEW_CHECK_INTERVAL_MS = 5 * 60 * 1000

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const pool = createPool(config.databaseUrl)
  await runMigrations(pool)

  const now = (): number => Math.floor(Date.now() / 1000)

  const tencentClient = createTencentClient(config.tencent, {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // 毫秒时钟：项目里通用的 now() 是秒级，喂给令牌桶会让补充速率慢 1000 倍
    nowMs: Date.now,
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
  // 网关这边只读改写，不写。写侧在控制台的管理端点里（阶段 4）
  const grantsStore = createGrantsStore(pool)
  const accessGate = createAccessGate({ store: policyStore, grants: grantsStore })
  // 网关只用它读「这场会议归档了没有」（规则的 arch 条件）——归档流水线的写侧
  // 在 worker 进程里，两边共用同一份 store 定义，不各写一遍 SQL
  const archivesStore = createArchivesStore(pool)

  const auditStore = createAuditStore(pool)
  const auditRecorder = createAuditRecorder(auditStore, now)

  const authStore = createAuthStore(pool)
  const deviceFlow = createDeviceFlow({ store: authStore, baseUrl: config.gatewayBaseUrl })
  // 企微未配置 = 本次部署不启用扫码登录（合法形态），设备授权流程整体返回 501
  const wecomClient = config.wecom === null ? null : createWecomClient(config.wecom, { fetch, now })
  if (wecomClient === null) {
    console.warn('[startup] WeCom 未配置：设备授权流程（扫码登录）已停用，客户端请使用服务账号认证')
  }
  const identityMapper = createIdentityMapper(config.identityStrategy, {
    lookupTable: async (wecomUserId) => (await authStore.lookupIdentityMap(wecomUserId))?.tmUserId ?? null,
    lookupByEmail: async (email) => (await authStore.lookupIdentityByEmail(email))?.tmUserId ?? null,
  })
  const serviceAuth = createServiceAuth({ store: authStore })
  const meetingsCache = createMeetingCacheStore(pool)
  const loginRateLimiter = createLoginRateLimiter()

  // 管理员会话与账号管理（Task 3，A1）——与企微/服务账号认证完全独立的第三条认证线，
  // 不共用 authStore/上面任何一张登录相关表（见 migrations/003_console_stage2.sql 的注释）
  const adminStore = createAdminStore(pool)
  const adminAuth = createAdminAuth({ store: adminStore })
  // cookie 的 Secure 属性：本仓库目前没有任何「是否生产环境」的既有判断机制
  // （既无 NODE_ENV 读取，也无 config.ts 里的同类字段），因此不引入 NODE_ENV
  // 这第一套判断逻辑，而是复用已经校验过的 config.gatewayBaseUrl——它就是本次
  // 部署对外可见的地址，协议是 https 即视为可以安全下发 Secure cookie。
  // 本地 http 开发环境 gatewayBaseUrl 一般是 http://localhost:3000 之类，此时
  // cookieSecure=false，避免"浏览器悄悄丢弃 cookie"这种排查成本极高的静默失败
  // （见 http/handlers/console/auth.ts 的 cookieAttrs 注释）。
  const cookieSecure = new URL(config.gatewayBaseUrl).protocol === 'https:'

  // 控制台的会议查询（阶段 4 · T5，A2）。
  // meetingVisibility 的四件依赖与 worker 的采集清单重算（computeProgramInventory）
  // 是**同一组**——控制台答「这场会议准不准采集」和网关真去取时的判定必须同源，
  // 各判一遍的下场是「详情抽屉说准许、程序取的时候被拒」。
  // getMeetings 直接接 ConsoleMeetingsStore：签名与语义（含「查不到不造空壳」）都对得上。
  const consoleMeetings = createConsoleMeetingsStore(pool, { policy: policyStore })
  const meetingVisibility: VisibilityDeps = {
    policy: policyStore,
    grants: grantsStore,
    archives: archivesStore,
    getMeetings: (keys) => consoleMeetings.getMeetings(keys),
  }

  const deps: AppDeps = {
    now,
    jwtSecret: config.jwtSecret,
    gatewayBaseUrl: config.gatewayBaseUrl,
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
    loginRateLimiter,
    trustedProxyHops: config.trustedProxyHops,
    adminAuth,
    adminStore,
    cookieSecure,
    consoleMeetings,
    meetingVisibility,
    meetingHistory: auditStore,
  }

  const app = createApp(deps)
  // PORT / HOST 走 process.env 而非 loadConfig：它们是进程编排参数（由 systemd /
  // 容器 / 反向代理决定），不是业务配置。HOST 用于把监听面收窄到内网地址——
  // 例如只让同机的反向代理访问时填其网桥地址，避免服务直接暴露在公网。
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer in 1..65535, got: ${process.env.PORT}`)
  }
  const hostname = process.env.HOST || '0.0.0.0'
  const server = Bun.serve({ port, hostname, fetch: app })
  console.log(`meeting-export-gateway listening on ${hostname}:${server.port}`)

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
