export type IdentityStrategy = 'direct' | 'email' | 'table'

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
  webhook: {
    token: string
    aesKey: string
  }
  wecom: {
    corpId: string
    agentId: string
    secret: string
  }
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

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const webhookToken = required(env, 'TM_WEBHOOK_TOKEN')
  if (webhookToken.length !== 25) {
    throw new Error('TM_WEBHOOK_TOKEN must be exactly 25 characters')
  }

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
  const trustedProxyHopsRaw = env.TRUSTED_PROXY_HOPS ?? '1'
  const trustedProxyHops = Number(trustedProxyHopsRaw)
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1) {
    throw new Error('TRUSTED_PROXY_HOPS must be a positive integer (>= 1)')
  }

  return {
    tencent: {
      appId: required(env, 'TM_APP_ID'),
      sdkId: required(env, 'TM_SDK_ID'),
      secretId: required(env, 'TM_SECRET_ID'),
      secretKey: required(env, 'TM_SECRET_KEY'),
      operatorId: required(env, 'TM_OPERATOR_ID'),
      qps: Number(env.TM_QPS ?? 5),
      baseUrl: env.TM_BASE_URL ?? 'https://api.meeting.qq.com',
    },
    webhook: {
      token: webhookToken,
      aesKey: required(env, 'TM_WEBHOOK_AES_KEY'),
    },
    wecom: {
      corpId: required(env, 'WECOM_CORP_ID'),
      agentId: required(env, 'WECOM_AGENT_ID'),
      secret: required(env, 'WECOM_SECRET'),
    },
    databaseUrl: required(env, 'DATABASE_URL'),
    jwtSecret: required(env, 'JWT_SECRET'),
    gatewayBaseUrl: required(env, 'GATEWAY_BASE_URL'),
    identityStrategy: strategy as IdentityStrategy,
    trustedProxyHops,
  }
}
