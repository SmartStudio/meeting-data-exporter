#!/usr/bin/env bun
// scripts/reset-meeting-data.ts
//
// 把库里的**会议数据**清空，重新走一遍「拉取 → 归档 → 清理 → 刷新清单」。
// 用途是本地验证：磁盘上的文件没了（比如 MDE_ARCHIVE_ROOT 曾经指在 /tmp 下、
// 重启后被系统清掉），而库里仍然记着「1178 个资产已下载完、172 场已归档」——
// 两边对不上之后，界面上每一场都显示「已完成」而文件并不存在，且不会有任何报错。
//
// 与 admin-bootstrap.ts / admin-reset-password.ts 同一套取舍：直连数据库、
// 需要 DATABASE_URL。写成脚本而不是让人现敲 SQL，是因为这件事有**两个容易漏的
// 半边**：漏一张派生表（比如 archived_assets），下一轮归档会撞上一堆指向不存在
// 会议的旧行；漏掉 job_failures，失败项表会一直列着已经不存在的会议。
//
// ## 两道闸，都必须显式打开
//
// 1. `--confirm`：这是不可逆删除，不接受省略。
// 2. **DATABASE_URL 的主机必须是本机**，否则拒绝。想对远端跑要再加 `--allow-remote`。
//    一个只靠「你自己小心点」拦着的清库脚本，等于没拦。
//
//   bun scripts/reset-meeting-data.ts --confirm
//   bun scripts/reset-meeting-data.ts --confirm --keep-job-runs

import { createPool } from '../src/store/db'

/**
 * 要清的表，**按依赖从叶到根**排（本库没有外键约束，这个顺序是给读的人看的：
 * 它说明了这些表之间谁派生自谁）。
 *
 * 每一行都得说得出「为什么它属于会议数据」——说不出的就不该在这张表里。
 */
const MEETING_TABLES: ReadonlyArray<{ table: string; why: string }> = [
  { table: 'asset_contents', why: '资产正文解析结果，逐条挂在资产上' },
  { table: 'archived_assets', why: '已归档到 NAS 的资产清单' },
  { table: 'meeting_archives', why: '会议级归档记录（归档时间、保留期、NAS 路径）' },
  { table: 'meeting_asset_probes', why: '资产探测结果（有没有、多大）' },
  { table: 'meeting_assets', why: '资产下载状态，就是「1178 条 completed」那张表' },
  { table: 'meeting_overrides', why: '对某场会议的人工改写（不拉取 / 不归档）' },
  { table: 'meeting_grants', why: '会议级采集授权' },
  { table: 'meeting_cache', why: '会议列表缓存' },
  { table: 'meetings', why: '会议本体' },
  // 每一行都点名一场具体的会议。会议没了还留着，失败项表会一直列着不存在的东西
  { table: 'job_failures', why: '失败项，每行指向一场具体的会议' },
]

/** `--keep-job-runs` 时保留。它是任务运行历史（卡片上那条 sparkline），不是会议数据，
 *  但重新验证时通常希望它也是干净的——旧的绿柱子会让人以为这一轮跑过了。 */
const JOB_RUNS_TABLE = 'job_runs'

/**
 * **不清**的表，逐条写明理由。这份名单和上面那份一样重要：
 * 清库脚本最容易犯的错不是漏删，是多删。
 */
export const KEPT_TABLES: ReadonlyArray<{ table: string; why: string }> = [
  { table: 'admin_accounts', why: '控制台账号。清了就登不进去，且 bootstrap 只在空表时可用' },
  { table: 'admin_sessions', why: '当前登录会话。清了要重新登录一次，没必要' },
  { table: 'policy_rules', why: '自动规则。**清了就没有任何拉取规则，重跑一轮什么都不会下**' },
  { table: 'policy_rules_legacy', why: '迁移前的旧规则，留着是为了出问题时能对照当初那份怎么写的' },
  { table: 'system_settings', why: '保留天数、清理暂停开关等设置' },
  { table: 'service_accounts', why: '采集端的服务账号凭据' },
  { table: 'refresh_tokens', why: '采集端的刷新令牌。清了所有已接入的程序当场掉线，要重走一遍设备授权' },
  { table: 'device_authorizations', why: '设备授权码。清了正在走授权流程的设备会卡在半路，且看不出是为什么' },
  { table: 'identity_map', why: '企业微信 userid 到本系统身份的映射。清了每个人都要重新绑一次' },
  { table: 'sts_token_requests', why: '腾讯云临时凭据请求，与会议无关，且会自己过期' },
  { table: 'audit_log', why: '审计。它记的是**谁在什么时候做了什么**，那件事真的发生过——清库不该把它一起抹掉' },
]

export interface ResetArgs {
  confirm: boolean
  keepJobRuns: boolean
  allowRemote: boolean
}

export function parseArgs(argv: string[]): ResetArgs {
  const has = (flag: string): boolean => argv.includes(flag)
  if (!has('--confirm')) {
    throw new Error(
      'usage: bun scripts/reset-meeting-data.ts --confirm [--keep-job-runs] [--allow-remote]\n' +
        '这是不可逆删除，必须显式加 --confirm。',
    )
  }
  return {
    confirm: true,
    keepJobRuns: has('--keep-job-runs'),
    allowRemote: has('--allow-remote'),
  }
}

/**
 * 这个连接串是不是指向本机。
 *
 * **判据是白名单，不是黑名单**：认不出的主机一律当成远端。反过来写（「不含
 * 生产域名就算本地」）的失效方式是静默的——换一个没见过的域名就放行了。
 */
export function isLocalDatabase(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    // 解析不出来就当远端：拿不准时落到"拒绝"那一侧
    return false
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

async function countRows(pool: ReturnType<typeof createPool>, table: string): Promise<number> {
  const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM \`${table}\``)
  const c = (rows as Array<{ c: number | string }>)[0]?.c ?? 0
  return typeof c === 'string' ? Number.parseInt(c, 10) : c
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('missing required env: DATABASE_URL')

  if (!isLocalDatabase(databaseUrl) && !args.allowRemote) {
    console.error(
      'DATABASE_URL 不指向本机，拒绝执行。\n' +
        '这个脚本会删掉全部会议数据。要对远端跑，请显式加 --allow-remote，' +
        '并先确认你知道那一端是什么环境。',
    )
    return 1
  }

  const targets = args.keepJobRuns
    ? MEETING_TABLES
    : [...MEETING_TABLES, { table: JOB_RUNS_TABLE, why: '任务运行历史（卡片上的 sparkline）' }]

  const pool = createPool(databaseUrl)
  try {
    console.log('将要清空：')
    let total = 0
    for (const t of targets) {
      const n = await countRows(pool, t.table)
      total += n
      console.log(`  ${String(n).padStart(6)}  ${t.table.padEnd(22)} ${t.why}`)
    }
    console.log(`  ${String(total).padStart(6)}  合计\n`)

    console.log('保留不动：')
    for (const t of KEPT_TABLES) {
      console.log(`  ${String(await countRows(pool, t.table)).padStart(6)}  ${t.table.padEnd(22)} ${t.why}`)
    }
    console.log('')

    // 一条一条 DELETE，不用 TRUNCATE：TRUNCATE 在 MySQL 里是 DDL，会隐式提交，
    // 中途失败就留下一个删了一半的库；DELETE 在一个事务里，要么全清要么原样。
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      for (const t of targets) await conn.query(`DELETE FROM \`${t.table}\``)
      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }

    console.log(`已清空 ${targets.length} 张表，共 ${total} 行。`)
    console.log('磁盘上的文件不归这个脚本管——它只动数据库。')
    return 0
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('reset failed', err)
      process.exit(1)
    })
}
