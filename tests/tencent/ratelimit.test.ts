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

test('配额闸门允许一口气用满 perMinute 次，第 perMinute+1 次要等到最早那次满 60 秒', () => {
  const q = createEndpointQuota(10)
  for (let i = 0; i < 10; i++) expect(q.tryTake(i * 100)).toBe(0) // 0.9 秒内连翻 10 页
  expect(q.tryTake(1_000)).toBe(59_000) // 最早那次在 0，要等到 60_000
  expect(q.tryTake(59_999)).toBe(1)
  expect(q.tryTake(60_000)).toBe(0) // 0 那次出窗，放行
  expect(q.tryTake(60_000)).toBe(100) // 下一个出窗的是 100 那次
})

test('任意 60 秒窗口内至多放行 perMinute 次——不是「先突发 N 次再补 N 次」', () => {
  const q = createEndpointQuota(10)
  let passed = 0
  // 高频叩门整整一分钟；令牌桶式实现在这里会放过 20 次
  for (let t = 0; t < 60_000; t += 100) if (q.tryTake(t) === 0) passed++
  expect(passed).toBe(10)
})

test('拒绝时返回的是「还要等多少毫秒」，可直接喂给 sleep', () => {
  const q = createEndpointQuota(6)
  for (let i = 0; i < 6; i++) q.tryTake(1_000)
  const waitMs = q.tryTake(3_000)
  expect(waitMs).toBe(58_000)
  expect(q.tryTake(3_000 + waitMs)).toBe(0)
})

test('perMinute 非正数在构造期报错，不静默退化成「不限流」', () => {
  expect(() => createEndpointQuota(0)).toThrow()
  expect(() => createEndpointQuota(-1)).toThrow()
  expect(() => createEndpointQuota(Number.NaN)).toThrow()
})
