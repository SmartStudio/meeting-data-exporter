import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { render, renderAsRole } from '../helpers/session'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { fmtDateTime, fmtDateTimeSec, fmtDayHeading, fmtTimeSec } from '../../src/lib/format'
import AuditPage from '../../src/pages/Audit'
import { AUDIT_DEFAULT_UI, AUDIT_RANGES, rangeOf, toQuery } from '../../src/pages/Audit/filters'

/* ── 假后端 ─────────────────────────────────────────────────────── */

let urls: string[] = []
let reply: (url: URL) => { status: number; body: unknown } = () => ({ status: 200, body: emptyPage() })

function installFetch(): void {
  urls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const raw = String(input)
      urls.push(raw)
      const { status, body } = reply(new URL(raw, 'http://x'))
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

function lastQuery(): URLSearchParams {
  return new URL(urls[urls.length - 1]!, 'http://x').searchParams
}

/** unix **秒**。挑一个当成毫秒读会掉进 1970 年的值，好让量纲错误一眼看得出来。 */
const AT = 1_756_000_000

function win(over: Record<string, unknown> = {}): unknown {
  return { from: AT - 7 * 86_400, to: null, isDefault: false, days: 7, text: null, ...over }
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    at: AT,
    actor: { kind: 'prog', type: 'service_account', id: 'kb-indexer' },
    action: 'issue_download_url',
    actionLabel: '签发下载链接',
    object: { id: 'm-1', idKind: 'meeting', meetingId: 'm-1', title: '产品周会', code: '881-123-40' },
    asset: { id: 'rec-1:f-1:ai_minutes:0', type: 'ai_minutes' },
    detail: '取走了 AI 纪要',
    result: { decision: 'allow', kind: 'allow', reason: null },
    matchedRuleId: null,
    clientKind: 'console',
    ...over,
  }
}

function pageOf(rows: Record<string, unknown>[], over: Record<string, unknown> = {}): unknown {
  return {
    rows,
    total: rows.length,
    limit: 50,
    offset: 0,
    window: win(),
    // 后端按动作汇总的「这一页有哪几种动作没登记中文名」（阶段 5 · A9）。
    // 全部登记过时是 `[]`，不是 null
    unlabeledActions: [],
    ...over,
  }
}

function emptyPage(): unknown {
  return pageOf([])
}

function serve(rows: Record<string, unknown>[], over: Record<string, unknown> = {}): void {
  reply = () => ({ status: 200, body: pageOf(rows, over) })
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/audit', element: <AuditPage /> },
      { path: '/preview/:id', element: <h1>内容预览占位</h1> },
    ],
    { initialEntries: ['/audit'] },
  )
  return render(<RouterProvider router={router} />)
}

/** 挂上页面并等第一批条目落地。`serve()` 要在它之前调。 */
async function ready(id = 1) {
  renderPage()
  return screen.findByTestId(`audit-row-${id}`)
}

/** 打开「精确筛选」面板（操作者 ID / 动作代码两个输入框收在里面）。 */
async function openExact(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /精确筛选/ }))
  return screen.findByRole('dialog', { name: '精确筛选' })
}

beforeEach(() => {
  installFetch()
  serve([row()])
})
afterEach(() => {
  vi.unstubAllGlobals()
  reply = () => ({ status: 200, body: emptyPage() })
})

/* ── 纯函数：筛选条件怎么翻成查询 ──────────────────────────────── */

describe('筛选条件 → 查询参数', () => {
  const NOW = 1_800_000_000

  test('时间范围一律换算成 from（unix 秒），不是天数', () => {
    const q = toQuery({ ...AUDIT_DEFAULT_UI, rangeId: 'd7' }, NOW)
    expect(q.from).toBe(NOW - 7 * 86_400)
  })

  test('上界也钉在锚点上 —— audit_log 一直在写，不钉的话翻页会重看一条、跳过一条', () => {
    // 半开区间 [from, to)，所以是 NOW + 1：恰好落在锚点那一秒的记录也要在里面
    expect(toQuery({ ...AUDIT_DEFAULT_UI }, NOW).to).toBe(NOW + 1)
    expect(toQuery({ ...AUDIT_DEFAULT_UI, rangeId: 'all' }, NOW).to).toBe(NOW + 1)
  })

  test('「全部时间」发 from=0，而不是干脆不发 —— 不发的话后端会兜一个看不见的 7 天窗口', () => {
    expect(toQuery({ ...AUDIT_DEFAULT_UI, rangeId: 'all' }, NOW).from).toBe(0)
  })

  test('三个色块多选；一个都不选时整个键不出现（空集合后端回 400）', () => {
    expect(toQuery({ ...AUDIT_DEFAULT_UI, actorKinds: [] }, NOW).actorKind).toBeUndefined()
    expect(toQuery({ ...AUDIT_DEFAULT_UI, actorKinds: ['prog', 'sys'] }, NOW).actorKind).toEqual(['prog', 'sys'])
  })

  test('只看被拒绝 → decision=deny；不勾时不筛（不是 decision=allow）', () => {
    expect(toQuery({ ...AUDIT_DEFAULT_UI, onlyDenied: true }, NOW).decision).toBe('deny')
    expect(toQuery({ ...AUDIT_DEFAULT_UI, onlyDenied: false }, NOW).decision).toBeUndefined()
  })

  test('动作按逗号拆成多值，空段丢掉；全空时整个键不出现', () => {
    expect(toQuery({ ...AUDIT_DEFAULT_UI, action: 'login, issue_download_url ,' }, NOW).action).toEqual([
      'login',
      'issue_download_url',
    ])
    expect(toQuery({ ...AUDIT_DEFAULT_UI, action: ' , ' }, NOW).action).toBeUndefined()
  })

  test('分页：第 3 页 = offset 2×每页；limit 是每页条数', () => {
    const q = toQuery({ ...AUDIT_DEFAULT_UI, page: 3, pageSize: 20 }, NOW)
    expect(q.limit).toBe(20)
    expect(q.offset).toBe(40)
  })

  test('每一个预设范围都认得出来，认不出的落回默认的近 7 天', () => {
    for (const r of AUDIT_RANGES) expect(rangeOf(r.id).id).toBe(r.id)
    expect(rangeOf('不存在的范围').id).toBe('d7')
  })
})

/* ── 一行长什么样 ───────────────────────────────────────────────── */

describe('审计条目', () => {
  test('时间按 unix 秒渲染、到秒 —— 当成毫秒会掉到 1970 年', async () => {
    const tr = await ready()
    // 行上只报当天的时刻（日期在分组行里），完整日期时间在 title 上
    const t = within(tr).getByText(fmtTimeSec(AT))
    expect(t).toHaveAttribute('title', fmtDateTimeSec(AT))
    expect(tr.textContent).not.toContain('1970')
    expect(screen.getByTestId('audit-day').textContent).toContain(fmtDayHeading(AT))
  })

  test('按天分组：跨天时插一行日期，但每一条仍然各占一行', async () => {
    serve([row({ id: 1, at: AT }), row({ id: 2, at: AT - 3 }), row({ id: 3, at: AT - 2 * 86_400 })])
    await ready()
    const days = screen.getAllByTestId('audit-day')
    expect(days).toHaveLength(2)
    expect(days[0]!.textContent).toContain(fmtDayHeading(AT))
    expect(days[1]!.textContent).toContain(fmtDayHeading(AT - 2 * 86_400))
    expect(screen.getAllByTestId(/^audit-row-/)).toHaveLength(3)
  })

  test('操作者带色块与 ID；库里的 actor_type 原值在 title 与展开区，不占行', async () => {
    const user = userEvent.setup()
    const tr = await ready()
    const who = within(tr).getByTestId('audit-actor-1')
    expect(who).toHaveAttribute('data-kind', 'prog')
    expect(who.textContent).toContain('kb-indexer')
    expect(within(who).getByTitle(/service_account/)).toBeInTheDocument()
    // 读屏能念到身份（色块里的字是 aria-hidden 的装饰）
    expect(who.textContent).toContain('程序')
    await user.click(within(tr).getByRole('button', { name: '完整记录' }))
    expect(screen.getByTestId('audit-expanded-1').textContent).toContain('service_account')
  })

  test('认不出的操作者身份不折成三种色块里的任何一种，原值照显示', async () => {
    serve([row({ actor: { kind: 'unknown', type: 'ghost', id: 'x' } })])
    const tr = await ready()
    const who = within(tr).getByTestId('audit-actor-1')
    expect(who).toHaveAttribute('data-kind', 'unknown')
    expect(who.textContent).toContain('ghost')
    expect(within(tr).getByText(/未知身份/)).toBeInTheDocument()
  })

  test('后端没登记中文名的动作显示原值，并说清那是原值——不留空也不藏起来', async () => {
    serve([row({ action: 'purge_expired', actionLabel: null })])
    const tr = await ready()
    expect(within(tr).getByText('purge_expired')).toBeInTheDocument()
    // 一行裸的 snake_case 读起来与一个真叫这名字的动作一模一样，
    // 于是漏登记永远不会被发现。措辞与 /history 那句「（未登记标签）」一致
    expect(within(tr).getByTestId('audit-unlabeled-1')).toHaveTextContent('未登记标签')
  })

  test('动作登记过时不出现那个标记；原值在 title 与展开区，不再占第二行', async () => {
    serve([row()])
    const user = userEvent.setup()
    const tr = await ready()
    expect(within(tr).queryByTestId('audit-unlabeled-1')).toBeNull()
    expect(within(tr).getByTitle('issue_download_url')).toHaveTextContent('签发下载链接')
    await user.click(within(tr).getByRole('button', { name: '完整记录' }))
    expect(screen.getByTestId('audit-expanded-1').textContent).toContain('issue_download_url')
  })

  test('对象：标题 + 会议号；能定位到会议时标题是通向内容预览的链接', async () => {
    const tr = await ready()
    const link = within(tr).getByRole('link', { name: /产品周会/ })
    expect(link).toHaveAttribute('href', '/preview/m-1')
    expect(within(tr).getByText('881-123-40')).toBeInTheDocument()
  })

  test('补不齐标题时说「标题缺失」，绝不拿 ID 冒充标题', async () => {
    serve([row({ object: { id: 'm-404', idKind: 'unknown', meetingId: null, title: null, code: null } })])
    const tr = await ready()
    expect(within(tr).getByText(/标题缺失/)).toBeInTheDocument()
    expect(within(tr).queryByRole('link')).toBeNull()
  })

  test('这次操作不针对某一场会议时说清楚，不是一个空格子', async () => {
    serve([row({ object: null })])
    const tr = await ready()
    expect(within(tr).getByText('无关联会议')).toHaveAttribute('title', expect.stringMatching(/不针对某一场会议/))
  })

  test('放行的结果是「准许」——默认值，不占视觉：这一行不带左侧色条', async () => {
    const tr = await ready()
    expect(within(tr).getByText('准许')).toBeInTheDocument()
    // 「结果」列的准许原来是一个灰底圆角框，和上面的筛选输入框长得一模一样。
    // 现在准许是纯文字：没有 data-flag 就没有 CSS 里那道左侧色条（Audit.module.css
    // 的 `tr[data-flag]`），它与拒绝/存疑唯一的区别就是这一个属性。
    expect(tr).not.toHaveAttribute('data-flag')
  })

  test('被拒绝的记录是红的，并写明拒绝原因（原因来自后端，不是前端编的），行左侧带色条', async () => {
    serve([
      row({
        result: { decision: 'deny', kind: 'deny', reason: '本地已到期，请去 NAS 取' },
      }),
    ])
    const tr = await ready()
    const cell = within(tr).getByTestId('audit-result-1')
    expect(cell).toHaveAttribute('data-kind', 'deny')
    expect(cell.textContent).toContain('拒绝')
    expect(cell.textContent).toContain('本地已到期，请去 NAS 取')
    // 拒绝：行左侧 3px 色条，靠 data-flag='deny' 驱动
    expect(tr).toHaveAttribute('data-flag', 'deny')
  })

  test('拒绝但库里没留原因时说「未记录原因」，不编一句兜底理由', async () => {
    serve([row({ result: { decision: 'deny', kind: 'deny', reason: null } })])
    const tr = await ready()
    expect(within(tr).getByTestId('audit-result-1').textContent).toContain('未记录原因')
  })

  test('库里的结果值既不是 allow 也不是 deny 时标成「存疑」，并带上那个原值，行左侧也带色条', async () => {
    serve([
      row({ result: { decision: 'weird', kind: 'unknown', reason: '审计记录里的结果值无法识别：weird' } }),
    ])
    const tr = await ready()
    const cell = within(tr).getByTestId('audit-result-1')
    expect(cell).toHaveAttribute('data-kind', 'unknown')
    expect(cell.textContent).toContain('存疑')
    expect(cell.textContent).toContain('weird')
    // 存疑同样需要先被看到，色条只是换成 warn 色——用同一个 data-flag 机制
    expect(tr).toHaveAttribute('data-flag', 'unknown')
  })

  test('detail 为 NULL（迁移 008 之前的历史记录）显示「无细节」，不是空白', async () => {
    serve([row({ detail: null })])
    await ready()
    expect(screen.getByTestId('audit-detail-1').textContent).toContain('无细节')
  })

  test('detail 的第一行是给人看的那句话，附文不塞进表格里', async () => {
    serve([row({ detail: '取走了 AI 纪要\n{"ruleId":100,"assets":["ai_minutes"]}' })])
    await ready()
    const cell = screen.getByTestId('audit-detail-1')
    expect(cell.textContent).toContain('取走了 AI 纪要')
    expect(cell.textContent).not.toContain('ruleId')
  })

  test('展开之后能看到明细全文与其余可回溯字段', async () => {
    serve([
      row({
        detail: '取走了 AI 纪要\n{"ruleId":100}',
        matchedRuleId: 100,
        clientKind: 'console',
      }),
    ])
    const user = userEvent.setup()
    await ready()
    expect(screen.queryByTestId('audit-expanded-1')).toBeNull()
    await user.click(screen.getByRole('button', { name: '完整记录' }))
    const box = screen.getByTestId('audit-expanded-1')
    expect(box.textContent).toContain('{"ruleId":100}')
    expect(box.textContent).toContain('rec-1:f-1:ai_minutes:0')
    expect(box.textContent).toContain('ai_minutes')
    expect(box.textContent).toContain('100')
    expect(box.textContent).toContain('console')
  })

  test('展开区里缺的字段说成缺，不填默认值', async () => {
    serve([row({ asset: null, matchedRuleId: null, clientKind: null })])
    const user = userEvent.setup()
    await ready()
    await user.click(screen.getByRole('button', { name: '完整记录' }))
    const box = screen.getByTestId('audit-expanded-1')
    expect(box.textContent).toContain('不针对某一份资产')
    expect(box.textContent).toContain('没有命中规则')
    expect(box.textContent).toContain('未记录')
  })

  test('点行上任何空白处也能展开；点链接不展开', async () => {
    const user = userEvent.setup()
    const tr = await ready()
    await user.click(within(tr).getByTestId('audit-detail-1'))
    expect(screen.getByTestId('audit-expanded-1')).toBeInTheDocument()
    expect(within(tr).getByRole('button', { name: '完整记录' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(within(tr).getByTestId('audit-detail-1'))
    expect(screen.queryByTestId('audit-expanded-1')).toBeNull()
  })

  test('展开区里「只看这个操作者」直接变成筛选条件，并回显成可移除的标签', async () => {
    const user = userEvent.setup()
    await ready()
    await user.click(screen.getByRole('button', { name: '完整记录' }))
    await user.click(screen.getByRole('button', { name: '只看这个操作者' }))
    await waitFor(() => expect(lastQuery().get('actorId')).toBe('kb-indexer'))
    expect(lastQuery().get('offset')).toBe('0')
    // 面板收着，条件也得看得见
    const remove = screen.getByRole('button', { name: '移除操作者筛选 kb-indexer' })
    expect(screen.getByRole('button', { name: /精确筛选 · 1/ })).toBeInTheDocument()
    await user.click(remove)
    await waitFor(() => expect(lastQuery().has('actorId')).toBe(false))
    expect(screen.queryByRole('button', { name: /移除操作者筛选/ })).toBeNull()
  })

  test('展开区里「只看这个动作」按原值筛，不用知道代码怎么拼', async () => {
    const user = userEvent.setup()
    await ready()
    await user.click(screen.getByRole('button', { name: '完整记录' }))
    await user.click(screen.getByRole('button', { name: '只看这个动作' }))
    await waitFor(() => expect(lastQuery().getAll('action')).toEqual(['issue_download_url']))
    expect(screen.getByRole('button', { name: '移除动作筛选 issue_download_url' })).toBeInTheDocument()
  })

  test('两条看起来一样的记录就是发生过两次 —— 不折叠、不去重', async () => {
    serve([row({ id: 11 }), row({ id: 12 }), row({ id: 13 })])
    await ready(11)
    expect(screen.getAllByText('签发下载链接')).toHaveLength(3)
    expect(screen.getByTestId('audit-row-12')).toBeInTheDocument()
    expect(screen.getByTestId('audit-row-13')).toBeInTheDocument()
  })
})

/* ── 筛选与分页真的走后端 ───────────────────────────────────────── */

describe('筛选', () => {
  test('首屏就带上时间下界（近 7 天）与分页参数', async () => {
    await ready()
    const q = lastQuery()
    expect(Number(q.get('from'))).toBeGreaterThan(0)
    expect(q.get('limit')).toBe('50')
    expect(q.get('offset')).toBe('0')
  })

  test('点色块 chip 发新请求，且回到第一页', async () => {
    const user = userEvent.setup()
    await ready()
    await user.click(screen.getByRole('button', { name: '程序取用' }))
    await waitFor(() => expect(lastQuery().getAll('actorKind')).toEqual(['prog']))
    expect(lastQuery().get('offset')).toBe('0')
  })

  test('「只看被拒绝」→ decision=deny', async () => {
    const user = userEvent.setup()
    await ready()
    await user.click(screen.getByRole('button', { name: '只看被拒绝' }))
    await waitFor(() => expect(lastQuery().get('decision')).toBe('deny'))
  })

  test('切到「全部时间」发 from=0', async () => {
    const user = userEvent.setup()
    await ready()
    expect(screen.getByRole('radio', { name: '近 7 天' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: '全部时间' }))
    await waitFor(() => expect(lastQuery().get('from')).toBe('0'))
    expect(screen.getByRole('radio', { name: '全部时间' })).toHaveAttribute('aria-checked', 'true')
  })

  test('操作者是精确匹配，不是模糊搜索；面板里提交之后才发请求', async () => {
    const user = userEvent.setup()
    await ready()
    // 两个输入框不常驻在页面上——常驻的空输入框长得像搜索框。
    // Popover 关着时仍在 DOM 里，但整块 inert（不可见、Tab 不到）
    expect(screen.getByLabelText(/操作者 ID/).closest('[inert]')).not.toBeNull()
    const panel = await openExact(user)
    expect(within(panel).getByLabelText(/操作者 ID/).closest('[inert]')).toBeNull()
    const input = within(panel).getByLabelText(/操作者 ID/)
    expect(input).toHaveAccessibleDescription(/精确匹配/)
    const before = urls.length
    await user.type(input, 'kb-indexer')
    expect(urls).toHaveLength(before) // 每敲一个字都发一次请求是不行的
    await user.click(within(panel).getByRole('button', { name: '应用' }))
    await waitFor(() => expect(lastQuery().get('actorId')).toBe('kb-indexer'))
    // 应用后面板收起，条件回显成标签
    expect(screen.getByRole('dialog', { name: '精确筛选' })).toHaveAttribute('data-state', 'closed')
    expect(screen.getByRole('button', { name: '移除操作者筛选 kb-indexer' })).toBeInTheDocument()
  })

  test('面板里按「取消」，没应用的草稿不会留下来生效', async () => {
    const user = userEvent.setup()
    await ready()
    const panel = await openExact(user)
    await user.type(within(panel).getByLabelText(/操作者 ID/), 'half')
    await user.click(within(panel).getByRole('button', { name: '取消' }))
    expect(lastQuery().has('actorId')).toBe(false)
    const again = await openExact(user)
    expect(within(again).getByLabelText(/操作者 ID/)).toHaveValue('')
  })

  test('动作按原值筛，可以用逗号给多个', async () => {
    const user = userEvent.setup()
    await ready()
    const panel = await openExact(user)
    await user.type(within(panel).getByLabelText(/动作代码/), 'login,list_meetings')
    await user.click(within(panel).getByRole('button', { name: '应用' }))
    await waitFor(() => expect(lastQuery().getAll('action')).toEqual(['login', 'list_meetings']))
    expect(screen.getByRole('button', { name: /精确筛选 · 1/ })).toBeInTheDocument()
  })

  test('时间范围五档全在面上，是一个单选组', async () => {
    await ready()
    const group = screen.getByRole('radiogroup', { name: '时间范围' })
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(
      AUDIT_RANGES.map((r) => r.label),
    )
  })

  test('翻页只改 offset，时间窗口两头都不动 —— 两页看的必须是同一段时间', async () => {
    serve([row()], { total: 120, limit: 50, offset: 0 })
    const user = userEvent.setup()
    await ready()
    const from = lastQuery().get('from')
    const to = lastQuery().get('to')
    expect(to).not.toBeNull()
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(lastQuery().get('offset')).toBe('50'))
    expect(lastQuery().get('from')).toBe(from)
    expect(lastQuery().get('to')).toBe(to)
  })

  test('改每页条数回到第一页', async () => {
    serve([row()], { total: 300, limit: 50, offset: 0 })
    const user = userEvent.setup()
    await ready()
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(lastQuery().get('offset')).toBe('50'))
    await user.selectOptions(screen.getByLabelText('每页条数'), '20')
    await waitFor(() => expect(lastQuery().get('limit')).toBe('20'))
    expect(lastQuery().get('offset')).toBe('0')
  })

  test('没有全文搜索框 —— 后端没有这个参数，前端不补一个翻页就失效的内存版', async () => {
    await ready()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByPlaceholderText(/搜/)).toBeNull()
  })

  test('选了色块就要说清「未知身份」筛不出来', async () => {
    const user = userEvent.setup()
    await ready()
    expect(screen.queryByTestId('audit-unknown-caveat')).toBeNull()
    await user.click(screen.getByRole('button', { name: '系统自动' }))
    expect(await screen.findByTestId('audit-unknown-caveat')).toBeInTheDocument()
  })

  test('清除筛选把三类条件一起清掉，时间范围回到近 7 天', async () => {
    const user = userEvent.setup()
    await ready()
    await user.click(screen.getByRole('button', { name: '程序取用' }))
    await user.click(screen.getByRole('button', { name: '只看被拒绝' }))
    await user.click(await screen.findByRole('button', { name: '清除筛选' }))
    await waitFor(() => expect(lastQuery().has('actorKind')).toBe(false))
    expect(lastQuery().has('decision')).toBe(false)
  })
})

/* ── 时间窗口必须看得见 ─────────────────────────────────────────── */

describe('时间窗口', () => {
  test('回显后端真正用的那一段，不是前端自己说的', async () => {
    serve([row()], { window: win({ from: 1_755_000_000, to: 1_756_000_000 }) })
    await ready()
    const line = screen.getByTestId('audit-window')
    expect(line.textContent).toContain(fmtDateTime(1_755_000_000))
    expect(line.textContent).toContain(fmtDateTime(1_756_000_000))
  })

  test('后端兜了默认窗口时，把它那句话原样显示出来', async () => {
    serve([row()], {
      window: win({ isDefault: true, text: '未指定时间范围，默认只查最近 7 天的记录；更早的操作不在本次结果里。' }),
    })
    await ready()
    expect(screen.getByTestId('audit-window').textContent).toContain('更早的操作不在本次结果里')
  })

  test('不限起点时说「不限起点」，不显示 1970 年', async () => {
    serve([row()], { window: win({ from: 0 }) })
    await ready()
    const line = screen.getByTestId('audit-window')
    expect(line.textContent).toContain('不限起点')
    expect(line.textContent).not.toContain('1970')
  })
})

/* ── 后端还没登记中文名的动作（阶段 5 · A9 / F9）───────────────── */

describe('unlabeledActions —— 这一页有几种动作后端还没登记名字', () => {
  const HINT =
    '这个动作在后端没有登记中文标签（src/audit/actions.ts 的 AUDIT_ACTION_LABELS 里没有这一行），' +
    '界面上显示的是 audit_log 里的原值。'

  test('汇总成一句，逐个点名并带出现次数；后端那句话原样上屏', async () => {
    serve([row({ action: 'frobnicate', actionLabel: null })], {
      unlabeledActions: [
        { action: 'frobnicate', count: 2, hint: HINT },
        { action: 'purge_expired', count: 1, hint: HINT },
      ],
    })
    await ready()
    const note = screen.getByTestId('audit-unlabeled-actions')
    expect(note).toHaveTextContent(/2\s*种动作/)
    expect(note).toHaveTextContent('frobnicate')
    expect(note).toHaveTextContent(/frobnicate（2 次）/)
    expect(note).toHaveTextContent(/purge_expired（1 次）/)
    expect(note).toHaveTextContent(/AUDIT_ACTION_LABELS/)
  })

  test('同一句 hint 只说一遍，不按条数重复 N 行', async () => {
    serve([row({ action: 'a', actionLabel: null })], {
      unlabeledActions: [
        { action: 'a', count: 1, hint: HINT },
        { action: 'b', count: 1, hint: HINT },
      ],
    })
    await ready()
    const note = screen.getByTestId('audit-unlabeled-actions')
    expect(within(note).getAllByText(HINT)).toHaveLength(1)
  })

  test('全部登记过时一个字都不说', async () => {
    serve([row()])
    await ready()
    expect(screen.queryByTestId('audit-unlabeled-actions')).toBeNull()
  })

  test('读失败时不显示——那一句描述的是上一次成功的查询', async () => {
    reply = () => ({ status: 500, body: { error: 'db_down' } })
    renderPage()
    await screen.findByTestId('audit-error')
    expect(screen.queryByTestId('audit-unlabeled-actions')).toBeNull()
  })
})

/* ── 三态 ───────────────────────────────────────────────────────── */

describe('加载中 / 读不到 / 空', () => {
  test('加载中有骨架，不是一句「暂无数据」', async () => {
    let release: (() => void) | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Promise<Response>((res) => {
            release = () =>
              res(new Response(JSON.stringify(pageOf([row()])), { status: 200 }))
          }),
      ),
    )
    renderPage()
    expect(await screen.findByTestId('audit-skeleton')).toBeInTheDocument()
    expect(screen.getByTestId('audit-loading')).toBeInTheDocument()
    release!()
    await waitFor(() => expect(screen.getByTestId('audit-row-1')).toBeInTheDocument())
  })

  test('重新查询期间保留上一次的结果，但明说下面是上一次的', async () => {
    const user = userEvent.setup()
    await ready()
    // 让接下来那次请求一直挂着
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    await user.click(screen.getByRole('button', { name: '程序取用' }))
    // 上一次的行还在（不清空、不跳高度），但旁边写着它是上一次的
    expect(screen.getByTestId('audit-row-1')).toBeInTheDocument()
    expect(screen.getByTestId('audit-loading').textContent).toContain('上一次')
  })

  test('读失败时不再显示时间窗口 —— 那一行说的是上一次成功的查询', async () => {
    const user = userEvent.setup()
    await ready()
    expect(screen.getByTestId('audit-window')).toBeInTheDocument()
    reply = () => ({ status: 500, body: { error: 'boom' } })
    await user.click(screen.getByRole('button', { name: '程序取用' }))
    await screen.findByTestId('audit-error')
    expect(screen.queryByTestId('audit-window')).toBeNull()
  })

  test('读不到时说清是读不到、给重试、并带上端点与错误码', async () => {
    reply = () => ({ status: 500, body: { error: 'boom' } })
    renderPage()
    const box = await screen.findByTestId('audit-error')
    expect(box.textContent).toContain('/api/v1/admin/audit')
    expect(box.textContent).toContain('boom')

    const user = userEvent.setup()
    serve([row()])
    await user.click(within(box).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByTestId('audit-row-1')).toBeInTheDocument())
  })

  test('这段时间没有记录 → 出口是放宽时间范围，不是「清除筛选」', async () => {
    serve([])
    renderPage()
    const box = await screen.findByTestId('audit-empty')
    expect(box).toHaveAttribute('data-kind', 'out-of-range')
    expect(within(box).getByRole('button', { name: /全部时间/ })).toBeInTheDocument()
  })

  test('全部时间 + 无筛选还是空 → 是真的一条都没有', async () => {
    serve([])
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId('audit-empty')
    await user.click(screen.getByRole('radio', { name: '全部时间' }))
    await waitFor(() =>
      expect(screen.getByTestId('audit-empty')).toHaveAttribute('data-kind', 'none-at-all'),
    )
  })

  test('筛没了 → 出口是清除筛选', async () => {
    const user = userEvent.setup()
    await ready()
    serve([])
    await user.click(screen.getByRole('button', { name: '程序取用' }))
    const box = await screen.findByTestId('audit-empty')
    await waitFor(() => expect(box).toHaveAttribute('data-kind', 'filtered-out'))
    expect(within(box).getByRole('button', { name: '清除筛选' })).toBeInTheDocument()
  })
})

/* ── 页面骨架与令牌 ─────────────────────────────────────────────── */

describe('页面骨架', () => {
  test('根节点是 PageShell（区域由 h1 命名），页面自己不再套一个 main', async () => {
    await ready()
    expect(screen.getByRole('heading', { name: '操作审计', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '操作审计' })).toBeInTheDocument()
    expect(screen.queryByRole('main')).toBeNull()
  })

  test('CSS 里没有裸值 —— 色值与间距一律走令牌', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/Audit/Audit.module.css'), 'utf-8')
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(declarations).not.toMatch(/\brgba?\(/)
    // 1px 边框是门槛明确豁免的那一个
    expect(declarations.replace(/\b[01]px\b/g, '')).not.toMatch(/\b\d+px\b/)
  })
})

describe('窄屏一行一张卡片（spec §11 缺口 2）', () => {
  test('六个有列名的格子都带 data-label——卡片形态下 thead 不渲染，列名靠它', async () => {
    const tr = await ready()
    const labels = [...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))
    // 最后一格是展开钮，没有列名，也不该在卡片上冒出一个空标签
    expect(labels).toEqual(['时间', '操作者', '动作', '对象', '结果', '细节', null])
  })
})

describe('只读账号（spec §11 缺口 1）', () => {
  test('这一页本来就没有写入口，只读账号看到的与管理员一模一样', async () => {
    const router = createMemoryRouter([{ path: '/audit', element: <AuditPage /> }], {
      initialEntries: ['/audit'],
    })
    renderAsRole(<RouterProvider router={router} />, 'readonly')
    await screen.findByRole('heading', { name: '操作审计', level: 1 })
    // 页头那句说明照常在（一个只读账号在哪一页都该知道自己是只读的）
    expect(screen.getByTestId('readonly-banner')).toBeInTheDocument()
    // 但没有任何一个按钮因为角色被禁用
    for (const b of screen.getAllByRole('button')) {
      expect(b).not.toHaveAttribute('title', '只读账号不能改')
    }
  })
})

