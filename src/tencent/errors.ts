export type ErrorClass = 'fatal' | 'transient' | 'asset_permanent' | 'asset_pending'

/**
 * 配置或权限问题，重试无意义，应立即失败并明确告知。
 *
 * 500063「该应用没有调用该接口的权限点」是 M3.5 联调实测新增的：自建应用未勾选
 * 对应权限点时腾讯返回它。原先落入默认的 transient 分类，导致每次调用都白白重试
 * MAX_ATTEMPTS 次——既拖慢启动，又持续消耗令牌桶配额，而重试永远不可能成功。
 */
const FATAL = new Set([9042, 500014, 190004, 200001, 202004, 500063])

/**
 * 资产本身不存在，跳过该资产但不影响其他。
 * 500182「该文件未打开智能录制开关」：/v1/smart/minutes、/v1/smart/chapters 对没开
 * 智能录制的录制文件返回它（2026-09-08 实调）。原先落入 transient，一次探测白重试 5 次。
 */
const ASSET_PERMANENT = new Set([4051, 4049, 500182])

/**
 * 资产还没生成好，现在拿不到、以后能拿到：跳过该资产、不重试、不中断整体。
 * 500051「智能化数据生成中」：/v1/smart/minutes、/v1/smart/chapters 对刚结束的会议返回它
 * （2026-09-09 本机回填实测）。原先落入 transient——client 重试 5 次仍失败后从
 * discover 抛出，整轮拉取中止，连录像都没下。归为 asset_pending 后 smart.ts 翻成
 * 「这一类现在没有」，引擎按探测退避（48h 上限）下轮再问。
 */
const ASSET_PENDING = new Set([500051])

/**
 * 分类依据是响应体的 error_code，不是 HTTP status——
 * 后者只有 400 与 500 两种取值，承载不了这个区分。
 */
export function classify(errorCode: number): ErrorClass {
  if (FATAL.has(errorCode)) return 'fatal'
  if (ASSET_PERMANENT.has(errorCode)) return 'asset_permanent'
  if (ASSET_PENDING.has(errorCode)) return 'asset_pending'
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
