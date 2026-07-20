export type QueryParams = Record<string, string | number | undefined>

export interface BuiltUrl {
  /** 实际发起请求用的完整 URL */
  url: string
  /** 参与签名计算的 URI（不含 host，含完整查询串） */
  uriForSigning: string
}

/**
 * URL 构造的唯一出口。
 *
 * 平台要求参与签名的 URI 必须与实际请求 URL 逐字节一致，且 query 中的特殊字符
 * （? + = 等）须先 urlencode 再参与签名。因此两者必须由同一处产出——分开拼接
 * 必然出现不一致，且失败时的错误码（190301 / 9042）不会指向真正原因。
 */
export function buildUrl(baseUrl: string, path: string, query: QueryParams): BuiltUrl {
  const entries = Object.entries(query)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')

  const uriForSigning = qs === '' ? path : `${path}?${qs}`
  return {
    url: `${baseUrl}${uriForSigning}`,
    uriForSigning,
  }
}
