import type { ActorIdentity } from '../domain/types'
import type { AuthStore } from '../store/auth'

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
      if (account === null) throw new ServiceAuthError()

      const valid = await Bun.password.verify(clientSecret, account.secretHash)
      if (!valid) throw new ServiceAuthError()

      if (!account.enabled) throw new ServiceAuthError()
      if (account.expiresAt !== null && now >= account.expiresAt) throw new ServiceAuthError()

      return { kind: 'service_account', wecomUserId: null, tmUserId: account.tmUserId }
    },
  }
}
