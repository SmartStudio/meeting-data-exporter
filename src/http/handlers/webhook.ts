import { WebhookVerificationError } from '../../sts/crypto'
import type { UrlChallengeCandidate } from '../../sts/manager'
import { json, text } from '../respond'
import type { RouteCtx } from '../router'

/** 官方《回调服务要求》规定的成功响应体，必须逐字一致、不能加引号或换行 */
const ACK_BODY = 'successfully received callback'

interface SigParams {
  timestamp: string
  nonce: string
  signature: string
  /** 三个参数实际来自哪里，仅用于日志——真实环境到底是 header 还是 query，一次就能问清楚 */
  source: 'header' | 'query'
}

/**
 * 取验签三参数。
 *
 * 官方《回调服务要求》（文档 1095/51608）写明它们在 **HTTP Header** 里
 * （本项目最初仿企业微信惯例实现成 query，属推断错误，已纠正）。仍保留 query
 * 作为回退：多读一个位置不产生安全风险（签名本身才是关卡），却能在腾讯实际
 * 行为与文档不符时避免整条链路不可用；命中哪个来源会记进日志。
 */
function readSigParams(req: Request, url: URL): SigParams | null {
  const h = req.headers
  const ht = h.get('timestamp')
  const hn = h.get('nonce')
  const hs = h.get('signature')
  if (ht && hn && hs) return { timestamp: ht, nonce: hn, signature: hs, source: 'header' }

  const qt = url.searchParams.get('timestamp')
  const qn = url.searchParams.get('nonce')
  const qs = url.searchParams.get('signature')
  if (qt && qn && qs) return { timestamp: qt, nonce: qn, signature: qs, source: 'query' }

  return null
}

/** 未解码的原始 query 值——`URLSearchParams` 会把 `+` 解成空格，base64 载荷经不起这一下 */
function rawQueryValue(url: URL, key: string): string | null {
  for (const pair of url.search.replace(/^\?/, '').split('&')) {
    if (pair === '') continue
    const i = pair.indexOf('=')
    const k = i < 0 ? pair : pair.slice(0, i)
    if (k === key) return i < 0 ? '' : pair.slice(i + 1)
  }
  return null
}

/**
 * `check_str` 的候选（签名形态, 载荷形态）组合，按「最可能正确」排序后交给验签
 * 与解密共同裁决。官方既没说签名算的是解码前还是解码后的值，base64 里的 `+` 在
 * query string 中又有「加号」与「空格」两种解读，故把几种组合都列出来：
 *
 * 0. 原始值未经任何编码——签名与解密都用它（腾讯不做百分号转义时的情形）
 * 1. 线路上是百分号编码；签名算的是**编码后**的形态，解密用解码后的
 * 2. 线路上是百分号编码；签名算的是**解码后**的形态
 * 3. `URLSearchParams` 的标准解码（`+` → 空格）——兜底
 */
function checkStrCandidates(url: URL): UrlChallengeCandidate[] {
  const out: UrlChallengeCandidate[] = []
  const push = (signed: string | null, payload: string | null): void => {
    if (!signed || !payload) return
    if (out.some((c) => c.signed === signed && c.payload === payload)) return
    out.push({ signed, payload })
  }

  const raw = rawQueryValue(url, 'check_str')
  let decoded: string | null = null
  if (raw !== null) {
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // 畸形百分号转义：该形态不可用，其余候选仍然有效
    }
  }

  push(raw, raw)
  push(raw, decoded)
  push(decoded, decoded)
  const standard = url.searchParams.get('check_str')
  push(standard, standard)
  return out
}

/**
 * GET /webhook/tencent-meeting?check_str=...
 * Header: timestamp / nonce / signature
 *
 * 事件订阅**配置阶段**腾讯会先打这个请求验证 URL 是否具备解析能力：验签通过后
 * 把 `check_str` 解密，**3 秒内以纯文本回显明文**（不能带引号/换行），否则后台
 * 保存事件订阅会失败。这是整条 webhook 链路的第一道门，没有它连配都配不上。
 *
 * 与 POST 相同的硬性契约：验签失败立即拒绝，不记录任何载荷内容。
 */
export async function handleWebhookVerify(req: Request, ctx: RouteCtx): Promise<Response> {
  const url = new URL(req.url)
  const sig = readSigParams(req, url)
  const candidates = checkStrCandidates(url)

  if (sig === null || candidates.length === 0) {
    return json(401, { error: 'verification_failed' })
  }

  try {
    const { plain, candidate } = ctx.deps.stsManager.verifyUrlChallenge({
      timestamp: sig.timestamp,
      nonce: sig.nonce,
      signature: sig.signature,
      candidates,
    })
    // 验签已通过，此时记录是安全的。这条日志专为联调而留：它一次性回答
    // 「三参数在 header 还是 query」「check_str 用哪种解码」「明文长什么样
    // （是否带尾部 $key）」——官方文档没写明的三件事。
    console.log(
      `[webhook] URL 校验通过 sig_source=${sig.source} check_str_candidate=${candidate} ` +
        `plain_len=${plain.length} plain=${JSON.stringify(plain)}`,
    )
    return text(200, plain)
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return json(401, { error: 'verification_failed' })
    }
    throw err
  }
}

/**
 * POST /webhook/tencent-meeting
 * Header: timestamp / nonce / signature
 * body:   { "data": "<base64 密文>" }
 *
 * 线路格式已对照腾讯官方《回调服务要求》（文档 1095/51608）核实：三个验签参数
 * 在 Header、密文字段名是 `data`、成功必须返回 HTTP 200 且响应体为纯文本
 * `successfully received callback`。响应不合格时腾讯视为失败，并在 1/3/6 分钟
 * 后各重试一次（共三次）。
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
  const sig = readSigParams(req, url)
  if (sig === null) {
    return json(401, { error: 'verification_failed' })
  }

  let body: { data?: string; encrypt?: string } | null
  try {
    body = (await req.json()) as { data?: string; encrypt?: string }
  } catch {
    // 请求体不是合法 JSON：不具备验签所需材料，一律按验签失败处理（fail closed），
    // 不尝试解析或记录其内容。
    return json(401, { error: 'verification_failed' })
  }

  // 官方字段名是 `data`；`encrypt` 是本项目早期按企微惯例推断的字段名，保留为
  // 回退与 readSigParams 同理——签名才是关卡，多认一个字段名不放宽任何东西。
  const encrypted = body?.data ?? body?.encrypt
  if (!encrypted) {
    return json(401, { error: 'verification_failed' })
  }

  const now = ctx.deps.now()
  try {
    await ctx.deps.stsManager.handleWebhook(
      { timestamp: sig.timestamp, nonce: sig.nonce, signature: sig.signature, encrypted },
      now,
    )
    return text(200, ACK_BODY)
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return json(401, { error: 'verification_failed' })
    }
    throw err
  }
}
