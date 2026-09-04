#!/usr/bin/env bun
/**
 * 主持人姓名一次性回填。
 *
 * 用法：
 *   bun scripts/sync-host-names.ts [--max-rounds N] [--per-round N]
 *
 * 定时任务一每 15 分钟补一轮，一轮最多 50 个（`src/worker/host-names.ts` 的
 * `MAX_PER_ROUND`）——那个上限是为了不跟录制下载抢腾讯的配额，代价是历史会议里
 * 那几百个主持人要好几个小时才补齐。这个脚本就是「现在就补完」的那条路：
 * **它跑的是同一个 `syncHostNames`**，只是一轮接一轮地跑，直到没有人要补。
 *
 * ## 它与定时任务不是两套逻辑
 *
 * 判据（谁该查、什么错该写 NULL、什么错该跳过）、配额闸门、落库全部在
 * `syncHostNames` 里，这里只负责循环与收工条件。回填脚本另写一份「差不多的」
 * 同步，意味着生产上补出来的数据与脚本补出来的不一样，而两边都不会报错。
 *
 * ## 可重复跑
 *
 * 收工条件是「`listMissing` 说没有人要补了」，而查过的（**包括查无此人**）一天内
 * 不会再被列出来。所以随时可以再跑一次：断在半路、当时腾讯限流、或者只是想确认
 * 没有漏网的，重跑的代价是一次差集查询。
 *
 * 没问成的（限流、网络）**不写表**，因此下一次重跑会再试一遍。为了不在同一次运行
 * 里对同一批 id 空转，一轮里一个都没补上就停——见下面的 `progressed`。
 *
 * ## 它不碰什么
 *
 * 只读 `meetings.host_userid` 与腾讯的成员接口，只写 `tm_users`。
 * `identity_map` 一列都不碰——那张表是身份映射（企微 ↔ 腾讯会议 ↔ 邮箱），
 * 语义与姓名无关，见 `migrations/012_tm_users.sql` 的表头。
 */
import { loadConfig } from '../src/config'
import { closePool, createPool, runMigrations } from '../src/store/db'
import { createTencentClient } from '../src/tencent/client'
import { createMeetingHostIdsStore, createTmUsersStore } from '../src/store/tm-users'
import { MAX_PER_ROUND, syncHostNames } from '../src/worker/host-names'

export interface Args {
  /** 最多跑几轮，0 = 不限（跑到补完为止） */
  maxRounds: number
  /** 每轮问几个。缺省跟定时任务一样，见 MAX_PER_ROUND 的注释 */
  perRound: number
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { maxRounds: 0, perRound: MAX_PER_ROUND }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--max-rounds') args.maxRounds = requireNonNegativeInt(argv[++i], '--max-rounds')
    else if (arg === '--per-round') args.perRound = requirePositiveInt(argv[++i], '--per-round')
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法: bun scripts/sync-host-names.ts [选项]',
          '',
          `  --max-rounds N  最多跑 N 轮，默认 0（跑到补完为止）`,
          `  --per-round N   每轮问 N 个成员，默认 ${MAX_PER_ROUND}`,
          '',
          '所需环境变量与网关一致（DATABASE_URL 与 TM_* 那一组），见 .env.example。',
        ].join('\n'),
      )
      process.exit(0)
    } else throw new Error(`未知参数：${arg}`)
  }
  return args
}

function requirePositiveInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} 需要一个正整数，收到 ${raw}`)
  return n
}

function requireNonNegativeInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} 需要一个非负整数，收到 ${raw}`)
  return n
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  // 与网关、调度器共用同一份 loadConfig 与同一个 .env——腾讯凭据、DATABASE_URL 同源
  const config = loadConfig(process.env)

  const pool = createPool(config.databaseUrl)
  try {
    // 表可能还没建（这个脚本很可能是升级后第一个跑的东西）
    await runMigrations(pool)

    const client = createTencentClient(config.tencent, {
      fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // 毫秒时钟：项目通用的 now() 是秒级，喂给令牌桶会让补充速率慢 1000 倍
      nowMs: Date.now,
    })
    const store = createTmUsersStore(pool)
    const meetings = createMeetingHostIdsStore(pool)

    let rounds = 0
    let named = 0
    let absent = 0
    let failed = 0

    for (;;) {
      // 每轮各取一次「现在」：这个脚本可能跑几分钟，冻结一个时刻会让后面几轮
      // 落库的 fetched_at 全部标在开跑那一刻
      const now = Math.floor(Date.now() / 1000)
      const r = await syncHostNames({
        client,
        operatorId: config.tencent.operatorId,
        store,
        meetings,
        now,
        maxPerRound: args.perRound,
      })
      rounds++
      named += r.named
      absent += r.absent
      failed += r.failed

      if (r.due === 0) break
      // 一轮下来一行都没落成：剩下的全是问不成的（限流、网络、权限）。再跑一轮
      // 只会原地打转——同一批 id 因为没落行，下一轮还是它们
      const progressed = r.named + r.absent > 0
      if (!progressed) {
        console.error('这一轮一个都没补上，剩下的都问不成，先停。原因见上面的日志')
        break
      }
      if (r.stoppedEarly !== null) {
        console.error(`提前收工：${r.stoppedEarly}`)
        break
      }
      if (args.maxRounds > 0 && rounds >= args.maxRounds) {
        console.log(`已跑满 ${args.maxRounds} 轮，还没补完的下次再跑本脚本`)
        break
      }
    }

    console.log(
      `回填完成：跑了 ${rounds} 轮 · 查到姓名 ${named} · 查无此人 ${absent} · 没问成 ${failed}`,
    )
    if (absent > 0) {
      console.log(
        '「查无此人」是正常结果：离职回收掉的账号、跨企业来开会的外部成员都会落到这一支，' +
          '库里各有一行记着（username 为 NULL），一天之内不会再问腾讯',
      )
    }
    if (failed > 0) {
      console.error('「没问成」的没有写库，稍后重跑本脚本会再试一遍')
      return 1
    }
    return 0
  } finally {
    await closePool(pool)
  }
}

// 被 import 时（测试）不自动执行
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
