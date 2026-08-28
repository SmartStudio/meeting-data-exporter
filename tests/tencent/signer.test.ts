import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { sign } from '../../src/tencent/signer'

/** 独立于实现重算一遍，验证双重编码顺序 */
function reference(secretKey: string, stringToSign: string): string {
  const hex = createHmac('sha256', secretKey).update(stringToSign, 'utf8').digest('hex')
  return Buffer.from(hex, 'utf8').toString('base64')
}

const base = {
  secretId: 'AKIDtest',
  secretKey: 'SecretKeyTest',
  method: 'GET' as const,
  nonce: '88080',
  timestamp: '1572168600',
  requestUri: '/v1/corp/records?end_time=2&start_time=1',
  body: '',
}

test('签名等于 base64(lowerHex(hmacSha256))，而非 base64(hmacBytes)', () => {
  const stringToSign =
    'GET\n' +
    'X-TC-Key=AKIDtest&X-TC-Nonce=88080&X-TC-Timestamp=1572168600\n' +
    '/v1/corp/records?end_time=2&start_time=1\n' +
    ''
  expect(sign(base)).toBe(reference(base.secretKey, stringToSign))
})

test('十六进制部分为小写', () => {
  const hexOfSig = Buffer.from(sign(base), 'base64').toString('utf8')
  expect(hexOfSig).toBe(hexOfSig.toLowerCase())
  expect(hexOfSig).toMatch(/^[0-9a-f]{64}$/)
})

test('POST 请求体参与签名', () => {
  const withBody = { ...base, method: 'POST' as const, body: '{"a":1}' }
  const withoutBody = { ...base, method: 'POST' as const, body: '' }
  expect(sign(withBody)).not.toBe(sign(withoutBody))
})

test('nonce 变化导致签名变化（重试须重新签名）', () => {
  expect(sign(base)).not.toBe(sign({ ...base, nonce: '88081' }))
})

test('timestamp 变化导致签名变化', () => {
  expect(sign(base)).not.toBe(sign({ ...base, timestamp: '1572168601' }))
})

test('查询串参与签名', () => {
  expect(sign(base)).not.toBe(sign({ ...base, requestUri: '/v1/corp/records' }))
})

import { buildAuthHeaders } from '../../src/tencent/signer'
import { buildUrl } from '../../src/tencent/url'

const authCfg = { appId: 'corp', sdkId: 'sdk', secretId: 'AKIDx', secretKey: 'k' }

test('buildAuthHeaders 含全部必需头，X-TC-Registered 固定为 1', () => {
  const built = buildUrl('https://x', '/v1/corp/records', { page: 1 })
  const h = buildAuthHeaders(authCfg, 'GET', built, '')
  expect(h['Content-Type']).toBe('application/json')
  expect(h['X-TC-Registered']).toBe('1')
  expect(h.AppId).toBe('corp')
  expect(h.SdkId).toBe('sdk')
  expect(h['X-TC-Signature']).toBeTruthy()
  expect(h['STS-Token']).toBeUndefined()
})

test('传入 stsToken 时附加 STS-Token 头', () => {
  const built = buildUrl('https://x', '/v1/addresses/1', {})
  const h = buildAuthHeaders(authCfg, 'GET', built, '', 'tok-123')
  expect(h['STS-Token']).toBe('tok-123')
})

test('两次调用产生不同的 nonce（保证重试时签名不重放）', () => {
  const built = buildUrl('https://x', '/v1/corp/records', { page: 1 })
  const a = buildAuthHeaders(authCfg, 'GET', built, '')
  const b = buildAuthHeaders(authCfg, 'GET', built, '')
  expect(a['X-TC-Nonce']).not.toBe(b['X-TC-Nonce'])
})
