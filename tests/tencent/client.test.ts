import { expect, test } from 'bun:test'
import { USER_DETAIL_QUOTA_KEY, createTencentClient } from '../../src/tencent/client'
import { TencentApiError } from '../../src/tencent/errors'

const cfg = {
  appId: 'corp', sdkId: 'sdk', secretId: 'AKIDx', secretKey: 'k',
  operatorId: 'admin', qps: 5, baseUrl: 'https://api.test',
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0
  const calls: Request[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(input, init))
    const r = responses[Math.min(i++, responses.length - 1)]!
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

const deps = (f: typeof fetch) => ({
  fetch: f,
  sleep: async () => {},
  nowMs: () => 1_700_000_000_000,
})

test('成功响应直接返回解析后的 body', async () => {
  const { fn } = fakeFetch([{ status: 200, body: { total_count: 3 } }])
  const c = createTencentClient(cfg, deps(fn))
  expect(await c.get<{ total_count: number }>('/v1/addresses', { page: 1 })).toEqual({ total_count: 3 })
})

test('请求携带全部必需头', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: {} }])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/addresses', { page: 1 })
  const h = calls[0]!.headers
  expect(h.get('X-TC-Registered')).toBe('1')
  expect(h.get('X-TC-Signature')).toBeTruthy()
  expect(h.get('Content-Type')).toBe('application/json')
})

test('致命错误立即抛出，不重试', async () => {
  const { fn, calls } = fakeFetch([
    { status: 400, body: { error_info: { error_code: 9042, message: 'auth failed' } } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await expect(c.get('/v1/addresses', {})).rejects.toThrow(TencentApiError)
  expect(calls).toHaveLength(1)
})

test('瞬时错误重试后成功', async () => {
  const { fn, calls } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 960000, message: 'net' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  expect(await c.get<{ ok: boolean }>('/v1/addresses', {})).toEqual({ ok: true })
  expect(calls).toHaveLength(2)
})

test('190301 重试时使用新的 nonce 与 timestamp', async () => {
  const { fn, calls } = fakeFetch([
    { status: 400, body: { error_info: { error_code: 190301, message: 'replay' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/addresses', {})
  expect(calls[0]!.headers.get('X-TC-Nonce')).not.toBe(calls[1]!.headers.get('X-TC-Nonce'))
})

test('190310 触发限流收敛', async () => {
  const { fn } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 190310, message: 'limit' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/addresses', {})
  expect(c.currentQps()).toBeLessThan(5)
})

test('资产级永久错误不重试', async () => {
  const { fn, calls } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 4051, message: 'deleted' } } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await expect(c.get('/v1/addresses/1', {})).rejects.toMatchObject({ classification: 'asset_permanent' })
  expect(calls).toHaveLength(1)
})

test('超过重试上限后抛出最后一次错误', async () => {
  const { fn, calls } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 41, message: 'timeout' } } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await expect(c.get('/v1/addresses', {})).rejects.toThrow(TencentApiError)
  expect(calls).toHaveLength(5)
})

/**
 * 令牌桶与注入时钟的**量纲一致性**回归。
 *
 * M3.5 联调实测到的事故：装配处把项目通用的秒级 now() 传给了按毫秒计速的令牌桶，
 * 补充速率因此慢 1000 倍——桶里初始的 qps 个令牌一旦用完，每补 1 个要等 200 秒
 * 真实时间。表现是网关在头几个请求之后静默失去调用腾讯的能力：连接被
 * Bun.serve 的 idleTimeout 关掉，**不留任何日志**。单元测试原本抓不到它，因为
 * 每个用例都构造全新的 client，桶永远是满的。
 *
 * 这里用「被 sleep 推进的模拟时钟」跑满一轮突发 + 恢复，把速率关系钉死。
 */
test('突发耗尽后按 qps 恢复：总模拟耗时符合速率，而非慢若干个数量级', async () => {
  let clockMs = 1_700_000_000_000
  const { fn, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
  const c = createTencentClient(
    { ...cfg, qps: 5 },
    {
      fetch: fn,
      sleep: async (ms: number) => { clockMs += ms },
      nowMs: () => clockMs,
    },
  )

  const startMs = clockMs
  for (let i = 0; i < 15; i++) await c.get('/v1/addresses', { page: i })
  const elapsedMs = clockMs - startMs

  expect(calls).toHaveLength(15)
  // 容量 5 的桶先放行 5 个，剩余 10 个按 5/秒补充 → 约 2 秒。
  // 放宽到 4 秒容纳调度粒度；量纲写错时这里会是 2000 秒量级。
  expect(elapsedMs).toBeLessThan(4_000)
  // 也不能是 0：真的限了流，而不是压根没生效
  expect(elapsedMs).toBeGreaterThan(0)
})

/**
 * `/v1/corp/records` 的**单接口配额**：官方「访问限制：10次/min」。
 *
 * 全局令牌桶挡不住它——TM_QPS 默认 5 就是 300 次/min，6 秒即可超掉一分钟的
 * 配额。所以这个接口另有一道零突发的闸门。这里同样用「被 sleep 推进的模拟
 * 时钟」，不做任何真实等待。
 */
test('/v1/corp/records 被单独限到 10 次/min——全局桶再宽也不放行', async () => {
  let clockMs = 1_700_000_000_000
  const { fn, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
  const c = createTencentClient(
    { ...cfg, qps: 50 }, // 全局 50/s = 3000/min，比该接口的配额宽 300 倍
    {
      fetch: fn,
      sleep: async (ms: number) => { clockMs += ms },
      nowMs: () => clockMs,
    },
  )

  const startMs = clockMs
  for (let i = 0; i < 11; i++) await c.get('/v1/corp/records', { page: i })
  const elapsedMs = clockMs - startMs

  expect(calls).toHaveLength(11)
  // 第 11 次调用必须落在第一次之后的 60 秒之外，否则某个 60 秒窗口里就有 11 次
  expect(elapsedMs).toBeGreaterThanOrEqual(60_000)
})

test('这道闸门只管 /v1/corp/records，不拖慢其它接口', async () => {
  let clockMs = 1_700_000_000_000
  const { fn, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
  const c = createTencentClient(
    { ...cfg, qps: 5 },
    {
      fetch: fn,
      sleep: async (ms: number) => { clockMs += ms },
      nowMs: () => clockMs,
    },
  )

  const startMs = clockMs
  for (let i = 0; i < 11; i++) await c.get('/v1/addresses', { page: i })
  const elapsedMs = clockMs - startMs

  expect(calls).toHaveLength(11)
  // 只受全局 5/s 约束：容量 5 先放行 5 个，余下 6 个约 1.2 秒。
  // 若把按分钟的闸门错误地套到全部接口上，这里会是 60 秒量级。
  expect(elapsedMs).toBeLessThan(4_000)
})

test('配额闸门跟着 client 实例走：同一实例的后续调用继续受限，不会每次调用重置', async () => {
  let clockMs = 1_700_000_000_000
  const { fn } = fakeFetch([{ status: 200, body: { ok: true } }])
  const c = createTencentClient(
    { ...cfg, qps: 50 },
    { fetch: fn, sleep: async (ms: number) => { clockMs += ms }, nowMs: () => clockMs },
  )

  await c.get('/v1/corp/records', { page: 1 })
  const afterFirstMs = clockMs
  await c.get('/v1/corp/records', { page: 2 })

  // 两次之间必须隔满 60000/10 = 6 秒
  expect(clockMs - afterFirstMs).toBeGreaterThanOrEqual(6_000)
})

/**
 * 路径里带变量的接口（`/v1/users/{userid}`）：按 path 匹配等于**一次都匹配不上**
 * ——每个 userid 都是一条新 path。它靠 `RequestOptions.quotaKey` 把同一个接口的
 * 全部调用归到一条闸门上，闸门本身还是那一个（见 client.ts 的 ENDPOINT_QUOTAS）。
 */
test('quotaKey 让路径带变量的接口也受分钟级配额约束', async () => {
  let clockMs = 1_700_000_000_000
  const { fn, calls } = fakeFetch([{ status: 200, body: { username: '张三' } }])
  const c = createTencentClient(
    { ...cfg, qps: 50 }, // 全局 50/s = 3000/min，比这个接口的 60/min 宽 50 倍
    { fetch: fn, sleep: async (ms: number) => { clockMs += ms }, nowMs: () => clockMs },
  )

  const startMs = clockMs
  // 每次都是不同的 path，只有 quotaKey 相同
  for (let i = 0; i < 3; i++) {
    await c.get(`/v1/users/u-${i}`, { operator_id: 'admin' }, { quotaKey: USER_DETAIL_QUOTA_KEY })
  }

  expect(calls).toHaveLength(3)
  // 60/min = 两次之间至少隔 1 秒，三次至少 2 秒
  expect(clockMs - startMs).toBeGreaterThanOrEqual(2_000)
})

test('不传 quotaKey 时按 path 计费——同一个接口的不同 path 因此互不影响', async () => {
  let clockMs = 1_700_000_000_000
  const { fn, calls } = fakeFetch([{ status: 200, body: { username: '张三' } }])
  const c = createTencentClient(
    { ...cfg, qps: 50 },
    { fetch: fn, sleep: async (ms: number) => { clockMs += ms }, nowMs: () => clockMs },
  )

  const startMs = clockMs
  // 这正是**不能**这么调的原因，钉在这里免得有人以为「按 path 也拦得住」：
  // 三条不同的 path 一条配额都匹配不上，全部当场放行
  for (let i = 0; i < 3; i++) await c.get(`/v1/users/u-${i}`, { operator_id: 'admin' })

  expect(calls).toHaveLength(3)
  expect(clockMs - startMs).toBe(0)
})
