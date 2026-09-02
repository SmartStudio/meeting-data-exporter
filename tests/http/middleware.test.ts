import { expect, test } from 'bun:test'
import { requireAuth, requireAdminAuth, ADMIN_SESSION_COOKIE } from '../../src/http/middleware'
import { signAccessToken } from '../../src/auth/tokens'
import { AdminSessionInvalidError } from '../../src/auth/admin'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { ActorIdentity } from '../../src/domain/types'

const SECRET = 'x'.repeat(32)
const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-a', tmUserId: 'tm-a', programId: null }

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

// ---------------------------------------------------------------------------
// requireAdminAuth（Task 3 / A1）
// ---------------------------------------------------------------------------

const ADMIN_IDENTITY: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }

/** 只需要 verifySession 这一个方法被 requireAdminAuth 调用；其余方法在这些用例里不应被触碰 */
function fakeAdminAuth(verifySession: AdminAuth['verifySession']): AdminAuth {
  const notExpected = (name: string) => () => {
    throw new Error(`unexpected call to AdminAuth.${name} in this test`)
  }
  return {
    authenticate: notExpected('authenticate'),
    hashPassword: notExpected('hashPassword'),
    issueSession: notExpected('issueSession'),
    verifySession,
    revokeSession: notExpected('revokeSession'),
    revokeAllSessionsFor: notExpected('revokeAllSessionsFor'),
    revokeOtherSessionsFor: notExpected('revokeOtherSessionsFor'),
  }
}

test('requireAdminAuth：无 cookie 返回 401 missing_admin_session', async () => {
  const adminAuth = fakeAdminAuth(async () => ADMIN_IDENTITY)
  const req = new Request('https://gw/api/v1/admin/accounts')
  const r = await requireAdminAuth(req, adminAuth, 1000)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.response.status).toBe(401)
    expect((await r.response.json()).error).toBe('missing_admin_session')
  }
})

test('requireAdminAuth：token 校验失败（AdminSessionInvalidError）返回 401 invalid_admin_session', async () => {
  const adminAuth = fakeAdminAuth(async () => {
    throw new AdminSessionInvalidError()
  })
  const req = new Request('https://gw/api/v1/admin/accounts', {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=some-invalid-token` },
  })
  const r = await requireAdminAuth(req, adminAuth, 1000)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.response.status).toBe(401)
    expect((await r.response.json()).error).toBe('invalid_admin_session')
  }
})

// ── 被拒绝的会话 cookie 必须当场作废 ────────────────────────────────
//
// 服务端判定这张令牌不认了，浏览器却按签发时的 Max-Age（勾了「记住此设备」
// 就是 30 天）继续留着它、附在此后每一个请求上。两边对「我登录了没有」的答案
// 从此不一致，而产品里**没有任何一条路径**能让人把它弄掉——普通用户不会去开
// 开发者工具删 cookie。这几条钉住「拒绝的那一刻就是清掉的那一刻」。

function setCookies(res: Response): string[] {
  // getSetCookie() 才拿得到多条；headers.get('set-cookie') 会把它们逗号连成一条
  return res.headers.getSetCookie()
}

test('requireAdminAuth：令牌无效时，401 顺带把浏览器里那张 cookie 作废', async () => {
  const adminAuth = fakeAdminAuth(async () => {
    throw new AdminSessionInvalidError()
  })
  const req = new Request('https://gw/api/v1/admin/accounts', {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=some-invalid-token` },
  })
  const r = await requireAdminAuth(req, adminAuth, 1000)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    const cookies = setCookies(r.response)
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toContain(`${ADMIN_SESSION_COOKIE}=;`)
    expect(cookies[0]).toContain('Max-Age=0')
    // Path / HttpOnly / SameSite 必须与签发时（handlers/console/auth.ts 的
    // cookieAttrs）一字不差，否则浏览器认为这是另一张 cookie，删除落空
    expect(cookies[0]).toContain('Path=/')
    expect(cookies[0]).toContain('HttpOnly')
    expect(cookies[0]).toContain('SameSite=Strict')
  }
})

test('requireAdminAuth：删除指令不带 Secure —— 一条写法要在 http 与 https 下都成立', async () => {
  // cookie 的身份是 (name, domain, path)，Secure 不在其中：https 下一条不带
  // Secure 的删除指令照样删得掉 Secure 的 cookie。反过来在本地开发（http）
  // 下发带 Secure 的删除指令，浏览器整条丢弃——删除**静静地**不生效。
  const adminAuth = fakeAdminAuth(async () => {
    throw new AdminSessionInvalidError()
  })
  const req = new Request('https://gw/x', {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=nope` },
  })
  const r = await requireAdminAuth(req, adminAuth, 1000)
  expect(r.ok === false && setCookies(r.response)[0]).not.toContain('Secure')
})

test('requireAdminAuth：压根没带 cookie 时不发删除指令 —— 没东西可清，那是噪音', async () => {
  const adminAuth = fakeAdminAuth(async () => ADMIN_IDENTITY)
  const r = await requireAdminAuth(new Request('https://gw/x'), adminAuth, 1000)
  expect(r.ok === false && setCookies(r.response)).toEqual([])
})

test('requireAdminAuth：verifySession 抛出非 AdminSessionInvalidError 的异常时向上抛出，不吞掉', async () => {
  const boom = new Error('unexpected db failure')
  const adminAuth = fakeAdminAuth(async () => {
    throw boom
  })
  const req = new Request('https://gw/api/v1/admin/accounts', {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=some-token` },
  })
  await expect(requireAdminAuth(req, adminAuth, 1000)).rejects.toBe(boom)
})

test('requireAdminAuth：校验成功返回 ok:true 并带回 identity', async () => {
  const adminAuth = fakeAdminAuth(async (token, now) => {
    expect(token).toBe('valid-token')
    expect(now).toBe(1234)
    return ADMIN_IDENTITY
  })
  const req = new Request('https://gw/api/v1/admin/accounts', {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=valid-token` },
  })
  const r = await requireAdminAuth(req, adminAuth, 1234)
  expect(r.ok).toBe(true)
  expect(r.ok && r.identity).toEqual(ADMIN_IDENTITY)
})

test('requireAdminAuth：cookie 头混了其他 cookie 时仍能正确取到目标值', async () => {
  const adminAuth = fakeAdminAuth(async (token) => {
    expect(token).toBe('xxx')
    return ADMIN_IDENTITY
  })
  const req = new Request('https://gw/api/v1/admin/accounts', {
    headers: { cookie: `foo=bar; ${ADMIN_SESSION_COOKIE}=xxx; baz=qux` },
  })
  const r = await requireAdminAuth(req, adminAuth, 1000)
  expect(r.ok).toBe(true)
})

test('requireAdminAuth：目标 cookie 在头部最前面时仍能正确取到值', async () => {
  const adminAuth = fakeAdminAuth(async (token) => {
    expect(token).toBe('first')
    return ADMIN_IDENTITY
  })
  const req = new Request('https://gw/api/v1/admin/accounts', {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=first; other=second` },
  })
  const r = await requireAdminAuth(req, adminAuth, 1000)
  expect(r.ok).toBe(true)
})

test('requireAdminAuth：cookie 值经过 URL 编码时正确解码', async () => {
  const adminAuth = fakeAdminAuth(async (token) => {
    expect(token).toBe('a/b+c')
    return ADMIN_IDENTITY
  })
  const req = new Request('https://gw/api/v1/admin/accounts', {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent('a/b+c')}` },
  })
  const r = await requireAdminAuth(req, adminAuth, 1000)
  expect(r.ok).toBe(true)
})
