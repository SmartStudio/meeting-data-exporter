import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createStsStore } from '../../src/store/sts'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

test('createRequest 写入 pending 记录，此时无可用 token', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-1', 1000)
  expect(await store.getActive(1000)).toBeNull()
})

test('fulfill 后可取到有效 token', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-2', 1000)
  await store.fulfill('req-2', 'cipher-abc', 9999, 1100)
  const active = await store.getActive(2000)
  expect(active?.tokenCipher).toBe('cipher-abc')
  expect(active?.expireTs).toBe(9999)
})

test('getActive 忽略已过期的 token', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-3', 1000)
  await store.fulfill('req-3', 'expired-one', 500, 1100)
  const active = await store.getActive(600)
  expect(active?.tokenCipher).not.toBe('expired-one')
})

test('新旧并存时取过期最晚的一个', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-old', 1000)
  await store.fulfill('req-old', 'older', 50_000, 1100)
  await store.createRequest('req-new', 1200)
  await store.fulfill('req-new', 'newer', 90_000, 1300)
  expect((await store.getActive(2000))?.tokenCipher).toBe('newer')
})

/** MySQL 无 RETURNING，靠 affectedRows 判断——此用例锁定该行为 */
test('fulfill 未知 req_id 时抛错（回调无法配对属异常）', async () => {
  const store = createStsStore(pool)
  await expect(store.fulfill('nonexistent', 'x', 1, 1)).rejects.toThrow('unknown req_id')
})

test('createRequest 重复调用不报错（幂等）', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-dup', 1000)
  await store.createRequest('req-dup', 1000)
  expect(true).toBe(true)
})

test('中文与 emoji 可正确往返（验证 utf8mb4）', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-utf8', 1000)
  await store.fulfill('req-utf8', '季度评审 🎉 纪要', 99_999, 1100)
  expect((await store.getActive(2000))?.tokenCipher).toBe('季度评审 🎉 纪要')
})
