import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../src/api/client'
import { ApiShapeError } from '../../src/api/validate'
import {
  EXTEND_DEFAULT_DAYS,
  WHY_MISSING,
  extendRetention,
  fetchMeetingHistory,
  fetchTriage,
  getMeeting,
  listMeetings,
} from '../../src/api/admin/meetings'

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

function install(status: number, body: unknown): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

/** 一行会议的最小合法响应，字段名逐字照抄契约（api-contracts.md §6）。 */
const ROW = {
  id: 'm-1|',
  meetingId: 'm-1',
  subMeetingId: '',
  title: '产品周会',
  code: '123-456-789',
  startAt: 1699900000,
  durationSec: 3600,
  host: 'zouyanjian',
  missing: [],
  assets: { ai_minutes: { got: 1, total: 3 } },
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
    fetch: { by: 'rule', text: '拉取规则 #100' },
    archive: { by: 'rule', text: '归档规则 #100' },
    allow: { by: 'rule', text: '权限规则 #100' },
  },
  history: [],
}

function page(rows: unknown[] = [ROW], extra: Record<string, unknown> = {}): unknown {
  return { rows, total: 137, limit: 20, offset: 40, ...extra }
}

describe('api/admin/meetings · 列表', () => {
  test('路径写全，分页与筛选原样进查询串', async () => {
    install(200, page())
    await listMeetings({
      search: '周会',
      triage: 'archiveFailed',
      hasGrant: true,
      hasOverride: false,
      inRetention: true,
      limit: 20,
      offset: 40,
    })
    const url = new URL(calls[0]!.url, 'http://x')
    expect(url.pathname).toBe('/api/v1/admin/meetings')
    expect(url.searchParams.get('search')).toBe('周会')
    expect(url.searchParams.get('triage')).toBe('archiveFailed')
    // 三态布尔要发成字符串 'true' / 'false'——后端认的就是这两个字面量
    expect(url.searchParams.get('hasGrant')).toBe('true')
    expect(url.searchParams.get('hasOverride')).toBe('false')
    expect(url.searchParams.get('inRetention')).toBe('true')
    expect(url.searchParams.get('limit')).toBe('20')
    expect(url.searchParams.get('offset')).toBe('40')
  })

  test('没给的筛选项不出现在 URL 里——「不筛选」不是「筛 false」', async () => {
    install(200, page())
    await listMeetings({ limit: 10, offset: 0 })
    const url = new URL(calls[0]!.url, 'http://x')
    expect(url.searchParams.has('hasGrant')).toBe(false)
    expect(url.searchParams.has('hasOverride')).toBe(false)
    expect(url.searchParams.has('inRetention')).toBe(false)
    expect(url.searchParams.has('triage')).toBe(false)
    expect(url.searchParams.has('search')).toBe(false)
  })

  test('总数与分页回显照原样带出来（表格靠 total 算页数，不靠当页行数）', async () => {
    install(200, page())
    const res = await listMeetings({})
    expect(res.total).toBe(137)
    expect(res.limit).toBe(20)
    expect(res.offset).toBe(40)
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.keep.retentionDays).toBe(30)
    expect(res.rows[0]!.keep.extendedSource).toBe('none')
    expect(res.rows[0]!.meetingId).toBe('m-1')
  })

  test('缺必填字段时抛带端点名与字段路径的错，不是渲染成空白', async () => {
    const broken = { ...ROW } as Record<string, unknown>
    delete broken.nasPath
    install(200, page([broken]))
    await expect(listMeetings({})).rejects.toBeInstanceOf(ApiShapeError)
    await expect(listMeetings({})).rejects.toThrow(/GET \/api\/v1\/admin\/meetings/)
    await expect(listMeetings({})).rejects.toThrow(/rows\[0\]\.nasPath/)
  })

  test('keep 少一个字段时报得出是 keep 里的哪一个', async () => {
    const keep = { ...ROW.keep } as Record<string, unknown>
    delete keep.expiresAt
    install(200, page([{ ...ROW, keep }]))
    await expect(listMeetings({})).rejects.toThrow(/rows\[0\]\.keep\.expiresAt/)
  })

  test('400 的错误码带进 message —— 每个错误不能长得一样', async () => {
    install(400, { error: 'invalid_triage', detail: 'triage 只能是…' })
    await expect(listMeetings({ triage: 'archiveFailed' })).rejects.toBeInstanceOf(ApiError)
    await expect(listMeetings({})).rejects.toThrow(/invalid_triage/)
  })
})

describe('api/admin/meetings · 不许静默放行', () => {
  test('认不出的状态原样带出来，不折成 done —— 由界面显示「未知」', async () => {
    install(200, page([{ ...ROW, fetch: 'teleported', archive: 'done', allow: 'allow' }]))
    const res = await listMeetings({})
    expect(res.rows[0]!.fetch).toBe('teleported')
  })

  test('认不出的 why.by 原样带出来，不折成 rule', async () => {
    install(200, page([{ ...ROW, why: { ...ROW.why, allow: { by: 'wat', text: '???' } } }]))
    const res = await listMeetings({})
    expect(res.rows[0]!.why.allow.by).toBe('wat')
  })

  test('判定理由整块缺失时给出显式的「缺失」标记，而不是空串糊过去', async () => {
    const noWhy = { ...ROW } as Record<string, unknown>
    delete noWhy.why
    install(200, page([noWhy]))
    const res = await listMeetings({})
    // 三段都要落到同一个显式取值上，界面据此显示「理由缺失」
    expect(res.rows[0]!.why.fetch).toEqual(WHY_MISSING)
    expect(res.rows[0]!.why.archive).toEqual(WHY_MISSING)
    expect(res.rows[0]!.why.allow).toEqual(WHY_MISSING)
  })

  test('某一段理由坏了，另外两段照常读出来', async () => {
    install(200, page([{ ...ROW, why: { ...ROW.why, archive: { by: 'rule' } } }]))
    const res = await listMeetings({})
    expect(res.rows[0]!.why.archive).toEqual(WHY_MISSING)
    expect(res.rows[0]!.why.fetch.text).toBe('拉取规则 #100')
  })
})

describe('api/admin/meetings · 分诊五格', () => {
  test('走自己的端点，五个计数全部必填', async () => {
    install(200, { archiveFailed: 2, expiringIn7d: 1, awaitingGrant: 4, inProgress: 3, nasOnly: 5 })
    const t = await fetchTriage()
    expect(new URL(calls[0]!.url, 'http://x').pathname).toBe('/api/v1/admin/meetings/triage')
    expect(t).toEqual({ archiveFailed: 2, expiringIn7d: 1, awaitingGrant: 4, inProgress: 3, nasOnly: 5 })
  })

  test('少一格就抛——0 与「读不到」不能糊成同一个数字', async () => {
    install(200, { archiveFailed: 2, expiringIn7d: 1, awaitingGrant: 4, inProgress: 3 })
    await expect(fetchTriage()).rejects.toThrow(/nasOnly/)
  })
})

describe('api/admin/meetings · 单场详情', () => {
  test('meetingId 过 encodeURIComponent 再拼进路径段', async () => {
    install(200, { ...ROW, history: [{ at: 1699908000, text: '取走了 AI 纪要' }] })
    await getMeeting('m-1,s-7')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1%2Cs-7')
  })

  test('404 抛 ApiError（带 meeting_not_found），不是返回 null 让界面显示空壳', async () => {
    install(404, { error: 'meeting_not_found' })
    await expect(getMeeting('m-404')).rejects.toThrow(/meeting_not_found/)
  })
})

describe('api/admin/meetings · 延长保留窗口', () => {
  test('默认 30 天，且这个默认值是常量不是散在页面里的字面量', async () => {
    install(200, {
      meetingId: 'm-1',
      subMeetingId: '',
      addedDays: 30,
      extendedDays: 60,
      archivedAt: 1698000000,
      expiresAt: 1703000000,
    })
    const res = await extendRetention({ meetingId: 'm-1' })
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/extend')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ days: EXTEND_DEFAULT_DAYS })
    // 新的到期时间由后端算好下发，前端不再自己加 30 天
    expect(res.expiresAt).toBe(1703000000)
    expect(res.addedDays).toBe(30)
  })

  test('周期性会议的场次走请求体的 subMeetingId（extend 没有 ?sub=）', async () => {
    install(200, {
      meetingId: 'm-1',
      subMeetingId: 's-7',
      addedDays: 30,
      extendedDays: 30,
      archivedAt: 1698000000,
      expiresAt: 1703000000,
    })
    await extendRetention({ meetingId: 'm-1', subMeetingId: 's-7' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ days: 30, subMeetingId: 's-7' })
  })

  test('409 already_purged 是一句要说给人听的话，错误码要能被页面认出来', async () => {
    install(409, {
      error: 'already_purged',
      meetingId: 'm-1',
      subMeetingId: '',
      purgedAt: 1700000000,
      message: '本地文件已被清理',
    })
    await expect(extendRetention({ meetingId: 'm-1' })).rejects.toMatchObject({
      status: 409,
      body: { error: 'already_purged' },
    })
  })
})

describe('api/admin/meetings · 操作历史', () => {
  const HISTORY = {
    meeting: { id: 'm-1', title: '周会', code: '123-456', startAt: 1699900000, source: 'meetings' },
    rows: [
      {
        id: 1,
        at: 1699908000,
        actor: { kind: 'prog', type: 'service_account', id: 'kb-indexer' },
        action: 'issue_download_url',
        actionLabel: '签发下载链接',
        object: { id: 'm-1', idKind: 'meeting', meetingId: 'm-1', title: '周会', code: '123-456' },
        asset: { id: 'rec-1:f-1:ai_minutes:0', type: 'ai_minutes' },
        detail: '取走了 AI 纪要',
        result: { decision: 'allow', kind: 'allow', reason: null },
        matchedRuleId: null,
        clientKind: 'console',
        text: 'kb-indexer（service_account） · 签发下载链接（ai_minutes） · 准许',
      },
    ],
    window: { since: 1699900000, sinceSource: 'meetings', text: null },
  }

  test('读出现成的那一句 text，并带上判定结果供着色用', async () => {
    install(200, HISTORY)
    const h = await fetchMeetingHistory('m-1')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/history')
    expect(h.rows[0]!.text).toContain('签发下载链接')
    expect(h.rows[0]!.decision).toBe('allow')
    expect(h.rows[0]!.at).toBe(1699908000)
  })

  test('meeting 为 null 是 200 的正常结果——「记录还在不在」正是这条端点要回答的', async () => {
    install(200, { ...HISTORY, meeting: null, rows: [] })
    const h = await fetchMeetingHistory('m-1')
    expect(h.meeting).toBeNull()
    expect(h.rows).toEqual([])
  })

  test('window.text 有话说时带出来——「历史是空的」与「被下界截掉了」不是一回事', async () => {
    install(200, { ...HISTORY, window: { since: 1699900000, sinceSource: 'meetings', text: '只列出会议开始之后的记录' } })
    const h = await fetchMeetingHistory('m-1')
    expect(h.window.text).toBe('只列出会议开始之后的记录')
  })

  test('limit 进查询串', async () => {
    install(200, HISTORY)
    await fetchMeetingHistory('m-1', 50)
    expect(new URL(calls[0]!.url, 'http://x').searchParams.get('limit')).toBe('50')
  })
})
