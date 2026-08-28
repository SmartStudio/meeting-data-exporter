import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { render, renderAsRole } from '../helpers/session'
import userEvent from '@testing-library/user-event'
import StoragePage from '../../src/pages/Storage'
import { buildTimelineRows } from '../../src/pages/Storage/RetentionTimeline'
import type { AdminMeeting } from '../../src/api/admin/meetings'
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
 * 另外这一页的口径说明**一律挂在 ⓘ 的 title / aria-label 上，不在正文里**
 * （原先 13 处说明性散文占了全页可见文字的 48%）。所以下面凡是断言"这一格
 * 说清了口径"的测试，查的是那个提示标记的可及名，而不是 textContent——
 * 把它改回 toHaveTextContent 就等于把散文放回页面上。
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

  test('容量条三段是三个不同的填充，不是"最大的两段同一个灰"', async () => {
    // 真实数据上本系统只占 0.53%，而「其他占用」与「剩余」是条上最大的两段。
    // 它们从前都是浅灰（--ink-4 opacity .4 与轨道底色），肉眼分不开。现在
    // 自有=--brand、他人=--ink-4 实色、剩余=轨道底色，三段两两可辨。
    await renderReady()
    const bar = within(screen.getByTestId('nas-capacity')).getByRole('img')
    const segs = Array.from(bar.querySelectorAll('[data-seg]'))
    expect(segs.map((e) => e.getAttribute('data-seg'))).toEqual(['us', 'others'])
    // 各段的类名互不相同：同一个类就是同一个颜色
    const tone = (e: Element): string =>
      (e.getAttribute('class') ?? '').split(' ').find((c) => c.includes('brand') || c.includes('neutral')) ?? ''
    expect(tone(segs[0]!)).not.toBe(tone(segs[1]!))
    expect(tone(segs[0]!)).not.toBe('')
    expect(tone(segs[1]!)).not.toBe('')
  })

  test('占比极小的那一段仍然看得见——0.53% 不许缩成 0 像素', async () => {
    // 4.93 GB / 926 GB 的真实比例。宽度百分比照实算，但非零的段带一个最小
    // 渲染宽度类，否则 375px 下它不足 2px。
    answer(
      '/api/v1/admin/storage',
      ok(
        storagePayload({
          nas: { totalBytes: 994610155520, availableBytes: 385991004160, usedByUsBytes: 5292594122, usedByOthersBytes: 603326557238 },
        }),
      ),
    )
    await renderReady()
    const bar = within(screen.getByTestId('nas-capacity')).getByRole('img')
    const us = bar.querySelector('[data-seg="us"]')!
    expect(Number(us.getAttribute('data-pct'))).toBeCloseTo(0.53, 1)
    expect(us.getAttribute('class')).toMatch(/segMin/)
  })

  test('容量口径是可见的一句小字——不再挂 ⓘ，statfs 这个 syscall 名已经去掉', async () => {
    // D-jobs-storage brief：7 个 ⓘ 砍到 2 个以内。这一句原来挂在图例的 ⓘ 上
    // （悬停才看得到，还带着 statfs 这个技术名词），现在是一行可见的小字——
    // 技术名词还是不上屏，但口径本身不必再靠悬停。
    await renderReady()
    const cap = screen.getByTestId('nas-capacity')
    expect(cap).not.toHaveTextContent(/statfs/)
    expect(cap).toHaveTextContent(/记账/)
    expect(cap).toHaveTextContent(/对不齐/)
    expect(within(cap).queryByRole('note')).toBeNull()
  })

  test('归档三态：已归档 / 等待归档 / 归档报错', async () => {
    await renderReady()
    expect(stat('archived')).toHaveTextContent('71')
    expect(stat('pending')).toHaveTextContent('2')
    expect(stat('archived')).toHaveTextContent('已归档会议')
    expect(stat('pending')).toHaveTextContent('等待归档')
  })

  test('这一页不再出现「归档失败」这个词——它在会议记录页数的是另一件事', async () => {
    // 会议记录页 KPI 的「归档失败」走 console-meetings.ts 那条时间判据（最后
    // 一个资产下载完 6 小时后仍未进 meeting_archives）；这一页数的是
    // job_failures 里未恢复的报错行。两个口径都对，但同一个词不能指两件事。
    // 真实数据上前者 1、后者 0，界面上从前没有任何地方解释得了这个差。
    answer('/api/v1/admin/storage', ok(storagePayload({ nas: { failedMeetings: 0, failedMeetingsNote: undefined } })))
    await renderReady()
    expect(panel('NAS 归档').textContent ?? '').not.toContain('归档失败')
    expect(stat('archive-failed')).toHaveTextContent('归档报错')
  })

  test('三格都有一句可见的口径小字——不再挂 ⓘ，是同一个「标签/数字/注」形状', async () => {
    // D-jobs-storage brief：8 个 boxed stat 去框，能塞进一句小字的口径不再靠
    // 悬停才看得到。「等待归档」含着"还没轮到"和"一直归不上去"两种，这件事
    // 不能丢；「归档报错」说得出自己与会议记录页那个数不是一回事，但不写
    // 「归档失败」这四个字——那个词这一页已经让给会议记录页分诊条上的同名计数。
    answer('/api/v1/admin/storage', ok(storagePayload({ nas: { failedMeetings: 0, failedMeetingsNote: undefined } })))
    await renderReady()
    expect(stat('pending')).toHaveTextContent(/还没轮到/)
    expect(stat('archive-failed')).toHaveTextContent(/两个口径/)
    expect(stat('archived')).toHaveTextContent(/NAS 上有副本/)
    // 不再靠悬停：这三格里不该再有一个 role=note 的 ⓘ
    expect(within(stat('pending')).queryByRole('note')).toBeNull()
    expect(within(stat('archive-failed')).queryByRole('note')).toBeNull()
    expect(within(stat('archived')).queryByRole('note')).toBeNull()
  })

  test('failedMeetings 为 null 时显示「暂不可得」并给出原因，不显示成 0', async () => {
    await renderReady()
    const failed = stat('archive-failed')
    expect(failed).toHaveTextContent('暂不可得')
    expect(failed).not.toHaveTextContent(/(^|\D)0(\D|$)/)
    // 拿不到的原因现在是可见的一句小字，不必再悬停才看得到
    expect(failed).toHaveTextContent('尚未落库')
    expect(within(failed).queryByRole('note')).toBeNull()
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

  test('协议是从挂载点形式推断的，"是推断"这件事说在 ⓘ 上', async () => {
    // 后端没有下发协议字段（只有挂载点）。写死一句"SMB 协议"是替一个我们
    // 没有的探测下结论；这里只说观察到的形式，把"是推断"放进悬停。
    answer('/api/v1/admin/storage', ok(storagePayload({ nas: { root: '//nas01.internal/meetings' } })))
    await renderReady()
    const proto = screen.getByTestId('nas-protocol')
    expect(proto).toHaveTextContent(/SMB/)
    expect(within(proto).getByRole('note')).toHaveAccessibleName(/推断/)
  })

  test('挂载点是本地路径时不猜协议，而且"不知道"不占主文案的位置', async () => {
    // 从前这里是一句主文案：「协议未知 —— 后端只下发挂载点，从这一侧看不出
    // 它挂的是什么」。它诚实，但占的是管理员本来想看信息的位置，讲的却是
    // 系统不知道某件事。降级成 ⓘ：查得到，但不再挡着别的。
    await renderReady()
    const proto = screen.getByTestId('nas-protocol')
    expect(proto).not.toHaveTextContent(/未知/)
    expect(within(proto).getByRole('note')).toHaveAccessibleName(/协议未知/)
    // 猜一个协议出来仍然是不许的
    expect(panel('NAS 归档')).not.toHaveTextContent(/SMB|NFS 协议/)
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
    // 「默认保留天数」这个事实在这一页上只说一遍：徽标。旁边不再跟一段正文。
    expect(screen.queryByTestId('retention-alert')).toBeNull()
  })

  test('天数一律来自接口，徽标上没有写死的 30', async () => {
    // 管理员把它改成 60 之后，默认天数这个徽标不许还在说 30。
    // （注：这条只查徽标自己那一格——面板下半屏的时间轴刻度固定写着
    // "0–30 天"，那是坐标轴的量程，跟默认保留天数是不是 30 无关，
    // 两件事不共用一个"页面上不许出现 30 天"的断言。）
    answer(
      '/api/v1/admin/storage',
      ok(storagePayload({ retention: { defaultDays: 60, defaultDaysRaw: '60' } })),
    )
    await renderReady()
    const src = screen.getByTestId('retention-default')
    expect(src).toHaveTextContent('60 天')
    expect(src).not.toHaveTextContent('30 天')
    // 「这个天数是配出来的还是内置默认」现在是徽标旁边一句可见的小字
    // （D-jobs-storage brief），不必再悬停 ⓘ 才看得到。
    expect(src).toHaveTextContent('来自配置')
  })

  test('defaultDaysSource=fallback：天数照给，"没配过"是徽标旁一句可见小字', async () => {
    // 从前这是一段悬停才看得到的正文，里面还带着 default_retention_days 这个
    // 数据库列名。判据："删掉它管理员会不会做错事"——不会：天数就在徽标上，
    // 改它的按钮就在下面，"这个 30 是配出来的还是兜底的"不改变任何一次操作，
    // 所以现在收成一句短小字，不必再悬停，但也不是一整段正文。
    answer(
      '/api/v1/admin/storage',
      ok(storagePayload({ retention: { defaultDaysSource: 'fallback', defaultDaysRaw: null } })),
    )
    await renderReady()
    const src = screen.getByTestId('retention-default')
    expect(src).toHaveTextContent('30 天')
    expect(screen.queryByTestId('retention-alert')).toBeNull()
    expect(panel('本地保留窗口')).not.toHaveTextContent('default_retention_days')
    expect(src).toHaveTextContent(/内置默认值/)
    expect(within(src).queryByRole('note')).toBeNull()
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
    expect(src).not.toHaveTextContent('30 天')
    // 这一支**留正文**：删掉它管理员就不会去修，而坏掉的配置会让此后新归档的
    // 会议拿到一个算不出到期日的保留期。脏值原样摆出来。
    const alert = screen.getByTestId('retention-alert')
    expect(alert).toHaveTextContent('abc')
    expect(alert).toHaveTextContent(/1–365/)
  })

  test('来源是个没见过的取值时说"未知"，不折成其中一种', async () => {
    answer(
      '/api/v1/admin/storage',
      ok(storagePayload({ retention: { defaultDaysSource: 'env', defaultDaysRaw: '45', defaultDays: 45 } })),
    )
    await renderReady()
    expect(screen.getByTestId('retention-default')).toHaveTextContent(/未知/)
    expect(screen.getByTestId('retention-alert')).toHaveTextContent('env')
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

/* ── 保留窗口时间轴（D-jobs-storage brief：下半屏原来是空的） ─────── */

/**
 * `buildTimelineRows()` 是纯函数（`src/pages/Storage/RetentionTimeline.tsx`），
 * 直接单测比每次都挂整个页面快，也更精确地钉住"排序是呈现，不是判定"这条线：
 * 这里只测 sort / pct / warn 三件呈现层的事，不引入任何新的"会不会被清理"判断。
 */
describe('buildTimelineRows() —— 时间轴的行', () => {
  const NOW = new Date(2026, 7, 28, 12, 0, 0)
  const nowSec = Math.floor(NOW.getTime() / 1000)
  const inDays = (d: number): number => nowSec + d * 86400

  function meeting(id: string, title: string, expiresAt: number | null): Pick<AdminMeeting, 'id' | 'title' | 'keep'> {
    return {
      id,
      title,
      keep: {
        archivedAt: null,
        expiresAt,
        extended: 0,
        extendedSource: 'none',
        extendedDays: 0,
        retentionDays: 30,
        filesGone: false,
      },
    }
  }

  test('expiresAt 为 null 的会议不进时间轴——窗口还没起算，画出来的时刻是编的', () => {
    const rows = buildTimelineRows([meeting('a', '还没归档成功', null), meeting('b', '有到期日', inDays(5))], NOW)
    expect(rows.map((r) => r.id)).toEqual(['b'])
  })

  test('全部为 null 时不崩，返回空数组', () => {
    expect(buildTimelineRows([meeting('a', 'x', null), meeting('b', 'y', null)], NOW)).toEqual([])
  })

  test('按剩余天数升序排——快到期的排最前面', () => {
    const rows = buildTimelineRows(
      [meeting('a', '20 天后到期', inDays(20)), meeting('b', '3 天后到期', inDays(3))],
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })

  test('7 天内到期标 warn，超过 7 天不标——跟「7 天内到期」那一格同一个门槛', () => {
    const rows = buildTimelineRows([meeting('a', '', inDays(3)), meeting('b', '', inDays(10))], NOW)
    expect(rows.find((r) => r.id === 'a')?.warn).toBe(true)
    expect(rows.find((r) => r.id === 'b')?.warn).toBe(false)
  })

  test('位置按 0–30 天换算并夹到区间内；超过 30 天的真实天数仍然照实显示，只有位置饱和', () => {
    const rows = buildTimelineRows([meeting('a', '', inDays(60))], NOW)
    expect(rows[0]?.pct).toBe(100)
    expect(rows[0]?.daysLeft).toBe(60)
  })

  test('刚好今天到期（daysLeft=0）不出负数、位置落在最左端', () => {
    const rows = buildTimelineRows([meeting('a', '', nowSec - 3600)], NOW)
    expect(rows[0]?.daysLeft).toBe(0)
    expect(rows[0]?.pct).toBe(0)
    expect(rows[0]?.warn).toBe(true)
  })
})

/** 组件层面：不加新端点，且真的不会因为拿不到/拿到空数据而崩。 */
describe('RetentionTimeline（组件）', () => {
  function timelineMeetingRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'm-1|',
      meetingId: 'm-1',
      subMeetingId: '',
      title: '全员大会 · Q3 复盘',
      code: '000-000-000',
      startAt: 0,
      durationSec: 0,
      host: 'x',
      hostName: null,
      missing: [],
      assets: {},
      unknownAssetTypes: [],
      fetch: 'done',
      archive: 'done',
      allow: 'allow',
      grants: [],
      hand: [],
      nasPath: null,
      sizeBytes: null,
      keep: {
        archivedAt: null,
        expiresAt: 1702542000,
        extended: 0,
        extendedSource: 'none',
        extendedDays: 0,
        retentionDays: 30,
        filesGone: false,
      },
      why: { fetch: { by: '', text: '' }, archive: { by: '', text: '' }, allow: { by: '', text: '' } },
      history: [],
      ...over,
    }
  }

  test('expiresAt 全为 null 时不崩，时间轴给出空态而不是一片空白', async () => {
    answer(
      '/api/v1/admin/meetings',
      ok({
        rows: [
          timelineMeetingRow({ keep: { ...timelineMeetingRow().keep as object, expiresAt: null } }),
        ],
        total: 1,
        limit: 60,
        offset: 0,
      }),
    )
    await renderReady()
    const empty = await screen.findByTestId('retention-timeline-empty')
    expect(empty).toHaveTextContent('没有能定位到期日的会议')
    expect(screen.queryByTestId('retention-timeline-row')).toBeNull()
  })

  test('保留期内一场会议都没有时同样给空态，不崩', async () => {
    answer('/api/v1/admin/meetings', ok({ rows: [], total: 0, limit: 60, offset: 0 }))
    await renderReady()
    expect(await screen.findByTestId('retention-timeline-empty')).toBeInTheDocument()
  })

  test('有到期日的会议渲染成一行，会议名与剩余天数都在', async () => {
    answer('/api/v1/admin/meetings', ok({ rows: [timelineMeetingRow()], total: 1, limit: 60, offset: 0 }))
    await renderReady()
    const row = await screen.findByTestId('retention-timeline-row')
    expect(row).toHaveTextContent('全员大会 · Q3 复盘')
    expect(row).toHaveTextContent(/\d+ 天/)
  })

  test('用的是既有端点 GET /api/v1/admin/meetings?inRetention=true，没有加新端点', async () => {
    answer('/api/v1/admin/meetings', ok({ rows: [], total: 0, limit: 60, offset: 0 }))
    await renderReady()
    await screen.findByTestId('retention-timeline-empty')
    const call = calls.find((c) => c.url.startsWith('/api/v1/admin/meetings'))
    expect(call?.url).toContain('inRetention=true')
  })

  test('这条端点读不到时时间轴单独报错，不把整页拖下水', async () => {
    answer('/api/v1/admin/meetings', { status: 500, body: { error: 'db_down' } })
    await renderReady()
    expect(await screen.findByTestId('retention-timeline-error')).toHaveTextContent('db_down')
    // 上面的统计数字（来自另一条端点 /api/v1/admin/storage）照常在
    expect(stat('archived')).toHaveTextContent('71')
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

describe('只读账号（spec §11 缺口 1）', () => {
  async function readonlyReady(): Promise<void> {
    renderAsRole(<StoragePage />, 'readonly')
    await screen.findByRole('heading', { name: 'NAS 归档', level: 2 })
  }

  test('三个写动作禁用，并说得出为什么', async () => {
    await readonlyReady()
    for (const name of ['修改默认保留天数', '立即清理已到期文件', '暂停到期清理']) {
      const btn = screen.getByRole('button', { name })
      expect(btn, name).toBeDisabled()
      expect(btn, name).toHaveAttribute('title', '只读账号不能改')
    }
  })

  test('「导出可采集清单」**不**禁用——它是一条 GET，只读账号本来就该能导', async () => {
    await readonlyReady()
    expect(screen.getByRole('button', { name: '导出可采集清单' })).toBeEnabled()
  })

  test('页头有一句说明', async () => {
    await readonlyReady()
    expect(screen.getByTestId('readonly-banner')).toBeInTheDocument()
  })

  test('管理员这一侧照旧能点', async () => {
    await renderReady()
    expect(screen.getByRole('button', { name: '修改默认保留天数' })).toBeEnabled()
    expect(screen.queryByTestId('readonly-banner')).toBeNull()
  })
})
