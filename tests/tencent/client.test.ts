import { expect, test } from 'bun:test'
import { createTencentClient } from '../../src/tencent/client'
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
  now: () => 1_700_000_000_000,
})

test('成功响应直接返回解析后的 body', async () => {
  const { fn } = fakeFetch([{ status: 200, body: { total_count: 3 } }])
  const c = createTencentClient(cfg, deps(fn))
  expect(await c.get<{ total_count: number }>('/v1/records', { page: 1 })).toEqual({ total_count: 3 })
})

test('请求携带全部必需头', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: {} }])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/records', { page: 1 })
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
  await expect(c.get('/v1/records', {})).rejects.toThrow(TencentApiError)
  expect(calls).toHaveLength(1)
})

test('瞬时错误重试后成功', async () => {
  const { fn, calls } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 960000, message: 'net' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  expect(await c.get<{ ok: boolean }>('/v1/records', {})).toEqual({ ok: true })
  expect(calls).toHaveLength(2)
})

test('190301 重试时使用新的 nonce 与 timestamp', async () => {
  const { fn, calls } = fakeFetch([
    { status: 400, body: { error_info: { error_code: 190301, message: 'replay' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/records', {})
  expect(calls[0]!.headers.get('X-TC-Nonce')).not.toBe(calls[1]!.headers.get('X-TC-Nonce'))
})

test('190310 触发限流收敛', async () => {
  const { fn } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 190310, message: 'limit' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/records', {})
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
  await expect(c.get('/v1/records', {})).rejects.toThrow(TencentApiError)
  expect(calls).toHaveLength(5)
})
