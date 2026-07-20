import { createHash, createDecipheriv } from 'node:crypto'

export class WebhookVerificationError extends Error {
  constructor(reason: string) {
    super(`webhook verification failed: ${reason}`)
    this.name = 'WebhookVerificationError'
  }
}

/**
 * 回调 URL 公开可达，不验签等于允许任何人投递伪造的 STS-Token。
 * 算法：token / timestamp / nonce / 密文 四者字典序拼接后 sha1。
 *
 * 强制契约：返回 `false` 即验签失败，调用方必须立即拒绝整个请求（返回错误
 * 响应，如 401/403），严禁记录日志后继续处理请求体、调用 `decryptEvent` 或
 * `parseStsEvent`。这不是提示性建议，是路由层实现必须遵守的硬性要求。
 */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
  signature: string,
): boolean {
  const expected = createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex')
  return expected === signature
}

/**
 * EncodingAESKey 为 43 字符 base64，补 '=' 后解出 32 字节 AES key，
 * 密文前 16 字节为 IV。明文结构：16 随机字节 + 4 字节网络序长度 + JSON + corpid。
 *
 * 回调密文来自公网、可被任意构造，任何环节的失败都必须收敛成
 * `WebhookVerificationError`，不得把 OpenSSL/Buffer 层的原生异常
 * （及其内部错误码）透给调用方。
 */
export function decryptEvent(aesKey: string, encrypted: string): string {
  let padded: Buffer
  try {
    const key = Buffer.from(`${aesKey}=`, 'base64')
    const cipher = Buffer.from(encrypted, 'base64')
    const iv = key.subarray(0, 16)

    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    decipher.setAutoPadding(false)
    padded = Buffer.concat([decipher.update(cipher), decipher.final()])
  } catch {
    // 不透出原始 OpenSSL 错误信息（属于内部实现细节泄漏），仅保留可定位的原因。
    throw new WebhookVerificationError('failed to decrypt payload')
  }

  const padLen = padded[padded.length - 1] ?? 0
  if (padLen < 1 || padLen > 16 || padLen > padded.length) {
    throw new WebhookVerificationError('invalid padding length')
  }

  const plain = padded.subarray(0, padded.length - padLen)
  if (plain.length < 20) {
    throw new WebhookVerificationError('decrypted payload too short')
  }

  const msgLen = plain.readUInt32BE(16)
  if (20 + msgLen > plain.length) {
    throw new WebhookVerificationError('declared message length exceeds decrypted payload')
  }

  return plain.subarray(20, 20 + msgLen).toString('utf8')
}

export interface StsTokenPayload {
  reqId: string
  stsToken: string
  expireTs: number
  operatorUserId: string
}

export function parseStsEvent(json: string): StsTokenPayload {
  let parsed: {
    event?: string
    payload?: Array<{
      operator?: { userid?: string }
      token_info?: { req_id?: string; sts_token?: string; expire_ts?: number }
    }>
  }
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new WebhookVerificationError('payload is not valid json')
  }

  // JSON.parse('null') 合法返回 null，typeof null === 'object' 会绕过后续
  // 字段访问直接崩溃（TypeError），必须在此显式拦截。
  if (parsed === null || typeof parsed !== 'object') {
    throw new WebhookVerificationError('payload is not a json object')
  }

  if (parsed.event !== 'common.sts-token') {
    throw new WebhookVerificationError(`unexpected event: ${parsed.event}`)
  }
  const first = parsed.payload?.[0]
  const info = first?.token_info
  if (!info?.req_id || !info.sts_token || typeof info.expire_ts !== 'number') {
    throw new WebhookVerificationError('missing token_info fields')
  }

  return {
    reqId: info.req_id,
    stsToken: info.sts_token,
    expireTs: info.expire_ts,
    operatorUserId: first?.operator?.userid ?? '',
  }
}
