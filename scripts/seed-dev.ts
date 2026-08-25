#!/usr/bin/env bun
/**
 * 联调/开发环境的最小可用数据播种。
 *
 * 用法：
 *   bun scripts/seed-dev.ts [--client-id <id>] [--tm-userid <腾讯会议 userid>]
 *                           [--keep-secret]
 *
 * 做两件事，缺一不可：
 *   1. 往 policy_rules 插一条**采集权限规则**（`kind='allow'`）。allow 栈**兜底 deny**，
 *      空表意味着谁都导不了，而表现是「资产列表返回空数组」——与「这场会议真的
 *      没有录制」在客户端看来完全一样，是本项目最容易踩的坑。
 *   2. 往 service_accounts 建一个服务账号。客户端（mde CLI）用它认证。
 *
 * **规则的主体是服务账号的 id（client_id），不是腾讯会议 userid。** 阶段 3 之后
 * 采集权限规则管的是「哪个采集程序能取走哪些会议」，主体是程序不是人；
 * 一个人可能对应零个或多个服务账号，两者之间没有机械的对应关系。
 * 手工执行 SQL 时最常见的错误就是把 tm_userid 填进 subject_value——本脚本让
 * 规则主体与账号 id 由同一个变量产生，从结构上消除这种不一致。
 *
 * tm_userid 仍然要填对：它是审计留痕与调用腾讯 API 的操作者身份，只是**不再
 * 参与策略判定**。
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
          '  --client-id <id>       服务账号 id（即 MDE_CLIENT_ID），也是采集权限规则的主体，默认 mde-local',
          '  --tm-userid <userid>   服务账号的腾讯会议身份（审计与调用平台 API 用），默认取 .env 的 TM_OPERATOR_ID',
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

async function seedPolicyRule(pool: Pool, clientId: string): Promise<'created' | 'exists'> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM policy_rules
      WHERE kind = 'allow' AND subject_type = 'program' AND subject_value = ?
        AND effect = 'allow' AND enabled = 1
      LIMIT 1`,
    [clientId],
  )
  if (rows.length > 0) return 'exists'

  // conds = [] 表示不限定会议范围（匹配一切）；asset_types = ['*'] 表示全部八类资产。
  // 这就是 deploy.md §7 的「最小安全模板」：只放行这一个采集程序，其余一律兜底 deny。
  await pool.execute(
    `INSERT INTO policy_rules
       (kind, priority, join_op, conds, subject_type, subject_value, asset_types,
        effect, note, enabled, created_at, updated_at)
     VALUES ('allow', 100, 'and', JSON_ARRAY(), 'program', ?, JSON_ARRAY('*'), 'allow',
             'seed-dev：放行本地采集程序的全部会议与全部资产', 1,
             UNIX_TIMESTAMP(), UNIX_TIMESTAMP())`,
    [clientId],
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

    // 规则主体是采集程序的 id，不是 tmUserId——见文件头
    const ruleResult = await seedPolicyRule(pool, args.clientId)
    const accountResult = await seedServiceAccount(pool, args.clientId, tmUserId, args.keepSecret)

    console.log('')
    console.log('播种完成')
    console.log('─'.repeat(64))
    console.log(`  腾讯会议 userid : ${tmUserId}（审计与调用腾讯 API 的身份，不参与策略判定）`)
    console.log(`  采集权限规则    : ${ruleResult === 'created' ? `已插入（主体 ${args.clientId}，allow 全部资产）` : '已存在，跳过'}`)
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
