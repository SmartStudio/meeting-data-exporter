import { expect, test } from 'bun:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { decryptEvent, parseStsEvent, verifySignature, WebhookVerificationError } from '../../src/sts/crypto'

const TOKEN = 'a'.repeat(25)

function makeSig(token: string, ts: string, nonce: string, data: string): string {
  return createHash('sha1').update([token, ts, nonce, data].sort().join('')).digest('hex')
}

/**
 * 生成一个合法的 43 字符 EncodingAESKey：真实随机 32 字节 base64 编码后为
 * 44 字符（末尾恰好 1 个 '=' padding），去掉该 '=' 即得 43 字符 key——与
 * decryptEvent 内 `Buffer.from(\`${aesKey}=\`, 'base64')` 的还原方式对应。
 */
function makeAesKey(): string {
  const raw = randomBytes(32).toString('base64')
  return raw.slice(0, -1)
}

/**
 * 按实现约定的明文结构（16 随机字节 + 4 字节大端长度 + JSON + 尾部内容）
 * 手动构造并用 AES-256-CBC（key 前 16 字节作 IV）加密，默认开启的 PKCS#7
 * padding 与 decryptEvent 手动剥离 padding 的方式一致。
 */
function encryptEvent(aesKey: string, json: string): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const msg = Buffer.from(json, 'utf8')
  const msgLen = Buffer.alloc(4)
  msgLen.writeUInt32BE(msg.length, 0)
  const plain = Buffer.concat([randomBytes(16), msgLen, msg, Buffer.from('tail-corpid', 'utf8')])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

/** 直接加密任意明文（不套用 16+4 头部结构），用于构造畸形密文。 */
function encryptRaw(aesKey: string, plain: Buffer): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

/** 关闭自动 padding 加密，用于构造末字节（padLen）非法的畸形密文。 */
function encryptRawNoPad(aesKey: string, plain: Buffer): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

test('正确签名通过校验', () => {
  const sig = makeSig(TOKEN, '1700000000', 'n1', 'cipher')
  expect(verifySignature(TOKEN, '1700000000', 'n1', 'cipher', sig)).toBe(true)
})

test('篡改密文导致校验失败', () => {
  const sig = makeSig(TOKEN, '1700000000', 'n1', 'cipher')
  expect(verifySignature(TOKEN, '1700000000', 'n1', 'TAMPERED', sig)).toBe(false)
})

test('错误 token 无法produce 正确签名', () => {
  const sig = makeSig('b'.repeat(25), '1700000000', 'n1', 'cipher')
  expect(verifySignature(TOKEN, '1700000000', 'n1', 'cipher', sig)).toBe(false)
})

test('parseStsEvent 提取 req_id 与 token', () => {
  const payload = parseStsEvent(
    JSON.stringify({
      event: 'common.sts-token',
      trace_id: 'trace-1',
      payload: [
        {
          operate_time: 1609313201465,
          operator: { userid: 'admin', user_name: 'Admin' },
          token_info: { req_id: 'req-9', sts_token: 'tok-9', expire_ts: 1609399601 },
        },
      ],
    }),
  )
  expect(payload).toEqual({
    reqId: 'req-9',
    stsToken: 'tok-9',
    expireTs: 1609399601,
    operatorUserId: 'admin',
  })
})

test('非 sts-token 事件被拒绝', () => {
  expect(() => parseStsEvent(JSON.stringify({ event: 'other.event', payload: [] })))
    .toThrow(WebhookVerificationError)
})

test('payload 为空数组时报错而非静默返回', () => {
  expect(() => parseStsEvent(JSON.stringify({ event: 'common.sts-token', payload: [] })))
    .toThrow(WebhookVerificationError)
})

test('JSON 顶层为 null 时抛出 WebhookVerificationError 而非裸 TypeError', () => {
  expect(() => parseStsEvent('null')).toThrow(WebhookVerificationError)
})

test('decryptEvent 正常往返解密出原始 JSON', () => {
  const aesKey = makeAesKey()
  const json = JSON.stringify({
    event: 'common.sts-token',
    payload: [{ operator: { userid: 'admin' }, token_info: { req_id: 'r1', sts_token: 't1', expire_ts: 1 } }],
  })
  const encrypted = encryptEvent(aesKey, json)
  expect(decryptEvent(aesKey, encrypted)).toBe(json)
})

test('decryptEvent 明文短于 20 字节时抛出 WebhookVerificationError', () => {
  const aesKey = makeAesKey()
  const encrypted = encryptRaw(aesKey, Buffer.from([1, 2, 3, 4, 5]))
  expect(() => decryptEvent(aesKey, encrypted)).toThrow(WebhookVerificationError)
})

test('decryptEvent padLen 非法（超出缓冲区）时抛出 WebhookVerificationError', () => {
  const aesKey = makeAesKey()
  const plain = Buffer.alloc(32, 0)
  plain[31] = 255 // 末字节被当作 padLen，255 远超 16 与缓冲区长度
  const encrypted = encryptRawNoPad(aesKey, plain)
  expect(() => decryptEvent(aesKey, encrypted)).toThrow(WebhookVerificationError)
})

test('decryptEvent 密文非 16 字节整数倍时抛出 WebhookVerificationError', () => {
  const aesKey = makeAesKey()
  const encrypted = randomBytes(21).toString('base64') // 21 不是 16 的整数倍
  expect(() => decryptEvent(aesKey, encrypted)).toThrow(WebhookVerificationError)
})
