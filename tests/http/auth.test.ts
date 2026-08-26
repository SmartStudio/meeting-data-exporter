import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp } from './testApp'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

const NOW = 1_700_000_000

/**
 * 步进时钟：HTTP 层的 now() 在每次请求内取值一次，设备轮询的限速判断
 * （interval=5s）依赖真实的时间推进，因此需要一个可推进的 now，而不是
 * 固定常量。
 */
function stepClock(start: number): { now: () => number; advance: (sec: number) => void } {
  let t = start
  return { now: () => t, advance: (sec: number) => { t += sec } }
}

/**
 * 生产实现里，验证页面（GET /device?user_code=...）负责把 user_code 解析回
 * state 并跳转到企微授权页——那个页面不在 Task 14 的端点清单内（见任务
 * 报告"疑虑"部分），因此测试里直接查库还原它扮演的角色。
 */
async function lookupState(deviceCode: string): Promise<string> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT state FROM device_authorizations WHERE device_code = ?',
    [deviceCode],
  )
  return rows[0]!.state as string
}

test('设备授权完整路径：发码 → 轮询 pending → 企微回调 → 轮询取得令牌', async () => {
  const clock = stepClock(NOW)
  const { app } = buildTestApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-kate-1', email: null }),
  })

  const codeRes = await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  expect(codeRes.status).toBe(200)
  const codeBody = (await codeRes.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
  }
  expect(codeBody.user_code).toHaveLength(8)
  expect(codeBody.interval).toBe(5)
  expect(codeBody.expires_in).toBe(300)

  clock.advance(1)
  const pendingRes = await app(
    new Request('https://gw/api/v1/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: codeBody.device_code }),
    }),
  )
  expect(pendingRes.status).toBe(400)
  expect((await pendingRes.json()).error).toBe('authorization_pending')

  const state = await lookupState(codeBody.device_code)
  clock.advance(1)
  const cbRes = await app(
    new Request(`https://gw/auth/wecom/callback?code=wecom-auth-code-1&state=${state}`),
  )
  expect(cbRes.status).toBe(200)
  expect(cbRes.headers.get('content-type')).toContain('text/html')
  expect(await cbRes.text()).toContain('登录成功')

  clock.advance(10) // 超过 interval，避免 slow_down
  const tokenRes = await app(
    new Request('https://gw/api/v1/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: codeBody.device_code }),
    }),
  )
  expect(tokenRes.status).toBe(200)
  const tokenBody = (await tokenRes.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  expect(tokenBody.access_token).toBeTruthy()
  expect(tokenBody.refresh_token).toBeTruthy()
  expect(tokenBody.expires_in).toBe(900)

  const meRes = await app(
    new Request('https://gw/api/v1/meetings', {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    }),
  )
  expect(meRes.status).toBe(200)
})

test('早于 interval 连续轮询返回 slow_down', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW }) // 固定 now：两次轮询间隔恒为 0

  const codeRes = await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  const codeBody = (await codeRes.json()) as { device_code: string }

  const poll = () =>
    app(
      new Request('https://gw/api/v1/auth/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: codeBody.device_code }),
      }),
    )

  const first = await poll()
  expect(first.status).toBe(400)
  expect((await first.json()).error).toBe('authorization_pending')

  const second = await poll()
  expect(second.status).toBe(400)
  expect((await second.json()).error).toBe('slow_down')
})

test('未知 device_code 轮询返回 expired_token', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw/api/v1/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: 'never-issued-device-code' }),
    }),
  )
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('expired_token')
})

test('身份映射失败（account_not_provisioned）与授权失败明确区分，且审计留痕', async () => {
  const clock = stepClock(NOW)
  const { app } = buildTestApp(pool, {
    now: clock.now,
    identityStrategy: 'table', // ww-unmapped-1 不在 identity_map 表中 → 必然映射失败
    wecomExchangeCode: async () => ({ userId: 'ww-unmapped-1', email: null }),
  })

  const codeRes = await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  const codeBody = (await codeRes.json()) as { device_code: string }
  const state = await lookupState(codeBody.device_code)

  const cbRes = await app(
    new Request(`https://gw/auth/wecom/callback?code=any-code&state=${state}`),
  )
  expect(cbRes.status).toBe(403)
  const text = await cbRes.text()
  expect(text).toContain('account_not_provisioned')
  expect(text).not.toContain('无权限')

  // 设备记录不应被标记为已授权（映射失败等于登录失败，不能悄悄放行）
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT status FROM device_authorizations WHERE device_code = ?',
    [codeBody.device_code],
  )
  expect(rows[0]!.status).toBe('pending')

  const [auditRows] = await pool.execute<RowDataPacket[]>(
    "SELECT decision, asset_type, detail FROM audit_log WHERE actor_id = ? AND action = 'login'",
    ['ww-unmapped-1'],
  )
  expect(auditRows).toHaveLength(1)
  expect(auditRows[0]!.decision).toBe('deny')
  // 登录失败原因在 detail 列（migrations/008）。它从前被塞在 asset_type 上，
  // 那是 detail 列还不存在时唯一装得下自由文本的地方
  expect(auditRows[0]!.detail).toBe('account_not_provisioned')
  expect(auditRows[0]!.asset_type).toBeNull()
})

test('refresh：刷新即轮换，旧 refresh_token 立即失效', async () => {
  const clock = stepClock(NOW)
  const { app } = buildTestApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-liam-1', email: null }),
  })

  const codeBody = (await (
    await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  ).json()) as { device_code: string }
  const state = await lookupState(codeBody.device_code)
  await app(new Request(`https://gw/auth/wecom/callback?code=c&state=${state}`))
  clock.advance(10)
  const tokens = (await (
    await app(
      new Request('https://gw/api/v1/auth/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: codeBody.device_code }),
      }),
    )
  ).json()) as { refresh_token: string }

  const refreshOnce = async (token: string) =>
    app(
      new Request('https://gw/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: token }),
      }),
    )

  const firstRefresh = await refreshOnce(tokens.refresh_token)
  expect(firstRefresh.status).toBe(200)
  const firstBody = (await firstRefresh.json()) as { access_token: string; refresh_token: string }
  expect(firstBody.refresh_token).not.toBe(tokens.refresh_token)

  // 旧 refresh_token 已被轮换作废，立即重放应被拒绝
  const replay = await refreshOnce(tokens.refresh_token)
  expect(replay.status).toBe(401)
  expect((await replay.json()).error).toBe('refresh_token_reused')
})

test('refresh：检测到重放后连坐吊销整条链，新 token 也随之失效', async () => {
  const clock = stepClock(NOW)
  const { app } = buildTestApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-mia-1', email: null }),
  })

  const codeBody = (await (
    await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  ).json()) as { device_code: string }
  const state = await lookupState(codeBody.device_code)
  await app(new Request(`https://gw/auth/wecom/callback?code=c&state=${state}`))
  clock.advance(10)
  const tokens = (await (
    await app(
      new Request('https://gw/api/v1/auth/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: codeBody.device_code }),
      }),
    )
  ).json()) as { refresh_token: string }

  const refreshOnce = async (token: string) =>
    app(
      new Request('https://gw/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: token }),
      }),
    )

  const firstRefresh = await refreshOnce(tokens.refresh_token)
  const firstBody = (await firstRefresh.json()) as { refresh_token: string }

  // 攻击者重放旧 token → 触发连坐吊销
  await refreshOnce(tokens.refresh_token)

  // 即便是刚刚正常轮换出来、尚未过期的新 token，此刻也应因连坐吊销而失效
  const afterBreach = await refreshOnce(firstBody.refresh_token)
  expect(afterBreach.status).toBe(401)
})

test('service-token：正确凭证签发访问令牌，且不含 refresh_token', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const hash = await Bun.password.hash('s3cr3t', { algorithm: 'argon2id' })
  await pool.execute(
    `INSERT INTO service_accounts (id, name, secret_hash, tm_userid, enabled, expires_at, created_at)
     VALUES (?, ?, ?, ?, 1, NULL, ?)`,
    ['svc-http-1', '归档机器人', hash, 'tm-svc-http-1', NOW],
  )

  const res = await app(
    new Request('https://gw/api/v1/auth/service-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'svc-http-1', client_secret: 's3cr3t' }),
    }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, unknown>
  expect(body.access_token).toBeTruthy()
  expect(body.refresh_token).toBeUndefined()
})

test('service-token：错误凭证返回 401 invalid_credentials，不泄露账号是否存在', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw/api/v1/auth/service-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'svc-does-not-exist', client_secret: 'whatever' }),
    }),
  )
  expect(res.status).toBe(401)
  expect((await res.json()).error).toBe('invalid_credentials')
})

test('logout：吊销 refresh_token 后该 token 无法再用于刷新', async () => {
  const clock = stepClock(NOW)
  const { app } = buildTestApp(pool, {
    now: clock.now,
    wecomExchangeCode: async () => ({ userId: 'ww-noah-1', email: null }),
  })

  const codeBody = (await (
    await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  ).json()) as { device_code: string }
  const state = await lookupState(codeBody.device_code)
  await app(new Request(`https://gw/auth/wecom/callback?code=c&state=${state}`))
  clock.advance(10)
  const tokens = (await (
    await app(
      new Request('https://gw/api/v1/auth/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: codeBody.device_code }),
      }),
    )
  ).json()) as { refresh_token: string }

  const logoutRes = await app(
    new Request('https://gw/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }),
  )
  expect(logoutRes.status).toBe(200)

  const refreshRes = await app(
    new Request('https://gw/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }),
  )
  expect(refreshRes.status).toBe(401)
})

test('logout 对不存在/已吊销的 refresh_token 仍返回 200（幂等，不泄露有效性）', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'never-issued-refresh-token' }),
    }),
  )
  expect(res.status).toBe(200)
})
