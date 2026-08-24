/**
 * 管理员会话 API。**刻意不经过 `api/mock/` 那层**——`mockApi(state)` 是为
 * "会议/程序列表"这类业务数据准备的五态模拟（ok/loading/load-failed/empty/…），
 * 登录态是完全不同性质的东西：有真实的 httpOnly cookie、有真实的 401，硬塞进
 * 同一个 mock 抽象只会让两者都变形。这里直接 `fetch`，是有意的架构分界，不是遗漏。
 */

export interface AdminIdentity {
  adminId: string
  username: string
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
  return res.json()
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
  return res.json()
}
