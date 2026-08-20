import { afterAll, beforeAll, expect, test } from 'bun:test'
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

/**
 * 本部署不创建企业微信自建应用（M3.5 的部署决策）：设备授权流程整体停用，
 * 客户端只走服务账号认证。这里锁定「停用」的可观测形态——
 * 依赖企微的四个路由统一 501，其余端点完全不受影响。
 */

const WECOM_DEPENDENT: Array<[string, string]> = [
  ['POST', '/api/v1/auth/device/code'],
  ['POST', '/api/v1/auth/device/token'],
  ['GET', '/auth/wecom/callback'],
  ['GET', '/device'],
]

for (const [method, path] of WECOM_DEPENDENT) {
  test(`企微未配置时 ${method} ${path} 返回 501`, async () => {
    const { app } = buildTestApp(pool, { wecomDisabled: true })
    const res = await app(new Request(`https://gw${path}`, { method }))
    expect(res.status).toBe(501)
    expect((await res.json()).error).toBe('wecom_not_configured')
  })
}

/**
 * device/code 也被挡住是刻意的：设备授权只能由 wecomCallback 完成
 * （completeAuthorization 仅在那里被调用），没有企微就永远走不完。发一个注定
 * 无法被授权的 device_code，比直接说「本部署未启用」更糟——客户端会一直轮询到超时。
 */
test('企微未配置时不会签发注定无法完成授权的 device_code', async () => {
  const { app } = buildTestApp(pool, { wecomDisabled: true })
  const res = await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  expect(res.status).toBe(501)
  expect(await res.text()).not.toContain('device_code')
})

test('企微未配置不影响服务账号认证端点（仍走正常的凭证校验路径）', async () => {
  const { app } = buildTestApp(pool, { wecomDisabled: true })
  const res = await app(
    new Request('https://gw/api/v1/auth/service-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'nobody', client_secret: 'wrong' }),
    }),
  )
  // 关键是「不是 501」——凭证不存在时的 401 属于正常业务路径
  expect(res.status).toBe(401)
  expect((await res.json()).error).toBe('invalid_credentials')
})

test('企微未配置不影响 healthz 与 webhook 等无关端点', async () => {
  const { app } = buildTestApp(pool, { wecomDisabled: true })
  expect((await app(new Request('https://gw/healthz'))).status).toBe(200)

  const webhookRes = await app(
    new Request('https://gw/webhook/tencent-meeting', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x' }),
    }),
  )
  expect(webhookRes.status).toBe(401) // 缺验签参数，而非 501
})

test('企微已配置时这些路由不再返回 501', async () => {
  const { app } = buildTestApp(pool)
  const res = await app(new Request('https://gw/api/v1/auth/device/code', { method: 'POST' }))
  expect(res.status).toBe(200)
})
