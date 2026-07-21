import type { ActorIdentity } from '../domain/types'
import type { AuthStore } from '../store/auth'

/**
 * 账号不存在时也要跑一次 verify，否则「跳过昂贵的 argon2 校验」会让响应时间
 * 泄露 client_id 是否存在（枚举预言机）。这里预先算一个与真实密钥同算法
 * （argon2id，见 store 里 service_accounts.secret_hash 的生成方式）的 dummy hash，
 * 账号缺失时对它做一次等价耗时的校验。模块加载时算一次即可。
 */
const DUMMY_HASH_PROMISE = Bun.password.hash('invalid-placeholder-not-a-real-secret', {
  algorithm: 'argon2id',
})

/**
 * 统一的失败原因，不区分「账号不存在」「密钥错误」「已禁用」「已过期」——
 * 这些细节只用于内部日志排查，绝不能通过异常类型或消息暴露给调用方，
 * 否则等于给攻击者提供了一个账号是否存在/是否启用的探测预言机。
 */
export class ServiceAuthError extends Error {
  constructor() {
    super('invalid service account credentials')
    this.name = 'ServiceAuthError'
  }
}

export interface ServiceAuthDeps {
  store: Pick<AuthStore, 'findServiceAccount'>
}

export interface ServiceAuth {
  authenticate(clientId: string, clientSecret: string, now: number): Promise<ActorIdentity>
}

export function createServiceAuth(deps: ServiceAuthDeps): ServiceAuth {
  return {
    async authenticate(clientId, clientSecret, now) {
      const account = await deps.store.findServiceAccount(clientId)
      // 账号不存在时对 dummy hash 校验：耗时与真实校验一致，时序不可区分。
      const hashToCheck = account?.secretHash ?? (await DUMMY_HASH_PROMISE)
      const secretOk = await Bun.password.verify(clientSecret, hashToCheck)

      // 所有失败原因合并判定，统一抛同一错误：不区分不存在/密钥错/已禁用/已过期。
      if (
        account === null ||
        !secretOk ||
        !account.enabled ||
        (account.expiresAt !== null && now >= account.expiresAt)
      ) {
        throw new ServiceAuthError()
      }

      return { kind: 'service_account', wecomUserId: null, tmUserId: account.tmUserId }
    },
  }
}
