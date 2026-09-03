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
  groupHistory,
  historyAtText,
  parseWhy,
  programAbbr,
  rowFlag,
  stageNote,
  whyLabel,
  whyTone,
  WHY_MISSING_LABEL,
} from '../src/pages/Meetings/display'
import { fmtDateTime } from '../src/lib/format'
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

/**
 * 后端为「已归档」这一段拼出来的判定理由，逐字照抄 `src/http/handlers/console/meetings.ts`。
 * 种子里那句 `归档规则 #100，已写入 NAS` 是个缩写版，测不出真实长度带来的问题——
 * 用户圈出来的正是这一段：140 字里藏着一个规则号。
 */
const ARCHIVED_WHY =
  '已归档到 /tmp/mde-nas/all（2026-08-28 02:22:10 UTC）。' +
  '当前归档规则栈的判定是「归档规则 #4「验收：与拉取规则对齐——拉下来的就归档」决定：归档到 all」——' +
  '那是此刻这一次求值，不是当初归档时跑的那一次；已经写进 NAS 的副本不受规则改动影响。'

const TRIAGE = { archiveFailed: 7, expiringIn7d: 3, awaitingGrant: 4, inProgress: 1, nasOnly: 5 }

const AUTO_OFF = { autoGrant: false, autoGrantAssetTypes: null }

const PROGRAMS = [
  { id: 'kb-indexer', name: '知识库索引器', tmUserId: 'tm-1', enabled: true, expiresAt: null, createdAt: 1, ...AUTO_OFF },
  { id: 'daily-digest', name: '简报机器人', tmUserId: 'tm-2', enabled: true, expiresAt: null, createdAt: 1, ...AUTO_OFF },
]

function emptyHistory(): unknown {
  return {
    meeting: null,
    rows: [],
    window: { since: null, sinceSource: null, text: null },
    unlabeledActions: [],
  }
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
    // （阶段 7：这一格从"进度条 + 剩 28 天"压成了右对齐的等宽天数「28 天」，
    //   数字本身没变——变的只是它旁边不再有一根复述它的横条。）
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('28 天')
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

  /**
   * `parseWhy` 只**切分**后端那句话，一个字都不新编。切出来的三段各自仍然是
   * 原句的子串——判定理由的可回溯性靠的就是这一点。
   */
  test('parseWhy：切出规则号 / 规则名 / 判成什么，注意事项单独拎出来', () => {
    const done = parseWhy(ARCHIVED_WHY)
    expect(done.rule).toEqual({
      ref: '归档规则 #4',
      name: '验收：与拉取规则对齐——拉下来的就归档',
      result: '归档到 all',
    })
    // 事实留在正文：归档到哪、什么时候
    expect(done.text).toBe('已归档到 /tmp/mde-nas/all（2026-08-28 02:22:10 UTC）。')
    // 注意事项一个字不丢
    expect(done.aside).toBe(
      '那是此刻这一次求值，不是当初归档时跑的那一次；已经写进 NAS 的副本不受规则改动影响。',
    )
  })

  test('parseWhy：整句话就是一条引用时，正文是空的；没起名字的规则 name 是 null', () => {
    const plain = parseWhy('拉取规则 #2「全量拉取：所有会议都拉」决定：拉取（video、audio）')
    expect(plain.text).toBe('')
    expect(plain.aside).toBeNull()
    expect(plain.rule?.name).toBe('全量拉取：所有会议都拉')

    const noName = parseWhy('归档规则 #9决定：不归档')
    expect(noName.rule).toEqual({ ref: '归档规则 #9', name: null, result: '不归档' })
  })

  /** 认不出格式的一律原样照登——猜错的代价是把一句判定理由拆成两个半句。 */
  test('parseWhy：认不出格式就原样照登，不去猜', () => {
    for (const raw of [
      '没有任何归档规则匹配这场会议，按兜底处理：不归档',
      '人工改写（zou）决定：不归档，改写理由：客户要求',
      '这场会议在 meetings 表里查不到元数据，归档规则求值所需的事实取不到，无从判定。',
      '拉取规则 #100 判定全拉',
    ]) {
      const parts = parseWhy(raw)
      expect(parts.text, raw).toBe(raw)
      expect(parts.aside, raw).toBeNull()
      if (!raw.includes('决定：') || !raw.includes('规则 #')) expect(parts.rule, raw).toBeNull()
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

  /**
   * 「撤销归档」这条缺口从界面上整个撤走了。
   *
   * 此前归档段里有一个虚线框（`data-testid="undo-archive-gap"`），逐字写着规格
   * 定的语义、定案日期、以及"后端没有这条端点所以不放按钮"。**那是开发笔记**：
   * 它向管理员解释一个不存在的按钮为什么不存在。缺口的账本是
   * `docs/console/spec.md` §11 那张表（第 7 行），不是抽屉里的一段话——上一轮
   * 刚为「全局搜索」立过这条规矩（§11 第 6 行）。
   *
   * 所以这条断言从"那段话在屏幕上找得到"改成**"这四个字在屏幕上一个都没有"**，
   * 并钉住源码里那段注释还在（它对读代码的人有用，只是不许渲染）。
   */
  test('界面上一个「撤销归档」都没有——缺口登记在 spec §11，不渲染成文案', async () => {
    await openDrawer()
    expect(screen.queryByTestId('undo-archive-gap')).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销归档' })).toBeNull()
    // 整个抽屉里连这四个字都不该出现
    expect(panel('产品周会').textContent).not.toMatch(/撤销归档/)
    // 但读代码的人还要知道这里为什么空着
    const src = css('src/pages/Meetings/MeetingDetail.tsx')
    expect(src).toMatch(/为什么没有「撤销归档」按钮/)
    expect(src).toMatch(/spec\.md` §11/)
  })

  test('「撤销归档」这条缺口在 spec §11 那张表里查得到', () => {
    const spec = readFileSync(resolve(process.cwd(), '../docs/console/spec.md'), 'utf-8')
    const table = spec.slice(spec.indexOf('## 11.'))
    const row = table.split('\n').find((l) => l.startsWith('| 7 |'))
    expect(row, '§11 少了「撤销归档」那一行').toBeDefined()
    expect(row).toMatch(/撤销归档/)
    expect(row).toMatch(/US-2\.5/)
  })

  test('资产表：口径进了列头与列头的 title，不再当一段脚注占正文', async () => {
    await openDrawer()
    const table = screen.getByTestId('asset-table')
    // 列头文案本身就是口径
    const head = within(table).getByRole('columnheader', { name: '已拿到 / 应有' })
    // 「不适用的类不出现在这张表里」搬进了 title，不是被删掉
    expect(head).toHaveAttribute('title', expect.stringContaining('不适用的类不出现在这张表里'))
    expect(head).toHaveAttribute('title', expect.stringContaining('八类资产'))
    // 正文里不再有那句脚注
    expect(table.textContent).not.toMatch(/不适用的类不出现在这张表里/)
  })

  /**
   * 「算不出来」与「0 字节」在一个按体积做决策的系统里是两件事。原来那句话
   * 三行长，现在正文只留这个区分本身，为什么算不出来进 `title`。
   */
  test('合计体积算不出来时，"算不出来 ≠ 0 字节"仍然表达得出来', async () => {
    handler = defaultHandler([meeting({ sizeBytes: null })])
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '产品周会 的详情' }))
    const cell = await screen.findByTestId('size-unknown')
    expect(cell).toHaveTextContent('算不出来')
    expect(cell).toHaveTextContent('不是 0 字节')
    expect(cell).toHaveAttribute('title', expect.stringContaining('不等于这场会议占 0 字节'))
    // 「逐类的体积后端没有下发」是后端契约，不是管理员要读的话——删掉了
    expect(panel('产品周会').textContent).not.toMatch(/逐类的体积/)
  })

  test('本地保留段：大号剩余天数 + 归档日/到期日 + 延长 30 天', async () => {
    await openDrawer()
    expect(screen.getByTestId('keep-days')).toHaveTextContent('28')
    const section = screen.getByTestId('section-keep')
    expect(section).toHaveTextContent('归档日')
    expect(section).toHaveTextContent('到期日')
    expect(within(section).getByRole('button', { name: '延长 30 天' })).toBeEnabled()

    // 真会被搞错的口径留一行；后半句（到期后删本地、只留记录和 NAS 路径）
    // 是全站通则，§4.9 归档存储页已经写过一次，这一页不再重复
    expect(screen.getByTestId('keep-basis')).toHaveTextContent(
      '保留期从归档成功那一刻起算，不是从会议日。',
    )
    expect(section.textContent).not.toMatch(/只留记录和 NAS 路径/)
  })

  /* ── 判定理由：可回溯性一条都不许弱化 ─────────────────────── */

  async function openWithRealWhy() {
    handler = defaultHandler([
      meeting({
        why: {
          fetch: { by: 'rule', text: '拉取规则 #2「全量拉取：所有会议都拉」决定：拉取（video、audio）' },
          archive: { by: 'rule', text: ARCHIVED_WHY },
          allow: { by: 'rule', text: '权限规则 #1「默认准许」决定：准许采集（video）' },
        },
      }),
    ])
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '产品周会 的详情' }))
    await waitFor(() =>
      expect(screen.getByTestId('section-fetch')).toHaveTextContent('全量拉取：所有会议都拉'),
    )
    return user
  }

  test('规则引用排成结构：规则号 + 规则名 + 判成什么，三样都逐字可查', async () => {
    await openWithRealWhy()

    const fetchRule = within(screen.getByTestId('section-fetch')).getByTestId('why-rule')
    expect(fetchRule).toHaveTextContent('拉取规则 #2')
    expect(fetchRule).toHaveTextContent('全量拉取：所有会议都拉')
    expect(fetchRule).toHaveTextContent('拉取（video、audio）')

    // 归档段的引用此前埋在一段 140 字里，现在自己站一层
    const archiveRule = within(screen.getByTestId('section-archive')).getByTestId('why-rule')
    expect(archiveRule).toHaveTextContent('归档规则 #4')
    expect(archiveRule).toHaveTextContent('验收：与拉取规则对齐——拉下来的就归档')
    expect(archiveRule).toHaveTextContent('归档到 all')

    const allowRule = within(screen.getByTestId('section-allow')).getByTestId('why-rule')
    expect(allowRule).toHaveTextContent('权限规则 #1')
    expect(allowRule).toHaveTextContent('默认准许')
  })

  /**
   * 「当前这次求值 ≠ 当初归档时跑的那一次」是个真实且不直观的陷阱，一个字都不许丢；
   * 但它在**每一场已归档的会议**上都是同一句话，重复到第三场就没人读了。
   * 所以：正文里没有，标签的 `title` 上有。搬家不等于消失。
   */
  test('那句注意事项从正文搬进「来自规则」的 title，一个字没丢', async () => {
    await openWithRealWhy()
    const why = within(screen.getByTestId('section-archive')).getByTestId('why-line')

    expect(why.textContent).not.toMatch(/那是此刻这一次求值/)
    expect(why.textContent).not.toMatch(/不受规则改动影响/)

    expect(within(why).getByText('来自规则')).toHaveAttribute(
      'title',
      '那是此刻这一次求值，不是当初归档时跑的那一次；已经写进 NAS 的副本不受规则改动影响。',
    )
    // 事实（归档到哪、什么时候）仍然在正文里
    expect(why).toHaveTextContent('已归档到 /tmp/mde-nas/all（2026-08-28 02:22:10 UTC）。')
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
              unlabeledActions: [],
            },
          }
        : base(c)
    await openDrawer()
    const rows = await screen.findByTestId('history-rows')
    expect(rows).toHaveTextContent('kb-indexer 取走了 AI 纪要')
    expect(within(rows).getAllByRole('listitem')[1]).toHaveAttribute('data-deny', 'true')
    expect(screen.getByTestId('history-window')).toHaveTextContent('只列出会议开始之后的记录')
    // 都登记过了就不该出现那句提示
    expect(screen.queryByTestId('history-unlabeled')).toBeNull()
  })

  test('后端有动作没登记中文名时，抽屉里汇总一句——不靠一行行读那句 text', async () => {
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
                  // 没登记时后端给 null，**绝不回退成 snake_case 原值**
                  actionLabel: null,
                  result: { decision: 'allow' },
                  clientKind: 'console',
                  text: 'frobnicate（未登记标签）',
                },
              ],
              window: { since: 1, sinceSource: 'meetings', text: null },
              unlabeledActions: [
                { action: 'frobnicate', count: 1, hint: '这个动作在后端没有登记中文标签……' },
              ],
            },
          }
        : base(c)
    await openDrawer()
    const line = await screen.findByTestId('history-unlabeled')
    expect(line).toHaveTextContent(/frobnicate/)
    // 「上面显示的是 audit_log 里的原值」是在解释另一处 UI 怎么工作，
    // 不是这里要做的判断的依据——搬进 title，不是删掉
    expect(line.textContent).not.toMatch(/audit_log/)
    expect(line).toHaveAttribute('title', expect.stringContaining('audit_log 里的原值'))
    expect(screen.getByTestId('history-rows')).toHaveTextContent('未登记标签')
  })

  /* ── 连续重复的行折成一行 ──────────────────────────────────────

     dev 下 React 的 StrictMode 让每个 useResource 的 effect 跑两次，于是每次
     取数写两行审计（生产没有 StrictMode，不双写）。折叠是界面的事，但**次数
     和时间跨度一个都不能丢**：把「一分钟内取了两次」显示成「取了一次」正是
     审计页明令禁止的那件事（见 pages/Audit/AuditRow.tsx 文件头）。 */

  const MIN = 60

  function historyBody(rows: unknown[]): unknown {
    return {
      meeting: { id: 'm1', title: '产品周会', code: '881', startAt: nowSec(), source: 'meetings' },
      rows,
      window: { since: 1, sinceSource: 'meetings', text: null },
      unlabeledActions: [],
    }
  }

  function serveHistory(rows: unknown[]): void {
    const base = defaultHandler()
    handler = (c) =>
      /\/history$/.test(c.path) ? { status: 200, body: historyBody(rows) } : base(c)
  }

  /** 整分钟基准。fmtDateTime 只到分钟，带上秒会让"是否同一分钟"随运行时刻漂移 */
  function minuteBase(): number {
    return Math.floor(Date.now() / 1000 / MIN) * MIN
  }

  const hm = (s: string): string => s.slice(s.lastIndexOf(' ') + 1)

  test('连续几十行一模一样折成一行，右侧写明发生了几次', async () => {
    const t0 = minuteBase()
    const same = '管理员 查看被规则禁止采集的会议内容 · 准许'
    serveHistory([
      { id: 9, at: t0 - 10 * MIN, actionLabel: '查看', result: { decision: 'allow' }, clientKind: 'console', text: same },
      { id: 8, at: t0 - 11 * MIN, actionLabel: '查看', result: { decision: 'allow' }, clientKind: 'console', text: same },
      { id: 7, at: t0 - 12 * MIN, actionLabel: '查看', result: { decision: 'allow' }, clientKind: 'console', text: same },
      { id: 6, at: t0 - 30 * MIN, actionLabel: '归档', result: { decision: 'allow' }, clientKind: 'sys', text: '归档成功，19 个文件' },
    ])
    await openDrawer()
    const rows = await screen.findByTestId('history-rows')
    const items = within(rows).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // 折叠掉而不说发生了几次，等于把审计记录抹掉
    expect(items[0]!).toHaveTextContent('×3')
    // 没折叠的那一行不许凭空多一个 ×1
    expect(items[1]!.textContent).not.toMatch(/×/)
  })

  test('折叠后的时刻是组里最早的那一条；跨了分钟就显示成区间', async () => {
    const t0 = minuteBase()
    const same = '管理员 查看被规则禁止采集的会议内容 · 准许'
    serveHistory([
      { id: 9, at: t0 - 10 * MIN, actionLabel: '查看', result: { decision: 'allow' }, clientKind: 'console', text: same },
      { id: 8, at: t0 - 12 * MIN, actionLabel: '查看', result: { decision: 'allow' }, clientKind: 'console', text: same },
      // 同一分钟内的两条（t0 是整分钟，所以 +51s / +20s 落在同一分钟里）：
      // 区间两端会渲染成同一个串，那时不该多出一个破折号
      { id: 5, at: t0 - 40 * MIN + 51, actionLabel: '查看', result: { decision: 'allow' }, clientKind: 'console', text: '另一句' },
      { id: 4, at: t0 - 40 * MIN + 20, actionLabel: '查看', result: { decision: 'allow' }, clientKind: 'console', text: '另一句' },
    ])
    await openDrawer()
    const rows = await screen.findByTestId('history-rows')
    const items = within(rows).getAllByRole('listitem')
    const spanned = within(items[0]!).getByTestId('history-at').textContent ?? ''
    // 最早的在前——显示一个时刻却掩掉两分钟的跨度是这一页最不能做的事
    expect(spanned.startsWith(fmtDateTime(t0 - 12 * MIN))).toBe(true)
    expect(spanned).toContain('–')
    expect(spanned.endsWith(hm(fmtDateTime(t0 - 10 * MIN)))).toBe(true)

    const oneMinute = within(items[1]!).getByTestId('history-at').textContent ?? ''
    expect(oneMinute).toBe(fmtDateTime(t0 - 40 * MIN))
  })

  test('一组里只要有一条被拒，整组仍然标红', async () => {
    const t0 = minuteBase()
    // 后端眼下把判定结果拼进了 text，deny 与 allow 因此折不进同一组——
    // 这里刻意造出「text 相同、判定不同」，就是不许实现依赖那个巧合
    const same = '知识库索引器 取用 AI 纪要'
    serveHistory([
      { id: 3, at: t0 - MIN, actionLabel: '签发下载链接', result: { decision: 'allow' }, clientKind: 'program', text: same },
      { id: 2, at: t0 - 2 * MIN, actionLabel: '签发下载链接', result: { decision: 'deny' }, clientKind: 'program', text: same },
    ])
    await openDrawer()
    const rows = await screen.findByTestId('history-rows')
    const items = within(rows).getAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(items[0]!).toHaveAttribute('data-deny', 'true')
    expect(items[0]!).toHaveTextContent('×2')
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

  /**
   * 阶段 7 把这条搬了家但没有放松。
   *
   * 「归档失败 ≠ 未归档」此前钉在「本地保留」那一格上（`.keepNone[data-fail]`
   * 是红的）。现在那一格统一只说「未计时」——**成因不在这里答了**，它由
   * 「拉取 · 归档」那一栏的异常注记回答，而且答得比原来响：红字 + 红方块 +
   * 一道行首色条。同一件事在一行里红两次，红就不再是"最严重"的意思。
   *
   * 所以这条断言换的是位置，不是强度：归档失败仍然必须是**这一行里唯一被
   * 染红的那件事**，而单纯没归档的行一点红都不许有。
   */
  test('归档失败是红的；未归档不是（两件事，不能同一个灰也不能同一个红）', async () => {
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    expect(rowCss).toMatch(/\.note\[data-tone='fail'\]\s*\{\s*color:\s*var\(--fail\)/)
    expect(rowCss).toMatch(/\.sq\[data-state='failed'\]\s*\{\s*background:\s*var\(--fail\)/)
    handler = defaultHandler([M3, M2])
    renderPage()
    await waitFor(() => expect(screen.getByTestId('row-m3')).toBeInTheDocument())

    // m3 归档失败：一句红字 + 一道红色行首色条
    expect(screen.getByTestId('stage-m3')).toHaveTextContent('归档失败')
    expect(screen.getByTestId('stage-m3').querySelector('[data-tone="fail"]')).not.toBeNull()
    expect(screen.getByTestId('row-m3')).toHaveAttribute('data-flag', 'fail')

    // m2 归档成功：一个字都不写，也没有色条
    expect(screen.getByTestId('stage-m2').textContent).toBe('')
    expect(screen.getByTestId('row-m2')).not.toHaveAttribute('data-flag')

    // 「本地保留」那一格不再替它说第二遍——那正是"红两次"的来源
    expect(screen.getByTestId('keep-m3')).toHaveTextContent('未计时')
    expect(screen.getByTestId('keep-m3').querySelector('[data-tone="fail"]')).toBeNull()
  })

  test('「＋30 天」平时不占位，hover / 键盘光标才浮出来', () => {
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    expect(rowCss).toMatch(/\.extendBtn\s*\{[^}]*opacity:\s*0/)
    expect(rowCss).toMatch(/tr:hover \.extendBtn[^{]*\{\s*opacity:\s*1/)
  })
})

/* ── 窄屏卡片化（spec §11 缺口 2）───────────────────────────────── */

describe('窄屏一行一张卡片', () => {
  test('每个数据格都带 data-label——卡片形态下 thead 不渲染，列名靠它', async () => {
    renderPage()
    await ready()
    const row = screen.getByTestId('row-m1')
    const cells = [...row.querySelectorAll('td')]
    // 前两格（勾选框、标题）与最后一格（详情箭头）本来就不需要列名
    const needLabel = cells.slice(2, -1)
    expect(needLabel.length).toBe(5)
    expect(needLabel.map((td) => td.getAttribute('data-label'))).toEqual([
      '主持人',
      '资产',
      '拉取 · 归档',
      '本地保留',
      '可取走的程序',
    ])
  })

  test('表格开着 cards 开关，且窄屏下把 1020 的最小宽度卸掉', () => {
    const tableCss = css('src/ui/Table.module.css')
    expect(tableCss).toMatch(/@media \(max-width: 56em\)/)
    expect(tableCss).toMatch(/content: attr\(data-label\)/)
    // 逼出横滚的就是这个下限，卡片形态下必须卸掉
    const mtCss = css('src/pages/Meetings/MeetingTable.module.css')
    expect(mtCss).toMatch(/@media \(max-width: 56em\)[\s\S]*min-width:\s*0/)
  })

  test('批量条不再心算居中——那是 375px 下被挤成竖柱的根因', () => {
    const barCss = css('src/pages/Meetings/BatchBar.module.css')
    expect(stripComments(barCss)).not.toMatch(/calc\(50% \+ var\(--rail-w\)/)
    expect(barCss).toMatch(/margin-inline:\s*auto/)
  })

  test('触屏没有 hover：「＋30 天」与详情箭头在窄屏常驻', () => {
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    expect(rowCss).toMatch(/@media \(max-width: 56em\)[\s\S]*\.extendBtn,\s*\n\s*\.detailBtn\s*\{\s*\n\s*opacity:\s*1/)
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

  /**
   * **键盘绕得过按钮**：spec §9 的 `e` / `1` / `2` / `3` 不看按钮的 disabled。
   * 只禁按钮不管键位，只读账号敲一下就会发出一条注定 403 的请求。
   * 这几条盯的就是那个洞。
   */
  test('键位 e（延长保留）不发请求，并且说清为什么', async () => {
    await readonlyReady()
    const before = calls.filter((c) => c.method !== 'GET').length
    await userEvent.keyboard('e')
    expect(await screen.findByRole('status')).toHaveTextContent('只读角色')
    expect(calls.filter((c) => c.method !== 'GET').length).toBe(before)
  })

  test('键位 1 / 2（改阶段）与 3（授权）同样不发请求', async () => {
    await readonlyReady()
    const before = calls.filter((c) => c.method !== 'GET').length
    await userEvent.keyboard('1')
    await userEvent.keyboard('2')
    await userEvent.keyboard('3')
    expect(calls.filter((c) => c.method !== 'GET').length).toBe(before)
    // 授权面板也不该被打开——一个点不动的面板比不打开更糟。
    // 浮层始终挂载（进出场要播动画），所以看的是 data-state 而不是有没有这个节点。
    for (const d of screen.queryAllByRole('dialog')) {
      expect(d).toHaveAttribute('data-state', 'closed')
    }
  })

  test('只读的拒绝是"说一句"，不是静默——点了没反应比慢一点更糟', async () => {
    await readonlyReady()
    await userEvent.keyboard('e')
    const said = await screen.findByRole('status')
    expect(said).toHaveTextContent('管理员')
  })

  test('管理员敲同一个键照常发请求（回归：别把所有人都挡住）', async () => {
    renderPage()
    await ready()
    await userEvent.keyboard('e')
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/extend'))).toBe(true)
    })
  })
})

/* ══════════════════════════════════════════════════════════════════
   阶段 6 · 信息设计（拿 77 场真实会议跑出来的那批问题）
   ══════════════════════════════════════════════════════════════════ */

/** 真实数据里主持人那一列长这样：一串 32 位机器 id，每一行都是 */
const REAL_HOST = 'woaJARCQAAt_hKBw--YKZeVjEaIMGFQQ'

describe('主持人这一列不再是 32 位机器 id', () => {
  test('查不到姓名时不把主键当人名摆上去，但两个不同的主持人仍然区分得开', async () => {
    // 身份映射表目前 0 行，所以 hostName 恒为 null——**这就是当前唯一会跑到的路径**
    handler = defaultHandler([
      meeting({ id: 'm1', meetingId: 'm1', host: REAL_HOST, hostName: null }),
      meeting({
        id: 'm2',
        meetingId: 'm2',
        title: '技术评审',
        host: 'woaJARCQAAt_hKBw--YKZeVjEaIMlj1lkQ',
        hostName: null,
      }),
    ])
    renderPage()
    await ready()

    const a = screen.getByTestId('host-m1')
    const b = screen.getByTestId('host-m2')

    // 这条是这一轮的硬判据：渲染出来的东西**不能是那串 id 原样**
    expect(a.textContent).not.toBe(REAL_HOST)
    expect(a).not.toHaveTextContent(REAL_HOST)
    expect(a).toHaveTextContent('未知主持人')

    // 但一屏之内两个不同的主持人必须分得开——否则勾选之前判断不了
    // "这几场是不是同一个人主持的"
    expect(a.textContent).not.toBe(b.textContent)

    // 全量 id 仍然够得着（title 可复制），排查时只有它有用
    expect(a).toHaveAttribute('title', expect.stringContaining(REAL_HOST))
  })

  test('后端解析到姓名时就显示姓名，id 退到 title 里', async () => {
    handler = defaultHandler([meeting({ host: REAL_HOST, hostName: 'zhang.san' })])
    renderPage()
    await ready()

    const cell = screen.getByTestId('host-m1')
    expect(cell).toHaveTextContent('zhang.san')
    expect(cell).not.toHaveTextContent('未知主持人')
    expect(cell).toHaveAttribute('title', expect.stringContaining(REAL_HOST))
  })

  test('库里压根没有主持人：说「未取到」，不是一个破折号也不是空白', async () => {
    handler = defaultHandler([meeting({ host: '', hostName: null, missing: ['host'] })])
    renderPage()
    await ready()
    const cell = screen.getByTestId('host-m1')
    expect(cell).toHaveTextContent('未取到')
    expect(cell.textContent).not.toBe('—')
  })

  test('后端没下发 hostName 这个字段时按「查不到」处理，不是整页读取失败', async () => {
    const raw = meeting({ host: REAL_HOST })
    delete (raw as Record<string, unknown>).hostName
    handler = defaultHandler([raw])
    renderPage()
    await ready()
    expect(screen.getByTestId('host-m1')).toHaveTextContent('未知主持人')
  })
})

/**
 * 阶段 7：这一栏从「两行文字」压成「两个方块 + 只在出问题时才出现的一句话」。
 *
 * 阶段 6 把三个没有图例的圆点换成文字，解决的是"读不懂"；这一轮解决的是
 * "读得懂但没人读"——59 场里 50 多场那两行文字逐字相同，一行 62px 有一半
 * 花在复述"一切正常"上。
 *
 * **压缩不许拿无障碍抵账**。下面这几条盯的就是这件事：方块不是可读内容，
 * 每一行的状态必须仍然有一段说得清的文字给读屏软件。所以此前查可见文字的
 * 断言全部改成查**无障碍名**，一条都没有删。
 */
describe('「拉取 · 归档」正常态一个字都不写，语义一个字都不少', () => {
  test('正常态：这一格没有任何可见文字，但两个方块各带一句完整的可读文本', async () => {
    renderPage()
    await ready()
    const cell = screen.getByTestId('stage-m1')
    // m1 是 fetch: done / archive: done —— 正常态，一个字都不写
    expect(cell.textContent).toBe('')
    // 语义走无障碍名，与压缩之前那两行文字逐字同形
    expect(within(cell).getByRole('button', { name: '拉取：已完成' })).toBeInTheDocument()
    expect(within(cell).getByRole('button', { name: '归档：已完成' })).toBeInTheDocument()
    // 方块自己不可读（它是 aria-hidden 的图形），可读文本在外层
    expect(cell.querySelectorAll('[aria-hidden="true"][data-state]')).toHaveLength(2)
  })

  test('归档失败那一行把「失败」写出来：可见的一句红字 + 完整的无障碍名', async () => {
    renderPage()
    await ready()
    const cell = screen.getByTestId('stage-m3')
    // 无障碍名照旧说得出"失败"两个字
    expect(within(cell).getByRole('button', { name: '归档：失败' })).toBeInTheDocument()
    // 眼睛也读得到：异常才补文字，而且是红的
    expect(cell).toHaveTextContent('归档失败')
  })

  test('人工改写过的阶段把「人工」写出来，不只靠一圈琥珀', async () => {
    handler = defaultHandler([meeting({ fetch: 'off', hand: ['fetch'] })])
    renderPage()
    await ready()
    // 无障碍名里的「人工改写」一个字没少
    expect(
      within(screen.getByTestId('row-m1')).getByRole('button', {
        name: '拉取：未执行 · 人工改写',
      }),
    ).toBeInTheDocument()
    // 可见的那句话也在——它就是"异常才写字"里的一种异常
    expect(screen.getByTestId('stage-m1')).toHaveTextContent('人工设为不拉取')
  })

  test('异常行挂行首色条，不是整行变红', async () => {
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    expect(rowCss).toMatch(/\.row\[data-flag='fail'\] td:first-child\s*\{\s*box-shadow:\s*inset/)
    expect(rowCss).toMatch(/\.row\[data-flag='warn'\] td:first-child\s*\{\s*box-shadow:\s*inset/)
    // 整行变红的写法（给 tr 上底色）不许回来
    expect(stripComments(rowCss)).not.toMatch(/\[data-flag[^{]*\{[^}]*background/)

    handler = defaultHandler([M3, M2])
    renderPage()
    await waitFor(() => expect(screen.getByTestId('row-m3')).toBeInTheDocument())
    expect(screen.getByTestId('row-m3')).toHaveAttribute('data-flag', 'fail')
    expect(screen.getByTestId('row-m2')).not.toHaveAttribute('data-flag')
  })

  test('stageNote：正常态返回 null，异常按"最贵的那件事"排序', () => {
    const base = meeting() as unknown as Parameters<typeof stageNote>[0]
    expect(stageNote(base)).toBeNull()
    expect(stageNote({ ...base, archive: 'failed' })).toEqual({ text: '归档失败', tone: 'fail' })
    // 读不懂后端排在人工改写之前：那是一个我们没有的结论
    expect(stageNote({ ...base, fetch: 'teleported' })?.text).toBe('拉取未知')
    expect(stageNote({ ...base, fetch: 'off', hand: ['fetch'] })).toEqual({
      text: '人工设为不拉取',
      tone: 'warn',
    })
    expect(stageNote({ ...base, fetch: 'none' })).toEqual({ text: '无录制', tone: 'neutral' })
    // 归档失败盖过一切——一格只放得下一句
    expect(stageNote({ ...base, fetch: 'none', archive: 'failed' })?.text).toBe('归档失败')
  })

  test('rowFlag：只有归档失败与七天内到期配得上色条；人工改写不挂条', () => {
    const now = new Date()
    const base = meeting() as unknown as Parameters<typeof rowFlag>[0]
    expect(rowFlag(base, now)).toBeNull()
    expect(rowFlag({ ...base, archive: 'failed' }, now)).toBe('fail')
    expect(rowFlag({ ...base, fetch: 'off', hand: ['fetch'] }, now)).toBeNull()
    const soon = { ...base, keep: { ...base.keep, expiresAt: Math.floor(now.getTime() / 1000) + 2 * DAY } }
    expect(rowFlag(soon, now)).toBe('warn')
    // 本地文件已经清理掉了就不存在"快到期"这回事
    expect(rowFlag({ ...soon, keep: { ...soon.keep, filesGone: true } }, now)).toBeNull()
  })

  test('页面底部那块圆点图例删掉了——格子自己说清楚了就不需要对照表', async () => {
    renderPage()
    await ready()
    const src = css('src/pages/Meetings/index.tsx')
    expect(stripTs(src)).not.toMatch(/function Legend\(/)
    // 图例里那句"到期会永久丢失"是它独有的文案，页面上不该再有第二处
    expect(screen.queryByText('失败 · 到期会永久丢失')).toBeNull()
  })
})

describe('「可取走的程序」：列头与格子回答同一个命题', () => {
  test('列头不再问"授权给了谁"——那是格子答不上来的问题', async () => {
    renderPage()
    await ready()
    expect(screen.getByRole('columnheader', { name: '可取走的程序' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: '已授权给' })).toBeNull()
  })

  test('规则禁止是默认态，用极淡的行内灰字，不占任何标记', async () => {
    handler = defaultHandler([meeting({ allow: 'deny', grants: [] })])
    renderPage()
    await ready()
    const cell = screen.getByTestId('grant-m1')
    expect(cell).toHaveTextContent('规则禁止')
    // 标记那种强调留给真的有授权的行——最常见的默认态不许占最强的视觉重量。
    // （阶段 7：pill 换成了 24×20 的两字母标记，这条断言跟着换成"一个标记都没有"）
    expect(within(cell).queryAllByRole('button')).toHaveLength(0)
  })

  /**
   * 阶段 7：蓝色 pill + `＋` 按钮 + 虚线「＋ 授权给…」三种形态表达同一件事，
   * 统一成一枚 24×20 的两字母等宽标记 + 一个虚线 `＋`。
   *
   * **缩写必须可回溯**：从程序的 key 派生，不是前端存的一张中文名对照表。
   */
  test('真的有授权的行给一枚两字母标记，全名在 title 上', async () => {
    renderPage()
    await ready()
    const cell = screen.getByTestId('grant-m1')
    const mark = within(cell).getByRole('button', {
      name: /收回 知识库索引器 对「产品周会」的授权/,
    })
    // kb-indexer → KB。缩写从 key 派生，不从中文名查表
    expect(mark).toHaveTextContent('KB')
    // 全名不许只活在缩写里——悬停就有
    expect(mark).toHaveAttribute('title', expect.stringContaining('知识库索引器'))
    // 末尾那个虚线 ＋ 仍然是"再加一个"的入口
    expect(within(cell).getByRole('button', { name: /再给「产品周会」授权一个采集程序/ })).toBeInTheDocument()
  })

  test('缩写派生不出来就退回完整程序名——不瞎缩', async () => {
    handler = (c) => {
      if (c.method === 'GET' && c.path === '/api/v1/admin/programs') {
        // 纯中文 id：切出来一段合法的 ASCII 都没有，派生不出两个字母
        return { status: 200, body: [{ ...PROGRAMS[0], id: '知识库', name: '知识库索引器' }] }
      }
      return defaultHandler([meeting({ grants: ['知识库'] })])(c)
    }
    renderPage()
    await ready()
    const cell = screen.getByTestId('grant-m1')
    const mark = within(cell).getByRole('button', { name: /收回 知识库索引器 对「产品周会」的授权/ })
    // 退回全名，而不是编一个谁也对不上号的两字母标记
    expect(mark).toHaveTextContent('知识库索引器')
    expect(mark).toHaveAttribute('data-full', 'true')
  })

  test('programAbbr：规则可回溯，且派生不出来时是 null 而不是瞎猜', () => {
    // 第一段恰好两个字符 → 它本来就是缩写，直接用（拆首字母会得到 KI / DS）
    expect(programAbbr('kb-indexer')).toBe('KB')
    expect(programAbbr('dw-sync')).toBe('DW')
    // 否则取前两段的首字母
    expect(programAbbr('daily-digest')).toBe('DD')
    expect(programAbbr('nas_archive_sync')).toBe('NA')
    // 只有一段就取前两个字符
    expect(programAbbr('archiver')).toBe('AR')
    // 派生不出来的一律 null——调用方据此退回完整程序名
    expect(programAbbr('知识库')).toBeNull()
    expect(programAbbr('a')).toBeNull()
    expect(programAbbr('')).toBeNull()
  })
})

/**
 * 阶段 7：进度条整根删掉了。
 *
 * 阶段 6 修的是"条画反了"（画成已用，于是一整列几乎空的浅条在对绝大多数行
 * 说反话）。这一轮把条本身去掉，理由是两条：它复述右边那个数（一列 50 根条，
 * 每根都在说同一件事），而且**贴在数字下面的横条会被读成下划线**——眼睛先把
 * 它当成"这个数被标了重点"。
 *
 * 剩下的就是一个右对齐的等宽天数。下面两条盯的仍然是同一个意图：这一格说的
 * 话必须和事实一致（刚归档＝还剩很多、快到期＝该看一眼），外加一条新的：
 * 那根会说反话的条不许回来。
 */
describe('「本地保留」是一个右对齐的等宽天数，不是一根会说反话的条', () => {
  test('刚归档 = 还剩很多，而且这一格里没有任何进度条', async () => {
    const archivedAt = nowSec() - 60 // 一分钟前刚归档
    handler = defaultHandler([
      meeting({
        keep: {
          archivedAt,
          expiresAt: archivedAt + 30 * DAY,
          extended: 0,
          extendedSource: 'none',
          extendedDays: 0,
          retentionDays: 30,
          filesGone: false,
        },
      }),
    ])
    renderPage()
    await ready()

    const cell = screen.getByTestId('keep-m1')
    expect(cell).toHaveTextContent('30 天')
    // 刚归档不是"快到期"，不上琥珀，整行也不挂色条
    expect(cell.querySelector('[data-soon="true"]')).toBeNull()
    expect(screen.getByTestId('row-m1')).not.toHaveAttribute('data-flag')
    // 那根复述天数、又会被读成下划线的条不许回来
    expect(within(cell).queryByRole('progressbar')).toBeNull()
    expect(css('src/pages/Meetings/MeetingRow.tsx')).not.toMatch(/ProgressBar/)
  })

  test('快到期 = 天数转琥珀，并且整行挂一道琥珀色条', async () => {
    const archivedAt = nowSec() - 27 * DAY
    handler = defaultHandler([
      meeting({
        keep: {
          archivedAt,
          expiresAt: archivedAt + 30 * DAY,
          extended: 0,
          extendedSource: 'none',
          extendedDays: 0,
          retentionDays: 30,
          filesGone: false,
        },
      }),
    ])
    renderPage()
    await ready()
    const cell = screen.getByTestId('keep-m1')
    expect(cell).toHaveTextContent('3 天')
    expect(cell.querySelector('[data-soon="true"]')).not.toBeNull()
    // 琥珀＝保留期快到了，这是它在这一栏唯一被允许的含义
    expect(css('src/pages/Meetings/MeetingRow.module.css')).toMatch(
      /\.keepLeft\[data-soon='true'\]\s*\{\s*color:\s*var\(--warn\)/,
    )
    // 余光里也看得见：整行挂一道琥珀色条
    expect(screen.getByTestId('row-m1')).toHaveAttribute('data-flag', 'warn')
    // 完整的一句话（还剩几天、哪天到期）在原生 title 上，不占版面
    expect(cell.querySelector('[data-soon="true"]')).toHaveAttribute(
      'title',
      expect.stringContaining('本地文件还剩 3 天'),
    )
  })
})

/**
 * 阶段 7：五张统计卡 → 一条分段筛选。
 *
 * 阶段 6 的处置是「0 不配占一整张卡」，把计数为 0 的格子折叠成一行细字。
 * **卡片没有了，那条理由跟着没有了**：一段 0 在这条 42px 的横条上只占约 80px
 * 宽，而折叠会让分段的数量随数据变化——同一个筛选器每次进来位置都不一样，
 * 那比一个 0 贵得多。折叠因此删掉，它守的两件事换成下面这几条守：
 *   · 0 仍然不许占强调色（`data-tone="zero"`）；
 *   · 0 仍然是一个点得动的筛选项；
 *   · 读不到（「？」）与 0 仍然是两件事。
 */
describe('分诊条：一条分段筛选，不是五张统计卡', () => {
  const oneNonZero = { archiveFailed: 1, expiringIn7d: 0, awaitingGrant: 0, inProgress: 0, nasOnly: 0 }

  function withTriage(counts: Record<string, number>): (c: Call) => Reply | undefined {
    const base = defaultHandler()
    return (c) =>
      c.path === '/api/v1/admin/meetings/triage' ? { status: 200, body: counts } : base(c)
  }

  test('计数为 0 的段照旧在条上、点得动，但不占强调色', async () => {
    handler = withTriage(oneNonZero)
    renderPage()
    await ready()

    // 非零的「归档失败」拿到语义色
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('1')
    expect(screen.getByTestId('triage-archfail')).toHaveAttribute('data-tone', 'fail')

    for (const id of ['soon', 'ungranted', 'running', 'nasonly']) {
      // 数字还在（0 不是"不知道"，它是一个事实）
      expect(screen.getByTestId(`triage-count-${id}`)).toHaveTextContent('0')
      // 但 0 不是一次告警，不许染红/染琥珀
      expect(screen.getByTestId(`triage-${id}`)).toHaveAttribute('data-tone', 'zero')
      // 仍然是筛选项，点得动
      expect(screen.getByTestId(`triage-${id}`)).toBeEnabled()
    }
  })

  test('计数为 0 的段照样能点出筛选', async () => {
    handler = withTriage(oneNonZero)
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByTestId('triage-nasonly'))
    await waitFor(() => expect(lastQuery('/api/v1/admin/meetings')?.get('triage')).toBe('nasOnly'))
  })

  test('五段全是 0 时仍然是五段——分段的位置不随数据变', async () => {
    handler = withTriage({ archiveFailed: 0, expiringIn7d: 0, awaitingGrant: 0, inProgress: 0, nasOnly: 0 })
    renderPage()
    await ready()
    for (const def of TRIAGE_DEFS) {
      expect(screen.getByTestId(`triage-count-${def.id}`)).toHaveTextContent('0')
      expect(screen.getByTestId(`triage-${def.id}`)).toHaveAttribute('data-tone', 'zero')
    }
  })

  test('计数读不到时显示「？」并且不上语义色——"？"不是 0', async () => {
    const base = defaultHandler()
    handler = (c) =>
      c.path === '/api/v1/admin/meetings/triage' ? { status: 500, body: { error: 'boom' } } : base(c)
    renderPage()
    await ready()
    await waitFor(() => expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('？'))
    expect(screen.getByTestId('triage-count-archfail')).not.toHaveTextContent('0')
    // 那个"？"不是一次告警，是一次未知
    expect(screen.getByTestId('triage-archfail')).toHaveAttribute('data-tone', 'zero')
    // 这一句是故障，不是口径说明，所以它露出来
    expect(screen.getByTestId('triage-scope')).toHaveAttribute('data-visible', 'true')
  })

  test('选中态同一时刻只有一个，而且是底部色条不是填充块', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const pressed = () =>
      TRIAGE_DEFS.filter(
        (d) => screen.getByTestId(`triage-${d.id}`).getAttribute('aria-pressed') === 'true',
      )
    expect(pressed()).toHaveLength(0)

    await user.click(screen.getByTestId('triage-archfail'))
    await waitFor(() => expect(pressed()).toHaveLength(1))
    await user.click(screen.getByTestId('triage-nasonly'))
    await waitFor(() => expect(pressed().map((d) => d.id)).toEqual(['nasonly']))
    // 再点一次取消，一个都不选也是合法状态（= 不筛）
    await user.click(screen.getByTestId('triage-nasonly'))
    await waitFor(() => expect(pressed()).toHaveLength(0))

    const barCss = css('src/pages/Meetings/TriageBar.module.css')
    // 选中态＝底部一道 2px 色条。填充块会把这条横条读成五枚按钮
    expect(barCss).toMatch(/\.seg\[aria-pressed='true'\]\s*\{[^}]*border-bottom-color:\s*var\(--ink\)/)
    expect(stripComments(barCss)).not.toMatch(/\.seg\[aria-pressed='true'\]\s*\{[^}]*background:/)
  })

  test('「一次只能筛一格」那句话仍然不在，口径说明也不再按正文排', async () => {
    renderPage()
    await ready()
    const scope = screen.getByTestId('triage-scope')
    expect(scope).not.toHaveTextContent('一次只能筛一格')
    // 口径说明不占版面：视觉隐藏（读屏仍然念得到，走 aria-describedby）
    expect(scope).not.toHaveAttribute('data-visible')
    expect(screen.getByTestId('triage-bar')).toHaveAttribute('aria-describedby', scope.id)
    const barCss = css('src/pages/Meetings/TriageBar.module.css')
    expect(barCss).toMatch(/\.scope\s*\{[^}]*clip-path:\s*inset\(50%\)/)
    // 同一句话在每一段自己的 title 里也拿得到——鼠标那一路
    expect(screen.getByTestId('triage-archfail')).toHaveAttribute(
      'title',
      expect.stringContaining('不受下面的搜索、筛选与分页影响'),
    )
  })

  test('一条分段条，不是五张卡：不再有卡片那套白底 + 边框 + 圆角', () => {
    const barCss = stripComments(css('src/pages/Meetings/TriageBar.module.css'))
    expect(barCss).not.toMatch(/\.card\b/)
    // 分段自己不画背景、不画边框、不画圆角——它靠底部那条基线成形
    const seg = /\.seg \{[^}]*\}/.exec(barCss)?.[0] ?? ''
    expect(seg).toMatch(/background:\s*none/)
    expect(seg).not.toMatch(/border-radius/)
  })
})

describe('页头与工具条：不用文案补可供性', () => {
  test('「点标题看录像与纪要内容」删了，标题自己长成可点的样子', async () => {
    renderPage()
    await ready()
    expect(screen.queryByText(/点标题看录像与纪要内容/)).toBeNull()
    // 可供性落在样式上：静止状态就带下划线，不是只有 hover 才像链接
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    const title = /\.title \{[^}]*\}/.exec(rowCss)?.[0] ?? ''
    expect(title).toMatch(/text-decoration:\s*underline/)
  })

  /**
   * 阶段 7：页头那句副标题降级成脚注。
   *
   * 它是一条**制度说明**（"本地会删、NAS 不删"），一个月不变，读者一辈子只
   * 需要读一次，却按正文排在标题正下方——整页信息密度最高的那条横线上方。
   * 删不得（不知道这件事的人会把「仅存 NAS」读成"数据丢了"），所以是降级：
   * 挪到它解释的那两列下面，小一号、次要色。
   */
  test('页头那句制度说明降级成表格下面的脚注，不再按正文排在标题下', async () => {
    renderPage()
    await ready()
    const note = screen.getByTestId('lifecycle-note')
    // 一个字都没删
    expect(note).toHaveTextContent('归档到 NAS 之后本地文件还会留一段时间')
    expect(note).toHaveTextContent('记录与 NAS 路径永久保留')

    // 但它不在页头里了——这一页现在**根本没有页头**：`ui/PageShell` 只在有
    // 说明或有主操作时才画那条带子，两样都没有的会议记录页连 `<header>` 都不出，
    // 顶栏底下那 36px 空带跟着没了（见 `tests/pages/shells.test.tsx`）。
    const h1 = screen.getByRole('heading', { name: '会议记录', level: 1 })
    expect(h1.closest('header'), '会议记录又长回一条页头').toBeNull()
    // 位置在表格之后
    const table = screen.getByRole('table')
    expect(table.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // 排版是脚注不是正文：最小字号 + 次要色
    expect(css('src/pages/Meetings/Meetings.module.css')).toMatch(
      /\.lifecycleNote\s*\{[^}]*font-size:\s*var\(--t-2xs\)/,
    )
  })

  test('搜索框的键位提示不再是 placeholder 尾巴上那个孤立的斜杠', async () => {
    renderPage()
    await ready()
    const box = screen.getByLabelText('搜索会议')
    expect(box.getAttribute('placeholder')).toBe('搜标题 / 会议号 / 主持人')
    // 提示挪成输入框右侧独立的一枚 <kbd>，位置由布局定，不由空格数定
    const src = css('src/pages/Meetings/index.tsx')
    expect(src).toMatch(/<kbd/)
    expect(stripTs(src)).not.toMatch(/placeholder="[^"]*  /)
  })
})

describe('操作历史 · 连续重复怎么折（纯函数）', () => {
  const NOW = new Date(2026, 7, 31, 15, 0, 0)
  const at = (d: number, h: number, m: number, sec = 0): number =>
    Math.floor(new Date(2026, 7, d, h, m, sec).getTime() / 1000)

  const row = (id: number, atSec: number, text: string, decision: string | null = 'allow') => ({
    id,
    at: atSec,
    text,
    actionLabel: '查看',
    decision,
    clientKind: 'console',
  })

  test('只折连续的：中间夹了别的行就不折——顺序是审计的一部分', () => {
    const g = groupHistory([
      row(4, at(31, 14, 20), 'A'),
      row(3, at(31, 14, 19), 'B'),
      row(2, at(31, 14, 18), 'A'),
      row(1, at(31, 14, 17), 'A'),
    ])
    expect(g.map((x) => [x.text, x.count])).toEqual([
      ['A', 1],
      ['B', 1],
      ['A', 2],
    ])
  })

  test('key 用这一组第一行的 id，两端时刻取组里的极值', () => {
    const g = groupHistory([
      row(9, at(31, 14, 25), 'A'),
      row(8, at(31, 14, 18), 'A'),
      row(7, at(31, 14, 21), 'A'),
    ])
    expect(g).toHaveLength(1)
    expect(g[0]!.id).toBe(9)
    expect(g[0]!.count).toBe(3)
    // 不靠"倒序列表的最后一行最早"这条排序约定，按 at 取极值
    expect(g[0]!.earliestAt).toBe(at(31, 14, 18))
    expect(g[0]!.latestAt).toBe(at(31, 14, 25))
  })

  test('一组里只要有 deny 就标红，不靠「deny 的 text 天然不同」这个巧合', () => {
    const g = groupHistory([row(2, at(31, 14, 20), 'A'), row(1, at(31, 14, 19), 'A', 'deny')])
    expect(g).toHaveLength(1)
    expect(g[0]!.deny).toBe(true)
    expect(groupHistory([row(1, at(31, 14, 19), 'A')])[0]!.deny).toBe(false)
  })

  test('空列表折出空列表', () => {
    expect(groupHistory([])).toEqual([])
  })

  test('同一分钟内只写一个时刻，跨了分钟必须写成区间', () => {
    const one = { earliestAt: at(31, 14, 18, 3), latestAt: at(31, 14, 18, 51) }
    expect(historyAtText(one, NOW)).toBe('8-31 14:18')

    const span = { earliestAt: at(31, 14, 18), latestAt: at(31, 14, 25) }
    expect(historyAtText(span, NOW)).toBe('8-31 14:18–14:25')
  })

  test('跨天时右端也写日期——只写时分会读成时间倒流', () => {
    const g = { earliestAt: at(30, 23, 59), latestAt: at(31, 0, 2) }
    expect(historyAtText(g, NOW)).toBe('8-30 23:59–8-31 00:02')
  })

  test('跨年时两端都带年份（fmtDateTime 的同年规则照旧生效）', () => {
    const nextYear = new Date(2027, 0, 5, 10, 0, 0)
    const g = { earliestAt: at(31, 14, 18), latestAt: at(31, 14, 25) }
    expect(historyAtText(g, nextYear)).toBe('2026-08-31 14:18–14:25')
  })
})
