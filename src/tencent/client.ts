import { buildAuthHeaders } from './signer'
import { buildUrl, type QueryParams } from './url'
import { parseErrorResponse, TencentApiError } from './errors'
import { createEndpointQuota, type EndpointQuota, createTokenBucket } from './ratelimit'
// 值导入，但**不成环**：smart.ts 对 client 只有 `import type`，编译后整句消失，
// 运行时 smart.ts 只依赖 ./errors
import { SMART_MINUTES_QUOTA_KEY } from './smart'

/**
 * `GET /v1/users/{userid}`（成员详情）的配额键。
 *
 * **path 里带变量，按精确 path 匹配不上任何一条配额**——每个 userid 都是一条新
 * 路径，闸门会一次都拦不住。所以这个接口的调用方要在 `RequestOptions.quotaKey`
 * 里把配额指到这个常量上，见 `ENDPOINT_QUOTAS_PER_MINUTE`。
 *
 * 常量而不是各调用点各写一个字面量：字面量写错的表现是**静默不限流**
 * （Map 里查不到就直接放行），不会有任何报错。
 */
export const USER_DETAIL_QUOTA_KEY = '/v1/users/{userid}'

/**
 * **按接口**另设的分钟级配额，配额键 → 每分钟上限。
 *
 * 全局令牌桶（`TM_QPS`，默认 5 即 300 次/min）对这些接口来说宽得没有意义：
 * `/v1/corp/records` 官方写明「访问限制：**10次/min**」，全局桶 6 秒就能超掉它
 * 一整分钟的配额。这里的闸门是零突发的，见 ratelimit.ts 的 createEndpointQuota。
 *
 * 键**默认就是 path**，但调用方可以用 `RequestOptions.quotaKey` 另指一个——
 * 路径里带变量的接口（`/v1/users/{userid}`）只能这么限，否则每个 id 都是一条
 * 新路径，一次都匹配不上。
 *
 * 只在这张表里的键上生效，其余接口一如既往只受全局桶约束。
 */
const ENDPOINT_QUOTAS_PER_MINUTE: Readonly<Record<string, number>> = {
  // https://cloud.tencent.com/document/product/1095/53224 「访问限制：10次/min」
  '/v1/corp/records': 10,
  // **60/min 是保守估计，不是文档值**：腾讯没有为成员详情接口公布单接口配额，
  // 只有全局的 190310「调用超限」兜着。取这个数的理由有三条：
  //   1. 它是**姓名同步**的接口，不在任何用户等待的路径上——慢一点没有人受影响，
  //      而超限会连累同一个网关里正在跑的下载与归档（190310 会让令牌桶 converge，
  //      收敛是全局的）
  //   2. 姓名同步一轮最多 50 个（host-names.ts 的 MAX_PER_ROUND），60/min 意味着
  //      一轮至多约 50 秒跑完，仍然远快于任务一 15 分钟一轮的节奏
  //   3. 真实配额若更宽，代价只是同步慢；若更严而我们按文档值调宽，代价是限流
  //      收敛拖慢整个网关。两边的代价不对称，所以往紧了取
  // 哪天腾讯公布了真实数字，改这一行即可，别在调用点上另加节流。
  [USER_DETAIL_QUOTA_KEY]: 60,
  // 智能录制的两个接口（纪要 / 章节）同样是 **60/min 的保守估计，不是文档值**：
  // 腾讯没为它们公布单接口配额，只有全局的 190310「调用超限」兜着。理由与上面那条
  // 同构，数量级不同：
  //   1. 它们跑在**回填**上，不在任何用户等待的路径上——慢一点没有人受影响
  //   2. 回填每个 record_file 每轮约 4 次调用（minutes + chapters，各含探测与取回）,
  //      按 60/min 算，约 130 个 record_file 的一轮回填要 10 分钟出头，可以接受
  //   3. 反过来超掉 190310 的代价是**全局的**：它会让令牌桶 converge，同一个网关里
  //      正在跑的下载与归档一起被拖慢。两边的代价不对称，所以往紧了取
  // 路径带变量，键必须用 smart.ts 那个常量，见 SMART_MINUTES_QUOTA_KEY 的注释。
  [SMART_MINUTES_QUOTA_KEY]: 60,
  // 章节的 path 里不带变量（record_file_id 走 query），按 path 计费就对得上
  '/v1/smart/chapters': 60,
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
  /**
   * 这次调用算在哪条分钟级配额上，缺省是 path 本身。
   *
   * 只有**路径里带变量**的接口需要它：`/v1/users/{userid}` 每个 id 都是一条不同的
   * path，按 path 匹配等于一次都匹配不上，闸门形同虚设。传
   * `USER_DETAIL_QUOTA_KEY` 之类的常量把同一个接口的全部调用归到一条闸门上。
   *
   * 传一个 `ENDPOINT_QUOTAS_PER_MINUTE` 里没有的键**不会报错**，只是不受
   * 单接口配额约束（与不传一样）——所以键要用常量，不要现写字面量。
   */
  quotaKey?: string
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
  for (const [key, perMinute] of Object.entries(ENDPOINT_QUOTAS_PER_MINUTE)) {
    quotas.set(key, createEndpointQuota(perMinute))
  }

  /**
   * 先过该接口自己的分钟级配额（若有），再过全局令牌桶。
   *
   * 顺序是有意的：先过紧的那道。反过来会先从全局桶里拿走令牌、再在配额闸门前
   * 干等几秒，白白挤占其它接口的额度。
   */
  async function acquire(quotaKey: string): Promise<void> {
    const quota = quotas.get(quotaKey)
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
      // 缺省按 path 计费，路径带变量的接口由调用方指一个稳定的键（见 RequestOptions）
      await acquire(opts.quotaKey ?? path)

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

      if (err.classification !== 'transient') throw err
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
