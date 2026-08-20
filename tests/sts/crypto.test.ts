import { expect, test } from 'bun:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import {
  decryptCheckStr,
  decryptEvent,
  parseStsEvent,
  verifySignature,
  WebhookVerificationError,
} from '../../src/sts/crypto'

const TOKEN = 'a'.repeat(25)

function makeSig(token: string, ts: string, nonce: string, data: string): string {
  return createHash('sha1').update([token, ts, nonce, data].sort().join('')).digest('hex')
}

/**
 * 生成一个合法的 43 字符 EncodingAESKey：真实随机 32 字节 base64 编码后为
 * 44 字符（末尾恰好 1 个 '=' padding），去掉该 '=' 即得 43 字符 key——与
 * aesDecrypt 内 `Buffer.from(\`${aesKey}=\`, 'base64')` 的还原方式对应。
 */
function makeAesKey(): string {
  const raw = randomBytes(32).toString('base64')
  return raw.slice(0, -1)
}

/** AES-256-CBC + PKCS#7（key 前 16 字节作 IV），与官方《事件加解密》一致 */
function encryptRaw(aesKey: string, plain: Buffer): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

/**
 * 按**腾讯官方**的明文结构加密：`msg + $key`——JSON 之后直接拼接 $key，
 * 没有企业微信那套 16 随机字节 + 4 字节长度头的前缀。
 */
function encryptEvent(aesKey: string, json: string, keySuffix = 'TailKey0123456789'): string {
  return encryptRaw(aesKey, Buffer.from(json + keySuffix, 'utf8'))
}

/** 关闭自动 padding 加密，用于构造末字节（padLen）非法的畸形密文。 */
function encryptRawNoPad(aesKey: string, plain: Buffer): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------

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

/**
 * 腾讯官方《签名校验》（文档 1095/51612）「验证示例」一节给出的全套样例值与
 * 期望签名，逐字抄录。本用例是我们的实现与**平台真实契约**之间唯一的硬性绑定
 * ——其余用例都只是自己和自己对账（自造签名、自己验证），无法发现「算法整体
 * 理解错了」这类问题。此处 token 恰好 25 字符，与 loadConfig 的长度校验相互印证。
 */
test('官方文档样例：签名算法与平台一致', () => {
  const token = 'bVPU6F8Htxl5XkAbp3jGV2xWp'
  const timestamp = '1609239040864'
  const nonce = '14964161'
  const data =
    'eyJldmVudCI6Im1lZXRpbmcuY3JlYXRlZCIsInVuaXF1ZV9zZXF1ZW5jZSI6ImYyMDA5NmVlLThhYzgt' +
    'NGRmMi1hN2RlLTA1NzQ2NDlmMjExYiIsInBheWxvYWQiOlt7Im9wZXJhdGVfdGltZSI6IjIwMjAtMTIt' +
    'MjkgMTc6NDE6MDYiLCJvcGVyYXRvciI6eyJ1c2VyaWQiOiJ0ZXN0ZXIwMDAwNmJhNWJhYjMzOTg1OGMx' +
    'M2M5MzBjY2E5NTY4NCJ9LCJtZWV0aW5nX2luZm8iOnsibWVldGluZ19pZCI6IjYwNTg4OTAzODU0ODA5' +
    'MjEwNTIiLCJtZWV0aW5nX2NvZGUiOiI1MzA4MTI0NTIiLCJzdWJqZWN0IjoibWVkaWEgdGVzdGVyIG1l' +
    'ZXRpbmciLCJjcmVhdG9yX2lkIjoidGVzdGVyMDAwMDZiYTViYWIzMzk4NThjMTNjOTMwY2NhOTU2ODQi' +
    'LCJob3N0cyI6WyJ0ZXN0ZXIwMDAwNmJhNWJhYjMzOTg1OGMxM2M5MzBjY2E5NTY4NCJdLCJtZWV0aW5n' +
    'X3R5cGUiOjAsInN0YXJ0X3RpbWUiOiIyMDIwLTEyLTI5IDE3OjQxOjA0IiwiZW5kX3RpbWUiOiIyMDIw' +
    'LTEyLTI5IDE4OjAxOjA0In19XX0'

  expect(token).toHaveLength(25)
  expect(
    verifySignature(token, timestamp, nonce, data, 'b11e507817336a91d7df0c8536ee2aca18bbbae8'),
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// 事件解析
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 解密
// ---------------------------------------------------------------------------

test('decryptEvent 按官方明文结构（msg + $key）解出 JSON，尾部 $key 被剥离', () => {
  const aesKey = makeAesKey()
  const json = JSON.stringify({
    event: 'common.sts-token',
    payload: [{ operator: { userid: 'admin' }, token_info: { req_id: 'r1', sts_token: 't1', expire_ts: 1 } }],
  })
  const encrypted = encryptEvent(aesKey, json)
  expect(decryptEvent(aesKey, encrypted)).toBe(json)
})

test('decryptEvent 对没有尾部 $key 的明文同样可用（JSON 恰好结束在末尾）', () => {
  const aesKey = makeAesKey()
  const json = JSON.stringify({ event: 'common.sts-token', payload: [] })
  expect(decryptEvent(aesKey, encryptEvent(aesKey, json, ''))).toBe(json)
})

/**
 * 官方《签名校验》样例里的 data 解 base64 后**直接就是明文 JSON**，与
 * 《事件加解密》所述的「先加密再 base64」不一致。两篇官方文档自身有出入，
 * 故实现对明文形态做了回退。此处锁定该行为。
 */
test('data 是未加密的 base64 明文 JSON 时按明文处理', () => {
  const aesKey = makeAesKey()
  const json = JSON.stringify({ event: 'common.sts-token', payload: [] })
  const plainBase64 = Buffer.from(json, 'utf8').toString('base64')
  expect(decryptEvent(aesKey, plainBase64)).toBe(json)
})

test('既解不出密、也不是明文 JSON 时抛出 WebhookVerificationError', () => {
  const aesKey = makeAesKey()
  const encrypted = encryptRaw(aesKey, Buffer.from('not json at all', 'utf8'))
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

test('decryptCheckStr 原样返回明文，不做 JSON 解析也不裁剪', () => {
  const aesKey = makeAesKey()
  const challenge = 'Ru1kR4nd0mCheckString-2026'
  const encrypted = encryptRaw(aesKey, Buffer.from(challenge, 'utf8'))
  expect(decryptCheckStr(aesKey, encrypted)).toBe(challenge)
})

test('decryptCheckStr 对畸形密文抛出 WebhookVerificationError 而非裸 OpenSSL 错误', () => {
  const aesKey = makeAesKey()
  expect(() => decryptCheckStr(aesKey, randomBytes(21).toString('base64')))
    .toThrow(WebhookVerificationError)
})
