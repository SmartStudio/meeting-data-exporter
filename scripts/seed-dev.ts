#!/usr/bin/env bun
/**
 * 联调/开发环境的最小可用数据播种。
 *
 * 用法：
 *   bun scripts/seed-dev.ts [--client-id <id>] [--tm-userid <腾讯会议 userid>]
 *                           [--keep-secret]
 *
 * 做两件事，缺一不可：
 *   1. 往 policy_rules 插一条 allow 规则。策略引擎**默认 deny**，空表意味着
 *      谁都导不了，而表现是「资产列表返回空数组」——与「这场会议真的没有录制」
 *      在客户端看来完全一样，是本项目最容易踩的坑。
 *   2. 往 service_accounts 建一个服务账号。客户端（mde CLI）用它认证，
 *      其 tm_userid 必须与上面规则的 subject_value **是同一个值**，否则策略
 *      照样拒绝，现象同样是空列表。
 *
 * 两处 userid 必须一致这件事，是手工执行 SQL 时最常见的错误来源；本脚本让它
 * 由同一个变量产生，从结构上消除不一致的可能。
 *
 * 幂等：重复执行只会轮换 secret（除非 --keep-secret），不会重复插入规则。
 *
 * 安全：secret 明文只在**本次运行的标准输出**里出现一次，不落盘、不入库
 * （库里只存 argon2id 哈希）。请立刻存进你的密钥管理，丢了就重跑本脚本轮换。
 */
import { randomBytes } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { loadConfig } from '../src/config'
import { createPool, runMigrations, type Pool } from '../src/store/db'

interface Args {
  clientId: string
  tmUserId: string | null
  keepSecret: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { clientId: 'mde-local', tmUserId: null, keepSecret: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--client-id') {
      args.clientId = argv[++i] ?? args.clientId
    } else if (arg === '--tm-userid') {
      args.tmUserId = argv[++i] ?? null
    } else if (arg === '--keep-secret') {
      args.keepSecret = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法: bun scripts/seed-dev.ts [选项]',
          '',
          '  --client-id <id>       服务账号 id（即 MDE_CLIENT_ID），默认 mde-local',
          '  --tm-userid <userid>   策略主体与服务账号身份，默认取 .env 的 TM_OPERATOR_ID',
          '  --keep-secret          账号已存在时保留原 secret（不轮换）',
        ].join('\n'),
      )
      process.exit(0)
    }
  }
  return args
}

/** URL 安全的强随机串，避免出现需要转义的字符（会被贴进 shell 的 export 语句） */
function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}

async function seedPolicyRule(pool: Pool, tmUserId: string): Promise<'created' | 'exists'> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM policy_rules
      WHERE subject_type = 'user' AND subject_value = ? AND effect = 'allow' AND enabled = 1
      LIMIT 1`,
    [tmUserId],
  )
  if (rows.length > 0) return 'exists'

  // resource_expr = {} 表示不限定会议范围；asset_types = ['*'] 表示全部八类资产。
  // 这就是 deploy.md §7 的「最小安全模板」：只放行这一个管理员，其余人默认 deny。
  await pool.execute(
    `INSERT INTO policy_rules
       (priority, subject_type, subject_value, resource_expr, asset_types,
        effect, enabled, created_at, updated_at)
     VALUES (100, 'user', ?, JSON_OBJECT(), JSON_ARRAY('*'), 'allow', 1,
             UNIX_TIMESTAMP(), UNIX_TIMESTAMP())`,
    [tmUserId],
  )
  return 'created'
}

async function seedServiceAccount(
  pool: Pool,
  clientId: string,
  tmUserId: string,
  keepSecret: boolean,
): Promise<{ action: string; secret: string | null }> {
  const [existing] = await pool.execute<RowDataPacket[]>(
    'SELECT id FROM service_accounts WHERE id = ? LIMIT 1',
    [clientId],
  )

  if (existing.length > 0 && keepSecret) {
    // 只把身份与启用状态对齐，不动 secret_hash
    await pool.execute(
      'UPDATE service_accounts SET tm_userid = ?, enabled = 1, expires_at = NULL WHERE id = ?',
      [tmUserId, clientId],
    )
    return { action: '已存在，保留原 secret', secret: null }
  }

  const secret = generateSecret()
  const hash = await Bun.password.hash(secret, { algorithm: 'argon2id' })
  await pool.execute(
    `INSERT INTO service_accounts (id, name, secret_hash, tm_userid, enabled, expires_at, created_at)
     VALUES (?, ?, ?, ?, 1, NULL, UNIX_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       secret_hash = VALUES(secret_hash),
       tm_userid   = VALUES(tm_userid),
       enabled     = 1,
       expires_at  = NULL`,
    [clientId, `seed-dev ${clientId}`, hash, tmUserId],
  )
  return { action: existing.length > 0 ? '已存在，secret 已轮换' : '新建', secret }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig(process.env)
  const tmUserId = args.tmUserId ?? config.tencent.operatorId

  const pool = createPool(config.databaseUrl)
  try {
    await runMigrations(pool)

    const ruleResult = await seedPolicyRule(pool, tmUserId)
    const accountResult = await seedServiceAccount(pool, args.clientId, tmUserId, args.keepSecret)

    console.log('')
    console.log('播种完成')
    console.log('─'.repeat(64))
    console.log(`  腾讯会议 userid : ${tmUserId}`)
    console.log(`  策略规则        : ${ruleResult === 'created' ? '已插入（allow 全部资产）' : '已存在，跳过'}`)
    console.log(`  服务账号        : ${args.clientId}（${accountResult.action}）`)
    console.log('─'.repeat(64))

    if (accountResult.secret !== null) {
      console.log('')
      console.log('客户端配置（secret 明文仅此一次输出，不落盘、不入库）：')
      console.log('')
      console.log(`  export MDE_GATEWAY_URL=${config.gatewayBaseUrl}`)
      console.log(`  export MDE_CLIENT_ID=${args.clientId}`)
      console.log(`  export MDE_CLIENT_SECRET=${accountResult.secret}`)
      console.log('')
      console.log('  丢了不用慌：重跑本脚本即可轮换（不加 --keep-secret）。')
    }
    console.log('')
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error('seed failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
