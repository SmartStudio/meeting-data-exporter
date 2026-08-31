import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, screen, waitFor, within } from '@testing-library/react'
import { render, renderAsRole } from '../helpers/session'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import PreviewPage from '../../src/pages/Preview'

/**
 * 内容预览页（spec §4.4 · §2）。
 *
 * 这一页最容易做错的三件事，每一件都有对应的测试盯着：
 *
 * 1. **拿 cues 冒充章节**。后端的 `chapters` 恒空、`source: 'none'`——本系统一次
 *    都没拉过腾讯的章节数据。时间轴 tab 的形态因此是「按转写时间戳切分」，
 *    而且界面上要说清这一点。
 * 2. **为了省一次请求把内容缓存起来复用**。每调一次那两条端点后端就写一行审计,
 *    省下的请求等于少一条留痕，而留痕是「被禁采集的会议管理员仍然能看」的对价。
 * 3. **把右下角做成 AI 问答框**。那是一条新的出境路径（spec §1.4），刻意不实现。
 */

/* ── fetch 桩 ─────────────────────────────────────────────────────── */

let urls: string[] = []
let routes: Array<{ match: RegExp; status: number; body: unknown }> = []

function installApi(): void {
  urls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      const hit = routes.find((r) => r.match.test(url))
      if (hit === undefined) {
        return new Response(JSON.stringify({ error: 'not_stubbed', url }), { status: 500 })
      }
      return new Response(JSON.stringify(hit.body), {
        status: hit.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

function answer(match: RegExp, body: unknown, status = 200): void {
  routes.unshift({ match, status, body })
}

const DURATION = 3600
/** spec §4.4：「打开时落在会议中段（不是 0:00）」 */
const MIDPOINT = DURATION / 2

const MEETING = {
  id: 'm-1',
  meetingId: 'm-1',
  subMeetingId: '',
  title: '产品周会',
  code: '123-456',
  startAt: 1699900000,
  durationSec: DURATION,
  host: 'zouyanjian',
  missing: [],
}

const ACCESS_ALLOW = {
  allow: 'allow',
  restricted: false,
  why: { by: 'rule', text: '采集程序「kb-indexer」：标题含「周会」，规则 #100 准许' },
  banner: null,
  audit: { logged: true, action: 'view_content' },
}

const ACCESS_DENY = {
  allow: 'deny',
  restricted: true,
  why: { by: 'deny', text: '标题含「面试」，规则 #7 禁止采集' },
  banner: '**采集程序取不走这场会议**。你能在这里看，是为了判断这条规则拦得对不对；这次查看已记审计。',
  audit: { logged: true, action: 'view_restricted_content' },
}

const LOCAL = {
  archived: true,
  filesGone: false,
  archivedAt: 1699950000,
  purgedAt: null,
  expiresAt: Math.floor(Date.now() / 1000) + 3 * 86400,
  nasDir: '/nas/2026/08/m-1',
  text: '到期只删本地文件；纪要正文与归档记录留着。',
}

function asset(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assetType: 'ai_minutes',
    assetKey: 'ai_minutes',
    remoteId: 'r-1',
    fileType: 'txt',
    availability: 'parsed',
    bytes: 4096,
    chars: 1200,
    reason: null,
    contentHash: 'sha256:abc',
    parsedAt: 1699950500,
    nasPath: '/nas/2026/08/m-1/ai_minutes.txt',
    ...over,
  }
}

const MEDIA = {
  proxied: false,
  // 保留期内是**空串**（2026-08-31）：「不入库，只给去向」在录像那一组的行尾，
  // 每个文件自己列着 NAS 路径，左边还有正在播的播放器——再写一段是第四遍。
  text: '',
  assets: [
    {
      assetType: 'video',
      assetKey: 'video',
      remoteId: 'r-9',
      fileType: 'mp4',
      nasPath: '/nas/2026/08/m-1/video.mp4',
      localPath: null,
      archivedAt: 1699950000,
      localGone: false,
    },
  ],
}

const INDEX = {
  meeting: MEETING,
  access: ACCESS_ALLOW,
  local: LOCAL,
  assets: [
    asset(),
    asset({
      assetType: 'meeting_summary',
      assetKey: 'transcript',
      remoteId: 'r-2',
      bytes: 8192,
      chars: 5200,
      nasPath: '/nas/2026/08/m-1/transcript.txt',
    }),
    asset({
      assetType: 'ai_topic_minutes',
      assetKey: 'ai_topic_minutes',
      remoteId: 'r-3',
      fileType: 'docx',
      availability: 'unsupported_format',
      bytes: 2048,
      chars: null,
      reason: '不是 txt，本版本只解析 txt；文件在 NAS 上，去 NAS 取就能看。',
      contentHash: null,
    }),
  ],
  selected: null,
  media: MEDIA,
}

function selection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...INDEX,
    selected: {
      type: 'ai_minutes',
      assetKey: 'ai_minutes',
      state: 'ok',
      segments: [{ ...asset(), ordinal: 1, content: '一、会议结论\nM3.5 联调通过。' }],
      text: 'AI 纪要共 1 段，其中 1 段有正文。',
      ...over,
    },
  }
}

/** 最后一段刻意紧挨着中段：走时那条测试只要推进 31 秒就能跨过去，不必空转四千轮 */
const CUES = [
  { at: 0, endAt: null, speaker: '邹研发', text: '今天主要过一下联调结果。' },
  { at: 1500, endAt: null, speaker: '王总', text: '先说结论行不行。' },
  { at: MIDPOINT, endAt: null, speaker: '陈运维', text: 'RDS 白名单我早上开了。' },
  { at: MIDPOINT + 30, endAt: null, speaker: '王总', text: '那这周先把文档回写补上。' },
]

const CHAPTERS = {
  meeting: MEETING,
  access: ACCESS_ALLOW,
  chapters: [],
  source: 'none',
  text: '腾讯会议那张页面上的「章节 + 摘要」在本系统里没有来源：一次都没被拉取过，库里也没有任何一列装它。',
  cues: CUES,
  cuesFrom: {
    assetType: 'meeting_summary',
    assetKey: 'transcript',
    remoteId: 'r-2',
    fileType: 'txt',
    format: 'bracket',
    total: CUES.length,
    returned: CUES.length,
    truncated: false,
  },
  sample: null,
}

const TRANSCRIPT = {
  ...INDEX,
  selected: {
    type: 'meeting_summary',
    assetKey: 'transcript',
    state: 'ok',
    segments: [
      {
        ...asset({ assetType: 'meeting_summary', assetKey: 'transcript', remoteId: 'r-2' }),
        ordinal: 1,
        content: '[00:00] 邹研发：今天主要过一下联调结果。\n[25:00] 王总：先说结论行不行。',
      },
    ],
    text: '完整转写共 1 段，其中 1 段有正文。',
  },
}

/** 后登记的先匹配（`answer` 是 unshift），所以从最泛的往最specific的登记 */
function stubHappyPath(): void {
  routes = []
  answer(/\/meetings\/[^/?]+$/, { id: 'm-1', grants: ['kb-indexer', '知识库索引器'] })
  answer(/\/content$/, INDEX)
  answer(/\/content\?type=/, selection())
  answer(/\/content\?type=(transcript|meeting_summary)/, TRANSCRIPT)
  answer(/\/content\/chapters/, CHAPTERS)
}

function renderPreview(id = 'm-1') {
  const router = createMemoryRouter(
    [
      { path: '/preview/:id', element: <PreviewPage /> },
      { path: '/meetings', element: <div>会议记录页</div> },
    ],
    { initialEntries: [`/preview/${id}`] },
  )
  return render(<RouterProvider router={router} />)
}

/**
 * 展开资产面板里的一组。
 *
 * 资产按类合并之后，逐格式的体积、后端逐条写的理由、NAS 路径都折在 `<details>`
 * 里。**jsdom 不实现 `<details>` 的折叠语义**：收起状态下 `getByText` 照样找得到
 * 这些内容，于是「断言绿着、人看不见」——这正是这一轮在 a11y 条状元素扫描上踩过
 * 的那个坑（报告"通过"却什么都没检查）。所以这一组测试一律：**先展开、再用
 * `toBeVisible()` 断言**，两件事分开钉。
 */
async function openAssetGroup(
  user: ReturnType<typeof userEvent.setup>,
  panel: HTMLElement,
  name: RegExp,
): Promise<void> {
  // 按 summary 里的类名文字找那一组。不用 `getByRole('group')`：`<details>` 的
  // 隐式角色在 jsdom 这一版里没有映射出来，查得到才是巧合。
  const summary = within(panel)
    .getAllByText(name)
    .map((el) => el.closest('summary'))
    .find((el): el is HTMLElement => el !== null)
  if (summary === undefined) throw new Error(`资产面板里没有名为 ${String(name)} 的分组`)
  await user.click(summary)
  await waitFor(() => expect(summary.closest('details')).toHaveAttribute('open'))
}

/** 等首屏三条并行请求落地 */
async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('heading', { name: '产品周会' })).toBeInTheDocument())
}

beforeEach(() => {
  installApi()
  stubHappyPath()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/* ── 打开时的初始状态（明确写死的规则）────────────────────────────── */

describe('打开时的初始状态', () => {
  /**
   * 2026-08-30 翻案：**打开时落在 0:00**，不再是会议中段。
   *
   * 原来那条写在 spec §4.4 里，理由是「字幕、时间轴、转写三处当场对得上，不用等
   * 走两分钟才看出它们是联动的」——那是**给静态原型截图看的**理由。接上真实数据
   * 之后它变成一个纯粹的坑：用户打开一场会议，进度条已经在正中间，前一半像是
   * 被跳过了。用户原话：「播放时都是进度是从中间一半开始播不是从头开始」。
   *
   * 联动本身仍然是真的，只是不再靠一个假的起始位置去演示它。
   */
  test('落在 0:00 —— 打开一场会议就是从头开始', async () => {
    renderPreview()
    await ready()
    const slider = screen.getByRole('slider', { name: '播放位置' })
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    expect(slider).toHaveAttribute('aria-valuemax', String(DURATION))
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('0:00'))
  })

  test('0:00 就落在第一段上，字幕与发言人当场有东西', async () => {
    renderPreview()
    await ready()
    const player = screen.getByRole('region', { name: /播放/ })
    // CUES[0] 的 at 是 0，所以开头这一段本来就是当前段
    expect(within(player).getByText('今天主要过一下联调结果。')).toBeInTheDocument()
    expect(within(player).getByText('邹研发')).toBeInTheDocument()
  })

  test('默认停在纪要 tab，三个 tab 都在', async () => {
    renderPreview()
    await ready()
    expect(screen.getByRole('tab', { name: /纪要/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /时间轴/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /转写文字/ })).toBeInTheDocument()
  })
})

/* ── 抬头的主持人 ─────────────────────────────────────────────────── */

describe('抬头的主持人：不许把 userid 当人名摆出去', () => {
  /**
   * 这一页曾经写的是 `主持 {meeting.host}`——而 `host` 是主持人的 **userid**，
   * 真实取值 `woaJARCQAA…` 是一串 32 位机器码。会议记录页 2026-08-28 修掉了它，
   * 预览页当时漏了：同一个病在另一页原样活着。判定搬进 `lib/host.ts` 之后两页共用。
   *
   * 这里刻意用**真实形状**的 userid，不用 fixture 里那个 `zouyanjian`——
   * 后者短到 12 位以内，走的是「整串显示」那条支路，验不出这个 bug。
   * 预览页的 bug 之所以躲过了所有基于 mock 的检查，正是因为替身里的 host
   * 填的是人名（`'邹研发'` / `'王总'`），比真实依赖宽容。
   */
  const REAL_ID = 'woaJARCQAAt_hKBw--YKZeVjEaIMGFQQ'

  test('身份映射查不到姓名时，屏幕上不出现那串 id', async () => {
    answer(/\/content$/, { ...INDEX, meeting: { ...MEETING, host: REAL_ID, hostName: null } })
    renderPreview()
    await ready()
    const head = screen.getByRole('heading', { name: '产品周会' }).parentElement
    expect(head).not.toHaveTextContent(REAL_ID)
    expect(head).toHaveTextContent('未知主持人')
    // 全量 id 仍然拿得到——排查时只有它有用，但它在 title 里，不在正文里
    expect(within(head as HTMLElement).getByTitle(new RegExp(REAL_ID))).toBeInTheDocument()
  })

  test('查到姓名就显示姓名', async () => {
    answer(/\/content$/, { ...INDEX, meeting: { ...MEETING, host: REAL_ID, hostName: '邹燕建' } })
    renderPreview()
    await ready()
    const head = screen.getByRole('heading', { name: '产品周会' }).parentElement
    expect(head).toHaveTextContent('主持 邹燕建')
    expect(head).not.toHaveTextContent(REAL_ID)
  })
})

/* ── 时间轴：不是章节 ─────────────────────────────────────────────── */

describe('时间轴 tab —— 按转写时间戳切分，不是章节', () => {
  test('界面上说清「本系统没有章节来源」，并把后端的原话摆出来', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /时间轴/ }))

    const panel = screen.getByRole('tabpanel')
    expect(within(panel).getByText(/没有来源/)).toBeInTheDocument()
    expect(within(panel).getByText(/按转写时间戳切分/)).toBeInTheDocument()
  })

  test('列表标题写的是「转写分段」，不是「章节」——不给一个我们没有的数据源伪造输出', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /时间轴/ }))

    const list = screen.getByRole('list', { name: /转写分段/ })
    expect(within(list).getAllByRole('listitem')).toHaveLength(CUES.length)
    // 分段来自哪一份转写、认出的是什么格式，都要交代
    expect(within(screen.getByRole('tabpanel')).getByText(/完整转写/)).toBeInTheDocument()
  })

  test('被 limit 截断时说出来——后半截凭空消失是最糟的静默', async () => {
    stubHappyPath()
    answer(/\/content\/chapters/, {
      ...CHAPTERS,
      cuesFrom: { ...CHAPTERS.cuesFrom, total: 9000, returned: 4, truncated: true },
    })

    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /时间轴/ }))
    expect(screen.getByText(/只显示了前 4 段/)).toBeInTheDocument()
  })

  test('认不出转写格式时给原文样例，而不是一个说不出为什么的空时间轴', async () => {
    stubHappyPath()
    answer(/\/content\/chapters/, {
      ...CHAPTERS,
      cues: [],
      cuesFrom: { ...CHAPTERS.cuesFrom, format: 'none', total: 0, returned: 0 },
      sample: ['会议记录 2026-08-21', '（无时间戳）'],
    })

    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /时间轴/ }))
    expect(screen.getByText('会议记录 2026-08-21')).toBeInTheDocument()
    expect(screen.getByText(/认不出时间戳格式/)).toBeInTheDocument()
  })
})

/* ── 三处联动 ─────────────────────────────────────────────────────── */

describe('三处联动', () => {
  test('点时间轴的一段 → 播放位置跳过去', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /时间轴/ }))
    await user.click(screen.getByRole('button', { name: /那这周先把文档回写补上/ }))
    expect(screen.getByRole('slider', { name: '播放位置' })).toHaveAttribute(
      'aria-valuenow',
      String(MIDPOINT + 30),
    )
  })

  test('点转写任意一段 → 播放位置跳过去，且那一段标成当前', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /转写文字/ }))
    const turn = await screen.findByRole('button', { name: /先说结论行不行/ })
    await user.click(turn)
    expect(screen.getByRole('slider', { name: '播放位置' })).toHaveAttribute('aria-valuenow', '1500')
    expect(turn).toHaveAttribute('aria-current', 'true')
  })

  /**
   * 没有可播放录像时才有「走时」这回事——它是一条模拟的时钟，专门给拿不到媒体源
   * 的会议用（没归档、或格式认不出）。所以这条用例显式把 media 清空。
   *
   * 有录像时位置的来源是视频自己的 `timeupdate`，两个时钟同时推同一个位置会互相
   * 打架：定时器把位置推快半拍，视频再把它拽回来，画面和字幕一直在抖。
   * 那条路径由下面「录像能放」那一组盯着。
   */
  test('没有可播录像时，走时推进 → 当前分段跟着换，字幕跟着换', async () => {
    const user = userEvent.setup()
    routes.unshift({
      match: /\/content$/,
      status: 200,
      body: { ...INDEX, media: { ...INDEX.media, assets: [] } },
    })
    renderPreview()
    await ready()
    // 起点是 0:00（2026-08-30 起），所以先跳到中段那一段上——这条测的是「推进」,
    // 不是「起点在哪」。用时间轴点过去，走的是真实的跳转路径。
    await user.click(screen.getByRole('tab', { name: /时间轴/ }))
    await user.click(await screen.findByRole('button', { name: /RDS 白名单我早上开了/ }))
    const slider = screen.getByRole('slider', { name: '播放位置' })
    expect(slider).toHaveAttribute('aria-valuenow', String(MIDPOINT))
    vi.useFakeTimers()
    await act(async () => {
      screen.getByRole('button', { name: '开始走时' }).click()
    })
    await act(async () => {
      vi.advanceTimersByTime(31 * 1000)
    })
    expect(Number(slider.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(MIDPOINT + 30)
    const player = screen.getByRole('region', { name: /播放/ })
    expect(within(player).getByText('那这周先把文档回写补上。')).toBeInTheDocument()
  })

  /**
   * 跟随滚动**一次都不许碰 `scrollIntoView`**（2026-08-31，用户报「一播放整个页面
   * 就被拉下来、一直在抖」）。
   *
   * `scrollIntoView` 会沿祖先链把每一个可滚动容器都滚一遍，一直滚到文档本身;
   * `block: 'nearest'` 管的是每个容器滚多少，不是滚哪几个。1440×900 实测：
   * 一按播放 `window.scrollY` 3.75 秒内被推到 544，人手动滚回去下一段又拽回来。
   * 推理与两次实测都在 `Preview/text.tsx` 的 `useFollowCurrent` 头上。
   *
   * jsdom 压根没有 `scrollIntoView`，所以旧实现在这里**是静默空转的**——测试全绿,
   * 真浏览器上那 544px 一路没人拦。这条测试就是补那个洞：把它装上再数调用次数。
   */
  test('走时跟随不碰 scrollIntoView —— 它会把整页也一起滚走', async () => {
    const user = userEvent.setup()
    routes.unshift({
      match: /\/content$/,
      status: 200,
      body: { ...INDEX, media: { ...INDEX.media, assets: [] } },
    })
    const spy = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: spy,
      configurable: true,
      writable: true,
    })
    try {
      renderPreview()
      await ready()
      await user.click(screen.getByRole('tab', { name: /转写文字/ }))
      await user.click(await screen.findByRole('button', { name: /RDS 白名单我早上开了/ }))
      vi.useFakeTimers()
      await act(async () => {
        screen.getByRole('button', { name: '开始走时' }).click()
      })
      await act(async () => {
        vi.advanceTimersByTime(31 * 1000)
      })
      expect(
        Number(screen.getByRole('slider', { name: '播放位置' }).getAttribute('aria-valuenow')),
      ).toBeGreaterThanOrEqual(MIDPOINT + 30)
      expect(spy, 'scrollIntoView 被调用了 —— 它会连带把 window 一起滚').not.toHaveBeenCalled()
    } finally {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    }
  })
})

/* ── 录像 ─────────────────────────────────────────────────────────── */

/**
 * 2026-08-30 之前这一页**没有画面**：`media.proxied` 恒为 false，唯一能签直链的
 * 端点走采集程序的 JWT，管理员会话签不出来。用户报「画面看不到、声音听不到」
 * 之后新开了 `GET .../media/:assetType/:remoteId/:fileType`——读的是已经归档在
 * NAS 上的那份文件，不是从腾讯 CDN 转发。
 */
describe('录像能放（左栏，走时条当控制器）', () => {
  test('已归档的 mp4 → 页面上有一个 <video>，src 指向管理端媒体端点', async () => {
    const { container } = renderPreview()
    await ready()
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(video!.getAttribute('src')).toBe(
      '/api/v1/admin/meetings/m-1/media/video/r-9/mp4',
    )
    // 不给原生 controls：进度条上的转写分段标记原生控件放不下（见 Player 文件头）
    expect(video!.hasAttribute('controls')).toBe(false)
  })

  test('没归档的录像不给播——本地那份到期会被清掉，拿它当播放源是个过几天就坏的功能', async () => {
    routes.unshift({
      match: /\/content$/,
      status: 200,
      body: {
        ...INDEX,
        media: {
          ...INDEX.media,
          assets: INDEX.media.assets.map((a) => ({ ...a, nasPath: null, archivedAt: null })),
        },
      },
    })
    const { container } = renderPreview()
    await ready()
    expect(container.querySelector('video')).toBeNull()
    // 退回成一条纯走时条，控制器仍然在
    expect(screen.getByRole('slider', { name: '播放位置' })).toBeInTheDocument()
  })

  test('认不出的容器不给播——摆一个点了没反应的播放器比说清楚更糟', async () => {
    routes.unshift({
      match: /\/content$/,
      status: 200,
      body: {
        ...INDEX,
        media: {
          ...INDEX.media,
          assets: INDEX.media.assets.map((a) => ({ ...a, fileType: 'avi' })),
        },
      },
    })
    const { container } = renderPreview()
    await ready()
    expect(container.querySelector('video')).toBeNull()
  })

  test('视频报错不吞掉：说清「已归档但这次读不到」，去向仍在资产清单里', async () => {
    const { container } = renderPreview()
    await ready()
    const video = container.querySelector('video')!
    await act(async () => {
      video.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByText(/录像取不回来/)).toBeInTheDocument()
    // 走时条不受影响——联动是位置的事，不是画面的事
    expect(screen.getByRole('slider', { name: '播放位置' })).toBeInTheDocument()
  })

  test('位置的来源是视频自己的 timeupdate，不是模拟时钟', async () => {
    const { container } = renderPreview()
    await ready()
    const video = container.querySelector('video')!
    Object.defineProperty(video, 'currentTime', { value: MIDPOINT + 30, writable: true })
    await act(async () => {
      video.dispatchEvent(new Event('timeupdate'))
    })
    expect(screen.getByRole('slider', { name: '播放位置' })).toHaveAttribute(
      'aria-valuenow',
      String(MIDPOINT + 30),
    )
    const player = screen.getByRole('region', { name: /播放/ })
    expect(within(player).getByText('那这周先把文档回写补上。')).toBeInTheDocument()
  })
})

/* ── 键盘 ─────────────────────────────────────────────────────────── */

describe('键盘可达（spec §9 是硬要求）', () => {
  test('进度条方向键前后各 15 秒，Home/End 到两端', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    const slider = screen.getByRole('slider', { name: '播放位置' })
    slider.focus()
    // 起点是 0:00，往回退会被夹到 0，两个方向都要能量出来——所以先往前走两格
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(slider).toHaveAttribute('aria-valuenow', '30')
    await user.keyboard('{ArrowLeft}')
    expect(slider).toHaveAttribute('aria-valuenow', '15')
    // 负数夹到 0，不是「负 15 秒」
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    await user.keyboard('{Home}')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    await user.keyboard('{End}')
    expect(slider).toHaveAttribute('aria-valuenow', String(DURATION))
  })

  test('tab 列表用方向键切换，且只有当前 tab 在 Tab 键序里（roving tabindex）', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    const minutes = screen.getByRole('tab', { name: /纪要/ })
    const timeline = screen.getByRole('tab', { name: /时间轴/ })
    expect(minutes).toHaveAttribute('tabindex', '0')
    expect(timeline).toHaveAttribute('tabindex', '-1')

    minutes.focus()
    await user.keyboard('{ArrowRight}')
    expect(timeline).toHaveAttribute('aria-selected', 'true')
    expect(timeline).toHaveFocus()
  })
})

/* ── 纪要 tab ─────────────────────────────────────────────────────── */

describe('纪要 tab', () => {
  test('模板切换是四个真实的资产类型，没有一个我们取不到的模板', async () => {
    renderPreview()
    await ready()
    const group = screen.getByRole('radiogroup', { name: '纪要模板' })
    const names = within(group)
      .getAllByRole('radio')
      .map((b) => b.textContent)
    expect(names).toEqual(['AI 纪要', '发言人纪要', '话题纪要', '会议摘要'])
  })

  test('换模板就重取一次——不缓存复用，留痕才完整', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    await waitFor(() => expect(screen.getByText(/M3.5 联调通过/)).toBeInTheDocument())

    const before = urls.filter((u) => u.includes('type=')).length
    await user.click(screen.getByRole('radio', { name: '话题纪要' }))
    await waitFor(() =>
      expect(urls.filter((u) => u.includes('type=ai_topic_minutes'))).not.toHaveLength(0),
    )
    // 再切回来，照样重取，不吃上一次的结果
    await user.click(screen.getByRole('radio', { name: 'AI 纪要' }))
    await waitFor(() => expect(urls.filter((u) => u.includes('type=')).length).toBeGreaterThan(before + 1))
  })

  test('「这场会议没有这类纪要」与「取失败了」在界面上分得开', async () => {
    stubHappyPath()
    answer(
      /\/content\?type=ai_speaker_minutes/,
      selection({ state: 'absent', segments: [], text: '这场会议在库里没有任何一段发言人纪要的记录。' }),
    )

    const user = userEvent.setup()
    renderPreview()
    await ready()

    await user.click(screen.getByRole('radio', { name: '发言人纪要' }))
    expect(await screen.findByText(/没有任何一段发言人纪要的记录/)).toBeInTheDocument()

    routes.unshift({ match: /\/content\?type=ai_topic_minutes/, status: 500, body: { error: 'boom' } })
    await user.click(screen.getByRole('radio', { name: '话题纪要' }))
    expect(await screen.findByText(/取失败/)).toBeInTheDocument()
    expect(screen.getByText(/boom/)).toBeInTheDocument()
  })

  test('未解析不等于缺失：docx 那一段要说清文件还在 NAS 上', async () => {
    answer(
      /\/content\?type=ai_minutes/,
      selection({
        state: 'unparsed',
        segments: [
          {
            ...asset({
              fileType: 'docx',
              availability: 'unsupported_format',
              chars: null,
              reason: '这一段是 docx，本版本只认 txt；文件本身在 NAS 上，现在就能取。',
            }),
            ordinal: 1,
            content: null,
          },
        ],
        text: 'AI 纪要在库里有 1 段记录，但一段正文都解析不出来。',
      }),
    )
    renderPreview()
    await ready()
    expect(await screen.findByText(/一段正文都解析不出来/)).toBeInTheDocument()
    expect(screen.getByText(/只认 txt/)).toBeInTheDocument()
  })
})

/* ── 转写 tab ─────────────────────────────────────────────────────── */

describe('转写文字 tab', () => {
  test('搜索给命中高亮与计数，且说清一共多少段', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /转写文字/ }))
    await screen.findByRole('button', { name: /先说结论行不行/ })

    await user.type(screen.getByRole('searchbox', { name: '在转写里搜' }), '结论')
    await waitFor(() => expect(screen.getByText(/命中 1 段/)).toBeInTheDocument())
    expect(screen.getByText(/共 4 段/)).toBeInTheDocument()
    const marks = document.querySelectorAll('mark')
    expect(marks.length).toBeGreaterThan(0)
    expect(marks[0]!.textContent).toBe('结论')
  })

  test('搜不到就说搜不到，不是空白', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /转写文字/ }))
    await screen.findByRole('button', { name: /先说结论行不行/ })
    await user.type(screen.getByRole('searchbox', { name: '在转写里搜' }), '不存在的词')
    expect(await screen.findByText(/没有命中/)).toBeInTheDocument()
  })

  test('转写原文单独取一次，完整正文摆在那里——分段解析会丢掉没有时间戳的行', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    await user.click(screen.getByRole('tab', { name: /转写文字/ }))
    await waitFor(() =>
      expect(urls.some((u) => /type=(transcript|meeting_summary)/.test(u))).toBe(true),
    )
    expect(await screen.findByText(/\[00:00\] 邹研发：今天主要过一下联调结果。/)).toBeInTheDocument()
  })
})

/* ── 右下角：资产与去向，不是问答框 ───────────────────────────────── */

describe('右下角是「这场会议的资产与去向」', () => {
  test('六件事都在：格式、体积、采集判定、已授权给谁、本地还剩几天、NAS 路径', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })

    // 四条事实在最上面，不必展开任何一组——它们是人打开这一页最先要的答案
    expect(within(panel).getByText(/规则 #100 准许/)).toBeVisible()
    expect(within(panel).getByText('kb-indexer、知识库索引器')).toBeVisible()
    expect(within(panel).getByText(/还剩 3 天/)).toBeVisible()
    expect(within(panel).getByText('/nas/2026/08/m-1')).toBeVisible()

    // 类名与格式在收起的那一行上就读得到
    expect(within(panel).getByText('AI 纪要')).toBeVisible()
    expect(within(panel).getAllByText('txt').length).toBeGreaterThan(0)

    // 体积是明细：收起时**必须看不见**（这一条钉的是合并本身有效），展开后才在
    expect(within(panel).getByText('4.00 KB')).not.toBeVisible()
    await openAssetGroup(user, panel, /AI 纪要/)
    expect(within(panel).getByText('4.00 KB')).toBeVisible()
  })

  test('未解析的那一类要显示自己的理由，不显示成「没有」', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    // 「未解析（格式不支持）」是**结论**，收起的那一行上就要看得见：合并成一组
    // 不许把一个可修复的缺口藏到点开之后
    expect(within(panel).getAllByText(/未解析（格式不支持）/)[0]).toBeVisible()
    // 后端逐条写的理由是明细，展开后一字不改地在
    // 这条理由属于 ai_topic_minutes 那一组（夹具 :142）
    await openAssetGroup(user, panel, /话题纪要/)
    expect(within(panel).getByText(/文件在 NAS 上/)).toBeVisible()
  })

  /**
   * 2026-08-31 改写：这条原来断言面板上常驻一句「录像与音频不由本接口代理内容」。
   * 那句话（连同它后面三句「为什么」）已经删掉——它讲的是这条 API 为什么长这样,
   * 管理员拿不走。**它保护的事实没有变**，只是换了更短的载体：录像那一组行尾的
   * 「不入库，只给去向」+ 每个文件自己的 NAS 路径。这条断言跟着钉到那两样上。
   */
  test('录像给去向不给内容：行尾说清不入库，并给出 NAS 路径', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    // 录像这一路整个搬进了资产面板（走时条不再管媒体，它只管位置）
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    expect(within(panel).getByText('不入库，只给去向')).toBeVisible()
    await openAssetGroup(user, panel, /录像/)
    expect(within(panel).getByText('/nas/2026/08/m-1/video.mp4')).toBeVisible()
  })

  test('「已授权给谁」取失败时说取失败，不显示成「没有授权」', async () => {
    routes.unshift({ match: /\/meetings\/[^/?]+$/, status: 500, body: { error: 'nope' } })
    renderPreview()
    await ready()
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    expect(await within(panel).findByText(/取失败/)).toBeInTheDocument()
  })

  // 这条断言 2026-08-28 翻了个面：从「理由写在界面上」改成「界面上一个字都没有」。
  //
  // 裁定本身**没有变**——问答是一条新的出境路径（spec §1.4），真要接就当一个采集
  // 程序来管，走接入向导拿凭据、受规则和授权约束、每次问答记一条审计。变的是这条
  // 裁定记在哪：此前右下角挂着一整块「向这场会议提问 —— 刻意不做」，两段散文解释
  // 一个不存在的输入框为什么不存在。它和会议详情抽屉里的「撤销归档」是同一个错误,
  // 处置也一样——理由进 spec（§1.4 / §10），界面上连那个禁用的输入框都不画。
  test('不是 AI 问答框：没有提问入口，也不在界面上解释为什么没有', async () => {
    renderPreview()
    await ready()
    expect(screen.queryByRole('region', { name: /提问/ })).toBeNull()
    expect(screen.queryByText(/向这场会议提问/)).toBeNull()
    expect(screen.queryByRole('button', { name: /提问/ })).toBeNull()
    // 资产面板里没有任何可输入的东西。（转写 tab 那个搜索框搜的是本地已经取回来
    // 的正文，不是一条出境路径，它可以在——所以这里只钉这一块，不钉整页。）
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    expect(within(panel).queryByRole('textbox')).toBeNull()
    expect(within(panel).queryByRole('searchbox')).toBeNull()
  })
})

/* ── 留痕与受限查看 ───────────────────────────────────────────────── */

/**
 * 后端好几段说明文字里带 Markdown 的粗体记号（`**不入库**`）。原样打印出来就是
 * 一串星号——看起来像个 bug，而它出现的位置恰恰是最需要被信任的地方。
 *
 * `Emphasis` 就是为这件事写的，但 2026-08-30 在真实数据上发现它**只套在
 * `access.banner` 上**：右下角的 `media.text` 直接把「录像与音频**不入库、也不由
 * 本接口代理内容**（T10 验收 3）」原样印了出来。
 *
 * 所以这条断言不盯某一个字段，盯**整页**：屏幕上任何位置都不许出现字面的 `**`。
 * 后端将来在哪一段文案里加粗体，这条都拦得住。
 */
/**
 * 上屏的文字是给管理员的，不是给读代码的人的（2026-08-31）。
 *
 * 用户报「这两个红框里的文字描述非常奇怪，从面向客户的交互视角这些信息都非常多余」。
 * 圈的是琥珀警示条和右栏面板，两处加起来近 200 字，里面有 `spec §2`、`spec §4.9`、
 * `view_restricted_content`、`` `asset_contents` 是文本表 ``、
 * `GET .../media/:assetType/:remoteId/:fileType`——全是给读代码的人写的。
 *
 * 后端那一侧有一条同名的门禁（`tests/http/console-content.test.ts`）盯着这三个字段
 * 本身。这一条盯的是**整页**：不管哪个字段、将来加哪个新字段，只要它上了屏，就受
 * 这条约束。机器名仍然可以走 `title`（审计动作名、主持人的 userid、精确到期时刻
 * 都是这个处置），所以这里读的是 `textContent`——它不含属性。
 */
describe('屏幕上不出现规格引用 / 机器名 / 反引号代码', () => {
  test('受限查看的整页文字里一个都没有', async () => {
    const user = userEvent.setup()
    routes.unshift({ match: /\/content$/, status: 200, body: { ...INDEX, access: ACCESS_DENY } })
    renderPreview()
    await ready()
    const seen = (): string => document.body.textContent ?? ''
    for (const [re, why] of [
      [/spec\s*§/, '规格章节号——管理员手里没有 spec'],
      [/view_(restricted_)?content|asset_contents|local_purged_at/, '机器名，它的位置是 title'],
      [/`/, '反引号'],
    ] as Array<[RegExp, string]>) {
      expect(re.test(seen()), `屏幕上出现了${why}`).toBe(false)
    }
    // 机器名没有被丢掉，只是挪进了 title
    expect(screen.getByTitle('动作 view_restricted_content')).toBeInTheDocument()

    // 展开资产明细，后端逐条写的理由同样受这条约束
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    await openAssetGroup(user, panel, /完整转写/)
    expect(/spec\s*§|`/.test(seen())).toBe(false)
  })

  /**
   * 空的 `media.text` 不许画成一个空段落——它仍然吃掉一行外边距，在面板底部留出
   * 一条说不清的空白（这一页为「空洞」返工过三轮）。
   */
  test('media.text 是空串时，面板底部不多出一个空段落', async () => {
    renderPreview()
    await ready()
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    expect(panel.querySelector('[class*="mediaNote"]')).toBeNull()
  })
})

describe('后端下发的 **强调** 一律渲染成粗体，屏幕上不出现字面的星号', () => {
  test('整页任何位置都没有字面的 **', async () => {
    const user = userEvent.setup()
    routes.unshift({
      match: /\/content$/,
      status: 200,
      body: {
        ...INDEX,
        access: ACCESS_DENY,
        local: { ...INDEX.local, text: '本地文件**还在**，保留期到 2026-09-01。' },
        media: { ...INDEX.media, text: '录像与音频**不入库、也不由本接口代理内容**。' },
      },
    })
    renderPreview()
    await ready()
    expect(document.body.textContent).not.toContain('**')
    // 粗体真的渲染出来了，不是把星号连同文字一起吞掉
    expect(screen.getByText('不入库、也不由本接口代理内容').tagName).toBe('STRONG')
    expect(screen.getByText('还在').tagName).toBe('STRONG')

    // 展开一组资产，明细里的后端理由同样不许漏星号
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    await openAssetGroup(user, panel, /完整转写/)
    expect(document.body.textContent).not.toContain('**')
  })
})

describe('只读留痕（spec §2）', () => {
  test('被规则禁止采集的会议：顶部挂琥珀警示条，并说清这次查看已留痕', async () => {
    routes.unshift({ match: /\/content$/, status: 200, body: { ...INDEX, access: ACCESS_DENY } })
    renderPreview()
    await ready()
    const note = screen.getByRole('note')
    /*
     * 2026-08-31 改写。原来这里断言警示条里同时有「禁止采集」和「已记进操作审计」
     * ——而这两件事抬头上各有一个标记（Pill「规则禁止采集」+「● 已记审计」），
     * 警示条把它们再说一遍就是同一屏第三次。现在警示条只说屏幕上没有的那件事：
     * **你为什么能看**。审计仍然提一句（那是这句话的后半截，不是重复），判定本身
     * 交给抬头的 Pill 和右栏「采集判定」那一行。
     */
    /*
     * **主语必须在**。第一稿写的是「这场会议的内容不允许出企业边界」，用户当场问
     * 「这个是什么意思，是不能采集走吗？」——问的人正是这句话唯一的读者。
     * 「出企业边界」是 spec §1.4 里我们自己的抽象说法；屏幕上要说的是具体那件事:
     * 取不走它的是**采集程序**，而看这一页的人恰恰是那个例外。
     */
    expect(within(note).getByText(/采集程序取不走/)).toBeInTheDocument()
    expect(within(note).getByText(/判断这条规则拦得对不对/)).toBeInTheDocument()
    expect(note.textContent, '抽象说法不上屏，屏幕上说具体的事').not.toContain('企业边界')
    expect(note.textContent).toContain('已记审计')
    // 判定本身不在警示条里说第三遍，但屏幕上仍然有——两个地方各一次
    expect(screen.getAllByText('规则禁止采集').length).toBe(1)
    expect(within(screen.getByRole('region', { name: '这场会议的资产与去向' })).getByText('禁止采集')).toBeVisible()
    // 后端下发的 `**强调**` 不能原样打印出星号
    expect(note.textContent).not.toContain('**')
    // 一句话，不是一段。上一版 89 个字，四句里三句屏幕上已经有了
    expect(note.textContent!.length).toBeLessThan(60)
  })

  test('页面上说得出这次查看记了哪个动作', async () => {
    routes.unshift({ match: /\/content$/, status: 200, body: { ...INDEX, access: ACCESS_DENY } })
    renderPreview()
    await ready()
    // 动作名从一整段散文挪进「已记审计」标记的 `title`（同 lib/host.ts 对 userid
    // 的处置）：留痕这件事恒在屏幕上，记的是哪个动作是查证时才要的那一层。
    expect(screen.getByText('已记审计')).toBeVisible()
    expect(screen.getByTitle('动作 view_restricted_content')).toBeInTheDocument()
  })

  test('「已记审计」在准许采集的会议上一样挂着——留痕不是受限会议才有的事', async () => {
    renderPreview()
    await ready()
    expect(screen.getByText('已记审计')).toBeVisible()
    expect(screen.getByTitle('动作 view_content')).toBeInTheDocument()
  })
})

/* ── 三态 ─────────────────────────────────────────────────────────── */

describe('加载 / 失败 / 空', () => {
  test('加载中给骨架，不是白屏', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(() => {})))
    renderPreview()
    expect(await screen.findByLabelText('正在读取这场会议的内容')).toBeInTheDocument()
  })

  test('整页读取失败：给端点名、错误码与重试', async () => {
    routes.unshift({ match: /\/content$/, status: 404, body: { error: 'meeting_not_found' } })
    const user = userEvent.setup()
    renderPreview()
    expect(await screen.findByText(/meeting_not_found/)).toBeInTheDocument()
    expect(screen.getByText(/\/content/)).toBeInTheDocument()

    routes.unshift({ match: /\/content$/, status: 200, body: INDEX })
    await user.click(screen.getByRole('button', { name: '重试' }))
    await ready()
  })

  /**
   * 返回链接以前挂在 `PageShell` 的 `actions` 上，于是这一页有两条抬头上下摞着，
   * 上面那条里只有一个右对齐的链接、左边九成宽是空的（1440 实测 34px 的空壳）。
   * 现在它是内容区的第一行，三个状态都在——读不出来的时候最想做的就是回列表。
   */
  test('加载中也有返回链接，而且它不再自己占一条页头', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(() => {})))
    const { container } = renderPreview()
    expect(screen.getByRole('link', { name: '返回会议列表' })).toBeInTheDocument()
    // 这一页自己有一条抬头（`Body` 的 `.head`）；`PageShell` 那条只装得下这个
    // 链接，左边九成宽是空的。它现在没有了 —— 三个状态下都不该再出现。
    expect(
      container.querySelector('header'),
      '返回链接又回到 PageShell 的 actions 里去了',
    ).toBeNull()
  })

  test('读不出来的时候返回链接还在 —— 那时最想做的就是回列表', async () => {
    routes.unshift({ match: /\/content$/, status: 404, body: { error: 'meeting_not_found' } })
    renderPreview()
    expect(await screen.findByText(/meeting_not_found/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回会议列表' })).toBeInTheDocument()
  })

  test('正常渲染时返回链接排在会议抬头前面，不跟抬头挤同一行', async () => {
    const { container } = renderPreview()
    await ready()
    const link = screen.getByRole('link', { name: '返回会议列表' })
    expect(link.closest('header')).toBeNull()
    const head = container.querySelector('header')
    expect(head, '会议抬头没了').not.toBeNull()
    expect(
      link.compareDocumentPosition(head!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  test('时间轴取失败不拖垮整页：播放器仍在，那一块说自己取失败了', async () => {
    routes.unshift({ match: /\/content\/chapters/, status: 500, body: { error: 'cue_boom' } })
    renderPreview()
    await ready()
    expect(screen.getByRole('slider', { name: '播放位置' })).toBeInTheDocument()
    expect(await screen.findByText(/cue_boom/)).toBeInTheDocument()
  })
})

/* ── 样式 ─────────────────────────────────────────────────────────── */

describe('样式令牌', () => {
  /**
   * 琥珀警示条**不许是 flex 容器**。
   *
   * 后端下发的 banner 里带 `**禁止采集**`，`Emphasis` 把它渲染成
   * `文本节点 + <strong> + 文本节点`。父容器一旦是 flex，这三段各自成为一个
   * flex item——`<strong>禁止采集</strong>` 被挤成一根四个字的竖条，整条警示
   * 变成三列：「这场会议按当前的采集权限规则是 / 禁止采集 / 的。管理员仍然能看……」。
   *
   * 2026-08-30 在真实数据上撞见。它在宽屏单行时看不出来——右栏一挤就现形，
   * 而这条恰恰是全站最需要被读懂的一句话。
   */
  test('警示条是普通文本流，不是 flex —— 后端下发的 **强调** 会被挤成竖条', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/pages/Preview/Preview.module.css'),
      'utf-8',
    )
    const block = /\.warn \{([^}]*)\}/.exec(css)
    expect(block, '找不到 .warn 规则').not.toBeNull()
    expect(block![1]).not.toMatch(/display:\s*flex/)
  })

  // 文件名原来是写死的两个。改成扫目录：这一页拆过一次组件（资产面板搬进了自己的
  // 样式表），写死的清单当场就漏掉了新文件——而漏掉的那一刻这条测试仍然是绿的。
  // 一个**报告"通过"却什么都没检查**的门禁比没有这个门禁更糟（同 a11y 的空扫描保护）。
  test('CSS 里没有裸值——色值与间距一律走令牌', () => {
    const dir = resolve(process.cwd(), 'src/pages/Preview')
    const files = readdirSync(dir).filter((f) => f.endsWith('.module.css'))
    expect(files.length, '一个样式表都没扫到，说明这条门禁在空转').toBeGreaterThan(0)
    for (const file of files) {
      const css = readFileSync(resolve(dir, file), 'utf-8')
      const decls = css.replace(/\/\*[\s\S]*?\*\//g, '')
      expect(decls, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(decls, file).not.toMatch(/\brgba?\(/)
      expect(decls.replace(/\b[01]px\b/g, ''), file).not.toMatch(/\b\d+px\b/)
    }
  })

  /**
   * `scrollIntoView` 在这一页是**被禁用的 API**，不是"尽量别用"。
   *
   * 它没有"只滚这一个容器"的写法：沿祖先链每一个可滚动容器都会被滚，文档本身也算
   * 一个。这一页同时有三层可滚动的东西（分段列表 60vh、原文 `<pre>` 60vh、页面本身）,
   * 用它就等于把 window 交出去。要跟随就自己写容器的 `scrollTop`——赋值不波及祖先。
   *
   * 上面那条只数了它在**跑到的那条路径**上没被调用；这条扫全目录，新加的组件也拦得住。
   */
  test('Preview 目录里不许出现 scrollIntoView', () => {
    const dir = resolve(process.cwd(), 'src/pages/Preview')
    const files = readdirSync(dir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    expect(files.length, '一个源文件都没扫到，说明这条门禁在空转').toBeGreaterThan(0)
    for (const file of files) {
      const src = readFileSync(resolve(dir, file), 'utf-8')
      // 注释里可以提它（`text.tsx` 整段推理就写在那儿），代码里不行
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/scrollIntoView/)
    }
  })
})

describe('只读账号（spec §2：看内容是它该有的权限）', () => {
  test('内容照常看得到——`GET .../content` 在 A8 的白名单里，读内容不降级', async () => {
    const router = createMemoryRouter(
      [
        { path: '/preview/:id', element: <PreviewPage /> },
        { path: '/meetings', element: <div>会议记录页</div> },
      ],
      { initialEntries: ['/preview/m-1'] },
    )
    renderAsRole(<RouterProvider router={router} />, 'readonly')
    await waitFor(() => expect(screen.getByRole('heading', { name: '产品周会' })).toBeInTheDocument())
    // 三个 tab 都点得动：它们是读
    for (const b of screen.getAllByRole('tab')) expect(b).toBeEnabled()
  })
})
