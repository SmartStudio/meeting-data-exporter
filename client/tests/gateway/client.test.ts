import { expect, test } from 'bun:test'
import { createGatewayClient, MeetingNotFoundInRangeError } from '../../src/gateway/client'

function stub(responses: Array<{ match: (url: string, init?: RequestInit) => boolean; res: () => Response }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const r = responses.find((x) => x.match(url, init))
    if (!r) throw new Error(`no stub for ${url}`)
    return r.res()
  }) as typeof fetch
}
const cfg = { gatewayUrl: 'https://gw', clientId: 'cid', clientSecret: 'sec' }
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

test('首次调用先换 service-token，再带 Bearer 调业务端点', async () => {
  let tokenCalls = 0; let sawBearer = ''
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => { tokenCalls++; return ok({ access_token: 'tok', expires_in: 900 }) } },
    { match: (u) => u.includes('/api/v1/meetings'), res: () => ok({ meetings: [], next_cursor: null }) },
  ])
  const wrapped: typeof fetch = (async (i, init) => { if (String(i).includes('/meetings')) sawBearer = (init?.headers as any)?.Authorization ?? ''; return fetchStub(i, init) }) as typeof fetch
  const gw = createGatewayClient(cfg, { fetch: wrapped, now: () => 1000 })
  await gw.listMeetings({ kind: 'range', from: 1, to: 2 })
  expect(tokenCalls).toBe(1)
  expect(sawBearer).toBe('Bearer tok')
})

test('业务端点 401 → 透明重取 token 后重试当次调用', async () => {
  let tokenCalls = 0; let meetingCalls = 0
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => { tokenCalls++; return ok({ access_token: `tok${tokenCalls}`, expires_in: 900 }) } },
    { match: (u) => u.includes('/api/v1/meetings'), res: () => { meetingCalls++; return meetingCalls === 1 ? new Response('{"error":"token_expired"}', { status: 401 }) : ok({ meetings: [], next_cursor: null }) } },
  ])
  const gw = createGatewayClient(cfg, { fetch: fetchStub, now: () => 1000 })
  await gw.listMeetings({ kind: 'range', from: 1, to: 2 })
  expect(tokenCalls).toBe(2)     // 初次 + 401 后重取
  expect(meetingCalls).toBe(2)   // 401 + 重试成功
})

test('meeting_not_found_in_range → 专用错误类', async () => {
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => ok({ access_token: 'tok', expires_in: 900 }) },
    { match: (u) => u.includes('/api/v1/meetings'), res: () => new Response('{"error":"meeting_not_found_in_range"}', { status: 404 }) },
  ])
  const gw = createGatewayClient(cfg, { fetch: fetchStub, now: () => 1000 })
  await expect(gw.listMeetings({ kind: 'id', meetingId: 'x' })).rejects.toThrow(MeetingNotFoundInRangeError)
})

/**
 * 网关在 404 体里给的 `message` 才是**判定理由**：按会议号/ID 的点名查询走的是
 * 用户维度的 `/v1/records`，只看得到 operator 自己主持的会议（见网关侧
 * tencent/records.ts 的 EXACT_LOOKUP_SCOPE_NOTE）。客户端只读 `body.error`、
 * 把 message 丢掉的话，终端上只剩一句笼统的「meeting not found in range」，
 * 使用者无从知道自己撞的是时间范围还是可见范围。
 */
test('网关给的 message 要带到错误里，不能只剩一句笼统的「未找到」', async () => {
  const gatewayMessage =
    'meeting 700999 not found within [1, 2]. Lookup by meeting code/ID uses /v1/records, ' +
    "which returns ONLY meetings hosted by the gateway's own operator account."
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => ok({ access_token: 'tok', expires_in: 900 }) },
    {
      match: (u) => u.includes('/api/v1/meetings'),
      res: () => new Response(JSON.stringify({ error: 'meeting_not_found_in_range', message: gatewayMessage }), { status: 404 }),
    },
  ])
  const gw = createGatewayClient(cfg, { fetch: fetchStub, now: () => 1000 })
  await expect(gw.listMeetings({ kind: 'code', meetingCode: '700999' })).rejects.toThrow(gatewayMessage)
})

test('其它网关错误同样带上 message', async () => {
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => ok({ access_token: 'tok', expires_in: 900 }) },
    {
      match: (u) => u.includes('/api/v1/meetings'),
      res: () => new Response(JSON.stringify({ error: 'upstream_rate_limited', message: 'tencent 190310, retry later' }), { status: 503 }),
    },
  ])
  const gw = createGatewayClient(cfg, { fetch: fetchStub, now: () => 1000 })
  await expect(gw.listMeetings({ kind: 'range', from: 1, to: 2 })).rejects.toThrow('tencent 190310, retry later')
})

test('网关没给 message 时保留原有的兜底措辞，不产出 undefined', async () => {
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => ok({ access_token: 'tok', expires_in: 900 }) },
    { match: (u) => u.includes('/api/v1/meetings'), res: () => new Response('{"error":"meeting_not_found_in_range"}', { status: 404 }) },
  ])
  const gw = createGatewayClient(cfg, { fetch: fetchStub, now: () => 1000 })
  const err = await gw.listMeetings({ kind: 'id', meetingId: 'x' }).then(() => null, (e: unknown) => e as Error)
  expect(err!.message).toBe('meeting not found in range')
  expect(err!.message).not.toContain('undefined')
})
