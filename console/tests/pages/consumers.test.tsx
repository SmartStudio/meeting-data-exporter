import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { render, renderAsRole } from '../helpers/session'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import ConsumersPage from '../../src/pages/Consumers'

/**
 * 采集授权页（spec §4.5）。
 *
 * 这一页只有一句话是有价值的：「现在可取走 N 场会议的 X」。spec 明说它是
 * **有授权 ∩ 在保留期内 ∩ 规则允许** 三者求交之后的实际结果，所以下面一半的
 * 断言都在盯同一件事——这句话只能从 `GET /programs/:id/inventory` 来，
 * 既不能从 `GET /programs` 的字段来，也不能在拉不到清单时退化成"0 场"。
 *
 * 只挂这一页（不经过 `AppShell`），所以不需要答 `/admin/storage` 与
 * `/admin/jobs`，也不能调 `useSystemStatusView()`。
 */

interface Call {
  method: string
  url: string
  body: unknown
}

let calls: Call[] = []
/** 路由表：路径片段 → [status, body]。按插入顺序取第一个匹配的。 */
let routes: Array<[RegExp, () => [number, unknown]]> = []

function respond(pattern: RegExp, make: () => [number, unknown]): void {
  routes.unshift([pattern, make])
}

function installFetch(): void {
  calls = []
  routes = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = String(input)
      const method = init.method ?? 'GET'
      calls.push({
        method,
        url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      const hit = routes.find(([re]) => re.test(`${method} ${url}`))
      if (!hit) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
      const [status, body] = hit[1]()
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/consumers', element: <ConsumersPage /> }], {
    initialEntries: ['/consumers'],
  })
  return render(<RouterProvider router={router} />)
}

const KB = {
  id: 'kb-indexer',
  name: '知识库索引器',
  tmUserId: 'tm-001',
  enabled: true,
  expiresAt: null,
  createdAt: 1700000000,
  // 自动授权默认关着：开着的那一侧由各条用例自己覆盖成 true
  autoGrant: false,
  autoGrantAssetTypes: null,
}
const DIGEST = {
  id: 'daily-digest',
  name: '简报机器人',
  tmUserId: 'tm-002',
  enabled: true,
  expiresAt: null,
  createdAt: 1700000000,
  autoGrant: false,
  autoGrantAssetTypes: null,
}

function inventory(over: Record<string, unknown> = {}): unknown {
  return {
    programId: 'kb-indexer',
    now: 1700000000,
    fetchableCount: 0,
    blockedCount: 0,
    expiringSoonCount: 0,
    expiringSoonDays: 7,
    assetTypes: [],
    fetchable: [],
    blocked: [],
    ...over,
  }
}

function fetchableItem(over: Record<string, unknown> = {}): unknown {
  return {
    meetingId: 'm-1',
    subMeetingId: '',
    assetTypes: ['ai_minutes', 'transcript'],
    expiresAt: 1700400000,
    expiringSoon: true,
    overridden: false,
    decision: { effect: 'allow', reason: '标题含「周会」，规则 #100', ruleId: 100, note: null, source: 'rule' },
    blockers: [],
    ...over,
  }
}

beforeEach(installFetch)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/* ───────────────────────── 列表本身的三态 ───────────────────────── */

describe('程序列表', () => {
  test('每个外部程序一行，行上是名字与 id（三个程序是同构对象，一张表才给得了对比）', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB, DIGEST]])
    respond(/GET .*\/inventory$/, () => [200, inventory()])
    renderPage()

    expect(await screen.findByRole('heading', { name: '知识库索引器', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '简报机器人', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('kb-indexer')).toBeInTheDocument()

    // 一张真实的表：六列表头 + 一行一个程序，不是卡片网格
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      '程序',
      '现在能取',
      '取不到',
      '操作者身份',
      '接入时间',
      '操作',
    ])
    // 表头一行 + 两个程序两行
    expect(within(table).getAllByRole('row')).toHaveLength(3)
  })

  test('第四个程序接进来只是多一行，不会把版式撑坏（原来的等高卡片会）', async () => {
    const FOURTH = { ...KB, id: 'archive-bot', name: '归档机器人', tmUserId: 'tm-004' }
    respond(/GET .*\/admin\/programs$/, () => [200, [KB, DIGEST, { ...KB, id: 'dw-sync', name: '数据仓库同步' }, FOURTH]])
    respond(/GET .*\/inventory$/, () => [200, inventory({ fetchableCount: 1, assetTypes: ['ai_minutes'] })])
    renderPage()

    // 四个程序都渲染出来，且各自的「现在能取」还是各自程序 id 下的那一份
    expect(await screen.findByRole('heading', { name: '归档机器人', level: 2 })).toBeInTheDocument()
    for (const id of ['kb-indexer', 'daily-digest', 'dw-sync', 'archive-bot']) {
      expect(await screen.findByTestId(`reach-${id}`)).toHaveTextContent('现在可取走 1 场会议的 纪要')
    }
    // 仍然只有一张表、六列表头——不会像卡片网格那样因为奇数个卡片留出空洞
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader')).toHaveLength(6)
    expect(within(table).getAllByRole('row')).toHaveLength(5) // 表头 + 四行
  })

  test('读列表失败时说清是哪一条端点失败了，并给重试——不显示成"一个程序都没有"', async () => {
    respond(/GET .*\/admin\/programs$/, () => [500, { error: 'boom' }])
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('GET /api/v1/admin/programs')
    expect(alert).not.toHaveTextContent('还没有接入')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  test('一个程序都没有是空态，不是错误', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, []])
    renderPage()

    expect(await screen.findByText(/还没有接入任何采集程序/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('空态里就是那一个动作本身，不是一句「点右上角那个按钮」', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, []])
    renderPage()

    const lead = await screen.findByText(/还没有接入任何采集程序/)
    // 按钮与那句话在同一个框里：不用告诉人往哪儿点，够得着就行
    const box = lead.parentElement!
    expect(within(box).getByRole('button', { name: '接入新程序' })).toBeInTheDocument()
    // 全页只有这一个，页头的动作区这时让位——空态上两个同名按钮等于两个入口
    expect(screen.getAllByRole('button', { name: '接入新程序' })).toHaveLength(1)
  })

  test('停用与凭据过期各自标出来——它们是真实字段，不是推出来的', async () => {
    const now = Math.floor(Date.now() / 1000)
    respond(/GET .*\/admin\/programs$/, () => [
      200,
      [
        { ...KB, enabled: false },
        { ...DIGEST, expiresAt: now - 60 },
      ],
    ])
    respond(/GET .*\/inventory$/, () => [200, inventory()])
    renderPage()

    expect(await screen.findByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('凭据已过期')).toBeInTheDocument()
  })
})

/* ────────────────── 这一页的全部价值：求交那句话 ────────────────── */

describe('「现在可取走 N 场会议的 X」', () => {
  test('场次数与资产串都来自 inventory，逐程序一个请求', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/programs\/kb-indexer\/inventory$/, () => [
      200,
      inventory({ fetchableCount: 4, assetTypes: ['ai_minutes', 'transcript'] }),
    ])
    renderPage()

    const reach = await screen.findByTestId('reach-kb-indexer')
    expect(reach).toHaveTextContent('现在可取走 4 场会议的 纪要 + 逐字稿')
    expect(calls.some((c) => c.url.endsWith('/api/v1/admin/programs/kb-indexer/inventory'))).toBe(true)
  })

  test('列表响应里就算混进一个 scope 配置串，也一个字都不会出现在界面上', async () => {
    // 真实的 GET /programs 不下发 scope。这条测试盯的是"哪怕它下发了，
    // 这一页也不会拿一个配置值冒充求交结果"。
    respond(/GET .*\/admin\/programs$/, () => [200, [{ ...KB, scope: '全部六类资产' }]])
    respond(/GET .*\/inventory$/, () => [200, inventory({ fetchableCount: 4, assetTypes: ['ai_minutes'] })])
    renderPage()

    expect(await screen.findByTestId('reach-kb-indexer')).toHaveTextContent('纪要')
    expect(screen.queryByText(/全部六类资产/)).toBeNull()
  })

  test('快到期的那几场用琥珀单独标出，阈值跟着响应走', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [
      200,
      inventory({ fetchableCount: 4, assetTypes: ['ai_minutes'], expiringSoonCount: 1, expiringSoonDays: 7 }),
    ])
    renderPage()

    expect(await screen.findByTestId('reach-kb-indexer')).toHaveTextContent('其中 1 场 7 天内到期')
  })

  test('一场都取不到时说的是"0 场对它开放"，并说清为什么', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [
      200,
      inventory({
        blockedCount: 2,
        blocked: [
          {
            ...(fetchableItem() as Record<string, unknown>),
            meetingId: 'm-purged',
            assetTypes: [],
            expiringSoon: false,
            decision: null,
            blockers: [{ code: 'local_purged', remedy: 'nas', reason: '本地文件已到期清理' }],
          },
          {
            ...(fetchableItem() as Record<string, unknown>),
            meetingId: 'm-9',
            assetTypes: [],
            expiringSoon: false,
            decision: null,
            blockers: [{ code: 'rule_denied', remedy: 'rules', reason: '采集权限规则 #7 拒绝' }],
          },
        ],
      }),
    ])
    renderPage()

    const reach = await screen.findByTestId('reach-kb-indexer')
    expect(reach).toHaveTextContent('0 场会议对它开放')
    expect(reach).not.toHaveTextContent('可取走 0 场')
    expect(await screen.findByText(/本地文件已清理/)).toBeInTheDocument()
    expect(screen.getByText(/规则拒绝/)).toBeInTheDocument()
  })

  test('程序被停用时这一格显示「已停用」，不显示那个会骗人的数（F7 / spec §1.3）', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [{ ...KB, enabled: false }]])
    respond(/GET .*\/inventory$/, () => [
      200,
      inventory({ fetchableCount: 4, assetTypes: ['ai_minutes'] }),
    ])
    renderPage()

    const reach = await screen.findByTestId('reach-kb-indexer')
    expect(reach).toHaveAttribute('data-kind', 'disabled')
    // 数字的位置上是状态本身，不是 4
    expect(within(reach).getByText('已停用')).toBeInTheDocument()
    expect(reach).toHaveTextContent('现在 0 场会议对它开放')
    expect(reach).not.toHaveTextContent('现在可取走')
    expect(reach).not.toHaveTextContent('可取走 4 场')
  })

  test('那份"如果它还能登录"的清单降到下面一行，仍然说得出来，但不冒充「现在」', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [{ ...KB, enabled: false }]])
    respond(/GET .*\/inventory$/, () => [
      200,
      inventory({ fetchableCount: 4, assetTypes: ['ai_minutes'] }),
    ])
    renderPage()

    const note = await screen.findByTestId('reach-kb-indexer-ifenabled')
    // 数与资产串照说，但整句话必须带着「恢复启用后」这个前提——它不是「现在」
    expect(note).toHaveTextContent('4 场会议的 纪要')
    expect(note.textContent ?? '').toMatch(/^恢复启用后/)
    expect(screen.getByTestId('reach-kb-indexer')).not.toHaveTextContent('现在可取走')
  })

  test('停用且清单本来就是空的时候，下面那一行说的是"恢复启用后也一场都取不到"', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [{ ...KB, enabled: false }]])
    respond(/GET .*\/inventory$/, () => [200, inventory()])
    renderPage()

    expect(await screen.findByTestId('reach-kb-indexer-ifenabled')).toHaveTextContent(
      '恢复启用后它也一场都取不到',
    )
  })

  test('「停用立刻生效 / 授权没删」只在按下停用的那一刻说，不常驻在卡片上', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [{ ...KB, enabled: false }]])
    respond(/GET .*\/inventory$/, () => [200, inventory({ fetchableCount: 4, assetTypes: ['ai_minutes'] })])
    renderPage()

    // 已经停用之后，卡片要答的是「现在取不到」这个状态，不是复述一遍停用的语义
    const reach = await screen.findByTestId('reach-kb-indexer')
    expect(reach).toHaveTextContent('已停用')
    expect(reach).toHaveTextContent('现在 0 场会议对它开放')
    expect(reach).not.toHaveTextContent('停用立刻生效')

    // 那件事在做决定的那一刻说得清清楚楚（confirm-disable 那条测试断言它的内容）
    await userEvent.click(screen.getByRole('button', { name: '启用' }))
    expect(await screen.findByTestId('confirm-enable')).toHaveTextContent('授权一条都没删')
  })

  test('凭据过期时同理，说的是"换发凭据后"', async () => {
    const now = Math.floor(Date.now() / 1000)
    respond(/GET .*\/admin\/programs$/, () => [200, [{ ...KB, expiresAt: now - 60 }]])
    respond(/GET .*\/inventory$/, () => [
      200,
      inventory({ fetchableCount: 4, assetTypes: ['ai_minutes'] }),
    ])
    renderPage()

    expect(await screen.findByTestId('reach-kb-indexer')).toHaveTextContent('换发凭据后可取走 4 场会议')
  })

  test('从来没授权过（blocked 也是空）时说的是"还没有任何会议授权给它"', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [200, inventory()])
    renderPage()

    expect(await screen.findByTestId('reach-kb-indexer')).toHaveTextContent('还没有任何会议授权给它')
  })

  test('一场都没授权时给的出路是"先授权、再放行"两步，不是二选一', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [200, inventory()])
    renderPage()

    const reach = await screen.findByTestId('reach-kb-indexer')
    // spec §1.3 的三个条件是「与」：只补授权、或只放行规则，这个数都还是 0。
    // 顺序必须是先规则、后授权：会议记录页只给规则已判「准许」的会议画授权入口
    // （`grantCellKind`），规则全是 deny 时那里一个按钮都没有。
    expect(reach).toHaveTextContent('先到「自动规则」')
    expect(reach).toHaveTextContent('然后到「会议记录」把会议授权给它')
    // 原来那句把两步写成了二选一，照着它走的人一直卡在 0 场。
    expect(reach).not.toHaveTextContent('或在「会议记录」里逐场授权')
    // 也不许把顺序写反：先授权的话，管理员会去找一个不存在的按钮。
    expect(reach).not.toHaveTextContent('先在「会议记录」')
  })

  test('能取走的同时另有取不到的，也要把后者说出来', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [
      200,
      inventory({
        fetchableCount: 1,
        assetTypes: ['ai_minutes'],
        fetchable: [fetchableItem()],
        blockedCount: 1,
        blocked: [
          {
            ...(fetchableItem() as Record<string, unknown>),
            meetingId: 'm-purged',
            decision: null,
            blockers: [{ code: 'local_purged', remedy: 'nas', reason: '本地文件已到期清理' }],
          },
        ],
      }),
    ])
    renderPage()

    expect(await screen.findByText(/另有 1 场已授权但现在取不到/)).toBeInTheDocument()
  })
})

/* ─────────────── 拉不到清单 ≠ 什么都取不到（不许静默放行）─────────────── */

describe('清单拉不到的时候', () => {
  test('显示「清单暂不可得」与原因，绝不显示成 0 场', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [503, { error: 'db_down' }])
    renderPage()

    const reach = await screen.findByTestId('reach-kb-indexer')
    expect(reach).toHaveTextContent('清单暂不可得')
    expect(reach).toHaveTextContent('db_down')
    expect(reach).not.toHaveTextContent('0 场')
    expect(reach).not.toHaveTextContent('可取走')
  })

  test('程序不存在（404）是另一回事，说出来而不是混进"暂不可得"的通用话术', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [404, { error: 'program_not_found' }])
    renderPage()

    expect(await screen.findByTestId('reach-kb-indexer')).toHaveTextContent('这个程序在后端已经不存在')
  })

  test('拉不到清单时不给「查看清单」按钮——没有清单可看，放一个点了没内容的按钮更差', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [503, { error: 'db_down' }])
    renderPage()

    await screen.findByText(/清单暂不可得/)
    expect(screen.queryByRole('button', { name: /查看清单/ })).toBeNull()
  })

  test('一个程序的清单挂了，不影响另一个程序的卡片', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB, DIGEST]])
    respond(/GET .*\/programs\/kb-indexer\/inventory$/, () => [503, { error: 'db_down' }])
    respond(/GET .*\/programs\/daily-digest\/inventory$/, () => [
      200,
      inventory({ programId: 'daily-digest', fetchableCount: 2, assetTypes: ['ai_minutes'] }),
    ])
    renderPage()

    expect(await screen.findByTestId('reach-kb-indexer')).toHaveTextContent('清单暂不可得')
    expect(await screen.findByTestId('reach-daily-digest')).toHaveTextContent('现在可取走 2 场会议的 纪要')
  })

  test('重试只重拉这一个程序的清单', async () => {
    let hits = 0
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => {
      hits += 1
      return hits === 1
        ? [503, { error: 'db_down' }]
        : [200, inventory({ fetchableCount: 3, assetTypes: ['ai_minutes'] })]
    })
    renderPage()

    await screen.findByText(/清单暂不可得/)
    await userEvent.click(screen.getByRole('button', { name: '重新读取清单' }))
    expect(await screen.findByTestId('reach-kb-indexer')).toHaveTextContent('现在可取走 3 场会议')
  })
})

/* ───────────────────────── 查看清单 ───────────────────────── */

describe('查看清单', () => {
  async function openList(): Promise<HTMLElement> {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [
      200,
      inventory({
        fetchableCount: 1,
        assetTypes: ['ai_minutes', 'transcript'],
        expiringSoonCount: 1,
        fetchable: [fetchableItem()],
        blockedCount: 1,
        blocked: [
          {
            ...(fetchableItem() as Record<string, unknown>),
            meetingId: 'm-purged',
            assetTypes: [],
            expiringSoon: false,
            decision: null,
            blockers: [{ code: 'local_purged', remedy: 'nas', reason: '本地文件已到期清理（/nas/2026/05/m-purged）' }],
          },
        ],
      }),
    ])
    renderPage()
    await screen.findByTestId('reach-kb-indexer')
    await userEvent.click(screen.getByRole('button', { name: /查看清单/ }))
    return screen.getByRole('dialog', { name: /知识库索引器 现在能取走什么/ })
  }

  test('面板里逐条列出能取到的与取不到的，取不到的带后端原话', async () => {
    const panel = await openList()
    expect(within(panel).getByText('m-1')).toBeInTheDocument()
    expect(within(panel).getByText('m-purged')).toBeInTheDocument()
    expect(within(panel).getByText(/本地文件已到期清理（\/nas\/2026\/05\/m-purged）/)).toBeInTheDocument()
  })

  test('面板顶部给的是两个数：授权了几场、其中现在真能取到几场', async () => {
    const panel = await openList()
    expect(panel).toHaveTextContent('已授权 2 场')
    expect(panel).toHaveTextContent('现在能取到 1 场')
    // 「取不到的那几场为什么取不到」由逐行的判定理由回答，不再由顶部一段总论回答
    expect(within(panel).getByText(/本地文件已按保留期清理/)).toBeInTheDocument()
  })

  test('能取到的那几场把判定理由带出来，不是只给一个绿点', async () => {
    const panel = await openList()
    expect(within(panel).getByText(/标题含「周会」，规则 #100/)).toBeInTheDocument()
  })
})

/* ───────────────────────── 接入向导 ───────────────────────── */

describe('接入向导', () => {
  const CREATED = {
    id: 'new-prog',
    name: '新程序',
    tmUserId: 'tm-9',
    enabled: true,
    expiresAt: null,
    createdAt: 1700000000,
    autoGrant: false,
    autoGrantAssetTypes: null,
    secret: 's_7Qk2vXe4NpR8tLmA3zYbW6hJfD1cGuS',
    secretShownOnce: true,
    // A8 之后建号与轮换下发同一句话，界面上两处都读它、都不改写
    secretNote: '这是唯一一次能看到这个凭据明文的机会：服务端只存哈希，此后无从还原。',
  }

  async function openWizard(): Promise<HTMLElement> {
    respond(/GET .*\/admin\/programs$/, () => [200, []])
    renderPage()
    await screen.findByText(/还没有接入任何采集程序/)
    await userEvent.click(screen.getByRole('button', { name: '接入新程序' }))
    return screen.getByRole('dialog', { name: /接入新的采集程序/ })
  }

  async function fillBasics(panel: HTMLElement): Promise<void> {
    await userEvent.type(within(panel).getByLabelText(/程序 id/), 'new-prog')
    await userEvent.type(within(panel).getByLabelText(/程序名称/), '新程序')
    await userEvent.type(within(panel).getByLabelText(/操作者身份/), 'tm-9')
  }

  test('四步，当前一步标成 aria-current', async () => {
    const panel = await openWizard()
    const steps = within(panel).getAllByRole('listitem')
    expect(steps.map((s) => s.textContent)).toEqual([
      '1基本信息',
      '2生成凭据',
      '3可取清单',
      '4接入方式',
    ])
    expect(steps[0]).toHaveAttribute('aria-current', 'step')
  })

  test('必填项没填时不发请求，错误落在具体那一栏上', async () => {
    const panel = await openWizard()
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))

    expect(within(panel).getByLabelText(/程序 id/)).toHaveAttribute('aria-invalid', 'true')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  test('请求体按契约发：不填到期日就不发这个键', async () => {
    const panel = await openWizard()
    respond(/POST .*\/admin\/programs$/, () => [201, CREATED])
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))

    await screen.findByText(/只出现这一次/)
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.body).toEqual({ id: 'new-prog', name: '新程序', tmUserId: 'tm-9' })
  })

  test('id 被占用时把后端的话翻成人话，人还留在第一步', async () => {
    const panel = await openWizard()
    respond(/POST .*\/admin\/programs$/, () => [409, { error: 'program_id_taken' }])
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))

    expect(await within(panel).findByRole('alert')).toHaveTextContent('已经被占用')
    expect(within(panel).getByLabelText(/程序 id/)).toBeInTheDocument()
  })

  test('第二步：明文只出现一次，没勾"已保存"就走不掉，也关不掉', async () => {
    const panel = await openWizard()
    respond(/POST .*\/admin\/programs$/, () => [201, CREATED])
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))

    expect(await within(panel).findByText(CREATED.secret)).toBeInTheDocument()
    const next = within(panel).getByRole('button', { name: '下一步' })
    expect(next).toBeDisabled()

    await userEvent.click(within(panel).getByRole('button', { name: '关闭' }))
    expect(within(panel).getByText(CREATED.secret)).toBeInTheDocument()
    expect(within(panel).getByRole('alert')).toHaveTextContent('关掉之后不能再取回')

    await userEvent.click(within(panel).getByLabelText(/我已经把 Secret 保存好了/))
    expect(next).toBeEnabled()
  })

  test('关不掉时那句提醒指向真实存在的「轮换凭据」，不说「还没有」', async () => {
    const panel = await openWizard()
    respond(/POST .*\/admin\/programs$/, () => [201, CREATED])
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))
    await within(panel).findByText(CREATED.secret)
    await userEvent.click(within(panel).getByRole('button', { name: '关闭' }))

    const alert = within(panel).getByRole('alert')
    // 轮换端点（POST /programs/:id/rotate-secret）阶段 5 就做了，卡片上的
    // 「轮换凭据」正在调它。告诉管理员「还没有」会让他以为丢了 Secret 就只能删号重建
    expect(alert).toHaveTextContent('轮换凭据')
    expect(alert.textContent ?? '').not.toContain('还没有')
  })

  test('创建之后回不到第一步——再填一遍就是再建一个程序', async () => {
    const panel = await openWizard()
    respond(/POST .*\/admin\/programs$/, () => [201, CREATED])
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))
    await within(panel).findByText(CREATED.secret)

    expect(within(panel).getByRole('button', { name: '上一步' })).toBeDisabled()
  })

  test('第三步"可取清单"给的是这个新程序的实测清单，不是一组勾选框', async () => {
    const panel = await openWizard()
    respond(/POST .*\/admin\/programs$/, () => [201, CREATED])
    respond(/GET .*\/programs\/new-prog\/inventory$/, () => [200, inventory({ programId: 'new-prog' })])
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))
    await within(panel).findByText(CREATED.secret)
    await userEvent.click(within(panel).getByLabelText(/我已经把 Secret 保存好了/))
    await userEvent.click(within(panel).getByRole('button', { name: '下一步' }))

    expect(await within(panel).findByTestId('reach-new-prog')).toHaveTextContent('0 场会议对它开放')
    expect(within(panel).queryByRole('checkbox', { name: /录像/ })).toBeNull()
  })

  test('第四步给的是真实端点，完成后列表重拉一次', async () => {
    let listHits = 0
    respond(/GET .*\/admin\/programs$/, () => {
      listHits += 1
      return listHits === 1 ? [200, []] : [200, [{ ...KB, id: 'new-prog', name: '新程序' }]]
    })
    renderPage()
    await screen.findByText(/还没有接入任何采集程序/)
    await userEvent.click(screen.getByRole('button', { name: '接入新程序' }))
    const panel = screen.getByRole('dialog', { name: /接入新的采集程序/ })

    respond(/POST .*\/admin\/programs$/, () => [201, CREATED])
    respond(/GET .*\/inventory$/, () => [200, inventory({ programId: 'new-prog' })])
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))
    await within(panel).findByText(CREATED.secret)
    await userEvent.click(within(panel).getByLabelText(/我已经把 Secret 保存好了/))
    await userEvent.click(within(panel).getByRole('button', { name: '下一步' }))
    await within(panel).findByTestId('reach-new-prog')
    await userEvent.click(within(panel).getByRole('button', { name: '下一步' }))

    expect(within(panel).getByText(/\/api\/v1\/auth\/service-token/)).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: '完成接入' }))

    await waitFor(() => expect(listHits).toBe(2))
    expect(await screen.findByRole('heading', { name: '新程序', level: 2 })).toBeInTheDocument()
  })

  test('关掉再打开，明文不会第二次出现', async () => {
    let listHits = 0
    respond(/GET .*\/admin\/programs$/, () => {
      listHits += 1
      return listHits === 1 ? [200, []] : [200, [{ ...KB, id: 'new-prog', name: '新程序' }]]
    })
    respond(/POST .*\/admin\/programs$/, () => [201, CREATED])
    respond(/GET .*\/inventory$/, () => [200, inventory({ programId: 'new-prog' })])
    renderPage()
    await screen.findByText(/还没有接入任何采集程序/)
    await userEvent.click(screen.getByRole('button', { name: '接入新程序' }))
    let panel = screen.getByRole('dialog', { name: /接入新的采集程序/ })
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))
    await within(panel).findByText(CREATED.secret)
    await userEvent.click(within(panel).getByLabelText(/我已经把 Secret 保存好了/))
    await userEvent.click(within(panel).getByRole('button', { name: '关闭' }))

    await screen.findByRole('heading', { name: '新程序', level: 2 })
    await userEvent.click(screen.getByRole('button', { name: '接入新程序' }))
    panel = screen.getByRole('dialog', { name: /接入新的采集程序/ })
    expect(within(panel).queryByText(CREATED.secret)).toBeNull()
    expect(within(panel).getByLabelText(/程序 id/)).toHaveValue('')
  })
})

/* ─────────────── 停用 / 轮换（spec §11 缺口 4，端点由 A8 补）─────────────── */

const ROTATED = {
  id: 'kb-indexer',
  name: '知识库索引器',
  rotatedAt: 1700000000,
  secret: 'brand-new-secret',
  secretShownOnce: true,
  secretNote: '这是唯一一次能看到这个凭据明文的机会：服务端只存哈希，此后无从还原。',
}

async function cardReady(program: Record<string, unknown> = KB): Promise<void> {
  respond(/GET .*\/admin\/programs$/, () => [200, [program]])
  respond(/GET .*\/inventory$/, () => [200, inventory({ fetchableCount: 1, assetTypes: ['ai_minutes'] })])
  renderPage()
  await screen.findByTestId('reach-kb-indexer')
}

describe('停用 / 启用', () => {
  test('按「停用」先弹二次确认，这时还没发任何请求', async () => {
    await cardReady()
    const before = calls.length
    await userEvent.click(screen.getByRole('button', { name: '停用' }))
    expect(await screen.findByTestId('confirm-disable')).toBeInTheDocument()
    expect(calls.length).toBe(before)
  })

  test('确认框里说清了两件事：立刻生效（含已签发的令牌）、授权一条都不删', async () => {
    await cardReady()
    await userEvent.click(screen.getByRole('button', { name: '停用' }))
    const box = await screen.findByTestId('confirm-disable')
    expect(box).toHaveTextContent('立刻')
    expect(box).toHaveTextContent('已经签发、还没过期的访问令牌')
    expect(box).toHaveTextContent('已有的授权一条都不会删')
    expect(box).toHaveTextContent('停用是可逆的')
  })

  test('确认之后发 PATCH，且请求体是真布尔 false', async () => {
    await cardReady()
    respond(/PATCH .*\/admin\/programs\/kb-indexer$/, () => [200, { ...KB, enabled: false }])
    await userEvent.click(screen.getByRole('button', { name: '停用' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认停用' }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(patch!.body).toEqual({ enabled: false })
    })
  })

  test('成功之后重取列表——不做乐观更新，卡片上的状态是后端说的', async () => {
    await cardReady()
    respond(/PATCH .*\/admin\/programs\/kb-indexer$/, () => [200, { ...KB, enabled: false }])
    const getsBefore = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/admin/programs')).length

    await userEvent.click(screen.getByRole('button', { name: '停用' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认停用' }))

    await waitFor(() => {
      const after = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/admin/programs')).length
      expect(after).toBeGreaterThan(getsBefore)
    })
  })

  test('已停用的程序上那个按钮是「启用」，确认框说凭据没变', async () => {
    await cardReady({ ...KB, enabled: false })
    await userEvent.click(screen.getByRole('button', { name: '启用' }))
    const box = await screen.findByTestId('confirm-enable')
    expect(box).toHaveTextContent('凭据没有变')
  })

  test('后端拒绝时把它那句话原样显示出来，不是一句"操作失败"', async () => {
    await cardReady()
    respond(/PATCH .*\/admin\/programs\/kb-indexer$/, () => [
      400,
      { error: 'invalid_enabled', hint: 'enabled 必须是 true 或 false' },
    ])
    await userEvent.click(screen.getByRole('button', { name: '停用' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认停用' }))

    const err = await screen.findByTestId('action-error-kb-indexer')
    expect(err).toHaveTextContent('invalid_enabled')
    expect(err).toHaveTextContent('/api/v1/admin/programs/kb-indexer')
  })
})

describe('轮换凭据：一次性展示', () => {
  test('先二次确认，且说清旧凭据当场失效', async () => {
    await cardReady()
    await userEvent.click(screen.getByRole('button', { name: '轮换凭据' }))
    const box = await screen.findByTestId('confirm-rotate')
    expect(box).toHaveTextContent('旧凭据当场失效')
    expect(box).toHaveTextContent('401')
    expect(box).toHaveTextContent('只显示这一次')
  })

  test('确认之后发 POST，新明文与后端那句话都上屏', async () => {
    await cardReady()
    respond(/POST .*\/rotate-secret$/, () => [200, ROTATED])
    await userEvent.click(screen.getByRole('button', { name: '轮换凭据' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认轮换' }))

    const panel = await screen.findByTestId('rotated-secret')
    expect(within(panel).getByText('brand-new-secret')).toBeInTheDocument()
    // 后端下发的那句原样上屏，前端不改写
    expect(screen.getByTestId('rotated-note')).toHaveTextContent(ROTATED.secretNote)
  })

  test('没勾「我已经保存好了」就关，会被再问一遍，而不是一声不吭地关掉', async () => {
    await cardReady()
    respond(/POST .*\/rotate-secret$/, () => [200, ROTATED])
    await userEvent.click(screen.getByRole('button', { name: '轮换凭据' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认轮换' }))
    await screen.findByTestId('rotated-secret')

    await userEvent.click(screen.getByRole('button', { name: '关掉这一屏' }))
    expect(await screen.findByTestId('rotated-leave-warn')).toHaveTextContent('再也拿不到')
    // 面板还在：明文没有被悄悄收走
    expect(screen.getByTestId('rotated-secret')).toBeInTheDocument()
  })

  test('勾了之后才关得掉', async () => {
    await cardReady()
    respond(/POST .*\/rotate-secret$/, () => [200, ROTATED])
    await userEvent.click(screen.getByRole('button', { name: '轮换凭据' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认轮换' }))
    await screen.findByTestId('rotated-secret')

    await userEvent.click(screen.getByLabelText('我已经把新 Secret 保存好了'))
    await userEvent.click(screen.getByRole('button', { name: '关掉这一屏' }))
    await waitFor(() => expect(screen.queryByTestId('rotated-secret')).toBeNull())
  })

  test('轮换失败时不弹那一屏，改把错误说出来', async () => {
    await cardReady()
    respond(/POST .*\/rotate-secret$/, () => [404, { error: 'program_not_found' }])
    await userEvent.click(screen.getByRole('button', { name: '轮换凭据' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认轮换' }))

    expect(await screen.findByTestId('action-error-kb-indexer')).toHaveTextContent('program_not_found')
    expect(screen.queryByTestId('rotated-secret')).toBeNull()
  })
})

/* ─────────────── 自动授权（方案 2：程序级开关）─────────────── */

const KB_AUTO = { ...KB, autoGrant: true, autoGrantAssetTypes: ['ai_minutes', 'transcript'] }

describe('自动授权开关', () => {
  test('关着时按钮写「开启自动授权」，点了先弹面板，这时还没发任何请求', async () => {
    await cardReady()
    const before = calls.length
    await userEvent.click(screen.getByRole('button', { name: '开启自动授权' }))
    expect(await screen.findByTestId('confirm-auto-on')).toBeInTheDocument()
    expect(calls.length).toBe(before)
  })

  test('开启面板逐条写着三条规矩，外加"只授权哪些会议"那一句', async () => {
    await cardReady()
    await userEvent.click(screen.getByRole('button', { name: '开启自动授权' }))
    const box = await screen.findByTestId('confirm-auto-on')
    // 1 时机：接在拉取 / 归档后面跑，另有 5 分钟兜底
    expect(box).toHaveTextContent('每 5 分钟')
    expect(box).toHaveTextContent('拉取新录制')
    // 2 人工撤销过的不再补回来——人的决定压过开关
    expect(box).toHaveTextContent('你手动撤销过的会议不会被自动补回来')
    // 3 关掉开关不收回已有授权
    expect(box).toHaveTextContent('关掉开关不收回已经授权的会议')
    // 候选判据：它不改判定，只在规则已判准许、文件还在本地的会议上动手
    expect(box).toHaveTextContent('只授权规则已判准许、且文件还在本地的会议')
    // 面板标题是那句问句，不是一个动作名
    expect(screen.getByRole('dialog', { name: '让规则替它授权？' })).toBeInTheDocument()
  })

  test('默认「不限制」：请求体里 autoGrantAssetTypes 是 null，不是八类全给', async () => {
    await cardReady()
    respond(/PATCH .*\/admin\/programs\/kb-indexer$/, () => [200, KB_AUTO])
    await userEvent.click(screen.getByRole('button', { name: '开启自动授权' }))
    expect(await screen.findByLabelText('不限制（以规则判定为准）')).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '确认开启' }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(patch!.body).toEqual({ autoGrant: true, autoGrantAssetTypes: null })
    })
  })

  test('切到「只授权这几类」并勾三类，请求体就是那三个键', async () => {
    await cardReady()
    respond(/PATCH .*\/admin\/programs\/kb-indexer$/, () => [200, KB_AUTO])
    await userEvent.click(screen.getByRole('button', { name: '开启自动授权' }))
    await userEvent.click(await screen.findByLabelText('只授权这几类'))
    for (const name of ['录像', '纪要', '逐字稿']) {
      await userEvent.click(screen.getByLabelText(name))
    }
    await userEvent.click(screen.getByRole('button', { name: '确认开启' }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(patch!.body).toEqual({
        autoGrant: true,
        autoGrantAssetTypes: ['video', 'ai_minutes', 'transcript'],
      })
    })
  })

  test('一类都没勾时确认按钮禁用，并说出该怎么办——不让人点下去等 400', async () => {
    await cardReady()
    await userEvent.click(screen.getByRole('button', { name: '开启自动授权' }))
    await userEvent.click(await screen.findByLabelText('只授权这几类'))

    expect(screen.getByRole('button', { name: '确认开启' })).toBeDisabled()
    expect(screen.getByTestId('auto-grant-scope-empty')).toHaveTextContent('至少勾一类，或改回不限制')

    // 勾上一类就点得动了
    await userEvent.click(screen.getByLabelText('纪要'))
    expect(screen.getByRole('button', { name: '确认开启' })).toBeEnabled()
  })

  test('开着时按钮写「关闭自动授权」，面板说清已经授权的一条都不收回', async () => {
    await cardReady(KB_AUTO)
    await userEvent.click(screen.getByRole('button', { name: '关闭自动授权' }))
    const box = await screen.findByTestId('confirm-auto-off')
    expect(box).toHaveTextContent('关掉之后新会议不再自动授权')
    expect(box).toHaveTextContent('已经授权的会议一条都不收回')
    expect(box).toHaveTextContent('要收回去会议记录页批量收回')
    // 关闭面板里没有资产范围：那一档是开的时候才要决定的事
    expect(screen.queryByTestId('auto-grant-scope')).toBeNull()
  })

  test('关掉时请求体是 autoGrant:false，且现有范围原样带回去（不顺手清掉）', async () => {
    await cardReady(KB_AUTO)
    respond(/PATCH .*\/admin\/programs\/kb-indexer$/, () => [200, KB])
    await userEvent.click(screen.getByRole('button', { name: '关闭自动授权' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认关闭' }))

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(patch!.body).toEqual({
        autoGrant: false,
        autoGrantAssetTypes: ['ai_minutes', 'transcript'],
      })
    })
  })

  test('成功之后重取列表——不做乐观更新，开关的状态是后端说的', async () => {
    await cardReady()
    respond(/PATCH .*\/admin\/programs\/kb-indexer$/, () => [200, KB_AUTO])
    const before = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/admin/programs')).length

    await userEvent.click(screen.getByRole('button', { name: '开启自动授权' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认开启' }))

    await waitFor(() => {
      const after = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/admin/programs')).length
      expect(after).toBeGreaterThan(before)
    })
  })

  test('后端拒绝时翻成人话，并把 issues 里逐条点名的资产键带出来', async () => {
    await cardReady()
    respond(/PATCH .*\/admin\/programs\/kb-indexer$/, () => [
      400,
      {
        error: 'invalid_auto_grant_asset_types',
        hint: '空数组存不进去',
        issues: ['认不出的资产类型「summary」'],
      },
    ])
    await userEvent.click(screen.getByRole('button', { name: '开启自动授权' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认开启' }))

    const err = await screen.findByTestId('action-error-kb-indexer')
    expect(err).toHaveTextContent('资产范围不合法')
    expect(err).toHaveTextContent('summary')
  })

  test('开着的程序在名字旁挂一个徽标；关着的不挂', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB_AUTO, DIGEST]])
    respond(/GET .*\/inventory$/, () => [200, inventory({ fetchableCount: 1, assetTypes: ['ai_minutes'] })])
    renderPage()

    // 等清单真的到了：骨架那一帧里两行都还没有名字，那时的断言是空话
    await screen.findByTestId('reach-kb-indexer')
    await screen.findByTestId('reach-daily-digest')
    const rows = screen.getAllByRole('row')
    // 表头一行 + 两个程序
    const kbRow = rows[1]!
    const digestRow = rows[2]!
    expect(within(kbRow).getByText('自动授权')).toBeInTheDocument()
    expect(within(digestRow).queryByText('自动授权')).toBeNull()
  })

  test('一场都取不到时，开着自动授权的那句话指向规则，不再叫人去逐场授权', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB_AUTO]])
    respond(/GET .*\/inventory$/, () => [200, inventory()])
    renderPage()

    const reach = await screen.findByTestId('reach-kb-indexer')
    expect(reach).toHaveTextContent('已开自动授权')
    expect(reach).toHaveTextContent('多半是还没有一条对它放行的采集权限规则')
    // 逐场授权那一步现在由任务代做，不该再让人去做一遍
    expect(reach).not.toHaveTextContent('然后到「会议记录」把会议授权给它')
  })

  test('关着的时候那句两步提示一个字都没变', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [200, inventory()])
    renderPage()

    const reach = await screen.findByTestId('reach-kb-indexer')
    expect(reach).toHaveTextContent('还没有任何会议授权给它')
    expect(reach).toHaveTextContent('然后到「会议记录」把会议授权给它')
    expect(reach).not.toHaveTextContent('已开自动授权')
  })
})

describe('只读账号（spec §11 缺口 1）', () => {
  async function readonlyCard(): Promise<void> {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [200, inventory({ fetchableCount: 1, assetTypes: ['ai_minutes'] })])
    const router = createMemoryRouter([{ path: '/consumers', element: <ConsumersPage /> }], {
      initialEntries: ['/consumers'],
    })
    renderAsRole(<RouterProvider router={router} />, 'readonly')
    await screen.findByTestId('reach-kb-indexer')
  }

  test('四个写入口全部禁用，且都说得出为什么', async () => {
    await readonlyCard()
    for (const name of ['接入新程序', '停用', '轮换凭据', '开启自动授权']) {
      const btn = screen.getByRole('button', { name })
      expect(btn, name).toBeDisabled()
      expect(btn, name).toHaveAttribute('title', '只读账号不能改')
    }
  })

  test('「查看清单」不禁用——它是读，只读账号本来就该看得到', async () => {
    await readonlyCard()
    expect(screen.getByRole('button', { name: '查看清单' })).toBeEnabled()
  })

  test('禁用了也不隐藏：按钮还在，只是点不动', async () => {
    await readonlyCard()
    expect(screen.getByRole('button', { name: '停用' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '轮换凭据' })).toBeInTheDocument()
  })
})
