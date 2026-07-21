import { escapeHtml, html } from '../respond'
import type { RouteCtx } from '../router'

/**
 * GET /device?user_code=XXX
 *
 * 设备授权流程（RFC 8628）的人机确认页。CLI/桌面端拿到 user_code 后引导用户在
 * 浏览器打开本页；本页凭 user_code 找到对应的待授权会话、取出其 state，302 跳转到
 * 企业微信扫码登录页。用户扫码授权后企微回调 /auth/wecom/callback?code=&state=，
 * 由 wecomCallback 完成身份映射与设备授权。这样「仅凭网关」即可走完真人登录
 * （US-2.1 的前提）。桌面端将来可用内嵌 webview 覆盖更顺滑的体验。
 */
export async function devicePage(req: Request, ctx: RouteCtx): Promise<Response> {
  const url = new URL(req.url)
  const userCode = url.searchParams.get('user_code')
  if (!userCode) {
    return html(400, errorPage('缺少 user_code 参数，请从客户端重新发起登录。'))
  }

  const record = await ctx.deps.authStore.findByUserCode(userCode)
  const now = ctx.deps.now()
  // 不存在 / 已过期 / 非 pending（已授权或已用过）：统一同一措辞的错误页，
  // 不区分具体原因，避免把「user_code 是否有效」变成可探测信号。
  if (!record || now >= record.expiresAt || record.status !== 'pending') {
    return html(400, errorPage('该登录码无效或已过期，请从客户端重新发起登录。'))
  }

  const redirectUri = `${ctx.deps.gatewayBaseUrl}/auth/wecom/callback`
  const authorizeUrl = ctx.deps.wecomClient.buildAuthorizeUrl(redirectUri, record.state)
  return new Response(null, { status: 302, headers: { Location: authorizeUrl } })
}

function errorPage(message: string): string {
  return `<!doctype html><html><body><h1>登录失败</h1><p>${escapeHtml(message)}</p></body></html>`
}
