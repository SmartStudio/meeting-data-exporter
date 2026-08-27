import { buildAuthHeaders } from './signer'
import { buildUrl, type QueryParams } from './url'
import { parseErrorResponse, TencentApiError } from './errors'
import { createEndpointQuota, type EndpointQuota, createTokenBucket } from './ratelimit'

/**
 * **按接口**另设的分钟级配额，路径 → 每分钟上限。
 *
 * 全局令牌桶（`TM_QPS`，默认 5 即 300 次/min）对这些接口来说宽得没有意义：
 * `/v1/corp/records` 官方写明「访问限制：**10次/min**」，全局桶 6 秒就能超掉它
 * 一整分钟的配额。这里的闸门是零突发的，见 ratelimit.ts 的 createEndpointQuota。
 *
 * 只在这张表里的路径上生效，其余接口一如既往只受全局桶约束。
 */
const ENDPOINT_QUOTAS_PER_MINUTE: Readonly<Record<string, number>> = {
  // https://cloud.tencent.com/document/product/1095/53224 「访问限制：10次/min」
  '/v1/corp/records': 10,
}

export interface TencentClientConfig {
  appId: string
  sdkId: string
  secretId: string
  secretKey: string
  operatorId: string
  qps: number
  baseUrl: string
}

export interface TencentClientDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  /**
   * **毫秒**时间戳（`Date.now`）。名字里带 Ms 不是修饰，是契约：本字段唯一的
   * 消费者是令牌桶，而桶按毫秒计算补充速率。曾经这里叫 `now`，装配处传了
   * 项目里通用的秒级时钟，导致补充速率慢 1000 倍——桶里初始的 qps 个令牌用完
   * 后，每补 1 个要等 200 秒真实时间，网关就此静默失去调用腾讯的能力。
   */
  nowMs: () => number
}

export interface RequestOptions {
  stsToken?: string
}

export interface TencentClient {
  get<T>(path: string, query: QueryParams, opts?: RequestOptions): Promise<T>
  post<T>(path: string, body: object, opts?: RequestOptions): Promise<T>
  currentQps(): number
}

const MAX_ATTEMPTS = 5

export function createTencentClient(
  cfg: TencentClientConfig,
  deps: TencentClientDeps,
): TencentClient {
  const bucket = createTokenBucket(cfg.qps)
  // 闸门随 client 实例存活：每次调用新建一个等于完全不限流。
  const quotas = new Map<string, EndpointQuota>()
  for (const [path, perMinute] of Object.entries(ENDPOINT_QUOTAS_PER_MINUTE)) {
    quotas.set(path, createEndpointQuota(perMinute))
  }

  /**
   * 先过该接口自己的分钟级配额（若有），再过全局令牌桶。
   *
   * 顺序是有意的：先过紧的那道。反过来会先从全局桶里拿走令牌、再在配额闸门前
   * 干等几秒，白白挤占其它接口的额度。
   */
  async function acquire(path: string): Promise<void> {
    const quota = quotas.get(path)
    if (quota) {
      for (;;) {
        const waitMs = quota.tryTake(deps.nowMs())
        if (waitMs === 0) break
        await deps.sleep(waitMs)
      }
    }
    while (!bucket.tryTake(deps.nowMs())) {
      await deps.sleep(1000 / Math.max(1, bucket.currentQps()))
    }
  }

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    query: QueryParams,
    bodyObj: object | null,
    opts: RequestOptions,
  ): Promise<T> {
    const body = bodyObj === null ? '' : JSON.stringify(bodyObj)
    let lastError: TencentApiError | null = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 重试也是真实的 API 调用，同样要占配额——放在循环内而非循环外。
      await acquire(path)

      // 每次重试都重新构造 URL 与请求头——nonce 与 timestamp 必须换新，
      // 否则触发 190301 请求重放错误。
      const built = buildUrl(cfg.baseUrl, path, query)
      const headers = buildAuthHeaders(cfg, method, built, body, opts.stsToken)

      const res = await deps.fetch(built.url, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
      })

      if (res.ok) return (await res.json()) as T

      let parsed: unknown
      try {
        parsed = await res.json()
      } catch {
        parsed = await res.text()
      }
      const err = parseErrorResponse(res.status, parsed)
      lastError = err

      if (err.classification === 'fatal' || err.classification === 'asset_permanent') throw err
      if (err.requiresBackoff) bucket.converge()
      if (attempt < MAX_ATTEMPTS) await deps.sleep(2 ** attempt * 100)
    }

    throw lastError ?? new TencentApiError(-1, 0, 'exhausted retries')
  }

  return {
    get: (path, query, opts = {}) => request('GET', path, query, null, opts),
    post: (path, body, opts = {}) => request('POST', path, {}, body, opts),
    currentQps: () => bucket.currentQps(),
  }
}
