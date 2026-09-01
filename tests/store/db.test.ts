/**
 * `closePool` 的测试 —— 钉的是**收尾不许拖住进程**。
 *
 * `pool.end()` 会等池里所有在途调用归还连接。而进度回写是 fire-and-forget
 * （见 `PoolTuning.queueLimit` 的注释：在途量无界，且 mysql2 **没有取连接
 * 超时**），信号落下时可能还有一批排在队列里——`end()` 之后池不再分配连接，
 * 排队者就永远等不到，`end()` 也永远等它们。那是个死锁，等下去不会好。
 *
 * 2026-09-01 的调度器正是这样：SIGTERM 之后任务全部收尾、库里一行 running
 * 都没有、CPU 时间不再增长，进程却又活了两分多钟，最后只能 kill -9。
 *
 * 四条用例分别锁住：不误报、真放弃、放弃之后不留未处理的拒绝、以及
 * **超时之前**的失败照旧向上抛（退出码语义不能被这次改动悄悄改掉）。
 */
import { expect, test } from 'bun:test'
import { POOL_CLOSE_TIMEOUT_MS, closePool } from '../../src/store/db'

const never = (): Promise<void> => new Promise<void>(() => {})

test('池正常关掉时，一声不吭', async () => {
  const said: string[] = []
  let ended = 0
  await closePool(
    {
      end: async () => {
        ended += 1
      },
    },
    { timeoutMs: 50, log: (m) => said.push(m) },
  )
  expect(ended).toBe(1)
  expect(said, '池关得好好的却报了一句，等于教人忽略这行日志').toEqual([])
})

test('池关不掉时，超时就放弃，并且留下一句为什么', async () => {
  const said: string[] = []
  const t0 = Date.now()
  await closePool({ end: never }, { timeoutMs: 30, log: (m) => said.push(m) })
  const spent = Date.now() - t0
  expect(spent, '等超过了 timeoutMs，说明兜底根本没生效').toBeLessThan(1000)
  expect(said.length, '悄悄放弃等于把死锁藏起来，下次还是查不出来').toBe(1)
  expect(said[0]).toContain('30ms')
})

test('放弃之后才失败的关池，不许变成未处理的拒绝', async () => {
  const seen: unknown[] = []
  const onUnhandled = (err: unknown): void => {
    seen.push(err)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await closePool(
      {
        end: () =>
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('boom')), 30)),
      },
      { timeoutMs: 5, log: () => {} },
    )
    // 等那个失败真的到达——它到达时已经没人 await 它了
    await new Promise((r) => setTimeout(r, 80))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  expect(seen, '进程正在退出的路上，最不需要的就是再崩一次').toEqual([])
})

test('超时之前失败的关池，照旧往上抛', async () => {
  const boom = new Error('connection reset')
  await expect(
    closePool(
      {
        end: () => Promise.reject(boom),
      },
      { timeoutMs: 1000, log: () => {} },
    ),
  ).rejects.toThrow('connection reset')
})

test('默认超时是个进程等得起的数', () => {
  expect(POOL_CLOSE_TIMEOUT_MS).toBeGreaterThan(0)
  expect(POOL_CLOSE_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
})
