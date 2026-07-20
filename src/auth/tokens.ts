import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ActorIdentity } from '../domain/types'

export const ACCESS_TOKEN_TTL_SEC = 900 // 15 分钟
export const REFRESH_TOKEN_TTL_SEC = 7 * 24 * 3600

export class AccessTokenExpiredError extends Error {
  constructor() {
    super('access token expired')
    this.name = 'AccessTokenExpiredError'
  }
}

export class AccessTokenInvalidError extends Error {
  constructor(reason: string) {
    super(`access token invalid: ${reason}`)
    this.name = 'AccessTokenInvalidError'
  }
}

interface Payload {
  kind: ActorIdentity['kind']
  wecomUserId: string | null
  tmUserId: string
  iat: number
  exp: number
}

const b64u = (s: string | Buffer): string => Buffer.from(s).toString('base64url')

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest()
}

/**
 * 载荷只含身份，不含策略判定结果——否则管理员收紧策略后，
 * 持旧令牌者仍可继续导出，出现最长 15 分钟的管控空窗。
 */
export function signAccessToken(identity: ActorIdentity, secret: string, now: number): string {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload: Payload = {
    kind: identity.kind,
    wecomUserId: identity.wecomUserId,
    tmUserId: identity.tmUserId,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SEC,
  }
  const body = `${header}.${b64u(JSON.stringify(payload))}`
  return `${body}.${b64u(hmac(secret, body))}`
}

export function verifyAccessToken(token: string, secret: string, now: number): ActorIdentity {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessTokenInvalidError('malformed')
  const [header, payloadPart, sig] = parts as [string, string, string]

  const expected = hmac(secret, `${header}.${payloadPart}`)
  const actual = Buffer.from(sig, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AccessTokenInvalidError('signature mismatch')
  }

  let payload: Payload
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString())
  } catch {
    throw new AccessTokenInvalidError('unparseable payload')
  }
  if (now >= payload.exp) throw new AccessTokenExpiredError()

  return {
    kind: payload.kind,
    wecomUserId: payload.wecomUserId,
    tmUserId: payload.tmUserId,
  }
}

/** 去除 0/O/1/I 等易混字符——user_code 会被用户读出并手工输入 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateUserCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length]
  }
  return out
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url')
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
