export type ErrorClass = 'fatal' | 'transient' | 'asset_permanent'

/**
 * 配置或权限问题，重试无意义，应立即失败并明确告知。
 *
 * 500063「该应用没有调用该接口的权限点」是 M3.5 联调实测新增的：自建应用未勾选
 * 对应权限点时腾讯返回它。原先落入默认的 transient 分类，导致每次调用都白白重试
 * MAX_ATTEMPTS 次——既拖慢启动，又持续消耗令牌桶配额，而重试永远不可能成功。
 */
const FATAL = new Set([9042, 500014, 190004, 200001, 202004, 500063])

/** 资产本身不存在，跳过该资产但不影响其他 */
const ASSET_PERMANENT = new Set([4051, 4049])

/**
 * 分类依据是响应体的 error_code，不是 HTTP status——
 * 后者只有 400 与 500 两种取值，承载不了这个区分。
 */
export function classify(errorCode: number): ErrorClass {
  if (FATAL.has(errorCode)) return 'fatal'
  if (ASSET_PERMANENT.has(errorCode)) return 'asset_permanent'
  return 'transient'
}

export class TencentApiError extends Error {
  readonly classification: ErrorClass

  constructor(
    readonly errorCode: number,
    readonly httpStatus: number,
    readonly apiMessage: string,
  ) {
    super(`tencent api error ${errorCode} (http ${httpStatus}): ${apiMessage}`)
    this.name = 'TencentApiError'
    this.classification = classify(errorCode)
  }

  /** X-TC-Nonce / X-TC-Timestamp 五分钟内不可重复，重试须重新签名 */
  get requiresResign(): boolean {
    return this.errorCode === 190301
  }

  /** 每分钟调用超限，除退避外还应收敛令牌桶速率 */
  get requiresBackoff(): boolean {
    return this.errorCode === 190310
  }
}

interface ErrorEnvelope {
  error_info?: { error_code?: number; message?: string }
}

export function parseErrorResponse(httpStatus: number, body: unknown): TencentApiError {
  const envelope = (typeof body === 'object' && body !== null ? body : {}) as ErrorEnvelope
  const code = envelope.error_info?.error_code ?? -1
  const message = envelope.error_info?.message ?? 'unparseable error response'
  return new TencentApiError(code, httpStatus, message)
}
