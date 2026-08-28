import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { render, renderAsRole } from '../helpers/session'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import RulesPage from '../../src/pages/Rules/index'
import { RULES_SCHEMA_BODY } from '../helpers/rulesSchema'

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
 * - 命中数是后端下发的字段，读不到就显示「—」——前端一次都不自己数。
 */

/**
 * `Rules.module.css` 的原文。
 *
 * jsdom 解析得出 `.act` 的静态 `opacity: 0`（vitest 的 `css: true` 会把 CSS Module
 * 注进文档），但它的选择器引擎**认不出 `:focus-within`**（实测 `matches(':focus-within')`
 * 恒为 false），`:hover` 更不可能模拟。于是「悬停 / 聚焦时才浮出来」这条契约
 * 只能在样式表原文里钉住——比不钉强，也比让它在某次重构里悄悄消失强。
 */
const RULES_CSS = readFileSync(rulesCssPath(), 'utf8')

/** vitest 的 `import.meta.url` 不是 file: 协议，所以从工作目录找（`npm test` 在 console/ 下跑）。 */
function rulesCssPath(): string {
  const rel = 'src/pages/Rules/Rules.module.css'
  const here = path.join(process.cwd(), rel)
  return existsSync(here) ? here : path.join(process.cwd(), 'console', rel)
}

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

/** 后端下发了命中数的那一份（`GET /rules` 每条规则自带 matchCount / matchScanned）。 */
const ALLOW_RULE_COUNTED = { ...ALLOW_RULE, matchCount: 8, matchScanned: 480 }

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
  // 条件字段与动作的取值域全部来自这条端点（阶段 5 · F9）。少了它，
  // 这一页会挂一条「字段清单读不出来」的横幅并把编辑器禁掉——那正是它该做的事
  reply(/\/api\/v1\/admin\/rules\/schema$/, RULES_SCHEMA_BODY)
  reply(/\/api\/v1\/admin\/programs$/, PROGRAMS)
}

/* ── 三态 ─────────────────────────────────────────────────────── */

describe('三态（spec §8）', () => {
  test('加载失败时给出端点名与重试，不白屏也不装作空', async () => {
    reply(/\/api\/v1\/admin\/rules\/schema$/, RULES_SCHEMA_BODY)
    reply(/\/api\/v1\/admin\/rules(\?|$)/, { error: 'db_down' }, { status: 500 })
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

/* ── 清单来自 GET /rules/schema（阶段 5 · F9）────────────────── */

describe('条件字段清单从后端拿，前端不留镜像', () => {
  test('后端多一个运算符，下拉框里就多一个——前端一行都不用改', async () => {
    const body = structuredClone(RULES_SCHEMA_BODY)
    body.fields[0]!.ops.push({ op: 'startswith', label: '以…开头', unitSuffix: null })
    reply(/\/api\/v1\/admin\/rules(\?|$)/, { rules: [ALLOW_RULE] })
    reply(/\/api\/v1\/admin\/rules\/schema$/, body)
    reply(/\/api\/v1\/admin\/programs$/, PROGRAMS)
    reply(/\/rules\/preview$/, previewBody(), { method: 'POST' })
    mount()

    await screen.findByRole('heading', { name: /三、采集权限规则/ })
    await userEvent.click(screen.getByRole('button', { name: '新建采集权限规则' }))
    const panel = await screen.findByRole('dialog', { name: /新建采集权限规则/ })
    const ops = within(panel).getAllByRole('combobox', { name: '条件运算符' })[0]!
    expect(within(ops).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '包含任一',
      '不包含',
      '以…开头',
    ])
  })

  test('后端漏登记运算符中文名时下拉框里说出来，不拿 op 原值冒充中文名', async () => {
    const body = structuredClone(RULES_SCHEMA_BODY)
    body.fields[0]!.ops[1]!.label = null as unknown as string
    reply(/\/api\/v1\/admin\/rules(\?|$)/, { rules: [ALLOW_RULE] })
    reply(/\/api\/v1\/admin\/rules\/schema$/, body)
    reply(/\/api\/v1\/admin\/programs$/, PROGRAMS)
    reply(/\/rules\/preview$/, previewBody(), { method: 'POST' })
    mount()

    await screen.findByRole('heading', { name: /三、采集权限规则/ })
    await userEvent.click(screen.getByRole('button', { name: '新建采集权限规则' }))
    const panel = await screen.findByRole('dialog', { name: /新建采集权限规则/ })
    expect(within(panel).getByRole('option', { name: /后端没有登记中文名/ })).toBeInTheDocument()
  })

  test('动作可选项与它下面那句解释都来自 schema', async () => {
    stubList([ALLOW_RULE])
    reply(/\/rules\/preview$/, previewBody(), { method: 'POST' })
    mount()
    await screen.findByRole('heading', { name: /三、采集权限规则/ })
    await userEvent.click(screen.getByRole('button', { name: '新建采集权限规则' }))
    const panel = await screen.findByRole('dialog', { name: /新建采集权限规则/ })
    expect(panel).toHaveTextContent('准许采集')
    expect(panel).toHaveTextContent(/仍需在会议列表里授权给具体程序才真的能取走/)
  })

  test('归档栈那段「目录模板」的说明来自 schema 的 freeform，不是前端写的', async () => {
    stubList([{ ...FETCH_RULE, id: 30, kind: 'archive', effect: 'nas/x/' }])
    reply(/\/rules\/preview$/, previewBody(), { method: 'POST' })
    mount()
    await screen.findByRole('heading', { name: /二、归档规则/ })
    await userEvent.click(screen.getByRole('button', { name: '新建归档规则' }))
    const panel = await screen.findByRole('dialog', { name: /新建归档规则/ })
    expect(panel).toHaveTextContent(/不会搬迁已经归档过的文件/)
    // 「填 skip 表示不归档」也是从 effects[0] 拼出来的
    expect(panel).toHaveTextContent(/填\s*skip\s*表示不归档/)
  })
})

describe('字段清单读不出来时（后端不可达 / 契约对不上）', () => {
  async function withoutSchema() {
    reply(/\/api\/v1\/admin\/rules(\?|$)/, { rules: [ALLOW_RULE] })
    reply(/\/api\/v1\/admin\/rules\/schema$/, { error: 'db_down' }, { status: 500 })
    reply(/\/api\/v1\/admin\/programs$/, PROGRAMS)
    mount()
    return screen.findByTestId('rules-schema-error')
  }

  test('说清是「字段清单读不出来」，并给出端点名与重试', async () => {
    const box = await withoutSchema()
    expect(box).toHaveTextContent(/字段清单读不出来/)
    expect(box).toHaveTextContent(/GET \/api\/v1\/admin\/rules\/schema/)
    expect(within(box).getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  test('规则照常列出来，但条件与动作退成库里的原值——不拿一份旧快照顶上', async () => {
    await withoutSchema()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    // 「会议标题 包含任一「财务」」是清单读得到时的说法；读不到时只报原值
    expect(row).toHaveTextContent('title has「财务」')
    expect(row).not.toHaveTextContent('会议标题')
    expect(row).not.toHaveTextContent('准许采集')
  })

  test('新建与编辑全部禁用，且说得出为什么', async () => {
    await withoutSchema()
    const create = await screen.findAllByRole('button', { name: /新建/ })
    for (const b of create) {
      expect(b).toBeDisabled()
      expect(b).toHaveAttribute('title', expect.stringMatching(/字段清单读不出来/))
    }
    expect(screen.getAllByRole('button', { name: '编辑' })[0]).toBeDisabled()
  })

  test('「查看命中」不禁用——那条路不需要清单', async () => {
    await withoutSchema()
    expect(screen.getAllByRole('button', { name: /查看命中|场命中/ })[0]).toBeEnabled()
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

  test('拉取栈一条启用的规则都没有时，兜底那一行自己说真话——不是先写 skip 再挂一段更正', async () => {
    stubList([{ ...FETCH_RULE, enabled: false }])
    mount()
    const fetchStack = await screen.findByRole('region', { name: /拉取规则/ })
    // 这一栈此刻真实的处置就写在那个标签上
    expect(fetchStack).toHaveTextContent(/发现到的录制全部拉取/)
    // spec 字面上的 skip 这时**不能**出现：它是假的，而一句假标签加一段更正
    // 比一句真标签差——读的人只会读到其中一半
    expect(fetchStack).not.toHaveTextContent('兜底：一条都不匹配时不拉取')
    // 标签自己说不出来的那一件事留着：建第一条会翻面
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

  test('命中数直接显示，不用先点一下——数字仍然点得开命中列表', async () => {
    stubList([ALLOW_RULE_COUNTED])
    reply(/\/rules\/20\/matches/, {
      rule: ALLOW_RULE_COUNTED,
      scope: { meetings: 480, meetingsTotal: 480, truncated: false },
      matches: [],
    })
    mount()

    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    // 一进页面就是数字，不是一颗「?」——`?` 要点一下才知道，那件事本来后端已经说了
    const hits = within(row).getByRole('button', { name: /8 场命中/ })
    expect(hits).toHaveTextContent('8')
    expect(calls.some((c) => /\/matches/.test(c.url))).toBe(false)

    // 数字还是可点的：点开还是那张命中列表
    await userEvent.click(hits)
    expect(await screen.findByRole('dialog', { name: /命中的会议/ })).toBeInTheDocument()
  })

  test('matchScanned 上屏做统计范围的可回溯说明——「8」是在多大一批里数出来的', async () => {
    stubList([ALLOW_RULE_COUNTED])
    mount()
    await screen.findByRole('heading', { name: /三、采集权限规则/ })
    expect(screen.getByRole('region', { name: /采集权限规则/ })).toHaveTextContent(
      /命中按最近 480 场统计/,
    )
  })

  test('字段读不到（旧后端 / 老响应）时显示「—」，页面照常，且不退回前端自己算', async () => {
    // ALLOW_RULE 这份响应里根本没有 matchCount / matchScanned 两个键
    stubList([ALLOW_RULE])
    mount()

    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    const hits = within(row).getByRole('button', { name: /查看命中的会议/ })
    // 「—」而不是 0：0 是一个具体的答案，管理员会照着它去删一条其实好好的规则
    expect(hits).toHaveTextContent('—')
    expect(hits).not.toHaveTextContent('0')
    // 前端没有替它去数一遍：一条 matches 请求都没发
    expect(calls.some((c) => /\/matches/.test(c.url))).toBe(false)
    // 统计范围也说不出来，于是那句话整句不出现——不编一个数
    expect(screen.getByRole('region', { name: /采集权限规则/ })).not.toHaveTextContent(/命中按最近/)
  })

  test('命中 0 场是一个真的答案，与「读不出来」分得开', async () => {
    stubList([{ ...ALLOW_RULE, matchCount: 0, matchScanned: 480 }])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    const hits = within(row).getByRole('button', { name: /0 场命中/ })
    expect(hits).toHaveTextContent('0')
    expect(hits).toHaveAttribute('data-zero', 'true')
  })

  test('停用的规则照样有命中数——先看得见「把它开回来会命中什么」', async () => {
    stubList([{ ...ALLOW_RULE, enabled: false, matchCount: 3, matchScanned: 480 }])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(row).toHaveAttribute('data-off', 'true')
    expect(within(row).getByRole('button', { name: /3 场命中/ })).toHaveTextContent('3')
  })
})

/* ── 梯子的几何（改版）───────────────────────────────────────── */

describe('一行一条规则：动作不常驻，但键盘走得到', () => {
  test('「编辑 · 停用」默认不可见（opacity 0），不是十二行常驻的噪声', async () => {
    stubList([ALLOW_RULE])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    const act = within(row).getByRole('button', { name: '编辑' }).parentElement!
    expect(getComputedStyle(act).opacity).toBe('0')
  })

  test('看不见不等于够不着：两颗按钮都在 Tab 序列里，也没被 aria 藏起来', async () => {
    stubList([ALLOW_RULE])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    const hits = within(row).getByRole('button', { name: /查看命中/ })
    const edit = within(row).getByRole('button', { name: '编辑' })
    const off = within(row).getByRole('button', { name: '停用' })

    // 没有 hidden / aria-hidden / tabindex=-1 这类把它排除出 Tab 序列的写法
    for (const b of [edit, off]) {
      expect(b).toBeEnabled()
      expect(b).not.toHaveAttribute('aria-hidden')
      expect(b).not.toHaveAttribute('tabindex')
    }

    // 从命中数往后 Tab，下一站就是「编辑」，再一站是「停用」
    hits.focus()
    await userEvent.tab()
    expect(edit).toHaveFocus()
    await userEvent.tab()
    expect(off).toHaveFocus()
  })

  test('浮出来的条件里有 :focus-within，触屏那一档常驻并补足触控高度', () => {
    // jsdom 认不出 :focus-within（见 RULES_CSS 的注释），这条只能钉样式表原文
    expect(RULES_CSS).toMatch(/\.rule:hover \.act,\s*\n\.rule:focus-within \.act/)
    // 触屏没有 hover：窄屏那一档里它们常驻，并且补足 --tap-min
    const narrow = RULES_CSS.slice(RULES_CSS.indexOf('@media (max-width: 56em)'))
    expect(narrow).toMatch(/\.act \{[^}]*opacity: 1;/)
    expect(narrow).toMatch(/min-height: var\(--tap-min\)/)
  })
})

describe('三类坏规则用左侧色条挂出来，不在行里加两行橙字', () => {
  test('conds 读不出来 → 挂 unreadable / fail，说的是「一场都命中不了，等于没建」', async () => {
    // 后端 evaluateRule 对非数组 conds 判 matched: false —— 这条规则什么都不做
    stubList([{ ...ALLOW_RULE, conds: { title: '财务' }, matchCount: 0, matchScanned: 480 }])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(row).toHaveAttribute('data-flag', 'unreadable')
    expect(row).toHaveAttribute('data-tone', 'fail')
    // 「conds 不是数组」写在行内那句话里；行下面那一行补的是**后果**
    expect(row).toHaveTextContent('条件写坏了（conds 不是数组）')
    expect(within(row).getByText(/一场都命中不了/)).toBeInTheDocument()
    // 那个 0 不是「条件写窄了」——这句必须在，否则管理员会去调宽条件
    expect(row).toHaveTextContent(/不是「条件写窄了」/)
    // **不许**说成「正在放行全部会议」：那是空数组 conds 的语义，方向正相反
    expect(row).not.toHaveTextContent(/放行全部|命中全部/)
  })

  test('采集权限栈 + 无条件准许 → fail：数据无条件出境，这一栈是唯一的闸门', async () => {
    stubList([{ ...ALLOW_RULE, effect: 'allow', conds: [], matchCount: 480, matchScanned: 480 }])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(row).toHaveAttribute('data-flag', 'unconditional')
    expect(row).toHaveAttribute('data-tone', 'fail')
    // 句子用后端写侧 validateDraft 那句话的意思，前端不另发明一套说法
    expect(row).toHaveTextContent(/空条件在求值器里是「匹配一切」/)
    expect(row).toHaveTextContent(/显式写一个恒真的条件/)
    expect(row).toHaveTextContent(/数据离开企业边界的唯一闸门/)
  })

  test('采集权限栈 + 无条件拒绝 → 不标记：无条件拒绝落在安全侧', async () => {
    stubList([
      { ...ALLOW_RULE, id: 20, priority: 200, effect: 'deny', assetTypes: [], conds: [] },
      { ...ALLOW_RULE, id: 21, priority: 100 },
    ])
    mount()
    const blocker = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(blocker).not.toHaveAttribute('data-flag')
    expect(blocker).not.toHaveAttribute('data-tone')
    // 但它挡住的那一行照旧说得出来——「不标记」不等于这件事没人说
    const blocked = screen.getByRole('listitem', { name: /采集权限规则 #21/ })
    expect(blocked).toHaveAttribute('data-tone', 'warn')
    expect(blocked).toHaveTextContent(/够不着：上面的 #20/)
  })

  test('归档栈 + 无条件 → warn：意图（兜底）对、写法不对，而且挡住下面所有规则', async () => {
    stubList([{ ...FETCH_RULE, id: 30, kind: 'archive', effect: 'nas/x/', conds: [] }])
    mount()
    const row = await screen.findByRole('listitem', { name: /归档规则 #30/ })
    expect(row).toHaveAttribute('data-flag', 'unconditional')
    expect(row).toHaveAttribute('data-tone', 'warn')
    expect(row).toHaveTextContent(/空条件在求值器里是「匹配一切」/)
    expect(row).toHaveTextContent(/优先级低于它的规则永远轮不到/)
    // 不许把归档栈说成数据出境
    expect(row).not.toHaveTextContent(/闸门|放行/)
  })

  test('拉取栈 + 无条件 → warn', async () => {
    stubList([{ ...FETCH_RULE, conds: [] }])
    mount()
    const row = await screen.findByRole('listitem', { name: /拉取规则 #10/ })
    expect(row).toHaveAttribute('data-tone', 'warn')
  })

  test('挂号只看 conds 本身，后端 issues 里没有那句话也照样挂得出来', async () => {
    stubList([{ ...ALLOW_RULE, effect: 'allow', conds: [], issues: [] }])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(row).toHaveAttribute('data-tone', 'fail')
  })

  test('永不命中（条件用的字段没有数据源）→ 挂 ineffective / warn，不是 fail', async () => {
    stubList([{ ...ALLOW_RULE, conds: [{ f: 'dept', op: 'in', v: ['财务部'] }] }])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(row).toHaveAttribute('data-flag', 'ineffective')
    expect(row).toHaveAttribute('data-tone', 'warn')
    expect(within(row).getByText(/永远不会命中/)).toBeInTheDocument()
  })

  test('色条挂在**出问题的那一行**，好规则那一行一个色条都没有', async () => {
    stubList([
      { ...ALLOW_RULE, id: 20, priority: 200, conds: { title: 'x' } },
      { ...ALLOW_RULE, id: 21, priority: 100 },
    ])
    mount()
    const bad = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    const good = screen.getByRole('listitem', { name: /采集权限规则 #21/ })
    expect(bad).toHaveAttribute('data-tone', 'fail')
    expect(good).not.toHaveAttribute('data-tone')
    expect(good).not.toHaveAttribute('data-flag')
  })

  test('停用的无条件规则不挂号——它现在一场都不命中，说它覆盖全部是无中生有', async () => {
    stubList([{ ...ALLOW_RULE, effect: 'allow', conds: [], enabled: false }])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(row).not.toHaveAttribute('data-flag')
    expect(row).toHaveAttribute('data-off', 'true')
    // 条件那一格照旧写着，要开回来的人看得见
    expect(row).toHaveTextContent('所有会议（无条件）')
  })

  test('已停用的行退后靠颜色，不靠 opacity——opacity 会把语义色一起压到不达标', async () => {
    // 这一条原来断言整行 `opacity` 在 0.75–1 之间。那个做法本身是错的：
    // 父级 opacity **无差别**压低整行每一处对比度，包括语义色。--warn 压在
    // --ground 上满强度只有 4.85:1（几乎没有余量），乘 0.8 就掉到 3.41:1——
    // 「· 已停用」这四个字和命中数那个 0 都因此不达 AA，是 `npm run a11y`
    // 实测报出来的。而这两处恰恰是语义，不能靠抬成 --ink-2 来救。
    //
    // 所以退后改成走颜色（中性文字降到 --ink-3），语义色保持满强度。
    // 这里钉住两件事：行上不许再有 opacity；内容照样逐字读得到。
    stubList([{ ...ALLOW_RULE, enabled: false }])
    mount()
    const row = await screen.findByRole('listitem', { name: /采集权限规则 #20/ })
    expect(row).toHaveAttribute('data-off', 'true')

    const o = getComputedStyle(row).opacity
    expect(o === '' || Number(o) === 1).toBe(true)

    // 停用这件事本身仍然看得见（不是靠"变淡"暗示的）
    expect(row).toHaveTextContent('已停用')
    // 条件与结果照样逐字读得到
    expect(row).toHaveTextContent('会议标题 包含任一「财务」')
    expect(row).toHaveTextContent('准许采集（ai_minutes）')
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

  test('「且 / 或」整条规则只有一个开关——限制由控件的形状说，不由一段说明说', async () => {
    const panel = await openNewAllowRule()
    await userEvent.click(within(panel).getByRole('button', { name: '添加条件' }))
    await userEvent.click(within(panel).getByRole('button', { name: '添加条件' }))

    // 三个条件，连接词却只有一个二选一的开关。以前是每行一个按钮、按一个全变，
    // 于是下面必须挂一段「这是刻意限制」——那是在替一个说谎的控件打补丁
    expect(within(panel).getAllByRole('radio', { name: /以下(全部|任一)条件/ })).toHaveLength(2)
    expect(within(panel).queryAllByRole('button', { name: /连接词/ })).toHaveLength(0)

    await userEvent.click(within(panel).getByRole('radio', { name: /任一条件/ }))
    // 每一行的连接词跟着一起变：它们是这个开关的显示，不是各自的控件
    expect(within(panel).getAllByText('或')).toHaveLength(2)
    expect(within(panel).queryAllByText('且')).toHaveLength(0)
  })

  test('只剩一条条件时干脆没有那个 ×，不是一个点不动的 × 加一句 title', async () => {
    const panel = await openNewAllowRule()
    // 开局就一条条件：删到零会被写侧拒绝（空 conds = 匹配一切），所以这个口子
    // 本来就不存在。以前它是一个 disabled 的 ×，理由写在 title 里——
    // 而 title 要把鼠标停上去才看得见，触屏上看不到
    expect(within(panel).queryByRole('button', { name: /删除第 1 个条件/ })).toBeNull()

    await userEvent.click(within(panel).getByRole('button', { name: '添加条件' }))
    // 有两条了，两条都删得掉
    expect(within(panel).getAllByRole('button', { name: /删除第 \d 个条件/ })).toHaveLength(2)
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

describe('只读账号（spec §11 缺口 1）', () => {
  async function readonlyMount(): Promise<void> {
    stubList([FETCH_RULE, ALLOW_RULE])
    const router = createMemoryRouter([{ path: '/rules', element: <RulesPage /> }], {
      initialEntries: ['/rules'],
    })
    renderAsRole(<RouterProvider router={router} />, 'readonly')
    await screen.findByRole('heading', { name: '自动规则', level: 1 })
  }

  test('三个「新建…规则」全部禁用，且说得出为什么', async () => {
    await readonlyMount()
    const news = await screen.findAllByRole('button', { name: /新建/ })
    expect(news.length).toBeGreaterThan(0)
    for (const b of news) {
      expect(b).toBeDisabled()
      expect(b).toHaveAttribute('title', '只读账号不能改')
    }
  })

  test('逐条的「编辑」「停用/启用」禁用', async () => {
    await readonlyMount()
    for (const b of await screen.findAllByRole('button', { name: '编辑' })) {
      expect(b).toBeDisabled()
    }
    for (const b of screen.getAllByRole('button', { name: /^(停用|启用)$/ })) {
      expect(b).toBeDisabled()
    }
  })

  test('「查看命中」不禁用——那是 GET，只读账号该看得到规则命中了哪几场', async () => {
    await readonlyMount()
    const hits = await screen.findAllByRole('button', { name: /查看命中|场命中/ })
    expect(hits[0]).toBeEnabled()
  })

  test('规则的条件本身仍然逐条写在列表上，只读账号看得到自己看不了编辑器的那部分', async () => {
    await readonlyMount()
    expect(screen.getAllByText(/财务/).length).toBeGreaterThan(0)
  })

  test('管理员这一侧照旧', async () => {
    stubList([FETCH_RULE])
    mount()
    await screen.findByRole('heading', { name: '自动规则', level: 1 })
    expect(screen.getAllByRole('button', { name: '编辑' })[0]).toBeEnabled()
  })
})
