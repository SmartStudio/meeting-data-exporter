import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StoragePage from '../../src/pages/Storage'
import { fmtBytes, fmtDateTime } from '../../src/lib/format'

/**
 * 归档存储页（spec.md §4.9）。
 *
 * 这一页有一个别的页面没有的特点：**它上面唯一一个不可逆的动作**（立即清理
 * 已到期文件）删掉的东西找不回来。所以下面的测试里有相当一部分不是在测
 * "点了有没有反应"，而是在测"点之前有没有把话说清楚"：
 *
 *   - 二次确认框里必须同时写明**删的是什么**与**留下的是什么**
 *   - 清理被暂停时那颗红按钮必须点不动，且**点不动的原因写在界面上**
 *   - `failedMeetings` 拿不到时显示"暂不可得"，不是 0——0 的意思是"确实没有"
 *   - `defaultDaysSource` 的三个取值在界面上分得开，尤其 `invalid`
 *
 * 另外，系统状态横幅上的「暂停到期清理」现在链到 `/storage`（见 F0 报告 §2.2），
 * 所以「暂停/恢复到期清理」这个动作必须在这一页上真的做得成。
 */

/* ── 后端替身 ──────────────────────────────────────────────────── */

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[] = []
let routes: Record<string, Array<{ status: number; body: unknown }>> = {}

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
      failedMeetingsNote: '归档失败项尚未落库：失败原因目前只写进 worker 日志。',
      ...over.nas,
    },
    retention: {
      defaultDays: 30,
      defaultDaysSource: 'setting',
      defaultDaysRaw: '30',
      cleanupPaused: false,
      liveMeetings: 10,
      grantedMeetings: 8,
      expiringIn7dMeetings: 1,
      expiredMeetings: 2,
      localBytes: 900000000,
      ...over.retention,
    },
  }
}

/** 某条路径的下一次应答。给多个就按调用顺序依次用，最后一个反复用。 */
function answer(path: string, ...responses: Array<{ status: number; body: unknown }>): void {
  routes[path] = responses
}

function ok(body: unknown): { status: number; body: unknown } {
  return { status: 200, body }
}

function nextFor(path: string): { status: number; body: unknown } {
  const queue = routes[path]
  if (!queue || queue.length === 0) throw new Error(`Storage.test.tsx: 未预期的请求 ${path}`)
  return queue.length === 1 ? queue[0]! : queue.shift()!
}

beforeEach(() => {
  calls = []
  routes = {}
  answer('/api/v1/admin/storage', ok(storagePayload()))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const path = url.split('?')[0] ?? url
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      calls.push({ url, method: init?.method ?? 'GET', body })
      const res = nextFor(path)
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderReady(): Promise<void> {
  render(<StoragePage />)
  await screen.findByRole('heading', { name: 'NAS 归档', level: 2 })
}

function panel(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function stat(id: string): HTMLElement {
  return screen.getByTestId(`stat-${id}`)
}

/* ── 页面骨架 ──────────────────────────────────────────────────── */

describe('归档存储页 · 三态', () => {
  test('加载中给骨架，不先渲染一堆 0', async () => {
    render(<StoragePage />)
    expect(screen.getByTestId('storage-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('stat-archived')).toBeNull()
    await screen.findByRole('heading', { name: 'NAS 归档', level: 2 })
  })

  test('读取失败时说清是哪条端点，并给重试', async () => {
    answer('/api/v1/admin/storage', { status: 503, body: { error: 'db_down' } }, ok(storagePayload()))
    const user = userEvent.setup()
    render(<StoragePage />)

    const err = await screen.findByTestId('storage-error')
    expect(err).toHaveTextContent('/api/v1/admin/storage')
    expect(err).toHaveTextContent('db_down')

    await user.click(within(err).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: 'NAS 归档', level: 2 })).toBeInTheDocument()
  })

  test('页头是 PageShell 的 h1，不自己再套一个 main', async () => {
    await renderReady()
    expect(screen.getByRole('heading', { name: '归档存储', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('main')).toBeNull()
  })
})

/* ── NAS 归档 ──────────────────────────────────────────────────── */

describe('NAS 归档', () => {
  test('挂载点 / 连通状态 / 最近检测时间都在，时间走 lib/format', async () => {
    await renderReady()
    const nas = panel('NAS 归档')
    expect(nas).toHaveTextContent('/mnt/nas')
    expect(nas).toHaveTextContent('连通正常')
    expect(nas).toHaveTextContent(fmtDateTime(1700000000))
  })

  test('容量三分：本系统 / 其他 / 剩余，字节数走 fmtBytes', async () => {
    await renderReady()
    const cap = screen.getByTestId('nas-capacity')
    expect(cap).toHaveTextContent(fmtBytes(842000000000))
    expect(cap).toHaveTextContent(fmtBytes(1758000000000))
    expect(cap).toHaveTextContent(fmtBytes(1400000000000))
    expect(cap).toHaveTextContent(fmtBytes(4000000000000))
    // 容量条本身要能被读屏念出来，不能只有颜色
    expect(within(cap).getByRole('img')).toHaveAccessibleName(/本系统/)
  })

  test('归档三态：已归档 / 尚未归档完成 / 归档失败', async () => {
    await renderReady()
    expect(stat('archived')).toHaveTextContent('71')
    expect(stat('pending')).toHaveTextContent('2')
  })

  test('「尚未归档完成」不能说成纯粹的等待——它同时含着一直归档不成功的那些', async () => {
    await renderReady()
    expect(stat('pending')).toHaveTextContent(/还没轮到|没成功/)
  })

  test('failedMeetings 为 null 时显示「暂不可得」并给出原因，不显示成 0', async () => {
    await renderReady()
    const failed = stat('archive-failed')
    expect(failed).toHaveTextContent('暂不可得')
    expect(failed).not.toHaveTextContent(/(^|\D)0(\D|$)/)
    expect(failed).toHaveTextContent(/尚未落库/)
  })

  test('A8 接上 job_failures 之后，同一格显示真实数字', async () => {
    answer(
      '/api/v1/admin/storage',
      ok(storagePayload({ nas: { failedMeetings: 3, failedMeetingsNote: undefined } })),
    )
    await renderReady()
    const failed = stat('archive-failed')
    expect(failed).toHaveTextContent('3')
    expect(failed).not.toHaveTextContent('暂不可得')
  })

  test('NAS 不可达仍然是一页正常渲染的内容：报原因、容量说暂不可得', async () => {
    answer(
      '/api/v1/admin/storage',
      ok(
        storagePayload({
          nas: {
            reachable: false,
            error: 'ENOENT: /mnt/nas',
            totalBytes: null,
            availableBytes: null,
            usedByOthersBytes: null,
          },
        }),
      ),
    )
    await renderReady()

    expect(screen.queryByTestId('storage-error')).toBeNull()
    const nas = panel('NAS 归档')
    expect(nas).toHaveTextContent('无法连通')
    expect(nas).toHaveTextContent('ENOENT: /mnt/nas')
    const cap = screen.getByTestId('nas-capacity')
    expect(cap).toHaveTextContent('暂不可得')
    expect(within(cap).queryByRole('img')).toBeNull()
  })

  test('挂载点没配时说"未配置"，不显示成一个空白路径', async () => {
    answer('/api/v1/admin/storage', ok(storagePayload({ nas: { root: null, reachable: false, error: '未配置 MDE_NAS_ROOT' } })))
    await renderReady()
    expect(panel('NAS 归档')).toHaveTextContent('未配置')
  })

  test('协议是从挂载点形式推断的，界面上要说明这一点', async () => {
    // 后端没有下发协议字段（只有挂载点）。写死一句"SMB 协议"是替一个我们
    // 没有的探测下结论；这里只说观察到的形式，并标明是推断。
    answer('/api/v1/admin/storage', ok(storagePayload({ nas: { root: '//nas01.internal/meetings' } })))
    await renderReady()
    expect(screen.getByTestId('nas-protocol')).toHaveTextContent(/SMB/)
    expect(screen.getByTestId('nas-protocol')).toHaveTextContent(/推断/)
  })

  test('挂载点是本地路径时协议未知——不猜一个出来', async () => {
    await renderReady()
    expect(screen.getByTestId('nas-protocol')).toHaveTextContent(/未知/)
  })
})

/* ── 本地保留窗口 ──────────────────────────────────────────────── */

describe('本地保留窗口', () => {
  test('四个数：保留期内 / 其中已授权 / 7 天内到期 / 本地占用', async () => {
    await renderReady()
    expect(stat('live')).toHaveTextContent('10')
    expect(stat('granted')).toHaveTextContent('8')
    expect(stat('expiring')).toHaveTextContent('1')
    expect(stat('local-bytes')).toHaveTextContent(fmtBytes(900000000))
  })

  test('defaultDaysSource=setting：就是库里配的天数', async () => {
    await renderReady()
    const src = screen.getByTestId('retention-default')
    expect(src).toHaveTextContent('30 天')
    expect(src).not.toHaveTextContent(/未配置|非法/)
  })

  test('defaultDaysSource=fallback：说明是没配过、用的内置默认', async () => {
    answer(
      '/api/v1/admin/storage',
      ok(storagePayload({ retention: { defaultDaysSource: 'fallback', defaultDaysRaw: null } })),
    )
    await renderReady()
    const src = screen.getByTestId('retention-default')
    expect(src).toHaveTextContent('30 天')
    expect(src).toHaveTextContent(/没有配过|未配置/)
  })

  test('defaultDaysSource=invalid：脏值原样摆出来，且不谎称系统在用 30 兜底', async () => {
    // 归档流水线那边是 `retentionSetting ? Number(retentionSetting) : 30`，
    // 'abc' 会让它拿到 NaN 而**不是**回落到 30。页面上显示一个 30 等于替一个
    // 坏掉的配置打掩护。
    answer(
      '/api/v1/admin/storage',
      ok(
        storagePayload({
          retention: { defaultDays: null, defaultDaysSource: 'invalid', defaultDaysRaw: 'abc' },
        }),
      ),
    )
    await renderReady()
    const src = screen.getByTestId('retention-default')
    expect(src).toHaveTextContent('非法')
    expect(src).toHaveTextContent('abc')
    expect(src).not.toHaveTextContent('30 天')
  })

  test('来源是个没见过的取值时说"未知"，不折成其中一种', async () => {
    answer(
      '/api/v1/admin/storage',
      ok(storagePayload({ retention: { defaultDaysSource: 'env', defaultDaysRaw: '45', defaultDays: 45 } })),
    )
    await renderReady()
    expect(screen.getByTestId('retention-default')).toHaveTextContent(/未知/)
    expect(screen.getByTestId('retention-default')).toHaveTextContent('env')
  })

  test('页面底部那段话逐字留着——它是产品模型的复述，不是装饰', async () => {
    await renderReady()
    const note = screen.getByTestId('retention-model-note')
    expect(note.textContent?.replace(/\s+/g, '')).toBe(
      '到期只删本地文件，数据库记录永久保留——会议标题、时间、主持人、内容哈希、以及归档到 NAS 的具体目录。所以历史会议在这里依然搜得到，只是要按给出的路径去 NAS 取。'.replace(
        /\s+/g,
        '',
      ),
    )
  })
})

/* ── 暂停 / 恢复到期清理 ───────────────────────────────────────── */

describe('暂停到期清理（系统状态横幅链到这一页的那个动作）', () => {
  test('点「暂停到期清理」→ 发请求 → 重取 → 界面照库里的真值显示', async () => {
    answer(
      '/api/v1/admin/storage',
      ok(storagePayload()),
      ok(storagePayload({ retention: { cleanupPaused: true } })),
    )
    answer('/api/v1/admin/storage/cleanup-pause', ok({ cleanupPaused: true }))
    const user = userEvent.setup()
    await renderReady()

    expect(screen.getByTestId('cleanup-state')).toHaveTextContent('正常运行')
    await user.click(screen.getByRole('button', { name: '暂停到期清理' }))

    await waitFor(() => expect(screen.getByTestId('cleanup-state')).toHaveTextContent('已暂停'))
    const pause = calls.find((c) => c.url.endsWith('/cleanup-pause'))
    expect(pause?.method).toBe('POST')
    expect(pause?.body).toEqual({ paused: true })
    // 不做乐观更新：改完要重取（计划 G-c）
    expect(calls.filter((c) => c.url.endsWith('/api/v1/admin/storage')).length).toBe(2)
  })

  test('暂停着的时候给的是「恢复到期清理」，并说明暂停期间不会删任何本地文件', async () => {
    answer('/api/v1/admin/storage', ok(storagePayload({ retention: { cleanupPaused: true } })))
    await renderReady()
    expect(screen.getByRole('button', { name: '恢复到期清理' })).toBeInTheDocument()
    expect(screen.getByTestId('cleanup-state')).toHaveTextContent(/不会再删/)
  })

  test('后端说没暂停成功，界面就显示没暂停——不相信自己发出去的那个值', async () => {
    // 写后重读回来的是库里此刻的真值。这条开关最不能出的错就是
    // "页面说已暂停、实际还在删"。
    answer('/api/v1/admin/storage', ok(storagePayload()), ok(storagePayload()))
    answer('/api/v1/admin/storage/cleanup-pause', ok({ cleanupPaused: false }))
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '暂停到期清理' }))
    await waitFor(() =>
      expect(screen.getByTestId('storage-toast')).toHaveTextContent(/没有生效|仍在运行/),
    )
    expect(screen.getByTestId('cleanup-state')).toHaveTextContent('正常运行')
  })

  test('写成功但重取失败：说"改动发出去了、数字可能是旧的"，不报成一次失败', async () => {
    // 两件事分开报。报成"操作失败"会让人再点一次（对不可逆的动作尤其危险），
    // 咽下去又会让人对着一份旧数字下判断。
    answer('/api/v1/admin/storage', ok(storagePayload()), { status: 503, body: { error: 'db_down' } })
    answer('/api/v1/admin/storage/cleanup-pause', ok({ cleanupPaused: true }))
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '暂停到期清理' }))
    await waitFor(() => expect(screen.getByTestId('storage-toast')).toHaveTextContent('已暂停'))
    expect(screen.getByTestId('storage-toast')).toHaveTextContent(/重新取数失败/)
    expect(screen.getByTestId('storage-toast')).toHaveTextContent('db_down')
    // 页面没有因此变成错误态：旧数据还在，只是标明可能是旧的
    expect(screen.queryByTestId('storage-error')).toBeNull()
    expect(stat('archived')).toHaveTextContent('71')
  })

  test('只读账号（A8 之后）被拒时，读到的是后端那句人话，不是一个错误码', async () => {
    // A8 给四条写端点加了 requireAdminWrite，只读角色拿到 403 + 一句解释。
    // 压成"返回 403：readonly_role"的话，读的人还得去查那个码是什么意思。
    // （按角色把入口禁掉是 F7 的活，这一页这一轮只保证拒绝的理由读得懂。）
    answer('/api/v1/admin/storage/cleanup-pause', {
      status: 403,
      body: {
        error: 'readonly_role',
        role: 'viewer',
        message: '这个账号是只读角色（spec §2），只能查看、不能改任何状态。',
      },
    })
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '暂停到期清理' }))
    await waitFor(() => expect(screen.getByTestId('storage-toast')).toHaveTextContent('只读角色'))
    expect(screen.getByTestId('storage-toast')).toHaveTextContent('403')
    expect(screen.getByTestId('cleanup-state')).toHaveTextContent('正常运行')
  })

  test('请求失败时说出错误，且状态不擅自翻面', async () => {
    answer('/api/v1/admin/storage', ok(storagePayload()))
    answer('/api/v1/admin/storage/cleanup-pause', { status: 500, body: { error: 'db_down' } })
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '暂停到期清理' }))
    await waitFor(() => expect(screen.getByTestId('storage-toast')).toHaveTextContent('db_down'))
    expect(screen.getByTestId('cleanup-state')).toHaveTextContent('正常运行')
  })
})

/* ── 修改默认保留天数 ──────────────────────────────────────────── */

describe('修改默认保留天数', () => {
  test('填一个新天数 → POST → 重取 → 提示里带着新旧两个值', async () => {
    answer(
      '/api/v1/admin/storage',
      ok(storagePayload()),
      ok(storagePayload({ retention: { defaultDays: 45, defaultDaysRaw: '45' } })),
    )
    answer('/api/v1/admin/storage/retention-days', ok({ defaultDays: 45, previousDefaultDays: 30 }))
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '修改默认保留天数' }))
    const form = await screen.findByRole('dialog', { name: '修改默认保留天数' })
    expect(form).toHaveAttribute('data-state', 'open')

    const input = within(form).getByLabelText(/默认保留天数/)
    await user.clear(input)
    await user.type(input, '45')
    await user.click(within(form).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByTestId('storage-toast')).toHaveTextContent('30'))
    expect(screen.getByTestId('storage-toast')).toHaveTextContent('45')
    const post = calls.find((c) => c.url.endsWith('/retention-days'))
    expect(post?.body).toEqual({ days: 45 })
    await waitFor(() => expect(screen.getByTestId('retention-default')).toHaveTextContent('45 天'))
  })

  test('表单里写明：只影响此后新归档的会议', async () => {
    // 已经归档的会议按各自归档时记下的 retention_days 计时（archive.ts 在
    // upsertMeetingArchive 那一刻写死），改默认值不会追溯。
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: '修改默认保留天数' }))
    const form = await screen.findByRole('dialog', { name: '修改默认保留天数' })
    expect(form).toHaveTextContent(/此后新归档/)
  })

  test('后端 400 时照它给的区间说话，表单不关', async () => {
    answer('/api/v1/admin/storage/retention-days', {
      status: 400,
      body: { error: 'invalid_days', min: 1, max: 365 },
    })
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '修改默认保留天数' }))
    const form = await screen.findByRole('dialog', { name: '修改默认保留天数' })
    const input = within(form).getByLabelText(/默认保留天数/)
    await user.clear(input)
    await user.type(input, '400')
    await user.click(within(form).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('365'))
    expect(form).toHaveAttribute('data-state', 'open')
  })
})

/* ── 立即清理已到期文件（不可逆） ──────────────────────────────── */

describe('立即清理已到期文件', () => {
  const preview = {
    dryRun: true,
    cleanupPaused: false,
    items: [
      { meetingId: 'm-1', subMeetingId: '', assetCount: 3, localBytes: 120000000 },
      { meetingId: 'm-2', subMeetingId: 's-7', assetCount: 1, localBytes: 20000000 },
    ],
    totalBytes: 140000000,
  }

  test('先跑一次 dry-run 预览，确认框里列出会删哪些', async () => {
    answer('/api/v1/admin/storage/cleanup-now', ok(preview))
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '立即清理已到期文件' }))
    const dialog = await screen.findByRole('dialog', { name: '立即清理已到期文件' })
    expect(dialog).toHaveAttribute('data-state', 'open')

    // 预览这一次调用不许带 confirm
    const first = calls.find((c) => c.url.endsWith('/cleanup-now'))
    expect(first?.body).toBeUndefined()

    expect(dialog).toHaveTextContent('m-1')
    expect(dialog).toHaveTextContent('m-2')
    expect(dialog).toHaveTextContent('s-7')
    expect(dialog).toHaveTextContent(fmtBytes(140000000))
  })

  test('确认框同时说清「删的是什么」与「留下的是什么」', async () => {
    answer('/api/v1/admin/storage/cleanup-now', ok(preview))
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: '立即清理已到期文件' }))
    const dialog = await screen.findByRole('dialog', { name: '立即清理已到期文件' })

    expect(within(dialog).getByTestId('cleanup-deletes')).toHaveTextContent(/本地文件/)
    const keeps = within(dialog).getByTestId('cleanup-keeps')
    expect(keeps).toHaveTextContent(/数据库记录/)
    expect(keeps).toHaveTextContent(/内容哈希/)
    expect(keeps).toHaveTextContent(/NAS/)
  })

  test('确认之后才带 confirm:true，结果三个桶分开报', async () => {
    answer(
      '/api/v1/admin/storage/cleanup-now',
      ok(preview),
      ok({
        dryRun: false,
        paused: false,
        purged: [{ meetingId: 'm-1', subMeetingId: '', assetCount: 3, localBytes: 120000000 }],
        verificationFailed: [{ meetingId: 'm-2', subMeetingId: 's-7', reason: '哈希对不上' }],
        failed: [],
      }),
    )
    answer('/api/v1/admin/storage', ok(storagePayload()), ok(storagePayload({ retention: { expiredMeetings: 1 } })))
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '立即清理已到期文件' }))
    const dialog = await screen.findByRole('dialog', { name: '立即清理已到期文件' })
    await user.click(within(dialog).getByRole('button', { name: '删除本地文件' }))

    const done = await screen.findByTestId('cleanup-result')
    expect(done).toHaveTextContent('1')
    expect(done).toHaveTextContent('哈希对不上')
    const confirmed = calls.filter((c) => c.url.endsWith('/cleanup-now'))
    expect(confirmed[1]?.body).toEqual({ confirm: true })
    // 删完要重取（数字会变）
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/api/v1/admin/storage')).length).toBe(2),
    )
  })

  test('没有可清理的文件时按钮点不动，且说明为什么', async () => {
    answer(
      '/api/v1/admin/storage/cleanup-now',
      ok({ dryRun: true, cleanupPaused: false, items: [], totalBytes: 0 }),
    )
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: '立即清理已到期文件' }))
    const dialog = await screen.findByRole('dialog', { name: '立即清理已到期文件' })

    expect(within(dialog).getByRole('button', { name: '删除本地文件' })).toBeDisabled()
    expect(dialog).toHaveTextContent(/没有已到期/)
  })

  test('清理被暂停时那颗红按钮点不动，原因写在界面上', async () => {
    answer(
      '/api/v1/admin/storage/cleanup-now',
      ok({ ...preview, cleanupPaused: true }),
    )
    answer('/api/v1/admin/storage', ok(storagePayload({ retention: { cleanupPaused: true } })))
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: '立即清理已到期文件' }))
    const dialog = await screen.findByRole('dialog', { name: '立即清理已到期文件' })

    expect(within(dialog).getByRole('button', { name: '删除本地文件' })).toBeDisabled()
    expect(dialog).toHaveTextContent(/已暂停/)
    expect(dialog).toHaveTextContent(/恢复/)
  })

  test('本进程没挂本地归档区时把 503 那句话原样摆出来，不说成"没有可清理的"', async () => {
    answer('/api/v1/admin/storage/cleanup-now', {
      status: 503,
      body: {
        error: 'local_archive_root_not_configured',
        message: '本进程没有挂载本地归档区（MDE_ARCHIVE_ROOT 未配置），无法执行到期清理。',
      },
    })
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: '立即清理已到期文件' }))

    const dialog = await screen.findByRole('dialog', { name: '立即清理已到期文件' })
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('MDE_ARCHIVE_ROOT'))
    expect(within(dialog).getByRole('button', { name: '删除本地文件' })).toBeDisabled()
  })
})

/* ── 导出可采集清单 ───────────────────────────────────────────── */

describe('导出可采集清单', () => {
  function meetingRow(over: Record<string, unknown> = {}): Record<string, unknown> {
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
      nasPath: '/nas/meetings/2023/11/产品周会/',
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

  /** jsdom 里的 Blob 没有 `.text()`（那是浏览器与 Node 原生 Blob 才有的），
   *  用 FileReader 读——这是 jsdom 真正实现了的那条路径。 */
  function blobText(b: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onerror = () => reject(new Error('读不出 Blob'))
      fr.onload = () => resolve(String(fr.result))
      fr.readAsText(b)
    })
  }

  function captureDownload(): { blobs: Blob[]; names: string[] } {
    const blobs: Blob[] = []
    const names: string[] = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => {
        blobs.push(b)
        return 'blob:mock'
      },
      revokeObjectURL: () => {},
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download)
    })
    return { blobs, names }
  }

  test('导出的是「保留期内且判定可采集」的会议，CSV 带会议号/到期日/授权程序/NAS 路径', async () => {
    answer('/api/v1/admin/meetings', ok({ rows: [meetingRow()], total: 1, limit: 500, offset: 0 }))
    const cap = captureDownload()
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '导出可采集清单' }))
    await waitFor(() => expect(cap.blobs).toHaveLength(1))

    const csv = await blobText(cap.blobs[0]!)
    expect(csv).toContain('会议号')
    expect(csv).toContain('到期日')
    expect(csv).toContain('已授权程序')
    expect(csv).toContain('NAS 路径')
    expect(csv).toContain('123-456-789')
    expect(csv).toContain('kb-indexer')
    expect(csv).toContain('/nas/meetings/2023/11/产品周会/')
    expect(cap.names[0]).toMatch(/\.csv$/)
    expect(screen.getByTestId('storage-toast')).toHaveTextContent('1')
  })

  test('清单没扫全时说出来，不给一份看起来完整的半份清单', async () => {
    // 后端说有 9999 场，但每页只回一条——翻到页数上限也扫不全
    answer('/api/v1/admin/meetings', ok({ rows: [meetingRow()], total: 9999, limit: 500, offset: 0 }))
    const cap = captureDownload()
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '导出可采集清单' }))
    await waitFor(() => expect(cap.blobs).toHaveLength(1))
    // 警告要跟着文件走：光在 toast 里说，文件转手给别人之后那句话就没了
    expect(cap.names[0]).toContain('部分')
    expect(screen.getByTestId('storage-toast')).toHaveTextContent(/没扫全/)
  })

  test('取数失败时不生成一个空文件，只报错', async () => {
    answer('/api/v1/admin/meetings', { status: 500, body: { error: 'db_down' } })
    const cap = captureDownload()
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '导出可采集清单' }))
    await waitFor(() => expect(screen.getByTestId('storage-toast')).toHaveTextContent('db_down'))
    expect(cap.blobs).toHaveLength(0)
  })
})

/* ── 样式门槛 ─────────────────────────────────────────────────── */

describe('CSS 令牌', () => {
  test('页面的 module.css 里没有裸色值 / 裸像素', () => {
    for (const file of ['src/pages/Storage/Storage.module.css']) {
      const css = readFileSync(resolve(process.cwd(), file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(css, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(css, file).not.toMatch(/\brgba?\(/)
      expect(css, file).not.toMatch(/\b\d+px\b/)
    }
  })
})
