#!/usr/bin/env bun
// scripts/admin-bootstrap.ts
//
// 首个管理员账号的引导脚本。只在 admin_accounts 表为空时可用——建完第一个账号
// 后自动失效，此后创建/移除管理员账号一律走控制台内"添加运维人员"（US-3.5）。
// 直连数据库而非经网关 HTTP，理由见本任务说明。运行这个脚本需要 DATABASE_URL，
// 也就是需要服务器/部署环境的数据库访问权限——能跑这个脚本的人本来就能直接
// 操作数据库，所以密码走命令行参数（会进 shell history）是可接受的取舍，
// 不必为一次性引导操作单独实现遮蔽输入。

import { randomUUID } from 'node:crypto'
import { createPool, runMigrations } from '../src/store/db'
import { createAdminStore } from '../src/store/admin'
import { createAdminAuth, ADMIN_PASSWORD_MIN_LENGTH, isAdminPasswordAcceptable } from '../src/auth/admin'

export function parseArgs(argv: string[]): { username: string; password: string } {
  let username: string | undefined
  let password: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--username') username = argv[++i]
    else if (argv[i] === '--password') password = argv[++i]
  }
  if (!username || !password) {
    throw new Error('usage: bun scripts/admin-bootstrap.ts --username <name> --password <password>')
  }
  // 门槛来自 src/auth/admin.ts，与控制台的 POST /api/v1/admin/accounts 是同一个判定，
  // 不在这里各写一份长度比较
  if (!isAdminPasswordAcceptable(password)) {
    throw new Error(`password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`)
  }
  return { username, password }
}

async function main(): Promise<number> {
  const { username, password } = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('missing required env: DATABASE_URL')

  const pool = createPool(databaseUrl)
  try {
    await runMigrations(pool)
    const store = createAdminStore(pool)
    const auth = createAdminAuth({ store })

    const count = await store.countAccounts()
    if (count > 0) {
      console.error(
        `admin_accounts already has ${count} account(s) — bootstrap only works on an empty table. ` +
          'Use the console\'s "添加运维人员" to add more accounts.',
      )
      return 1
    }

    const passwordHash = await auth.hashPassword(password)
    await store.createAccount({
      id: randomUUID(),
      username,
      passwordHash,
      now: Math.floor(Date.now() / 1000),
    })
    console.log(`created first admin account: ${username}`)
    return 0
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('admin bootstrap failed', err)
      process.exit(1)
    })
}
