/**
 * 只读角色（阶段 5 · A8，spec §2 「角色与权限」· §11 缺口 1）。
 *
 * ## 这个文件为什么遍历路由表，而不是一条条列端点
 *
 * 计划 §11.1 写着「每个写端点各有一条『只读账号被 403 挡住』的用例，
 * 少一条就是一个洞」。手写清单确实能覆盖今天这 19 条，但**它覆盖不了明天新增的
 * 那一条**——而漏掉一条的表现是：一个只读账号能改规则、能停用采集程序、能触发
 * 不可逆的清理，全过程没有任何报错，界面上也看不出异常。这类洞不会被用户报告，
 * 只会在事后审计里被发现。
 *
 * 所以判据从「我列全了吗」换成「路由表里还有没有没挡住的」：
 * `listRoutes()`（src/http/router.ts）给出全部端点，本文件对**每一条非 GET 的
 * admin 路由**发一个只读会话的请求，断言 403。新加一条端点而忘了换
 * `requireAdminWrite`，这条用例当场红。
 *
 * 白名单（`READONLY_ALLOWED`）里那三条各有各的理由，逐条写在下面——
 * 白名单必须是「显式的短清单 + 每条一个理由」，而不是一个可以随手加东西的口袋。
 *
 * ## 它走的是真路由 + 真库
 *
 * 与 tests/http/console-*.test.ts 那种「注入假件直接调 handler」不同：
 * 这里要验的恰恰是**装配**——角色从库里的一行出发，经过会话校验、经过路由派发，
 * 最后在 handler 的第一句被用上。中间任何一环掉了，假件都测不出来。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp } from './testApp'
import { listRoutes } from '../../src/http/router'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'
import { createAdminStore } from '../../src/store/admin'
import { createAdminAuth } from '../../src/auth/admin'

let pool: Pool
let cleanup: () => Promise<void>
let adminCookie: string
let readonlyCookie: string

const NOW = 1_700_000_000

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup

  const store = createAdminStore(pool)
  const auth = createAdminAuth({ store })
  await store.createAccount({
    id: 'admin-full', username: 'boss', passwordHash: 'h', now: NOW, role: 'admin',
  })
  await store.createAccount({
    id: 'admin-ro', username: 'watcher', passwordHash: 'h', now: NOW, role: 'readonly',
  })
  adminCookie = (await auth.issueSession('admin-full', true, NOW)).token
  readonlyCookie = (await auth.issueSession('admin-ro', true, NOW)).token
})
afterAll(() => cleanup())

/**
 * 非 GET 但**允许只读角色**的 admin 端点。三条，各有理由：
 *
 * - `POST /auth/login` —— 登录时还没有角色可言。它根本不过 requireAdminAuth。
 * - `POST /auth/logout` —— 撤销的是调用者自己的会话。挡住它等于让一个只读账号
 *   无法退出登录，而「登不出去」本身就是一个安全问题：共用机器上那张 cookie
 *   会一直活着。它改的不是任何系统状态。
 * - `POST /auth/password` —— 改的是调用者自己的凭据，不是系统状态，也不改角色。
 *   挡住它防不住任何越权，只会让一个怀疑自己密码泄露的只读操作员无法自救。
 *   理由与代码写在 handlers/console/auth.ts 的 changePassword 上。
 *
 * **往这个集合里加东西之前**：问一句「这条端点改的是调用者自己的东西，
 * 还是别人也看得见的状态」。后者一律不进这个集合。
 */
const READONLY_ALLOWED = new Set([
  'POST /api/v1/admin/auth/login',
  'POST /api/v1/admin/auth/logout',
  'POST /api/v1/admin/auth/password',
])

/**
 * 会写审计但本质是读的两条（计划 §11.1 明写的例外）。
 *
 * 管理员查看会议内容会留痕（spec §2），**被规则禁止采集的那些尤其**——
 * 但「看内容」本身正是只读角色该有的权限。留痕照记，不因为角色是只读就少记一条。
 * 它们是 GET，本来就不在本文件的 403 断言范围内；单独列出来是为了让下面那条
 * 「只读账号读得到内容」的用例指得住它们。
 */
const READ_BUT_AUDITED = [
  '/api/v1/admin/meetings/:meetingId/content',
  '/api/v1/admin/meetings/:meetingId/content/chapters',
]

/**
 * 路径参数换成一个无害的占位值。角色判断在 handler 第一句，走不到参数校验——
 * 但**管理员那条对照用例会走到**，所以 `:kind` 给一个合法值（`meeting_overrides.kind`
 * 只认三个字面量，随便填会让 store 抛异常，把对照用例的输出淹在一堆 500 里）。
 */
const PARAM_PLACEHOLDER: Record<string, string> = { kind: 'allow' }

function fillParams(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? PARAM_PLACEHOLDER[seg.slice(1)] ?? 'placeholder-1' : seg))
    .join('/')
}

function adminWriteRoutes(): { method: string; path: string }[] {
  return listRoutes().filter(
    (r) =>
      r.path.startsWith('/api/v1/admin/') &&
      r.method !== 'GET' &&
      !READONLY_ALLOWED.has(`${r.method} ${r.path}`),
  )
}

function request(route: { method: string; path: string }, cookie: string): Request {
  return new Request(`https://gw.example${fillParams(route.path)}`, {
    method: route.method,
    headers: { 'content-type': 'application/json', cookie: `${ADMIN_SESSION_COOKIE}=${cookie}` },
    // 空对象而不是不带 body：几个 handler 会先 readJson，缺 body 时它们各自
    // 报 400。角色判断排在那之前，但空对象让「403 之外的那些响应」也是可解释的
    body: route.method === 'DELETE' ? undefined : JSON.stringify({}),
  })
}

// ── 一、路由表里每一条写端点都挡得住只读账号 ────────────────────────────

test('路由表里非 GET 的 admin 端点一条不少地被数到（清单不为空，且含已知的几条）', async () => {
  const keys = adminWriteRoutes().map((r) => `${r.method} ${r.path}`)
  // 兜底：如果哪天 listRoutes 的形状变了、或者过滤条件写错，这里会先红，
  // 而不是让下面那条循环用例在一个空清单上「全部通过」
  expect(keys.length).toBeGreaterThanOrEqual(19)
  for (const expected of [
    'POST /api/v1/admin/accounts',
    'DELETE /api/v1/admin/accounts/:id',
    // 改角色（本轮新增）。它是写操作里最该挡住只读账号的那一条：放过去等于
    // 一个只读账号能把自己提成管理员，那样角色这套东西就不存在了
    'PATCH /api/v1/admin/accounts/:id',
    'POST /api/v1/admin/programs',
    'PATCH /api/v1/admin/programs/:id',
    'POST /api/v1/admin/programs/:id/rotate-secret',
    'POST /api/v1/admin/meetings/:meetingId/grants',
    'DELETE /api/v1/admin/meetings/:meetingId/grants/:programId',
    'PUT /api/v1/admin/meetings/:meetingId/override',
    'DELETE /api/v1/admin/meetings/:meetingId/override/:kind',
    'POST /api/v1/admin/storage/retention-days',
    'POST /api/v1/admin/storage/cleanup-pause',
    'POST /api/v1/admin/storage/cleanup-now',
    'POST /api/v1/admin/meetings/:meetingId/extend',
    'POST /api/v1/admin/rules',
    'POST /api/v1/admin/rules/preview',
    'PATCH /api/v1/admin/rules/:id',
    'DELETE /api/v1/admin/rules/:id',
    'POST /api/v1/admin/jobs/:name/run',
  ]) {
    expect(keys).toContain(expected)
  }
})

test('每一条非 GET 的 admin 端点都用 403 readonly_role 挡住只读账号', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const leaks: string[] = []

  for (const route of adminWriteRoutes()) {
    const res = await app(request(route, readonlyCookie))
    if (res.status !== 403) {
      leaks.push(`${route.method} ${route.path} → ${res.status}（期望 403）`)
      continue
    }
    const body = (await res.json()) as { error?: string; message?: string }
    if (body.error !== 'readonly_role') {
      leaks.push(`${route.method} ${route.path} → 403 但 error=${String(body.error)}`)
      continue
    }
    // 403 要说得出原因：光一个状态码会让前端只能显示「操作失败」
    expect(body.message).toContain('只读')
  }

  // 一次报全部，而不是在第一条上就断掉——漏掉的往往不止一条
  expect(leaks).toEqual([])
})

test('同样的请求换成管理员账号就不会撞上 readonly_role（证明上一条测的是角色而不是别的）', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const wrong: string[] = []

  for (const route of adminWriteRoutes()) {
    const res = await app(request(route, adminCookie))
    // 管理员这条路上会撞到 400 / 404 / 503 各种业务错（占位参数、空请求体），
    // 那些都正常。**唯独不能是 readonly_role**——那说明守卫连管理员也挡了
    if (res.status !== 403) continue
    const body = (await res.json()) as { error?: string }
    if (body.error === 'readonly_role') wrong.push(`${route.method} ${route.path}`)
  }

  expect(wrong).toEqual([])
})

// ── 二、只读账号读得到东西（挡的是写，不是登录） ────────────────────────

test('GET /auth/me 下发 role，只读账号看到的是 readonly', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw.example/api/v1/admin/auth/me', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${readonlyCookie}` },
    }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ adminId: 'admin-ro', username: 'watcher', role: 'readonly' })
})

test('GET /auth/me 对管理员下发 role: admin', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw.example/api/v1/admin/auth/me', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${adminCookie}` },
    }),
  )
  expect(((await res.json()) as { role: string }).role).toBe('admin')
})

test('只读账号读得到规则、程序、审计、任务四张表', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  for (const path of [
    '/api/v1/admin/rules',
    // 条件字段与运算符清单（阶段 5 · A9）。只读角色也要能打开规则编辑器看
    // 「这条规则是按什么判的」，拿不到清单那一页就只剩一堆英文字段名
    '/api/v1/admin/rules/schema',
    '/api/v1/admin/programs',
    '/api/v1/admin/audit',
    '/api/v1/admin/jobs',
    '/api/v1/admin/storage',
  ]) {
    const res = await app(
      new Request(`https://gw.example${path}`, {
        headers: { cookie: `${ADMIN_SESSION_COOKIE}=${readonlyCookie}` },
      }),
    )
    expect({ path, status: res.status }).toEqual({ path, status: 200 })
  }
})

test('会写审计的那两条内容端点仍对只读开放（留痕照记，权限不因此收紧）', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  for (const path of READ_BUT_AUDITED) {
    const res = await app(
      new Request(`https://gw.example${fillParams(path)}`, {
        headers: { cookie: `${ADMIN_SESSION_COOKIE}=${readonlyCookie}` },
      }),
    )
    // 这场会议不存在，所以是 404 而不是 200——要紧的是**不能是 403**：
    // 「管理员要判断这条规则拦对了没有」这件事只读角色也得做（spec §2）
    expect({ path, status: res.status }).not.toEqual({ path, status: 403 })
  }
})

test('只读账号退得出登录（挡住登出本身就是一个安全问题）', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const store = createAdminStore(pool)
  const auth = createAdminAuth({ store })
  const throwaway = (await auth.issueSession('admin-ro', false, NOW)).token

  const res = await app(
    new Request('https://gw.example/api/v1/admin/auth/logout', {
      method: 'POST',
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${throwaway}` },
    }),
  )
  expect(res.status).toBe(204)
})

// ── 三、角色拿不到时按 readonly 处理（不是按 admin） ─────────────────────

test('库里是认不出来的角色值时按只读处理——认不出来落到拒绝一侧', async () => {
  const store = createAdminStore(pool)
  const auth = createAdminAuth({ store })
  await pool.execute(
    `INSERT INTO admin_accounts (id, username, password_hash, created_at, \`role\`)
     VALUES ('admin-weird', 'weird', 'h', ?, 'superadmin')`,
    [NOW],
  )
  const cookie = (await auth.issueSession('admin-weird', true, NOW)).token

  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw.example/api/v1/admin/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${ADMIN_SESSION_COOKIE}=${cookie}` },
      body: JSON.stringify({}),
    }),
  )
  expect(res.status).toBe(403)
  expect(((await res.json()) as { error: string }).error).toBe('readonly_role')
})

test('未登录时是 401 而不是 403——两种失败前端要分得开（一个跳登录，一个提示权限）', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw.example/api/v1/admin/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
  expect(res.status).toBe(401)
  expect(((await res.json()) as { error: string }).error).toBe('missing_admin_session')
})
