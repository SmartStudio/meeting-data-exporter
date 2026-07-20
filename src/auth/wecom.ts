export interface WecomConfig {
  corpId: string
  agentId: string
  secret: string
}

export interface WecomUser {
  userId: string
  email: string | null
}

export interface WecomClientDeps {
  fetch: typeof fetch
  now: () => number
}

export interface WecomClient {
  buildAuthorizeUrl(redirectUri: string, state: string): string
  exchangeCode(code: string): Promise<WecomUser>
}

export function createWecomClient(cfg: WecomConfig, deps: WecomClientDeps): WecomClient {
  let cachedToken: { value: string; expiresAt: number } | null = null

  async function accessToken(): Promise<string> {
    const now = deps.now()
    if (cachedToken !== null && cachedToken.expiresAt > now) return cachedToken.value
    const res = await deps.fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpId}&corpsecret=${cfg.secret}`,
    )
    const body = (await res.json()) as { access_token?: string; expires_in?: number; errmsg?: string }
    if (!body.access_token) throw new Error(`wecom gettoken failed: ${body.errmsg ?? 'unknown'}`)
    cachedToken = { value: body.access_token, expiresAt: now + (body.expires_in ?? 7200) - 300 }
    return body.access_token
  }

  return {
    buildAuthorizeUrl(redirectUri, state) {
      const q = new URLSearchParams({
        login_type: 'CorpApp',
        appid: cfg.corpId,
        agentid: cfg.agentId,
        redirect_uri: redirectUri,
        state,
      })
      return `https://login.work.weixin.qq.com/wwlogin/sso/login?${q.toString()}`
    },

    async exchangeCode(code) {
      const token = await accessToken()
      const res = await deps.fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${token}&code=${encodeURIComponent(code)}`,
      )
      const body = (await res.json()) as { userid?: string; errmsg?: string }
      if (!body.userid) throw new Error(`wecom getuserinfo failed: ${body.errmsg ?? 'unknown'}`)

      const email = await fetchEmail(token, body.userid)
      return { userId: body.userid, email }
    },
  }

  // auth/getuserinfo 本身不返回邮箱，email 身份映射策略需要再用拿到的 userid
  // 调一次 user/get 才能取到。这次调用失败、返回业务错误码、或邮箱为空，都不应
  // 阻断登录——direct/table 策略根本不需要邮箱，是否因缺邮箱而拒绝应由
  // identity.ts 按所配策略决定，这里只负责尽力取值，取不到就置 null。
  async function fetchEmail(token: string, userId: string): Promise<string | null> {
    try {
      const res = await deps.fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${encodeURIComponent(userId)}`,
      )
      const body = (await res.json()) as { errcode?: number; email?: string }
      if (body.errcode !== undefined && body.errcode !== 0) return null
      return body.email ? body.email : null
    } catch {
      return null
    }
  }
}
