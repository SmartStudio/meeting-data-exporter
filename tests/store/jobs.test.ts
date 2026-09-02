import { expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import {
  JOB_CATALOG,
  createJobsStore,
  jobSpec,
  nextDueAt,
  slotOf,
  slotStartAt,
  type JobsStore,
} from '../../src/store/jobs'
import type { Pool } from '../../src/store/db'

/**
 * 阶段 4 · T11（A4）的存取层。两半分开测：
 *
 * - **时间片算术**是纯函数，不碰库。它是「进程重启后不补跑错过的」（验收判据 3）
 *   与「每小时整点 / 每天 03:00」两件事的唯一实现处，所以要逐条钉死边界
 * - **job_runs / job_failures 的往返**要真数据库：这一层的价值全在 SQL 语义里
 *   （唯一键撞上时是累加还是新增、JSON 列往返、已恢复的行再次失败怎么办）
 */

const HOUR = 3600
const DAY = 86_400
/** 东八区。到期清理定在「凌晨 3 点」，那是**本地时间**的低谷 */
const CST = 8 * HOUR

async function withStore(fn: (store: JobsStore, pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try {
    await fn(createJobsStore(pool), pool)
  } finally {
    await cleanup()
  }
}

// ── 一、任务目录 ────────────────────────────────────────────────

test('JOB_CATALOG 就是 spec §4.8 的四个任务，频率逐条对上', () => {
  expect(JOB_CATALOG.map((j) => j.name)).toEqual([
    'fetch_recordings',
    'archive_nas',
    'cleanup_expired',
    'refresh_inventory',
  ])
  expect(jobSpec('fetch_recordings')?.schedule).toEqual({ kind: 'everyMinutes', minutes: 15 })
  expect(jobSpec('archive_nas')?.schedule).toEqual({ kind: 'hourly', minute: 0 })
  expect(jobSpec('cleanup_expired')?.schedule).toEqual({ kind: 'daily', hour: 3, minute: 0 })
  expect(jobSpec('refresh_inventory')?.schedule).toEqual({ kind: 'everyMinutes', minutes: 5 })
})

test('认不出来的任务名返回 null，不回退到第一个任务', () => {
  // 手动触发端点拿的是路径参数，回退到"第一个任务"等于按下"拉取"按钮跑了清理
  expect(jobSpec('archive')).toBeNull()
  expect(jobSpec('')).toBeNull()
})

test('每个任务都带一句「影响」——失败项表要显示它（spec §4.8）', () => {
  for (const spec of JOB_CATALOG) {
    expect(spec.impact.length).toBeGreaterThan(0)
    expect(spec.maxAttempts).toBeGreaterThan(0)
  }
  // 抽查一条。措辞本身由 tests/store/jobs-copy.test.ts 钉住三处一致，
  // 这里只确认「影响」这一列真的接到了目录里那句话上
  expect(jobSpec('archive_nas')?.impact).toBe('本地文件到期清理后，这场会议就一份都不剩了')
})

// ── 二、时间片算术 ──────────────────────────────────────────────

test('每 15 分钟对齐到 :00 :15 :30 :45，而不是"进程启动后每 15 分钟"', () => {
  const sched = { kind: 'everyMinutes', minutes: 15 } as const
  // 1970-01-01 00:07:00 与 00:14:59 落在同一片，00:15:00 换片
  expect(slotOf(sched, 7 * 60, 0)).toBe(slotOf(sched, 14 * 60 + 59, 0))
  expect(slotOf(sched, 15 * 60, 0)).toBe(slotOf(sched, 7 * 60, 0) + 1)
  expect(slotStartAt(sched, slotOf(sched, 7 * 60, 0), 0)).toBe(0)
  expect(nextDueAt(sched, 7 * 60, 0)).toBe(15 * 60)
})

test('每小时整点：59:59 与 00:00 分属两片', () => {
  const sched = { kind: 'hourly', minute: 0 } as const
  const t = 10 * HOUR + 59 * 60 + 59
  expect(slotOf(sched, t, 0) + 1).toBe(slotOf(sched, 11 * HOUR, 0))
  expect(nextDueAt(sched, t, 0)).toBe(11 * HOUR)
})

test('每天 03:00 按本地时区算，东八区就是 UTC 19:00', () => {
  const sched = { kind: 'daily', hour: 3, minute: 0 } as const
  // 2026-08-26 03:00 CST = 2026-08-25 19:00 UTC
  const due = Date.UTC(2026, 7, 25, 19, 0, 0) / 1000
  expect(nextDueAt(sched, due - 1, CST)).toBe(due)
  expect(slotOf(sched, due, CST)).toBe(slotOf(sched, due + DAY - 1, CST))
  expect(slotOf(sched, due + DAY, CST)).toBe(slotOf(sched, due, CST) + 1)
})

test('时区给 0 时 03:00 就是 UTC 03:00——两者不能混着算', () => {
  const sched = { kind: 'daily', hour: 3, minute: 0 } as const
  const utc3 = Date.UTC(2026, 7, 26, 3, 0, 0) / 1000
  expect(nextDueAt(sched, utc3 - 1, 0)).toBe(utc3)
  // 同一时刻在东八区落在另一片：这正是配错时区会让清理跑在业务高峰的原因
  expect(slotStartAt(sched, slotOf(sched, utc3, CST), CST)).not.toBe(utc3)
})

// ── 三、job_runs 的往返 ─────────────────────────────────────────

test('startRun / finishRun：summary 是 JSON 列，原样往返', async () => {
  await withStore(async (store) => {
    const id = await store.startRun({ jobName: 'archive_nas', trigger: 'schedule', now: 1000 })
    const running = await store.findRun(id)
    expect(running?.status).toBe('running')
    expect(running?.startedAt).toBe(1000)
    expect(running?.finishedAt).toBeNull()
    expect(running?.trigger).toBe('schedule')
    expect(running?.requestedBy).toBeNull()

    await store.finishRun(id, {
      status: 'succeeded',
      summary: { newlyArchived: 3, failed: 0, meetings: ['a', 'b'] },
      now: 1200,
    })
    const done = await store.findRun(id)
    expect(done?.status).toBe('succeeded')
    expect(done?.finishedAt).toBe(1200)
    expect(done?.summary).toEqual({ newlyArchived: 3, failed: 0, meetings: ['a', 'b'] })
    expect(done?.error).toBeNull()
  })
})

test('任务体自己抛出时记 failed + error，与"轮内有几件事失败"分得开', async () => {
  await withStore(async (store) => {
    const id = await store.startRun({ jobName: 'fetch_recordings', trigger: 'schedule', now: 10 })
    await store.finishRun(id, { status: 'failed', error: '腾讯接口 502', now: 20 })
    const rec = await store.findRun(id)
    expect(rec?.status).toBe('failed')
    expect(rec?.error).toBe('腾讯接口 502')
    expect(rec?.summary).toBeNull()
  })
})

test('listRuns 按任务倒序取最近 N 条，sparkline 读的就是它', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i++) {
      const id = await store.startRun({ jobName: 'archive_nas', trigger: 'schedule', now: i })
      await store.finishRun(id, { status: 'succeeded', summary: { i }, now: i })
    }
    await store.startRun({ jobName: 'cleanup_expired', trigger: 'schedule', now: 99 })

    const rows = await store.listRuns('archive_nas', 3)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => (r.summary as { i: number }).i)).toEqual([4, 3, 2])
    // 别的任务的行不许混进来——混进来的话 sparkline 会把清理的失败画成归档的
    expect(rows.every((r) => r.jobName === 'archive_nas')).toBe(true)
  })
})

test('重叠保护落成一行 skipped，而不是什么都不发生', async () => {
  await withStore(async (store) => {
    const blocking = await store.startRun({
      jobName: 'archive_nas',
      trigger: 'schedule',
      now: 100,
    })
    const skipped = await store.recordSkip({
      jobName: 'archive_nas',
      now: 3700,
      blockedByRunId: blocking,
    })
    const rec = await store.findRun(skipped)
    expect(rec?.status).toBe('skipped')
    expect(rec?.startedAt).toBeNull()
    expect(rec?.finishedAt).toBe(3700)
    expect(rec?.summary).toEqual({ blockedByRunId: blocking })
  })
})

// ── 四、手动触发：网关排队，调度器认领 ─────────────────────────

test('手动触发在网关侧只排队，认领之后才变 running', async () => {
  await withStore(async (store) => {
    const id = await store.enqueueManualRun({
      jobName: 'refresh_inventory',
      requestedBy: 'admin-1',
      now: 500,
    })
    const queued = await store.findRun(id)
    expect(queued?.status).toBe('queued')
    // 排队中还没开跑：startedAt 必须是 null，否则界面上"排队中"与"正在跑"长得一样
    expect(queued?.startedAt).toBeNull()
    expect(queued?.trigger).toBe('manual')
    expect(queued?.requestedBy).toBe('admin-1')

    const claimed = await store.claimQueued('refresh_inventory', 600)
    expect(claimed).toEqual([id])
    expect((await store.findRun(id))?.status).toBe('running')
    expect((await store.findRun(id))?.startedAt).toBe(600)

    // 认领过的不会被第二次认领
    expect(await store.claimQueued('refresh_inventory', 700)).toEqual([])
  })
})

test('claimQueued 只认领指定任务的排队行', async () => {
  await withStore(async (store) => {
    await store.enqueueManualRun({ jobName: 'archive_nas', requestedBy: 'a', now: 1 })
    const b = await store.enqueueManualRun({
      jobName: 'cleanup_expired',
      requestedBy: 'a',
      now: 2,
    })
    expect(await store.claimQueued('cleanup_expired', 3)).toEqual([b])
  })
})

test('同一任务连按三次只会被认领成三行，交给调度器合并（按 id 升序）', async () => {
  await withStore(async (store) => {
    const ids = [
      await store.enqueueManualRun({ jobName: 'archive_nas', requestedBy: 'a', now: 1 }),
      await store.enqueueManualRun({ jobName: 'archive_nas', requestedBy: 'a', now: 2 }),
      await store.enqueueManualRun({ jobName: 'archive_nas', requestedBy: 'b', now: 3 }),
    ]
    expect(await store.claimQueued('archive_nas', 4)).toEqual(ids)
  })
})

// ── 五、重启后看得出中间断了（验收判据 3）────────────────────

test('markInterrupted 把残留的 running 标成 interrupted，不碰已经结束的行', async () => {
  await withStore(async (store) => {
    const crashed = await store.startRun({
      jobName: 'archive_nas',
      trigger: 'schedule',
      now: 100,
    })
    const done = await store.startRun({ jobName: 'fetch_recordings', trigger: 'schedule', now: 90 })
    await store.finishRun(done, { status: 'succeeded', summary: {}, now: 95 })
    const queued = await store.enqueueManualRun({
      jobName: 'archive_nas',
      requestedBy: 'a',
      now: 99,
    })

    expect(await store.markInterrupted(1000)).toBe(1)

    const rec = await store.findRun(crashed)
    expect(rec?.status).toBe('interrupted')
    // 断点时刻要留下来，否则时间轴上看不出停机窗口是从哪儿开始的
    expect(rec?.finishedAt).toBe(1000)
    expect((await store.findRun(done))?.status).toBe('succeeded')
    // 排队中的手动触发不是"中断"——它还没开跑，重启后照样应该被认领
    expect((await store.findRun(queued))?.status).toBe('queued')
  })
})

// ── 六、job_failures：不静默丢弃（验收判据 1）──────────────────

test('同一个对象反复失败是累加 attempts，不是每轮新增一行', async () => {
  await withStore(async (store) => {
    const base = {
      jobName: 'archive_nas',
      target: 'm-1|',
      targetLabel: '季度财务复盘',
      meetingId: 'm-1',
      subMeetingId: '',
      impact: '未归档，到期会永久丢失',
      maxAttempts: 5,
    }
    await store.recordFailure({ ...base, reason: 'NAS 写入超时', now: 1000 })
    await store.recordFailure({ ...base, reason: 'ENOENT 本地文件不见了', now: 2000 })

    const rows = await store.listFailures()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.attempts).toBe(2)
    expect(row.maxAttempts).toBe(5)
    // 首次失败时刻是"这件事卡了多久"的起点，不能被最近一次覆盖
    expect(row.firstFailedAt).toBe(1000)
    expect(row.lastFailedAt).toBe(2000)
    // 原因取最近一次：上一轮的原因已经过时了
    expect(row.reason).toBe('ENOENT 本地文件不见了')
    expect(row.impact).toBe('未归档，到期会永久丢失')
    expect(row.targetLabel).toBe('季度财务复盘')
    expect(row.resolvedAt).toBeNull()
  })
})

test('不同任务的同名对象是两个失败项', async () => {
  await withStore(async (store) => {
    const base = { target: 'm-1|', targetLabel: '', meetingId: 'm-1', subMeetingId: '', maxAttempts: 5 }
    await store.recordFailure({ ...base, jobName: 'archive_nas', reason: 'a', impact: 'x', now: 1 })
    await store.recordFailure({ ...base, jobName: 'cleanup_expired', reason: 'b', impact: 'y', now: 1 })
    expect(await store.listFailures()).toHaveLength(2)
    expect(await store.listFailures({ jobName: 'archive_nas' })).toHaveLength(1)
  })
})

test('恢复了的失败项不删行，但默认不出现在"需要处理"里', async () => {
  await withStore(async (store) => {
    await store.recordFailure({
      jobName: 'archive_nas',
      target: 'm-1|',
      targetLabel: '',
      meetingId: 'm-1',
      subMeetingId: '',
      reason: 'NAS 写入超时',
      impact: '未归档，到期会永久丢失',
      maxAttempts: 5,
      now: 1000,
    })
    // 这一轮从 2000 开跑并且跑完了，而这个对象最近一次失败是 1000 —— 它没再失败
    expect(await store.resolveStaleFailures('archive_nas', 2000, 2500)).toBe(1)

    expect(await store.listFailures()).toHaveLength(0)
    const all = await store.listFailures({ includeResolved: true })
    expect(all).toHaveLength(1)
    expect(all[0]?.resolvedAt).toBe(2500)
  })
})

test('轮次开始之后才失败的项不会被这一轮的 resolve 误清', async () => {
  await withStore(async (store) => {
    const base = {
      jobName: 'archive_nas',
      targetLabel: '',
      meetingId: null,
      subMeetingId: '',
      reason: 'x',
      impact: 'y',
      maxAttempts: 5,
    }
    await store.recordFailure({ ...base, target: 'old', now: 1000 })
    await store.recordFailure({ ...base, target: 'fresh', now: 2100 })
    expect(await store.resolveStaleFailures('archive_nas', 2000, 2500)).toBe(1)
    expect((await store.listFailures()).map((r) => r.target)).toEqual(['fresh'])
  })
})

test('恢复过的对象再次失败会重开，计数从 1 起算', async () => {
  await withStore(async (store) => {
    const base = {
      jobName: 'archive_nas',
      target: 'm-1|',
      targetLabel: '',
      meetingId: 'm-1',
      subMeetingId: '',
      reason: 'x',
      impact: '未归档，到期会永久丢失',
      maxAttempts: 5,
    }
    await store.recordFailure({ ...base, now: 1000 })
    await store.recordFailure({ ...base, now: 1100 })
    await store.resolveStaleFailures('archive_nas', 2000, 2000)
    await store.recordFailure({ ...base, now: 3000 })

    const rows = await store.listFailures()
    expect(rows).toHaveLength(1)
    // 这是新一轮失败：显示"4 / 5"会让人以为它从来没好过
    expect(rows[0]?.attempts).toBe(1)
    expect(rows[0]?.firstFailedAt).toBe(3000)
    expect(rows[0]?.resolvedAt).toBeNull()
  })
})

test('countOpenFailures 按任务分组，只数没恢复的', async () => {
  await withStore(async (store) => {
    const base = { targetLabel: '', meetingId: null, subMeetingId: '', reason: 'x', impact: 'y', maxAttempts: 5 }
    await store.recordFailure({ ...base, jobName: 'archive_nas', target: 'a', now: 1 })
    await store.recordFailure({ ...base, jobName: 'archive_nas', target: 'b', now: 1 })
    await store.recordFailure({ ...base, jobName: 'cleanup_expired', target: 'c', now: 1 })
    await store.resolveStaleFailures('cleanup_expired', 100, 100)

    expect(await store.countOpenFailures()).toEqual({ archive_nas: 2 })
  })
})

test('失败项按会议反查得到——详情抽屉要显示"这场归档失败了"', async () => {
  await withStore(async (store) => {
    await store.recordFailure({
      jobName: 'archive_nas',
      target: 'm-1|s-2',
      targetLabel: '',
      meetingId: 'm-1',
      subMeetingId: 's-2',
      reason: 'x',
      impact: 'y',
      maxAttempts: 5,
      now: 1,
    })
    const rows = await store.listFailures({ meetingId: 'm-1', subMeetingId: 's-2' })
    expect(rows).toHaveLength(1)
    expect(await store.listFailures({ meetingId: 'm-1', subMeetingId: '' })).toHaveLength(0)
  })
})

test('一整页会议一次问完：`meetings` 批量反查，场次是键的一半', async () => {
  await withStore(async (store) => {
    const base = { jobName: 'archive_nas', targetLabel: '', impact: 'y', maxAttempts: 5, now: 1 }
    await store.recordFailure({ ...base, target: 'm-1|', meetingId: 'm-1', subMeetingId: '', reason: 'a' })
    await store.recordFailure({ ...base, target: 'm-2|s-2', meetingId: 'm-2', subMeetingId: 's-2', reason: 'b' })
    await store.recordFailure({ ...base, target: 'm-3|', meetingId: 'm-3', subMeetingId: '', reason: 'c' })

    // 会议记录页整页反查：查询数与页上有几场归档失败的会议无关，恒为 1
    const rows = await store.listFailures({
      jobName: 'archive_nas',
      meetings: [
        { meetingId: 'm-1', subMeetingId: '' },
        { meetingId: 'm-2', subMeetingId: 's-2' },
      ],
    })
    expect(rows.map((r) => r.reason).sort()).toEqual(['a', 'b'])

    // 只给会议号会把周期性会议的**另一场**捞进来，而抽屉里那句话会因此
    // 把别的场次的失败原因说成这一场的
    expect(await store.listFailures({ meetings: [{ meetingId: 'm-2', subMeetingId: '' }] })).toHaveLength(0)

    // 空数组 = 这一页一场归档失败的会议都没有。**返回空，不是返回全表**：
    // 退化成"没有条件"的话，抽屉会把别的会议的失败原因安到这一场头上
    expect(await store.listFailures({ meetings: [] })).toEqual([])
  })
})
