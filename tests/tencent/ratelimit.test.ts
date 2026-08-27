import { expect, test } from 'bun:test'
import { createEndpointQuota, createTokenBucket } from '../../src/tencent/ratelimit'

test('初始允许突发到容量上限', async () => {
  const b = createTokenBucket(5)
  for (let i = 0; i < 5; i++) expect(b.tryTake(0)).toBe(true)
  expect(b.tryTake(0)).toBe(false)
})

test('按速率恢复令牌', () => {
  const b = createTokenBucket(5)
  for (let i = 0; i < 5; i++) b.tryTake(0)
  expect(b.tryTake(200)).toBe(true)   // 200ms 恢复 1 个
  expect(b.tryTake(200)).toBe(false)
})

test('converge 收敛速率至一半，下限 1 QPS', () => {
  const b = createTokenBucket(8)
  b.converge()
  expect(b.currentQps()).toBe(4)
  b.converge(); b.converge(); b.converge(); b.converge()
  expect(b.currentQps()).toBe(1)
})

// ---------------------------------------------------------------------------
// 单接口配额闸门（createEndpointQuota）
//
// 上面那个令牌桶是**全局**一个、按 QPS 计速的。腾讯有些接口另有一个**按分钟**
// 计的硬配额（`/v1/corp/records` 是 10 次/min），全局桶挡不住：TM_QPS 默认 5
// 等于 300 次/min，6 秒就能把一分钟的配额用光。
// ---------------------------------------------------------------------------

test('配额闸门零突发：两次放行之间恒定间隔 60000/perMinute 毫秒', () => {
  const q = createEndpointQuota(10) // 10 次/min → 每 6 秒一次
  expect(q.tryTake(0)).toBe(0)
  expect(q.tryTake(0)).toBe(6_000) // 立刻再取，被告知还要等 6 秒
  expect(q.tryTake(5_999)).toBe(1)
  expect(q.tryTake(6_000)).toBe(0)
})

test('任意 60 秒窗口内至多放行 perMinute 次——不是「先突发 N 次再补 N 次」', () => {
  const q = createEndpointQuota(10)
  let passed = 0
  // 高频叩门整整一分钟；令牌桶式实现在这里会放过 20 次
  for (let t = 0; t < 60_000; t += 100) if (q.tryTake(t) === 0) passed++
  expect(passed).toBe(10)
})

test('拒绝时返回的是「还要等多少毫秒」，可直接喂给 sleep', () => {
  const q = createEndpointQuota(6) // 每 10 秒一次
  q.tryTake(1_000)
  const waitMs = q.tryTake(3_000)
  expect(waitMs).toBe(8_000)
  expect(q.tryTake(3_000 + waitMs)).toBe(0)
})

test('perMinute 非正数在构造期报错，不静默退化成「不限流」', () => {
  expect(() => createEndpointQuota(0)).toThrow()
  expect(() => createEndpointQuota(-1)).toThrow()
  expect(() => createEndpointQuota(Number.NaN)).toThrow()
})
