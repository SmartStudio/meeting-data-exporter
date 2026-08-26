/**
 * T11 · A4 定时任务 API 的测试（spec §4.8）。
 *
 * 用假的 `JobsStore` 直接调 handler，不走真库：本文件要断言的是**胶水**——
 * 「下次运行」算得对不对、从没跑过的任务会不会被编出一个 lastRun、手动触发到底
 * 排了队还是当场跑了、审计有没有落。这些在真库上只能看到「返回了 200」。
 * store 层的 SQL 语义由 `tests/store/jobs.test.ts` 在真库上盯着。
 *
 * 验收判据 4（手动触发端点记审计）在这一层。判据 5 的另一半也在这里：
 * 手动触发**只排队**，网关一个任务体都不许跑。
 */
import { expect, test } from 'bun:test'
import { listJobs, runJob } from '../../src/http/handlers/console/jobs'
import {
  JOB_CATALOG,
  type JobFailureRecord,
  type JobRunRecord,
  type JobsStore,
} from '../../src/store/jobs'
import { AdminSessionInvalidError } from '../../src/auth/admin'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AuditEntry } from '../../src/store/audit'
import type { AppDeps, RouteCtx } from '../../src/http/router'

/** 2026-08-26 10:07:00 UTC —— 刻意不是任何一个任务的片边界 */
const NOW = Date.UTC(2026, 7, 26, 10, 7, 0) / 1000
const HOUR = 3600
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice' }

function fakeAdminAuth(ok = true): AdminAuth {
  return {
    async authenticate() { throw new Error('not stubbed') },
    async hashPassword() { throw new Error('not stubbed') },
    async issueSession() { throw new Error('not stubbed') },
    async verifySession() {
      // 会话无效必须抛这一种错——requireAdminAuth 只把它翻成 401，别的错会往上冒
      if (!ok) throw new AdminSessionInvalidError()
      return ADMIN
    },
    async revokeSession() { throw new Error('not stubbed') },
    async revokeAllSessionsFor() { throw new Error('not stubbed') },
  }
}

function run(o: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    id: 1,
    jobName: 'archive_nas',
    trigger: 'schedule',
    requestedBy: null,
    status: 'succeeded',
    startedAt: NOW - 400,
    finishedAt: NOW - 100,
    summary: { newlyArchived: 2 },
    error: null,
    createdAt: NOW - 400,
    ...o,
  }
}

function failure(o: Partial<JobFailureRecord> = {}): JobFailureRecord {
  return {
    id: 1,
    jobName: 'archive_nas',
    target: 'm-1|',
    targetLabel: '季度财务复盘',
    meetingId: 'm-1',
    subMeetingId: '',
    reason: 'NAS 写入超时',
    impact: '未归档，到期会永久丢失',
    attempts: 2,
    maxAttempts: 5,
    firstFailedAt: NOW - 7200,
    lastFailedAt: NOW - 600,
    resolvedAt: null,
    ...o,
  }
}

interface Spy {
  enqueued: Array<{ jobName: string; requestedBy: string; now: number }>
  audits: AuditEntry[]
  listRunsCalls: Array<{ jobName: string; limit: number }>
}

function fakeCtx(opts: {
  runsByJob?: Record<string, JobRunRecord[]>
  failures?: JobFailureRecord[]
  openCounts?: Record<string, number>
  loggedIn?: boolean
  params?: Record<string, string>
  tzOffsetSec?: number
}): { ctx: RouteCtx; spy: Spy } {
  const spy: Spy = { enqueued: [], audits: [], listRunsCalls: [] }
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} 不该被网关调用`)
  }
  const jobs: JobsStore = {
    startRun: notUsed('startRun'),
    finishRun: notUsed('finishRun'),
    recordSkip: notUsed('recordSkip'),
    claimQueued: notUsed('claimQueued'),
    coalesceRuns: notUsed('coalesceRuns'),
    markInterrupted: notUsed('markInterrupted'),
    findRun: notUsed('findRun'),
    recordFailure: notUsed('recordFailure'),
    resolveStaleFailures: notUsed('resolveStaleFailures'),
    async enqueueManualRun(input) {
      spy.enqueued.push(input)
      return 77
    },
    async listRuns(jobName, limit) {
      spy.listRunsCalls.push({ jobName, limit })
      return opts.runsByJob?.[jobName] ?? []
    },
    async listFailures() {
      return opts.failures ?? []
    },
    async countOpenFailures() {
      return opts.openCounts ?? {}
    },
  }

  const deps = {
    now: () => NOW,
    adminAuth: fakeAdminAuth(opts.loggedIn !== false),
    jobs: {
      jobs,
      audit: {
        async record(entry: AuditEntry) {
          spy.audits.push(entry)
        },
      },
      tzOffsetSec: opts.tzOffsetSec ?? 0,
    },
  } as unknown as AppDeps

  return { ctx: { params: opts.params ?? {}, deps }, spy }
}

function req(path: string, method = 'GET'): Request {
  return new Request(`https://gw.example${path}`, {
    method,
    headers: { cookie: 'mde_admin_session=session-token' },
  })
}

interface JobsBody {
  now: number
  timezoneOffsetSec: number
  failuresTotal: number
  jobs: Array<{
    name: string
    label: string
    what: string
    schedule: string
    nextDueAt: number
    impact: string
    maxAttempts: number
    openFailures: number
    health: string
    lastRun: null | { id: number; status: string; durationSec: number | null }
    recentRuns: Array<{ id: number; status: string; startedAt: number | null }>
  }>
  failures: Array<{
    jobName: string
    target: string
    targetLabel: string
    attempts: number
    maxAttempts: number
    impact: string
    reason: string
    escalated: boolean
  }>
}

// ── 列表 ──────────────────────────────────────────────────────

test('未登录返回 401，一次库都不查', async () => {
  const { ctx, spy } = fakeCtx({ loggedIn: false })
  const res = await listJobs(req('/api/v1/admin/jobs'), ctx)
  expect(res.status).toBe(401)
  expect(spy.listRunsCalls).toHaveLength(0)
})

test('四个任务全在，顺序与 spec §4.8 一致，频率是人话', async () => {
  const { ctx } = fakeCtx({})
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  expect(body.jobs.map((j) => j.name)).toEqual(JOB_CATALOG.map((j) => j.name))
  expect(body.jobs.map((j) => j.schedule)).toEqual([
    '每 15 分钟',
    '每小时整点',
    '每天 03:00',
    '每 5 分钟',
  ])
  expect(body.jobs[0]?.label).toBe('拉取新录制')
})

test('「下次运行」按时间片算，10:07 的下一个整点是 11:00', async () => {
  const { ctx } = fakeCtx({})
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  const archive = body.jobs.find((j) => j.name === 'archive_nas')!
  expect(archive.nextDueAt).toBe(Date.UTC(2026, 7, 26, 11, 0, 0) / 1000)
  const fetch15 = body.jobs.find((j) => j.name === 'fetch_recordings')!
  expect(fetch15.nextDueAt).toBe(Date.UTC(2026, 7, 26, 10, 15, 0) / 1000)
})

test('「下次运行」跟着调度器的时区走，配错会显示成另一个时刻', async () => {
  const { ctx } = fakeCtx({ tzOffsetSec: 8 * HOUR })
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  const cleanup = body.jobs.find((j) => j.name === 'cleanup_expired')!
  // 东八区的 03:00 = UTC 19:00。当天 UTC 10:07 还没到，所以下一次就是当天 19:00
  expect(cleanup.nextDueAt).toBe(Date.UTC(2026, 7, 26, 19, 0, 0) / 1000)
  expect(body.timezoneOffsetSec).toBe(8 * HOUR)
})

test('从没跑过的任务如实报 never_ran，不编一个 lastRun', async () => {
  const { ctx } = fakeCtx({})
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  for (const j of body.jobs) {
    expect(j.lastRun).toBeNull()
    expect(j.recentRuns).toEqual([])
    // 一个新部署的实例本来就没跑过，这与"调度器死了"不是一回事，所以分成两个状态
    expect(j.health).toBe('never_ran')
  }
})

test('上次运行过久没动静报 overdue——「下次运行 11:00」不该在调度器死掉时照样显示', async () => {
  const { ctx } = fakeCtx({
    runsByJob: {
      // 每小时一次的任务，上一次是 5 小时前
      archive_nas: [run({ startedAt: NOW - 5 * HOUR, finishedAt: NOW - 5 * HOUR + 10 })],
      fetch_recordings: [run({ jobName: 'fetch_recordings', startedAt: NOW - 60, finishedAt: NOW - 50 })],
    },
  })
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  expect(body.jobs.find((j) => j.name === 'archive_nas')?.health).toBe('overdue')
  expect(body.jobs.find((j) => j.name === 'fetch_recordings')?.health).toBe('ok')
})

test('还在跑的一轮不算 overdue，也不算跑完', async () => {
  const { ctx } = fakeCtx({
    runsByJob: {
      archive_nas: [run({ status: 'running', startedAt: NOW - 5 * HOUR, finishedAt: null })],
    },
  })
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  const j = body.jobs.find((x) => x.name === 'archive_nas')!
  expect(j.health).toBe('running')
  // 没跑完就没有时长。填一个"到现在为止"的数会让它每刷新一次就变大，看起来像跑完了
  expect(j.lastRun?.durationSec).toBeNull()
})

test('在一个死掉的调度器上按「立即运行」，不许把 overdue 翻回正常', async () => {
  const { ctx } = fakeCtx({
    runsByJob: {
      // 最新一行是排队中的手动触发（还没被认领），它前面才是真的跑过的那一次
      archive_nas: [
        run({ id: 9, status: 'queued', trigger: 'manual', startedAt: null, finishedAt: null }),
        run({ id: 8, startedAt: NOW - 5 * HOUR, finishedAt: NOW - 5 * HOUR + 10 }),
      ],
    },
  })
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  const j = body.jobs.find((x) => x.name === 'archive_nas')!
  // 那次触发永远不会被认领——页面不能因为多了一行 queued 就显示"一切正常"
  expect(j.health).toBe('overdue')
  // 但排队这件事本身要看得见
  expect(j.lastRun?.status).toBe('queued')
})

test('被重叠保护挡掉的一轮不改变 health 的判据', async () => {
  const { ctx } = fakeCtx({
    runsByJob: {
      archive_nas: [
        run({ id: 9, status: 'skipped', startedAt: null, finishedAt: NOW - 60 }),
        run({ id: 8, status: 'succeeded', startedAt: NOW - 600, finishedAt: NOW - 500 }),
      ],
    },
  })
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  expect(body.jobs.find((x) => x.name === 'archive_nas')?.health).toBe('ok')
})

test('sparkline 取最近若干次运行，原样带状态与时长', async () => {
  const { ctx, spy } = fakeCtx({
    runsByJob: {
      archive_nas: [
        run({ id: 3, status: 'failed', startedAt: NOW - 100, finishedAt: NOW - 90 }),
        run({ id: 2, status: 'skipped', startedAt: null, finishedAt: NOW - 3700 }),
        run({ id: 1, status: 'succeeded', startedAt: NOW - 7200, finishedAt: NOW - 7000 }),
      ],
    },
  })
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  const j = body.jobs.find((x) => x.name === 'archive_nas')!
  expect(j.recentRuns.map((r) => r.status)).toEqual(['failed', 'skipped', 'succeeded'])
  expect(j.lastRun?.id).toBe(3)
  expect(j.lastRun?.status).toBe('failed')
  expect(j.recentRuns[2]?.startedAt).toBe(NOW - 7200)
  // 每个任务只查一次，四个任务四次——不是每个任务查一次 sparkline 再查一次 lastRun
  expect(spy.listRunsCalls).toHaveLength(JOB_CATALOG.length)
})

test('失败项表带 attempts / maxAttempts 与那句「影响」（spec §4.8 硬要求）', async () => {
  const { ctx } = fakeCtx({
    failures: [failure(), failure({ id: 2, attempts: 6, target: 'm-2|' })],
    openCounts: { archive_nas: 2 },
  })
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  expect(body.failuresTotal).toBe(2)
  expect(body.jobs.find((j) => j.name === 'archive_nas')?.openFailures).toBe(2)
  const f = body.failures[0]!
  expect(f.attempts).toBe(2)
  expect(f.maxAttempts).toBe(5)
  expect(f.impact).toBe('未归档，到期会永久丢失')
  expect(f.reason).toBe('NAS 写入超时')
  expect(f.escalated).toBe(false)
  // 重试次数超过阈值 = 该找人了。它**不表示系统放弃重试**，归档会一直重试下去
  expect(body.failures[1]?.escalated).toBe(true)
})

// ── 手动触发（验收判据 4）───────────────────────────────────

test('手动触发只排队，网关一个任务体都不跑', async () => {
  const { ctx, spy } = fakeCtx({ params: { name: 'archive_nas' } })
  const res = await runJob(req('/api/v1/admin/jobs/archive_nas/run', 'POST'), ctx)
  expect(res.status).toBe(202)
  const body = (await res.json()) as { runId: number; status: string; jobName: string }
  // 202 而不是 200：这一刻任务**还没跑**，由 worker 侧的调度器认领。
  // 回 200 会让界面显示"已完成"，而归档可能几十分钟后才开始
  expect(body.status).toBe('queued')
  expect(body.runId).toBe(77)
  expect(spy.enqueued).toEqual([{ jobName: 'archive_nas', requestedBy: 'admin-1', now: NOW }])
})

test('手动触发记审计（验收判据 4）', async () => {
  const { ctx, spy } = fakeCtx({ params: { name: 'cleanup_expired' } })
  await runJob(req('/api/v1/admin/jobs/cleanup_expired/run', 'POST'), ctx)
  expect(spy.audits).toHaveLength(1)
  const a = spy.audits[0]!
  expect(a.actorType).toBe('admin')
  expect(a.actorId).toBe('admin-1')
  expect(a.action).toBe('run_job')
  expect(a.decision).toBe('allow')
  expect(a.clientKind).toBe('console')
  // 记得下是哪个任务：只记一句"手动触发"的话，审计流里四个任务长得一模一样
  expect(a.assetId).toBe('job:cleanup_expired')
  // 一句话明细在 detail 列（migrations/008），asset_type 不再当自由文本用
  expect(a.assetType).toBeNull()
  expect(a.detail).toContain('清理到期文件')
  // runId 另留一份结构化的，好把这条审计与 job_runs 那一行对上
  expect(JSON.parse(a.detail!.split('\n')[1]!)).toMatchObject({ jobName: 'cleanup_expired' })
})

test('认不出的任务名 404，不排队也不记审计', async () => {
  const { ctx, spy } = fakeCtx({ params: { name: 'archive' } })
  const res = await runJob(req('/api/v1/admin/jobs/archive/run', 'POST'), ctx)
  expect(res.status).toBe(404)
  // 回退到"第一个任务"等于按下「拉取」按钮却跑了不可逆的清理
  expect(spy.enqueued).toHaveLength(0)
  expect(spy.audits).toHaveLength(0)
})

test('手动触发未登录 401，且不排队', async () => {
  const { ctx, spy } = fakeCtx({ loggedIn: false, params: { name: 'archive_nas' } })
  const res = await runJob(req('/api/v1/admin/jobs/archive_nas/run', 'POST'), ctx)
  expect(res.status).toBe(401)
  expect(spy.enqueued).toHaveLength(0)
  expect(spy.audits).toHaveLength(0)
})

test('先排队再记审计：审计记的是已经发生的事', async () => {
  const order: string[] = []
  const { ctx } = fakeCtx({ params: { name: 'archive_nas' } })
  const deps = ctx.deps as unknown as {
    jobs: { jobs: JobsStore; audit: { record(e: AuditEntry): Promise<void> } }
  }
  const realEnqueue = deps.jobs.jobs.enqueueManualRun.bind(deps.jobs.jobs)
  deps.jobs.jobs.enqueueManualRun = async (i) => {
    order.push('enqueue')
    return realEnqueue(i)
  }
  const realRecord = deps.jobs.audit.record.bind(deps.jobs.audit)
  deps.jobs.audit.record = async (e) => {
    order.push('audit')
    await realRecord(e)
  }
  await runJob(req('/api/v1/admin/jobs/archive_nas/run', 'POST'), ctx)
  expect(order).toEqual(['enqueue', 'audit'])
})
