import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createAuthStore } from '../../src/store/auth'

let pool: Pool
let cleanup: () => Promise<void>
let seq = 0
/** 每次调用生成一组不冲突的 device_code/user_code/state，避免测试间互相污染唯一索引 */
function uniqueTriplet(prefix: string): { deviceCode: string; userCode: string; state: string } {
  seq += 1
  return {
    deviceCode: `${prefix}-device-${seq}`,
    userCode: `${prefix}-UC-${seq}`,
    state: `${prefix}-state-${seq}`,
  }
}

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

test('device_code 为主键，重复插入报错', async () => {
  const store = createAuthStore(pool)
  const t = uniqueTriplet('pk')
  await store.createDeviceAuth({ ...t, expiresAt: 9999, now: 1000 })

  await expect(
    store.createDeviceAuth({
      deviceCode: t.deviceCode,
      userCode: `${t.userCode}-other`,
      state: `${t.state}-other`,
      expiresAt: 9999,
      now: 1000,
    }),
  ).rejects.toThrow()
})

test('user_code 唯一约束生效', async () => {
  const store = createAuthStore(pool)
  const t = uniqueTriplet('uc')
  await store.createDeviceAuth({ ...t, expiresAt: 9999, now: 1000 })

  await expect(
    store.createDeviceAuth({
      deviceCode: `${t.deviceCode}-other`,
      userCode: t.userCode,
      state: `${t.state}-other`,
      expiresAt: 9999,
      now: 1000,
    }),
  ).rejects.toThrow()
})

test('state 唯一约束生效', async () => {
  const store = createAuthStore(pool)
  const t = uniqueTriplet('st')
  await store.createDeviceAuth({ ...t, expiresAt: 9999, now: 1000 })

  await expect(
    store.createDeviceAuth({
      deviceCode: `${t.deviceCode}-other`,
      userCode: `${t.userCode}-other`,
      state: t.state,
      expiresAt: 9999,
      now: 1000,
    }),
  ).rejects.toThrow()
})

test('authorize 对 pending 记录成功并返回 true', async () => {
  const store = createAuthStore(pool)
  const t = uniqueTriplet('auth-ok')
  await store.createDeviceAuth({ ...t, expiresAt: 9999, now: 1000 })

  const ok = await store.authorize(t.state, 'wecom-alice', 'tm-alice')
  expect(ok).toBe(true)

  const record = await store.findByState(t.state)
  expect(record?.status).toBe('authorized')
  expect(record?.wecomUserId).toBe('wecom-alice')
  expect(record?.tmUserId).toBe('tm-alice')
})

test('authorize 对已授权记录返回 false（防 state 重放）', async () => {
  const store = createAuthStore(pool)
  const t = uniqueTriplet('auth-replay')
  await store.createDeviceAuth({ ...t, expiresAt: 9999, now: 1000 })

  const first = await store.authorize(t.state, 'wecom-bob', 'tm-bob')
  expect(first).toBe(true)

  const replay = await store.authorize(t.state, 'wecom-mallory', 'tm-mallory')
  expect(replay).toBe(false)

  // 记录仍是第一次授权的身份，未被重放请求篡改
  const record = await store.findByState(t.state)
  expect(record?.wecomUserId).toBe('wecom-bob')
  expect(record?.tmUserId).toBe('tm-bob')
})

test('authorize 对不存在的 state 返回 false', async () => {
  const store = createAuthStore(pool)
  const ok = await store.authorize('state-does-not-exist', 'wecom-x', 'tm-x')
  expect(ok).toBe(false)
})

test('refresh token 按 hash 精确查找', async () => {
  const store = createAuthStore(pool)
  await store.saveRefreshToken({
    tokenHash: 'hash-exact-1',
    wecomUserId: 'wecom-carol',
    tmUserId: 'tm-carol',
    familyId: 'family-exact-1',
    expiresAt: 99_999,
    now: 1000,
  })
  await store.saveRefreshToken({
    tokenHash: 'hash-exact-2',
    wecomUserId: 'wecom-dave',
    tmUserId: 'tm-dave',
    familyId: 'family-exact-2',
    expiresAt: 99_999,
    now: 1000,
  })

  const found = await store.findRefreshToken('hash-exact-1')
  expect(found?.wecomUserId).toBe('wecom-carol')
  expect(found?.familyId).toBe('family-exact-1')
  expect(found?.revoked).toBe(false)

  const notFound = await store.findRefreshToken('hash-does-not-exist')
  expect(notFound).toBeNull()
})

test('revokeFamily 吊销整条轮换链上的全部令牌', async () => {
  const store = createAuthStore(pool)
  const familyId = 'family-chain-1'
  await store.saveRefreshToken({
    tokenHash: 'chain-hash-1',
    wecomUserId: 'wecom-erin',
    tmUserId: 'tm-erin',
    familyId,
    expiresAt: 99_999,
    now: 1000,
  })
  await store.saveRefreshToken({
    tokenHash: 'chain-hash-2',
    wecomUserId: 'wecom-erin',
    tmUserId: 'tm-erin',
    familyId,
    expiresAt: 99_999,
    now: 1100,
  })
  // 不同轮换链，不应被连坐吊销
  await store.saveRefreshToken({
    tokenHash: 'chain-hash-other',
    wecomUserId: 'wecom-frank',
    tmUserId: 'tm-frank',
    familyId: 'family-chain-other',
    expiresAt: 99_999,
    now: 1000,
  })

  const revokedCount = await store.revokeFamily(familyId)
  expect(revokedCount).toBe(2)

  const t1 = await store.findRefreshToken('chain-hash-1')
  const t2 = await store.findRefreshToken('chain-hash-2')
  const other = await store.findRefreshToken('chain-hash-other')
  expect(t1?.revoked).toBe(true)
  expect(t2?.revoked).toBe(true)
  expect(other?.revoked).toBe(false)
})

test('findServiceAccount 返回 enabled 与 expires_at 供上层判断', async () => {
  await pool.execute(
    `INSERT INTO service_accounts (id, name, secret_hash, tm_userid, enabled, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['svc-enabled', '导出机器人', 'hash-svc-1', 'tm-svc-1', 1, null, 1000],
  )
  await pool.execute(
    `INSERT INTO service_accounts (id, name, secret_hash, tm_userid, enabled, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['svc-disabled', '已停用账号', 'hash-svc-2', 'tm-svc-2', 0, 5000, 1000],
  )

  const store = createAuthStore(pool)

  const enabled = await store.findServiceAccount('svc-enabled')
  expect(enabled?.enabled).toBe(true)
  expect(enabled?.expiresAt).toBeNull()

  const disabled = await store.findServiceAccount('svc-disabled')
  expect(disabled?.enabled).toBe(false)
  expect(disabled?.expiresAt).toBe(5000)

  const missing = await store.findServiceAccount('svc-does-not-exist')
  expect(missing).toBeNull()
})

test('pollDevice 更新 last_polled_at，但返回的是更新前的旧值', async () => {
  // pollDevice 的契约是「记录本次轮询，返回本次轮询之前的状态」。调用方（device.ts
  // 的限速判断）需要知道的正是「上一次轮询是什么时候」——如果返回值里的 last_polled_at
  // 被静默替换成本次的 now，这个信息就永久丢失，差值恒为 0，限速会对每次轮询都生效，
  // 设备授权流程在真实数据库下将永远无法完成（这是本用例锁定的真实故障场景）。
  const store = createAuthStore(pool)
  const t = uniqueTriplet('poll')
  await store.createDeviceAuth({ ...t, expiresAt: 9999, now: 1000 })

  // 从未轮询过，旧值应为 null，而不是本次传入的 now
  const first = await store.pollDevice(t.deviceCode, 2000)
  expect(first?.status).toBe('pending')
  expect(first?.lastPolledAt).toBeNull()

  const missing = await store.pollDevice('device-code-not-exist', 2000)
  expect(missing).toBeNull()
})

test('连续两次 pollDevice，第二次返回的 lastPolledAt 等于第一次调用时传入的 now', async () => {
  const store = createAuthStore(pool)
  const t = uniqueTriplet('poll-seq')
  await store.createDeviceAuth({ ...t, expiresAt: 9999, now: 1000 })

  await store.pollDevice(t.deviceCode, 2000)
  const second = await store.pollDevice(t.deviceCode, 2010)
  expect(second?.lastPolledAt).toBe(2000)

  const third = await store.pollDevice(t.deviceCode, 2025)
  expect(third?.lastPolledAt).toBe(2010)
})

test('lookupIdentityMap 按 wecom_userid 查找', async () => {
  await pool.execute(
    `INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at) VALUES (?, ?, ?, ?)`,
    ['wecom-grace', 'tm-grace', 'grace@example.com', 1000],
  )
  const store = createAuthStore(pool)

  const found = await store.lookupIdentityMap('wecom-grace')
  expect(found?.tmUserId).toBe('tm-grace')
  expect(found?.email).toBe('grace@example.com')

  const missing = await store.lookupIdentityMap('wecom-does-not-exist')
  expect(missing).toBeNull()
})

test('lookupIdentityByEmail 按 email 查找', async () => {
  await pool.execute(
    `INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at) VALUES (?, ?, ?, ?)`,
    ['wecom-heidi', 'tm-heidi', 'heidi@example.com', 1000],
  )
  const store = createAuthStore(pool)

  const found = await store.lookupIdentityByEmail('heidi@example.com')
  expect(found?.wecomUserId).toBe('wecom-heidi')

  const missing = await store.lookupIdentityByEmail('nobody@example.com')
  expect(missing).toBeNull()
})

test('lookupIdentityByEmail 邮箱重复时返回 updated_at 最新的一条', async () => {
  // email 无唯一约束，重复可能发生（离职员工邮箱回收、身份同步竞态写入）。
  // 结果必须是确定性的「最新映射生效」，而不是查询计划的偶然产物。
  await pool.execute(
    `INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at) VALUES (?, ?, ?, ?)`,
    ['wecom-ivan-old', 'tm-ivan-old', 'ivan@example.com', 1000],
  )
  await pool.execute(
    `INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at) VALUES (?, ?, ?, ?)`,
    ['wecom-ivan-new', 'tm-ivan-new', 'ivan@example.com', 2000],
  )
  const store = createAuthStore(pool)

  const found = await store.lookupIdentityByEmail('ivan@example.com')
  expect(found?.wecomUserId).toBe('wecom-ivan-new')
  expect(found?.tmUserId).toBe('tm-ivan-new')
  expect(found?.updatedAt).toBe(2000)
})
