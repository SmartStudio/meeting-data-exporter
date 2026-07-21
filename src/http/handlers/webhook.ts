import { WebhookVerificationError } from '../../sts/crypto'
import { json } from '../respond'
import type { RouteCtx } from '../router'

/**
 * POST /webhook/tencent-meeting?timestamp=&nonce=&signature=
 * body: { "encrypt": "<base64 密文>" }
 *
 * 线路格式（query 携带 timestamp/nonce/signature，body 携带密文）是本任务
 * 自行设计的约定，效仿企业微信回调的通行做法；上线前必须对照腾讯会议
 * 官方回调文档核实字段名与位置是否完全一致（见任务报告的"疑虑"部分）。
 *
 * 硬性契约（sts/crypto.ts 的 JSDoc 与本任务简报明确要求）：验签失败必须
 * 立即拒绝整个请求，禁止在验签之前或验签失败之后记录任何请求体内容、
 * 或继续调用 decryptEvent / parseStsEvent。因此这个 handler 里：
 * - 不打印/记录 body 或密文
 * - 一旦 handleWebhook 抛出 WebhookVerificationError（验签失败或解密/解析
 *   失败，二者都收敛为同一异常类型），立即返回 401，不做任何额外处理
 */
export async function handleWebhook(req: Request, ctx: RouteCtx): Promise<Response> {
  const url = new URL(req.url)
  const timestamp = url.searchParams.get('timestamp')
  const nonce = url.searchParams.get('nonce')
  const signature = url.searchParams.get('signature')

  if (!timestamp || !nonce || !signature) {
    return json(401, { error: 'verification_failed' })
  }

  let body: { encrypt?: string } | null
  try {
    body = (await req.json()) as { encrypt?: string }
  } catch {
    // 请求体不是合法 JSON：不具备验签所需材料，一律按验签失败处理（fail closed），
    // 不尝试解析或记录其内容。
    return json(401, { error: 'verification_failed' })
  }

  if (!body?.encrypt) {
    return json(401, { error: 'verification_failed' })
  }

  const now = ctx.deps.now()
  try {
    await ctx.deps.stsManager.handleWebhook(
      { timestamp, nonce, signature, encrypted: body.encrypt },
      now,
    )
    return json(200, { ok: true })
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return json(401, { error: 'verification_failed' })
    }
    throw err
  }
}
