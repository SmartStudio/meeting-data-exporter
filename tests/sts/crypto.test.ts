import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { parseStsEvent, verifySignature, WebhookVerificationError } from '../../src/sts/crypto'

const TOKEN = 'a'.repeat(25)

function makeSig(token: string, ts: string, nonce: string, data: string): string {
  return createHash('sha1').update([token, ts, nonce, data].sort().join('')).digest('hex')
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
