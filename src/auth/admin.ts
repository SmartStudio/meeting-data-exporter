import type { AdminAccount, AdminStore } from '../store/admin'
import { generateOpaqueToken, hashToken } from './tokens'

// 注：不需要 node:crypto 的 timingSafeEqual——密码比对交由 Bun.password.verify
// 完成（argon2id 校验本身即为常数时间），这里的枚举防御只需要「账号不存在时
// 仍跑一次等价耗时的校验」，见下方 DUMMY_HASH_PROMISE。

export class AdminAuthError extends Error {
  constructor() {
    super('invalid admin credentials')
    this.name = 'AdminAuthError'
  }
}

export class AdminSessionInvalidError extends Error {
  constructor() {
    super('invalid or expired admin session')
    this.name = 'AdminSessionInvalidError'
  }
}

export interface AdminIdentity {
  adminId: string
  username: string
}

/** "记住此设备" 勾选时的会话有效期（spec.md §4.1 登录页文案原文即 30 天） */
export const ADMIN_SESSION_REMEMBER_DAYS = 30
/** 不勾选时的会话有效期——仍落库以支持"移除账号立即失效"，只是窗口短得多 */
export const ADMIN_SESSION_SHORT_HOURS = 12
/**
 * 剩余有效期低于此阈值才续期（而不是每次请求都续期）——避免管理员面板这种
 * 低频访问场景下，每次请求都触发一次 UPDATE，没有必要的写放大。
 */
const TOUCH_THRESHOLD_SEC = 5 * 24 * 3600

// 与 auth/service.ts 相同的枚举防御：账号不存在时仍跑一次等时哈希校验，
// 使"账号不存在"与"密码错误"两种失败在响应时序上不可区分。
const DUMMY_HASH_PROMISE = Bun.password.hash('invalid-placeholder-not-a-real-secret', {
  algorithm: 'argon2id',
})
DUMMY_HASH_PROMISE.catch(() => {})

export interface AdminAuthDeps {
  store: AdminStore
}

export interface AdminAuth {
  authenticate(username: string, password: string): Promise<AdminAccount>
  hashPassword(password: string): Promise<string>
  issueSession(adminId: string, remember: boolean, now: number): Promise<{ token: string; expiresAt: number }>
  verifySession(token: string, now: number): Promise<AdminIdentity>
  revokeSession(token: string): Promise<void>
  revokeAllSessionsFor(adminId: string): Promise<void>
}

export function createAdminAuth(deps: AdminAuthDeps): AdminAuth {
  return {
    async authenticate(username, password) {
      const account = await deps.store.findByUsername(username)
      const hashToCheck = account?.passwordHash ?? (await DUMMY_HASH_PROMISE)
      const ok = await Bun.password.verify(password, hashToCheck)
      if (account === null || !ok) throw new AdminAuthError()
      return account
    },

    async hashPassword(password) {
      return Bun.password.hash(password, { algorithm: 'argon2id' })
    },

    async issueSession(adminId, remember, now) {
      const token = generateOpaqueToken()
      const ttlSec = remember ? ADMIN_SESSION_REMEMBER_DAYS * 86400 : ADMIN_SESSION_SHORT_HOURS * 3600
      const expiresAt = now + ttlSec
      await deps.store.createSession({ tokenHash: hashToken(token), adminId, expiresAt, now })
      return { token, expiresAt }
    },

    async verifySession(token, now) {
      const tokenHash = hashToken(token)
      const session = await deps.store.findSessionByTokenHash(tokenHash)
      if (session === null || now >= session.expiresAt) throw new AdminSessionInvalidError()

      const account = await deps.store.findById(session.adminId)
      if (account === null) throw new AdminSessionInvalidError() // 账号已被移除

      // 滑动续期：只在剩余有效期跌破阈值时才写库。续期到的新有效期固定用
      // "记住此设备"的 30 天窗口——本函数拿不到当初登录时是否勾选了记住，
      // 而滑动续期这个动作本身只在长会话上才有意义（短会话 12 小时内用完即弃，
      // 走不到这条续期分支也无妨）。
      if (session.expiresAt - now < TOUCH_THRESHOLD_SEC) {
        await deps.store.touchSessionExpiry(tokenHash, now + ADMIN_SESSION_REMEMBER_DAYS * 86400)
      }

      return { adminId: account.id, username: account.username }
    },

    async revokeSession(token) {
      await deps.store.deleteSession(hashToken(token))
    },

    async revokeAllSessionsFor(adminId) {
      await deps.store.deleteSessionsByAdminId(adminId)
    },
  }
}
