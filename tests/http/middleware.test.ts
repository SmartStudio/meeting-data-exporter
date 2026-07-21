import { expect, test } from 'bun:test'
import { requireAuth } from '../../src/http/middleware'
import { signAccessToken } from '../../src/auth/tokens'
import type { ActorIdentity } from '../../src/domain/types'

const SECRET = 'x'.repeat(32)
const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-a', tmUserId: 'tm-a' }

test('缺少 Authorization 头返回 401', () => {
  const r = requireAuth(new Request('https://gw/api/v1/meetings'), SECRET, 1000)
  expect(r.ok).toBe(false)
  expect(r.ok === false && r.response.status).toBe(401)
})

test('缺少 Authorization 头时错误码为 missing_token', async () => {
  const r = requireAuth(new Request('https://gw/api/v1/meetings'), SECRET, 1000)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect((await r.response.json()).error).toBe('missing_token')
  }
})

test('有效令牌通过并返回身份', () => {
  const t = signAccessToken(alice, SECRET, 1000)
  const req = new Request('https://gw/api/v1/meetings', { headers: { Authorization: `Bearer ${t}` } })
  const r = requireAuth(req, SECRET, 1100)
  expect(r.ok && r.identity).toEqual(alice)
})

test('过期令牌返回 401 且错误码为 token_expired', async () => {
  const t = signAccessToken(alice, SECRET, 1000)
  const req = new Request('https://gw/x', { headers: { Authorization: `Bearer ${t}` } })
  const r = requireAuth(req, SECRET, 1000 + 901)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.response.status).toBe(401)
    expect((await r.response.json()).error).toBe('token_expired')
  }
})

test('伪造/篡改令牌返回 401 且错误码为 invalid_token（与 token_expired 可区分）', async () => {
  const t = signAccessToken(alice, SECRET, 1000)
  const forged = `${t.slice(0, -4)}AAAA`
  const req = new Request('https://gw/x', { headers: { Authorization: `Bearer ${forged}` } })
  const r = requireAuth(req, SECRET, 1100)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.response.status).toBe(401)
    expect((await r.response.json()).error).toBe('invalid_token')
  }
})

test('用错误密钥签发的令牌返回 invalid_token', async () => {
  const t = signAccessToken(alice, 'y'.repeat(32), 1000)
  const req = new Request('https://gw/x', { headers: { Authorization: `Bearer ${t}` } })
  const r = requireAuth(req, SECRET, 1100)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect((await r.response.json()).error).toBe('invalid_token')
  }
})

test('Authorization 头不是 Bearer 形式时返回 401 missing_token', async () => {
  const req = new Request('https://gw/x', { headers: { Authorization: 'Basic abcdef' } })
  const r = requireAuth(req, SECRET, 1000)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect((await r.response.json()).error).toBe('missing_token')
  }
})
