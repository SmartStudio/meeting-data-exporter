/**
 * 令牌桶限流器（进程内）。
 *
 * 【多实例说明】这是明确标注的「进程内内存状态」例外：桶不跨实例共享。
 * 网关部署在负载均衡后方，N 个实例的聚合放行速率是单实例的 N 倍——仍然有界，
 * 且分布式暴力的外层防线本就应由 LB/WAF 承担。这里要挡的是「单点无节流」这个
 * 硬缺陷（枚举 device_code / 试探 client_secret / 当 DoS 入口），进程内桶足以
 * 把单实例单 IP 的稳态速率压到 refillPerSec，配合 service.ts 的恒定时间校验与
 * 统一失败措辞，构成最小可用的加固。上线前若需强一致的跨实例限流，可换成
 * 基于 Redis/DB 的实现，接口 allow(key, now) 保持不变。
 */
export interface RateLimiter {
  /** 返回 true 放行、false 超限应拒绝。now 单位为秒（与 AppDeps.now 一致）。 */
  allow(key: string, now: number): boolean
}

export interface RateLimiterConfig {
  /** 桶容量：允许的突发上限 */
  capacity: number
  /** 每秒补充的令牌数：稳态放行速率 */
  refillPerSec: number
}

export function createRateLimiter(cfg: RateLimiterConfig): RateLimiter {
  const buckets = new Map<string, { tokens: number; last: number }>()
  return {
    allow(key, now) {
      const b = buckets.get(key) ?? { tokens: cfg.capacity, last: now }
      // 时钟只前进：now 倒退时 elapsed 归零，不凭空补令牌也不扣令牌
      const elapsed = Math.max(0, now - b.last)
      b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec)
      b.last = now
      if (b.tokens < 1) {
        buckets.set(key, b)
        return false
      }
      b.tokens -= 1
      buckets.set(key, b)
      return true
    },
  }
}

/**
 * 登录端点限流参数。capacity=20 允许合理突发（设备端每 5 秒轮询一次远低于此），
 * refillPerSec=1 把单 key 的稳态速率压到 60 次/分钟——足以让穷举/试探在
 * argon2 校验成本之上再叠一层节流。数值是保守默认，可按上线观测调整。
 *
 * 导出为常量与工厂函数，供 index.ts（生产装配）与 tests/http/testApp.ts
 * （测试装配）共用同一份默认值，避免两处各自复制一份、后续调参时改漏一处。
 */
export const LOGIN_BURST = 20
export const LOGIN_REFILL_PER_SEC = 1

export function createLoginRateLimiter(): RateLimiter {
  return createRateLimiter({ capacity: LOGIN_BURST, refillPerSec: LOGIN_REFILL_PER_SEC })
}
