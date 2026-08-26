/**
 * 管理员会话 API。**刻意不经过 `api/mock/` 那层**——`mockApi(state)` 是为
 * "会议/程序列表"这类业务数据准备的五态模拟（ok/loading/load-failed/empty/…），
 * 登录态是完全不同性质的东西：有真实的 httpOnly cookie、有真实的 401，硬塞进
 * 同一个 mock 抽象只会让两者都变形。这里直接 `fetch`，是有意的架构分界，不是遗漏。
 */

/**
 * 控制台只有两个角色（spec §2）。后端保证 `role` **永远是这两个之一**——
 * 库里认不出来的取值在服务端就折成 `readonly`（A8）。前端再兜一次，是因为
 * 「后端保证」与「这一次响应里真的有」是两件事：旧版本后端、中间代理、
 * 半截响应都会让这个键消失，而少一个键就默认按管理员画界面，正是要防的方向。
 */
export type AdminRole = 'admin' | 'readonly'

export interface AdminIdentity {
  adminId: string
  username: string
  role: AdminRole
}

/**
 * **读不出角色时按 `readonly` 处理**（计划 §1 第 2 条：拿不准落到安全的一侧）。
 *
 * 这一层不是权限——真正的权限是 A8 在 18 条写端点上加的 403。落到只读一侧的
 * 代价只是「本来能改的人看见一排禁用按钮，刷新一次就好了」；反过来（角色读丢了
 * 却按管理员画）的代价是让人以为自己能改、点下去才被后端拒。两者不对称，
 * 所以没有"默认 admin"这个选项。
 */
export function readRole(raw: unknown): AdminRole {
  if (raw !== null && typeof raw === 'object' && 'role' in raw) {
    if ((raw as { role: unknown }).role === 'admin') return 'admin'
  }
  return 'readonly'
}

/** 缺 adminId / username 时抛，不折成空串——空串会让用户菜单显示成一片空白，
 *  看起来像渲染坏了，而实际是这次响应就没带身份。 */
function readIdentity(raw: unknown, endpoint: string): AdminIdentity {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`${endpoint} 的响应不是一个对象，读不出管理员身份`)
  }
  const o = raw as Record<string, unknown>
  if (typeof o.adminId !== 'string' || typeof o.username !== 'string') {
    throw new Error(`${endpoint} 的响应缺 adminId / username，读不出管理员身份`)
  }
  return { adminId: o.adminId, username: o.username, role: readRole(o) }
}

const BASE = '/api/v1/admin'

/** credentials: 'include' 是让 httpOnly cookie 能被浏览器带上/收下的必要条件 */
async function call(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, credentials: 'include' })
}

export class AdminAuthError extends Error {}

export async function adminLogin(
  username: string,
  password: string,
  remember: boolean,
): Promise<AdminIdentity> {
  const res = await call('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, remember }),
  })
  if (res.status === 401) throw new AdminAuthError('账号或密码错误')
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  return readIdentity(await res.json(), 'POST /auth/login')
}

export async function adminLogout(): Promise<void> {
  await call('/auth/logout', { method: 'POST' })
}

/** 未登录返回 null，而不是抛出——调用方（路由守卫）要的是"有没有登录"这个布尔判断，
 *  不是异常处理流。401 是这个探测本身预期的正常结果之一。 */
export async function fetchAdminIdentity(): Promise<AdminIdentity | null> {
  const res = await call('/auth/me', { method: 'GET' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`session check failed: ${res.status}`)
  return readIdentity(await res.json(), 'GET /auth/me')
}

/**
 * 改自己的密码（`POST /api/v1/admin/auth/password`，A8 新增）。
 *
 * 与登录/登出同属会话域，所以放在这里而不是 `api/admin/` 下的某个域文件——
 * 它也和它们一样**不经过 `api/client.ts`**：改密码成功之后后端会吊销这个账号
 * 的其它会话，401 在这条路径上有它自己的含义（"当前密码不对"），交给全局
 * 401 出口就会被误当成会话过期、把人踢回登录页。
 *
 * 只读角色也能调它（A8 白名单三条之一）：改的是调用者自己的凭据，不是系统状态。
 */
export interface PasswordChanged {
  /** 这次被踢下线的**其它**会话数。当前这一条保留，否则改完密码立刻被踢出去。 */
  revokedOtherSessions: number
}

export class PasswordError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** `password_too_short` 时后端回带的门槛，用来把提示写准。 */
    readonly minLength: number | null,
  ) {
    super(message)
    this.name = 'PasswordError'
  }
}

const PASSWORD_ERROR: Record<string, string> = {
  missing_fields: '当前密码与新密码都要填。',
  password_unchanged: '新密码和当前密码一样，等于没改。',
  invalid_current_password: '当前密码不对。这一栏必须填对——只凭浏览器里那张 cookie 就能改密码，等于一次 XSS 就能永久接管账号。',
  account_not_found: '这个账号在后端已经不存在了。请重新登录。',
  invalid_json: '请求体不是合法 JSON——这是前端的问题，请把这句话连同时间点报给维护者。',
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChanged> {
  const res = await call('/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!res.ok) {
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await res.json()
      if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>
    } catch {
      body = {}
    }
    const code = typeof body.error === 'string' ? body.error : `http_${res.status}`
    const min = typeof body.minLength === 'number' ? body.minLength : null
    const text =
      code === 'password_too_short'
        ? `新密码太短，至少 ${min ?? 8} 位。`
        : (PASSWORD_ERROR[code] ??
          `改密码失败（POST /auth/password 返回 ${res.status}：${code}）。`)
    throw new PasswordError(code, text, min)
  }
  const raw: unknown = await res.json()
  const n =
    raw !== null && typeof raw === 'object' && typeof (raw as { revokedOtherSessions?: unknown }).revokedOtherSessions === 'number'
      ? (raw as { revokedOtherSessions: number }).revokedOtherSessions
      : 0
  return { revokedOtherSessions: n }
}
