import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiShapeError } from '../../src/api/validate'
import {
  TENCENT_DOWN_STREAK,
  countConsecutiveFailures,
  fetchStreakText,
  fetchSystemHealth,
} from '../../src/api/admin/health'

const STORAGE = {
  nas: {
    root: '/mnt/nas',
    reachable: true,
    checkedAt: 1700000000,
    latencyMs: 12,
    error: null,
    totalBytes: 4000000000000,
    availableBytes: 1400000000000,
    usedByUsBytes: 842000000000,
    usedByOthersBytes: 1758000000000,
    archivedMeetings: 71,
    pendingMeetings: 2,
    failedMeetings: null,
    failedMeetingsNote: '归档失败项尚未落库…',
  },
  retention: {
    defaultDays: 30,
    defaultDaysSource: 'fallback',
    defaultDaysRaw: null,
    cleanupPaused: false,
    liveMeetings: 10,
    grantedMeetings: 8,
    expiringIn7dMeetings: 1,
    expiredMeetings: 0,
    localBytes: 900000000,
  },
}

function run(status: string, startedAt: number | null = 1699999800): Record<string, unknown> {
  return {
    id: 1,
    status,
    trigger: 'scheduler',
    requestedBy: null,
    startedAt,
    finishedAt: null,
    durationSec: null,
    summary: null,
    error: null,
  }
}

function jobsPayload(fetchRuns: string[], failuresTotal = 0): Record<string, unknown> {
  return {
    now: 1700000000,
    timezoneOffsetSec: 28800,
    jobs: [
      {
        name: 'fetch_recordings',
        label: '拉取新录制',
        what: '从腾讯会议拉新录制',
        schedule: '每 10 分钟',
        nextDueAt: 1700000600,
        impact: '拉不到就没有原始文件',
        maxAttempts: 5,
        openFailures: 0,
        health: 'ok',
        lastRun: fetchRuns.length === 0 ? null : run(fetchRuns[0]!),
        recentRuns: fetchRuns.map((s) => run(s)),
      },
      {
        name: 'archive_nas',
        label: '归档到 NAS',
        what: '写入 NAS 并校验哈希',
        schedule: '每小时 :00',
        nextDueAt: 1700003600,
        impact: '未归档，到期会永久丢失',
        maxAttempts: 5,
        openFailures: failuresTotal,
        health: 'ok',
        lastRun: null,
        recentRuns: [],
      },
    ],
    failuresTotal,
    failures: [],
  }
}

function install(routes: Record<string, { status: number; body: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      for (const [path, res] of Object.entries(routes)) {
        if (url === path) {
          return new Response(JSON.stringify(res.body), {
            status: res.status,
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      throw new Error(`health.test.ts: 未预期的 fetch ${url}`)
    }),
  )
}

function ok(jobs: Record<string, unknown> = jobsPayload([]), storage: unknown = STORAGE): void {
  install({
    '/api/v1/admin/storage': { status: 200, body: storage },
    '/api/v1/admin/jobs': { status: 200, body: jobs },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('countConsecutiveFailures · 「连续失败」的口径', () => {
  test('最近一次成功 → 0（recentRuns 最近一次在第 0 个）', () => {
    expect(countConsecutiveFailures(['succeeded', 'failed', 'failed'])).toBe(0)
  })

  test('连着三次失败 → 3', () => {
    expect(countConsecutiveFailures(['failed', 'failed', 'failed', 'succeeded'])).toBe(3)
  })

  test('queued / running / skipped 是"还没出结果"，跨过去，不打断也不计数', () => {
    // 在一台已经拉不通的机器上按一下「立即运行」，最新一行会变成 queued——
    // 拿它当"最近一次运行"会让界面从"连续失败"翻回正常，而那次触发根本没被认领。
    expect(countConsecutiveFailures(['queued', 'running', 'failed', 'skipped', 'failed'])).toBe(2)
  })

  test('一次都没跑过 → 0（没有证据说明它失败了）', () => {
    expect(countConsecutiveFailures([])).toBe(0)
    expect(countConsecutiveFailures(['queued'])).toBe(0)
  })

  test('interrupted 打断计数：进程被杀不等于腾讯会议不可达', () => {
    expect(countConsecutiveFailures(['failed', 'interrupted', 'failed'])).toBe(1)
  })
})

describe('fetchStreakText · 推断的措辞，两处必须一致', () => {
  test('说的是"最近 N 轮拉取连续失败"，不是一句肯定的"腾讯会议不可达"', () => {
    expect(fetchStreakText(3)).toBe('最近 3 轮拉取连续失败')
    expect(fetchStreakText(TENCENT_DOWN_STREAK)).not.toContain('腾讯会议不可达')
  })
})

describe('fetchSystemHealth · 两条真实端点', () => {
  test('storage 与 jobs 各请求一次，取出各自那一小块', async () => {
    ok(jobsPayload(['succeeded'], 3))
    const h = await fetchSystemHealth()
    expect(h.nas.reachable).toBe(true)
    expect(h.nas.root).toBe('/mnt/nas')
    expect(h.fetchJob?.label).toBe('拉取新录制')
    expect(h.fetchJob?.consecutiveFailures).toBe(0)
    expect(h.openFailures).toBe(3)
  })

  test('nas.reachable=false 仍是 200，是要展示的内容而不是错误', async () => {
    const down = structuredClone(STORAGE) as Record<string, Record<string, unknown>>
    down.nas!.reachable = false
    down.nas!.error = 'ENOENT: /mnt/nas'
    ok(jobsPayload(['succeeded']), down)
    const h = await fetchSystemHealth()
    expect(h.nas.reachable).toBe(false)
    expect(h.nas.error).toBe('ENOENT: /mnt/nas')
  })

  test('拉取任务连续失败的轮数从 recentRuns 推出来', async () => {
    ok(jobsPayload(['failed', 'failed', 'failed', 'succeeded']))
    const h = await fetchSystemHealth()
    expect(h.fetchJob?.consecutiveFailures).toBe(3)
  })

  test('任务清单里没有 fetch_recordings 时 fetchJob 为 null —— 不默认成"正常"', async () => {
    const jobs = jobsPayload(['succeeded']) as { jobs: Array<Record<string, unknown>> }
    jobs.jobs = jobs.jobs.filter((j) => j.name !== 'fetch_recordings')
    ok(jobs as unknown as Record<string, unknown>)
    const h = await fetchSystemHealth()
    expect(h.fetchJob).toBeNull()
  })

  test('后端少一个字段时报出端点名与字段路径，不渲染成空白', async () => {
    const broken = structuredClone(STORAGE) as Record<string, unknown>
    delete (broken.nas as Record<string, unknown>).reachable
    ok(jobsPayload([]), broken)
    const err = (await fetchSystemHealth().catch((e: unknown) => e)) as ApiShapeError
    expect(err).toBeInstanceOf(ApiShapeError)
    expect(err.message).toContain('/api/v1/admin/storage')
    expect(err.message).toContain('nas.reachable')
  })

  test('任一端点挂掉，整体就是"读不到"，不是半个正常', async () => {
    install({
      '/api/v1/admin/storage': { status: 200, body: STORAGE },
      '/api/v1/admin/jobs': { status: 503, body: { error: 'db_down' } },
    })
    await expect(fetchSystemHealth()).rejects.toThrow(/\/api\/v1\/admin\/jobs/)
  })
})
