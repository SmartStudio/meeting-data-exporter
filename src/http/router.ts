import type { AuthStore } from '../store/auth'
import type { MeetingCacheStore } from '../store/meetings'
import type { RecordsApi } from '../tencent/records'
import type { Catalog } from '../catalog/index'
import type { StsManager } from '../sts/manager'
import type { PolicyEngine } from '../policy/engine'
import type { AuditRecorder } from '../audit/recorder'
import type { DeviceFlow } from '../auth/device'
import type { WecomClient } from '../auth/wecom'
import type { IdentityMapper } from '../auth/identity'
import type { ServiceAuth } from '../auth/service'
import { internalError, json } from './respond'
import * as authHandlers from './handlers/auth'
import * as meetingsHandlers from './handlers/meetings'
import * as webhookHandlers from './handlers/webhook'
import { createRateLimiter } from './ratelimit'

/**
 * 聚合全部前置任务的模块实例，供路由层组装。测试用 stub 注入，
 * src/index.ts 用真实模块装配——两者共用同一份类型契约。
 */
export interface AppDeps {
  now: () => number
  jwtSecret: string
  gatewayBaseUrl: string
  recordsApi: RecordsApi
  catalog: Catalog
  policyEngine: PolicyEngine
  auditRecorder: AuditRecorder
  deviceFlow: DeviceFlow
  wecomClient: WecomClient
  identityMapper: IdentityMapper
  serviceAuth: ServiceAuth
  authStore: AuthStore
  stsManager: StsManager
  meetingsCache: MeetingCacheStore
}

export interface RouteCtx {
  params: Record<string, string>
  deps: AppDeps
}

type Handler = (req: Request, ctx: RouteCtx) => Promise<Response>

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

/** `:param` 段编译为具名捕获组；`[^/]+` 保证不会跨段匹配，路由间天然无歧义 */
function compile(method: string, path: string, handler: Handler): Route {
  const keys: string[] = []
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1))
        return '([^/]+)'
      }
      return segment
    })
    .join('/')
  return { method, pattern: new RegExp(`^${pattern}$`), keys, handler }
}

const ROUTES: Route[] = [
  compile('POST', '/api/v1/auth/device/code', authHandlers.deviceCode),
  compile('POST', '/api/v1/auth/device/token', authHandlers.deviceToken),
  compile('GET', '/auth/wecom/callback', authHandlers.wecomCallback),
  compile('POST', '/api/v1/auth/refresh', authHandlers.refresh),
  compile('POST', '/api/v1/auth/service-token', authHandlers.serviceToken),
  compile('POST', '/api/v1/auth/logout', authHandlers.logout),

  compile('GET', '/api/v1/meetings', meetingsHandlers.listMeetings),
  compile('GET', '/api/v1/meetings/:meetingId', meetingsHandlers.getMeeting),
  compile('GET', '/api/v1/meetings/:meetingId/assets', meetingsHandlers.listAssets),
  compile('POST', '/api/v1/assets/:assetId/download-url', meetingsHandlers.downloadUrl),

  compile('POST', '/webhook/tencent-meeting', webhookHandlers.handleWebhook),

  compile('GET', '/healthz', async () => json(200, { status: 'ok' })),
]

/**
 * 登录端点限流参数。capacity=20 允许合理突发（设备端每 5 秒轮询一次远低于此），
 * refillPerSec=1 把单 IP 单端点的稳态速率压到 60 次/分钟——足以让穷举/试探在
 * argon2 校验成本之上再叠一层节流。数值是保守默认，可按上线观测调整。
 */
const LOGIN_BURST = 20
const LOGIN_REFILL_PER_SEC = 1

/** 仅对写型登录端点限流（webhook 是腾讯侧调用、GET /device 是浏览器页，均不在此列） */
const RATE_LIMITED = new Set([
  'POST /api/v1/auth/device/code',
  'POST /api/v1/auth/device/token',
  'POST /api/v1/auth/service-token',
  'POST /api/v1/auth/refresh',
])

/** 取客户端 IP：网关部署在可信代理后方，真实 IP 在 x-forwarded-for 首段 */
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  // 限流器随 app 实例存活整个进程周期；用 deps.now 便于测试注入可控时钟
  const loginLimiter = createRateLimiter({ capacity: LOGIN_BURST, refillPerSec: LOGIN_REFILL_PER_SEC })

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // 限流在路由派发之前：按「方法+路径」精确匹配（这些端点无路径参数），
    // key 含 pathname，使每个端点对每个 IP 有独立的桶。
    if (RATE_LIMITED.has(`${req.method} ${url.pathname}`)) {
      if (!loginLimiter.allow(`${url.pathname}|${clientIp(req)}`, deps.now())) {
        return json(429, { error: 'rate_limited' })
      }
    }

    for (const route of ROUTES) {
      if (route.method !== req.method) continue
      const match = route.pattern.exec(url.pathname)
      if (!match) continue

      const params: Record<string, string> = {}
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? '')
      })

      try {
        return await route.handler(req, { params, deps })
      } catch (err) {
        return internalError(err)
      }
    }

    return json(404, { error: 'not_found' })
  }
}
