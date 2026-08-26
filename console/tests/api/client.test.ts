import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ApiError,
  UnauthorizedError,
  apiGet,
  apiSend,
  setUnauthorizedHandler,
} from '../../src/api/client'

/** 构造 Response 的小 helper（与 tests/pages/Login.test.tsx 同一形状）。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

function install(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = String(input)
      calls.push({ url, init })
      return handler(url, init)
    }),
  )
}

beforeEach(() => {
  setUnauthorizedHandler(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedHandler(null)
})

describe('apiGet · 请求的形状', () => {
  test('带 credentials: include —— httpOnly 会话 cookie 的必要条件', async () => {
    install(() => jsonResponse(200, { ok: true }))
    await apiGet('/api/v1/admin/storage')
    expect(calls[0]!.init.credentials).toBe('include')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.url).toBe('/api/v1/admin/storage')
  })

  test('undefined / null 的键不出现在 URL 里，而不是出现成 ?x=undefined', async () => {
    install(() => jsonResponse(200, []))
    await apiGet('/api/v1/admin/audit', { limit: 20, cursor: undefined, actor: null, q: '' })
    // limit 与空串都要在（空串是一次真实的取值），undefined / null 两个键要消失
    expect(calls[0]!.url).toContain('limit=20')
    expect(calls[0]!.url).toContain('q=')
    expect(calls[0]!.url).not.toContain('cursor')
    expect(calls[0]!.url).not.toContain('actor')
    expect(calls[0]!.url).not.toContain('undefined')
    expect(calls[0]!.url).not.toContain('null')
  })

  test('数组序列化成重复的键，布尔与数字照原样', async () => {
    install(() => jsonResponse(200, []))
    await apiGet('/api/v1/admin/audit', { kind: ['grant', 'revoke'], failed: true, page: 2 })
    const q = calls[0]!.url.split('?')[1] ?? ''
    expect(q.split('&').filter((p) => p.startsWith('kind='))).toEqual(['kind=grant', 'kind=revoke'])
    expect(q).toContain('failed=true')
    expect(q).toContain('page=2')
  })

  test('没有 query 时不留一个空的问号', async () => {
    install(() => jsonResponse(200, []))
    await apiGet('/api/v1/admin/jobs', { a: undefined })
    expect(calls[0]!.url).toBe('/api/v1/admin/jobs')
  })

  test('路径写错（漏了 /api/v1/admin 前缀）当场炸，不是发出去一条 404', async () => {
    install(() => jsonResponse(200, {}))
    await expect(apiGet('/storage')).rejects.toThrow(/\/api\/v1\/admin/)
    expect(calls).toHaveLength(0)
  })
})

describe('apiSend · 写操作', () => {
  test('带请求体时才有 content-type，体是 JSON', async () => {
    install(() => jsonResponse(200, { id: 42 }))
    await apiSend('POST', '/api/v1/admin/meetings/m-1/grants', { programId: 'kb', assetTypes: null })
    const init = calls[0]!.init
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({ programId: 'kb', assetTypes: null })
  })

  test('DELETE 没有请求体时不发 content-type，也不发一个 "undefined" 的体', async () => {
    install(() => jsonResponse(200, { revoked: true }))
    await apiSend('DELETE', '/api/v1/admin/meetings/m-1/grants/kb')
    const init = calls[0]!.init
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('content-type')).toBeNull()
  })

  test('204 无内容时解析成 undefined，而不是在 res.json() 上炸掉', async () => {
    install(() => new Response(null, { status: 204 }))
    await expect(apiSend('DELETE', '/api/v1/admin/accounts/3')).resolves.toBeUndefined()
  })
})

describe('错误：非 2xx 不许被吞成同一种样子', () => {
  test('400 的响应体读出来放进 ApiError.body，后端给的原因不丢', async () => {
    install(() => jsonResponse(400, { error: 'invalid_days', min: 1, max: 365 }))
    const err = await apiSend('POST', '/api/v1/admin/storage/retention-days', { days: 0 }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    const api = err as ApiError
    expect(api.status).toBe(400)
    expect(api.endpoint).toBe('POST /api/v1/admin/storage/retention-days')
    expect(api.body).toEqual({ error: 'invalid_days', min: 1, max: 365 })
    // 后端的错误码要出现在 message 里：每个错误长得一样等于没有错误信息
    expect(api.message).toContain('invalid_days')
    expect(api.message).toContain('/api/v1/admin/storage/retention-days')
  })

  test('非 JSON 的错误体按文本留下，不静默丢弃', async () => {
    install(() => new Response('upstream exploded', { status: 502 }))
    const err = (await apiGet('/api/v1/admin/jobs').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
    expect(err.body).toBe('upstream exploded')
  })

  test('200 但响应体不是 JSON —— 报出端点名，不是一句无头无尾的语法错误', async () => {
    install(
      () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    const err = (await apiGet('/api/v1/admin/storage').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toContain('/api/v1/admin/storage')
  })

  test('网络层直接拒绝（后端不可达）也包成带端点名的 ApiError', async () => {
    install(() => {
      throw new TypeError('Failed to fetch')
    })
    const err = (await apiGet('/api/v1/admin/storage').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(0)
    expect(err.endpoint).toBe('GET /api/v1/admin/storage')
    expect(err.message).toContain('Failed to fetch')
  })
})

describe('401：一个全局出口，不在每个页面各写一遍跳转', () => {
  test('401 抛的是 UnauthorizedError（它同时也是 ApiError）', async () => {
    install(() => jsonResponse(401, { error: 'invalid_admin_session' }))
    const err = (await apiGet('/api/v1/admin/storage').catch((e: unknown) => e)) as UnauthorizedError
    expect(err).toBeInstanceOf(UnauthorizedError)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.body).toEqual({ error: 'invalid_admin_session' })
  })

  test('401 会通知注册好的全局处理器，且只通知它', async () => {
    const seen: number[] = []
    setUnauthorizedHandler(() => seen.push(1))
    install(() => jsonResponse(401, { error: 'missing_admin_session' }))
    await apiGet('/api/v1/admin/jobs').catch(() => {})
    expect(seen).toHaveLength(1)

    install(() => jsonResponse(403, { error: 'readonly_account' }))
    await apiGet('/api/v1/admin/jobs').catch(() => {})
    expect(seen).toHaveLength(1) // 403 不是会话过期，不该触发跳登录
  })

  test('注销处理器之后不再回调（组件卸载后不许再改状态）', async () => {
    let n = 0
    setUnauthorizedHandler(() => {
      n += 1
    })
    setUnauthorizedHandler(null)
    install(() => jsonResponse(401, {}))
    await apiGet('/api/v1/admin/jobs').catch(() => {})
    expect(n).toBe(0)
  })
})

describe('回归：fetchAdminIdentity 不许改成走这一层', () => {
  /**
   * `GET /auth/me` 是**唯一一个 401 属于预期结果**的调用：它要返回 null 让
   * `AppShell` 跳登录。让它走 `apiGet` 就会抛 `UnauthorizedError`，触发全局
   * 401 出口 → 又跳一次登录 → 登录页把自己重定向到登录页，死循环。
   * 这条测试盯的就是「有人顺手把它统一了」。
   */
  test('src/api/admin.ts 不 import client.ts', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/api/admin.ts'), 'utf-8')
    expect(src).not.toMatch(/from\s+['"][^'"]*client['"]/)
    expect(src).not.toMatch(/\bapiGet\b|\bapiSend\b/)
  })

  test('fetchAdminIdentity 遇到 401 仍然返回 null，不抛', async () => {
    const { fetchAdminIdentity } = await import('../../src/api/admin')
    install(() => jsonResponse(401, { error: 'missing_admin_session' }))
    await expect(fetchAdminIdentity()).resolves.toBeNull()
  })
})
