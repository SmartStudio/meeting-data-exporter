#!/usr/bin/env bun
// scripts/admin-reset-password.ts
//
// 重置某个管理员账号的密码。这是**忘记密码时唯一的出路**：控制台里的
// `POST /auth/password` 要填当前密码（US-3.5），而这套系统没有邮件找回——
// 一个自托管的后台，忘了密码就只能从数据库这一侧改。此前这条路只存在于
// "自己写一段 SQL"，那意味着每个人现场发明一遍怎么算 argon2id 哈希、
// 以及**记不记得顺手把旧会话踢掉**。踢会话是这件事的一半：密码换了而旧
// 会话还活着，等于没换。
//
// 与 admin-bootstrap.ts 同一套取舍：直连数据库、需要 DATABASE_URL，也就是
// 需要服务器/部署环境的数据库访问权限——能跑这个脚本的人本来就能直接操作
// 数据库，所以密码走命令行参数（会进 shell history）是可接受的，不为一次性
// 恢复操作单独实现遮蔽输入。用完记得清 history。
//
// 与 bootstrap 的差别：那个只在表为空时可用（建第一个账号），这个只在账号
// **已存在**时可用（改已有账号）。两者不重叠，各自的前置条件都会显式检查。
//
//   bun scripts/admin-reset-password.ts --username admin --password <新密码>

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
    throw new Error('usage: bun scripts/admin-reset-password.ts --username <name> --password <新密码>')
  }
  // 门槛来自 src/auth/admin.ts，与控制台那两条建号/改密路径是同一个判定，
  // 不在这里再写一遍 `.length < 8`
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

    const account = await store.findByUsername(username)
    if (!account) {
      // 这里**故意把账号不存在说出来**，与登录端点的枚举防御相反：那条路开在
      // 公网上，这条路要求数据库凭据。对一个已经能读整张表的人隐瞒账号是否
      // 存在，只会让他去手写 SQL——那正是这个脚本要替代的东西。
      console.error(`no admin account named "${username}". 现有账号：`)
      for (const a of await store.listAccounts()) console.error(`  - ${a.username}（${a.role}）`)
      return 1
    }

    await store.updatePassword(account.id, await auth.hashPassword(password))

    // 密码换了而旧会话还活着等于没换：能拿到旧 cookie 的人照样进得来。
    // 控制台里的改密路径（POST /auth/password）保留当前这一条会话、踢掉其余；
    // 这里没有"当前会话"可言——跑这个脚本的人是在浏览器之外——所以全踢。
    await store.deleteSessionsByAdminId(account.id)

    console.log(`已重置 ${account.username}（${account.role}）的密码，并踢掉该账号的全部登录会话。`)
    console.log('新密码不会被打印在这里，也不会写进任何文件——它只在你刚才输入的那条命令里。')
    return 0
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('admin password reset failed', err)
      process.exit(1)
    })
}
