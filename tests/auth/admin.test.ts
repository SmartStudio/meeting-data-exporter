import { beforeAll, expect, test } from 'bun:test'
import {
  createAdminAuth,
  AdminAuthError,
  AdminSessionInvalidError,
  ADMIN_SESSION_REMEMBER_DAYS,
  ADMIN_SESSION_SHORT_HOURS,
} from '../../src/auth/admin'
import { hashToken } from '../../src/auth/tokens'
import type { AdminAccount, AdminSession, AdminStore } from '../../src/store/admin'

let correctHash: string

beforeAll(async () => {
  correctHash = await Bun.password.hash('s3cr3t-pass', { algorithm: 'argon2id' })
})

function baseAccount(overrides: Partial<AdminAccount> = {}): AdminAccount {
  return {
    id: 'admin-1',
    username: 'alice',
    passwordHash: correctHash,
    createdAt: 1000,
    ...overrides,
  }
}

/**
 * 内存版 AdminStore：与 tests/auth/service.test.ts 的 memServiceAccountStore
 * 同一种手法——用 Map 存状态，只服务于 AdminAuth 这一层的行为验证，
 * 不重新验证 store 层的 SQL 语义（那是 tests/store/admin.test.ts 的职责）。
 */
function memAdminStore(opts: { accounts?: AdminAccount[] } = {}): AdminStore {
  const byId = new Map((opts.accounts ?? []).map((a) => [a.id, a]))
  const byUsername = new Map((opts.accounts ?? []).map((a) => [a.username, a]))
  const sessions = new Map<string, AdminSession>()

  return {
    async countAccounts() {
      return byId.size
    },
    async findByUsername(username) {
      return byUsername.get(username) ?? null
    },
    async findById(id) {
      return byId.get(id) ?? null
    },
    async listAccounts() {
      return [...byId.values()]
    },
    async createAccount(input) {
      const account: AdminAccount = {
        id: input.id,
        username: input.username,
        passwordHash: input.passwordHash,
        createdAt: input.now,
      }
      byId.set(account.id, account)
      byUsername.set(account.username, account)
    },
    async deleteAccount(id) {
      const account = byId.get(id)
      if (!account) return false
      byId.delete(id)
      byUsername.delete(account.username)
      return true
    },
    async createSession(input) {
      sessions.set(input.tokenHash, { adminId: input.adminId, expiresAt: input.expiresAt })
    },
    async findSessionByTokenHash(tokenHash) {
      return sessions.get(tokenHash) ?? null
    },
    async touchSessionExpiry(tokenHash, newExpiresAt) {
      const s = sessions.get(tokenHash)
      if (s) sessions.set(tokenHash, { ...s, expiresAt: newExpiresAt })
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash)
    },
    async deleteSessionsByAdminId(adminId) {
      let n = 0
      for (const [k, v] of sessions) {
        if (v.adminId === adminId) {
          sessions.delete(k)
          n++
        }
      }
      return n
    },
  }
}

/** 包一层调用计数的 touchSessionExpiry，委托给原实现，用于断言滑动续期是否真的触发 */
function withTouchSpy(store: AdminStore): { store: AdminStore; touchCalls: () => number } {
  let count = 0
  const original = store.touchSessionExpiry.bind(store)
  const spied: AdminStore = {
    ...store,
    async touchSessionExpiry(tokenHash, newExpiresAt) {
      count++
      return original(tokenHash, newExpiresAt)
    },
  }
  return { store: spied, touchCalls: () => count }
}

test('正确密码：authenticate 成功并返回账号', async () => {
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })

  const account = await auth.authenticate('alice', 's3cr3t-pass')
  expect(account).toEqual(baseAccount())
})

test('错误密码：拒绝并抛 AdminAuthError', async () => {
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })

  await expect(auth.authenticate('alice', 'wrong-pass')).rejects.toThrow(AdminAuthError)
})

test('账号不存在：拒绝并抛 AdminAuthError', async () => {
  const store = memAdminStore({ accounts: [] })
  const auth = createAdminAuth({ store })

  await expect(auth.authenticate('does-not-exist', 'any-pass')).rejects.toThrow(AdminAuthError)
})

test('账号不存在与密码错误：走同一条时序路径，统一抛同一错误（不可区分）', async () => {
  // 行为锁定：两条路径都必须抛 AdminAuthError。恒定时间属性由「账号不存在时
  // 也对 dummy hash 跑一次等价耗时的 verify」的实现保证（见 auth/admin.ts 的
  // DUMMY_HASH_PROMISE），与 tests/auth/service.test.ts 的对应用例同一手法：
  // 不做真的计时断言（那样会 flaky），只锁定"两条路径不可区分"这个可观察行为。
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })

  await expect(auth.authenticate('does-not-exist', 'any-pass')).rejects.toThrow(AdminAuthError)
  await expect(auth.authenticate('alice', 'wrong-pass')).rejects.toThrow(AdminAuthError)
})

test('hashPassword：产出的哈希可被 Bun.password.verify 校验通过', async () => {
  const store = memAdminStore({ accounts: [] })
  const auth = createAdminAuth({ store })

  const hash = await auth.hashPassword('a-new-password')
  expect(await Bun.password.verify('a-new-password', hash)).toBe(true)
})

test('issueSession：勾选"记住此设备"时，有效期为 30 天', async () => {
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })
  const now = 1_000_000

  const { expiresAt } = await auth.issueSession('admin-1', true, now)
  expect(expiresAt - now).toBe(ADMIN_SESSION_REMEMBER_DAYS * 86400)
})

test('issueSession：不勾选"记住此设备"时，有效期为 12 小时', async () => {
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })
  const now = 1_000_000

  const { expiresAt } = await auth.issueSession('admin-1', false, now)
  expect(expiresAt - now).toBe(ADMIN_SESSION_SHORT_HOURS * 3600)
})

test('issueSession 签发的令牌可被 verifySession 立即校验通过', async () => {
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })
  const now = 1_000_000

  const { token } = await auth.issueSession('admin-1', true, now)
  const identity = await auth.verifySession(token, now)
  expect(identity).toEqual({ adminId: 'admin-1', username: 'alice' })
})

test('verifySession：不存在的 token 抛 AdminSessionInvalidError', async () => {
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })

  await expect(auth.verifySession('never-issued-token', 1_000_000)).rejects.toThrow(
    AdminSessionInvalidError,
  )
})

test('verifySession：已过期的 token 抛 AdminSessionInvalidError', async () => {
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })
  const now = 1_000_000

  const { token, expiresAt } = await auth.issueSession('admin-1', false, now)
  await expect(auth.verifySession(token, expiresAt)).rejects.toThrow(AdminSessionInvalidError)
})

test('verifySession：账号已被移除（findById 返回 null）时会话立即失效', async () => {
  const store = memAdminStore({ accounts: [] }) // 账号不存在——模拟"账号已被删除"
  const token = 'ghost-admin-token'
  await store.createSession({
    tokenHash: hashToken(token),
    adminId: 'admin-ghost',
    expiresAt: 9_999_999,
    now: 1_000_000,
  })
  const auth = createAdminAuth({ store })

  await expect(auth.verifySession(token, 1_000_000)).rejects.toThrow(AdminSessionInvalidError)
})

test('verifySession：剩余有效期低于阈值时触发滑动续期', async () => {
  const baseStore = memAdminStore({ accounts: [baseAccount()] })
  const { store, touchCalls } = withTouchSpy(baseStore)
  const now = 1_000_000
  const token = 'about-to-expire-token'
  // 剩余有效期 400000s < 阈值 432000s (5 天)
  await store.createSession({ tokenHash: hashToken(token), adminId: 'admin-1', expiresAt: now + 400_000, now })
  const auth = createAdminAuth({ store })

  await auth.verifySession(token, now)

  expect(touchCalls()).toBe(1)
  const session = await store.findSessionByTokenHash(hashToken(token))
  expect(session?.expiresAt).toBe(now + ADMIN_SESSION_REMEMBER_DAYS * 86400)
})

test('verifySession：剩余有效期高于阈值时不触发滑动续期', async () => {
  const baseStore = memAdminStore({ accounts: [baseAccount()] })
  const { store, touchCalls } = withTouchSpy(baseStore)
  const now = 1_000_000
  const token = 'freshly-issued-token'
  // 剩余有效期 1000000s > 阈值 432000s (5 天)
  const originalExpiresAt = now + 1_000_000
  await store.createSession({ tokenHash: hashToken(token), adminId: 'admin-1', expiresAt: originalExpiresAt, now })
  const auth = createAdminAuth({ store })

  await auth.verifySession(token, now)

  expect(touchCalls()).toBe(0)
  const session = await store.findSessionByTokenHash(hashToken(token))
  expect(session?.expiresAt).toBe(originalExpiresAt)
})

test('revokeSession：吊销后该 token 无法再通过 verifySession', async () => {
  const store = memAdminStore({ accounts: [baseAccount()] })
  const auth = createAdminAuth({ store })
  const now = 1_000_000

  const { token } = await auth.issueSession('admin-1', true, now)
  await auth.revokeSession(token)

  await expect(auth.verifySession(token, now)).rejects.toThrow(AdminSessionInvalidError)
})

test('revokeAllSessionsFor：撤销该管理员的全部会话，不影响其他管理员', async () => {
  const store = memAdminStore({ accounts: [baseAccount(), baseAccount({ id: 'admin-2', username: 'bob' })] })
  const auth = createAdminAuth({ store })
  const now = 1_000_000

  const sessionA1 = await auth.issueSession('admin-1', true, now)
  const sessionA2 = await auth.issueSession('admin-1', true, now)
  const sessionB1 = await auth.issueSession('admin-2', true, now)

  await auth.revokeAllSessionsFor('admin-1')

  await expect(auth.verifySession(sessionA1.token, now)).rejects.toThrow(AdminSessionInvalidError)
  await expect(auth.verifySession(sessionA2.token, now)).rejects.toThrow(AdminSessionInvalidError)
  // 另一个管理员的会话不受影响
  const identity = await auth.verifySession(sessionB1.token, now)
  expect(identity).toEqual({ adminId: 'admin-2', username: 'bob' })
})
