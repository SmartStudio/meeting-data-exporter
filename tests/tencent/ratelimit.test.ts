import { expect, test } from 'bun:test'
import { createTokenBucket } from '../../src/tencent/ratelimit'

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
