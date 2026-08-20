import { buildAuthHeaders } from './signer'
import { buildUrl, type QueryParams } from './url'
import { parseErrorResponse, TencentApiError } from './errors'
import { createTokenBucket } from './ratelimit'

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

  async function acquire(): Promise<void> {
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
      await acquire()

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
