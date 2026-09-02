import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readRole, fetchAdminIdentity, adminLogin } from '../src/api/admin'
import { ApiError, ForbiddenError, UnauthorizedError, apiGet, apiSend } from '../src/api/client'
import { SessionProvider, useRole, useReadonly, readonlyTitle, ROLE_LINE } from '../src/app/session'
import { PageShell } from '../src/ui/PageShell'

/**
 * 只读角色（spec §11 缺口 1）。
 *
 * 这一整个文件盯的是同一件事：**"没读到角色"必须落到"不能改"那一侧**。
 * 前端的降级不是权限（权限是 A8 在 18 条写端点上的 403），但降级落错方向会
 * 让人以为自己改成了——所以每一条"读不到"的路径都单独有一条用例。
 */

const realFetch = globalThis.fetch

function install(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return Promise.resolve(handler(url, init))
  }) as typeof fetch
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('readRole：只有一个取值算管理员，其余全部落到只读', () => {
  test('role === "admin" 才是管理员', () => {
    expect(readRole({ role: 'admin' })).toBe('admin')
  })

  test('role === "readonly" 是只读', () => {
    expect(readRole({ role: 'readonly' })).toBe('readonly')
  })

  test('**没有 role 这个键**时是只读，不是管理员', () => {
    expect(readRole({ adminId: 'a', username: 'b' })).toBe('readonly')
  })

  test('认不出来的取值是只读，不是"当作管理员先放行"', () => {
    expect(readRole({ role: 'superuser' })).toBe('readonly')
    expect(readRole({ role: 'ADMIN' })).toBe('readonly')
    expect(readRole({ role: 1 })).toBe('readonly')
    expect(readRole({ role: null })).toBe('readonly')
  })

  test('根本不是对象时是只读', () => {
    expect(readRole(null)).toBe('readonly')
    expect(readRole('admin')).toBe('readonly')
    expect(readRole(undefined)).toBe('readonly')
  })
})

describe('GET /auth/me 把 role 带回来', () => {
  test('下发 admin 时是管理员', async () => {
    install(() => jsonResponse(200, { adminId: 'a-1', username: 'alice', role: 'admin' }))
    await expect(fetchAdminIdentity()).resolves.toEqual({
      signedIn: true,
      identity: { adminId: 'a-1', username: 'alice', role: 'admin' },
    })
  })

  test('下发 readonly 时是只读', async () => {
    install(() => jsonResponse(200, { adminId: 'a-2', username: 'bob', role: 'readonly' }))
    const me = await fetchAdminIdentity()
    expect(me.signedIn && me.identity.role).toBe('readonly')
  })

  test('旧后端不下发 role 时按只读处理（回归：不许折成 admin）', async () => {
    install(() => jsonResponse(200, { adminId: 'a-3', username: 'carol' }))
    const me = await fetchAdminIdentity()
    expect(me.signedIn && me.identity.role).toBe('readonly')
  })

  test('401 仍然不抛（这条路径没被角色改动碰坏）', async () => {
    install(() => jsonResponse(401, { error: 'missing_admin_session' }))
    await expect(fetchAdminIdentity()).resolves.toEqual({ signedIn: false, rejected: false })
  })

  // ── 「从来没登录过」与「带着令牌被拒了」必须分得开 ──────────────
  //
  // 这两种都是 401、都落到同一张空登录表单前，但后者的人**以为自己好好地登着**。
  // 折成同一个值（原来的 `null`）的代价，是登录页说不出「你为什么在这儿」——
  // 于是他会认为系统坏了，去找一个并不存在的原因（比如「要手工清 cookie」）。

  test('invalid_admin_session：带了令牌、被服务端拒了 → rejected', async () => {
    install(() => jsonResponse(401, { error: 'invalid_admin_session' }))
    await expect(fetchAdminIdentity()).resolves.toEqual({ signedIn: false, rejected: true })
  })

  test('读不出错误码时按「没带令牌」处理——拿不准就少说一句', async () => {
    install(() => new Response('', { status: 401 }))
    await expect(fetchAdminIdentity()).resolves.toEqual({ signedIn: false, rejected: false })
  })

  test('缺 adminId / username 时抛，不折成空串', async () => {
    install(() => jsonResponse(200, { role: 'admin' }))
    await expect(fetchAdminIdentity()).rejects.toThrow(/adminId/)
  })

  test('登录响应同样过一遍角色归一化', async () => {
    install(() => jsonResponse(200, { adminId: 'a-4', username: 'dave' }))
    await expect(adminLogin('dave', 'pw', false)).resolves.toEqual({
      adminId: 'a-4',
      username: 'dave',
      role: 'readonly',
    })
  })
})

describe('403 与 401 是两件事', () => {
  test('403 抛 ForbiddenError，且用后端那句中文当 message', async () => {
    install(() =>
      jsonResponse(403, {
        error: 'readonly_role',
        role: 'readonly',
        message: '这个账号是只读角色（spec §2），只能查看、不能改任何状态。',
      }),
    )
    const err = (await apiSend('POST', '/api/v1/admin/jobs/x/run').catch((e: unknown) => e)) as ForbiddenError
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).not.toBeInstanceOf(UnauthorizedError)
    expect(err.status).toBe(403)
    expect(err.message).toBe('这个账号是只读角色（spec §2），只能查看、不能改任何状态。')
  })

  test('403 没带 message 时自己拼一句，仍然带端点名与错误码', async () => {
    install(() => jsonResponse(403, { error: 'readonly_role' }))
    const err = (await apiGet('/api/v1/admin/storage').catch((e: unknown) => e)) as ForbiddenError
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err.message).toContain('/api/v1/admin/storage')
    expect(err.message).toContain('readonly_role')
  })
})

/* ── 界面层 ─────────────────────────────────────────────────────── */

function Probe() {
  const role = useRole()
  const ro = useReadonly()
  return (
    <p>
      角色={role} 只读={String(ro)} title={String(readonlyTitle(ro))}
    </p>
  )
}

describe('useRole：没有 Provider 时落到只读', () => {
  test('裸渲染（没有 SessionProvider）是只读', () => {
    render(<Probe />)
    expect(screen.getByText(/角色=readonly/)).toBeInTheDocument()
    expect(screen.getByText(/只读=true/)).toBeInTheDocument()
    expect(screen.getByText(/title=只读账号不能改/)).toBeInTheDocument()
  })

  test('Provider 给 admin 时可写，且 title 不留空串', () => {
    render(
      <SessionProvider identity={{ adminId: 'a', username: 'alice', role: 'admin' }}>
        <Probe />
      </SessionProvider>,
    )
    expect(screen.getByText(/角色=admin/)).toBeInTheDocument()
    expect(screen.getByText(/只读=false/)).toBeInTheDocument()
    expect(screen.getByText(/title=undefined/)).toBeInTheDocument()
  })

  test('用户菜单那一行随角色变（spec §11 缺口 1 点名的那句话）', () => {
    expect(ROLE_LINE.admin).toBe('数据管理员 · 可改规则与授权')
    expect(ROLE_LINE.readonly).not.toBe(ROLE_LINE.admin)
    expect(ROLE_LINE.readonly).toContain('只读')
  })
})

describe('PageShell：只读时每一页都带一句说明', () => {
  test('只读账号看得到说明条', () => {
    render(
      <SessionProvider identity={{ adminId: 'a', username: 'bob', role: 'readonly' }}>
        <PageShell title="自动规则" />
      </SessionProvider>,
    )
    const note = screen.getByTestId('readonly-banner')
    expect(note).toHaveTextContent('只读角色')
    expect(note).toHaveTextContent('管理员')
  })

  test('管理员看不到它（它不是常驻噪音）', () => {
    render(
      <SessionProvider identity={{ adminId: 'a', username: 'alice', role: 'admin' }}>
        <PageShell title="自动规则" />
      </SessionProvider>,
    )
    expect(screen.queryByTestId('readonly-banner')).toBeNull()
  })
})
