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
 */
export function decryptEvent(aesKey: string, encrypted: string): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const cipher = Buffer.from(encrypted, 'base64')
  const iv = key.subarray(0, 16)

  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  const padded = Buffer.concat([decipher.update(cipher), decipher.final()])

  const padLen = padded[padded.length - 1] ?? 0
  const plain = padded.subarray(0, padded.length - padLen)

  const msgLen = plain.readUInt32BE(16)
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
