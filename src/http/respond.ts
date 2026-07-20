/** 统一 JSON 响应构造：全部接口一律返回 JSON（webhook 端点内部另有独立契约） */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/**
 * 请求体不是合法 JSON（或为空）时返回 null 而非抛出——由调用方决定如何应答
 * （多数场景为 400，webhook 端点则必须是 401，因此不能在这里统一处理）。
 */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

/** 兜底：处理函数内未被显式捕获的异常，避免把内部错误细节泄漏给调用方 */
export function internalError(err: unknown): Response {
  console.error('unhandled error in http handler', err)
  return json(500, { error: 'internal_error' })
}
