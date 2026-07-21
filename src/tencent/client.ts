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
  now: () => number
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
    while (!bucket.tryTake(deps.now())) {
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
