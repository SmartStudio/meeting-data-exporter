import { expect, test } from 'bun:test'
import type { ActorIdentity } from '../../src/domain/types'
import {
  AccessTokenExpiredError,
  AccessTokenInvalidError,
  generateDeviceCode,
  generateOpaqueToken,
  generateUserCode,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from '../../src/auth/tokens'

const identity: ActorIdentity = {
  kind: 'wecom_user',
  wecomUserId: 'ww-alice',
  tmUserId: 'tm-alice',
}
const SECRET = 'x'.repeat(32)

test('签发的令牌可被验证并还原身份', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  expect(verifyAccessToken(t, SECRET, 1100)).toEqual(identity)
})

test('令牌 15 分钟后过期', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  expect(() => verifyAccessToken(t, SECRET, 1000 + 901)).toThrow(AccessTokenExpiredError)
  expect(() => verifyAccessToken(t, SECRET, 1000 + 899)).not.toThrow()
})

test('错误密钥签发的令牌被拒绝', () => {
  const t = signAccessToken(identity, 'y'.repeat(32), 1000)
  expect(() => verifyAccessToken(t, SECRET, 1100)).toThrow(AccessTokenInvalidError)
})

test('篡改载荷的令牌被拒绝', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  const [h, p, s] = t.split('.')
  const tampered = `${h}.${Buffer.from('{"tmUserId":"tm-bob"}').toString('base64url')}.${s}`
  expect(() => verifyAccessToken(tampered, SECRET, 1100)).toThrow(AccessTokenInvalidError)
})

test('令牌中不含策略判定结果（策略须实时评估）', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  const payload = JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString())
  expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'kind', 'tmUserId', 'wecomUserId'])
})

test('user_code 为 8 位且不含易混字符 0 O 1 I', () => {
  for (let i = 0; i < 200; i++) {
    const c = generateUserCode()
    expect(c).toHaveLength(8)
    expect(c).not.toMatch(/[0O1I]/)
  }
})

test('device_code 与 opaque token 每次不同且足够长', () => {
  expect(generateDeviceCode()).not.toBe(generateDeviceCode())
  expect(generateDeviceCode().length).toBeGreaterThanOrEqual(43)
  expect(generateOpaqueToken()).not.toBe(generateOpaqueToken())
})

test('hashToken 稳定且为 sha256 hex', () => {
  expect(hashToken('abc')).toBe(hashToken('abc'))
  expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
})
