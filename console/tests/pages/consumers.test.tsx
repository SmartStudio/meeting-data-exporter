import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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
}
const DIGEST = {
  id: 'daily-digest',
  name: '简报机器人',
  tmUserId: 'tm-002',
  enabled: true,
  expiresAt: null,
  createdAt: 1700000000,
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
  test('每个外部程序一张卡片，卡片上是名字与 id', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB, DIGEST]])
    respond(/GET .*\/inventory$/, () => [200, inventory()])
    renderPage()

    expect(await screen.findByRole('heading', { name: '知识库索引器', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '简报机器人', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('kb-indexer')).toBeInTheDocument()
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
    expect(reach).toHaveTextContent('现在可取走 4 场会议的 AI 纪要 + 完整转写')
    expect(calls.some((c) => c.url.endsWith('/api/v1/admin/programs/kb-indexer/inventory'))).toBe(true)
  })

  test('列表响应里就算混进一个 scope 配置串，也一个字都不会出现在界面上', async () => {
    // 真实的 GET /programs 不下发 scope。这条测试盯的是"哪怕它下发了，
    // 这一页也不会拿一个配置值冒充求交结果"。
    respond(/GET .*\/admin\/programs$/, () => [200, [{ ...KB, scope: '全部八类资产' }]])
    respond(/GET .*\/inventory$/, () => [200, inventory({ fetchableCount: 4, assetTypes: ['ai_minutes'] })])
    renderPage()

    expect(await screen.findByTestId('reach-kb-indexer')).toHaveTextContent('AI 纪要')
    expect(screen.queryByText(/全部八类资产/)).toBeNull()
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

  test('程序被停用时不许说"现在可取走"——清单端点不看 enabled，它给的是"如果它还能登录"', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [{ ...KB, enabled: false }]])
    respond(/GET .*\/inventory$/, () => [
      200,
      inventory({ fetchableCount: 4, assetTypes: ['ai_minutes'] }),
    ])
    renderPage()

    const reach = await screen.findByTestId('reach-kb-indexer')
    expect(reach).not.toHaveTextContent('现在可取走')
    expect(reach).toHaveTextContent('恢复启用后可取走 4 场会议的 AI 纪要')
    expect(reach).toHaveTextContent('凭据换不到令牌')
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
    expect(await screen.findByTestId('reach-daily-digest')).toHaveTextContent('现在可取走 2 场会议的 AI 纪要')
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

  test('面板顶部复述三个「与」——这一页的读者需要知道这三件事由不同的人维护', async () => {
    const panel = await openList()
    expect(panel).toHaveTextContent('有授权')
    expect(panel).toHaveTextContent('在保留期内')
    expect(panel).toHaveTextContent('规则允许采集')
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
    secret: 's_7Qk2vXe4NpR8tLmA3zYbW6hJfD1cGuS',
    secretShownOnce: true,
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
      '3可取资产',
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

  test('创建之后回不到第一步——再填一遍就是再建一个程序', async () => {
    const panel = await openWizard()
    respond(/POST .*\/admin\/programs$/, () => [201, CREATED])
    await fillBasics(panel)
    await userEvent.click(within(panel).getByRole('button', { name: '创建并生成凭据' }))
    await within(panel).findByText(CREATED.secret)

    expect(within(panel).getByRole('button', { name: '上一步' })).toBeDisabled()
  })

  test('第三步"可取资产"给的是这个新程序的实测清单，不是一组勾选框', async () => {
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

/* ─────────────── 这一轮明确不做的两个动作 ─────────────── */

describe('停用程序 / 轮换凭据这一轮不放按钮', () => {
  test('卡片上没有这两个动作——端点还不存在，放一个点了没反应的按钮更差', async () => {
    respond(/GET .*\/admin\/programs$/, () => [200, [KB]])
    respond(/GET .*\/inventory$/, () => [200, inventory({ fetchableCount: 1, assetTypes: ['ai_minutes'] })])
    renderPage()

    await screen.findByTestId('reach-kb-indexer')
    expect(screen.queryByRole('button', { name: /停用/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /轮换/ })).toBeNull()
  })
})
