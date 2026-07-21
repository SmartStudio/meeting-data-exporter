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
  }
}
