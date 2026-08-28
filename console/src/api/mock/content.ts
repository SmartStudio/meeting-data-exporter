import type { AssetKey, Meeting } from '../types'

/**
 * 内容预览页的两条端点（`.../content` 与 `.../content/chapters`）。
 *
 * ## 一份内容索引不是"八行都正常"
 *
 * `availability` 的六个取值**每一个都对应一件不同的事实**，只有 `missing` 才是
 * 「这场会议确实缺这一类」，其余五种都是可修复的缺口。种子里因此让同一场会议
 * 的不同资产落在不同取值上：txt 解析进库、docx 格式不支持、pdf 超出上限、
 * 还有一类归档了但正文没入库。屏幕上这几行的颜色与说明各不相同，
 * 门槛只扫到"正文在库"那一种等于没扫。
 *
 * ## 章节没有来源，所以这里不编章节
 *
 * 阶段 4 · T16 的裁定：`chapters` **恒为空数组**、`source` 恒为 `'none'`——
 * 本系统一次都没拉取过腾讯的「章节」数据。真正有内容的是 `cues`（转写分段，
 * 时间戳来自转写正文本身）。这里照办：一条假章节都不给。
 *
 * ## 内容跟着会议世界走
 *
 * 还没归档的会议，它的资产就只能是「本地已下载，未归档」；本地文件已清理的
 * 会议，录像那一行就得说 NAS 上还有、本地没了。这些不是这里另编的一套状态，
 * 是从 `api/mock/meetings.ts` 那一份世界推出来的。
 */

/** 八类里做文本的六类。录像与音频只给去向，不给内容，走 `media`。 */
const TEXT_TYPES: AssetKey[] = [
  'transcript',
  'ai_transcript',
  'ai_minutes',
  'ai_topic_minutes',
  'ai_speaker_minutes',
  'ai_ds_minutes',
]

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
  ai_transcript: [{ fileType: 'txt', availability: 'not_ingested' }],
  ai_minutes: [
    { fileType: 'txt', availability: 'parsed', body: (m) => minutesBody(m) },
    { fileType: 'docx', availability: 'unsupported_format' },
  ],
  ai_topic_minutes: [{ fileType: 'docx', availability: 'unsupported_format' }],
  ai_speaker_minutes: [{ fileType: 'txt', availability: 'too_large' }],
  ai_ds_minutes: [{ fileType: 'txt', availability: 'parsed', body: (m) => summaryBody(m) }],
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
    `# ${m.title} · AI 纪要`,
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

function summaryBody(m: Meeting): string {
  return `${m.title}：三件事，两件当场定了下一步，一件卡在上游接口的排期上。`
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
    text:
      assets.length === 0
        ? '这场会议没有录像或音频的归档记录。'
        : '录像与音频不入库，控制台也不代理它们的内容——下面给的是文件的去向，取用请直接去 NAS。',
    assets,
  }
}

function localBlock(m: Meeting, shiftSec: number): Record<string, unknown> {
  const archived = m.keep.archivedAt !== null
  const shift = (n: number | null): number | null => (n === null ? null : n + shiftSec)
  let text: string
  if (!archived) {
    text = '还没有归档到 NAS。保留窗口要等归档成功才开始计时，现在只有本地这一份。'
  } else if (m.keep.filesGone) {
    text = '保留期已经结束，本地文件被到期清理删掉了。NAS 上的副本还在，取用请去 NAS。'
  } else {
    text = '本地文件还在保留期内，NAS 上也有一份副本。到期之后本地会被清理，NAS 那份不动。'
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
    banner: restricted
      ? '这场会议**按采集规则禁止采集**，外部程序一份都取不到。管理员在控制台仍然可以看——**这次查看已经记进审计**。'
      : null,
    audit: { logged: true, action: restricted ? 'view_restricted_content' : 'view_content' },
  }
}

/** 会议抬头。契约的 `Meeting` 是给会议记录页的，这里只有标识与抬头。 */
function meetingBlock(m: Meeting, shiftSec: number): Record<string, unknown> {
  return {
    id: m.id,
    meetingId: m.id,
    subMeetingId: '',
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
  const common = {
    meeting: meetingBlock(m, shiftSec),
    access: accessBlock(m),
    // 恒为空数组：本系统从未拉取过章节数据，不编一份假的
    chapters: [],
    source: 'none',
    text: '本系统没有「章节」这一类数据（腾讯会议侧从来没有拉过），下面是从转写正文的时间戳切出来的分段。',
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
