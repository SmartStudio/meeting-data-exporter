export interface TokenBucket {
  tryTake(nowMs: number): boolean
  converge(): void
  currentQps(): number
}

/**
 * 对腾讯的调用集中于网关，限流也集中于此。
 * 遇 190310 时调用 converge() 主动降速，避免持续触发限流。
 */
export function createTokenBucket(initialQps: number): TokenBucket {
  let qps = initialQps
  let tokens = initialQps
  let lastMs = 0

  return {
    tryTake(nowMs) {
      const elapsed = Math.max(0, nowMs - lastMs)
      tokens = Math.min(qps, tokens + (elapsed / 1000) * qps)
      lastMs = nowMs
      if (tokens >= 1) {
        tokens -= 1
        return true
      }
      return false
    },
    converge() {
      qps = Math.max(1, Math.floor(qps / 2))
      tokens = Math.min(tokens, qps)
    },
    currentQps: () => qps,
  }
}

/**
 * **单接口**配额闸门：把某一个接口的调用速率限制在「每分钟 N 次」。
 *
 * 为什么不复用上面那个令牌桶：桶的容量等于速率，允许先突发 N 次、再在随后的
 * 60 秒里补满 N 次——任意 60 秒窗口内最多 2N 次。对 `/v1/corp/records` 这种
 * 「访问限制：10次/min」的硬配额来说，那等于没限。这里改成**零突发**：两次
 * 放行之间强制隔满 `60000 / perMinute` 毫秒，任意 60 秒窗口内至多 N 次。
 *
 * 也不能靠全局桶顺带挡住：`TM_QPS` 默认 5，即 300 次/min，6 秒就能超掉
 * corp/records 一整分钟的配额。
 *
 * **入参是毫秒**，与 `TencentClientDeps.nowMs` 同一个量纲——这不是修饰，是契约。
 * 见 `client.ts` 里那条注释记着的坑：秒/毫秒混用曾让补充速率慢 1000 倍，
 * 网关静默失去调用腾讯的能力。
 */
export interface EndpointQuota {
  /**
   * 取一个调用额度。
   * @returns 取到返回 `0`；取不到返回**还需要等待的毫秒数**（恒 > 0），可直接喂给 sleep。
   */
  tryTake(nowMs: number): number
}

export function createEndpointQuota(perMinute: number): EndpointQuota {
  // 0 / 负数 / NaN 会让 intervalMs 变成 Infinity 或 NaN：前者是「永远不放行」，
  // 后者的比较恒为 false 也是「永远不放行」——两种都表现为静默卡死而非报错。
  // 与 config.ts 对 TM_QPS 的处理同一个道理，必须在构造期挡住。
  if (!Number.isFinite(perMinute) || perMinute <= 0) {
    throw new Error(`perMinute must be a positive finite number, got: ${perMinute}`)
  }
  const intervalMs = 60_000 / perMinute
  // 负无穷而不是 0：调用方传进来的是真实的毫秒时间戳（1.7e12 量级），
  // 但测试里也可能从 0 开始——两种都要让第一次调用直接放行。
  let nextAllowedMs = Number.NEGATIVE_INFINITY

  return {
    tryTake(nowMs) {
      if (nowMs >= nextAllowedMs) {
        nextAllowedMs = nowMs + intervalMs
        return 0
      }
      return nextAllowedMs - nowMs
    },
  }
}
