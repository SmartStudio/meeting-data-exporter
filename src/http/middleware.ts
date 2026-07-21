import {
  AccessTokenExpiredError,
  AccessTokenInvalidError,
  verifyAccessToken,
} from '../auth/tokens'
import type { ActorIdentity } from '../domain/types'
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
