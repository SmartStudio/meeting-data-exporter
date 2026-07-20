import { expect, test } from 'bun:test'
import { createWecomClient } from '../../src/auth/wecom'

const cfg = { corpId: 'corp1', agentId: 'agent1', secret: 'sec1' }

type FakeResponse = { status?: number; body: unknown } | { throws: true }

/**
 * exchangeCode 依次调用三个接口：gettoken → auth/getuserinfo → user/get。
 * responses 按调用顺序对应；用 { throws: true } 模拟网络失败（fetch 本身抛异常）。
 */
function fakeFetch(responses: FakeResponse[]) {
  let i = 0
  const calls: string[] = []
  const fn = async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    const r = responses[Math.min(i, responses.length - 1)]!
    i += 1
    if ('throws' in r) throw new Error('network error')
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

const deps = (f: typeof fetch) => ({ fetch: f, now: () => 1_700_000_000 })

test('exchangeCode 用 userid 再查 user/get 拿到邮箱', async () => {
  const { fn, calls } = fakeFetch([
    { body: { access_token: 'tok', expires_in: 7200 } },
    { body: { userid: 'zed' } },
    { body: { errcode: 0, errmsg: 'ok', userid: 'zed', email: 'zed@example.com' } },
  ])
  const client = createWecomClient(cfg, deps(fn))

  const user = await client.exchangeCode('code-1')

  expect(user).toEqual({ userId: 'zed', email: 'zed@example.com' })
  expect(calls).toHaveLength(3)
  expect(calls[2]).toContain('/cgi-bin/user/get')
  expect(calls[2]).toContain('userid=zed')
})

test('user/get 返回空字符串邮箱时视为 null', async () => {
  const { fn } = fakeFetch([
    { body: { access_token: 'tok', expires_in: 7200 } },
    { body: { userid: 'zed' } },
    { body: { errcode: 0, errmsg: 'ok', userid: 'zed', email: '' } },
  ])
  const client = createWecomClient(cfg, deps(fn))

  const user = await client.exchangeCode('code-1')

  expect(user).toEqual({ userId: 'zed', email: null })
})

test('user/get 调用失败（网络错误）不阻断登录，email 置 null', async () => {
  const { fn } = fakeFetch([
    { body: { access_token: 'tok', expires_in: 7200 } },
    { body: { userid: 'zed' } },
    { throws: true },
  ])
  const client = createWecomClient(cfg, deps(fn))

  const user = await client.exchangeCode('code-1')

  // 只要 userid 拿到了，登录本身不应因为邮箱查询失败而失败——direct/table
  // 策略根本不需要邮箱，是否报错应该留给 identity.ts 按所配策略决定。
  expect(user).toEqual({ userId: 'zed', email: null })
})

test('user/get 返回业务错误码时 email 置 null，不影响 userId', async () => {
  const { fn } = fakeFetch([
    { body: { access_token: 'tok', expires_in: 7200 } },
    { body: { userid: 'zed' } },
    { body: { errcode: 60111, errmsg: 'userid not found' } },
  ])
  const client = createWecomClient(cfg, deps(fn))

  const user = await client.exchangeCode('code-1')

  expect(user).toEqual({ userId: 'zed', email: null })
})
