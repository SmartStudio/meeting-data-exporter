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
import type { RateLimiter } from './ratelimit'

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
  /** 登录端点限流器（IP 维度 + handler 内的账号维度共用同一个实例，见 ratelimit.ts） */
  loginRateLimiter: RateLimiter
  /** 网关前方会追加 X-Forwarded-For 的可信代理层数，决定 clientIp 取右数第几段 */
  trustedProxyHops: number
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

/** 仅对写型登录端点限流（webhook 是腾讯侧调用、GET /device 是浏览器页，均不在此列） */
const RATE_LIMITED = new Set([
  'POST /api/v1/auth/device/code',
  'POST /api/v1/auth/device/token',
  'POST /api/v1/auth/service-token',
  'POST /api/v1/auth/refresh',
])

/**
 * 取客户端 IP 用于限流。XFF 由每跳代理在末尾追加，越靠右越可信——最左段是
 * 客户端自填、可伪造的值，绝不能取首段（否则换个请求头即可绕过限流）。
 * 取右数第 trustedHops 段：trustedHops = 网关前方会追加 XFF 的可信代理层数
 * （默认 1，单层反向代理）。链条比预期短时回退到最左端已知值。
 */
function clientIp(req: Request, trustedHops: number): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (parts.length > 0) {
      // 纵深防御：即便 loadConfig 已校验 trustedHops 为正整数，这里仍不用 `!`
      // 强行断言——任何残留路径算出空下标时，回退到 x-real-ip/'unknown'，
      // 避免产生 undefined 限流 key（会把不同客户端合并进同一个桶）。
      const seg = parts[Math.max(0, parts.length - trustedHops)]
      if (seg) return seg
    }
  }
  return req.headers.get('x-real-ip') ?? 'unknown'
}

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // 限流在路由派发之前：按「方法+路径」精确匹配（这些端点无路径参数），
    // key 含 pathname 与 ip: 命名空间前缀，使每个端点对每个 IP 有独立的桶，
    // 且不会与 handler 内的账号维度桶（acct: 前缀，见 handlers/auth.ts）撞 key。
    if (RATE_LIMITED.has(`${req.method} ${url.pathname}`)) {
      if (!deps.loginRateLimiter.allow(`ip:${url.pathname}|${clientIp(req, deps.trustedProxyHops)}`, deps.now())) {
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
