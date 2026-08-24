import { randomUUID } from 'node:crypto'
import type { RouteCtx } from '../../router'
import { json, readJson } from '../../respond'
import { requireAdminAuth, readCookie, ADMIN_SESSION_COOKIE } from '../../middleware'
import { AdminAuthError, ADMIN_PASSWORD_MIN_LENGTH, isAdminPasswordAcceptable } from '../../../auth/admin'

interface LoginBody { username?: string; password?: string; remember?: boolean }

/** Secure 在本地开发（非 https）下会导致浏览器直接丢弃 cookie；生产环境必须为 true。
 *  跟随 gatewayBaseUrl 是否为 https 判断，而不是写死——避免"本地登录页收到 cookie
 *  但浏览器悄悄不存"这种排查成本极高的静默失败。 */
function cookieAttrs(secure: boolean, maxAgeSec: number): string {
  const parts = [`Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=${maxAgeSec}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export async function login(req: Request, ctx: RouteCtx): Promise<Response> {
  const body = await readJson<LoginBody>(req)
  if (!body?.username || !body.password) {
    return json(400, { error: 'missing_credentials' })
  }
  try {
    const account = await ctx.deps.adminAuth.authenticate(body.username, body.password)
    const { token, expiresAt } = await ctx.deps.adminAuth.issueSession(account.id, body.remember === true, ctx.deps.now())
    const maxAge = expiresAt - ctx.deps.now()
    const res = json(200, { adminId: account.id, username: account.username })
    res.headers.append('set-cookie', `${ADMIN_SESSION_COOKIE}=${token}; ${cookieAttrs(ctx.deps.cookieSecure, maxAge)}`)
    return res
  } catch (err) {
    // 统一"账号或密码错误"，不区分——spec.md §4.1：表单级报错，故意不说哪个字段错
    if (err instanceof AdminAuthError) return json(401, { error: 'invalid_credentials' })
    throw err
  }
}

export async function logout(req: Request, ctx: RouteCtx): Promise<Response> {
  // 读 cookie 走 middleware 的 readCookie + ADMIN_SESSION_COOKIE 常量，不自己写正则：
  // 之前那份手写正则把 cookie 名写成了字面量，改名之后它会静静地匹配不上——响应里
  // 清除 cookie 的那一句照常发出（客户端看起来登出了），服务端会话却永远不被撤销。
  const token = readCookie(req, ADMIN_SESSION_COOKIE)
  // 空值（`mde_admin_session=;`）不值得往下走一次撤销——与改用 readCookie 之前的
  // `if (match?.[1])` 行为一致
  if (token) await ctx.deps.adminAuth.revokeSession(token)
  const res = json(204, null)
  res.headers.append('set-cookie', `${ADMIN_SESSION_COOKIE}=; ${cookieAttrs(ctx.deps.cookieSecure, 0)}`)
  return res
}

export async function me(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  return json(200, auth.identity)
}

export async function listAccounts(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const accounts = await ctx.deps.adminStore.listAccounts()
  // passwordHash 绝不出现在响应里
  return json(200, accounts.map((a) => ({ id: a.id, username: a.username, createdAt: a.createdAt })))
}

interface CreateAccountBody { username?: string; password?: string }

export async function createAccount(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const body = await readJson<CreateAccountBody>(req)
  if (!body?.username || !body.password) return json(400, { error: 'missing_fields' })
  // 密码门槛与 scripts/admin-bootstrap.ts 共用同一个判定（src/auth/admin.ts），
  // 不在这里另写一个 `.length < 8`：同一套凭证系统不能因为建号入口不同而有两条标准。
  // minLength 一并回给前端，好让"添加运维人员"的表单能直接说清差多少，
  // 不用把 8 这个数字在前端再抄一遍。
  if (!isAdminPasswordAcceptable(body.password)) {
    return json(400, { error: 'password_too_short', minLength: ADMIN_PASSWORD_MIN_LENGTH })
  }
  const existing = await ctx.deps.adminStore.findByUsername(body.username)
  if (existing !== null) return json(409, { error: 'username_taken' })
  const id = randomUUID()
  const passwordHash = await ctx.deps.adminAuth.hashPassword(body.password)
  await ctx.deps.adminStore.createAccount({ id, username: body.username, passwordHash, now: ctx.deps.now() })
  return json(201, { id, username: body.username })
}

export async function deleteAccount(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const targetId = ctx.params.id!
  // 系统内至少保留一个账号（US-3.5 验收标准）：删前查计数，等于 1 就拒绝，
  // 不给"最后一个也删了、谁都进不去控制台"的机会。
  const count = await ctx.deps.adminStore.countAccounts()
  if (count <= 1) return json(409, { error: 'cannot_delete_last_account' })
  const deleted = await ctx.deps.adminStore.deleteAccount(targetId)
  if (!deleted) return json(404, { error: 'account_not_found' })
  // 移除账号后其会话立即失效（US-3.5 验收标准）——不等自然过期
  await ctx.deps.adminAuth.revokeAllSessionsFor(targetId)
  return json(204, null)
}
