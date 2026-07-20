import { createHmac, randomInt } from 'node:crypto'
import type { BuiltUrl } from './url'

export interface SignParams {
  secretId: string
  secretKey: string
  method: 'GET' | 'POST'
  nonce: string
  /** 秒级 unix 时间戳的字符串形式 */
  timestamp: string
  /** 含完整查询串的 URI，须来自 buildUrl 的 uriForSigning */
  requestUri: string
  /** GET 传空串 */
  body: string
}

/**
 * 双重编码：HMAC-SHA256 结果先转小写十六进制字符串，再对该字符串做 Base64。
 * 不是 base64(hmacBytes)——这是最常见的实现错误。
 */
export function sign(p: SignParams): string {
  const headerString =
    `X-TC-Key=${p.secretId}` +
    `&X-TC-Nonce=${p.nonce}` +
    `&X-TC-Timestamp=${p.timestamp}`

  const stringToSign = `${p.method}\n${headerString}\n${p.requestUri}\n${p.body}`

  const hex = createHmac('sha256', p.secretKey).update(stringToSign, 'utf8').digest('hex')
  return Buffer.from(hex, 'utf8').toString('base64')
}

export interface AuthHeaderInput {
  appId: string
  sdkId: string
  secretId: string
  secretKey: string
}

/**
 * 组装全部必需请求头。每次调用生成新的 nonce 与 timestamp——
 * 平台要求二者在五分钟内不可重复（错误码 190301），因此重试时
 * 必须重新调用本函数，不可复用已签名的请求。
 */
export function buildAuthHeaders(
  cfg: AuthHeaderInput,
  method: 'GET' | 'POST',
  built: BuiltUrl,
  body: string,
  stsToken?: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = String(randomInt(1, 2 ** 31 - 1))

  const signature = sign({
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    method,
    nonce,
    timestamp,
    requestUri: built.uriForSigning,
    body,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-TC-Key': cfg.secretId,
    'X-TC-Timestamp': timestamp,
    'X-TC-Nonce': nonce,
    'X-TC-Signature': signature,
    AppId: cfg.appId,
    SdkId: cfg.sdkId,
    'X-TC-Registered': '1',
  }
  if (stsToken !== undefined) {
    headers['STS-Token'] = stsToken
  }
  return headers
}
