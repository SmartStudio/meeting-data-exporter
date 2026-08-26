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
import { login, logout, me, listAccounts, createAccount, deleteAccount, changePassword }
  from '../../../src/http/handlers/console/auth'
import { AdminAuthError, AdminSessionInvalidError, ADMIN_PASSWORD_MIN_LENGTH } from '../../../src/auth/admin'
import type { AdminAuth, AdminIdentity } from '../../../src/auth/admin'
import type { AdminAccount, AdminStore } from '../../../src/store/admin'
import type { AppDeps, RouteCtx } from '../../../src/http/router'
import type { AuditEntry } from '../../../src/store/audit'
import { ADMIN_SESSION_COOKIE } from '../../../src/http/middleware'

const ADMIN_IDENTITY: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }

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
    async revokeOtherSessionsFor() {
      throw new Error('fakeAdminAuth.revokeOtherSessionsFor not stubbed for this test')
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
    async deleteSessionsByAdminIdExcept() {
      throw new Error('fakeAdminStore.deleteSessionsByAdminIdExcept not stubbed for this test')
    },
    async updatePassword() {
      throw new Error('fakeAdminStore.updatePassword not stubbed for this test')
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

interface Ctx {
  ctx: RouteCtx
  /** 这一族 handler 落下的审计行（阶段 5 · A8：账号写操作也要进 audit_log） */
  audits: AuditEntry[]
}

/**
 * 只造 handler 真正读到的那几个字段（见文件头）。`auditStore` 是阶段 5 · A8
 * 加进来的第五个——建号 / 删号 / 改密码三条路径都要落审计。
 */
function makeCtxFull(overrides: CtxOverrides = {}): Ctx {
  const audits: AuditEntry[] = []
  const deps = {
    now: overrides.now ?? (() => 1_000_000),
    adminAuth: fakeAdminAuth(overrides.adminAuth),
    adminStore: fakeAdminStore(overrides.adminStore),
    cookieSecure: overrides.cookieSecure ?? false,
    auditStore: {
      async record(entry: AuditEntry) {
        audits.push(entry)
      },
    },
  }
  return { ctx: { params: overrides.params ?? {}, deps: deps as unknown as AppDeps }, audits }
}

function makeCtx(overrides: CtxOverrides = {}): RouteCtx {
  return makeCtxFull(overrides).ctx
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
  const account: AdminAccount = { id: 'admin-1', username: 'alice', passwordHash: 'h', createdAt: 1000, role: 'admin' }
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
  const account: AdminAccount = { id: 'admin-1', username: 'alice', passwordHash: 'h', createdAt: 1000, role: 'admin' }
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
  const account: AdminAccount = { id: 'admin-1', username: 'alice', passwordHash: 'h', createdAt: 1000, role: 'admin' }
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
    { id: 'admin-1', username: 'alice', passwordHash: 'super-secret-hash-should-not-leak', createdAt: 1000, role: 'admin' },
    { id: 'admin-2', username: 'bob', passwordHash: 'another-secret-hash', createdAt: 2000, role: 'admin' },
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
    // role 是阶段 5 · A8 加的：spec §4.11 的账号表要显示每个人是什么角色
    { id: 'admin-1', username: 'alice', createdAt: 1000, role: 'admin' },
    { id: 'admin-2', username: 'bob', createdAt: 2000, role: 'admin' },
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

test('createAccount：密码短于最小长度返回 400 password_too_short，且不查库、不建号', async () => {
  // 门槛取自 src/auth/admin.ts 的常量而不是在测试里写死 8：这条用例要锁的是
  // "两条建号路径共用同一个门槛"，把数字抄一遍就等于又开了第三份定义。
  let findCalled = false
  let createCalled = false
  const ctx = makeCtx({
    adminStore: {
      async findByUsername() {
        findCalled = true
        return null
      },
      async createAccount() {
        createCalled = true
      },
    },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'newuser', password: 'x'.repeat(ADMIN_PASSWORD_MIN_LENGTH - 1) }),
  })
  const res = await createAccount(req, ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'password_too_short', minLength: ADMIN_PASSWORD_MIN_LENGTH })
  expect(findCalled).toBe(false)
  expect(createCalled).toBe(false)
})

test('createAccount：密码正好等于最小长度时放行（边界不多不少）', async () => {
  const recorded: { password: string | null } = { password: null }
  const ctx = makeCtx({
    adminAuth: {
      async hashPassword(password) {
        recorded.password = password
        return 'hashed'
      },
    },
    adminStore: {
      async findByUsername() {
        return null
      },
      async createAccount() {},
    },
  })
  const minLengthPassword = 'x'.repeat(ADMIN_PASSWORD_MIN_LENGTH)
  const req = authedRequest('https://gw/api/v1/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'newuser', password: minLengthPassword }),
  })
  const res = await createAccount(req, ctx)
  expect(res.status).toBe(201)
  expect(recorded.password).toBe(minLengthPassword)
})

test('createAccount：用户名已存在返回 409，且不调用 store.createAccount', async () => {
  let createCalled = false
  const ctx = makeCtx({
    adminStore: {
      async findByUsername(username) {
        expect(username).toBe('taken-name')
        return { id: 'existing-1', username: 'taken-name', passwordHash: 'h', createdAt: 1, role: 'admin' }
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
    input: Parameters<AdminStore['createAccount']>[0] | null
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
    // 不给 role 时建出来的是数据管理员——这条端点在 009 之前建的就是它，
    // 而 spec §4.11 那个按钮写的是「添加运维人员」
    role: 'admin',
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


// ---------------------------------------------------------------------------
// changePassword（阶段 5 · A8，spec §11 缺口 5）
// ---------------------------------------------------------------------------

/** 一份「校验得过 old-pass、认得出 wrong-pass」的 AdminAuth + AdminStore 组合 */
function passwordRig(over: {
  currentPassword?: string
  updateReturns?: boolean
  revokedCount?: number
} = {}) {
  const current = over.currentPassword ?? 'old-pass-12345'
  const calls = {
    authenticate: [] as Array<{ username: string; password: string }>,
    updated: [] as Array<{ id: string; hash: string }>,
    revoked: [] as Array<{ adminId: string; keepToken: string }>,
  }
  const rig = makeCtxFull({
    now: () => 7000,
    adminAuth: {
      async authenticate(username, password) {
        calls.authenticate.push({ username, password })
        if (password !== current) throw new AdminAuthError()
        return {
          id: 'admin-1', username, passwordHash: 'stored', createdAt: 1000, role: 'admin',
        }
      },
      async hashPassword(pw) {
        return `hashed:${pw}`
      },
      async revokeOtherSessionsFor(adminId, keepToken) {
        calls.revoked.push({ adminId, keepToken })
        return over.revokedCount ?? 2
      },
    },
    adminStore: {
      async updatePassword(id, hash) {
        calls.updated.push({ id, hash })
        return over.updateReturns ?? true
      },
    },
  })
  return { ...rig, calls }
}

function passwordRequest(body: unknown): Request {
  return authedRequest('https://gw/api/v1/admin/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('changePassword：未登录返回 401，且不校验也不改任何密码', async () => {
  const r = passwordRig()
  const req = new Request('https://gw/api/v1/admin/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'old-pass-12345', newPassword: 'new-pass-12345' }),
  })
  const res = await changePassword(req, r.ctx)
  expect(res.status).toBe(401)
  expect(r.calls.updated).toEqual([])
})

test('changePassword：缺字段返回 400', async () => {
  for (const body of [
    {},
    { currentPassword: 'x' },
    { newPassword: 'y' },
    { currentPassword: '', newPassword: 'new-pass-12345' },
    { currentPassword: 'old-pass-12345', newPassword: '' },
    { currentPassword: 123, newPassword: 'new-pass-12345' },
  ]) {
    const r = passwordRig()
    const res = await changePassword(passwordRequest(body), r.ctx)
    expect({ body, status: res.status }).toEqual({ body, status: 400 })
    expect(r.calls.updated).toEqual([])
  }
})

test('changePassword：新密码不够长返回 400，且回带 minLength（与建号那条路径同一份校验）', async () => {
  const r = passwordRig()
  const res = await changePassword(
    passwordRequest({ currentPassword: 'old-pass-12345', newPassword: 'short' }),
    r.ctx,
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    error: 'password_too_short',
    minLength: ADMIN_PASSWORD_MIN_LENGTH,
  })
  // 校验都没走到——不够长的密码不该先拿去跟当前密码比一遍
  expect(r.calls.authenticate).toEqual([])
})

test('changePassword：新旧相同返回 400（不然会显示「改成功了，另外 N 台设备已退出」而密码没变）', async () => {
  const r = passwordRig()
  const res = await changePassword(
    passwordRequest({ currentPassword: 'old-pass-12345', newPassword: 'old-pass-12345' }),
    r.ctx,
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ error: 'password_unchanged' })
  expect(r.calls.revoked).toEqual([])
})

test('changePassword：**必须校验当前密码**——密码错时 401，且一个字节都不写', async () => {
  // 只凭会话 cookie 就能改密码 = 一次 XSS 就能永久接管账号：偷到 cookie 的人
  // 把密码换掉，真正的主人再也登不进来，而 cookie 本身可能几小时后就过期了
  const r = passwordRig()
  const res = await changePassword(
    passwordRequest({ currentPassword: 'wrong-pass-9999', newPassword: 'new-pass-12345' }),
    r.ctx,
  )
  expect(res.status).toBe(401)
  expect(await res.json()).toMatchObject({ error: 'invalid_current_password' })
  expect(r.calls.updated).toEqual([])
  expect(r.calls.revoked).toEqual([])
  expect(r.audits).toEqual([])
})

test('changePassword：校验走的是当前会话对应的那个用户名（请求体里没有 adminId 这种字段）', async () => {
  const r = passwordRig()
  await changePassword(
    passwordRequest({
      currentPassword: 'old-pass-12345',
      newPassword: 'new-pass-12345',
      // 就算前端塞了别人的 id，也一个字都不该被采信
      adminId: 'someone-else',
      username: 'someone-else',
    }),
    r.ctx,
  )
  expect(r.calls.authenticate).toEqual([{ username: 'alice', password: 'old-pass-12345' }])
  expect(r.calls.updated).toEqual([{ id: 'admin-1', hash: 'hashed:new-pass-12345' }])
})

test('changePassword：成功后吊销其它会话、保留当前这一条，并把条数回给前端', async () => {
  const r = passwordRig({ revokedCount: 3 })
  const res = await changePassword(
    passwordRequest({ currentPassword: 'old-pass-12345', newPassword: 'new-pass-12345' }),
    r.ctx,
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ revokedOtherSessions: 3 })
  // 传下去的是 cookie 里那个明文令牌——当前这一条要留着，否则用户改完密码
  // 立刻 401，界面把一次成功的操作显示成「被踢出去了」
  expect(r.calls.revoked).toEqual([{ adminId: 'admin-1', keepToken: 'valid-session-token' }])
})

test('changePassword：账号在两步之间被删掉时返回 404，不装作改成功了', async () => {
  const r = passwordRig({ updateReturns: false })
  const res = await changePassword(
    passwordRequest({ currentPassword: 'old-pass-12345', newPassword: 'new-pass-12345' }),
    r.ctx,
  )
  expect(res.status).toBe(404)
  expect(await res.json()).toMatchObject({ error: 'account_not_found' })
  expect(r.calls.revoked).toEqual([])
})

test('changePassword：记审计，且 detail 里绝不出现密码或它的任何片段', async () => {
  const r = passwordRig({ revokedCount: 2 })
  const res = await changePassword(
    passwordRequest({ currentPassword: 'old-pass-12345', newPassword: 'brand-new-secret-777' }),
    r.ctx,
  )
  expect(res.status).toBe(200)

  expect(r.audits).toHaveLength(1)
  expect(r.audits[0]).toMatchObject({
    occurredAt: 7000,
    actorType: 'admin',
    actorId: 'admin-1',
    action: 'change_admin_password',
    meetingId: null,
    assetId: 'admin-1',
    decision: 'allow',
    clientKind: 'console',
  })
  const dumped = JSON.stringify(r.audits)
  expect(dumped).not.toContain('brand-new-secret-777')
  expect(dumped).not.toContain('old-pass-12345')
  // 片段也不行：审计日志会被备份、导出、复制进工单
  expect(dumped).not.toContain('brand-new')
  expect(dumped).not.toContain('secret-777')
  // 该说的是「谁在什么时候改了自己的密码、踢掉了几个会话」
  expect(r.audits[0]!.detail).toContain('2 个会话')
})

test('changePassword：只读角色也改得了自己的密码（挡住它防不住越权，只会让人无法自救）', async () => {
  const calls: string[] = []
  const rig = makeCtxFull({
    now: () => 7000,
    adminAuth: {
      async verifySession() {
        return { adminId: 'admin-ro', username: 'watcher', role: 'readonly' }
      },
      async authenticate(_u, _p) {
        return { id: 'admin-ro', username: 'watcher', passwordHash: 's', createdAt: 1, role: 'readonly' }
      },
      async hashPassword(pw) {
        return `hashed:${pw}`
      },
      async revokeOtherSessionsFor() {
        return 0
      },
    },
    adminStore: {
      async updatePassword(id) {
        calls.push(id)
        return true
      },
    },
  })
  const res = await changePassword(
    passwordRequest({ currentPassword: 'old-pass-12345', newPassword: 'new-pass-12345' }),
    rig.ctx,
  )
  expect(res.status).toBe(200)
  expect(calls).toEqual(['admin-ro'])
})

// ---------------------------------------------------------------------------
// me 下发 role（阶段 5 · A8）
// ---------------------------------------------------------------------------

test('me：把角色一并下发，前端照它降级界面', async () => {
  const ctx = makeCtx({
    adminAuth: {
      async verifySession() {
        return { adminId: 'admin-ro', username: 'watcher', role: 'readonly' }
      },
    },
  })
  const res = await me(authedRequest('https://gw/api/v1/admin/auth/me'), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ adminId: 'admin-ro', username: 'watcher', role: 'readonly' })
})

// ---------------------------------------------------------------------------
// 账号写操作也进 audit_log（阶段 5 · A8：管理员的每一次写操作都要留痕）
// ---------------------------------------------------------------------------

test('createAccount：成功建号落一行审计，角色写进 detail，密码一个字符都不进', async () => {
  const rig = makeCtxFull({
    now: () => 5000,
    adminStore: {
      async findByUsername() {
        return null
      },
      async createAccount() {},
    },
    adminAuth: {
      async hashPassword(pw) {
        return `hashed:${pw}`
      },
    },
  })
  const req = authedRequest('https://gw/api/v1/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'watcher', password: 'a-very-secret-pw', role: 'readonly' }),
  })
  const res = await createAccount(req, rig.ctx)
  expect(res.status).toBe(201)
  expect(await res.json()).toMatchObject({ username: 'watcher', role: 'readonly' })

  expect(rig.audits).toHaveLength(1)
  expect(rig.audits[0]).toMatchObject({ action: 'create_admin_account', actorId: 'admin-1' })
  expect(rig.audits[0]!.detail).toContain('readonly')
  expect(JSON.stringify(rig.audits)).not.toContain('a-very-secret-pw')
})

test('createAccount：认不出来的角色报 400，不悄悄折成某一个角色', async () => {
  // 前端把 readonly 写成别的拼法，应该当场看见，而不是建出一个角色与界面上
  // 勾选的不一样的账号
  const rig = makeCtxFull()
  const req = authedRequest('https://gw/api/v1/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x', password: 'a-long-enough-pw', role: 'read-only' }),
  })
  const res = await createAccount(req, rig.ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ error: 'invalid_role', allowed: ['admin', 'readonly'] })
})

test('deleteAccount：成功删号落一行审计', async () => {
  const rig = makeCtxFull({
    params: { id: 'admin-2' },
    adminStore: {
      async countAccounts() {
        return 2
      },
      async deleteAccount() {
        return true
      },
    },
    adminAuth: {
      async revokeAllSessionsFor() {},
    },
  })
  const res = await deleteAccount(
    authedRequest('https://gw/api/v1/admin/accounts/admin-2', { method: 'DELETE' }),
    rig.ctx,
  )
  expect(res.status).toBe(204)
  expect(rig.audits).toHaveLength(1)
  expect(rig.audits[0]).toMatchObject({
    action: 'delete_admin_account',
    actorId: 'admin-1',
    assetId: 'admin-2',
  })
})
