import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../src/api/client'
import { ApiShapeError } from '../../src/api/validate'
import {
  fetchFetchableMeetings,
  fetchStorage,
  previewCleanup,
  runCleanup,
  setCleanupPaused,
  setRetentionDays,
} from '../../src/api/admin/storage'

/**
 * 归档存储页的域文件（F5b）。契约见 `<SCRATCH>/api-contracts.md` 第 3 节，
 * 权威是 `src/http/handlers/console/storage.ts`。
 *
 * 这一组测试盯着三件最容易出错的事：
 *   1. `nas.reachable === false` 仍是 200——不可达是要展示的内容，不是一次错误。
 *   2. `failedMeetings === null` 与 `0` 是两件事，解析层不许把 null 折成 0。
 *   3. 「暂停到期清理」回显的是**库里的真值**，不是把请求体抄回来。
 */

function storagePayload(over: {
  nas?: Record<string, unknown>
  retention?: Record<string, unknown>
} = {}): unknown {
  return {
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
      failedMeetingsNote: '归档失败项尚未落库：…',
      ...over.nas,
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
      ...over.retention,
    },
  }
}

interface Call {
  url: string
  method: string
  body: unknown
}

const calls: Call[] = []

function install(
  handler: (url: string, method: string, body: unknown) => { status: number; body: unknown },
): void {
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      calls.push({ url, method, body })
      const res = handler(url, method, body)
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

function answer(routes: Record<string, { status: number; body: unknown }>): void {
  install((url) => {
    const hit = routes[url]
    if (!hit) throw new Error(`storage.test.ts: 未预期的 fetch ${url}`)
    return hit
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchStorage · GET /api/v1/admin/storage', () => {
  test('两块字段逐字取出，路径写全', async () => {
    answer({ '/api/v1/admin/storage': { status: 200, body: storagePayload() } })
    const s = await fetchStorage()

    expect(calls[0]?.url).toBe('/api/v1/admin/storage')
    expect(s.nas.root).toBe('/mnt/nas')
    expect(s.nas.reachable).toBe(true)
    expect(s.nas.checkedAt).toBe(1700000000)
    expect(s.nas.totalBytes).toBe(4000000000000)
    expect(s.nas.usedByUsBytes).toBe(842000000000)
    expect(s.nas.usedByOthersBytes).toBe(1758000000000)
    expect(s.nas.archivedMeetings).toBe(71)
    expect(s.nas.pendingMeetings).toBe(2)
    expect(s.retention.defaultDays).toBe(30)
    expect(s.retention.defaultDaysSource).toBe('fallback')
    expect(s.retention.cleanupPaused).toBe(false)
    expect(s.retention.liveMeetings).toBe(10)
    expect(s.retention.grantedMeetings).toBe(8)
    expect(s.retention.expiringIn7dMeetings).toBe(1)
    expect(s.retention.expiredMeetings).toBe(0)
    expect(s.retention.localBytes).toBe(900000000)
  })

  test('failedMeetings 为 null 时原样留着 null，不折成 0', async () => {
    // 0 的意思是"确实没有归档失败的会议"，null 的意思是"这个数现在查不到"。
    // 折成 0 就是把一个缺口伪装成一次判定。
    answer({ '/api/v1/admin/storage': { status: 200, body: storagePayload() } })
    const s = await fetchStorage()
    expect(s.nas.failedMeetings).toBeNull()
    expect(s.nas.failedMeetingsNote).toContain('尚未落库')
  })

  test('A8 之后 failedMeetings 变成数字、note 消失，解析层照样收得下', async () => {
    answer({
      '/api/v1/admin/storage': {
        status: 200,
        body: storagePayload({ nas: { failedMeetings: 3, failedMeetingsNote: undefined } }),
      },
    })
    const s = await fetchStorage()
    expect(s.nas.failedMeetings).toBe(3)
    expect(s.nas.failedMeetingsNote).toBeNull()
  })

  test('nas.reachable=false 仍是 200，不当成请求失败', async () => {
    answer({
      '/api/v1/admin/storage': {
        status: 200,
        body: storagePayload({
          nas: {
            reachable: false,
            error: 'ENOENT: /mnt/nas',
            totalBytes: null,
            availableBytes: null,
            usedByOthersBytes: null,
            latencyMs: 30000,
          },
        }),
      },
    })
    const s = await fetchStorage()
    expect(s.nas.reachable).toBe(false)
    expect(s.nas.error).toBe('ENOENT: /mnt/nas')
    expect(s.nas.totalBytes).toBeNull()
    expect(s.nas.usedByOthersBytes).toBeNull()
  })

  test('nasRoot 未配置时后端下发 null，不当成缺字段', async () => {
    // 装配处的 `StorageDeps.nasRoot` 是 `string | null`（未配 MDE_NAS_ROOT 时为 null）。
    answer({
      '/api/v1/admin/storage': { status: 200, body: storagePayload({ nas: { root: null } }) },
    })
    const s = await fetchStorage()
    expect(s.nas.root).toBeNull()
  })

  test('defaultDaysSource=invalid 时 defaultDays 是 null，脏值原样带出来', async () => {
    answer({
      '/api/v1/admin/storage': {
        status: 200,
        body: storagePayload({
          retention: { defaultDays: null, defaultDaysSource: 'invalid', defaultDaysRaw: 'abc' },
        }),
      },
    })
    const s = await fetchStorage()
    expect(s.retention.defaultDays).toBeNull()
    expect(s.retention.defaultDaysSource).toBe('invalid')
    expect(s.retention.defaultDaysRaw).toBe('abc')
  })

  test('少一个必填字段时报出端点名与字段路径', async () => {
    const broken = storagePayload() as { nas: Record<string, unknown> }
    delete broken.nas.reachable
    answer({ '/api/v1/admin/storage': { status: 200, body: broken } })
    const err = (await fetchStorage().catch((e: unknown) => e)) as ApiShapeError
    expect(err).toBeInstanceOf(ApiShapeError)
    expect(err.message).toContain('/api/v1/admin/storage')
    expect(err.message).toContain('nas.reachable')
  })

  test('后端整条挂掉时抛 ApiError，带端点名', async () => {
    answer({ '/api/v1/admin/storage': { status: 503, body: { error: 'db_down' } } })
    await expect(fetchStorage()).rejects.toThrow(/\/api\/v1\/admin\/storage/)
  })
})

describe('setRetentionDays · POST /storage/retention-days', () => {
  test('请求体是 { days }，响应带新旧两个值', async () => {
    answer({
      '/api/v1/admin/storage/retention-days': {
        status: 200,
        body: { defaultDays: 45, previousDefaultDays: 30 },
      },
    })
    const r = await setRetentionDays(45)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ days: 45 })
    expect(r.defaultDays).toBe(45)
    expect(r.previousDefaultDays).toBe(30)
  })

  test('旧值非法时 previousDefaultDays 是 null——"从多少改的"答不出来就说答不出来', async () => {
    answer({
      '/api/v1/admin/storage/retention-days': {
        status: 200,
        body: { defaultDays: 45, previousDefaultDays: null },
      },
    })
    const r = await setRetentionDays(45)
    expect(r.previousDefaultDays).toBeNull()
  })

  test('400 invalid_days 的区间原样进 ApiError.body，界面才说得出 1..365', async () => {
    answer({
      '/api/v1/admin/storage/retention-days': {
        status: 400,
        body: { error: 'invalid_days', min: 1, max: 365 },
      },
    })
    const err = (await setRetentionDays(0).catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(400)
    expect(err.body).toMatchObject({ error: 'invalid_days', min: 1, max: 365 })
  })
})

describe('setCleanupPaused · POST /storage/cleanup-pause', () => {
  test('回显的是库里的真值，不是把请求体抄回来', async () => {
    // 这条开关最不能出的错就是"页面说已恢复、实际还停着"。后端是写后重读，
    // 前端就必须照它的回显更新，不能自作主张地相信自己发出去的那个值。
    answer({
      '/api/v1/admin/storage/cleanup-pause': { status: 200, body: { cleanupPaused: true } },
    })
    const paused = await setCleanupPaused(false)
    expect(calls[0]?.body).toEqual({ paused: false })
    expect(paused).toBe(true)
  })

  test('暂停成功时回 true', async () => {
    answer({
      '/api/v1/admin/storage/cleanup-pause': { status: 200, body: { cleanupPaused: true } },
    })
    await expect(setCleanupPaused(true)).resolves.toBe(true)
    expect(calls[0]?.body).toEqual({ paused: true })
  })
})

describe('cleanup-now · 预览与真删是同一条端点的两种调用', () => {
  test('预览不带 confirm，回 dryRun:true 与候选清单', async () => {
    answer({
      '/api/v1/admin/storage/cleanup-now': {
        status: 200,
        body: {
          dryRun: true,
          cleanupPaused: false,
          items: [{ meetingId: 'm-1', subMeetingId: '', assetCount: 3, localBytes: 120000000 }],
          totalBytes: 120000000,
        },
      },
    })
    const p = await previewCleanup()
    expect(calls[0]?.body).toBeUndefined()
    expect(p.dryRun).toBe(true)
    expect(p.cleanupPaused).toBe(false)
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ meetingId: 'm-1', assetCount: 3, localBytes: 120000000 })
    expect(p.totalBytes).toBe(120000000)
  })

  test('真删必须显式 confirm:true，三个结果桶各自取出来', async () => {
    answer({
      '/api/v1/admin/storage/cleanup-now': {
        status: 200,
        body: {
          dryRun: false,
          paused: false,
          purged: [{ meetingId: 'm-1', subMeetingId: '', assetCount: 3, localBytes: 120000000 }],
          verificationFailed: [{ meetingId: 'm-2', subMeetingId: 's-1', reason: '哈希对不上' }],
          failed: [{ meetingId: 'm-3', subMeetingId: '', reason: 'EACCES' }],
        },
      },
    })
    const r = await runCleanup()
    expect(calls[0]?.body).toEqual({ confirm: true })
    expect(r.dryRun).toBe(false)
    expect(r.purged).toHaveLength(1)
    expect(r.verificationFailed[0]).toMatchObject({ meetingId: 'm-2', reason: '哈希对不上' })
    expect(r.failed[0]).toMatchObject({ meetingId: 'm-3', reason: 'EACCES' })
  })

  test('被暂停时不是错误：200 + paused:true + 空的 purged', async () => {
    answer({
      '/api/v1/admin/storage/cleanup-now': {
        status: 200,
        body: { dryRun: false, paused: true, purged: [], verificationFailed: [], failed: [] },
      },
    })
    const r = await runCleanup()
    expect(r.paused).toBe(true)
    expect(r.purged).toHaveLength(0)
  })

  test('503 未挂载本地归档区时把后端那句话带出来——不是"没有可清理的"', async () => {
    answer({
      '/api/v1/admin/storage/cleanup-now': {
        status: 503,
        body: {
          error: 'local_archive_root_not_configured',
          message: '本进程没有挂载本地归档区（MDE_ARCHIVE_ROOT 未配置）…',
        },
      },
    })
    const err = (await previewCleanup().catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(503)
    expect((err.body as { message: string }).message).toContain('MDE_ARCHIVE_ROOT')
  })
})

/* ── 导出可采集清单（spec §4.9 三个动作之一） ───────────────────── */

function meeting(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1|',
    meetingId: 'm-1',
    subMeetingId: '',
    title: '产品周会',
    code: '123-456-789',
    startAt: 1699900000,
    durationSec: 3600,
    host: 'zouyanjian',
    missing: [],
    assets: {},
    unknownAssetTypes: [],
    fetch: 'done',
    archive: 'done',
    grants: ['kb-indexer'],
    hand: [],
    keep: {
      archivedAt: 1699950000,
      expiresAt: 1702542000,
      extended: 0,
      extendedSource: 'none',
      extendedDays: 0,
      retentionDays: 30,
      filesGone: false,
    },
    nasPath: '/nas/meetings/2023/11/88112340-产品周会/',
    sizeBytes: 120000000,
    allow: 'allow',
    why: {
      fetch: { by: 'rule', text: 'x' },
      archive: { by: 'rule', text: 'y' },
      allow: { by: 'rule', text: '标题含「周会」，规则 #100' },
    },
    history: [],
    ...over,
  }
}

describe('fetchFetchableMeetings · 导出清单的取数', () => {
  test('只问保留期内的会议，按 allow 过滤，理由一并带出来', async () => {
    install((url) => {
      expect(url).toContain('/api/v1/admin/meetings?')
      expect(url).toContain('inRetention=true')
      return {
        status: 200,
        body: {
          rows: [meeting(), meeting({ id: 'm-2|', meetingId: 'm-2', allow: 'deny' })],
          total: 2,
          limit: 500,
          offset: 0,
        },
      }
    })
    const list = await fetchFetchableMeetings()
    expect(list.scanned).toBe(2)
    expect(list.rows).toHaveLength(1)
    expect(list.rows[0]).toMatchObject({
      meetingId: 'm-1',
      code: '123-456-789',
      grants: ['kb-indexer'],
      nasPath: '/nas/meetings/2023/11/88112340-产品周会/',
      expiresAt: 1702542000,
      allowWhy: '标题含「周会」，规则 #100',
    })
    expect(list.truncated).toBe(false)
  })

  test('翻页翻到 total 为止，不是只拿第一页就当成全部', async () => {
    let n = 0
    install((url) => {
      n += 1
      const offset = new URL(url, 'http://x').searchParams.get('offset')
      return {
        status: 200,
        body: {
          rows: [meeting({ id: `m-${n}|`, meetingId: `m-${n}` })],
          total: 3,
          limit: 1,
          offset: Number(offset ?? 0),
        },
      }
    })
    const list = await fetchFetchableMeetings({ pageSize: 1 })
    expect(n).toBe(3)
    expect(list.rows.map((r) => r.meetingId)).toEqual(['m-1', 'm-2', 'm-3'])
    expect(list.total).toBe(3)
    expect(list.truncated).toBe(false)
  })

  test('页数封顶时如实报 truncated，不悄悄导出半份清单', async () => {
    install(() => ({
      status: 200,
      body: { rows: [meeting()], total: 99, limit: 1, offset: 0 },
    }))
    const list = await fetchFetchableMeetings({ pageSize: 1, maxPages: 2 })
    expect(list.truncated).toBe(true)
    expect(list.scanned).toBe(2)
    expect(list.total).toBe(99)
  })

  test('后端某一页少字段时报出端点与字段路径', async () => {
    const bad = meeting()
    delete bad.nasPath
    install(() => ({ status: 200, body: { rows: [bad], total: 1, limit: 500, offset: 0 } }))
    const err = (await fetchFetchableMeetings().catch((e: unknown) => e)) as ApiShapeError
    expect(err).toBeInstanceOf(ApiShapeError)
    expect(err.message).toContain('/api/v1/admin/meetings')
    expect(err.message).toContain('rows[0].nasPath')
  })
})
