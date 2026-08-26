import { randomBytes } from 'node:crypto'
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
// 标记已处理，避免加载期哈希意外失败时的未处理 rejection 警告；authenticate 内仍会 await 它
DUMMY_HASH_PROMISE.catch(() => {})

/**
 * 新采集程序的凭据明文。URL 安全的强随机串（32 字节），避免出现需要转义的字符——
 * 它会被贴进对接方的 shell `export` 语句或 YAML 配置。
 *
 * 与 `hashServiceSecret` 一起放在这个文件里，而不是放在建号那一侧（控制台的
 * `handlers/console/grants.ts`、`scripts/seed-dev.ts`），是**结构上的**理由：
 * 校验凭据的 `Bun.password.verify` 就在下面几行，产出与校验同处一个文件，
 * 「两边用的不是同一套哈希」这种事就没有发生的余地。计划 §3 T7 第 2 条写的
 * 「复用 `src/auth/service.ts`，不要另写一套」指的就是这件事——只是这个文件此前
 * 只有校验侧，没有可复用的产出侧，于是在这里补上。
 */
export function generateServiceSecret(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 凭据明文 → 入库的哈希。**算法必须是 argon2id**：`Bun.password.verify` 会从哈希串
 * 自带的前缀里认算法，所以换成别的算法照样"能用"，不会有任何报错——直到某天有人
 * 想统一强度参数时才发现库里躺着两三种哈希。唯一的产出点就是这里。
 */
export function hashServiceSecret(secret: string): Promise<string> {
  return Bun.password.hash(secret, { algorithm: 'argon2id' })
}

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

      // programId 取 service_accounts.id（= 传进来的 clientId），**不是 tmUserId**：
      // 采集权限栈（allow 栈）的主体是采集程序本身，一个人可能对应零个或多个
      // 服务账号，拿 tmUserId 当主体等于把「谁在跑这个程序」错认成「哪个程序」。
      return {
        kind: 'service_account',
        wecomUserId: null,
        tmUserId: account.tmUserId,
        programId: account.id,
      }
    },
  }
}
