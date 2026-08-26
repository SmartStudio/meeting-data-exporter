import type { Store } from '@yaowu/mde-engine'

/** `runExecutor` 一轮的结果里我们关心的那三个数 */
interface RoundResult { completed: number; failed: number; skipped: number }

/**
 * 一轮什么都没干时，说清楚是「没活可干」还是「活被租约锁着」。
 *
 * **这是实测跑出来的一个真实体验缺陷**（M3.5 §4.3，2026-08-26）：
 * Ctrl-C 打断下载之后立刻重跑，十五分钟内什么都不会发生——任务停在 `running`，
 * 租约要到领取时刻 + `leaseSec`（默认 900 秒）才过期，`claimNext` 在那之前
 * 一条都领不到。这是租约机制**正常工作**的表现：它防的正是「另一个执行体
 * 把还在下载中的任务抢走，两个进程同时写同一个 `.part`」。
 *
 * 但屏幕上只有一行 `completed=0 failed=0 skipped=0`，对着它的人不可能知道
 * 发生了什么，只会以为断点续传坏了。**机制是对的，沉默是错的。**
 *
 * 只在这一轮**颗粒无收**时才提示：正常跑完的那一轮里也可能有别的执行体
 * 正持着租约，那是并发下的常态，不该每次都刷一行。
 */
export async function warnIfLeaseLocked(
  store: Pick<Store, 'counts'>,
  r: RoundResult,
  leaseSec: number,
): Promise<void> {
  if (r.completed > 0 || r.failed > 0 || r.skipped > 0) return

  const c = await store.counts()
  const running = c.running ?? 0
  if (running === 0) return

  const mins = Math.ceil(leaseSec / 60)
  console.log(
    `提示：有 ${running} 个任务停在 running 且租约还没过期，本轮一个都领不到。\n` +
      `      上一次中断（Ctrl-C / 进程被杀）留下的任务要等租约到期才会被重新领取，` +
      `最长 ${leaseSec} 秒（约 ${mins} 分钟）。\n` +
      `      等一会儿再跑 execute 即可；这是防止两个进程同时写同一个文件的机制，不是故障。`,
  )
}
