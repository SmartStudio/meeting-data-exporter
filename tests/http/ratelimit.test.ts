import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createRateLimiter } from '../../src/http/ratelimit'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp } from './testApp'

test('桶满时放行，耗尽后拒绝', () => {
  const rl = createRateLimiter({ capacity: 3, refillPerSec: 1 })
  const now = 1000
  expect(rl.allow('k', now)).toBe(true)
  expect(rl.allow('k', now)).toBe(true)
  expect(rl.allow('k', now)).toBe(true)
  expect(rl.allow('k', now)).toBe(false) // 第 4 次，桶空
})

test('按经过秒数补充令牌，上限为 capacity', () => {
  const rl = createRateLimiter({ capacity: 2, refillPerSec: 1 })
  expect(rl.allow('k', 1000)).toBe(true)
  expect(rl.allow('k', 1000)).toBe(true)
  expect(rl.allow('k', 1000)).toBe(false)
  // 过 2 秒补 2 个令牌，但不超过 capacity=2
  expect(rl.allow('k', 1002)).toBe(true)
  expect(rl.allow('k', 1002)).toBe(true)
  expect(rl.allow('k', 1002)).toBe(false)
})

test('不同 key 互不影响', () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSec: 1 })
  expect(rl.allow('a', 1000)).toBe(true)
  expect(rl.allow('a', 1000)).toBe(false)
  expect(rl.allow('b', 1000)).toBe(true) // b 有独立的桶
})

test('时间倒流不产生负令牌（防御时钟异常）', () => {
  const rl = createRateLimiter({ capacity: 2, refillPerSec: 1 })
  expect(rl.allow('k', 1000)).toBe(true)
  expect(rl.allow('k', 999)).toBe(true) // now 回退，elapsed 视为 0，仍用桶内余量
})

let pool: Pool
let cleanup: () => Promise<void>
beforeAll(async () => { const db = await withTestDb(); pool = db.pool; cleanup = db.cleanup })
afterAll(() => cleanup())

function deviceCodeReq(ip: string): Request {
  return new Request('http://gw.example/api/v1/auth/device/code', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  })
}

test('登录端点按 IP 限流：超过突发上限返回 429', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_000_000 })
  // 默认 capacity=20：前 20 次放行（device/code 恒返回 200），第 21 次 429
  for (let i = 0; i < 20; i++) {
    const res = await app(deviceCodeReq('10.0.0.1'))
    expect(res.status).toBe(200)
  }
  const blocked = await app(deviceCodeReq('10.0.0.1'))
  expect(blocked.status).toBe(429)
  expect(await blocked.json()).toEqual({ error: 'rate_limited' })
})

test('限流按 IP 隔离：另一 IP 不受影响', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_100_000 })
  for (let i = 0; i < 20; i++) await app(deviceCodeReq('10.0.0.2'))
  expect((await app(deviceCodeReq('10.0.0.2'))).status).toBe(429)
  expect((await app(deviceCodeReq('10.0.0.3'))).status).toBe(200) // 独立的桶
})

test('令牌随时间补充：等待后重新放行', async () => {
  let t = 2_200_000
  const { app } = buildTestApp(pool, { now: () => t })
  for (let i = 0; i < 20; i++) await app(deviceCodeReq('10.0.0.4'))
  expect((await app(deviceCodeReq('10.0.0.4'))).status).toBe(429)
  t += 5 // 过 5 秒，refill=1/s 补 5 个令牌
  expect((await app(deviceCodeReq('10.0.0.4'))).status).toBe(200)
})

/** 伪造首段、真实末段固定不变的 XFF 请求（默认 trustedProxyHops=1，单层可信代理） */
function forgedXffReq(forgedFirstHop: string, realIp: string): Request {
  return new Request('http://gw.example/api/v1/auth/device/code', {
    method: 'POST',
    headers: { 'x-forwarded-for': `${forgedFirstHop}, ${realIp}` },
  })
}

test('C1 回归：XFF 首段可被客户端任意伪造，限流必须按末段（可信段）计算，伪造首段无法绕过', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_300_000 })
  const realIp = '203.0.113.9'
  // 每次请求都换一个不同的伪造首段——如果限流仍按首段（旧实现的 bug）计算，
  // 每次都会落入一个全新的桶，20 次根本打不满，第 21 次也会被放行。
  for (let i = 0; i < 20; i++) {
    const res = await app(forgedXffReq(`10.0.${i}.1`, realIp))
    expect(res.status).toBe(200)
  }
  const blocked = await app(forgedXffReq('9.9.9.9', realIp))
  expect(blocked.status).toBe(429)
  expect(await blocked.json()).toEqual({ error: 'rate_limited' })
})

function deviceTokenReq(ip: string, deviceCode: string): Request {
  return new Request('http://gw.example/api/v1/auth/device/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ device_code: deviceCode }),
  })
}

function serviceTokenReq(ip: string, clientId: string): Request {
  return new Request('http://gw.example/api/v1/auth/service-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ client_id: clientId, client_secret: 'whatever' }),
  })
}

function refreshReq(ip: string): Request {
  return new Request('http://gw.example/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ refresh_token: 'not-a-real-refresh-token' }),
  })
}

test('I1 回归：账号维度限流独立于 IP 维度——固定 client_id、每次换 IP，第 21 次仍 429', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_400_000 })
  for (let i = 0; i < 20; i++) {
    // IP 每次都不同：IP 维度的桶不会耗尽，若第 21 次仍被拒绝，只能是账号维度生效
    const res = await app(serviceTokenReq(`10.1.0.${i}`, 'svc-fixed-1'))
    expect(res.status).toBe(401) // 账号不存在，但尚未被限流
  }
  const blocked = await app(serviceTokenReq('10.1.0.99', 'svc-fixed-1'))
  expect(blocked.status).toBe(429)
  expect(await blocked.json()).toEqual({ error: 'rate_limited' })
})

test('I1 回归：IP 维度不受账号维度干扰——同一 IP、每次换 client_id，第 21 次仍 429', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_500_000 })
  for (let i = 0; i < 20; i++) {
    // client_id 每次都不同：账号维度的桶不会耗尽，若第 21 次仍被拒绝，只能是 IP 维度生效
    const res = await app(serviceTokenReq('10.2.0.1', `svc-diff-${i}`))
    expect(res.status).toBe(401)
  }
  const blocked = await app(serviceTokenReq('10.2.0.1', 'svc-diff-final'))
  expect(blocked.status).toBe(429)
})

test('M（回归）：device/token 账号维度限流独立于 IP 维度——固定 device_code、每次换 IP，第 21 次仍 429', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_350_000 })
  for (let i = 0; i < 20; i++) {
    // IP 每次都不同：IP 维度的桶不会耗尽，若第 21 次仍被拒绝，只能是账号维度生效。
    // device_code 无需真实存在——账号维度限流检查在 deviceFlow.poll 之前生效，
    // 未耗尽时会走到 poll 拿到 expired_token（device_code 未知）。
    const res = await app(deviceTokenReq(`10.5.0.${i}`, 'dev-fixed-1'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'expired_token' })
  }
  const blocked = await app(deviceTokenReq('10.5.0.99', 'dev-fixed-1'))
  expect(blocked.status).toBe(429)
  expect(await blocked.json()).toEqual({ error: 'rate_limited' })
})

test('I2 回归：refresh 端点确在 RATE_LIMITED 集合内，同 IP 第 21 次 429', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_600_000 })
  for (let i = 0; i < 20; i++) {
    const res = await app(refreshReq('10.3.0.1'))
    expect(res.status).toBe(401) // invalid_refresh_token，body 内容不影响 429 判定
  }
  const blocked = await app(refreshReq('10.3.0.1'))
  expect(blocked.status).toBe(429)
  expect(await blocked.json()).toEqual({ error: 'rate_limited' })
})

test('I2 回归：service-token 端点确在 RATE_LIMITED 集合内，同 IP 第 21 次 429', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_700_000 })
  for (let i = 0; i < 20; i++) {
    const res = await app(serviceTokenReq('10.4.0.1', 'svc-i2-fixed'))
    expect(res.status).toBe(401)
  }
  const blocked = await app(serviceTokenReq('10.4.0.1', 'svc-i2-fixed'))
  expect(blocked.status).toBe(429)
  expect(await blocked.json()).toEqual({ error: 'rate_limited' })
})
