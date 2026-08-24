import {
  AccessTokenExpiredError,
  AccessTokenInvalidError,
  verifyAccessToken,
} from '../auth/tokens'
import type { ActorIdentity } from '../domain/types'
import type { AdminAuth, AdminIdentity } from '../auth/admin'
import { AdminSessionInvalidError } from '../auth/admin'
import { json } from './respond'

export type AuthResult =
  | { ok: true; identity: ActorIdentity }
  | { ok: false; response: Response }

/**
 * 校验 Authorization: Bearer <access_token>。
 *
 * 三种失败必须可区分（供客户端决定是否该静默重新登录还是提示错误）：
 * - 缺失/格式不对   → 401 missing_token
 * - 签名无效/伪造   → 401 invalid_token
 * - 已过期         → 401 token_expired（且与其余两种失败分开，便于客户端
 *                     自动触发 refresh 流程而不是要求用户重新登录）
 */
export function requireAuth(req: Request, secret: string, now: number): AuthResult {
  const header = req.headers.get('authorization')
  if (!header || !header.startsWith('Bearer ')) {
    return { ok: false, response: json(401, { error: 'missing_token' }) }
  }

  const token = header.slice('Bearer '.length).trim()
  if (token.length === 0) {
    return { ok: false, response: json(401, { error: 'missing_token' }) }
  }

  try {
    const identity = verifyAccessToken(token, secret, now)
    return { ok: true, identity }
  } catch (err) {
    if (err instanceof AccessTokenExpiredError) {
      return { ok: false, response: json(401, { error: 'token_expired' }) }
    }
    if (err instanceof AccessTokenInvalidError) {
      return { ok: false, response: json(401, { error: 'invalid_token' }) }
    }
    throw err
  }
}

/** 客户端类型：仅用于审计留痕，缺失时置为 unknown，不阻断请求 */
export function clientKindOf(req: Request): string {
  return req.headers.get('x-client-kind') ?? 'unknown'
}

export const ADMIN_SESSION_COOKIE = 'mde_admin_session'

export type AdminAuthResult =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; response: Response }

/**
 * 从 Cookie 头里取指定名字的值。Cookie 头可能同时携带多个 cookie
 * （`foo=bar; mde_admin_session=xxx; baz=qux`），必须按 `;` 拆分后逐个匹配
 * 名字，不能假设目标 cookie 是唯一或第一个。
 *
 * 导出而不是留作模块私有：handlers/console/auth.ts 的 logout 也要读同一个 cookie，
 * 各写一份的代价不是重复代码而是**静默的安全失败**——logout 那份曾经把 cookie 名
 * 写成正则里的字面量，一旦 ADMIN_SESSION_COOKIE 改名，浏览器侧的 cookie 照样被清掉
 * （客户端看起来已登出），服务端的会话却再也撤销不掉。要读 cookie 一律走这个函数。
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/**
 * 管理员会话校验。与 requireAuth 并列但签名故意不同——管理员会话（Task 3，
 * A1）落库在 admin_sessions 表，校验必须查库（并可能触发滑动续期的 UPDATE），
 * 做不成同步函数。
 */
export async function requireAdminAuth(
  req: Request,
  adminAuth: AdminAuth,
  now: number,
): Promise<AdminAuthResult> {
  const token = readCookie(req, ADMIN_SESSION_COOKIE)
  if (token === null) {
    return { ok: false, response: json(401, { error: 'missing_admin_session' }) }
  }
  try {
    const identity = await adminAuth.verifySession(token, now)
    return { ok: true, identity }
  } catch (err) {
    if (err instanceof AdminSessionInvalidError) {
      return { ok: false, response: json(401, { error: 'invalid_admin_session' }) }
    }
    throw err
  }
}
