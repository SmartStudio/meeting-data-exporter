/**
 * 统一的请求层，给 33 条 admin 端点共用。
 *
 * 它是从 `api/admin.ts` 的私有 `call()` 抽出来的——那一版只服务三条会话端点，
 * 每加一个域就复制一遍「拼 URL / 带 cookie / 判 401 / 读错误体」四件事，
 * 复制到第七遍时它们一定已经不一样了。
 *
 * ## 三条约定
 *
 * 1. **路径写全**。`apiGet('/api/v1/admin/storage')`，不是 `apiGet('/storage')`。
 *    契约文档（`<SCRATCH>/api-contracts.md`）里每条端点写的就是全路径，
 *    照抄过来即可，中间没有一步"减去前缀"的心算。写漏了前缀当场抛开发期错误，
 *    不是悄悄发出去一条 404。
 * 2. **401 一律抛 `UnauthorizedError`**，页面不处理它，由 `AppShell` 注册的
 *    全局出口（`setUnauthorizedHandler`）统一跳登录。
 *    **唯一的例外是 `fetchAdminIdentity()`**（`api/admin.ts`）：它探的就是
 *    "有没有登录"，401 是它预期的正常结果，必须返回 `null` 而不是抛。
 *    所以 `api/admin.ts` 刻意不走这一层，`tests/api/client.test.ts` 有一条
 *    回归测试盯着这件事——把它并进来的表现是登录页把自己重定向到登录页，死循环。
 * 3. **非 2xx 的响应体读出来放进 `ApiError.body`**。后端的 400 是带原因的
 *    （`{ error: 'invalid_days', min: 1, max: 365 }`），吞掉它等于让每个错误
 *    都长得一样，页面上只能显示"操作失败"。
 */

/** 全部 admin 端点共同的前缀。路径必须以它开头，见文件头第 1 条。 */
const ADMIN_PREFIX = '/api/v1/admin/'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** `"GET /api/v1/admin/storage"`。错误落到界面上时要说清是哪一条端点。 */
    readonly endpoint: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 会话过期。调用方（页面）不处理它，由一个全局的 401 出口统一跳登录。
 *
 * 构造签名与 `ApiError` 一致，是为了让 `catch (e) { if (e instanceof ApiError) }`
 * 这种写法照样把它接住——它先是一个 ApiError，然后才是一个更具体的原因。
 */
export class UnauthorizedError extends ApiError {
  constructor(status: number, endpoint: string, message: string, body?: unknown) {
    super(status, endpoint, message, body)
    this.name = 'UnauthorizedError'
  }
}

type UnauthorizedHandler = () => void

let unauthorizedHandler: UnauthorizedHandler | null = null

/**
 * 注册全局 401 出口。`AppShell` 挂载时注册、卸载时注销（传 `null`）——
 * 注销这一步不是礼貌，是必要的：不注销的话，组件卸载之后的一次 401 仍会去
 * 改一个已经不存在的组件的状态。
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler
}

/**
 * query 序列化。`undefined` 与 `null` 的键**不出现在 URL 里**——
 * 两者都是"不带这个参数"的意思，而 `String(undefined)` / `String(null)` 会把它们
 * 变成 `?x=undefined` / `?x=null` 两个真实的、后端会当成字符串收下的取值。
 *
 * 空串保留：`?q=` 是一次真实的取值（"搜索词为空"），与"没有搜索词"不是一回事。
 * 数组展开成重复的键（`?kind=grant&kind=revoke`）。
 */
function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue
        params.append(key, String(item))
      }
      continue
    }
    params.append(key, String(value))
  }
  const s = params.toString()
  return s === '' ? '' : `?${s}`
}

/** 响应体读一次：能当 JSON 解就给对象，否则给原始文本，都失败给 undefined。 */
async function readBody(res: Response): Promise<unknown> {
  let text: string
  try {
    text = await res.text()
  } catch {
    return undefined
  }
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** 从后端错误体里取出那个错误码，放进 message —— 否则每个错误都长得一样。 */
function describeBody(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200)
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const code = (body as { error: unknown }).error
    if (typeof code === 'string') return code
  }
  return ''
}

async function request<T>(
  method: string,
  path: string,
  query: Record<string, unknown> | undefined,
  body: unknown,
  hasBody: boolean,
): Promise<T> {
  if (!path.startsWith(ADMIN_PREFIX)) {
    // 开发期错误，不是运行时错误：路径写漏了前缀，请求发出去也只会拿到 404。
    throw new Error(
      `api/client: 路径要写全（以 ${ADMIN_PREFIX} 开头），收到的是 "${path}"。` +
        '契约文档里每条端点写的就是全路径，照抄即可。',
    )
  }

  const url = `${path}${buildQuery(query)}`
  const endpoint = `${method} ${path}`

  const init: RequestInit = { method, credentials: 'include' }
  if (hasBody) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    // 后端不可达 / DNS / CORS。status 0 表示"这次请求根本没有拿到响应"，
    // 与"拿到了一个 5xx"是两件不同的事，界面上给的话也不一样。
    const reason = e instanceof Error ? e.message : String(e)
    throw new ApiError(0, endpoint, `${endpoint} 请求发不出去：${reason}`, undefined)
  }

  if (res.status === 401) {
    const errBody = await readBody(res)
    unauthorizedHandler?.()
    throw new UnauthorizedError(401, endpoint, `${endpoint} 会话已过期或未登录`, errBody)
  }

  if (!res.ok) {
    const errBody = await readBody(res)
    const detail = describeBody(errBody)
    throw new ApiError(
      res.status,
      endpoint,
      `${endpoint} 返回 ${res.status}${detail === '' ? '' : `：${detail}`}`,
      errBody,
    )
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  if (text === '') return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(
      res.status,
      endpoint,
      `${endpoint} 的响应不是 JSON（前 80 字：${text.slice(0, 80)}）`,
      text,
    )
  }
}

export async function apiGet<T>(path: string, query?: Record<string, unknown>): Promise<T> {
  return request<T>('GET', path, query, undefined, false)
}

export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  // `arguments.length` 分不清 `apiSend('DELETE', p)` 与 `apiSend('DELETE', p, undefined)`，
  // 但两者要的都是"不发请求体"，用 `body !== undefined` 判就够。
  return request<T>(method, path, undefined, body, body !== undefined)
}
