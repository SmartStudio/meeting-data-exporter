import { expect, setDefaultTimeout, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import { createJobsStore, jobSpec, type JobName, type JobsStore } from '../../src/store/jobs'
import {
  ROUND_FAILURE_TARGET,
  createJobRunners,
  createScheduler,
  type JobBodyDeps,
  type JobRunner,
  type Scheduler,
} from '../../src/worker/scheduler'
import type { FetchRound } from '../../src/worker/index'
import type { Pool } from '../../src/store/db'

/**
 * 阶段 4 · T11（A4）调度器。五条验收判据里的四条在这一层验：
 *
 *   1 失败项不静默丢弃   任务体里逐个对象落 job_failures
 *   2 重叠保护           上一轮没跑完时不许再起一轮
 *   3 重启不补跑         但 job_runs 里看得出中间断了
 *   5 不进网关进程       这一条是文件头的约束，验不了代码，验的是它没有反向依赖
 *
 * 判据 4（手动触发记审计）在 tests/http/console-jobs.test.ts。
 *
 * 时钟一律注入：调度靠"当前时间落在哪个时间片"判到没到点，用真 setInterval 的话
 * 一条"每小时整点"的用例要跑一个小时。
 */

// 每条用例各建一个隔离的测试库（跟随 tests/store/ 的约定），建库 + 跑全套迁移
// 本身就要一秒上下，几个多 tick 的用例再叠上十几次往返之后会顶穿 bun 默认的 5 秒。
// 超时时间与"这段逻辑对不对"无关，别让它变成一条随机挂的用例。
setDefaultTimeout(30_000)

const HOUR = 3600
const MIN = 60

interface Harness {
  scheduler: Scheduler
  jobs: JobsStore
  /** 可推进的假时钟，unix 秒 */
  setNow(t: number): void
  /** 等本 tick 起的全部任务体跑完 */
  drain(): Promise<void>
}

async function withScheduler(
  runners: Partial<Record<JobName, JobRunner>>,
  startAt: number,
  fn: (h: Harness, pool: Pool) => Promise<void>,
): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try {
    const jobs = createJobsStore(pool)
    let clock = startAt
    const noop: JobRunner = async () => ({})
    const scheduler = createScheduler({
      jobs,
      now: () => clock,
      tzOffsetSec: 0,
      log: () => {},
      runners: {
        fetch_recordings: runners.fetch_recordings ?? noop,
        archive_nas: runners.archive_nas ?? noop,
        cleanup_expired: runners.cleanup_expired ?? noop,
        refresh_inventory: runners.refresh_inventory ?? noop,
      },
    })
    await fn(
      {
        scheduler,
        jobs,
        setNow: (t) => {
          clock = t
        },
        drain: () => scheduler.drain(),
      },
      pool,
    )
  } finally {
    await cleanup()
  }
}

/** 2026-08-26 00:00:00 UTC，正好是四个任务全部时间片的边界 */
const T0 = Date.UTC(2026, 7, 26, 0, 0, 0) / 1000

/**
 * 等到只剩 `keep` 一个任务还在跑。
 *
 * 一个 tick 会把**这一刻全部到点的**任务都起起来，而 `tick()` 只等到"起好了"、
 * 不等任务体跑完（那是刻意的：一轮归档几十分钟）。用例里只想卡住其中一个、
 * 让别的正常收尾时，就得在推进时钟之前等一下——否则下一个 tick 会把还没写完
 * `finished_at` 的那些也算成"上一轮没跑完"。`drain()` 在这里用不了：它会连
 * **被故意卡住的那个**一起等，永远不返回。
 */
async function settleExcept(h: Harness, keep: JobName): Promise<void> {
  while (h.scheduler.runningJobs().some((n) => n !== keep)) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ── 到点才跑，一片只跑一次 ────────────────────────────────────

test('bootstrap 之后的第一个 tick 一个任务都不起——不补跑此刻这一片', async () => {
  await withScheduler({}, T0 + 30, async (h) => {
    await h.scheduler.bootstrap()
    const out = await h.scheduler.tick()
    // 30 秒前刚跨过 00:00，四个任务的这一片都"算已经跑过"：进程重启不补跑
    expect(out.started).toEqual([])
    expect(out.skipped).toEqual([])
    expect(await h.jobs.listRuns('refresh_inventory', 10)).toHaveLength(0)
  })
})

test('跨到下一片才跑，同一片里 tick 多少次都只跑一次', async () => {
  const seen: number[] = []
  await withScheduler(
    { refresh_inventory: async (ctx) => { seen.push(ctx.now); return { ok: true } } },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      await h.scheduler.tick()
      expect(seen).toHaveLength(0)

      // 每 5 分钟一片：04:59 还在同一片
      h.setNow(T0 + 4 * MIN + 59)
      await h.scheduler.tick()
      await h.drain()
      expect(seen).toHaveLength(0)

      h.setNow(T0 + 5 * MIN)
      const out = await h.scheduler.tick()
      await h.drain()
      expect(out.started).toEqual(['refresh_inventory'])
      expect(seen).toEqual([T0 + 5 * MIN])

      // 同一片里再 tick 两次，不会再跑
      h.setNow(T0 + 6 * MIN)
      await h.scheduler.tick()
      h.setNow(T0 + 9 * MIN)
      await h.scheduler.tick()
      await h.drain()
      expect(seen).toHaveLength(1)
    },
  )
})

test('停机跨过好几片，恢复后只跑下一片一次（验收判据 3）', async () => {
  let runs = 0
  await withScheduler(
    { refresh_inventory: async () => { runs++; return {} } },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      // 停了 1 小时 = 错过 12 片。恢复之后只跑**现在这一片**的那一次，
      // 不会把错过的 12 片翻出来重放
      h.setNow(T0 + HOUR + 30)
      await h.scheduler.tick()
      await h.drain()
      expect(runs).toBe(1)

      // 之后照常，一片一次
      h.setNow(T0 + HOUR + 5 * MIN)
      await h.scheduler.tick()
      await h.drain()
      expect(runs).toBe(2)
    },
  )
})

test('每小时整点与每天 03:00 各按各的片走', async () => {
  const fired: string[] = []
  await withScheduler(
    {
      archive_nas: async () => { fired.push('archive'); return {} },
      cleanup_expired: async () => { fired.push('cleanup'); return {} },
    },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      h.setNow(T0 + HOUR)
      await h.scheduler.tick()
      await h.drain()
      expect(fired).toEqual(['archive'])

      h.setNow(T0 + 3 * HOUR)
      await h.scheduler.tick()
      await h.drain()
      // 03:00 整点：归档（每小时）与清理（每天 03:00）同时到点
      expect(fired.slice(1).sort()).toEqual(['archive', 'cleanup'])
    },
  )
})

// ── 重叠保护（验收判据 2）────────────────────────────────────

test('上一轮还没跑完时不许再起一轮，且留下一行 skipped', async () => {
  // 用一个持有对象而不是裸 let：`release?.()` 那一处 TS 会把变量窄化成 null
  // （赋值发生在回调里），窄化之后这一行在编译产物里等于什么都不做，测试于是永远卡住
  const gate: { release: (() => void) | null } = { release: null }
  let entered = 0
  /** 只有**第一轮**卡住，好在同一条用例里接着验"上一轮结束之后再到点就正常起" */
  const blocking: JobRunner = async () => {
    entered++
    if (entered === 1) await new Promise<void>((resolve) => { gate.release = resolve })
    return { done: true }
  }
  await withScheduler({ archive_nas: blocking }, T0, async (h) => {
    await h.scheduler.bootstrap()
    h.setNow(T0 + HOUR)
    await h.scheduler.tick()
    expect(entered).toBe(1)
    expect(h.scheduler.runningJobs()).toContain('archive_nas')
    // 这一刻拉取与清单也到点了（它们是 noop）。**不等它们收尾就推进时钟的话**，
    // 下一个 tick 会把它们也算成"上一轮还没跑完"，`skipped` 里于是多出别的名字——
    // 那是本用例自己的竞态（noop 的收尾要两次库往返，整库跑起来时不一定赶得上），
    // 与重叠保护无关。断言仍然是"恰好只有归档被跳过"，只是把竞态挡在断言之前。
    await settleExcept(h, 'archive_nas')

    // 一轮归档可以跑几十分钟，下一个整点又到了
    h.setNow(T0 + 2 * HOUR)
    const out = await h.scheduler.tick()
    // 别的任务这一刻也到点了，这里只问归档这一个
    expect(out.started).not.toContain('archive_nas')
    expect(out.skipped).toEqual(['archive_nas'])
    expect(entered).toBe(1)

    const runs = await h.jobs.listRuns('archive_nas', 10)
    expect(runs.map((r) => r.status)).toEqual(['skipped', 'running'])
    // 跳过的那一行指向挡住它的那次运行——不然运维只看到一行 skipped，
    // 不知道是谁还在跑
    expect((runs[0]?.summary as { blockedByRunId: number }).blockedByRunId).toBe(runs[1]!.id)

    gate.release?.()
    await h.drain()
    expect((await h.jobs.findRun(runs[1]!.id))?.status).toBe('succeeded')

    // 上一轮结束之后，再到点就正常起
    h.setNow(T0 + 3 * HOUR)
    await h.scheduler.tick()
    await h.drain()
    expect(entered).toBe(2)
  })
})

// ── 运行记录 ──────────────────────────────────────────────────

test('跑成功记 succeeded + summary，任务体的返回值原样进 summary', async () => {
  await withScheduler(
    { refresh_inventory: async () => ({ programs: 2, fetchable: 7, blocked: 1 }) },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      h.setNow(T0 + 5 * MIN)
      await h.scheduler.tick()
      await h.drain()
      const run = (await h.jobs.listRuns('refresh_inventory', 1))[0]!
      expect(run.status).toBe('succeeded')
      expect(run.summary).toEqual({ programs: 2, fetchable: 7, blocked: 1 })
      expect(run.startedAt).toBe(T0 + 5 * MIN)
      expect(run.finishedAt).toBe(T0 + 5 * MIN)
    },
  )
})

test('任务体抛出：run 记 failed，并且落一条整轮的失败项（不静默丢弃）', async () => {
  await withScheduler(
    { fetch_recordings: async () => { throw new Error('腾讯接口 502') } },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      h.setNow(T0 + 15 * MIN)
      await h.scheduler.tick()
      await h.drain()

      const run = (await h.jobs.listRuns('fetch_recordings', 1))[0]!
      expect(run.status).toBe('failed')
      expect(run.error).toContain('腾讯接口 502')

      const failures = await h.jobs.listFailures({ jobName: 'fetch_recordings' })
      expect(failures).toHaveLength(1)
      expect(failures[0]?.target).toBe(ROUND_FAILURE_TARGET)
      expect(failures[0]?.reason).toContain('腾讯接口 502')
      // 一句「影响」是硬要求，不能空着
      expect(failures[0]?.impact).toBe(jobSpec('fetch_recordings')!.impact)
      expect(failures[0]?.maxAttempts).toBe(5)
      expect(failures[0]?.attempts).toBe(1)
    },
  )
})

test('轮次抛出时不 resolve 失败项——那些对象只是没轮到', async () => {
  await withScheduler(
    { archive_nas: async () => { throw new Error('boom') } },
    T0,
    async (h) => {
      await h.jobs.recordFailure({
        jobName: 'archive_nas',
        target: 'm-1|',
        targetLabel: '',
        meetingId: 'm-1',
        subMeetingId: '',
        reason: '旧的失败',
        impact: '未归档，到期会永久丢失',
        maxAttempts: 5,
        now: T0 - HOUR,
      })
      await h.scheduler.bootstrap()
      h.setNow(T0 + HOUR)
      await h.scheduler.tick()
      await h.drain()
      const open = await h.jobs.listFailures({ jobName: 'archive_nas' })
      expect(open.map((r) => r.target).sort()).toEqual([ROUND_FAILURE_TARGET, 'm-1|'])
    },
  )
})

test('轮次跑完之后，这一轮没再失败的项自动标成已恢复', async () => {
  await withScheduler({ archive_nas: async () => ({}) }, T0, async (h) => {
    await h.jobs.recordFailure({
      jobName: 'archive_nas',
      target: 'm-1|',
      targetLabel: '',
      meetingId: 'm-1',
      subMeetingId: '',
      reason: '上一轮失败了',
      impact: '未归档，到期会永久丢失',
      maxAttempts: 5,
      now: T0 - HOUR,
    })
    await h.scheduler.bootstrap()
    h.setNow(T0 + HOUR)
    await h.scheduler.tick()
    await h.drain()
    expect(await h.jobs.listFailures({ jobName: 'archive_nas' })).toHaveLength(0)
    expect(await h.jobs.listFailures({ jobName: 'archive_nas', includeResolved: true })).toHaveLength(1)
  })
})

test('任务体落的失败项带上任务自己的影响与阈值', async () => {
  await withScheduler(
    {
      cleanup_expired: async (ctx) => {
        await ctx.fail({
          target: 'm-9|',
          targetLabel: '季度复盘',
          meetingId: 'm-9',
          subMeetingId: '',
          reason: 'NAS 上的文件哈希对不上',
        })
        return { verificationFailed: 1 }
      },
    },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      h.setNow(T0 + 3 * HOUR)
      await h.scheduler.tick()
      await h.drain()
      const f = (await h.jobs.listFailures({ jobName: 'cleanup_expired' }))[0]!
      expect(f.impact).toBe(jobSpec('cleanup_expired')!.impact)
      expect(f.targetLabel).toBe('季度复盘')
      expect(f.meetingId).toBe('m-9')
      // 本轮刚落的失败项不会被本轮的 resolve 顺手清掉
      expect(f.resolvedAt).toBeNull()
    },
  )
})

// ── 手动触发（网关排队 → 调度器认领）────────────────────────

test('认领网关排队的手动触发并跑一次', async () => {
  const seen: string[] = []
  await withScheduler(
    { archive_nas: async (ctx) => { seen.push(ctx.trigger); return {} } },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      const id = await h.jobs.enqueueManualRun({
        jobName: 'archive_nas',
        requestedBy: 'admin-1',
        now: T0,
      })
      h.setNow(T0 + 60)
      const out = await h.scheduler.tick()
      await h.drain()
      expect(out.claimed).toEqual(['archive_nas'])
      expect(seen).toEqual(['manual'])
      const run = await h.jobs.findRun(id)
      expect(run?.status).toBe('succeeded')
      expect(run?.requestedBy).toBe('admin-1')
    },
  )
})

test('连按三次只跑一次，另外两行标成已合并', async () => {
  let runs = 0
  await withScheduler(
    { archive_nas: async () => { runs++; return {} } },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      const ids = [
        await h.jobs.enqueueManualRun({ jobName: 'archive_nas', requestedBy: 'a', now: T0 }),
        await h.jobs.enqueueManualRun({ jobName: 'archive_nas', requestedBy: 'a', now: T0 }),
        await h.jobs.enqueueManualRun({ jobName: 'archive_nas', requestedBy: 'b', now: T0 }),
      ]
      h.setNow(T0 + 60)
      await h.scheduler.tick()
      await h.drain()
      expect(runs).toBe(1)
      expect((await h.jobs.findRun(ids[0]!))?.status).toBe('succeeded')
      for (const id of ids.slice(1)) {
        const r = await h.jobs.findRun(id)
        expect(r?.status).toBe('skipped')
        expect((r?.summary as { coalescedIntoRunId: number }).coalescedIntoRunId).toBe(ids[0]!)
      }
    },
  )
})

test('任务正在跑时，手动触发原样留在队里，下一个 tick 再认领', async () => {
  const gate: { release: (() => void) | null } = { release: null }
  let entered = 0
  await withScheduler(
    {
      archive_nas: async () => {
        entered++
        // 同上：只卡住第一轮，后面被认领的那次手动触发要能正常跑完
        if (entered === 1) await new Promise<void>((r) => { gate.release = r })
        return {}
      },
    },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      h.setNow(T0 + HOUR)
      await h.scheduler.tick()
      const id = await h.jobs.enqueueManualRun({
        jobName: 'archive_nas',
        requestedBy: 'a',
        now: T0 + HOUR,
      })
      h.setNow(T0 + HOUR + 60)
      const out = await h.scheduler.tick()
      expect(out.claimed).toEqual([])
      // 没被认领 = 还在队里。标成 skipped 会把管理员按过的那次触发悄悄吞掉
      expect((await h.jobs.findRun(id))?.status).toBe('queued')

      gate.release?.()
      await h.drain()
      h.setNow(T0 + HOUR + 120)
      await h.scheduler.tick()
      await h.drain()
      expect((await h.jobs.findRun(id))?.status).toBe('succeeded')
    },
  )
})

test('手动跑过之后，同一片里的定时触发不再重复起一轮', async () => {
  let runs = 0
  await withScheduler(
    { archive_nas: async () => { runs++; return {} } },
    T0,
    async (h) => {
      await h.scheduler.bootstrap()
      h.setNow(T0 + HOUR)
      await h.jobs.enqueueManualRun({ jobName: 'archive_nas', requestedBy: 'a', now: T0 + HOUR })
      // 这一刻既到点（整点）又有排队的手动触发：只该跑一次
      const out = await h.scheduler.tick()
      await h.drain()
      expect(out.claimed).toEqual(['archive_nas'])
      // 同一片里既认领了手动触发又到点：归档只该跑一次，不许再起一轮，
      // 也不该留下一行 skipped（那会让运维以为有一轮被挡掉了）
      expect(out.started).not.toContain('archive_nas')
      expect(out.skipped).not.toContain('archive_nas')
      expect(runs).toBe(1)
    },
  )
})

// ── 重启后看得出中间断了（验收判据 3）────────────────────────

test('bootstrap 把上一次残留的 running 标成 interrupted', async () => {
  await withScheduler({}, T0, async (h) => {
    const crashed = await h.jobs.startRun({
      jobName: 'archive_nas',
      trigger: 'schedule',
      now: T0 - HOUR,
    })
    await h.scheduler.bootstrap()
    const rec = await h.jobs.findRun(crashed)
    expect(rec?.status).toBe('interrupted')
    expect(rec?.finishedAt).toBe(T0)
  })
})

// ── 四个任务体（createJobRunners）────────────────────────────

/** 一轮什么都没发现、什么都没下的拉取轮 */
const EMPTY_FETCH_ROUND: FetchRound = {
  meetings: 0,
  tasks: 0,
  probes: { resolved: 0, abandoned: 0, newTasks: 0 },
  completed: 0,
  failed: 0,
  skipped: 0,
  manifests: { written: 0, unchanged: 0, skipped: 0, failed: 0 },
}

function bodyDeps(over: Partial<JobBodyDeps>): JobBodyDeps {
  return {
    fetchRound: async () => EMPTY_FETCH_ROUND,
    archiveRound: async () => ({
      newlyArchived: 0,
      verificationFailed: 0,
      failed: 0,
      sidecarFailed: 0,
      skipped: 0,
      undecidable: 0,
    }),
    cleanup: async () => ({ dryRun: false, paused: false, purged: [], verificationFailed: [], failed: [] }),
    listPrograms: async () => [],
    inventory: async () => ({
      programId: 'p',
      now: 0,
      entries: [],
      fetchable: [],
      blocked: [],
      assetTypes: [],
    }),
    ...over,
  }
}

test('任务四逐程序算一遍，把 fetchable / blocked 写进摘要——不写缓存表（E-e）', async () => {
  const asked: string[] = []
  const deps = bodyDeps({
    listPrograms: async () => [
      { id: 'p-1', name: '财务采集', tmUserId: 'u1', enabled: true, expiresAt: null, createdAt: 0 },
      { id: 'p-2', name: '合规采集', tmUserId: 'u2', enabled: true, expiresAt: null, createdAt: 0 },
    ],
    inventory: async (programId) => {
      asked.push(programId)
      return {
        programId,
        now: 0,
        entries: [],
        fetchable: programId === 'p-1' ? ([{}, {}, {}] as never) : ([] as never),
        blocked: programId === 'p-1' ? ([] as never) : ([{}] as never),
        assetTypes: [],
      }
    },
  })
  await withScheduler({ refresh_inventory: createJobRunners(deps).refresh_inventory }, T0, async (h) => {
    await h.scheduler.bootstrap()
    h.setNow(T0 + 5 * MIN)
    await h.scheduler.tick()
    await h.drain()
    expect(asked).toEqual(['p-1', 'p-2'])
    const run = (await h.jobs.listRuns('refresh_inventory', 1))[0]!
    expect(run.status).toBe('succeeded')
    expect(run.summary).toEqual({
      programs: [
        { programId: 'p-1', name: '财务采集', fetchable: 3, blocked: 0 },
        { programId: 'p-2', name: '合规采集', fetchable: 0, blocked: 1 },
      ],
      fetchable: 3,
      blocked: 1,
      failedPrograms: 0,
    })
  })
})

test('任务四某个程序算不出来：其它程序照算，那一个进失败项', async () => {
  const deps = bodyDeps({
    listPrograms: async () => [
      { id: 'p-1', name: '坏的', tmUserId: 'u1', enabled: true, expiresAt: null, createdAt: 0 },
      { id: 'p-2', name: '好的', tmUserId: 'u2', enabled: true, expiresAt: null, createdAt: 0 },
    ],
    inventory: async (programId) => {
      if (programId === 'p-1') throw new Error('规则表读不到')
      return { programId, now: 0, entries: [], fetchable: [], blocked: [], assetTypes: [] }
    },
  })
  await withScheduler({ refresh_inventory: createJobRunners(deps).refresh_inventory }, T0, async (h) => {
    await h.scheduler.bootstrap()
    h.setNow(T0 + 5 * MIN)
    await h.scheduler.tick()
    await h.drain()
    // 一个程序算不出来不该让整轮 failed——另一个程序的巡检数据仍然有效
    const run = (await h.jobs.listRuns('refresh_inventory', 1))[0]!
    expect(run.status).toBe('succeeded')
    expect((run.summary as { failedPrograms: number }).failedPrograms).toBe(1)
    const f = (await h.jobs.listFailures({ jobName: 'refresh_inventory' }))[0]!
    expect(f.target).toBe('p-1')
    expect(f.targetLabel).toBe('坏的')
    expect(f.reason).toContain('规则表读不到')
  })
})

test('任务三把拒删与出错的会议逐场落成失败项，带各自的原因', async () => {
  const deps = bodyDeps({
    cleanup: async () => ({
      dryRun: false,
      paused: false,
      purged: [{ meetingId: 'm-1', subMeetingId: '', localBytes: 10, assetCount: 1 }],
      verificationFailed: [{ meetingId: 'm-2', subMeetingId: '', reason: '哈希对不上' }],
      failed: [{ meetingId: 'm-3', subMeetingId: 's-1', reason: 'EACCES' }],
    }),
  })
  await withScheduler({ cleanup_expired: createJobRunners(deps).cleanup_expired }, T0, async (h) => {
    await h.scheduler.bootstrap()
    h.setNow(T0 + 3 * HOUR)
    await h.scheduler.tick()
    await h.drain()
    const run = (await h.jobs.listRuns('cleanup_expired', 1))[0]!
    expect(run.summary).toEqual({
      purged: 1,
      purgedBytes: 10,
      verificationFailed: 1,
      failed: 1,
      paused: false,
    })
    const fs = await h.jobs.listFailures({ jobName: 'cleanup_expired' })
    expect(fs.map((f) => f.target).sort()).toEqual(['m-2|', 'm-3|s-1'])
  })
})

test('任务三被暂停时如实报，不当成"没有可清理的"', async () => {
  const deps = bodyDeps({
    cleanup: async () => ({ dryRun: false, paused: true, purged: [], verificationFailed: [], failed: [] }),
  })
  await withScheduler({ cleanup_expired: createJobRunners(deps).cleanup_expired }, T0, async (h) => {
    await h.scheduler.bootstrap()
    h.setNow(T0 + 3 * HOUR)
    await h.scheduler.tick()
    await h.drain()
    const run = (await h.jobs.listRuns('cleanup_expired', 1))[0]!
    expect((run.summary as { paused: boolean }).paused).toBe(true)
  })
})

/**
 * T14 之前这条用例只断言 `{ meetings, tasks }`——那时任务一确实只 discover + 入队。
 * 现在它还要把队列下完，摘要必须给出下了多少：只有发现数的话，一轮全下挂了在运行
 * 记录里看起来和一轮全下成功一模一样。「真的下下来了」那条端到端的证据在
 * tests/worker/e2e.test.ts。
 */
test('任务一把发现数与下载数一起写进摘要', async () => {
  const deps = bodyDeps({
    fetchRound: async () => ({
      meetings: 4,
      tasks: 11,
      probes: { resolved: 2, abandoned: 1, newTasks: 2 },
      completed: 9,
      failed: 1,
      skipped: 1,
      manifests: { written: 4, unchanged: 0, skipped: 0, failed: 0 },
    }),
  })
  await withScheduler({ fetch_recordings: createJobRunners(deps).fetch_recordings }, T0, async (h) => {
    await h.scheduler.bootstrap()
    h.setNow(T0 + 15 * MIN)
    await h.scheduler.tick()
    await h.drain()
    const run = (await h.jobs.listRuns('fetch_recordings', 1))[0]!
    // 逐个资产下挂了不算整轮失败（与任务二同一条两层容错），整轮仍是 succeeded
    expect(run.status).toBe('succeeded')
    expect(run.summary).toEqual({
      meetings: 4,
      discovered: 11,
      completed: 9,
      failed: 1,
      skipped: 1,
      probes: { resolved: 2, abandoned: 1, newTasks: 2 },
      manifests: { written: 4, unchanged: 0, skipped: 0, failed: 0 },
    })
  })
})

/**
 * T14 之后任务一里跑着执行体，一轮可以跑几十分钟（一个 2GB 的录制就够了），
 * 而它每 15 分钟到点一次。这条钉的是重叠保护对它仍然成立——判据 2 的那条用例
 * 用的是归档，而现在**任务一才是最可能压着下一片的那个**。
 */
test('任务一现在可能跑几十分钟：下一片到点时不起新的，留一行 skipped', async () => {
  const gate: { release: (() => void) | null } = { release: null }
  let entered = 0
  const blocking: JobRunner = async () => {
    entered++
    if (entered === 1) await new Promise<void>((resolve) => { gate.release = resolve })
    return {}
  }
  await withScheduler({ fetch_recordings: blocking }, T0, async (h) => {
    await h.scheduler.bootstrap()
    h.setNow(T0 + 15 * MIN)
    await h.scheduler.tick()
    expect(entered).toBe(1)

    // 40 分钟过去了，中间跨了两片，两片都只留 skipped
    h.setNow(T0 + 30 * MIN)
    expect((await h.scheduler.tick()).skipped).toContain('fetch_recordings')
    h.setNow(T0 + 45 * MIN)
    expect((await h.scheduler.tick()).skipped).toContain('fetch_recordings')
    expect(entered).toBe(1)

    const runs = await h.jobs.listRuns('fetch_recordings', 10)
    expect(runs.map((r) => r.status)).toEqual(['skipped', 'skipped', 'running'])
    // 两行 skipped 都指着挡住它们的那一次运行
    for (const r of runs.slice(0, 2)) {
      expect((r.summary as { blockedByRunId: number }).blockedByRunId).toBe(runs[2]!.id)
    }

    gate.release?.()
    await h.drain()
  })
})

/**
 * 任务一收**活时钟**，不是冻结在开跑时刻的那个时间戳。
 *
 * 这一条不是风格问题：执行体领任务时写的 `lease_expires_at = now() + leaseSec`，
 * 而租约默认 15 分钟、一轮却可以跑更久。时钟冻结在开跑时刻的话，一轮里后领取的
 * 任务全都拿到一个**已经过期**的租约，另一个进程（`bun run worker` 手动补跑）
 * 按自己的活时钟一看就把还在下载中的任务抢走，两个进程同时写同一个 `.part`。
 */
test('任务一收到的是活时钟，不是冻结在开跑时刻的时间戳', async () => {
  const seen: number[] = []
  const hold: { setNow?: (t: number) => void } = {}
  const deps = bodyDeps({
    fetchRound: async (clock) => {
      seen.push(clock())
      hold.setNow?.(T0 + 35 * MIN) // 模拟"这一轮下了 20 分钟"
      seen.push(clock())
      return EMPTY_FETCH_ROUND
    },
  })
  await withScheduler({ fetch_recordings: createJobRunners(deps).fetch_recordings }, T0, async (h) => {
    hold.setNow = h.setNow
    await h.scheduler.bootstrap()
    h.setNow(T0 + 15 * MIN)
    await h.scheduler.tick()
    await h.drain()
  })
  expect(seen).toEqual([T0 + 15 * MIN, T0 + 35 * MIN])
})

test('任务二把归档轮的六个数字原样写进摘要', async () => {
  const deps = bodyDeps({
    archiveRound: async () => ({
      newlyArchived: 5,
      verificationFailed: 1,
      failed: 2,
      sidecarFailed: 0,
      skipped: 3,
      undecidable: 1,
    }),
  })
  await withScheduler({ archive_nas: createJobRunners(deps).archive_nas }, T0, async (h) => {
    await h.scheduler.bootstrap()
    h.setNow(T0 + HOUR)
    await h.scheduler.tick()
    await h.drain()
    const run = (await h.jobs.listRuns('archive_nas', 1))[0]!
    // 归档轮内几场会议归不上**不算整轮失败**：失败项在 job_failures 里，
    // 整轮标红会让真正"归档任务挂了"的那一次淹没在里面
    expect(run.status).toBe('succeeded')
    expect(run.summary).toEqual({
      newlyArchived: 5,
      verificationFailed: 1,
      failed: 2,
      sidecarFailed: 0,
      skipped: 3,
      undecidable: 1,
    })
  })
})
