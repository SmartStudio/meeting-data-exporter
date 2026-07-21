import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createStsStore, type StsStore } from '../../src/store/sts'

interface StateRow extends RowDataPacket {
  state: string
  token_cipher: string | null
}

/**
 * 直接查具体 req_id 的持久化状态，而不是借助 getActive()——getActive 是
 * “当前全局最活跃的 token” 语义（跨记录取 expire_ts 最大者），不适合用来断言
 * 某一条具体记录是否被覆盖，尤其是测试之间共享同一张表、彼此状态会累积时。
 */
async function rowOf(
  pool: Pool,
  reqId: string,
): Promise<{ state: string; tokenCipher: string | null } | undefined> {
  const [rows] = await pool.execute<StateRow[]>(
    `SELECT state, token_cipher FROM sts_token_requests WHERE req_id = ?`,
    [reqId],
  )
  const r = rows[0]
  return r ? { state: r.state, tokenCipher: r.token_cipher } : undefined
}

const stateOf = async (pool: Pool, reqId: string) => (await rowOf(pool, reqId))?.state

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

test('createRequest 重复调用不报错，且不覆盖已有记录（幂等）', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-dup', 1000)
  await store.fulfill('req-dup', 'cipher-dup', 9999, 1100)

  // INSERT IGNORE 语义：重复调用应静默忽略，不得回滚已 fulfilled 的记录
  await store.createRequest('req-dup', 1000)

  // 直接查这条记录本身（而非 getActive，见 rowOf 注释），验证 fulfilled 状态未被
  // 第二次 createRequest 覆盖回 pending
  const row = await rowOf(pool, 'req-dup')
  expect(row?.state).toBe('fulfilled')
  expect(row?.tokenCipher).toBe('cipher-dup')
})

test('中文与 emoji 可正确往返（验证 utf8mb4）', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-utf8', 1000)
  await store.fulfill('req-utf8', '季度评审 🎉 纪要', 99_999, 1100)
  expect((await store.getActive(2000))?.tokenCipher).toBe('季度评审 🎉 纪要')
})

/**
 * 本文件里的用例共享同一张表、顺序执行、彼此不做行级回滚（withTestDb 只在
 * beforeAll 建一次库）。expireStale 断言的是“受影响行数”，若不先清掉前面用例
 * 遗留的 pending 记录，返回的条数会把它们也算进去。用一个足够大的 now 把所有
 * 现存 pending 记录冲成 expired，让每个 expireStale 用例的计数只反映自己新建
 * 的记录，不依赖用例执行顺序。
 */
const FAR_FUTURE = 10_000_000_000
async function flushAllPending(store: StsStore): Promise<void> {
  await store.expireStale(FAR_FUTURE)
}

test('expireStale 将超过 1 小时仍 pending 的记录置为 expired 并返回条数', async () => {
  const store = createStsStore(pool)
  await flushAllPending(store)

  const now = 1_000_000
  // requested_at 比 now 早 3601 秒 / 7200 秒（均 > 1 小时），应被判定为过期
  await store.createRequest('req-stale-1', now - 3601)
  await store.createRequest('req-stale-2', now - 7200)

  const count = await store.expireStale(now)
  expect(count).toBe(2)
  expect(await stateOf(pool, 'req-stale-1')).toBe('expired')
  expect(await stateOf(pool, 'req-stale-2')).toBe('expired')
})

test('expireStale 不影响未超时的 pending 记录', async () => {
  const store = createStsStore(pool)
  await flushAllPending(store)

  const now = 2_000_000
  // requested_at 比 now 早 100 秒（< 1 小时），不应被判定为过期
  await store.createRequest('req-fresh', now - 100)

  const count = await store.expireStale(now)
  expect(count).toBe(0)
  expect(await stateOf(pool, 'req-fresh')).toBe('pending')
})

test('expireStale 不影响已 fulfilled 的记录', async () => {
  const store = createStsStore(pool)
  await flushAllPending(store)

  const now = 3_000_000
  await store.createRequest('req-done', now - 7200)
  await store.fulfill('req-done', 'cipher-done', now + 9999, now - 7100)

  const count = await store.expireStale(now)
  expect(count).toBe(0)
  expect(await stateOf(pool, 'req-done')).toBe('fulfilled')
})

/**
 * hasRecentPending 用例：req_id 与时间戳都选与上面所有既有用例远隔的值
 * （见文件顶部关于共享 pool、不回滚的说明），避免因 INSERT IGNORE 撞上已存在
 * 的 req_id 而让新建请求被静默忽略、误判用例结果。
 */
test('hasRecentPending：存在未过陈旧窗口的 pending 时为 true', async () => {
  const store = createStsStore(pool)
  await store.createRequest('hp-recent', 500_000_000)
  // 陈旧窗口 3600s：now=500_000_500 时 requested_at=500_000_000 仍在窗口内
  expect(await store.hasRecentPending(500_000_500)).toBe(true)
})

test('hasRecentPending：pending 已超陈旧窗口（>1h）时为 false', async () => {
  const store = createStsStore(pool)
  await store.createRequest('hp-old', 500_100_000)
  // now 比 requested_at 晚超过 3600s
  expect(await store.hasRecentPending(500_100_000 + 3601)).toBe(false)
})

test('hasRecentPending：已 fulfilled 的记录不算在途', async () => {
  const store = createStsStore(pool)
  await store.createRequest('hp-fulfilled', 500_200_000)
  await store.fulfill('hp-fulfilled', 'cipher', 500_200_000 + 86_400, 500_200_050)
  // 若仍按 pending 计入，requested_at=500_200_000 落在窗口内会被误判为 true
  expect(await store.hasRecentPending(500_200_100)).toBe(false)
})

test('hasRecentPending：无任何在窗口内的 pending 时为 false', async () => {
  const store = createStsStore(pool)
  expect(await store.hasRecentPending(999_999_999)).toBe(false)
})
