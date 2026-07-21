import {
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
  generateOpaqueToken,
  hashToken,
  signAccessToken,
} from '../../auth/tokens'
import { DeviceFlowExpired, DeviceFlowPending, DeviceFlowSlowDown } from '../../auth/device'
import { IdentityMappingError } from '../../auth/identity'
import { ServiceAuthError } from '../../auth/service'
import type { ActorIdentity } from '../../domain/types'
import { html, json, readJson } from '../respond'
import type { RouteCtx } from '../router'

/**
 * POST /api/v1/auth/device/code
 *
 * 发起设备授权流程（RFC 8628）。桌面端与 CLI 共用同一条路径：响应体同时
 * 带上 user_code 与 verification_uri。
 *
 * 已知缺口：verification_uri 指向的 `/device` 确认页面尚未实现（归属待定，
 * 见 auth/device.ts 内 start() 的说明），当前会 404。客户端/CLI 应以
 * user_code 为准引导用户完成企微授权，不要假设打开 verification_uri 就能用。
 */
export async function deviceCode(_req: Request, ctx: RouteCtx): Promise<Response> {
  const started = await ctx.deps.deviceFlow.start(ctx.deps.now())
  return json(200, {
    device_code: started.deviceCode,
    user_code: started.userCode,
    verification_uri: started.verificationUri,
    expires_in: started.expiresIn,
    interval: started.interval,
  })
}

/**
 * POST /api/v1/auth/device/token
 *
 * 客户端按 interval 轮询。授权完成前返回 RFC 8628 标准错误码，
 * 客户端据此决定继续轮询 / 退避 / 放弃重新发起。
 */
export async function deviceToken(req: Request, ctx: RouteCtx): Promise<Response> {
  const body = await readJson<{ device_code?: string }>(req)
  const deviceCode = body?.device_code
  if (!deviceCode) return json(400, { error: 'invalid_request' })

  const now = ctx.deps.now()
  try {
    const identity = await ctx.deps.deviceFlow.poll(deviceCode, now)
    const tokens = await issueSession(ctx, identity, now)
    await ctx.deps.auditRecorder.recordLogin(identity, true)
    return json(200, tokens)
  } catch (err) {
    if (err instanceof DeviceFlowPending) return json(400, { error: 'authorization_pending' })
    if (err instanceof DeviceFlowSlowDown) return json(400, { error: 'slow_down' })
    if (err instanceof DeviceFlowExpired) return json(400, { error: 'expired_token' })
    throw err
  }
}

/**
 * GET /auth/wecom/callback?code=&state=
 *
 * 浏览器直接访问，不是客户端 API 调用——响应为 HTML 而非 JSON。
 *
 * 身份映射失败（IdentityMappingError）必须与「授权失败/无权限」显式区分
 * （跨任务约束 #3）：前者是配置缺陷（该员工在腾讯会议侧没有对应账号），
 * 用 account_not_provisioned 呈现，不能笼统展示成一个通用失败页。
 */
export async function wecomCallback(req: Request, ctx: RouteCtx): Promise<Response> {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (!code || !state) {
    return html(400, failurePage('登录参数缺失，请重新发起登录。'))
  }

  let wecomUser: { userId: string; email: string | null }
  try {
    wecomUser = await ctx.deps.wecomClient.exchangeCode(code)
  } catch {
    return html(400, failurePage('企业微信授权码无效或已过期，请重新发起登录。'))
  }

  try {
    const tmUserId = await ctx.deps.identityMapper.toTmUserId(wecomUser.userId, wecomUser.email)

    const ok = await ctx.deps.deviceFlow.completeAuthorization(state, wecomUser.userId, tmUserId)
    const identity: ActorIdentity = {
      kind: 'wecom_user',
      wecomUserId: wecomUser.userId,
      tmUserId,
    }

    if (!ok) {
      await ctx.deps.auditRecorder.recordLogin(identity, false, 'invalid_or_replayed_state')
      return html(400, failurePage('登录会话已失效或已被使用，请重新发起登录。'))
    }

    await ctx.deps.auditRecorder.recordLogin(identity, true)
    return html(200, successPage())
  } catch (err) {
    if (err instanceof IdentityMappingError) {
      // 没有真实 tmUserId 可用——用企微 userid 兜底填充，仅为了让这次失败的
      // 登录尝试仍然留有可追溯的审计记录（错误原因已经在 reason 字段里显式区分）。
      const placeholder: ActorIdentity = {
        kind: 'wecom_user',
        wecomUserId: wecomUser.userId,
        tmUserId: wecomUser.userId,
      }
      await ctx.deps.auditRecorder.recordLogin(placeholder, false, 'account_not_provisioned')
      return html(
        403,
        failurePage(
          '该企业微信账号尚未在腾讯会议侧开通，请联系管理员完成账号配置（account_not_provisioned）。',
        ),
      )
    }
    throw err
  }
}

/**
 * POST /api/v1/auth/refresh
 *
 * 刷新即轮换：每次成功刷新都作废旧 refresh_token 并签发新的（同一 family_id）。
 * 若提交的 refresh_token 已经被标记为 revoked（说明它在此之前已被使用过一次），
 * 判定为泄露，连坐吊销整条轮换链——即便这次提交的 token 字面上"看起来"合法。
 */
export async function refresh(req: Request, ctx: RouteCtx): Promise<Response> {
  const body = await readJson<{ refresh_token?: string }>(req)
  const refreshToken = body?.refresh_token
  if (!refreshToken) return json(400, { error: 'invalid_request' })

  const now = ctx.deps.now()
  const tokenHash = hashToken(refreshToken)
  const record = await ctx.deps.authStore.findRefreshToken(tokenHash)

  if (!record) return json(401, { error: 'invalid_refresh_token' })

  if (record.revoked) {
    await ctx.deps.authStore.revokeFamily(record.familyId)
    return json(401, { error: 'refresh_token_reused' })
  }

  if (now >= record.expiresAt) return json(401, { error: 'refresh_token_expired' })

  // 先吊销旧 token（含本条）再签发新的，避免旧 token 在窗口期内仍可被重放使用
  await ctx.deps.authStore.revokeFamily(record.familyId)

  const identity: ActorIdentity = {
    kind: 'wecom_user',
    wecomUserId: record.wecomUserId,
    tmUserId: record.tmUserId,
  }
  const tokens = await issueSession(ctx, identity, now, record.familyId)
  return json(200, tokens)
}

/**
 * POST /api/v1/auth/service-token
 *
 * 服务账号：无 refresh_token，到期重新换取。同样受策略约束，不享有绕过特权
 * （身份仍是一个显式的腾讯会议 userid，由管理员在创建服务账号时指定）。
 */
export async function serviceToken(req: Request, ctx: RouteCtx): Promise<Response> {
  const body = await readJson<{ client_id?: string; client_secret?: string }>(req)
  const clientId = body?.client_id
  const clientSecret = body?.client_secret
  if (!clientId || !clientSecret) return json(400, { error: 'invalid_request' })

  const now = ctx.deps.now()
  try {
    const identity = await ctx.deps.serviceAuth.authenticate(clientId, clientSecret, now)
    const accessToken = signAccessToken(identity, ctx.deps.jwtSecret, now)
    await ctx.deps.auditRecorder.recordLogin(identity, true)
    return json(200, { access_token: accessToken, expires_in: ACCESS_TOKEN_TTL_SEC })
  } catch (err) {
    if (err instanceof ServiceAuthError) {
      // 统一失败原因：不区分账号不存在/密钥错误/已禁用/已过期，否则等于给出
      // 一个账号是否存在的探测预言机（service.ts 的既有约定，这里原样遵守）。
      // 审计里用 clientId 兜底填充 tmUserId，仅为了让失败尝试仍可追溯到具体
      // 是哪个 client_id 在尝试，不代表该 client_id 就是一个已知的合法身份。
      await ctx.deps.auditRecorder.recordLogin(
        { kind: 'service_account', wecomUserId: null, tmUserId: clientId },
        false,
        'invalid_credentials',
      )
      return json(401, { error: 'invalid_credentials' })
    }
    throw err
  }
}

/**
 * POST /api/v1/auth/logout
 *
 * 吊销 refresh_token（整条轮换链）。未过期的 access_token 是无状态 JWT，
 * 无法主动失效，最多再存活到其自身的 15 分钟到期——这是设计上已知的窗口，
 * 由 access_token 的短 TTL 兜底，不在本端点里试图解决。
 */
export async function logout(req: Request, ctx: RouteCtx): Promise<Response> {
  const body = await readJson<{ refresh_token?: string }>(req)
  const refreshToken = body?.refresh_token
  if (!refreshToken) return json(400, { error: 'invalid_request' })

  const record = await ctx.deps.authStore.findRefreshToken(hashToken(refreshToken))
  if (record) await ctx.deps.authStore.revokeFamily(record.familyId)

  // 幂等：无论 token 是否存在/已吊销，登出请求本身总是成功——不向调用方
  // 泄露该 refresh_token 当前是否有效。
  return json(200, { ok: true })
}

async function issueSession(
  ctx: RouteCtx,
  identity: ActorIdentity,
  now: number,
  familyId?: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  if (identity.wecomUserId === null) {
    throw new Error('issueSession requires a wecom_user identity (service accounts have no refresh token)')
  }

  const accessToken = signAccessToken(identity, ctx.deps.jwtSecret, now)
  const refreshTokenValue = generateOpaqueToken()
  await ctx.deps.authStore.saveRefreshToken({
    tokenHash: hashToken(refreshTokenValue),
    wecomUserId: identity.wecomUserId,
    tmUserId: identity.tmUserId,
    familyId: familyId ?? generateOpaqueToken(),
    expiresAt: now + REFRESH_TOKEN_TTL_SEC,
    now,
  })

  return {
    access_token: accessToken,
    refresh_token: refreshTokenValue,
    expires_in: ACCESS_TOKEN_TTL_SEC,
  }
}

function successPage(): string {
  return '<!doctype html><html><body><h1>登录成功</h1><p>请返回客户端继续。</p></body></html>'
}

function failurePage(message: string): string {
  return `<!doctype html><html><body><h1>登录失败</h1><p>${escapeHtml(message)}</p></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
