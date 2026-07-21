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
