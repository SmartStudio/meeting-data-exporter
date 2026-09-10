export type IdentityStrategy = 'direct' | 'email' | 'table'

export interface WecomConfig {
  corpId: string
  agentId: string
  secret: string
}

export interface AppConfig {
  tencent: {
    appId: string
    sdkId: string
    secretId: string
    secretKey: string
    operatorId: string
    qps: number
    baseUrl: string
  }
  /**
   * 企业微信自建应用。**为 null 表示本次部署不启用企微登录**——设备授权流程
   * （扫码登录）随之整体不可用，客户端只能走服务账号认证。
   *
   * 这不是「配置缺失」而是一个合法的部署形态，因此用 null 表达，而不是塞占位符
   * 字符串：占位符会让代码相信一个假事实，再靠人记住它是假的——preflight 从此
   * 永远有一项红，而一个永远红的检查和一个坏掉的检查在实践中是同一件事。
   */
  wecom: WecomConfig | null
  databaseUrl: string
  jwtSecret: string
  gatewayBaseUrl: string
  identityStrategy: IdentityStrategy
  trustedProxyHops: number
}

const IDENTITY_STRATEGIES: readonly IdentityStrategy[] = ['direct', 'email', 'table']

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key]
  if (v === undefined || v === '') {
    throw new Error(`missing required config: ${key}`)
  }
  return v
}

/**
 * 可选配置项：**空串与未设置等价**。
 *
 * `.env.example` 里这类变量写作 `TM_QPS=`（留空表示用默认值），而 Bun 会把它读成
 * 空字符串而不是 undefined——`env.TM_QPS ?? 5` 只挡 undefined，于是空串会一路
 * 穿到 `Number('')` = 0。qps=0 会让令牌桶永远补不满，**所有腾讯 API 调用被静默
 * 卡死**，且不抛异常、不打日志，排障时极易误判成网络或凭证问题。
 *
 * 「空」与「不存在」在环境变量这一层是两个状态，而模板文件天生只能表达前者；
 * 差异必须在读取处抹平，不能靠使用方各自记得用 `||` 而不是 `??`。
 */
function optional(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key]
  return v === undefined || v === '' ? undefined : v
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const strategy = required(env, 'IDENTITY_STRATEGY')
  if (!IDENTITY_STRATEGIES.includes(strategy as IdentityStrategy)) {
    throw new Error(
      `IDENTITY_STRATEGY must be one of ${IDENTITY_STRATEGIES.join(' | ')}, got: ${strategy}`,
    )
  }

  // 必须精确等于网关前方会追加 X-Forwarded-For 的可信代理层数（见 .env.example /
  // docs/deploy.md）：填多了会取到攻击者可伪造的 XFF 段，导致登录限流被绕过（安全问题）；
  // 填 0/空/非数字会使 Number() 得到 0/NaN，router.ts 的下标运算越界，等价于把全体
  // 客户端合并进同一个限流桶——单个攻击者即可打满全局登录桶。故在启动期强制校验。
  const trustedProxyHops = Number(optional(env, 'TRUSTED_PROXY_HOPS') ?? '1')
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1) {
    throw new Error('TRUSTED_PROXY_HOPS must be a positive integer (>= 1)')
  }

  // 令牌桶速率。0 会让桶永远补不满（tryTake 恒为 false），表现是所有腾讯 API 调用
  // 静默卡死而非报错——必须在启动期挡住，不能等到线上排障时才发现。
  const qps = Number(optional(env, 'TM_QPS') ?? '5')
  if (!Number.isInteger(qps) || qps < 1) {
    throw new Error('TM_QPS must be a positive integer (>= 1)')
  }

  // 企微三项要么全给、要么全不给。**部分给**几乎一定是打错了变量名或漏配，
  // 此时若静默按「未启用」处理，管理员会得到一个「扫码登录莫名其妙不可用」的
  // 系统而毫无提示——所以这里明确报错，把配置错误与部署决策区分开。
  const wecomKeys = ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_SECRET'] as const
  const wecomPresent = wecomKeys.filter((k) => optional(env, k) !== undefined)
  if (wecomPresent.length !== 0 && wecomPresent.length !== wecomKeys.length) {
    const missing = wecomKeys.filter((k) => optional(env, k) === undefined)
    throw new Error(
      `WeCom config is partially set: missing ${missing.join(', ')}. ` +
        'Set all three to enable WeCom login, or none to disable it.',
    )
  }
  const wecom: WecomConfig | null =
    wecomPresent.length === wecomKeys.length
      ? {
          corpId: required(env, 'WECOM_CORP_ID'),
          agentId: required(env, 'WECOM_AGENT_ID'),
          secret: required(env, 'WECOM_SECRET'),
        }
      : null

  // 用户会话 JWT 签名密钥。弱口令会让整个会话体系可被爆破/猜测，故强制最低长度。
  const jwtSecret = required(env, 'JWT_SECRET')
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters')
  }

  return {
    tencent: {
      appId: required(env, 'TM_APP_ID'),
      sdkId: required(env, 'TM_SDK_ID'),
      secretId: required(env, 'TM_SECRET_ID'),
      secretKey: required(env, 'TM_SECRET_KEY'),
      operatorId: required(env, 'TM_OPERATOR_ID'),
      qps,
      baseUrl: optional(env, 'TM_BASE_URL') ?? 'https://api.meeting.qq.com',
    },
    wecom,
    databaseUrl: required(env, 'DATABASE_URL'),
    jwtSecret,
    gatewayBaseUrl: required(env, 'GATEWAY_BASE_URL'),
    identityStrategy: strategy as IdentityStrategy,
    trustedProxyHops,
  }
}
