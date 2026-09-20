import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import type { ActorIdentity } from '../../src/domain/types'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp, JWT_SECRET } from './testApp'
import { signAccessToken } from '../../src/auth/tokens'
import { TencentApiError } from '../../src/tencent/errors'

let pool: Pool
let cleanup: () => Promise<void>
beforeAll(async () => { const db = await withTestDb(); pool = db.pool; cleanup = db.cleanup })
afterAll(() => cleanup())

const NOW = 1_700_000_000
const alice: ActorIdentity = { kind: 'service_account', wecomUserId: null, tmUserId: 'tm-a', programId: 'prog-a' }
function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken(alice, JWT_SECRET, NOW)}` }
}
function listReq(): Request {
  return new Request('http://gw.example/api/v1/meetings?from=1&to=2', { headers: bearer() })
}

/**
 * 网关自己不调腾讯了（会议读 meeting_cache），所以这里把 recordsApi 换成一个只会
 * 抛错的实现：验的是路由层把各类异常映射成哪个响应，与异常从哪一层冒出来无关
 */
function appThatThrows(err: Error): (req: Request) => Promise<Response> {
  const { app, deps } = buildTestApp(pool, { now: () => NOW })
  deps.recordsApi = { listMeetings: async () => { throw err } }
  return app
}

test('腾讯 fatal 错误（如 9042 配错凭证）→ 502 upstream_config_error，透出 tencent_code', async () => {
  const app = appThatThrows(new TencentApiError(9042, 500, 'signature invalid'))
  const res = await app(listReq())
  expect(res.status).toBe(502)
  expect(await res.json()).toEqual({ error: 'upstream_config_error', tencent_code: 9042 })
})

test('腾讯 transient 错误 → 503 upstream_unavailable', async () => {
  const app = appThatThrows(new TencentApiError(190310, 500, 'rate limited'))
  const res = await app(listReq())
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ error: 'upstream_unavailable', tencent_code: 190310 })
})

test('腾讯 asset_permanent（4051）→ 404 asset_not_found', async () => {
  const app = appThatThrows(new TencentApiError(4051, 400, 'file not exist'))
  const res = await app(listReq())
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'asset_not_found', tencent_code: 4051 })
})

test('非腾讯的未知异常仍返回不透明 500（不泄露内部细节）', async () => {
  const app = appThatThrows(new Error('some internal boom'))
  const res = await app(listReq())
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({ error: 'internal_error' })
})
