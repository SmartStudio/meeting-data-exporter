import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { render, renderAsRole } from './helpers/session'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { SystemStateProvider } from '../src/app/SystemStatus'
import MeetingsPage from '../src/pages/Meetings'
import { emptyKind } from '../src/pages/Meetings/MeetingTable'
import { TRIAGE_DEFS } from '../src/pages/Meetings/TriageBar'
import {
  allowView,
  dotState,
  extendedText,
  grantCellKind,
  whyLabel,
  whyTone,
  WHY_MISSING_LABEL,
} from '../src/pages/Meetings/display'
import { batchSummary, failureOf, tally } from '../src/pages/Meetings/writes'
import { isActivationTarget, isTypingTarget, resolveMeetingKey } from '../src/lib/keys'

/* ══════════════════════════════════════════════════════════════════
   一台答 admin 端点的假网关
   ══════════════════════════════════════════════════════════════════ */

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

let calls: Call[] = []
/** 端点 → 响应。键是 `METHOD /path`（路径里的 :id 用真值），值可以是函数。 */
type Reply = { status: number; body: unknown }
let handler: (call: Call) => Reply | undefined

function lastQuery(path: string): URLSearchParams | undefined {
  return [...calls].reverse().find((c) => c.path === path)?.query
}

function callsTo(method: string, path: string): Call[] {
  return calls.filter((c) => c.method === method && c.path === path)
}

function installFetch(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(String(input), 'http://console.test')
      const method = (init.method ?? 'GET').toUpperCase()
      const call: Call = {
        method,
        path: url.pathname,
        query: url.searchParams,
        body: typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined,
      }
      calls.push(call)
      const reply = handler(call) ?? { status: 501, body: { error: 'no_stub', path: call.path } }
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

/* ── 种子 ─────────────────────────────────────────────────────── */

const HOUR = 3600
const DAY = 86400
/** 「现在」用真实时钟——页面已经不再有钉死的 MOCK_NOW，测试跟着它走。 */
const nowSec = (): number => Math.floor(Date.now() / 1000)

function meeting(over: Record<string, unknown> = {}): Record<string, unknown> {
  const archivedAt = nowSec() - 2 * DAY
  return {
    id: 'm1',
    meetingId: 'm1',
    subMeetingId: '',
    title: '产品周会',
    code: '881-123-40',
    startAt: nowSec() - 2 * DAY - HOUR,
    durationSec: 6720,
    host: 'zouyanjian',
    missing: [],
    assets: { video: { got: 1, total: 1 }, ai_minutes: { got: 2, total: 3 } },
    unknownAssetTypes: [],
    fetch: 'done',
    archive: 'done',
    grants: ['kb-indexer'],
    hand: [],
    keep: {
      archivedAt,
      expiresAt: archivedAt + 30 * DAY,
      extended: 0,
      extendedSource: 'none',
      extendedDays: 0,
      retentionDays: 30,
      filesGone: false,
    },
    nasPath: '/nas/meetings/2026/08/88112340-产品周会/',
    sizeBytes: 23907140,
    allow: 'allow',
    why: {
      fetch: { by: 'rule', text: '拉取规则 #100 判定全拉' },
      archive: { by: 'rule', text: '归档规则 #100，已写入 NAS' },
      allow: { by: 'rule', text: '权限规则 #100 准许采集' },
    },
    history: [],
    ...over,
  }
}

const M2 = meeting({ id: 'm2', meetingId: 'm2', title: '技术评审', code: '881-130-05', grants: [] })
const M3 = meeting({
  id: 'm3',
  meetingId: 'm3',
  title: '客户访谈',
  code: '881-140-11',
  archive: 'failed',
  grants: [],
  nasPath: null,
  keep: {
    archivedAt: null,
    expiresAt: null,
    extended: 0,
    extendedSource: 'none',
    extendedDays: 0,
    retentionDays: null,
    filesGone: false,
  },
  why: {
    fetch: { by: 'rule', text: '拉取规则 #100 判定全拉' },
    archive: { by: 'fail', text: '归档失败：NAS 写入被拒' },
    allow: { by: 'wait', text: '尚未归档成功，没有可授权的资产' },
  },
})

const TRIAGE = { archiveFailed: 7, expiringIn7d: 3, awaitingGrant: 4, inProgress: 1, nasOnly: 5 }

const PROGRAMS = [
  { id: 'kb-indexer', name: '知识库索引器', tmUserId: 'tm-1', enabled: true, expiresAt: null, createdAt: 1 },
  { id: 'daily-digest', name: '简报机器人', tmUserId: 'tm-2', enabled: true, expiresAt: null, createdAt: 1 },
]

function emptyHistory(): unknown {
  return { meeting: null, rows: [], window: { since: null, sinceSource: null, text: null } }
}

/** 默认世界：三场会议、五格计数、两个采集程序，写操作一律成功。 */
function defaultHandler(rows: unknown[] = [meeting(), M2, M3]): (c: Call) => Reply | undefined {
  return (c) => {
    if (c.method === 'GET' && c.path === '/api/v1/admin/meetings') {
      const limit = Number(c.query.get('limit') ?? '50')
      const offset = Number(c.query.get('offset') ?? '0')
      return { status: 200, body: { rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset } }
    }
    if (c.method === 'GET' && c.path === '/api/v1/admin/meetings/triage') {
      return { status: 200, body: TRIAGE }
    }
    if (c.method === 'GET' && c.path === '/api/v1/admin/programs') return { status: 200, body: PROGRAMS }
    if (c.method === 'GET' && /\/history$/.test(c.path)) return { status: 200, body: emptyHistory() }
    if (c.method === 'GET' && /\/meetings\/[^/]+$/.test(c.path)) {
      const id = decodeURIComponent(c.path.split('/').pop() ?? '')
      const row = rows.find((r) => (r as { id: string }).id === id)
      return row ? { status: 200, body: row } : { status: 404, body: { error: 'meeting_not_found' } }
    }
    if (c.method === 'POST' && /\/extend$/.test(c.path)) {
      return {
        status: 200,
        body: {
          meetingId: 'm1',
          subMeetingId: '',
          addedDays: 30,
          extendedDays: 30,
          archivedAt: nowSec() - 2 * DAY,
          expiresAt: nowSec() + 58 * DAY,
        },
      }
    }
    if (c.method === 'POST' && /\/grants$/.test(c.path)) {
      return {
        status: 200,
        body: {
          id: 1,
          meetingId: 'm1',
          subMeetingId: '',
          programId: String((c.body as { programId: string }).programId),
          assetTypes: null,
          grantedAt: nowSec(),
          revokedAt: null,
        },
      }
    }
    if (c.method === 'DELETE' && /\/grants\//.test(c.path)) return { status: 200, body: { revoked: true } }
    if (c.method === 'PUT' && /\/override$/.test(c.path)) {
      const b = c.body as { kind: string; effect: string; reason: string }
      return {
        status: 200,
        body: {
          id: 9,
          meetingId: 'm1',
          subMeetingId: '',
          kind: b.kind,
          effect: b.effect,
          assetTypes: null,
          reason: b.reason,
          createdAt: nowSec(),
          revokedAt: null,
        },
      }
    }
    if (c.method === 'DELETE' && /\/override\//.test(c.path)) return { status: 200, body: { revoked: true } }
    return undefined
  }
}

beforeEach(() => {
  installFetch()
  handler = defaultHandler()
})
afterEach(() => vi.unstubAllGlobals())

/* ── 渲染 ─────────────────────────────────────────────────────── */

/**
 * 只挂会议记录页本体（不套 AppShell）——外壳的行为由 `shell.test.tsx` 负责。
 * `/preview/:id` 与 `/rules` 给了真实的目标路由，好断言"点标题真的跳走了"。
 */
function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/meetings', element: <MeetingsPage /> },
      { path: '/preview/:id', element: <h1>内容预览占位</h1> },
      { path: '/rules', element: <h1>自动规则占位</h1> },
      { path: '/jobs', element: <h1>定时任务占位</h1> },
    ],
    { initialEntries: ['/meetings'] },
  )
  return render(
    <SystemStateProvider initialState="ok">
      <RouterProvider router={router} />
    </SystemStateProvider>,
  )
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId('row-m1')).toBeInTheDocument())
}

function css(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf-8')
}

/** 注释里允许出现裸数字（说明为什么收成了令牌），声明里不允许。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** TS 源码去注释。注释里提到 applyWrite（说明它为什么被删）不算它回来了。 */
function stripTs(source: string): string {
  return stripComments(source).replace(/^\s*\/\/.*$/gm, '')
}

/** 浮层是不是真的开着。Overlay 始终挂载，只用 data-state 切——
 *  按文本查得到不等于它开着，这个区别在 jsdom 里必须显式断言。 */
function panel(name: string | RegExp): HTMLElement {
  return screen.getByRole('dialog', { name })
}
function isOpen(el: HTMLElement): boolean {
  return el.getAttribute('data-state') === 'open'
}

/* ══════════════════════════════════════════════════════════════════
   数据来源：真 API
   ══════════════════════════════════════════════════════════════════ */

describe('会议记录页 · 数据全部来自真实端点', () => {
  test('首屏打三条真实请求：列表、分诊、采集程序', async () => {
    renderPage()
    await ready()
    expect(callsTo('GET', '/api/v1/admin/meetings')).toHaveLength(1)
    expect(callsTo('GET', '/api/v1/admin/meetings/triage')).toHaveLength(1)
    expect(callsTo('GET', '/api/v1/admin/programs')).toHaveLength(1)
  })

  test('页面源码里一行 mock 都不 import —— 这一页是 F0 那道门槛关上的地方', () => {
    const files = [
      'src/pages/Meetings/index.tsx',
      'src/pages/Meetings/useMeetings.ts',
      'src/pages/Meetings/MeetingDetail.tsx',
      'src/pages/Meetings/MeetingRow.tsx',
      'src/pages/Meetings/MeetingTable.tsx',
      'src/pages/Meetings/display.ts',
      'src/pages/Meetings/writes.ts',
    ]
    for (const f of files) {
      expect(css(f), `${f} 还在 import mock`).not.toMatch(/from '[^']*api\/mock/)
    }
  })

  test('「今天」是真实时钟，不是钉死的 MOCK_NOW', async () => {
    renderPage()
    await ready()
    // 种子里 m1 归档于 2 天前、窗口 30 天 → 还剩 28 天。这条只有在
    // now = new Date() 时才成立；钉在 2026-08-23 的话它会随真实日期漂移。
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('剩 28 天')
  })
})

describe('分诊条 · 计数走自己的端点（回归）', () => {
  test('五格显示的是 /meetings/triage 的数，不是当页那几行数出来的', async () => {
    renderPage()
    await ready()
    // 当页只有 3 行、其中 1 行归档失败；端点说 7。显示必须是 7。
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('7')
    expect(screen.getByTestId('triage-count-nasonly')).toHaveTextContent('5')
    expect(screen.getByTestId('triage-count-ungranted')).toHaveTextContent('4')
  })

  test('翻页之后五格不变 —— 它统计的是全部会议', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      meeting({ id: `x${i}`, meetingId: `x${i}`, title: `会议 ${i}` }),
    )
    handler = defaultHandler(many)
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('row-x0')).toBeInTheDocument())
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('7')

    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(screen.getByTestId('row-x10')).toBeInTheDocument())
    // 翻页只重取列表，五格照旧是端点给的那一份
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('7')
    expect(lastQuery('/api/v1/admin/meetings')?.get('offset')).toBe('10')
  })

  test('计数端点挂了时显示「？」而不是 0 —— 0 会被读成"没有需要处理的"', async () => {
    const base = defaultHandler()
    handler = (c) =>
      c.path === '/api/v1/admin/meetings/triage' ? { status: 500, body: { error: 'boom' } } : base(c)
    renderPage()
    await ready()
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('？'))
    expect(screen.getByTestId('triage-count-archfail')).not.toHaveTextContent('0')
    expect(screen.getByTestId('triage-archfail')).toBeDisabled()
  })

  test('点一格把 ?triage= 发给服务端，再点取消；一次只能筛一格', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByTestId('triage-archfail'))
    await waitFor(() => expect(lastQuery('/api/v1/admin/meetings')?.get('triage')).toBe('archiveFailed'))

    // 点另一格是"换一格"，不是"求交"——后端的 ?triage= 只收一个取值
    await user.click(screen.getByTestId('triage-nasonly'))
    await waitFor(() => expect(lastQuery('/api/v1/admin/meetings')?.get('triage')).toBe('nasOnly'))
    expect(screen.getByTestId('triage-archfail')).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByTestId('triage-nasonly'))
    await waitFor(() => expect(lastQuery('/api/v1/admin/meetings')?.has('triage')).toBe(false))
  })

  test('分诊格的定义里没有前端的判据 —— 计数与筛选都在服务端', () => {
    for (const def of TRIAGE_DEFS) {
      expect(def).not.toHaveProperty('test')
      expect(typeof def.bucket).toBe('string')
    }
  })
})

describe('筛选与分页 · 全在服务端，前端不偷偷补内存版本', () => {
  test('搜索防抖后进查询串', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.type(screen.getByLabelText('搜索会议'), '周会')
    await waitFor(() => expect(lastQuery('/api/v1/admin/meetings')?.get('search')).toBe('周会'))
  })

  test('三态筛选发的是 true / false，不筛时这个键根本不出现', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    expect(lastQuery('/api/v1/admin/meetings')?.has('hasGrant')).toBe(false)

    await user.click(screen.getByRole('button', { name: '筛选 ▾' }))
    await user.click(screen.getByRole('menuitemradio', { name: '只看已授权给程序的' }))
    await waitFor(() => expect(lastQuery('/api/v1/admin/meetings')?.get('hasGrant')).toBe('true'))

    // 菜单选完不自动收起（三组条件常常要连着改），所以这里不用再点一次触发按钮
    await user.click(screen.getByRole('menuitemradio', { name: '只看还没授权的' }))
    await waitFor(() => expect(lastQuery('/api/v1/admin/meetings')?.get('hasGrant')).toBe('false'))
  })

  test('时间范围筛选没有了 —— 后端没有这个参数，前端不补一个只在第一页成立的', async () => {
    renderPage()
    await ready()
    expect(screen.queryByRole('button', { name: /近 90 天/ })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: '全部时间' })).toBeNull()
    const src = css('src/pages/Meetings/index.tsx')
    // 内存筛选的痕迹：把当前页的行按时间/关键词再筛一遍
    expect(src).not.toMatch(/rows\.filter/)
  })

  test('每页条数改变时回到第 1 页并带上新的 limit', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.selectOptions(screen.getByLabelText('每页条数'), '20')
    await waitFor(() => expect(lastQuery('/api/v1/admin/meetings')?.get('limit')).toBe('20'))
    expect(lastQuery('/api/v1/admin/meetings')?.get('offset')).toBe('0')
  })

  test('总数来自后端的 total，不是当页行数', async () => {
    const many = Array.from({ length: 12 }, (_, i) => meeting({ id: `x${i}`, meetingId: `x${i}` }))
    handler = defaultHandler(many)
    renderPage()
    await waitFor(() => expect(screen.getByTestId('row-x0')).toBeInTheDocument())
    expect(screen.getByText(/共 12/)).toBeInTheDocument()
  })
})

/* ══════════════════════════════════════════════════════════════════
   三态与不许静默放行
   ══════════════════════════════════════════════════════════════════ */

describe('三态 · 加载 / 失败 / 空 各有各的出口', () => {
  test('加载失败给出错误详情与重试，不是「暂无数据」', async () => {
    const base = defaultHandler()
    handler = (c) =>
      c.path === '/api/v1/admin/meetings' && c.method === 'GET'
        ? { status: 503, body: { error: 'upstream_down' } }
        : base(c)
    renderPage()
    const box = await screen.findByTestId('meetings-error')
    expect(box).toHaveTextContent('读不到会议列表')
    expect(box).toHaveTextContent('已经归档到 NAS 的文件不受影响')
    // 端点名与错误码要在界面上，否则运维只能去开 devtools
    expect(box).toHaveTextContent('GET /api/v1/admin/meetings')
    expect(box).toHaveTextContent('upstream_down')
    expect(within(box).getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByTestId('meetings-empty')).toBeNull()
  })

  test('后端少下发一个字段 → 错误态而不是白屏，且报得出是哪个字段', async () => {
    const broken = meeting()
    delete (broken as Record<string, unknown>).nasPath
    handler = defaultHandler([broken])
    renderPage()
    const box = await screen.findByTestId('meetings-error')
    expect(box).toHaveTextContent('rows[0].nasPath')
    expect(box).toHaveTextContent('GET /api/v1/admin/meetings')
  })

  test('一场都没有 / 被筛没了，是两句不同的话与两个不同的出口', async () => {
    handler = defaultHandler([])
    const user = userEvent.setup()
    renderPage()
    const box = await screen.findByTestId('meetings-empty')
    expect(box).toHaveAttribute('data-kind', 'none-at-all')
    expect(box).toHaveTextContent('还没有拉取过任何会议')

    // 有筛选条件时同样的 0 行是另一件事
    await user.click(screen.getByTestId('triage-archfail'))
    await waitFor(() =>
      expect(screen.getByTestId('meetings-empty')).toHaveAttribute('data-kind', 'filtered-out'),
    )
  })

  test('emptyKind 的两支', () => {
    expect(emptyKind({ total: 3, narrowed: false })).toBeNull()
    expect(emptyKind({ total: 0, narrowed: false })).toBe('none-at-all')
    expect(emptyKind({ total: 0, narrowed: true })).toBe('filtered-out')
  })
})

describe('不许静默放行', () => {
  test('认不出的阶段状态显示「未知」，不画成任何一种圆点', async () => {
    handler = defaultHandler([meeting({ fetch: 'teleported' })])
    renderPage()
    await ready()
    expect(within(screen.getByTestId('row-m1')).getByText('拉取未知')).toBeInTheDocument()
    expect(within(screen.getByTestId('row-m1')).queryByRole('button', { name: /^拉取：/ })).toBeNull()
  })

  test('认不出的采集权限不画「＋ 授权给…」—— 闸门读不懂状态时必须是关着的', async () => {
    handler = defaultHandler([meeting({ allow: 'maybe', grants: [] })])
    renderPage()
    await ready()
    expect(within(screen.getByTestId('grant-m1')).getByText('权限未知')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '＋ 授权给…' })).toBeNull()
  })

  test('判定理由缺失时显示「理由缺失」并说清那是读不到，不是留空', async () => {
    const noWhy = meeting()
    delete (noWhy as Record<string, unknown>).why
    handler = defaultHandler([noWhy])
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '产品周会 的详情' }))
    const lines = await screen.findAllByTestId('why-line')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines) {
      expect(line).toHaveTextContent(WHY_MISSING_LABEL)
      expect(line).toHaveTextContent('只代表这里读不到')
    }
  })

  test('展示映射：未知一律落到 unknown，不落到 done / allow', () => {
    expect(dotState('fetch', 'done')).toBe('done')
    expect(dotState('fetch', 'failed')).toBe('unknown') // failed 不是拉取的取值
    expect(dotState('archive', 'failed')).toBe('failed')
    expect(dotState('archive', '')).toBe('unknown')
    expect(allowView('allow')).toBe('allow')
    expect(allowView('ALLOW')).toBe('unknown')
    expect(whyLabel('')).toBe(WHY_MISSING_LABEL)
    expect(whyLabel('rule')).toBe('来自规则')
    expect(whyLabel('brand-new')).toMatch(/未知理由类型/)
  })

  test('琥珀只给人工改写；失败给红；生命周期原因与理由缺失都中性', () => {
    expect(whyTone('hand')).toBe('warn')
    expect(whyTone('fail')).toBe('fail')
    for (const by of ['rule', 'deny', 'expired', 'wait', 'na', '']) {
      expect(whyTone(by)).toBe('neutral')
    }
  })

  test('grantCellKind：allow 认不出时是 unknown，不是 grantable', () => {
    const base = meeting() as unknown as Parameters<typeof grantCellKind>[0]
    expect(grantCellKind(base).kind).toBe('grantable')
    expect(grantCellKind({ ...base, allow: 'wat' }).kind).toBe('unknown')
    expect(grantCellKind({ ...base, allow: 'deny' }).kind).toBe('denied')
    expect(grantCellKind({ ...base, archive: 'running' }).kind).toBe('wait')
  })

  test('「已延长 N 次」与「至少延长过 N 次」是两句话', () => {
    expect(extendedText({ extended: 0, extendedSource: 'none', extendedDays: 0 } as never)).toBeNull()
    expect(extendedText({ extended: 2, extendedSource: 'audit', extendedDays: 45 } as never)).toBe(
      '已延长 2 次，共 45 天',
    )
    expect(extendedText({ extended: 1, extendedSource: 'floor', extendedDays: 30 } as never)).toBe(
      '至少延长过 1 次，共 30 天',
    )
  })
})

/* ══════════════════════════════════════════════════════════════════
   写操作：发请求 + 重取，不做乐观更新
   ══════════════════════════════════════════════════════════════════ */

describe('写操作 · pending → 重取 → 界面更新', () => {
  test('页面里没有任何"推导下一个状态"的代码（G-c 回归）', () => {
    // write.ts 的 applyWrite 是这条裁定要删掉的东西。它不该以任何形式回来。
    const dir = 'src/pages/Meetings/'
    for (const f of ['index.tsx', 'display.ts', 'writes.ts', 'MeetingDetail.tsx']) {
      const src = stripTs(css(dir + f))
      expect(src, `${f} 里出现了 applyWrite`).not.toMatch(/applyWrite/)
    }
    expect(() => css('src/pages/Meetings/write.ts')).toThrow()
  })

  test('延长保留期：按钮先变 pending，成功后重取三条数据并弹提示', async () => {
    let release: (() => void) | null = null
    const base = defaultHandler()
    handler = (c) => base(c)
    const user = userEvent.setup()
    renderPage()
    await ready()

    // 把 extend 卡住，好断言 pending 真的显示出来了
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (String(input).endsWith('/extend')) {
          await new Promise<void>((r) => {
            release = r
          })
        }
        return realFetch(input, init)
      }),
    )

    const before = callsTo('GET', '/api/v1/admin/meetings').length
    await user.click(screen.getByRole('button', { name: /把「产品周会」的本地保留期延长 30 天/ }))
    await waitFor(() => expect(screen.getByText('延长中…')).toBeInTheDocument())

    release!()
    await waitFor(() =>
      expect(callsTo('GET', '/api/v1/admin/meetings').length).toBeGreaterThan(before),
    )
    // 重取的是三条，不只是列表——一次延长会改变"7 天内到期"那一格
    await waitFor(() => expect(callsTo('GET', '/api/v1/admin/meetings/triage').length).toBe(2))
    expect(await screen.findByText(/本地保留期延长 30 天/)).toBeInTheDocument()
  })

  test('写失败留下一条按得掉的错误条，带端点名、错误码和一句能照着做的话', async () => {
    const base = defaultHandler()
    handler = (c) =>
      /\/extend$/.test(c.path)
        ? { status: 409, body: { error: 'already_purged', purgedAt: 1, message: 'x' } }
        : base(c)
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: /把「产品周会」的本地保留期延长 30 天/ }))
    const box = await screen.findByTestId('write-error')
    expect(box).toHaveTextContent('延长本地保留期没有成功')
    expect(box).toHaveTextContent('already_purged')
    // 端点名带的是**真实路径**（含这一场的 id），不是模板——运维照着它就能去翻网关日志
    expect(box).toHaveTextContent('POST /api/v1/admin/meetings/m1/extend')
    expect(box).toHaveTextContent('本地文件已被到期清理')

    await user.click(within(box).getByRole('button', { name: '知道了' }))
    expect(screen.queryByTestId('write-error')).toBeNull()
  })

  test('圆点：没有改写时打开人工改写面板（后端要求理由），有改写时一键撤销', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(within(screen.getByTestId('row-m1')).getByRole('button', { name: '拉取：已完成' }))
    await waitFor(() => expect(isOpen(panel('人工改写：拉取'))).toBe(true))
    // 理由没写之前不能提交——后端缺 reason 直接 400，前端不该把这一趟白发出去
    expect(screen.getByRole('button', { name: '保存改写' })).toBeDisabled()

    await user.type(screen.getByRole('textbox'), '这场涉密')
    await user.click(screen.getByRole('button', { name: '保存改写' }))

    await waitFor(() => expect(callsTo('PUT', '/api/v1/admin/meetings/m1/override')).toHaveLength(1))
    const sent = callsTo('PUT', '/api/v1/admin/meetings/m1/override')[0]!.body as Record<string, unknown>
    expect(sent).toEqual({ kind: 'fetch', effect: 'skip', assetTypes: null, reason: '这场涉密' })
  })

  test('已有改写的阶段：点圆点直接撤销，不再问理由（DELETE 不需要理由）', async () => {
    handler = defaultHandler([meeting({ fetch: 'off', hand: ['fetch'] })])
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(
      within(screen.getByTestId('row-m1')).getByRole('button', { name: '拉取：未执行 · 人工改写' }),
    )
    await waitFor(() =>
      expect(callsTo('DELETE', '/api/v1/admin/meetings/m1/override/fetch')).toHaveLength(1),
    )
    // 没有问理由，也就没有发过 PUT
    expect(callsTo('PUT', '/api/v1/admin/meetings/m1/override')).toHaveLength(0)
    expect(isOpen(panel('人工改写：拉取'))).toBe(false)
  })

  test('收回单条授权走 DELETE，程序 id 在路径里', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: /收回 知识库索引器 对「产品周会」的授权/ }))
    await waitFor(() =>
      expect(callsTo('DELETE', '/api/v1/admin/meetings/m1/grants/kb-indexer')).toHaveLength(1),
    )
  })

  test('授权面板：单场是"改成这些"，去掉的那个真的会被撤销', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    // m1 已经授权给 kb-indexer；打开面板、取消它、勾上 daily-digest
    await user.click(screen.getByRole('button', { name: /再给「产品周会」授权一个采集程序/ }))
    await user.click(await screen.findByRole('checkbox', { name: /知识库索引器/ }))
    await user.click(screen.getByRole('checkbox', { name: /简报机器人/ }))
    await user.click(screen.getByRole('button', { name: '保存授权' }))

    await waitFor(() => expect(callsTo('POST', '/api/v1/admin/meetings/m1/grants')).toHaveLength(1))
    expect(callsTo('POST', '/api/v1/admin/meetings/m1/grants')[0]!.body).toEqual({
      programId: 'daily-digest',
      // assetTypes 必须显式给出，缺这个键后端 400
      assetTypes: null,
    })
    expect(callsTo('DELETE', '/api/v1/admin/meetings/m1/grants/kb-indexer')).toHaveLength(1)
  })

  test('点不动的时候说人话，而不是发一条注定失败的请求', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    // m3 归档失败，保留窗口没开始计时
    await user.click(within(screen.getByTestId('row-m3')).getByRole('button', { name: '客户访谈 的详情' }))
    await screen.findByTestId('section-keep')
    expect(screen.getByTestId('keep-none')).toHaveTextContent('归档失败')
    expect(
      within(screen.getByTestId('section-keep')).getByRole('button', { name: '延长 30 天' }),
    ).toBeDisabled()
    expect(callsTo('POST', '/api/v1/admin/meetings/m3/extend')).toHaveLength(0)
  })

  test('批量结果把成功与失败分开说', () => {
    expect(batchSummary('延长 30 天保留', 3, 0)).toBe('已对 3 场会议延长 30 天保留')
    expect(batchSummary('延长', 2, 1)).toBe('2 场延长成功，1 场失败')
    expect(batchSummary('延长', 0, 3)).toMatch(/3 场都没能/)
    const t = tally([
      { status: 'fulfilled', value: 1 },
      { status: 'rejected', reason: new Error('x') },
    ] as PromiseSettledResult<unknown>[])
    expect(t).toMatchObject({ ok: 1, failed: 1 })
  })

  test('failureOf 认得出的错误码给一句能照着做的话', () => {
    const e = Object.assign(new Error('POST … 返回 400：missing_reason'), {})
    expect(failureOf('人工改写', e).hint).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════════
   详情抽屉（spec §4.3）
   ══════════════════════════════════════════════════════════════════ */

describe('详情抽屉 · 四段 + 操作历史', () => {
  async function openDrawer() {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '产品周会 的详情' }))
    await screen.findByTestId('section-fetch')
    return user
  }

  test('抽屉自己再取一次单场详情与操作历史', async () => {
    await openDrawer()
    await waitFor(() => expect(callsTo('GET', '/api/v1/admin/meetings/m1')).toHaveLength(1))
    expect(callsTo('GET', '/api/v1/admin/meetings/m1/history')).toHaveLength(1)
  })

  test('四段齐了，每段带自己的判定理由', async () => {
    await openDrawer()
    for (const id of ['section-fetch', 'section-archive', 'section-keep', 'section-allow']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.getByTestId('section-fetch')).toHaveTextContent('拉取规则 #100 判定全拉')
    expect(screen.getByTestId('section-archive')).toHaveTextContent('归档规则 #100')
    expect(screen.getByTestId('section-allow')).toHaveTextContent('权限规则 #100 准许采集')
  })

  test('拉取段列出八类资产各自的格式数，部分失败的那一类标出来', async () => {
    await openDrawer()
    const table = screen.getByTestId('asset-table')
    expect(within(table).getByText('录像')).toBeInTheDocument()
    expect(within(table).getByText('AI 纪要')).toBeInTheDocument()
    expect(within(table).getByText('2/3')).toHaveAttribute('data-partial', 'true')
    expect(within(table).getByText('1/1')).toHaveAttribute('data-partial', 'false')
  })

  test('归档段给 NAS 路径（可复制）、归档时间、体积', async () => {
    await openDrawer()
    const section = screen.getByTestId('section-archive')
    expect(within(section).getByTestId('nas-path')).toHaveTextContent(
      '/nas/meetings/2026/08/88112340-产品周会/',
    )
    expect(within(section).getByRole('button', { name: '复制' })).toBeInTheDocument()
    expect(section).toHaveTextContent('22.8 MB')
  })

  test('「撤销归档」没有按钮，但它的语义与缺口写在归档段里（2026-08-25 定案）', async () => {
    await openDrawer()
    const gap = screen.getByTestId('undo-archive-gap')
    // 逐字：只撤记录、NAS 副本保留、可逆、不需要二次确认
    expect(gap).toHaveTextContent('只撤归档记录、NAS 上的副本保留')
    expect(gap).toHaveTextContent('可逆动作、不需要二次确认')
    // 不许出现一个名叫「撤销归档」的按钮去干别的事
    expect(screen.queryByRole('button', { name: '撤销归档' })).toBeNull()
  })

  test('本地保留段：大号剩余天数 + 归档日/到期日 + 延长 30 天', async () => {
    await openDrawer()
    expect(screen.getByTestId('keep-days')).toHaveTextContent('28')
    const section = screen.getByTestId('section-keep')
    expect(section).toHaveTextContent('归档日')
    expect(section).toHaveTextContent('到期日')
    expect(within(section).getByRole('button', { name: '延长 30 天' })).toBeEnabled()
  })

  test('采集授权段：已授权程序 + 放行/禁止的理由 + 人工改写入口', async () => {
    const user = await openDrawer()
    const section = screen.getByTestId('section-allow')
    expect(within(section).getByTestId('detail-grants')).toHaveTextContent('知识库索引器')
    expect(section).toHaveTextContent('单场会议的人工改写优先于所有规则。')

    await user.click(within(section).getByRole('button', { name: '人工改写采集权限…' }))
    await waitFor(() => expect(isOpen(panel('人工改写：采集授权'))).toBe(true))
    expect(screen.getByRole('radio', { name: /禁止采集/ })).toBeInTheDocument()
  })

  test('操作历史来自 /history；读不到时说清"这不代表没有人取过"', async () => {
    const base = defaultHandler()
    handler = (c) =>
      /\/history$/.test(c.path) ? { status: 500, body: { error: 'boom' } } : base(c)
    await openDrawer()
    const box = await screen.findByTestId('history-error')
    expect(box).toHaveTextContent('这不代表没有人取过')
    expect(box).toHaveTextContent('GET /api/v1/admin/meetings/m1/history')
  })

  test('操作历史逐条渲染后端拼好的那句话，被拒的那条要看得出来', async () => {
    const base = defaultHandler()
    handler = (c) =>
      /\/history$/.test(c.path)
        ? {
            status: 200,
            body: {
              meeting: { id: 'm1', title: '产品周会', code: '881', startAt: nowSec(), source: 'meetings' },
              rows: [
                {
                  id: 1,
                  at: nowSec() - HOUR,
                  actionLabel: '签发下载链接',
                  result: { decision: 'allow' },
                  clientKind: 'program',
                  text: 'kb-indexer 取走了 AI 纪要',
                },
                {
                  id: 2,
                  at: nowSec() - 2 * HOUR,
                  actionLabel: '签发下载链接',
                  result: { decision: 'deny' },
                  clientKind: 'program',
                  text: 'daily-digest 想取完整转写，被拒绝',
                },
              ],
              window: { since: 1, sinceSource: 'meetings', text: '只列出会议开始之后的记录' },
            },
          }
        : base(c)
    await openDrawer()
    const rows = await screen.findByTestId('history-rows')
    expect(rows).toHaveTextContent('kb-indexer 取走了 AI 纪要')
    expect(within(rows).getAllByRole('listitem')[1]).toHaveAttribute('data-deny', 'true')
    expect(screen.getByTestId('history-window')).toHaveTextContent('只列出会议开始之后的记录')
  })

  test('详情端点挂了不白屏：仍显示列表那一行，并说明它可能不是最新的', async () => {
    const base = defaultHandler()
    handler = (c) =>
      c.method === 'GET' && /\/meetings\/m1$/.test(c.path)
        ? { status: 500, body: { error: 'boom' } }
        : base(c)
    await openDrawer()
    const box = await screen.findByTestId('detail-error')
    expect(box).toHaveTextContent('可能不是最新的')
    // 内容还在
    expect(screen.getByTestId('section-fetch')).toHaveTextContent('拉取规则 #100 判定全拉')
  })
})

describe('详情抽屉 · 键盘可达性', () => {
  test('打开时焦点进入抽屉，Esc 关闭，焦点归还触发它的那个按钮', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const trigger = screen.getByRole('button', { name: '产品周会 的详情' })
    trigger.focus()
    await user.click(trigger)
    const dialog = panel('产品周会')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    await user.keyboard('{Escape}')
    await waitFor(() => expect(isOpen(panel('会议详情'))).toBe(false))
    expect(document.activeElement).toBe(trigger)
  })

  test('Tab 在抽屉内循环，不会跑到底层表格上', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '产品周会 的详情' }))
    const dialog = panel('产品周会')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    for (let i = 0; i < 25; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  test('Enter 打开抽屉、Esc 关掉——键位表按 spec §9', () => {
    expect(resolveMeetingKey({ key: 'Enter' })).toEqual({ type: 'open-detail' })
    expect(resolveMeetingKey({ key: 'Escape' })).toEqual({ type: 'close-overlay' })
    expect(resolveMeetingKey({ key: '1' })).toEqual({ type: 'stage', stage: 'fetch' })
    expect(resolveMeetingKey({ key: 'e' })).toEqual({ type: 'extend' })
    expect(resolveMeetingKey({ key: 'j', metaKey: true })).toBeNull()
  })

  test('输入框里打字不被键位表接管，Esc 除外', () => {
    const input = document.createElement('input')
    expect(isTypingTarget(input)).toBe(true)
    expect(resolveMeetingKey({ key: 'j', target: input })).toBeNull()
    expect(resolveMeetingKey({ key: 'Escape', target: input })).toEqual({ type: 'close-overlay' })
    const button = document.createElement('button')
    expect(isActivationTarget(button)).toBe(true)
    expect(resolveMeetingKey({ key: 'Enter', target: button })).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════════
   批量与选择
   ══════════════════════════════════════════════════════════════════ */

describe('批量 · 只能改到手里真的有的那些行', () => {
  test('批量条只剩真实存在的动作，「重跑拉取 / 重跑归档」删掉了', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('checkbox', { name: '选择 产品周会' }))
    const bar = screen.getByTestId('batch-bar')
    expect(within(bar).getByRole('button', { name: '延长 30 天' })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: '授权给…' })).toBeInTheDocument()
    expect(within(bar).queryByRole('button', { name: '重跑拉取' })).toBeNull()
    expect(within(bar).queryByRole('button', { name: '重跑归档' })).toBeNull()
  })

  test('批量延长：逐场发请求，成功之后清空选择并重取', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('checkbox', { name: '选择 产品周会' }))
    await user.click(screen.getByRole('checkbox', { name: '选择 技术评审' }))
    expect(screen.getByTestId('batch-count')).toHaveTextContent('2')

    await user.click(within(screen.getByTestId('batch-bar')).getByRole('button', { name: '延长 30 天' }))
    await waitFor(() => expect(callsTo('POST', '/api/v1/admin/meetings/m1/extend')).toHaveLength(1))
    expect(callsTo('POST', '/api/v1/admin/meetings/m2/extend')).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId('batch-count')).toHaveTextContent('0'))
  })

  test('改筛选就把选择清空 —— 选中的行可能已经不在结果里了', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('checkbox', { name: '选择 产品周会' }))
    expect(screen.getByTestId('batch-count')).toHaveTextContent('1')
    await user.click(screen.getByTestId('triage-archfail'))
    await waitFor(() => expect(screen.getByTestId('batch-count')).toHaveTextContent('0'))
  })

  test('跨页选中的行会被算进来，并且说清有几场不在本页', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      meeting({ id: `x${i}`, meetingId: `x${i}`, title: `会议 ${i}` }),
    )
    handler = defaultHandler(many)
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('row-x0')).toBeInTheDocument())
    await user.click(screen.getByRole('checkbox', { name: '选择 会议 0' }))
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(screen.getByTestId('row-x10')).toBeInTheDocument())
    expect(screen.getByTestId('batch-count')).toHaveTextContent('1')
    expect(screen.getByTestId('batch-bar')).toHaveTextContent('其中 1 场不在本页')
  })
})

/* ══════════════════════════════════════════════════════════════════
   页面骨架与样式纪律
   ══════════════════════════════════════════════════════════════════ */

describe('页面骨架与令牌', () => {
  test('用 ui/PageShell，标题是 h1（七页层级一致）', async () => {
    renderPage()
    await ready()
    expect(screen.getByRole('heading', { name: '会议记录', level: 1 })).toBeInTheDocument()
  })

  test('表格横向滚动收在自己的容器里，页面本身不横滚', () => {
    const tableCss = css('src/pages/Meetings/MeetingTable.module.css')
    expect(tableCss).toMatch(/\.table\s*\{\s*min-width:\s*var\(--meetings-table-w\)/)
    expect(stripComments(tableCss)).not.toMatch(/\d+px/)
    expect(css('src/ui/Table.module.css')).toMatch(/\.scroll\s*\{\s*overflow-x:\s*auto/)
    expect(css('src/styles/base.css')).toMatch(/overflow-x:\s*clip/)
  })

  test('页面 CSS 里没有裸的 px / hex / rgba（缺值就去 tokens.css 加令牌）', () => {
    const files = [
      'src/pages/Meetings/Meetings.module.css',
      'src/pages/Meetings/MeetingTable.module.css',
      'src/pages/Meetings/MeetingRow.module.css',
      'src/pages/Meetings/TriageBar.module.css',
      'src/pages/Meetings/BatchBar.module.css',
      'src/pages/Meetings/GrantPicker.module.css',
      'src/pages/Meetings/MeetingDetail.module.css',
      'src/pages/Meetings/OverrideSheet.module.css',
    ]
    for (const f of files) {
      const decls = stripComments(css(f))
        .split('\n')
        .filter((l) => /:/.test(l))
        .join('\n')
      expect(decls, `${f} 出现了裸像素`).not.toMatch(/:\s*-?\d+(\.\d+)?px/)
      expect(decls, `${f} 出现了裸 hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(decls, `${f} 出现了裸 rgba`).not.toMatch(/rgba?\(/)
    }
  })

  test('归档失败是红的；未归档不是（两件事，不能同一个灰也不能同一个红）', async () => {
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    expect(rowCss).toMatch(/\.keepNone\[data-fail='true'\]\s*\{\s*color:\s*var\(--fail\)/)
    handler = defaultHandler([M3, M2])
    renderPage()
    await waitFor(() => expect(screen.getByTestId('row-m3')).toBeInTheDocument())
    expect(screen.getByTestId('keep-m3').querySelector('[data-fail="true"]')).not.toBeNull()
    expect(screen.getByTestId('keep-m2').querySelector('[data-fail="true"]')).toBeNull()
  })

  test('「＋30 天」平时不占位，hover / 键盘光标才浮出来', () => {
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    expect(rowCss).toMatch(/\.extendBtn\s*\{[^}]*opacity:\s*0/)
    expect(rowCss).toMatch(/tr:hover \.extendBtn[^{]*\{\s*opacity:\s*1/)
  })
})

/* ── 只读账号（spec §11 缺口 1）─────────────────────────────────── */

describe('只读账号', () => {
  async function readonlyReady(): Promise<void> {
    const router = createMemoryRouter(
      [
        { path: '/meetings', element: <MeetingsPage /> },
        { path: '/preview/:id', element: <h1>内容预览占位</h1> },
      ],
      { initialEntries: ['/meetings'] },
    )
    renderAsRole(
      <SystemStateProvider initialState="ok">
        <RouterProvider router={router} />
      </SystemStateProvider>,
      'readonly',
    )
    await waitFor(() => expect(screen.getByTestId('row-m1')).toBeInTheDocument())
  }

  test('行内的四个写入口全部禁用：两个阶段圆点、＋30 天、授权', async () => {
    await readonlyReady()
    const row = screen.getByTestId('row-m1')
    for (const btn of within(row).getAllByRole('button')) {
      const name = btn.getAttribute('aria-label') ?? btn.textContent ?? ''
      if (/详情/.test(name)) continue // 打开抽屉是读，不禁用
      if (/^拉取|^归档|30 天|授权/.test(name)) expect(btn, name).toBeDisabled()
    }
  })

  test('标题仍然点得进内容预览——看内容是只读账号该有的权限（spec §2）', async () => {
    await readonlyReady()
    const row = screen.getByTestId('row-m1')
    expect(within(row).getByRole('button', { name: '产品周会' })).toBeEnabled()
    expect(within(row).getByRole('button', { name: /的详情$/ })).toBeEnabled()
  })

  test('选行不禁用，批量条里三个写动作禁用、「取消」留着', async () => {
    await readonlyReady()
    const box = within(screen.getByTestId('row-m1')).getByRole('checkbox')
    expect(box).toBeEnabled()
    await userEvent.click(box)

    const bar = screen.getByTestId('batch-bar')
    expect(within(bar).getByRole('button', { name: /延长/ })).toBeDisabled()
    expect(within(bar).getByRole('button', { name: '授权给…' })).toBeDisabled()
    expect(within(bar).getByRole('button', { name: '收回授权' })).toBeDisabled()
    expect(within(bar).getByRole('button', { name: '取消' })).toBeEnabled()
  })

  test('页头有一句说明', async () => {
    await readonlyReady()
    expect(screen.getByTestId('readonly-banner')).toBeInTheDocument()
  })
})
