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
