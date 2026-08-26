import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import RulesPage from '../../src/pages/Rules/index'

/**
 * 自动规则页 + 规则编辑器（spec §4.6 / §4.7 / §5）。
 *
 * 这一页最容易出的错是**前端自己实现一遍求值语义**，所以这里的断言刻意围着
 * 那件事转：
 *
 * - 影响预览的三个数必须与后端返回的 `counts` 逐字相同。测试里给的规则集与
 *   预览响应**故意对不上**（规则集里只有两条，预览说够得着 12 场、命中 7 场），
 *   前端只要算过一遍就会露馅。
 * - 判定理由一律来自后端；理由是空串时显示「理由缺失」，不留白。
 * - 「标题缺失」与「标题为空」在命中列表里是两句不同的话（阶段 4 · T13）。
 */

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []
let routes: Array<{ match: RegExp; method?: string; status: number; body: unknown }> = []

function reply(match: RegExp, body: unknown, opts: { method?: string; status?: number } = {}): void {
  routes.unshift({ match, method: opts.method, status: opts.status ?? 200, body })
}

function installFetch(): void {
  calls = []
  routes = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = String(input)
      const method = init.method ?? 'GET'
      calls.push({ url, init })
      const hit = routes.find((r) => r.match.test(url) && (r.method ?? method) === method)
      if (!hit) {
        return new Response(JSON.stringify({ error: 'test_no_stub', url, method }), { status: 500 })
      }
      return new Response(JSON.stringify(hit.body), {
        status: hit.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

function mount() {
  const router = createMemoryRouter([{ path: '/rules', element: <RulesPage /> }], {
    initialEntries: ['/rules'],
  })
  return render(<RouterProvider router={router} />)
}

function sentBodyOf(pattern: RegExp, method: string): unknown {
  const call = calls.find((c) => pattern.test(c.url) && (c.init.method ?? 'GET') === method)
  return call === undefined ? undefined : JSON.parse(String(call.init.body))
}

beforeEach(installFetch)
afterEach(() => vi.unstubAllGlobals())

/* ── 固定数据 ─────────────────────────────────────────────────── */

const FETCH_RULE = {
  id: 10,
  kind: 'fetch',
  priority: 100,
  enabled: true,
  join: 'and',
  conds: [{ f: 'age', op: 'within', v: 90 }],
  subjectType: null,
  subjectValue: null,
  assetTypes: ['*'],
  effect: 'all',
  note: '兜底规则，覆盖绝大多数会议',
  createdBy: '陈运维',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  issues: [],
}

const ALLOW_RULE = {
  ...FETCH_RULE,
  id: 20,
  kind: 'allow',
  priority: 50,
  conds: [{ f: 'title', op: 'has', v: '财务' }],
  subjectType: 'program',
  subjectValue: 'kb-indexer',
  assetTypes: ['ai_minutes'],
  effect: 'allow',
  note: '财务会议给数据组',
}

const PROGRAMS = [
  {
    id: 'kb-indexer',
    name: '知识库索引器',
    tmUserId: 'tm-1',
    enabled: true,
    expiresAt: null,
    createdAt: 1,
  },
]

function previewBody(over: Record<string, unknown> = {}) {
  return {
    scope: { meetings: 12, meetingsTotal: 480, truncated: true, programs: ['kb-indexer'] },
    stacks: [
      {
        kind: 'allow',
        counts: {
          total: 480,
          scanned: 12,
          hits: 7,
          opened: 3,
          tightened: 1,
          moved: 0,
          mixed: 0,
          deciderOnly: 2,
          shielded: 1,
          invalid: 0,
        },
        summary: '这次采集权限规则改动够得着 12 场会议（命中 7 场，共 480 场）',
        changedRuleIds: [20],
        changed: [
          {
            key: 'm-1|kb-indexer',
            meetingId: 'm-1',
            title: '财务月度复盘',
            programId: 'kb-indexer',
            aspect: 'effect',
            direction: 'opened',
            invalidRule: false,
            overridden: false,
            summary: '从「禁止采集」变成「准许采集（ai_minutes）」',
            before: {
              effect: 'deny',
              ruleId: null,
              note: null,
              source: 'default',
              reason: '没有任何采集权限规则命中，按兜底禁止采集',
              assetTypes: [],
              issues: [],
            },
            after: {
              effect: 'allow',
              ruleId: 20,
              note: '财务会议给数据组',
              source: 'rule',
              reason: '采集权限规则 #20「财务会议给数据组」命中',
              assetTypes: ['ai_minutes'],
              issues: [],
            },
          },
        ],
        deciderOnly: [],
        shielded: [],
        sampled: { changed: false, deciderOnly: false, shielded: false },
      },
    ],
    warnings: [],
    candidateIssues: [],
    ...over,
  }
}

function stubList(rules: unknown[]): void {
  reply(/\/api\/v1\/admin\/rules(\?|$)/, { rules })
  reply(/\/api\/v1\/admin\/programs$/, PROGRAMS)
}

/* ── 三态 ─────────────────────────────────────────────────────── */

describe('三态（spec §8）', () => {
  test('加载失败时给出端点名与重试，不白屏也不装作空', async () => {
    reply(/\/api\/v1\/admin\/rules/, { error: 'db_down' }, { status: 500 })
    mount()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/GET \/api\/v1\/admin\/rules/)
    expect(alert).toHaveTextContent(/db_down/)
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  test('某一栈一条规则都没有时，说清"于是现在会发生什么"，不是一句暂无数据', async () => {
    stubList([FETCH_RULE])
    mount()
    await screen.findByRole('heading', { name: /采集权限规则/ })
    const allow = screen.getByRole('region', { name: /采集权限规则/ })
    expect(allow).toHaveTextContent(/还没有规则/)
    expect(allow).toHaveTextContent(/任何外部程序都取不到/)
  })
})

/* ── 三栈呈现（spec §4.6）────────────────────────────────────── */

describe('三栈（spec §4.6）', () => {
  test('三组分开展示，兜底逐条写明——第三组是 deny，前两组是 skip', async () => {
    stubList([FETCH_RULE, ALLOW_RULE])
    mount()

    await screen.findByRole('heading', { name: /一、拉取规则/ })
    expect(screen.getByRole('heading', { name: /二、归档规则/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /三、采集权限规则/ })).toBeInTheDocument()

    const allow = screen.getByRole('region', { name: /采集权限规则/ })
    expect(allow).toHaveTextContent(/默认全部拒绝/)
    expect(allow).toHaveTextContent(/数据离开企业边界的唯一闸门/)
  })

  test('规则行给出优先级、条件、动作、说明与建立人', async () => {
    stubList([ALLOW_RULE])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(row).toHaveTextContent('50')
    expect(row).toHaveTextContent('会议标题 包含任一「财务」')
    expect(row).toHaveTextContent('准许采集（ai_minutes）')
    expect(row).toHaveTextContent('财务会议给数据组')
    expect(row).toHaveTextContent('陈运维')
  })

  test('后端的 issues 逐条原样显示——建完就静默失效的规则要看得见', async () => {
    stubList([
      {
        ...ALLOW_RULE,
        issues: ['第 1 个条件的字段「主持人部门」当前没有数据源（需要企业微信通讯录），这条条件恒不成立'],
      },
    ])
    mount()
    expect(
      await screen.findByText(/第 1 个条件的字段「主持人部门」当前没有数据源/),
    ).toBeInTheDocument()
  })

  test('只有 dept 条件的规则给出"永远不会命中"的可见提示（spec §5.3）', async () => {
    stubList([{ ...ALLOW_RULE, conds: [{ f: 'dept', op: 'in', v: ['财务部'] }] }])
    mount()
    expect(await screen.findByText(/永远不会命中/)).toBeInTheDocument()
  })

  test('被上面一条无条件规则挡住时说出来，且说得出是哪一条', async () => {
    stubList([
      { ...ALLOW_RULE, id: 20, priority: 200, conds: [] },
      { ...ALLOW_RULE, id: 21, priority: 100 },
    ])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #21/ })
    expect(row).toHaveTextContent(/#20/)
    expect(row).toHaveTextContent(/够不着|挡住/)
  })

  test('拉取栈一条启用的规则都没有时，说清现在走的是兼容兜底"全拉"，不是 skip', async () => {
    stubList([{ ...FETCH_RULE, enabled: false }])
    mount()
    const fetchStack = await screen.findByRole('region', { name: /拉取规则/ })
    expect(fetchStack).toHaveTextContent(/兼容兜底|时间窗内全拉/)
    expect(fetchStack).toHaveTextContent(/建下第一条拉取规则的那一刻/)
  })

  test('kind 认不出的规则单独一组，不悄悄丢掉', async () => {
    stubList([{ ...ALLOW_RULE, id: 99, kind: 'sideways' }])
    mount()
    expect(await screen.findByRole('heading', { name: /认不出的规则/ })).toBeInTheDocument()
    expect(screen.getByText(/sideways/)).toBeInTheDocument()
  })
})

/* ── 停用 / 启用 ─────────────────────────────────────────────── */

describe('停用 / 启用', () => {
  test('只发 enabled 一个键，并且重取列表——不做乐观更新（G-c）', async () => {
    stubList([ALLOW_RULE])
    reply(/\/api\/v1\/admin\/rules\/20$/, { rule: { ...ALLOW_RULE, enabled: false } }, { method: 'PATCH' })
    mount()

    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    await userEvent.click(within(row).getByRole('button', { name: '停用' }))

    await waitFor(() => {
      expect(sentBodyOf(/\/rules\/20$/, 'PATCH')).toEqual({ enabled: false })
    })
    // 重取：列表的 GET 至少发了两次
    await waitFor(() => {
      const gets = calls.filter((c) => /\/rules(\?|$)/.test(c.url) && (c.init.method ?? 'GET') === 'GET')
      expect(gets.length).toBeGreaterThanOrEqual(2)
    })
  })
})

/* ── 命中的会议（spec §4.7 的命中数可点）───────────────────── */

describe('命中的会议', () => {
  test('「标题缺失」与「标题为空」是两句不同的话（阶段 4 · T13）', async () => {
    stubList([ALLOW_RULE])
    reply(/\/rules\/20\/matches/, {
      rule: ALLOW_RULE,
      scope: { meetings: 12, meetingsTotal: 480, truncated: true },
      matches: [
        { id: 'm-1|', meetingId: 'm-1', subMeetingId: '', title: '财务月度复盘', startAt: 1_700_000_000, missing: [] },
        { id: 'm-2|', meetingId: 'm-2', subMeetingId: '', title: '', startAt: 1_700_000_000, missing: ['title'] },
        { id: 'm-3|', meetingId: 'm-3', subMeetingId: '', title: '', startAt: 1_700_000_000, missing: [] },
      ],
    })
    mount()

    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    await userEvent.click(within(row).getByRole('button', { name: /命中/ }))

    const panel = await screen.findByRole('dialog', { name: /命中的会议/ })
    expect(within(panel).getByText('标题缺失')).toBeInTheDocument()
    expect(within(panel).getByText('（标题为空）')).toBeInTheDocument()
    // 只考察了 480 场里的 12 场，这件事必须说出来
    expect(panel).toHaveTextContent(/12/)
    expect(panel).toHaveTextContent(/480/)
  })

  test('命中数在拿到之前不显示一个数——没问过就说不出来', async () => {
    stubList([ALLOW_RULE])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(within(row).getByRole('button', { name: /查看命中的会议/ })).toBeInTheDocument()
  })
})

/* ── 规则编辑器（spec §4.7）──────────────────────────────────── */

describe('规则编辑器', () => {
  async function openNewAllowRule() {
    stubList([ALLOW_RULE])
    reply(/\/rules\/preview$/, previewBody(), { method: 'POST' })
    mount()
    await screen.findByRole('heading', { name: /三、采集权限规则/ })
    await userEvent.click(screen.getByRole('button', { name: '新建采集权限规则' }))
    return screen.findByRole('dialog', { name: /新建采集权限规则/ })
  }

  test('条件构建器覆盖 spec §5.3 的六个字段，dept 可见但禁用并写明原因', async () => {
    const panel = await openNewAllowRule()
    const fieldSelect = within(panel).getAllByRole('combobox', { name: '条件字段' })[0]!
    const options = within(fieldSelect).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      '会议标题',
      '主持人部门',
      '主持人',
      '会议时长',
      '录制结束',
      '归档状态',
    ])
    const dept = options[1]!
    expect(dept).toBeDisabled()
    expect(panel).toHaveTextContent(/需要企业微信通讯录/)
  })

  test('一条规则内只能全用「且」或全用「或」——切一处就是全切', async () => {
    const panel = await openNewAllowRule()
    await userEvent.click(within(panel).getByRole('button', { name: '添加条件' }))
    await userEvent.click(within(panel).getByRole('button', { name: '添加条件' }))
    // 两个连接词按钮（第一行是「当」，不是按钮）
    const joins = within(panel).getAllByRole('button', { name: /连接词/ })
    expect(joins).toHaveLength(2)
    await userEvent.click(joins[0]!)
    for (const b of within(panel).getAllByRole('button', { name: /连接词/ })) {
      expect(b).toHaveTextContent('或')
    }
  })

  test('影响预览的三个数逐字来自后端，前端不算', async () => {
    const panel = await openNewAllowRule()
    await waitFor(() => {
      expect(within(panel).getByRole('group', { name: '影响预览' })).toHaveTextContent('7')
    })
    const preview = within(panel).getByRole('group', { name: '影响预览' })
    expect(preview).toHaveTextContent(/7\s*场命中/)
    expect(preview).toHaveTextContent(/3\s*场新放行/)
    expect(preview).toHaveTextContent(/1\s*场新收紧/)
    // 规则集里只有一条规则，够不着 12 场——这些数只可能是后端给的
    expect(preview).toHaveTextContent(/12/)
  })

  test('预览走 POST /rules/preview 的单条写法，带上本栈 kind', async () => {
    await openNewAllowRule()
    await waitFor(() => {
      expect(sentBodyOf(/\/rules\/preview$/, 'POST')).toMatchObject({ kind: 'allow' })
    })
    const body = sentBodyOf(/\/rules\/preview$/, 'POST') as { rule: Record<string, unknown> }
    expect(body.rule.kind).toBe('allow')
    expect(body.rule).not.toHaveProperty('id')
  })

  test('琥珀警告原样上屏（从未对外开放过却将被放行）', async () => {
    stubList([ALLOW_RULE])
    reply(
      /\/rules\/preview$/,
      previewBody({
        warnings: [
          {
            level: 'amber',
            code: 'newly_opened',
            text: '有 3 场此前判定为「禁止采集」的会议将被这条规则放行给外部采集程序。',
            meetings: [{ id: 'm-1', title: '财务月度复盘' }],
          },
        ],
      }),
      { method: 'POST' },
    )
    mount()
    await screen.findByRole('heading', { name: /三、采集权限规则/ })
    await userEvent.click(screen.getByRole('button', { name: '新建采集权限规则' }))
    expect(
      await screen.findByText(/有 3 场此前判定为「禁止采集」的会议将被这条规则放行/),
    ).toBeInTheDocument()
  })

  test('判定理由是空串时显示「理由缺失」，不留白', async () => {
    stubList([ALLOW_RULE])
    const body = previewBody()
    const stack = body.stacks[0]!
    stack.changed[0]!.before.reason = ''
    reply(/\/rules\/preview$/, body, { method: 'POST' })
    mount()
    await screen.findByRole('heading', { name: /三、采集权限规则/ })
    await userEvent.click(screen.getByRole('button', { name: '新建采集权限规则' }))
    expect(await screen.findByText('理由缺失')).toBeInTheDocument()
  })

  test('保存发 POST /rules，请求体逐字对齐契约', async () => {
    const panel = await openNewAllowRule()
    reply(/\/api\/v1\/admin\/rules$/, { rule: ALLOW_RULE }, { method: 'POST', status: 201 })

    await userEvent.type(within(panel).getByLabelText('条件值'), '财务')
    // 采集程序必须显式选——数据出境闸门上，不替管理员预选一个
    await userEvent.selectOptions(
      within(panel).getByRole('combobox', { name: '采集程序' }),
      'kb-indexer',
    )
    await userEvent.click(within(panel).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sentBodyOf(/\/api\/v1\/admin\/rules$/, 'POST')).toMatchObject({
        kind: 'allow',
        join: 'and',
        subjectType: 'program',
        subjectValue: 'kb-indexer',
        effect: 'allow',
        conds: [{ f: 'title', op: 'has', v: '财务' }],
      })
    })
  })

  test('rule_invalid 的逐条原因全部显示，一条都不挑', async () => {
    const panel = await openNewAllowRule()
    reply(
      /\/api\/v1\/admin\/rules$/,
      {
        error: 'rule_invalid',
        issues: ['第 1 个条件写不进去：关键词为空，这条条件不会成立', 'priority 必须是整数'],
      },
      { method: 'POST', status: 400 },
    )
    await userEvent.click(within(panel).getByRole('button', { name: '保存' }))

    expect(await screen.findByText(/关键词为空，这条条件不会成立/)).toBeInTheDocument()
    expect(screen.getByText('priority 必须是整数')).toBeInTheDocument()
  })

  test('删除默认是安静的，点第一次才变红（二次确认）', async () => {
    stubList([ALLOW_RULE])
    reply(/\/rules\/preview$/, previewBody(), { method: 'POST' })
    reply(/\/api\/v1\/admin\/rules\/20$/, { rule: ALLOW_RULE }, { method: 'DELETE' })
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    await userEvent.click(within(row).getByRole('button', { name: '编辑' }))
    const panel = await screen.findByRole('dialog', { name: /编辑采集权限规则/ })

    const del = within(panel).getByRole('button', { name: /删除这条规则/ })
    await userEvent.click(del)
    expect(calls.some((c) => (c.init.method ?? 'GET') === 'DELETE')).toBe(false)

    await userEvent.click(within(panel).getByRole('button', { name: /确认删除/ }))
    await waitFor(() => {
      expect(calls.some((c) => (c.init.method ?? 'GET') === 'DELETE')).toBe(true)
    })
  })

  test('kind 认不出的规则打得开、也修得了——只有这时才给改 kind 的口子', async () => {
    stubList([{ ...ALLOW_RULE, id: 99, kind: 'sideways' }])
    reply(/\/rules\/preview$/, previewBody(), { method: 'POST' })
    mount()
    const row = await screen.findByRole('listitem', { name: /认不出的规则 #99/ })
    await userEvent.click(within(row).getByRole('button', { name: '编辑' }))

    const panel = await screen.findByRole('dialog', { name: /编辑/ })
    const picker = within(panel).getByRole('combobox', { name: '规则类型' })
    expect(picker).toHaveValue('')
    // 换栈时动作跟着重置成那一栈的默认值——三栈的 effect 取值域完全不同
    await userEvent.selectOptions(picker, 'fetch')
    const radios = within(panel).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => r.value)).toEqual(['all', 'skip'])
    expect(radios.find((r) => r.value === 'all')).toBeChecked()
  })

  test('正常的规则不给改 kind 的口子——换栈就在那一栈里新建', async () => {
    const panel = await openNewAllowRule()
    expect(within(panel).queryByRole('combobox', { name: '规则类型' })).toBeNull()
  })

  test('Esc 关掉编辑器（浮层基座的契约）', async () => {
    const panel = await openNewAllowRule()
    expect(panel).toHaveAttribute('data-state', 'open')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(panel).toHaveAttribute('data-state', 'closed'))
  })
})
