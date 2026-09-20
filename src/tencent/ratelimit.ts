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
 * **单接口**配额闸门：把某一个接口的调用速率限制在「任意 60 秒窗口内至多 N 次」。
 *
 * 为什么不复用上面那个令牌桶：桶的容量等于速率，允许先突发 N 次、再在随后的
 * 60 秒里补满 N 次——任意 60 秒窗口内最多 2N 次。对 `/v1/corp/records` 这种
 * 「访问限制：10次/min」的硬配额来说，那等于没限。
 *
 * 也不是「两次放行之间强制隔 60000/N 毫秒」的零突发实现（2026-09-20 之前的版本）。
 * 那种实现同样保证任意 60 秒内至多 N 次，但代价是**每一页都要等 6 秒**：网关每次
 * 列会议都实时翻 `/v1/corp/records`，每页 20 条，一天 40 场会议就是两页、12 秒，
 * 而 Bun.serve 的空闲超时把连接一断，客户端看到的是「Empty reply」，网关一行日志
 * 都没有。这里改成滑动窗口：记住最近 N 次放行的时刻，第 N+1 次要等到最早那次
 * 满 60 秒。任意 60 秒窗口内仍然至多 N 次，但一次列会议的前 N 页一口气翻完。
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

const WINDOW_MS = 60_000

export function createEndpointQuota(perMinute: number): EndpointQuota {
  // 0 / 负数 / NaN：前者是「永远不放行」，后者的比较恒为 false 也是「永远不放行」——
  // 两种都表现为静默卡死而非报错。与 config.ts 对 TM_QPS 的处理同一个道理，
  // 必须在构造期挡住。
  if (!Number.isFinite(perMinute) || perMinute <= 0) {
    throw new Error(`perMinute must be a positive finite number, got: ${perMinute}`)
  }
  const capacity = Math.floor(perMinute)
  // 最近 capacity 次放行的时刻，按时间升序；满了就看最早那次是否已经出了窗口
  const granted: number[] = []

  return {
    tryTake(nowMs) {
      while (granted.length > 0 && nowMs - granted[0]! >= WINDOW_MS) granted.shift()
      if (granted.length < capacity) {
        granted.push(nowMs)
        return 0
      }
      return granted[0]! + WINDOW_MS - nowMs
    },
  }
}
