import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp } from './testApp'
import { createAuthStore } from '../../src/store/auth'

let pool: Pool
let cleanup: () => Promise<void>
beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

async function seedDeviceAuth(o: { userCode: string; state: string; expiresAt: number }): Promise<void> {
  const store = createAuthStore(pool)
  await store.createDeviceAuth({
    deviceCode: `dc-${o.userCode}`,
    userCode: o.userCode,
    state: o.state,
    expiresAt: o.expiresAt,
    now: 1_700_000_000,
  })
}

function deviceReq(qs: string): Request {
  return new Request(`http://gw.example/device${qs}`)
}

test('有效 user_code：302 跳转企微授权页，带上记录里的 state', async () => {
  await seedDeviceAuth({ userCode: 'GOOD-01', state: 'state-good-01', expiresAt: 1_700_000_300 })
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 })
  const res = await app(deviceReq('?user_code=GOOD-01'))
  expect(res.status).toBe(302)
  const loc = res.headers.get('Location')!
  // testApp 的 stubWecomClient.buildAuthorizeUrl 返回 wecom.example/authorize?state=...&redirect=...
  expect(loc).toContain('wecom.example/authorize')
  expect(loc).toContain('state=state-good-01')
  expect(loc).toContain(encodeURIComponent('https://gw.example/auth/wecom/callback'))
})

test('缺 user_code：400 错误页', async () => {
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 })
  const res = await app(deviceReq(''))
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type')).toContain('text/html')
})

test('未知 user_code：400（不区分不存在/已用过/过期）', async () => {
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 })
  const res = await app(deviceReq('?user_code=NOPE'))
  expect(res.status).toBe(400)
})

test('已过期的 user_code：400', async () => {
  await seedDeviceAuth({ userCode: 'EXP-01', state: 'state-exp', expiresAt: 1_700_000_050 })
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 }) // now > expiresAt
  const res = await app(deviceReq('?user_code=EXP-01'))
  expect(res.status).toBe(400)
})

test('已授权（非 pending）的 user_code：400（不可复用）', async () => {
  await seedDeviceAuth({ userCode: 'USED-01', state: 'state-used', expiresAt: 1_700_000_300 })
  const store = createAuthStore(pool)
  await store.authorize('state-used', 'ww-x', 'tm-x') // 置为 authorized
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 })
  const res = await app(deviceReq('?user_code=USED-01'))
  expect(res.status).toBe(400)
})

test('失败不可区分：未知/已过期/已用过三种失败态响应体逐字节相同（避免 user_code 有效性成为可探测信号）', async () => {
  await seedDeviceAuth({ userCode: 'EXP-02', state: 'state-exp-02', expiresAt: 1_700_000_050 })
  await seedDeviceAuth({ userCode: 'USED-02', state: 'state-used-02', expiresAt: 1_700_000_300 })
  const store = createAuthStore(pool)
  await store.authorize('state-used-02', 'ww-x', 'tm-x') // 置为 authorized（已用过）
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 }) // now > EXP-02.expiresAt

  const unknown = await app(deviceReq('?user_code=NOPE-02'))
  const expired = await app(deviceReq('?user_code=EXP-02'))
  const used = await app(deviceReq('?user_code=USED-02'))

  for (const res of [unknown, expired, used]) {
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
  }
  const [unknownBody, expiredBody, usedBody] = await Promise.all([unknown.text(), expired.text(), used.text()])
  expect(unknownBody).toBe(expiredBody)
  expect(expiredBody).toBe(usedBody)
})
