import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../src/api/client'
import { ApiShapeError } from '../../src/api/validate'
import { FAILURES_PAGE_LIMIT, fetchJobs, runJob } from '../../src/api/admin/jobs'

/**
 * `api/admin/jobs.ts` 的契约测试。
 *
 * 这一层只做三件事：发对路径、把响应按契约读出来、读不出来时**大声报**。
 * 「大声报」是重点：`res.json()` 回来是 `any`，字段名敲错一个字母不会有任何
 * 编译期提示，界面上表现为一片空白——而空白看起来像"这个任务本来就没跑过"。
 */

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    status: 'succeeded',
    trigger: 'schedule',
    requestedBy: null,
    startedAt: 1699999800,
    finishedAt: 1699999900,
    durationSec: 100,
    summary: { newlyArchived: 12 },
    error: null,
    ...over,
  }
}

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'archive_nas',
    label: '归档到 NAS',
    what: '写入 NAS 并校验哈希',
    schedule: '每小时整点',
    nextDueAt: 1700003600,
    impact: '未归档，到期会永久丢失',
    maxAttempts: 5,
    openFailures: 0,
    health: 'ok',
    lastRun: run(),
    recentRuns: [run()],
    ...over,
  }
}

function failure(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    jobName: 'archive_nas',
    target: 'm-1|',
    targetLabel: '产品周会',
    meetingId: 'm-1',
    subMeetingId: '',
    reason: 'NAS 写入超时',
    impact: '未归档，到期会永久丢失',
    attempts: 2,
    maxAttempts: 5,
    escalated: false,
    firstFailedAt: 1699900000,
    lastFailedAt: 1699999000,
    detail: null,
    ...over,
  }
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    now: 1700000000,
    timezoneOffsetSec: 28800,
    jobs: [job()],
    failuresTotal: 1,
    fetchLookbackHours: 24,
    failures: [failure()],
    ...over,
  }
}

function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchJobs()', () => {
  test('打的是全路径 GET /api/v1/admin/jobs，不带查询串', async () => {
    const f = stubFetch(payload())
    await fetchJobs()
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]?.[0]).toBe('/api/v1/admin/jobs')
    expect((f.mock.calls[0]?.[1] as RequestInit).method).toBe('GET')
  })

  test('字段照契约读出来，不重命名也不补默认值', async () => {
    stubFetch(payload())
    const o = await fetchJobs()
    expect(o.now).toBe(1700000000)
    expect(o.timezoneOffsetSec).toBe(28800)
    expect(o.failuresTotal).toBe(1)
    expect(o.jobs).toHaveLength(1)
    const j = o.jobs[0]!
    expect(j.name).toBe('archive_nas')
    expect(j.label).toBe('归档到 NAS')
    expect(j.what).toBe('写入 NAS 并校验哈希')
    expect(j.schedule).toBe('每小时整点')
    expect(j.nextDueAt).toBe(1700003600)
    expect(j.impact).toBe('未归档，到期会永久丢失')
    expect(j.maxAttempts).toBe(5)
    expect(j.openFailures).toBe(0)
    expect(j.health).toBe('ok')
    expect(j.lastRun?.durationSec).toBe(100)
    expect(j.recentRuns).toHaveLength(1)
  })

  test('失败项的影响、已重试次数与 escalated 都读出来', async () => {
    stubFetch(payload())
    const o = await fetchJobs()
    const f = o.failures[0]!
    expect(f.impact).toBe('未归档，到期会永久丢失')
    expect(f.attempts).toBe(2)
    expect(f.maxAttempts).toBe(5)
    expect(f.escalated).toBe(false)
    expect(f.targetLabel).toBe('产品周会')
    expect(f.meetingId).toBe('m-1')
    expect(f.lastFailedAt).toBe(1699999000)
  })

  test('`meetingId` 为 null 的失败项（程序维度 / 整轮维度）照样读得出来', async () => {
    stubFetch(payload({ failures: [failure({ meetingId: null, target: 'kb-indexer', subMeetingId: '' })] }))
    const o = await fetchJobs()
    expect(o.failures[0]?.meetingId).toBeNull()
    expect(o.failures[0]?.target).toBe('kb-indexer')
  })

  test('`lastRun` 为 null（从没跑过）不算响应有问题', async () => {
    stubFetch(payload({ jobs: [job({ lastRun: null, recentRuns: [], health: 'never_ran' })] }))
    const o = await fetchJobs()
    expect(o.jobs[0]?.lastRun).toBeNull()
    expect(o.jobs[0]?.recentRuns).toEqual([])
  })

  test('`durationSec` 为 null（还没跑完）原样保留，不拿别的字段凑一个数', async () => {
    stubFetch(
      payload({
        jobs: [job({ lastRun: run({ status: 'running', finishedAt: null, durationSec: null }) })],
      }),
    )
    const o = await fetchJobs()
    expect(o.jobs[0]?.lastRun?.durationSec).toBeNull()
    expect(o.jobs[0]?.lastRun?.finishedAt).toBeNull()
  })

  test('`summary` 是任意 JSON，不校验形状（对象 / 字符串 / null 都收）', async () => {
    stubFetch(
      payload({
        jobs: [
          job({ lastRun: run({ summary: { purged: 2, paused: false } }) }),
          job({ name: 'x1', lastRun: run({ summary: '归档 12 场' }) }),
          job({ name: 'x2', lastRun: run({ summary: null }) }),
        ],
      }),
    )
    const o = await fetchJobs()
    expect(o.jobs[0]?.lastRun?.summary).toEqual({ purged: 2, paused: false })
    expect(o.jobs[1]?.lastRun?.summary).toBe('归档 12 场')
    expect(o.jobs[2]?.lastRun?.summary).toBeNull()
  })

  test('`health` 不收窄成联合类型——后端加一个取值不该让前端整页红', async () => {
    stubFetch(payload({ jobs: [job({ health: 'paused_by_operator' })] }))
    const o = await fetchJobs()
    expect(o.jobs[0]?.health).toBe('paused_by_operator')
  })

  test('缺字段抛 ApiShapeError，且报得出是哪一条端点的哪一个字段', async () => {
    const bad = payload()
    delete (bad.jobs as Record<string, unknown>[])[0]!.impact
    stubFetch(bad)
    await expect(fetchJobs()).rejects.toBeInstanceOf(ApiShapeError)
    await expect(fetchJobs()).rejects.toThrow(/GET \/api\/v1\/admin\/jobs/)
    await expect(fetchJobs()).rejects.toThrow(/jobs\[0\]\.impact/)
  })

  test('失败项数组里第几条坏了，报得出下标', async () => {
    stubFetch(payload({ failures: [failure(), failure({ id: 2, attempts: '2' })] }))
    await expect(fetchJobs()).rejects.toThrow(/failures\[1\]\.attempts/)
  })

  test('失败项的 detail 读出来；没有明细读成 null，不是空串', async () => {
    stubFetch(payload({
      failuresTotal: 2,
      failures: [
        failure({ id: 1, detail: 'video/r-1/mp4: http 404' }),
        failure({ id: 2 }),
      ],
    }))
    const o = await fetchJobs()
    expect(o.failures[0]!.detail).toBe('video/r-1/mp4: http 404')
    expect(o.failures[1]!.detail).toBeNull()
  })

  test('detail 这个键整个缺失时报形状错——它是契约里的必有字段，不静默补 null', async () => {
    const f = failure()
    delete (f as Record<string, unknown>).detail
    stubFetch(payload({ failures: [f] }))
    await expect(fetchJobs()).rejects.toBeInstanceOf(ApiShapeError)
  })

  test('`failuresTotal` 缺失也是坏响应——它是"被截断了没有"的唯一判据', async () => {
    const bad = payload()
    delete bad.failuresTotal
    stubFetch(bad)
    await expect(fetchJobs()).rejects.toThrow(/failuresTotal/)
  })

  test('`fetchLookbackHours` 缺失也是坏响应——横幅那句「超过 N 小时要人工补拉」没有 N 就说不出口', async () => {
    const bad = payload()
    delete bad.fetchLookbackHours
    stubFetch(bad)
    await expect(fetchJobs()).rejects.toThrow(/fetchLookbackHours/)
  })

  test('非 2xx 抛 ApiError（带端点名），不是 ApiShapeError', async () => {
    stubFetch({ error: 'boom' }, 500)
    const e = await fetchJobs().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).not.toBeInstanceOf(ApiShapeError)
    expect((e as ApiError).message).toContain('GET /api/v1/admin/jobs')
  })
})

describe('runJob()', () => {
  const ACCEPTED = {
    runId: 555,
    jobName: 'archive_nas',
    label: '归档到 NAS',
    status: 'queued',
    message: '已排队。定时任务由 worker 进程的调度器执行……',
  }

  test('POST 到 /api/v1/admin/jobs/:name/run，不带请求体', async () => {
    const f = stubFetch(ACCEPTED, 202)
    await runJob('archive_nas')
    expect(f.mock.calls[0]?.[0]).toBe('/api/v1/admin/jobs/archive_nas/run')
    const init = f.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })

  test('任务名进路径前先 encode——路径参数是外部输入', async () => {
    const f = stubFetch(ACCEPTED, 202)
    await runJob('a/b c')
    expect(f.mock.calls[0]?.[0]).toBe('/api/v1/admin/jobs/a%2Fb%20c/run')
  })

  test('202 的五个字段读出来；status 是 queued，不能被当成"已完成"', async () => {
    stubFetch(ACCEPTED, 202)
    const r = await runJob('archive_nas')
    expect(r).toEqual(ACCEPTED)
    expect(r.status).toBe('queued')
  })

  test('404 unknown_job 抛 ApiError，错误码进 message', async () => {
    stubFetch({ error: 'unknown_job', name: 'nope', knownJobs: [] }, 404)
    const e = await runJob('nope').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(404)
    expect((e as ApiError).message).toContain('unknown_job')
  })
})

describe('FAILURES_PAGE_LIMIT', () => {
  test('与后端的 FAILURES_PAGE_LIMIT 同一个数（100）', () => {
    // 后端 `src/http/handlers/console/jobs.ts` 里那个常量。对不上时界面会把
    // "显示 100 条"说成"一共 100 条"，而那正是这一页最不该含糊的地方。
    expect(FAILURES_PAGE_LIMIT).toBe(100)
  })
})
