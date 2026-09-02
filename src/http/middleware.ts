import {
  AccessTokenExpiredError,
  AccessTokenInvalidError,
  verifyAccessToken,
} from '../auth/tokens'
import type { ActorIdentity } from '../domain/types'
import type { AdminAuth, AdminIdentity } from '../auth/admin'
import { AdminSessionInvalidError } from '../auth/admin'
import { json } from './respond'

export type AuthResult =
  | { ok: true; identity: ActorIdentity }
  | { ok: false; response: Response }

/**
 * 校验 Authorization: Bearer <access_token>。
 *
 * 三种失败必须可区分（供客户端决定是否该静默重新登录还是提示错误）：
 * - 缺失/格式不对   → 401 missing_token
 * - 签名无效/伪造   → 401 invalid_token
 * - 已过期         → 401 token_expired（且与其余两种失败分开，便于客户端
 *                     自动触发 refresh 流程而不是要求用户重新登录）
 */
export function requireAuth(req: Request, secret: string, now: number): AuthResult {
  const header = req.headers.get('authorization')
  if (!header || !header.startsWith('Bearer ')) {
    return { ok: false, response: json(401, { error: 'missing_token' }) }
  }

  const token = header.slice('Bearer '.length).trim()
  if (token.length === 0) {
    return { ok: false, response: json(401, { error: 'missing_token' }) }
  }

  try {
    const identity = verifyAccessToken(token, secret, now)
    return { ok: true, identity }
  } catch (err) {
    if (err instanceof AccessTokenExpiredError) {
      return { ok: false, response: json(401, { error: 'token_expired' }) }
    }
    if (err instanceof AccessTokenInvalidError) {
      return { ok: false, response: json(401, { error: 'invalid_token' }) }
    }
    throw err
  }
}

/** 客户端类型：仅用于审计留痕，缺失时置为 unknown，不阻断请求 */
export function clientKindOf(req: Request): string {
  return req.headers.get('x-client-kind') ?? 'unknown'
}

export const ADMIN_SESSION_COOKIE = 'mde_admin_session'

export type AdminAuthResult =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; response: Response }

/**
 * 从 Cookie 头里取指定名字的值。Cookie 头可能同时携带多个 cookie
 * （`foo=bar; mde_admin_session=xxx; baz=qux`），必须按 `;` 拆分后逐个匹配
 * 名字，不能假设目标 cookie 是唯一或第一个。
 *
 * 导出而不是留作模块私有：handlers/console/auth.ts 的 logout 也要读同一个 cookie，
 * 各写一份的代价不是重复代码而是**静默的安全失败**——logout 那份曾经把 cookie 名
 * 写成正则里的字面量，一旦 ADMIN_SESSION_COOKIE 改名，浏览器侧的 cookie 照样被清掉
 * （客户端看起来已登出），服务端的会话却再也撤销不掉。要读 cookie 一律走这个函数。
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/**
 * 在一个响应上附「把浏览器手里那张会话 cookie 作废」的指令。
 *
 * ## 为什么服务端判无效之后必须主动清
 *
 * 服务端说这张令牌不认了，浏览器却还按签发时的 `Max-Age`（勾了「记住此设备」
 * 就是 30 天）继续留着它，附在此后每一个请求上。两边对「我登录了没有」的答案
 * 从此不一致，而**产品里没有任何一条路径能让人把它弄掉**——普通用户不会去开
 * 开发者工具删 cookie。所以拒绝这张令牌的那一刻，就是告诉浏览器扔掉它的那一刻，
 * 这件事不该落到人身上。
 *
 * ## 为什么这条删除指令不带 `Secure`
 *
 * cookie 的身份是 (name, domain, path) 三元组，`Secure` 不在其中：https 下一条
 * 不带 Secure 的删除指令照样删得掉一张 Secure 的 cookie。反过来在本地开发
 * （http）下发一条带 Secure 的删除指令，浏览器会整条丢弃——删除**静静地**不生效，
 * 而这正是最难排查的那种失败。一条在两种部署下都成立的写法，胜过两条各自成立、
 * 靠调用方挑对的写法，所以这里不接 `cookieSecure`。
 *
 * Path / HttpOnly / SameSite 必须与签发时（`handlers/console/auth.ts` 的
 * `cookieAttrs`）一致，否则浏览器认为这是另一张 cookie，删除落空。
 */
export function clearAdminSessionCookie(res: Response): Response {
  res.headers.append(
    'set-cookie',
    `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  )
  return res
}

/**
 * 管理员会话校验。与 requireAuth 并列但签名故意不同——管理员会话（Task 3，
 * A1）落库在 admin_sessions 表，校验必须查库（并可能触发滑动续期的 UPDATE），
 * 做不成同步函数。
 */
export async function requireAdminAuth(
  req: Request,
  adminAuth: AdminAuth,
  now: number,
): Promise<AdminAuthResult> {
  const token = readCookie(req, ADMIN_SESSION_COOKIE)
  if (token === null) {
    return { ok: false, response: json(401, { error: 'missing_admin_session' }) }
  }
  try {
    const identity = await adminAuth.verifySession(token, now)
    return { ok: true, identity }
  } catch (err) {
    if (err instanceof AdminSessionInvalidError) {
      // 浏览器确实带了一张令牌，服务端判定它无效——顺手让浏览器把它扔掉，
      // 理由见 clearAdminSessionCookie。上面 token === null 那一支不清：
      // 本来就没有东西可清，每个未登录请求都回一条 set-cookie 只是噪音。
      return {
        ok: false,
        response: clearAdminSessionCookie(json(401, { error: 'invalid_admin_session' })),
      }
    }
    throw err
  }
}

/**
 * 管理员**写**操作的守卫（阶段 5 · A8，spec §2 / §11 缺口 1）。
 *
 * = `requireAdminAuth` + 一句角色判断。每一个改状态的 admin handler 都改调它，
 * 读端点继续调 `requireAdminAuth`。
 *
 * ## 判断方向：只有明确是 `admin` 才放行
 *
 * 写成 `role === 'readonly' → 拒绝` 与写成 `role !== 'admin' → 拒绝` 在今天
 * 等价（`parseAdminRole` 只吐这两个值），但明天不等价——加第三个角色的那一次
 * 改动，前一种写法会把它**静默地当成管理员**放行。所以这里是白名单不是黑名单。
 *
 * 同理，`identity.role` 在类型上不可能是 undefined，但真到了运行时是
 * undefined（哪个假件漏填了、或者某条路径绕过了 store 的映射），它也落在
 * 拒绝一侧。拿不到角色按 readonly 处理，不是按 admin。
 *
 * ## 为什么不放在路由表上统一挡
 *
 * 角色要查库（会话 → 账号），而 handler 里本来就要查一次。放在路由层就是查两次，
 * 或者把校验结果穿过一个新的上下文字段传下去。真正防「漏一条」的是
 * `tests/http/console-readonly.test.ts`——它遍历路由表，任何一条新增的非 GET
 * admin 端点只要没挡住只读账号就会红。靠人一条条数是数不住的。
 */
export async function requireAdminWrite(
  req: Request,
  adminAuth: AdminAuth,
  now: number,
): Promise<AdminAuthResult> {
  const auth = await requireAdminAuth(req, adminAuth, now)
  if (!auth.ok) return auth
  if (auth.identity.role !== 'admin') {
    return {
      ok: false,
      response: json(403, {
        error: 'readonly_role',
        role: auth.identity.role,
        // 这句话必须**指向一个真的做得到的动作**。它从前写的是「请让管理员把角色
        // 改成 admin」，而那时改角色在产品里没有任何路径能执行（store 层连
        // updateRole 都没有），只能手工 UPDATE 库——一条指向不存在的操作的提示语，
        // 比不给提示更糟：看到它的人会去点一个不存在的按钮，然后以为是自己没找到。
        // 现在有 PATCH /api/v1/admin/accounts/:id 了，所以这里明说走哪条路，
        // 并说清界面上暂时还没有这一页（账号管理界面不在本轮范围内）
        message:
          '这个账号是只读角色（spec §2），只能查看、不能改任何状态。' +
          '需要改规则、改授权、延长保留或手动触发任务，' +
          '请让管理员用 PATCH /api/v1/admin/accounts/:id（请求体 {"role":"admin"}）把这个账号提成 admin' +
          '——控制台目前还没有账号管理页，这一步只能走接口。',
      }),
    }
  }
  return auth
}
