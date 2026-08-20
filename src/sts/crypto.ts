import { createHash, createDecipheriv } from 'node:crypto'

export class WebhookVerificationError extends Error {
  constructor(reason: string) {
    super(`webhook verification failed: ${reason}`)
    this.name = 'WebhookVerificationError'
  }
}

/**
 * 回调 URL 公开可达，不验签等于允许任何人投递伪造的 STS-Token。
 * 算法：token / timestamp / nonce / 载荷 四者字典序拼接后 sha1。
 *
 * 已对照腾讯官方《签名校验》（文档 1095/51612）核实并用其样例实算验证：
 *   token=bVPU6F8Htxl5XkAbp3jGV2xWp  timestamp=1609239040864  nonce=14964161
 *   → signature = b11e507817336a91d7df0c8536ee2aca18bbbae8
 * 见 tests/sts/crypto.test.ts 的官方样例回归测试。
 *
 * 第四个参与项：POST 事件回调是 body 里的 `data`，GET URL 校验是 query 里的
 * `check_str`——两者都是"本次请求携带的那段 base64 载荷"，故共用本函数。
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
 * AES 解密的公共部分，POST 事件与 GET URL 校验共用。
 *
 * 对照腾讯官方《事件加解密》（文档 1095/54658）：
 *   AESKey = Base64_Decode(EncodingAESKey + "=")   → 32 字节（AES-256）
 *   算法 = AES-256-CBC，PKCS#7 填充，IV 取 AESKey 的前 16 字节
 *
 * 回调密文来自公网、可被任意构造，任何环节的失败都必须收敛成
 * `WebhookVerificationError`，不得把 OpenSSL/Buffer 层的原生异常
 * （及其内部错误码）透给调用方。
 */
function aesDecrypt(aesKey: string, encrypted: string): Buffer {
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
  return padded.subarray(0, padded.length - padLen)
}

/**
 * GET URL 有效性校验用：解密 `check_str`，原样返回明文。
 *
 * 官方《回调服务要求》（文档 1095/51608）要求把解密所得的明文字符串在 3 秒内
 * 原样回显（响应体不能带引号、换行），因此这里**不做任何结构解析或裁剪**——
 * 官方未写明该明文是否也像事件回调那样在尾部拼接了 $key，故先原样回显；
 * 若真实环境保存失败，看日志里的明文再决定是否需要剥离尾部。
 */
export function decryptCheckStr(aesKey: string, checkStr: string): string {
  return aesDecrypt(aesKey, checkStr).toString('utf8')
}

/**
 * 从明文中取出 JSON 部分。
 *
 * 官方《事件加解密》给出的加密结构是 `AES_Encrypt[msg + $key]`——即 JSON 之后
 * 直接拼接了 $key，**没有**企业微信那套「16 随机字节 + 4 字节长度头」的前缀
 * （本项目最初按企微惯例实现，属于推断错误，已按官方文档纠正）。
 *
 * $key 取自 base64 字符集，不含 `}`，因此「截到最后一个 `}`」是安全的切法。
 * 要求 JSON 必须从第 0 位开始，避免把任何前缀内容误当作载荷。
 */
function extractJsonPrefix(plain: string): string {
  const end = plain.lastIndexOf('}')
  if (!plain.startsWith('{') || end < 0) {
    throw new WebhookVerificationError('decrypted payload is not a json object')
  }
  return plain.slice(0, end + 1)
}

/** 载荷本身就是未加密的 base64 JSON 时返回它，否则返回 null */
function plainBase64Json(data: string): string | null {
  let text: string
  try {
    text = Buffer.from(data, 'base64').toString('utf8')
  } catch {
    return null
  }
  if (!text.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof (parsed as { event?: unknown }).event !== 'string') return null
    return text
  } catch {
    return null
  }
}

/**
 * POST 事件回调用：把 body 里的 `data` 还原成事件 JSON。
 *
 * 两条路径：
 * 1. 正常路径——AES 解密后取 JSON 前缀（见 extractJsonPrefix）。
 * 2. 回退路径——腾讯官方《签名校验》给出的样例里，`data` base64 解码后**直接
 *    就是明文 JSON**（未加密），与《事件加解密》的描述不一致。两篇官方文档
 *    自身存在出入，故这里在解密失败时再判断一次「是否本来就是明文 JSON」。
 *
 * 回退不降低安全性：调用方（`StsManager.handleWebhook`）**必须先验签通过**才会
 * 走到这里，而签名由 token 参与计算，伪造者无法构造出合法签名。
 */
export function decryptEvent(aesKey: string, encrypted: string): string {
  try {
    return extractJsonPrefix(aesDecrypt(aesKey, encrypted).toString('utf8'))
  } catch (err) {
    const plain = plainBase64Json(encrypted)
    if (plain !== null) {
      console.warn('[webhook] data 未加密（base64 明文 JSON），已按明文处理；验签已通过')
      return plain
    }
    throw err
  }
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
