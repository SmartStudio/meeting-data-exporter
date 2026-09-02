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

/**
 * 探测登录态的结果。
 *
 * ## 为什么不是 `AdminIdentity | null`
 *
 * 它原来就是。但「从来没登录过」和「登录过、服务端已经不认这张会话了」在**界面上
 * 是两回事**：前者看见一张登录表单是理所当然的，后者的人以为自己好好地登着，
 * 被静静地弹到同一张空表单前，只会认为系统坏了——然后开始怀疑是不是要手工清
 * cookie。这条类型改动的来源正是这样一次误判。
 *
 * 两者的区别后端一直在说（`missing_admin_session` / `invalid_admin_session`），
 * 是这一层把它折成了 `null` 丢掉的。
 */
export type SessionProbe =
  | { signedIn: true; identity: AdminIdentity }
  | {
      signedIn: false
      /** 浏览器确实带了一张会话令牌、而服务端拒绝了它。用来在登录页上解释「你为什么在这儿」。 */
      rejected: boolean
    }

/** 401 体里那个错误码是不是「令牌无效」——与「压根没带令牌」相对。 */
async function sessionWasRejected(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.json()
    return (
      body !== null &&
      typeof body === 'object' &&
      (body as { error?: unknown }).error === 'invalid_admin_session'
    )
  } catch {
    // 读不出错误码时按「没带令牌」处理：多说一句「你的登录失效了」给一个从没
    // 登录过的人，是在解释一件没发生过的事。拿不准就少说。
    return false
  }
}

/**
 * 探一次登录态。**401 是它预期的正常结果之一**，所以返回值而不是抛——调用方
 * （路由守卫）要的是"有没有登录"，不是异常处理流。
 */
export async function fetchAdminIdentity(): Promise<SessionProbe> {
  const res = await call('/auth/me', { method: 'GET' })
  if (res.status === 401) return { signedIn: false, rejected: await sessionWasRejected(res) }
  if (!res.ok) throw new Error(`session check failed: ${res.status}`)
  return { signedIn: true, identity: readIdentity(await res.json(), 'GET /auth/me') }
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

/** 这两个码说的是「这张会话没了」，不是「当前密码不对」。见 changePassword 里的分支。 */
const SESSION_GONE = new Set(['missing_admin_session', 'invalid_admin_session'])

const PASSWORD_ERROR: Record<string, string> = {
  missing_admin_session: '你的登录已经失效了，密码没有被修改。正在把你送回登录页——用现在的密码重新登录之后再改。',
  invalid_admin_session: '你的登录已经失效了，密码没有被修改。正在把你送回登录页——用现在的密码重新登录之后再改。',
  missing_fields: '当前密码与新密码都要填。',
  password_unchanged: '新密码和当前密码一样，等于没改。',
  invalid_current_password: '当前密码不对。这一栏必须填对——只凭浏览器里那张 cookie 就能改密码，等于一次 XSS 就能永久接管账号。',
  account_not_found: '这个账号在后端已经不存在了。请重新登录。',
  invalid_json: '请求体不是合法 JSON——这是前端的问题，请把这句话连同时间点报给维护者。',
}

/**
 * 这个错误是不是「会话没了」——而不是「当前密码不对」。
 *
 * 判据留在这一层（错误码是后端契约的一部分，UI 不该认识 `invalid_admin_session`
 * 这种字符串），动作留在 UI 层（跳登录页是界面的事）。
 */
export function isSessionGone(err: unknown): boolean {
  return err instanceof PasswordError && SESSION_GONE.has(err.code)
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
    // 401 在这条端点上有两个含义，必须分开——这是本轮修的那个死胡同：
    // 会话已经没了（管理员在命令行重置过密码、短会话到期、在别处登出）时，
    // 后端回的是 missing/invalid_admin_session，而这里从前把它当成一句普通的
    // 「改密码失败」显示在表单里。用户看着自己**填对了**的当前密码一遍遍失败，
    // 得不到任何出口——这是全站唯一一处 401 不通往登录页的地方。
    // 抛一个**认得出来**的错误就够了，跳转不在这一层做：`tests/api/client.test.ts`
    // 有一条故意写得很钝的回归测试——这个文件一律不许引用统一请求层，连提到它
    // 那两个函数的名字都不行。它钝得超过了它写下的理由（防止 /auth/me 走那一层、
    // 造成登录页把自己重定向到自己），而那个钝正是它的价值：第一个被它挡住的人
    // 如果顺手把它磨细，它就再也挡不住下一个人了——本轮就被它挡了一次，挡对了。
    // 所以这里只说「发生了什么」，「该去哪」交给调用方（`app/UserMenu.tsx`）。
    if (SESSION_GONE.has(code)) throw new PasswordError(code, PASSWORD_ERROR[code]!, null)
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
