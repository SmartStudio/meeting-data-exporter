import type { AdminAccount, AdminRole, AdminStore } from '../store/admin'
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
  /**
   * 角色（阶段 5 · A8，spec §2）。**每一个写 handler 都读它**，所以它必须
   * 从会话校验里带出来，而不是让 handler 各自再查一次库——各查各的意味着
   * 「有一处忘了查」，而那一处的表现是一个只读账号能改规则，且不会有任何报错。
   *
   * 值来自 `AdminStore` 的 `parseAdminRole`：库里认不出来的取值一律折成
   * `readonly`。**这一层不会给出 `undefined`**，落到安全侧的判断在更下面。
   */
  role: AdminRole
}

/** "记住此设备" 勾选时的会话有效期（spec.md §4.1 登录页文案原文即 30 天） */
export const ADMIN_SESSION_REMEMBER_DAYS = 30
/** 不勾选时的会话有效期——仍落库以支持"移除账号立即失效"，只是窗口短得多 */
export const ADMIN_SESSION_SHORT_HOURS = 12
/**
 * 剩余有效期低于此阈值才续期（而不是每次请求都续期）——避免管理员面板这种
 * 低频访问场景下，每次请求都触发一次 UPDATE，没有必要的写放大。
 *
 * 注意这个阈值只对"记住此设备"的长会话有意义：它比短会话的整个生命周期
 * （ADMIN_SESSION_SHORT_HOURS = 12 小时）还长得多，所以短会话从签发那一刻起
 * 剩余有效期就已经在阈值之下。滑动续期必须先判断"这是不是一个长会话"，
 * 不能只看剩余时间，见 verifySession 里 isRememberSession 的说明。
 */
const TOUCH_THRESHOLD_SEC = 5 * 24 * 3600

/**
 * 管理员密码最小长度。两条建号路径共用同一条门槛：
 * scripts/admin-bootstrap.ts（首个账号引导）与 POST /api/v1/admin/accounts
 * （控制台"添加运维人员"）。同一套凭证系统只能有一个门槛——两处各写各的，
 * 结果就是"命令行建的号必须 8 位、控制台建的号一个字符也能过"。
 */
export const ADMIN_PASSWORD_MIN_LENGTH = 8

/** 密码是否满足最小长度要求。两条建号路径都调它，别再各自写 `.length < 8`。 */
export function isAdminPasswordAcceptable(password: string): boolean {
  return password.length >= ADMIN_PASSWORD_MIN_LENGTH
}

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
  /**
   * 吊销这个账号**除当前这一条之外**的全部会话，返回撤销条数（阶段 5 · A8）。
   *
   * 改密码之后调它：旧密码换来的会话不该在密码换掉之后还活着（spec §11 缺口 5）。
   * `keepToken` 是**明文令牌**，与 revokeSession 的入参同型——哈希在这一层做，
   * 调用方（handler）拿到的就是 cookie 里那个明文，不必知道存的是哈希。
   */
  revokeOtherSessionsFor(adminId: string, keepToken: string): Promise<number>
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

      // 滑动续期：只对"记住此设备"签发的长会话生效，且只在剩余有效期跌破阈值时
      // 才写库。
      //
      // 判据是会话的**总时长**（expiresAt - createdAt），不是剩余时长：签发时勾没勾
      // "记住此设备"没有单独落库，但两种会话的窗口长度本来就是两个数量级
      // （30 天 vs 12 小时），总时长足以还原当初签的是哪一种。
      //
      // 只看剩余时长是一个真实的安全漏洞（本轮修复的就是它）：短会话的整个生命周期
      // 12 小时 < 阈值 5 天，于是"剩余不足阈值"从签发那一刻起就成立，登录后的第一个
      // 请求（控制台 AppShell 一挂载就打 /auth/me）就会把一个操作员**明确拒绝**了
      // 30 天持久化的会话，悄悄续成 30 天——共用机器、借来的笔记本上尤其危险，
      // 而且当事人完全无从察觉。短会话就该 12 小时后干脆地过期，不进这条分支。
      const isRememberSession = session.expiresAt - session.createdAt >= ADMIN_SESSION_REMEMBER_DAYS * 86400
      if (isRememberSession && session.expiresAt - now < TOUCH_THRESHOLD_SEC) {
        await deps.store.touchSessionExpiry(tokenHash, now + ADMIN_SESSION_REMEMBER_DAYS * 86400)
      }

      return { adminId: account.id, username: account.username, role: account.role }
    },

    async revokeSession(token) {
      await deps.store.deleteSession(hashToken(token))
    },

    async revokeAllSessionsFor(adminId) {
      await deps.store.deleteSessionsByAdminId(adminId)
    },

    async revokeOtherSessionsFor(adminId, keepToken) {
      return deps.store.deleteSessionsByAdminIdExcept(adminId, hashToken(keepToken))
    },
  }
}
