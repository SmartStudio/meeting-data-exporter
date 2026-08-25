import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
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
  programId: null,
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

/**
 * 载荷里只许有**身份**，不许有判定结果——否则管理员收紧规则后，持旧令牌者
 * 还能继续导出，出现最长 15 分钟的管控空窗。
 *
 * `programId` 是身份（这次请求是哪个采集程序发的），不是判定结果：它进载荷，
 * 规则仍然每次请求实时求值。这条断言列全部键名就是为了让「往载荷里塞点判定
 * 结果省一次查询」这种改动必须先改掉它、必须先想一遍。
 */
test('令牌中只含身份、不含策略判定结果（策略须实时评估）', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  const payload = JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString())
  expect(Object.keys(payload).sort()).toEqual([
    'exp', 'iat', 'kind', 'programId', 'tmUserId', 'wecomUserId',
  ])
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

test('采集程序身份随令牌往返（allow 栈的主体靠它）', () => {
  const program: ActorIdentity = {
    kind: 'service_account',
    wecomUserId: null,
    tmUserId: 'tm-svc',
    programId: 'svc-1',
  }
  const t = signAccessToken(program, SECRET, 1000)
  expect(verifyAccessToken(t, SECRET, 1100)).toEqual(program)
})

/**
 * 本次改动之前签发的令牌载荷里没有 programId。它们还没到期（最长 15 分钟），
 * 拿着它们发来的请求必须落到**拒绝**一侧，而不是被当成「某个采集程序」。
 */
test('旧令牌（载荷里没有 programId）还原成没有采集程序身份，不是漏判', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ kind: 'service_account', wecomUserId: null, tmUserId: 'tm-old', iat: 1000, exp: 1900 }),
  ).toString('base64url')
  const body = `${header}.${payload}`
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url')

  const identity = verifyAccessToken(`${body}.${sig}`, SECRET, 1100)
  expect(identity.programId).toBeNull()
})
