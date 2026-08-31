import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../src/api/client'
import { ApiShapeError } from '../../src/api/validate'
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_FILTERABLE_ACTOR_KINDS,
  AUDIT_MAX_LIMIT,
  listAudit,
  type AuditRow,
} from '../../src/api/admin/audit'

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

function query(): URLSearchParams {
  return new URL(calls[0]!.url, 'http://x').searchParams
}

afterEach(() => vi.unstubAllGlobals())

/** 一条最完整的行，逐字照 `<SCRATCH>/api-contracts.md` §4 的样例。 */
const FULL_ROW = {
  id: 123,
  at: 1_700_000_000,
  actor: { kind: 'prog', type: 'service_account', id: 'svc-1' },
  action: 'issue_download_url',
  actionLabel: '签发下载链接',
  object: {
    id: 'm-1',
    idKind: 'meeting',
    meetingId: 'm-1',
    title: '产品周会',
    code: '123-456',
  },
  asset: { id: 'rec-1:f-1:video:0', type: 'video' },
  detail: '取走了 AI 纪要\n{"rule":100}',
  result: { decision: 'allow', kind: 'allow', reason: null },
  matchedRuleId: 100,
  clientKind: 'console',
}

/** 迁移 008 之前的历史记录：`detail` 为 NULL，对象也补不齐标题。 */
const OLD_ROW = {
  id: 7,
  at: 1_690_000_000,
  actor: { kind: 'unknown', type: '一个没见过的 actor_type', id: 'who' },
  action: 'purge_expired',
  actionLabel: null,
  object: { id: 'm-404', idKind: 'unknown', meetingId: null, title: null, code: null },
  asset: null,
  detail: null,
  result: { decision: 'weird', kind: 'unknown', reason: '审计记录里的结果值无法识别：weird' },
  matchedRuleId: null,
  clientKind: null,
}

const WINDOW = {
  from: 1_699_395_200,
  to: null,
  isDefault: true,
  days: 7,
  text: '未指定时间范围，默认只查最近 7 天的记录；……',
}

function page(rows: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    rows,
    total: rows.length,
    limit: 50,
    offset: 0,
    window: WINDOW,
    // 全部登记过时是 `[]`，不是 null（阶段 5 · A9）
    unlabeledActions: [],
    ...extra,
  }
}

const UNLABELED_HINT =
  '这个动作在后端没有登记中文标签（src/audit/actions.ts 的 AUDIT_ACTION_LABELS 里没有这一行），' +
  '界面上显示的是 audit_log 里的原值。'

describe('listAudit —— 请求的拼法', () => {
  test('端点是全路径；什么都不传时一个查询参数都不带', async () => {
    install(200, page([]))
    await listAudit()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/v1/admin/audit')
    expect(calls[0]!.init.credentials).toBe('include')
  })

  test('六个筛选维度逐个落到查询串上', async () => {
    install(200, page([]))
    await listAudit({
      from: 1_700_000_000,
      to: 1_700_086_400,
      actorId: 'kb-indexer',
      actorKind: ['prog', 'sys'],
      action: ['issue_download_url', 'login'],
      decision: 'deny',
      limit: 20,
      offset: 40,
    })
    const q = query()
    expect(q.get('from')).toBe('1700000000')
    expect(q.get('to')).toBe('1700086400')
    expect(q.get('actorId')).toBe('kb-indexer')
    // 多值参数用重复键，不是逗号串——后端两种都收，重复键不会被 `,` 的转义咬到
    expect(q.getAll('actorKind')).toEqual(['prog', 'sys'])
    expect(q.getAll('action')).toEqual(['issue_download_url', 'login'])
    expect(q.get('decision')).toBe('deny')
    expect(q.get('limit')).toBe('20')
    expect(q.get('offset')).toBe('40')
  })

  test('空数组不发出去 —— 后端把空集合当客户端错误（400 empty_filter）', async () => {
    install(200, page([]))
    await listAudit({ actorKind: [], action: [] })
    expect(calls[0]!.url).toBe('/api/v1/admin/audit')
  })

  test('空白的操作者当作没填，不发一个空串上去', async () => {
    install(200, page([]))
    await listAudit({ actorId: '   ' })
    expect(query().has('actorId')).toBe(false)
  })

  test('from = 0 是一次真实取值（「全部时间」），必须发出去', async () => {
    install(200, page([]))
    await listAudit({ from: 0 })
    expect(query().get('from')).toBe('0')
  })

  test('offset = 0 也发出去 —— 翻回第一页与「没翻过页」是同一个请求，不能省成两种', async () => {
    install(200, page([]))
    await listAudit({ offset: 0 })
    expect(query().get('offset')).toBe('0')
  })

  test('上限与默认值照抄后端常量，不在页面里各写一个', () => {
    expect(AUDIT_MAX_LIMIT).toBe(200)
    expect(AUDIT_DEFAULT_LIMIT).toBe(50)
    // `unknown` 不在其中：它是补集，后端 `IN (...)` 表达不出来，传了会 400
    expect([...AUDIT_FILTERABLE_ACTOR_KINDS]).toEqual(['prog', 'person', 'sys'])
  })
})

describe('listAudit —— 响应的读法', () => {
  test('完整的一行逐字段读出来', async () => {
    install(200, page([FULL_ROW]))
    const res = await listAudit()
    const row = res.rows[0]!
    expect(row).toEqual<AuditRow>({
      id: 123,
      at: 1_700_000_000,
      // `name` 只有管理员账号解析得出；采集程序不是账号，恒为 null
      actor: { kind: 'prog', type: 'service_account', id: 'svc-1', name: null },
      action: 'issue_download_url',
      actionLabel: '签发下载链接',
      object: {
        id: 'm-1',
        idKind: 'meeting',
        meetingId: 'm-1',
        title: '产品周会',
        code: '123-456',
      },
      asset: { id: 'rec-1:f-1:video:0', type: 'video' },
      detail: '取走了 AI 纪要\n{"rule":100}',
      result: { decision: 'allow', kind: 'allow', reason: null },
      matchedRuleId: 100,
      clientKind: 'console',
    })
  })

  test('null 一律保留成 null，不填默认值', async () => {
    install(200, page([OLD_ROW]))
    const row = (await listAudit()).rows[0]!
    expect(row.detail).toBeNull()
    expect(row.asset).toBeNull()
    expect(row.actionLabel).toBeNull()
    expect(row.matchedRuleId).toBeNull()
    expect(row.clientKind).toBeNull()
    expect(row.object).not.toBeNull()
    expect(row.object!.title).toBeNull()
    expect(row.object!.meetingId).toBeNull()
  })

  test('认不出的 actor.kind / result.kind 原样带出来，不折进已知的几种', async () => {
    install(200, page([OLD_ROW]))
    const row = (await listAudit()).rows[0]!
    expect(row.actor.kind).toBe('unknown')
    expect(row.actor.type).toBe('一个没见过的 actor_type')
    expect(row.result.decision).toBe('weird')
    expect(row.result.kind).toBe('unknown')
  })

  test('object 为 null（这次操作不针对某一场会议）', async () => {
    install(200, page([{ ...FULL_ROW, object: null }]))
    expect((await listAudit()).rows[0]!.object).toBeNull()
  })

  test('分页与时间窗口原样读出来', async () => {
    install(200, page([FULL_ROW], { total: 137, limit: 20, offset: 40 }))
    const res = await listAudit()
    expect(res.total).toBe(137)
    expect(res.limit).toBe(20)
    expect(res.offset).toBe(40)
    expect(res.window).toEqual(WINDOW)
  })

  test('两条长得一模一样的记录就是发生过两次 —— 不去重、不合并、不换序', async () => {
    const a = { ...FULL_ROW, id: 1 }
    const b = { ...FULL_ROW, id: 2 }
    install(200, page([a, b, { ...FULL_ROW, id: 3 }]))
    const res = await listAudit()
    expect(res.rows.map((r) => r.id)).toEqual([1, 2, 3])
    // 除了 id 之外逐字段相同，仍然是三条独立的记录
    expect({ ...res.rows[0]!, id: 0 }).toEqual({ ...res.rows[1]!, id: 0 })
  })
})

describe('listAudit —— 对不上契约时报得出是哪一个字段', () => {
  async function shapeError(body: unknown): Promise<ApiShapeError> {
    install(200, body)
    try {
      await listAudit()
    } catch (e) {
      expect(e).toBeInstanceOf(ApiShapeError)
      return e as ApiShapeError
    }
    throw new Error('本该抛 ApiShapeError')
  }

  test('缺 rows', async () => {
    const e = await shapeError({ total: 0, limit: 50, offset: 0, window: WINDOW })
    expect(e.message).toContain('GET /api/v1/admin/audit')
    expect(e.message).toContain('rows')
  })

  test('某一行缺 at —— 报得出是第几行的哪个字段', async () => {
    const { at: _at, ...noAt } = FULL_ROW
    const e = await shapeError(page([FULL_ROW, noAt]))
    expect(e.message).toContain('rows[1].at')
  })

  test('时间被写成字符串也算对不上（unix 秒是 number）', async () => {
    const e = await shapeError(page([{ ...FULL_ROW, at: '1700000000' }]))
    expect(e.message).toContain('rows[0].at')
    expect(e.message).toContain('number')
  })

  test('缺 window.isDefault —— 默认窗口看不见正是审计最怕的事', async () => {
    const { isDefault: _d, ...noFlag } = WINDOW
    const e = await shapeError(page([], { window: noFlag }))
    expect(e.message).toContain('window.isDefault')
  })

  test('缺 result.kind', async () => {
    const e = await shapeError(page([{ ...FULL_ROW, result: { decision: 'allow', reason: null } }]))
    expect(e.message).toContain('rows[0].result.kind')
  })

  test('缺 actor.id', async () => {
    const e = await shapeError(page([{ ...FULL_ROW, actor: { kind: 'prog', type: 'x' } }]))
    expect(e.message).toContain('rows[0].actor.id')
  })

  test('object 少一个字段（不是整块为 null）', async () => {
    const e = await shapeError(page([{ ...FULL_ROW, object: { id: 'm-1', idKind: 'meeting' } }]))
    expect(e.message).toContain('rows[0].object.meetingId')
  })
})

describe('listAudit —— unlabeledActions（阶段 5 · A9）', () => {
  test('这一页里没登记中文名的动作逐条读出来，带次数与那句人话', async () => {
    install(
      200,
      page([OLD_ROW], {
        unlabeledActions: [{ action: 'purge_expired', count: 2, hint: UNLABELED_HINT }],
      }),
    )
    const res = await listAudit()
    expect(res.unlabeledActions).toEqual([
      { action: 'purge_expired', count: 2, hint: UNLABELED_HINT },
    ])
    // 行里的 actionLabel 仍然是 null——后端绝不回退成 snake_case 原值
    expect(res.rows[0]!.actionLabel).toBeNull()
    expect(res.rows[0]!.action).toBe('purge_expired')
  })

  test('全部登记过时是空数组', async () => {
    install(200, page([FULL_ROW]))
    expect((await listAudit()).unlabeledActions).toEqual([])
  })

  test('缺这个键就报形状错——「都登记过了」与「根本没算」不能长得一样', async () => {
    const { unlabeledActions: _u, ...body } = page([FULL_ROW]) as Record<string, unknown>
    install(200, body)
    const err = await listAudit().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiShapeError)
    expect((err as ApiShapeError).message).toContain('unlabeledActions')
  })

  test('少一项 count 也报得出是第几项', async () => {
    install(200, page([OLD_ROW], { unlabeledActions: [{ action: 'x', hint: 'y' }] }))
    const err = await listAudit().catch((e: unknown) => e)
    expect((err as ApiShapeError).message).toContain('unlabeledActions[0].count')
  })
})

describe('listAudit —— 后端的 400 原样带上来', () => {
  test('错误码进 message，响应体进 body', async () => {
    install(400, { error: 'invalid_time_range', hint: 'from 必须小于 to' })
    await expect(listAudit({ from: 2, to: 1 })).rejects.toMatchObject({
      status: 400,
      endpoint: 'GET /api/v1/admin/audit',
    })
    install(400, { error: 'limit_too_large', max: 200 })
    const err = await listAudit({ limit: 500 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toContain('limit_too_large')
    expect((err as ApiError).body).toEqual({ error: 'limit_too_large', max: 200 })
  })
})
