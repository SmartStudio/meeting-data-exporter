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

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)

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
