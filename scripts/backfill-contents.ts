#!/usr/bin/env bun
/**
 * 已归档会议的**纪要正文回填**（控制台阶段 4 · T4，A6 的写侧）。
 *
 * 用法：
 *   DATABASE_URL=... bun scripts/backfill-contents.ts [--limit N] [--batch N] [--dry-run]
 *
 * 归档流水线从这次改动起会在**归档成功的那一刻**把文本类资产的正文写进
 * `asset_contents`（见 src/worker/archive.ts 的 ingestAssetContent）。但**这之前
 * 归档的会议库里一行正文都没有**——它们的资产早就躺在 NAS 上了，不会再被归档一次，
 * 也就永远等不到那一刻。这个脚本就是补这一段。
 *
 * ## 为什么是手动脚本，不是 worker 启动时自动跑（计划 E-f）
 *
 * 自动回填会在**每一次** worker 启动时扫全表（`archived_assets` LEFT JOIN
 * `asset_contents`），而这是一件**一次性**的事。代价还不止一次全表扫描：
 * 每次启动都要把「上次跑完之后一条都没多」这个结论重新算一遍，而算错的方向
 * （某次因为 NAS 没挂上而全部失败）会在下一次启动时被安静地重试掉，
 * 没有人会知道曾经失败过。手动跑一次、看着输出，比这个可靠。
 *
 * ## 可重复跑
 *
 * 枚举源是 `ContentsStore.listPending`——「已归档 + 文本类 + `asset_contents` 里
 * 还没有」的差集。跑过的行（**包括「未解析」那种**）下一次不再出现，所以这个脚本
 * 随时可以再跑一次：断在半路、NAS 当时没挂上、或者只是想确认没有漏网的，
 * 重跑的代价是一次差集查询。
 *
 * 读不到 / 哈希对不上 / 写库失败的**不写行**，因此下一次重跑会再试一遍——
 * 这正是要的行为（NAS 挂上了再跑一次就补上了）。为了不在同一次运行里对同一行
 * 反复重试，本次运行内已经试过的键会被记住，见下面的 `seen`。
 *
 * ## 它不碰什么
 *
 * 只读 `archived_assets` 与 NAS 上的文件，只写 `asset_contents`。
 * 本地文件、`meeting_assets`、`meeting_archives` 一列都不碰——**本地文件可能早就
 * 到期清理掉了**（spec §4.9：到期只删本地文件，数据库记录永久保留），
 * 所以正文只能从 NAS 那份副本读，而这也正是 `archived_assets.nas_hash` 校验的对象。
 */
import { createPool, runMigrations } from '../src/store/db'
import {
  buildAssetContent,
  createContentsStore,
  type AssetContentKey,
  type ContentsStore,
  type PendingContentRow,
} from '../src/store/contents'

export interface Args {
  /** 本次最多处理多少行，0 = 不限 */
  limit: number
  /** 每次差集查询取多少行 */
  batch: number
  dryRun: boolean
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 0, batch: 200, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--limit') args.limit = requirePositiveInt(argv[++i], '--limit')
    else if (arg === '--batch') args.batch = requirePositiveInt(argv[++i], '--batch')
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法: DATABASE_URL=... bun scripts/backfill-contents.ts [选项]',
          '',
          '  --limit N    本次最多处理 N 行，默认 0（不限）',
          '  --batch N    每次差集查询取 N 行，默认 200',
          '  --dry-run    只报告会做什么，不写库',
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

/** 与 archives.ts 的 archiveStateKey 同一种做法：用 NUL 分隔，任何一段里都不会出现它 */
function rowKey(k: AssetContentKey): string {
  return [k.meetingId, k.subMeetingId, k.assetType, k.remoteId, k.fileType].join('\u0000')
}

export interface BackfillSummary {
  /** 正文入库了 */
  ingested: number
  /** 明确记了一行「未解析」：docx / pdf、超上限、非 UTF-8。**不是故障** */
  unparsed: number
  /** 读不到 / 哈希对不上 / 写库炸了。**没写行，下次重跑还会再试** */
  failed: number
}

export async function backfill(
  store: ContentsStore,
  args: Args,
  log: (line: string) => void = console.log,
): Promise<BackfillSummary> {
  const summary: BackfillSummary = { ingested: 0, unparsed: 0, failed: 0 }
  const seen = new Set<string>()
  // 失败的行不写库，于是下一次差集查询还会把它们排在最前面返回。把窗口按已知的
  // 失败数往后推，才够得着它们后面的行——否则一批全失败就会让脚本原地打转
  // （或者更糟：以为「没有新的了」而提前收工，留下一堆从没看过的行）。
  let stuck = 0

  for (;;) {
    const pending = await store.listPending(args.batch + stuck)
    const fresh = pending.filter((r) => !seen.has(rowKey(r)))
    if (fresh.length === 0) break

    for (const row of fresh) {
      seen.add(rowKey(row))
      await handleOne(store, row, args, summary, log)
      if (summary.failed > stuck) stuck = summary.failed
      const done = summary.ingested + summary.unparsed + summary.failed
      if (args.limit > 0 && done >= args.limit) return summary
    }
  }
  return summary
}

async function handleOne(
  store: ContentsStore,
  row: PendingContentRow,
  args: Args,
  summary: BackfillSummary,
  log: (line: string) => void,
): Promise<void> {
  const where = `${row.meetingId}/${row.subMeetingId} ${row.assetType}/${row.remoteId}/${row.fileType}`
  try {
    const built = await buildAssetContent({
      key: row,
      nasPath: row.nasPath,
      nasHash: row.nasHash,
      now: Math.floor(Date.now() / 1000),
    })

    // listPending 已经在 SQL 里按文本类筛过。真撞上这一支说明两处判据分叉了，
    // 那是要查的事，不是可以数一数了事的
    if (built.kind === 'not_text') {
      summary.failed++
      log(`  ! ${where} 不是文本类资产，却出现在待回填列表里——listPending 与 isTextAssetType 判据不一致`)
      return
    }

    if (built.kind === 'failed') {
      summary.failed++
      log(`  ! ${where} ${built.reason}`)
      return
    }

    if (!args.dryRun) await store.put(built.record)

    if (built.record.status === 'parsed') {
      summary.ingested++
      log(`  + ${where} ${built.record.bytes} 字节`)
      return
    }
    summary.unparsed++
    log(`  - ${where} ${built.record.reason}`)
  } catch (err) {
    summary.failed++
    log(`  ! ${where} ${err}`)
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('missing required env: DATABASE_URL')

  const pool = createPool(databaseUrl)
  try {
    await runMigrations(pool)
    const store = createContentsStore(pool)
    if (args.dryRun) console.log('（--dry-run：只报告，不写库）')

    const summary = await backfill(store, args)
    console.log(
      `回填完成：入库 ${summary.ingested} · 未解析 ${summary.unparsed} · 失败 ${summary.failed}`,
    )
    if (summary.unparsed > 0) {
      console.log('「未解析」是正常结果，库里各有一行记着原因（docx / pdf 本版本不解析，超 16MB 明确拒绝）')
    }
    if (summary.failed > 0) {
      console.error('「失败」的行没有写进库，NAS 挂好之后重跑本脚本会再试一遍')
      return 1
    }
    return 0
  } finally {
    await pool.end()
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
