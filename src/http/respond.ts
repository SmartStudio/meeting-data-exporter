import { TencentApiError } from '../tencent/errors'

/** 统一 JSON 响应构造：全部接口一律返回 JSON（webhook 端点内部另有独立契约） */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * 纯文本响应。腾讯会议的 webhook 契约要求响应体是**裸字符串**——
 * URL 校验回显解密后的明文、事件回调回 `successfully received callback`，
 * 官方明确写了「不能加引号、换行符」，因此这两处不能走 `json()`。
 */
export function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/** HTML 文本转义：用于把不可信内容安全嵌入服务端渲染页面 */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
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

/** 兜底：处理函数内未被显式捕获的异常。腾讯 API 错误按分类映射，其余不泄露细节。 */
export function internalError(err: unknown): Response {
  if (err instanceof TencentApiError) return upstreamError(err)
  console.error('unhandled error in http handler', err)
  return json(500, { error: 'internal_error' })
}

/**
 * 腾讯 API 错误在 HTTP 层的映射。分类依据 error_info.error_code（见 tencent/errors.ts），
 * 绝不能全塌成 500：
 * - fatal：网关侧配置/权限问题（SecretKey 错、operator 离职），非调用方过错。
 *   502 + 透出腾讯 error_code 供运维排障，但不透出内部 message（避免细节泄露）。
 * - asset_permanent：该资产在平台侧不存在，语义上等价 404。
 * - transient / asset_pending：可重试，503 让客户端知道稍后再试。
 */
export function upstreamError(err: TencentApiError): Response {
  switch (err.classification) {
    case 'fatal':
      console.error('tencent fatal error', err.errorCode, err.apiMessage)
      return json(502, { error: 'upstream_config_error', tencent_code: err.errorCode })
    case 'asset_permanent':
      return json(404, { error: 'asset_not_found', tencent_code: err.errorCode })
    case 'transient':
    case 'asset_pending': // 还在生成，稍后再试——对调用方与瞬时错误同一语义
      // 也要留一行：503 之前 client 已经重试过 5 次，全程一声不吭的话，
      // 线上排查只能看到客户端那句「upstream_unavailable」
      console.warn('tencent transient error after retries', err.errorCode, err.apiMessage)
      return json(503, { error: 'upstream_unavailable', tencent_code: err.errorCode })
  }
}
