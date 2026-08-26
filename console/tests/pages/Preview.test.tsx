import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
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
  banner: '这场会议按当前的采集权限规则是**禁止采集**的。管理员仍然能看，但这次查看已记进操作审计。',
  audit: { logged: true, action: 'view_restricted_content' },
}

const LOCAL = {
  archived: true,
  filesGone: false,
  archivedAt: 1699950000,
  purgedAt: null,
  expiresAt: Math.floor(Date.now() / 1000) + 3 * 86400,
  nasDir: '/nas/2026/08/m-1',
  text: '本地文件还在，保留期到 2026-09-01。',
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
  text: '录像与音频不入库、也不由本接口代理内容：它们不是文本，单个可以有几个 GB。',
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
  test('落在会议中段，不是 0:00——三处联动当场就对得上', async () => {
    renderPreview()
    await ready()
    const slider = screen.getByRole('slider', { name: '播放位置' })
    expect(slider).toHaveAttribute('aria-valuenow', String(MIDPOINT))
    expect(slider).toHaveAttribute('aria-valuemax', String(DURATION))
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('30:00'))
  })

  test('字幕、发言人小窗当场对上中段那一段——不用等走两分钟', async () => {
    renderPreview()
    await ready()
    const player = screen.getByRole('region', { name: /播放/ })
    expect(within(player).getByText('RDS 白名单我早上开了。')).toBeInTheDocument()
    expect(within(player).getByText('陈运维')).toBeInTheDocument()
  })

  test('默认停在纪要 tab，三个 tab 都在', async () => {
    renderPreview()
    await ready()
    expect(screen.getByRole('tab', { name: /纪要/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /时间轴/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /转写文字/ })).toBeInTheDocument()
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

  test('走时推进 → 当前分段跟着换，字幕跟着换', async () => {
    renderPreview()
    await ready()
    // 从中段（1800）开始，走 31 秒就跨进 1830 那一段
    const slider = screen.getByRole('slider', { name: '播放位置' })
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
})

/* ── 键盘 ─────────────────────────────────────────────────────────── */

describe('键盘可达（spec §9 是硬要求）', () => {
  test('进度条方向键前后各 15 秒，Home/End 到两端', async () => {
    const user = userEvent.setup()
    renderPreview()
    await ready()
    const slider = screen.getByRole('slider', { name: '播放位置' })
    slider.focus()
    await user.keyboard('{ArrowRight}')
    expect(slider).toHaveAttribute('aria-valuenow', String(MIDPOINT + 15))
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(slider).toHaveAttribute('aria-valuenow', String(MIDPOINT - 15))
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
    renderPreview()
    await ready()
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })

    expect(within(panel).getByText('AI 纪要')).toBeInTheDocument()
    expect(within(panel).getAllByText('txt').length).toBeGreaterThan(0)
    expect(within(panel).getByText('4.00 KB')).toBeInTheDocument()
    expect(within(panel).getByText(/规则 #100 准许/)).toBeInTheDocument()
    expect(within(panel).getByText('kb-indexer、知识库索引器')).toBeInTheDocument()
    expect(within(panel).getByText(/还剩 3 天/)).toBeInTheDocument()
    expect(within(panel).getByText('/nas/2026/08/m-1')).toBeInTheDocument()
  })

  test('未解析的那一类要显示自己的理由，不显示成「没有」', async () => {
    renderPreview()
    await ready()
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    expect(within(panel).getByText(/未解析（格式不支持）/)).toBeInTheDocument()
    expect(within(panel).getByText(/文件在 NAS 上/)).toBeInTheDocument()
  })

  test('录像给去向不给内容：说清不代理，并给出 NAS 路径', async () => {
    renderPreview()
    await ready()
    expect(screen.getByText(/不由本接口代理内容/)).toBeInTheDocument()
    expect(screen.getByText('/nas/2026/08/m-1/video.mp4')).toBeInTheDocument()
  })

  test('「已授权给谁」取失败时说取失败，不显示成「没有授权」', async () => {
    routes.unshift({ match: /\/meetings\/[^/?]+$/, status: 500, body: { error: 'nope' } })
    renderPreview()
    await ready()
    const panel = screen.getByRole('region', { name: '这场会议的资产与去向' })
    expect(await within(panel).findByText(/取失败/)).toBeInTheDocument()
  })

  test('不是 AI 问答框：没有输入框、没有提问按钮，理由写在界面上', async () => {
    renderPreview()
    await ready()
    const ask = screen.getByRole('region', { name: /向这场会议提问/ })
    expect(within(ask).queryByRole('textbox')).toBeNull()
    expect(within(ask).queryByRole('searchbox')).toBeNull()
    expect(within(ask).queryByRole('button')).toBeNull()
    expect(within(ask).getByText(/出境/)).toBeInTheDocument()
    expect(within(ask).getByText(/当一个采集程序来管/)).toBeInTheDocument()
  })
})

/* ── 留痕与受限查看 ───────────────────────────────────────────────── */

describe('只读留痕（spec §2）', () => {
  test('被规则禁止采集的会议：顶部挂琥珀警示条，并说清这次查看已留痕', async () => {
    routes.unshift({ match: /\/content$/, status: 200, body: { ...INDEX, access: ACCESS_DENY } })
    renderPreview()
    await ready()
    const note = screen.getByRole('note')
    expect(within(note).getByText(/禁止采集/)).toBeInTheDocument()
    expect(within(note).getByText(/已记进操作审计|已记入操作审计/)).toBeInTheDocument()
    // 后端下发的 `**强调**` 不能原样打印出星号
    expect(note.textContent).not.toContain('**')
  })

  test('页面上说得出这次查看记了哪个动作', async () => {
    routes.unshift({ match: /\/content$/, status: 200, body: { ...INDEX, access: ACCESS_DENY } })
    renderPreview()
    await ready()
    expect(screen.getByText(/view_restricted_content/)).toBeInTheDocument()
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
  test('CSS 里没有裸值——色值与间距一律走令牌', () => {
    for (const file of ['Preview.module.css', 'Player.module.css']) {
      const css = readFileSync(resolve(process.cwd(), 'src/pages/Preview', file), 'utf-8')
      const decls = css.replace(/\/\*[\s\S]*?\*\//g, '')
      expect(decls, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(decls, file).not.toMatch(/\brgba?\(/)
      expect(decls.replace(/\b[01]px\b/g, ''), file).not.toMatch(/\b\d+px\b/)
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
