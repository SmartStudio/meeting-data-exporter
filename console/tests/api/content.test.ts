import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../src/api/client'
import { ApiShapeError } from '../../src/api/validate'
import {
  ASSET_LABEL,
  AVAILABILITY_LABEL,
  assetLabel,
  availabilityLabel,
  fetchChapters,
  fetchContentIndex,
  fetchContentSelection,
  fetchMeetingGrantIds,
} from '../../src/api/admin/content'

/**
 * 内容预览的两条端点（api-contracts §7）+ 一条窄读（授权程序 id）。
 *
 * 这一层测的是**形状与路径**，不是界面：字段名写错一个字母，TypeScript 一个字
 * 都不会说，而 `res.json()` 回来是 any。所以每条端点都要有一条"缺字段就抛、
 * 并且报得出是哪个字段"的测试。
 */

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

function install(status: number, body: unknown): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

const MEETING = {
  id: 'm-1',
  meetingId: 'm-1',
  subMeetingId: '',
  title: '产品周会',
  code: '123-456',
  startAt: 1699900000,
  durationSec: 3600,
  host: 'zouyanjian',
  missing: [],
}

const ACCESS_ALLOW = {
  allow: 'allow',
  restricted: false,
  why: { by: 'rule', text: '采集程序「kb-indexer」：标题含「周会」，规则 #100' },
  banner: null,
  audit: { logged: true, action: 'view_content' },
}

const ACCESS_DENY = {
  allow: 'deny',
  restricted: true,
  why: { by: 'deny', text: '规则 #7 明确拒绝' },
  banner: '这场会议按当前的采集权限规则是**禁止采集**的。',
  audit: { logged: true, action: 'view_restricted_content' },
}

const LOCAL = {
  archived: true,
  filesGone: false,
  archivedAt: 1699950000,
  purgedAt: null,
  expiresAt: 1702542000,
  nasDir: '/nas/2026/08/m-1',
  text: '本地文件还在，保留期到 …',
}

const ASSET = {
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
}

const MEDIA = {
  proxied: false,
  text: '录像与音频不入库、也不由本接口代理内容……',
  assets: [
    {
      assetType: 'record',
      assetKey: null,
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
  assets: [ASSET],
  selected: null,
  media: MEDIA,
}

const SELECTED = {
  ...INDEX,
  selected: {
    type: 'ai_minutes',
    assetKey: 'ai_minutes',
    state: 'ok',
    segments: [{ ...ASSET, ordinal: 1, content: '……正文……' }],
    text: '纪要共 1 段，其中 1 段有正文。',
  },
}

const CHAPTERS = {
  meeting: MEETING,
  access: ACCESS_ALLOW,
  chapters: [
    { id: 'C1', name: '开场', at: 7 },
    { id: 'C2', name: '需求评审', at: 120 },
  ],
  source: 'tencent',
  text: '上面是腾讯智能录制生成的章节，下面是从逐字稿的时间戳切出来的转写分段。',
  cues: [
    { at: 65, endAt: null, speaker: '张三', text: '大家好' },
    { at: 130, endAt: 190, speaker: null, text: '先过一下进度' },
  ],
  cuesFrom: {
    assetType: 'meeting_summary',
    assetKey: 'transcript',
    remoteId: 'r-1',
    fileType: 'txt',
    format: 'bracket',
    total: 2,
    returned: 2,
    truncated: false,
  },
  sample: null,
}

describe('fetchContentIndex —— 只要索引，不选具体一类', () => {
  test('打的是 /content，且不带 type（带了就会多返回一份正文）', async () => {
    install(200, INDEX)
    const got = await fetchContentIndex('m-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/content')
    expect(got.meeting.title).toBe('产品周会')
    expect(got.access.why.text).toContain('规则 #100')
    expect(got.local.nasDir).toBe('/nas/2026/08/m-1')
    expect(got.assets[0]!.availability).toBe('parsed')
    expect(got.selected).toBeNull()
    expect(got.media.proxied).toBe(false)
    expect(got.media.assets[0]!.nasPath).toBe('/nas/2026/08/m-1/video.mp4')
  })

  test('周期性会议的 id 里有逗号，整段要编码——不编码后端会按逗号切错', async () => {
    install(200, INDEX)
    await fetchContentIndex('m%2C1,s-7')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m%252C1%2Cs-7/content')
  })

  test('每调一次就发一次请求：留痕的价值在完整，不许为省一次请求缓存复用', async () => {
    install(200, INDEX)
    await fetchContentIndex('m-1')
    await fetchContentIndex('m-1')
    expect(calls).toHaveLength(2)
  })

  test('缺字段抛 ApiShapeError，并报得出是哪一个字段', async () => {
    install(200, { ...INDEX, access: { ...ACCESS_ALLOW, why: { by: 'rule' } } })
    await expect(fetchContentIndex('m-1')).rejects.toBeInstanceOf(ApiShapeError)
    install(200, { ...INDEX, access: { ...ACCESS_ALLOW, why: { by: 'rule' } } })
    await expect(fetchContentIndex('m-1')).rejects.toThrow(/access\.why\.text/)
  })

  test('404 抛 ApiError，message 里带端点名与后端错误码', async () => {
    install(404, { error: 'meeting_not_found' })
    const err = await fetchContentIndex('m-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(404)
    expect((err as ApiError).message).toContain('/content')
    expect((err as ApiError).message).toContain('meeting_not_found')
  })

  test('琥珀警示条原样透出，restricted 与 audit.action 都读得到', async () => {
    install(200, { ...INDEX, access: ACCESS_DENY })
    const got = await fetchContentIndex('m-1')
    expect(got.access.restricted).toBe(true)
    expect(got.access.banner).toContain('禁止采集')
    expect(got.access.audit.action).toBe('view_restricted_content')
  })
})

describe('fetchContentSelection —— 选一类正文', () => {
  test('type 与 format 都进查询串', async () => {
    install(200, SELECTED)
    const got = await fetchContentSelection('m-1', { type: 'ai_minutes', format: 'txt' })
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/content?type=ai_minutes&format=txt')
    expect(got.selected!.state).toBe('ok')
    expect(got.selected!.segments[0]!.content).toBe('……正文……')
    expect(got.selected!.segments[0]!.ordinal).toBe(1)
  })

  test('不给 format 就不发这个键（`?format=` 是一次真实取值，不是"不筛选"）', async () => {
    install(200, SELECTED)
    await fetchContentSelection('m-1', { type: 'transcript' })
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/content?type=transcript')
  })

  test('state=absent 时 segments 为空，text 说得出为什么', async () => {
    install(200, {
      ...INDEX,
      selected: {
        type: 'ai_minutes',
        assetKey: 'ai_minutes',
        state: 'absent',
        segments: [],
        text: '这场会议在库里没有任何一段纪要的记录',
      },
    })
    const got = await fetchContentSelection('m-1', { type: 'ai_minutes' })
    expect(got.selected!.state).toBe('absent')
    expect(got.selected!.segments).toEqual([])
    expect(got.selected!.text).toContain('没有任何一段')
  })

  test('未解析的段：content 为 null、reason 有话说，两者都要留住', async () => {
    install(200, {
      ...INDEX,
      selected: {
        type: 'ai_minutes',
        assetKey: 'ai_minutes',
        state: 'unparsed',
        segments: [
          {
            ...ASSET,
            fileType: 'docx',
            availability: 'unsupported_format',
            chars: null,
            contentHash: null,
            reason: '不是 txt，本版本只解析 txt',
            ordinal: 1,
            content: null,
          },
        ],
        text: '在库里有 1 段记录，但一段正文都解析不出来',
      },
    })
    const got = await fetchContentSelection('m-1', { type: 'ai_minutes', format: 'docx' })
    expect(got.selected!.segments[0]!.content).toBeNull()
    expect(got.selected!.segments[0]!.reason).toContain('只解析 txt')
    expect(got.selected!.segments[0]!.chars).toBeNull()
  })
})

describe('fetchChapters —— 时间轴（章节 + 转写分段，两样各有各的来源）', () => {
  test('章节按 id/name/at 逐条读出来，source 原样透出', async () => {
    install(200, CHAPTERS)
    const got = await fetchChapters('m-1')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/content/chapters')
    expect(got.chapters).toEqual([
      { id: 'C1', name: '开场', at: 7 },
      { id: 'C2', name: '需求评审', at: 120 },
    ])
    expect(got.source).toBe('tencent')
    expect(got.text).toContain('章节')
    expect(got.cues).toHaveLength(2)
    expect(got.cues[0]).toEqual({ at: 65, endAt: null, speaker: '张三', text: '大家好' })
    expect(got.cuesFrom!.format).toBe('bracket')
    expect(got.cuesFrom!.truncated).toBe(false)
  })

  test('limit 进查询串', async () => {
    install(200, CHAPTERS)
    await fetchChapters('m-1', { limit: 5000 })
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/content/chapters?limit=5000')
  })

  test('认不出格式：cuesFrom.format=none 时 sample 给前几行原文', async () => {
    install(200, {
      ...CHAPTERS,
      cues: [],
      cuesFrom: { ...CHAPTERS.cuesFrom, format: 'none', total: 0, returned: 0 },
      sample: ['第一行', '第二行'],
    })
    const got = await fetchChapters('m-1')
    expect(got.cues).toEqual([])
    expect(got.sample).toEqual(['第一行', '第二行'])
  })

  test('一段转写都没有：cuesFrom 与 sample 都是 null，不是空数组', async () => {
    install(200, { ...CHAPTERS, cues: [], cuesFrom: null, sample: null })
    const got = await fetchChapters('m-1')
    expect(got.cuesFrom).toBeNull()
    expect(got.sample).toBeNull()
  })

  test('cues 里字段类型不对就抛，报得出下标', async () => {
    install(200, { ...CHAPTERS, cues: [{ at: '65', endAt: null, speaker: null, text: 'x' }] })
    await expect(fetchChapters('m-1')).rejects.toThrow(/cues\[0\]\.at/)
  })
})

describe('fetchMeetingGrantIds —— 「已授权给谁」的窄读', () => {
  test('只读 grants 一列，别的字段一个都不碰', async () => {
    install(200, { id: 'm-1', title: '产品周会', grants: ['kb-indexer', 'search'] })
    const got = await fetchMeetingGrantIds('m-1')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1')
    expect(got).toEqual(['kb-indexer', 'search'])
  })

  test('一个都没授权是空数组，不是 null', async () => {
    install(200, { id: 'm-1', grants: [] })
    expect(await fetchMeetingGrantIds('m-1')).toEqual([])
  })

  test('grants 不是字符串数组就抛', async () => {
    install(200, { id: 'm-1', grants: [1, 2] })
    await expect(fetchMeetingGrantIds('m-1')).rejects.toBeInstanceOf(ApiShapeError)
  })
})

describe('标签表', () => {
  test('五个资产键与后端 src/domain/asset-labels.ts 逐字一致', () => {
    expect(ASSET_LABEL).toEqual({
      video: '录像',
      audio: '音频',
      transcript: '逐字稿',
      ai_minutes: '纪要',
      chapters: '时间轴',
    })
  })

  test('资产名跟着后端的叫法，认不出的类型原样显示而不是折成"其他"', () => {
    expect(assetLabel('ai_minutes', 'ai_minutes')).toBe('纪要')
    expect(assetLabel('transcript', 'meeting_summary')).toBe('逐字稿')
    expect(assetLabel(null, 'brand_new_engine')).toBe('brand_new_engine')
  })

  test('六个 availability 各有各的说法，未知取值原样显示', () => {
    expect(Object.keys(AVAILABILITY_LABEL).sort()).toEqual(
      ['missing', 'not_archived', 'not_ingested', 'parsed', 'too_large', 'unsupported_format'].sort(),
    )
    expect(availabilityLabel('missing')).toBe('确认取不到')
    expect(availabilityLabel('parsed')).not.toBe(availabilityLabel('not_ingested'))
    expect(availabilityLabel('something_new')).toBe('something_new')
  })
})
