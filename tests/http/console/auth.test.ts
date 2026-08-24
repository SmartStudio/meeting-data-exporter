/**
 * 与 tests/http/auth.test.ts（走真实 DB + 完整 app 派发）不同：AdminStore
 * 的 SQL 语义已由 tests/store/admin.test.ts 覆盖，AdminAuth 的会话/密码逻辑
 * 已由 tests/auth/admin.test.ts 覆盖。这一层只关心 handler 自身的胶水逻辑
 * （参数校验、状态码选择、passwordHash 是否泄露、删除账号前的计数守卫、
 * 删除成功后是否级联撤销会话等），因此用假 AdminAuth/AdminStore 直接注入、
 * 直接调用 handler 函数断言 Response——不经过真实数据库，也不经过路由派发。
 *
 * RouteCtx.deps 的类型是完整的 AppDeps，但这些 handler 只读
 * now/adminAuth/adminStore/cookieSecure 四个字段，因此这里只构造这四个字段
 * 后 `as unknown as AppDeps`：一是省去为 admin 认证无关的十几个字段各编一个
 * 假实现，二是这样写不会因为未来任务往 AppDeps 上加字段而被迫跟着改。
 */
import { expect, test } from 'bun:test'
import { login, logout, me, listAccounts, createAccount, deleteAccount } from '../../../src/http/handlers/console/auth'
import { AdminAuthError, AdminSessionInvalidError } from '../../../src/auth/admin'
import type { AdminAuth, AdminIdentity } from '../../../src/auth/admin'
import type { AdminAccount, AdminStore } from '../../../src/store/admin'
import type { AppDeps, RouteCtx } from '../../../src/http/router'
import { ADMIN_SESSION_COOKIE } from '../../../src/http/middleware'

const ADMIN_IDENTITY: AdminIdentity = { adminId: 'admin-1', username: 'alice' }

function fakeAdminAuth(overrides: Partial<AdminAuth> = {}): AdminAuth {
  const base: AdminAuth = {
    async authenticate() {
      throw new Error('fakeAdminAuth.authenticate not stubbed for this test')
    },
    async hashPassword() {
      throw new Error('fakeAdminAuth.hashPassword not stubbed for this test')
    },
    async issueSession() {
      throw new Error('fakeAdminAuth.issueSession not stubbed for this test')
    },
    // 默认放行：多数 handler 用例关心的是登录之后的业务逻辑，未登录场景
    // 由不带 cookie 的请求或显式覆盖 verifySession 来表达
    async verifySession() {
      return ADMIN_IDENTITY
    },
    async revokeSession() {
      throw new Error('fakeAdminAuth.revokeSession not stubbed for this test')
    },
    async revokeAllSessionsFor() {
      throw new Error('fakeAdminAuth.revokeAllSessionsFor not stubbed for this test')
    },
  }
  return { ...base, ...overrides }
}

function fakeAdminStore(overrides: Partial<AdminStore> = {}): AdminStore {
  const base: AdminStore = {
    async countAccounts() {
      throw new Error('fakeAdminStore.countAccounts not stubbed for this test')
    },
    async findByUsername() {
      throw new Error('fakeAdminStore.findByUsername not stubbed for this test')
    },
    async findById() {
      throw new Error('fakeAdminStore.findById not stubbed for this test')
    },
    async listAccounts() {
      throw new Error('fakeAdminStore.listAccounts not stubbed for this test')
    },
    async createAccount() {
      throw new Error('fakeAdminStore.createAccount not stubbed for this test')
    },
    async deleteAccount() {
      throw new Error('fakeAdminStore.deleteAccount not stubbed for this test')
    },
    async createSession() {
      throw new Error('fakeAdminStore.createSession not stubbed for this test')
    },
    async findSessionByTokenHash() {
      throw new Error('fakeAdminStore.findSessionByTokenHash not stubbed for this test')
    },
    async touchSessionExpiry() {
      throw new Error('fakeAdminStore.touchSessionExpiry not stubbed for this test')
    },
    async deleteSession() {
      throw new Error('fakeAdminStore.deleteSession not stubbed for this test')
    },
    async deleteSessionsByAdminId() {
      throw new Error('fakeAdminStore.deleteSessionsByAdminId not stubbed for this test')
    },
  }
  return { ...base, ...overrides }
}

interface CtxOverrides {
  adminAuth?: Partial<AdminAuth>
  adminStore?: Partial<AdminStore>
  cookieSecure?: boolean
  now?: () => number
  params?: Record<string, string>
}

function makeCtx(overrides: CtxOverrides = {}): RouteCtx {
  const deps = {
    now: overrides.now ?? (() => 1_000_000),
    adminAuth: fakeAdminAuth(overrides.adminAuth),
    adminStore: fakeAdminStore(overrides.adminStore),
    cookieSecure: overrides.cookieSecure ?? false,
  }
  return { params: overrides.params ?? {}, deps: deps as unknown as AppDeps }
}

/** 带一个能通过默认 fakeAdminAuth.verifySession 校验的会话 cookie */
function authedRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('cookie', `${ADMIN_SESSION_COOKIE}=valid-session-token`)
  return new Request(url, { ...init, headers })
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

test('login：缺少用户名或密码返回 400，且不调用 authenticate', async () => {
  let authCalled = false
  const ctx = makeCtx({
    adminAuth: {
      async authenticate() {
        authCalled = true
        throw new Error('should not be called')
      },
    },
  })
  const req = new Request('https://gw/api/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice' }),
  })
  const res = await login(req, ctx)
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('missing_credentials')
  expect(authCalled).toBe(false)
})

test('login：凭证错误返回 401 invalid_credentials，且不下发 cookie', async () => {
  const ctx = makeCtx({
    adminAuth: {
      async authenticate() {
        throw new AdminAuthError()
      },
    },
  })
  const req = new Request('https://gw/api/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'wrong' }),
  })
  const res = await login(req, ctx)
  expect(res.status).toBe(401)
  expect((await res.json()).error).toBe('invalid_credentials')
  expect(res.headers.get('set-cookie')).toBeNull()
})

test('login：凭证正确时返回账号信息并下发会话 cookie（HttpOnly / SameSite=Strict / Max-Age）', async () => {
  const account: AdminAccount = { id: 'admin-1', username: 'alice', passwordHash: 'h', createdAt: 1000 }
  const ctx = makeCtx({
    now: () => 5000,
    cookieSecure: false,
    adminAuth: {
      async authenticate(username, password) {
        expect(username).toBe('alice')
        expect(password).toBe('correct-pass')
        return account
      },
      async issueSession(adminId, remember, now) {
        expect(adminId).toBe('admin-1')
        expect(remember).toBe(true)
        expect(now).toBe(5000)
        return { token: 'issued-session-token', expiresAt: now + 2_592_000 }
      },
    },
  })
  const req = new Request('https://gw/api/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct-pass', remember: true }),
  })
  const res = await login(req, ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ adminId: 'admin-1', username: 'alice' })

  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE}=issued-session-token`)
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('SameSite=Strict')
  expect(setCookie).toContain('Max-Age=2592000')
  expect(setCookie).not.toContain('Secure')
})

test('login：未勾选/未提供 remember 时按 false 传给 issueSession', async () => {
  const account: AdminAccount = { id: 'admin-1', username: 'alice', passwordHash: 'h', createdAt: 1000 }
  const ctx = makeCtx({
    adminAuth: {
      async authenticate() {
        return account
      },
      async issueSession(_adminId, remember, now) {
        expect(remember).toBe(false)
        return { token: 't', expiresAt: now + 100 }
      },
    },
  })
  const req = new Request('https://gw/api/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'x' }),
  })
  const res = await login(req, ctx)
  expect(res.status).toBe(200)
})

test('login：cookieSecure=true 时 set-cookie 带 Secure 属性', async () => {
  const account: AdminAccount = { id: 'admin-1', username: 'alice', passwordHash: 'h', createdAt: 1000 }
  const ctx = makeCtx({
    cookieSecure: true,
    adminAuth: {
      async authenticate() {
        return account
      },
      async issueSession(_adminId, _remember, now) {
        return { token: 't', expiresAt: now + 100 }
      },
    },
  })
  const req = new Request('https://gw/api/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'x' }),
  })
  const res = await login(req, ctx)
  expect(res.headers.get('set-cookie')).toContain('Secure')
})

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

test('logout：携带会话 cookie 时调用 revokeSession(token)，并下发清除 cookie 的响应', async () => {
  // 用可变对象记录闭包内的调用参数，而不是裸 let：TS 对"在嵌套闭包里被赋值、
  // 稍后在外层读取"的裸变量会误判控制流、把读取点的类型收窄回初始值的字面量
  // 类型（这里是 null），导致 .toBe('session-to-revoke') 编译报错——对象属性
  // 访问不会触发这种过度收窄。
  const recorded: { token: string | null } = { token: null }
  const ctx = makeCtx({
    adminAuth: {
      async revokeSession(token) {
        recorded.token = token
      },
    },
  })
  const req = new Request('https://gw/api/v1/admin/auth/logout', {
    method: 'POST',
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=session-to-revoke` },
  })
  const res = await logout(req, ctx)
  expect(res.status).toBe(204)
  expect(recorded.token).toBe('session-to-revoke')

  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE}=;`)
  expect(setCookie).toContain('Max-Age=0')
})

test('logout：cookie 头混了其他 cookie 时仍能正确提取目标 token（不是取到相邻 cookie 的值）', async () => {
  const recorded: { token: string | null } = { token: null }
  const ctx = makeCtx({
    adminAuth: {
      async revokeSession(token) {
        recorded.token = token
      },
    },
  })
  const req = new Request('https://gw/api/v1/admin/auth/logout', {
    method: 'POST',
    headers: { cookie: `foo=bar; ${ADMIN_SESSION_COOKIE}=session-amid-others; baz=qux` },
  })
  const res = await logout(req, ctx)
  expect(res.status).toBe(204)
  expect(recorded.token).toBe('session-amid-others')
})

test('logout：没有会话 cookie 时不调用 revokeSession，仍返回 204 并下发清除 cookie', async () => {
  let revokeCalled = false
  const ctx = makeCtx({
    adminAuth: {
      async revokeSession() {
        revokeCalled = true
      },
    },
  })
  const req = new Request('https://gw/api/v1/admin/auth/logout', { method: 'POST' })
  const res = await logout(req, ctx)
  expect(res.status).toBe(204)
  expect(revokeCalled).toBe(false)
  expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
})

// ---------------------------------------------------------------------------
// me
// ---------------------------------------------------------------------------

test('me：未登录（无 cookie）返回 401 missing_admin_session', async () => {
  const ctx = makeCtx()
  const req = new Request('https://gw/api/v1/admin/auth/me')
  const res = await me(req, ctx)
  expect(res.status).toBe(401)
  expect((await res.json()).error).toBe('missing_admin_session')
})

test('me：会话无效返回 401 invalid_admin_session', async () => {
  const ctx = makeCtx({
    adminAuth: {
      async verifySession() {
        throw new AdminSessionInvalidError()
      },
    },
  })
  const req = authedRequest('https://gw/api/v1/admin/auth/me')
  const res = await me(req, ctx)
  expect(res.status).toBe(401)
  expect((await res.json()).error).toBe('invalid_admin_session')
})

test('me：已登录返回 200 与 identity', async () => {
  const ctx = makeCtx()
  const req = authedRequest('https://gw/api/v1/admin/auth/me')
  const res = await me(req, ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual(ADMIN_IDENTITY)
})

// ---------------------------------------------------------------------------
// listAccounts
// ---------------------------------------------------------------------------

test('listAccounts：未登录返回 401，且不查询 store', async () => {
  let listCalled = false
  const ctx = makeCtx({
    adminAuth: {
      async verifySession() {
        throw new AdminSessionInvalidError()
      },
    },
    adminStore: {
      async listAccounts() {
        listCalled = true
        return []
      },
    },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts')
  const res = await listAccounts(req, ctx)
  expect(res.status).toBe(401)
  expect(listCalled).toBe(false)
})

test('listAccounts：认证通过时返回账号列表，且响应体绝不包含 passwordHash', async () => {
  const accounts: AdminAccount[] = [
    { id: 'admin-1', username: 'alice', passwordHash: 'super-secret-hash-should-not-leak', createdAt: 1000 },
    { id: 'admin-2', username: 'bob', passwordHash: 'another-secret-hash', createdAt: 2000 },
  ]
  const ctx = makeCtx({
    adminStore: {
      async listAccounts() {
        return accounts
      },
    },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts')

  const res = await listAccounts(req, ctx)
  expect(res.status).toBe(200)

  const rawText = await res.text()
  expect(rawText).not.toContain('passwordHash')
  expect(rawText).not.toContain('super-secret-hash-should-not-leak')
  expect(rawText).not.toContain('another-secret-hash')

  const body = JSON.parse(rawText) as unknown
  // toEqual 会核对完整字段集合（多一个 passwordHash 键也会导致失败），
  // 与上面按原始文本查字符串的断言互为补充。
  expect(body).toEqual([
    { id: 'admin-1', username: 'alice', createdAt: 1000 },
    { id: 'admin-2', username: 'bob', createdAt: 2000 },
  ])
})

// ---------------------------------------------------------------------------
// createAccount
// ---------------------------------------------------------------------------

test('createAccount：未登录返回 401', async () => {
  const ctx = makeCtx({
    adminAuth: {
      async verifySession() {
        throw new AdminSessionInvalidError()
      },
    },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x', password: 'y' }),
  })
  const res = await createAccount(req, ctx)
  expect(res.status).toBe(401)
})

test('createAccount：缺少用户名或密码返回 400', async () => {
  const ctx = makeCtx()
  const req = authedRequest('https://gw/api/v1/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'onlyusername' }),
  })
  const res = await createAccount(req, ctx)
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('missing_fields')
})

test('createAccount：用户名已存在返回 409，且不调用 store.createAccount', async () => {
  let createCalled = false
  const ctx = makeCtx({
    adminStore: {
      async findByUsername(username) {
        expect(username).toBe('taken-name')
        return { id: 'existing-1', username: 'taken-name', passwordHash: 'h', createdAt: 1 }
      },
      async createAccount() {
        createCalled = true
      },
    },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'taken-name', password: 'whatever' }),
  })
  const res = await createAccount(req, ctx)
  expect(res.status).toBe(409)
  expect((await res.json()).error).toBe('username_taken')
  expect(createCalled).toBe(false)
})

test('createAccount：成功创建返回 201，调用了 hashPassword 与 store.createAccount', async () => {
  const recorded: {
    input: { id: string; username: string; passwordHash: string; now: number } | null
  } = { input: null }
  const ctx = makeCtx({
    now: () => 5000,
    adminAuth: {
      async hashPassword(password) {
        expect(password).toBe('new-pass-123')
        return 'hashed:new-pass-123'
      },
    },
    adminStore: {
      async findByUsername() {
        return null
      },
      async createAccount(input) {
        recorded.input = input
      },
    },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'newuser', password: 'new-pass-123' }),
  })
  const res = await createAccount(req, ctx)
  expect(res.status).toBe(201)
  const body = (await res.json()) as { id: string; username: string }
  expect(body.username).toBe('newuser')
  expect(typeof body.id).toBe('string')
  expect(recorded.input).toEqual({
    id: body.id,
    username: 'newuser',
    passwordHash: 'hashed:new-pass-123',
    now: 5000,
  })
})

// ---------------------------------------------------------------------------
// deleteAccount
// ---------------------------------------------------------------------------

test('deleteAccount：未登录返回 401', async () => {
  const ctx = makeCtx({
    adminAuth: {
      async verifySession() {
        throw new AdminSessionInvalidError()
      },
    },
    params: { id: 'admin-x' },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts/admin-x', { method: 'DELETE' })
  const res = await deleteAccount(req, ctx)
  expect(res.status).toBe(401)
})

test('deleteAccount：只剩最后一个账号时拒绝删除（409），且不会真的调用 store.deleteAccount', async () => {
  let deleteCalled = false
  const ctx = makeCtx({
    adminStore: {
      async countAccounts() {
        return 1
      },
      async deleteAccount() {
        deleteCalled = true
        return true
      },
    },
    params: { id: 'the-only-admin' },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts/the-only-admin', { method: 'DELETE' })
  const res = await deleteAccount(req, ctx)
  expect(res.status).toBe(409)
  expect((await res.json()).error).toBe('cannot_delete_last_account')
  expect(deleteCalled).toBe(false)
})

test('deleteAccount：目标账号不存在返回 404，且不调用 revokeAllSessionsFor', async () => {
  let revokeCalled = false
  const ctx = makeCtx({
    adminStore: {
      async countAccounts() {
        return 2
      },
      async deleteAccount() {
        return false
      },
    },
    adminAuth: {
      async revokeAllSessionsFor() {
        revokeCalled = true
      },
    },
    params: { id: 'does-not-exist' },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts/does-not-exist', { method: 'DELETE' })
  const res = await deleteAccount(req, ctx)
  expect(res.status).toBe(404)
  expect((await res.json()).error).toBe('account_not_found')
  expect(revokeCalled).toBe(false)
})

test('deleteAccount：成功删除后返回 204，并调用 revokeAllSessionsFor(targetId) 使其全部会话立即失效', async () => {
  const recorded: { deletedId: string | null; revokedId: string | null } = {
    deletedId: null,
    revokedId: null,
  }
  const ctx = makeCtx({
    adminStore: {
      async countAccounts() {
        return 2
      },
      async deleteAccount(id) {
        recorded.deletedId = id
        return true
      },
    },
    adminAuth: {
      async revokeAllSessionsFor(adminId) {
        recorded.revokedId = adminId
      },
    },
    params: { id: 'admin-to-remove' },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts/admin-to-remove', { method: 'DELETE' })
  const res = await deleteAccount(req, ctx)
  expect(res.status).toBe(204)
  expect(recorded.deletedId).toBe('admin-to-remove')
  expect(recorded.revokedId).toBe('admin-to-remove')
})
