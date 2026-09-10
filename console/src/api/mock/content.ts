import type { AssetKey, Meeting } from '../types'
import { MOCK_SUB_MEETING_ID } from './meetings'

/**
 * 内容预览页的两条端点（`.../content` 与 `.../content/chapters`）。
 *
 * ## 一份内容索引不是"每一行都正常"
 *
 * `availability` 的六个取值**每一个都对应一件不同的事实**，只有 `missing` 才是
 * 「这场会议确实缺这一类」，其余五种都是可修复的缺口。种子里因此让同一场会议
 * 的不同资产落在不同取值上：txt 解析进库、docx 格式不支持、pdf 超出上限、
 * 还有一类归档了但正文没入库。屏幕上这几行的颜色与说明各不相同，
 * 门槛只扫到"正文在库"那一种等于没扫。
 *
 * ## 章节与转写分段是两样东西
 *
 * `chapters` 是腾讯智能录制的章节（2026-09-08 起有真来源），`cues` 是按逐字稿
 * 时间戳切出的转写分段。种子里两样都给，但**不拿分段冒充章节**。
 *
 * ## 内容跟着会议世界走
 *
 * 还没归档的会议，它的资产就只能是「本地已下载，未归档」；本地文件已清理的
 * 会议，录像那一行就得说 NAS 上还有、本地没了。这些不是这里另编的一套状态，
 * 是从 `api/mock/meetings.ts` 那一份世界推出来的。
 */

/** 五类里做文本的两类。录像与音频只给去向不给内容（走 `media`），时间轴走 chapters 端点。 */
const TEXT_TYPES: AssetKey[] = ['transcript', 'ai_minutes']

interface FilePlan {
  fileType: string
  availability: string
  /** 只有 `parsed` 的那一份给得出正文 */
  body?: (m: Meeting) => string
}

/**
 * 每一类文本资产在库里是什么样。**只有 txt 会被解析成正文**（T4 裁定），
 * 另两种格式如实报未解析——不是"没有这一类"。
 */
const PLAN: Record<string, FilePlan[]> = {
  transcript: [
    { fileType: 'txt', availability: 'parsed', body: (m) => transcriptBody(m) },
    { fileType: 'docx', availability: 'unsupported_format' },
    { fileType: 'pdf', availability: 'too_large' },
  ],
  ai_minutes: [
    { fileType: 'txt', availability: 'parsed', body: (m) => minutesBody(m) },
    { fileType: 'docx', availability: 'unsupported_format' },
  ],
}

/** 每一种不可得都要说得出原因。空着等于让人以为"就是没有"。 */
const REASON: Record<string, string> = {
  unsupported_format: '这一份是 docx，正文解析只处理 txt。文件在 NAS 上，可以下载后自己打开。',
  too_large: '正文超出入库上限，只归档了文件本身，没有把正文读进库。',
  not_ingested: '文件已经在 NAS 上，正文没有入库——这一类接解析的时候它已经归档过了。',
  not_archived: '本地已经下载，还没归档进 NAS，所以正文也还没入库。',
  missing: '腾讯会议侧还没生成这一份，本轮没有取到。',
}

function minutesBody(m: Meeting): string {
  return [
    `# ${m.title} · 纪要`,
    '',
    `主持人：${m.host}　会议号：${m.code}`,
    '',
    '## 结论',
    '- 本次讨论的三件事都有了明确的下一步，责任人已经落到人。',
    '- 有一项依赖上游的接口改造，本周内给不出时间点。',
    '',
    '## 待办',
    '1. 把方案里那两处口径统一，周四前给出对照表。',
    '2. 联系上游确认接口改造的排期，拿到回复当天同步。',
  ].join('\n')
}

function transcriptBody(m: Meeting): string {
  return [
    `[00:00] ${m.host}：我们开始吧，今天三件事。`,
    '[00:42] 李销售：第一件我这边先说，上周的量比预期低一些。',
    '[03:15] 邹研发：原因我们查过了，是上游接口限流，不是我们这边的问题。',
    '[07:58] 王总：那就先按限流的口径重排一下这周的计划。',
    '[12:20] 邹研发：好，我今天把对照表发出来。',
  ].join('\n')
}

/* ── 资产索引 ─────────────────────────────────────────────────── */

function assetRows(m: Meeting, shiftSec: number): Array<Record<string, unknown>> {
  const archived = m.keep.archivedAt !== null
  const rows: Array<Record<string, unknown>> = []

  for (const type of TEXT_TYPES) {
    const have = m.assets[type]
    if (have === undefined || have.got === 0) continue
    const plan = PLAN[type] ?? []
    plan.forEach((p, i) => {
      // 还没归档的会议，正文不可能在库里——它整场都只到"本地已下载"这一步
      const availability = archived ? p.availability : 'not_archived'
      const body = availability === 'parsed' ? (p.body?.(m) ?? null) : null
      rows.push({
        assetType: type,
        assetKey: type,
        remoteId: `${m.id}-${type}-${i + 1}`,
        fileType: p.fileType,
        availability,
        bytes: availability === 'parsed' || availability === 'not_ingested' ? 18_342 + i * 907 : null,
        chars: body === null ? null : body.length,
        reason: REASON[availability] ?? null,
        contentHash: archived ? `sha256:${m.id}${type.slice(0, 3)}${i}` : null,
        parsedAt: body === null ? null : (m.keep.archivedAt ?? 0) + shiftSec + 120,
        nasPath: archived && m.nasPath !== null ? `${m.nasPath}${type}.${p.fileType}` : null,
      })
    })
    // 应有却还没拿到的那几份：**确认取不到**，与"格式不支持"不是一回事
    if (have.got < have.total) {
      rows.push({
        assetType: type,
        assetKey: type,
        remoteId: `${m.id}-${type}-pending`,
        fileType: 'txt',
        availability: 'missing',
        bytes: null,
        chars: null,
        reason: REASON.missing!,
        contentHash: null,
        parsedAt: null,
        nasPath: null,
      })
    }
  }
  return rows
}

function mediaBlock(m: Meeting, shiftSec: number): Record<string, unknown> {
  const assets: Array<Record<string, unknown>> = []
  for (const type of ['video', 'audio'] as AssetKey[]) {
    const have = m.assets[type]
    if (have === undefined || have.got === 0) continue
    const ext = type === 'video' ? 'mp4' : 'm4a'
    assets.push({
      assetType: type,
      assetKey: type,
      remoteId: `${m.id}-${type}`,
      fileType: ext,
      nasPath: m.nasPath === null ? null : `${m.nasPath}${type}.${ext}`,
      localPath: m.keep.filesGone ? null : `/var/lib/mde/media/${m.id}/${type}.${ext}`,
      archivedAt: m.keep.archivedAt === null ? null : m.keep.archivedAt + shiftSec,
      localGone: m.keep.filesGone,
    })
  }
  return {
    // 录像与音频不入库、本接口也不代理内容：几个 GB 的文件，代理一份等于把网关当 CDN
    proxied: false,
    // 与真网关同一版：保留期内是**空串**。「不入库，只给去向」写在录像那一组的行尾,
    // 每个文件自己列着 NAS 路径，左边还有一个正在播的播放器——这里再写一段是第四遍。
    text: m.keep.filesGone
      ? `本地已清理，能播的是 NAS 上那一份${m.nasPath === null ? '' : `（${m.nasPath}）`}。`
      : '',
    assets,
  }
}

function localBlock(m: Meeting, shiftSec: number): Record<string, unknown> {
  const archived = m.keep.archivedAt !== null
  const shift = (n: number | null): number | null => (n === null ? null : n + shiftSec)
  // 与真网关同一版：行值已经说了「还剩几天 / 已清理 / 没归档」，NAS 路径自己是一行,
  // 这里只补它们说不出的那一件事。
  let text: string
  if (!archived) {
    text = '正文在归档那一刻入库，所以现在读到的可能不全——拉取到哪一步看会议详情。'
  } else if (m.keep.filesGone) {
    text = '**纪要正文不受影响**——它在归档时就入了库。录像去上面那个 NAS 路径取。'
  } else {
    text = '到期只删本地文件；纪要正文与归档记录留着。'
  }
  return {
    archived,
    filesGone: m.keep.filesGone,
    archivedAt: shift(m.keep.archivedAt),
    // 已清理的会议，清理发生在到期那一刻
    purgedAt: m.keep.filesGone ? shift(m.keep.expiresAt) : null,
    expiresAt: shift(m.keep.expiresAt),
    nasDir: m.nasPath,
    text,
  }
}

function accessBlock(m: Meeting): Record<string, unknown> {
  const restricted = m.allow === 'deny'
  return {
    allow: m.allow,
    restricted,
    why: m.why.allow,
    // 与真网关的 RESTRICTED_BANNER 同一版：只说屏幕上没有的那件事（你为什么能看）,
    // 「禁止采集」和「已记审计」抬头各有一个标记，不在这里再说第三遍。
    banner: restricted
      ? '**采集程序取不走这场会议**。你能在这里看，是为了判断这条规则拦得对不对；这次查看已记审计。'
      : null,
    audit: { logged: true, action: restricted ? 'view_restricted_content' : 'view_content' },
  }
}

/** 会议抬头。契约的 `Meeting` 是给会议记录页的，这里只有标识与抬头。 */
function meetingBlock(m: Meeting, shiftSec: number): Record<string, unknown> {
  return {
    id: m.id,
    meetingId: m.id,
    subMeetingId: MOCK_SUB_MEETING_ID,
    title: m.title,
    code: m.code,
    startAt: m.startAt + shiftSec,
    durationSec: m.durationSec,
    host: m.host,
    // mock 的 `Meeting.host` 存的是人名（'邹研发' / '王总'），不是 userid——
    // 真网关那一列是 `woaJARCQAA…` 这样的 32 位串。两者形状不同，所以这里显式
    // 当作「已经查到姓名」下发；不写这一行，lib/host.ts 会把一个已经是姓名的
    // 东西降级成「未知主持人 · 邹研发」。
    //
    // 顺带记一笔：预览页把 userid 原样上屏的 bug 之所以躲过了所有基于 mock 的
    // 检查（含 a11y 的 preview 四个形态），正是因为这里的替身比真实依赖宽容。
    hostName: m.host,
    missing: [],
  }
}

/**
 * `GET /meetings/:id/content[?type=&format=]`。
 *
 * 不带 `type` 时 `selected` **恒为 null**：进页面就顺手把可能几 MB 的正文一起
 * 取回来，是这条端点最容易被写坏的地方。
 */
export function buildContent(
  m: Meeting,
  opts: { shiftSec: number; type?: string; format?: string },
): Record<string, unknown> {
  const assets = assetRows(m, opts.shiftSec)

  let selected: Record<string, unknown> | null = null
  if (opts.type !== undefined) {
    const mine = assets.filter(
      (r) => r.assetType === opts.type && (opts.format === undefined || r.fileType === opts.format),
    )
    const parsed = mine.filter((r) => r.availability === 'parsed')
    const plan = PLAN[opts.type] ?? []
    const state = parsed.length > 0 ? 'ok' : mine.length > 0 ? 'unparsed' : 'absent'
    selected = {
      type: opts.type,
      assetKey: opts.type,
      state,
      segments: mine.map((r, i) => {
        const p = plan.find((x) => x.fileType === r.fileType)
        return {
          ...r,
          ordinal: i + 1,
          content: r.availability === 'parsed' ? (p?.body?.(m) ?? null) : null,
        }
      }),
      text:
        state === 'ok'
          ? '下面是库里这一份的全文。'
          : state === 'unparsed'
            ? '这一类的文件在，但正文没有解析出来——**不是"这场会议没有这一类"**。每一段下面写了各自的原因。'
            : '库里没有这场会议这一类的任何记录。',
    }
  }

  return {
    meeting: meetingBlock(m, opts.shiftSec),
    access: accessBlock(m),
    local: localBlock(m, opts.shiftSec),
    assets,
    selected,
    media: mediaBlock(m, opts.shiftSec),
  }
}

/* ── 转写分段（不是章节） ─────────────────────────────────────── */

/**
 * 这几场的转写正文里没有任何时间戳（另一种导出格式）。
 * 认不出格式时后端不猜、不切，给前几行原文让人自己判断——
 * 切出一批时间对不上的分段，比切不出来糟得多。
 */
const NO_TIMESTAMP = new Set(['m6'])

const SPEAKERS = ['王总', '邹研发', '李销售', '周HR']

export function buildChapters(m: Meeting, shiftSec: number): Record<string, unknown> {
  const hasTranscript = (m.assets.transcript?.got ?? 0) > 0 && m.keep.archivedAt !== null
  // 章节跟着这场会议有没有取到「时间轴」那一类资产走——没开智能录制的会议
  // 拿不到，那时章节是空的、`text` 说清是哪一种。**不是**从 cues 编出来的：
  // 章节与转写分段各有各的来源。
  const hasChapters = (m.assets.chapters?.got ?? 0) > 0
  const common = {
    meeting: meetingBlock(m, shiftSec),
    access: accessBlock(m),
    chapters: hasChapters
      ? [
          { id: 'C1', name: '开场', at: 7 },
          { id: 'C2', name: '需求评审', at: 120 },
        ]
      : [],
    source: hasChapters ? 'tencent' : 'none',
    text: hasChapters
      ? '上面是腾讯智能录制生成的章节，下面是从逐字稿的时间戳切出来的转写分段。'
      : '这场会议没有开智能录制，所以没有章节；下面是从逐字稿的时间戳切出来的转写分段。',
  }

  if (!hasTranscript) {
    return { ...common, cues: [], cuesFrom: null, sample: null }
  }

  const from = {
    assetType: 'transcript',
    assetKey: 'transcript',
    remoteId: `${m.id}-transcript-1`,
    fileType: 'txt',
    format: NO_TIMESTAMP.has(m.id) ? 'none' : 'bracket',
    total: 0,
    returned: 0,
    truncated: false,
  }

  if (NO_TIMESTAMP.has(m.id)) {
    return {
      ...common,
      cues: [],
      cuesFrom: from,
      sample: [
        `${m.title} 转写`,
        '（这一份导出里没有任何时间戳）',
        '面试官：先请你介绍一下最近做的一个项目。',
      ],
    }
  }

  // 中间那一段落在正好一半的位置：进页面时播放位置就停在它上面（联动区要有东西可显示）
  const half = Math.floor(m.durationSec / 2)
  const ats = [0, Math.floor(half / 2), half, half + Math.floor(half / 2), m.durationSec - 60]
  const lines = transcriptBody(m).split('\n')
  const cues = ats.map((at, i) => ({
    at: Math.max(0, at),
    endAt: i === ats.length - 1 ? null : Math.max(0, ats[i + 1]! - 1),
    speaker: SPEAKERS[i % SPEAKERS.length]!,
    text: (lines[i] ?? lines[0]!).replace(/^\[[^\]]+\]\s*/, ''),
  }))

  return {
    ...common,
    cues,
    cuesFrom: { ...from, total: cues.length, returned: cues.length },
    sample: null,
  }
}
