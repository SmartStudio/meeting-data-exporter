/**
 * 内容预览页的两条端点（api-contracts §7 · 后端 `src/http/handlers/console/content.ts`）。
 *
 * ## 每调一次就是一行审计，所以这里没有缓存
 *
 * spec §2：**管理员查看会议内容会留痕**。后端在这两条端点上各写一行 `audit_log`
 * （`view_content` / `view_restricted_content`），而且**不 try/catch**——写不进去
 * 就整个请求失败，因为留痕是「被规则禁止采集的会议管理员仍然能看」这条豁免的对价。
 *
 * 于是这一层**刻意不做任何缓存/去重**：省下来的那一次请求，代价是审计流里少一条
 * 记录。而留痕的价值恰恰在于完整——尤其是那些被规则禁掉的会议，管理员看了就该
 * 有一条。`tests/api/content.test.ts` 有一条「调两次就要发两次」的测试盯着这件事。
 *
 * ## 章节没有来源，所以这里没有 `Chapter` 类型
 *
 * 阶段 4 · T16 的裁定：`GET .../content/chapters` 的 `chapters` **恒为空数组**、
 * `source: 'none'`——本系统一次都没拉取过腾讯的「章节」数据，不编一份假的。
 * 真正有内容的是 `cues`（**转写分段**，时间戳来自转写正文本身）。
 * 所以这里把 `chapters` 保留成 `unknown[]` 原样透出（它现在恒空，将来真有来源时
 * 是另一件事），把 `TranscriptCue` 明确命名成「转写分段」——**界面上不许拿 cues
 * 冒充章节**，那是在给一个我们没有的数据源伪造一次输出。
 *
 * ## 收窄的字段一律留 string（同 `grants.ts` 的口径）
 *
 * `availability` / `selected.state` / `cuesFrom.format` 都不收窄成联合类型：
 * 后端将来接新的纪要引擎会 emit 新的 `asset_type`，前端应当把它**原样显示出来**，
 * 而不是因为不在枚举里就崩掉或者悄悄折成「其他」。标签表（`AVAILABILITY_LABEL`
 * / `ASSET_LABEL`）因此都带一条「认不出就显示原值」的兜底。
 *
 * ## 类型定义在这里，不进 `api/types.ts`（计划 G-b）
 *
 * 这一组类型只有内容预览页一个消费者。跨页共享的 `AssetKey` / `Why` 已经在
 * `api/types.ts` 里了，从那里 import。
 */

import type { AssetKey, Why, WhyKind } from '../types'
import { apiGet } from '../client'
import { reader, type FieldReader } from '../validate'

/* ── 类型 ───────────────────────────────────────────────────────── */

/** 抬头要的那几列。契约的 `Meeting` 是给会议记录页的，这里只有标识与抬头。 */
export interface ContentMeeting {
  /** `consoleMeetingId` 编出来的串（周期性会议是 `会议id,场次id`），也是路由上的 `:id` */
  id: string
  meetingId: string
  subMeetingId: string
  title: string
  code: string
  /** unix 秒 */
  startAt: number
  /** 秒 */
  durationSec: number
  host: string
  /** 身份映射查出来的姓名。查不到是 null——别在这里回落成 `host`，见 `lib/host.ts` */
  hostName: string | null
  /** 元数据里没拉回来的列名。「标题是空的」与「元数据没拉回来」靠它区分 */
  missing: string[]
}

/**
 * 这次查看的判定与留痕。
 *
 * `restricted: true` = 这场会议按采集规则**禁止采集**，管理员是豁免看的——
 * 顶部必须挂琥珀警示条（spec §2），`banner` 是后端给的原话。
 * `audit.action` 是这次查看真正记进审计的那个动作名，界面上照抄，不要自己编。
 */
export interface ContentAccess {
  /** 'allow' | 'deny'，留 string 不收窄 */
  allow: string
  restricted: boolean
  why: Why
  banner: string | null
  audit: { logged: boolean; action: string }
}

/** 本地文件与 NAS 副本的去向。`text` 是后端写好的一句人话，前端不重写。 */
export interface ContentLocal {
  archived: boolean
  filesGone: boolean
  archivedAt: number | null
  purgedAt: number | null
  expiresAt: number | null
  nasDir: string | null
  text: string
}

/**
 * 资产索引里的一行。
 *
 * `availability` 六个取值**每一个都对应一件不同的事实**，只有 `missing` 才是
 * 「这场会议确实缺这一类」；其余五种都是可修复的缺口，显示成「没有」就是把一个
 * 可修复的缺口伪装成既成事实。`reason` 是后端逐条写好的理由，必须显示出来。
 */
export interface ContentAsset {
  assetType: string
  /** 认不出的 `asset_type`（将来的新引擎）为 null，此时显示 `assetType` 原值 */
  assetKey: AssetKey | null
  remoteId: string
  fileType: string
  availability: string
  /** NAS 副本字节数；只有 asset_contents 那一档给得出 */
  bytes: number | null
  /** 正文**字符数**，不是字节数 */
  chars: number | null
  reason: string | null
  contentHash: string | null
  parsedAt: number | null
  nasPath: string | null
}

/** 一段正文。同一类文本资产可以有多段（`remote_id` 区分），一段都不能漏。 */
export interface ContentSegment extends ContentAsset {
  ordinal: number
  /** `availability !== 'parsed'` 时恒为 null */
  content: string | null
}

/**
 * 选中的那一类内容。`state`：`ok`（有正文）/ `unparsed`（存在但没解析出正文，
 * **不等于缺失**）/ `absent`（确认缺失）。`text` 说清是哪一种，照原样显示。
 */
export interface SelectedContent {
  type: string
  assetKey: string
  state: string
  segments: ContentSegment[]
  text: string
}

/** 录像/音频只给去向，不给内容。 */
export interface MediaAsset {
  assetType: string
  assetKey: AssetKey | null
  remoteId: string
  fileType: string
  nasPath: string | null
  localPath: string | null
  archivedAt: number | null
  localGone: boolean
}

/**
 * `proxied` 恒为 false：录像与音频不入库、本接口也不代理内容（几个 GB 的文件，
 * 代理一份等于把网关当 CDN）。**控制台因此没有可播放的媒体源**，界面上要说清
 * 这件事并给出去向，不能画一个点了没反应的播放器。
 */
export interface MediaBlock {
  proxied: boolean
  text: string
  assets: MediaAsset[]
}

export interface ContentIndex {
  meeting: ContentMeeting
  access: ContentAccess
  local: ContentLocal
  assets: ContentAsset[]
  /** 没传 `type` 时为 null（只要索引） */
  selected: SelectedContent | null
  media: MediaBlock
}

/**
 * 转写分段。**不是章节**——时间戳来自转写正文本身的解析（`srt` / `bracket`），
 * 是真实数据，足够支撑「点一下跳转」。
 */
export interface TranscriptCue {
  /** 相对会议开始的秒数 */
  at: number
  /** 只有 SRT 那种带箭头的格式给得出，其余为 null */
  endAt: number | null
  /** 启发式认出来的发言人，认不出为 null */
  speaker: string | null
  text: string
}

/** 分段是从哪一段转写正文解析出来的，以及**有没有被 limit 截断**。 */
export interface CuesFrom {
  assetType: string
  assetKey: string
  remoteId: string
  fileType: string
  /** `srt` / `bracket` / `none`。`none` = 认不出格式，此时 `sample` 给前几行原文 */
  format: string
  total: number
  returned: number
  truncated: boolean
}

export interface ChaptersView {
  meeting: ContentMeeting
  access: ContentAccess
  /** **恒为空数组**（本系统从未拉取过章节数据）。留着原样透出，不当成"没数据" */
  chapters: unknown[]
  /** 恒为 `'none'` */
  source: string
  /** 后端写好的「为什么没有章节」，界面上要显示它 */
  text: string
  cues: TranscriptCue[]
  /** 一段转写都没有时为 null */
  cuesFrom: CuesFrom | null
  /** `format === 'none'` 时的前几行原文 */
  sample: string[] | null
}

/* ── 标签表 ─────────────────────────────────────────────────────── */

/**
 * 资产名。**逐字抄自后端的 `ASSET_LABEL`**（`handlers/console/content.ts`）——
 * 同一批资产已经有过三套叫法，M3.5 为此吃过一次亏，前端不再起第四套。
 */
export const ASSET_LABEL: Record<AssetKey, string> = {
  video: '录像',
  audio: '音频',
  transcript: '完整转写',
  ai_transcript: 'AI 转写',
  ai_minutes: 'AI 纪要',
  ai_topic_minutes: '话题纪要',
  ai_speaker_minutes: '发言人纪要',
  ai_ds_minutes: '会议摘要',
}

/**
 * 认不出的 `asset_type` 原样显示，不折成「其他」——那会把一个新引擎藏起来。
 *
 * `assetKey` 收 `string | null` 而不是 `AssetKey | null`：`selected.assetKey`
 * 在契约里就是一个字符串（后端接新引擎时会出现表里没有的取值），传进来查不到
 * 就退回 `assetType` 原值。
 */
export function assetLabel(assetKey: string | null, assetType: string): string {
  return (assetKey === null ? undefined : ASSET_LABEL[assetKey as AssetKey]) ?? assetType
}

/**
 * 六个 `availability` 各是一件不同的事实（后端文件头第二条）。
 * **只有 `missing` 是「这场会议确实缺这一类」**，其余五种都是可修复的缺口。
 */
export const AVAILABILITY_LABEL: Record<string, string> = {
  parsed: '正文在库',
  unsupported_format: '未解析（格式不支持）',
  too_large: '未解析（超出上限）',
  not_ingested: '已归档，正文未入库',
  not_archived: '本地已下载，未归档',
  missing: '确认取不到',
}

export function availabilityLabel(availability: string): string {
  return AVAILABILITY_LABEL[availability] ?? availability
}

/**
 * 纪要 tab 的模板切换（spec §4.4「这不是装饰性下拉——腾讯确实按不同模板生成
 * 多份纪要」）。
 *
 * **四项都对着真实的 `asset_type`**。原型里的第四项叫「待办清单」，而系统里
 * 没有任何一个资产类型装它（`ALL_ASSET_KEYS` 八项里的纪要类只有这四个），
 * 所以这里给的是 `ai_ds_minutes`（后端叫「会议摘要」）而不是原型那个名字——
 * 与「章节没有来源就不编章节」是同一条裁定：不提供一个我们没有来源的模板。
 */
export const MINUTES_TEMPLATES: ReadonlyArray<{ key: AssetKey; label: string }> = [
  { key: 'ai_minutes', label: ASSET_LABEL.ai_minutes },
  { key: 'ai_speaker_minutes', label: ASSET_LABEL.ai_speaker_minutes },
  { key: 'ai_topic_minutes', label: ASSET_LABEL.ai_topic_minutes },
  { key: 'ai_ds_minutes', label: ASSET_LABEL.ai_ds_minutes },
]

/** 转写文字 tab 取的那一类。`transcript` 在网关侧叫 `meeting_summary`，两套写法后端都认。 */
export const TRANSCRIPT_ASSET_KEY: AssetKey = 'transcript'

/** `?format=` 的三个取值。只有 txt 会被解析成正文（T4 裁定），另两个会如实报未解析。 */
export const FILE_TYPES: readonly string[] = ['txt', 'docx', 'pdf']

/** 时间轴一次要多少段。后端上限 5000，**超限是 400 不是静默钳制**，所以照着上限要。 */
export const CUES_LIMIT = 5000

/* ── 路径 ───────────────────────────────────────────────────────── */

const BASE = '/api/v1/admin'

/**
 * `:meetingId` 段是 `consoleMeetingId(meetingId, subMeetingId)` 编出来的串，
 * 周期性会议里带逗号，而会议 id 自身的逗号已经被编成 `%2C`。
 * **整段再编一次**：后端路由拿到参数会先 `decodeURIComponent` 一次再按逗号切，
 * 少编这一次，`m%2C1` 会被还原成 `m,1` 然后当成分隔符切错场次。
 */
function contentPath(id: string, suffix = ''): string {
  return `${BASE}/meetings/${encodeURIComponent(id)}/content${suffix}`
}

/* ── 校验 ───────────────────────────────────────────────────────── */

function readMeeting(r: FieldReader, raw: unknown, where: string): ContentMeeting {
  const o = r.object(raw, where)
  return {
    id: r.str(o, 'id', where),
    meetingId: r.str(o, 'meetingId', where),
    subMeetingId: r.str(o, 'subMeetingId', where),
    title: r.str(o, 'title', where),
    code: r.str(o, 'code', where),
    startAt: r.num(o, 'startAt', where),
    durationSec: r.num(o, 'durationSec', where),
    host: r.str(o, 'host', where),
    // 宽读：没下发这个字段就是「没查到姓名」，退到 lib/host.ts 的降级路径。
    // 为一个显示名让整页预览打不开不划算——同 api/admin/meetings.ts 的口径。
    hostName: typeof (o as Record<string, unknown>).hostName === 'string' ? String((o as Record<string, unknown>).hostName) : null,
    missing: r.strList(o, 'missing', where),
  }
}

function readAccess(r: FieldReader, raw: unknown, where: string): ContentAccess {
  const o = r.object(raw, where)
  const why = r.object(o.why, `${where}.why`)
  const audit = r.object(o.audit, `${where}.audit`)
  return {
    allow: r.str(o, 'allow', where),
    restricted: r.bool(o, 'restricted', where),
    // `by` 不收窄校验：它是 WhyKind 的取值，后端加一档时应当原样显示而不是抛
    why: { by: r.str(why, 'by', `${where}.why`) as WhyKind, text: r.str(why, 'text', `${where}.why`) },
    banner: r.strOrNull(o, 'banner', where),
    audit: {
      logged: r.bool(audit, 'logged', `${where}.audit`),
      action: r.str(audit, 'action', `${where}.audit`),
    },
  }
}

function readAsset(r: FieldReader, o: Record<string, unknown>, where: string): ContentAsset {
  return {
    assetType: r.str(o, 'assetType', where),
    assetKey: r.strOrNull(o, 'assetKey', where) as AssetKey | null,
    remoteId: r.str(o, 'remoteId', where),
    fileType: r.str(o, 'fileType', where),
    availability: r.str(o, 'availability', where),
    bytes: r.numOrNull(o, 'bytes', where),
    chars: r.numOrNull(o, 'chars', where),
    reason: r.strOrNull(o, 'reason', where),
    contentHash: r.strOrNull(o, 'contentHash', where),
    parsedAt: r.numOrNull(o, 'parsedAt', where),
    nasPath: r.strOrNull(o, 'nasPath', where),
  }
}

function readSelected(r: FieldReader, raw: Record<string, unknown> | null): SelectedContent | null {
  if (raw === null) return null
  const w = 'selected'
  return {
    type: r.str(raw, 'type', w),
    assetKey: r.str(raw, 'assetKey', w),
    state: r.str(raw, 'state', w),
    segments: r.objList(raw, 'segments', w).map((s, i) => ({
      ...readAsset(r, s, `${w}.segments[${i}]`),
      ordinal: r.num(s, 'ordinal', `${w}.segments[${i}]`),
      content: r.strOrNull(s, 'content', `${w}.segments[${i}]`),
    })),
    text: r.str(raw, 'text', w),
  }
}

function readIndex(endpoint: string, raw: unknown): ContentIndex {
  const r = reader(endpoint)
  const o = r.object(raw, '')
  const local = r.object(o.local, 'local')
  const media = r.object(o.media, 'media')
  return {
    meeting: readMeeting(r, o.meeting, 'meeting'),
    access: readAccess(r, o.access, 'access'),
    local: {
      archived: r.bool(local, 'archived', 'local'),
      filesGone: r.bool(local, 'filesGone', 'local'),
      archivedAt: r.numOrNull(local, 'archivedAt', 'local'),
      purgedAt: r.numOrNull(local, 'purgedAt', 'local'),
      expiresAt: r.numOrNull(local, 'expiresAt', 'local'),
      nasDir: r.strOrNull(local, 'nasDir', 'local'),
      text: r.str(local, 'text', 'local'),
    },
    assets: r.objList(o, 'assets', '').map((a, i) => readAsset(r, a, `assets[${i}]`)),
    selected: readSelected(r, r.objOrNull(o, 'selected', '')),
    media: {
      proxied: r.bool(media, 'proxied', 'media'),
      text: r.str(media, 'text', 'media'),
      assets: r.objList(media, 'assets', 'media').map((a, i) => {
        const w = `media.assets[${i}]`
        return {
          assetType: r.str(a, 'assetType', w),
          assetKey: r.strOrNull(a, 'assetKey', w) as AssetKey | null,
          remoteId: r.str(a, 'remoteId', w),
          fileType: r.str(a, 'fileType', w),
          nasPath: r.strOrNull(a, 'nasPath', w),
          localPath: r.strOrNull(a, 'localPath', w),
          archivedAt: r.numOrNull(a, 'archivedAt', w),
          localGone: r.bool(a, 'localGone', w),
        }
      }),
    },
  }
}

/* ── 三条端点 ────────────────────────────────────────────────────── */

/**
 * `GET /api/v1/admin/meetings/:meetingId/content`（不带 `type`）。
 *
 * 只要索引：八类资产的格式/体积/可得性、采集判定、本地与 NAS 去向、录像的去向。
 * `selected` 恒为 null——**不要顺手带上一个 `type` 去"顺便"把正文也取回来**，
 * 那会让每次进页面都多读一份可能有几 MB 的正文。
 */
export async function fetchContentIndex(id: string): Promise<ContentIndex> {
  const raw = await apiGet<unknown>(contentPath(id))
  return readIndex(`GET ${BASE}/meetings/:meetingId/content`, raw)
}

/**
 * `GET /api/v1/admin/meetings/:meetingId/content?type=…[&format=…]`。
 *
 * `format` 省略 = 不筛格式（把 txt / docx / pdf 各段一起拿回来）。
 * 传空串是一次真实取值，不是"不筛选"，所以这里只在给了非空值时才发这个键。
 */
export async function fetchContentSelection(
  id: string,
  opts: { type: string; format?: string },
): Promise<ContentIndex> {
  const query =
    opts.format === undefined || opts.format === ''
      ? `?type=${encodeURIComponent(opts.type)}`
      : `?type=${encodeURIComponent(opts.type)}&format=${encodeURIComponent(opts.format)}`
  const raw = await apiGet<unknown>(`${contentPath(id)}${query}`)
  return readIndex(`GET ${BASE}/meetings/:meetingId/content`, raw)
}

/**
 * `GET /api/v1/admin/meetings/:meetingId/content/chapters`。
 *
 * 名字叫 chapters，给的却是 `cues`——见文件头第二条。`limit` 超出 1..5000 时后端
 * 回 400（**不静默钳制**：客户端以为要到了 20000 段、实际只拿到 5000 段，后半截
 * 转写会在时间轴上凭空消失，而界面上一切正常）。
 */
export async function fetchChapters(
  id: string,
  opts: { limit?: number } = {},
): Promise<ChaptersView> {
  const query = opts.limit === undefined ? '' : `?limit=${encodeURIComponent(String(opts.limit))}`
  const endpoint = `GET ${BASE}/meetings/:meetingId/content/chapters`
  const raw = await apiGet<unknown>(`${contentPath(id, '/chapters')}${query}`)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  const from = r.objOrNull(o, 'cuesFrom', '')
  return {
    meeting: readMeeting(r, o.meeting, 'meeting'),
    access: readAccess(r, o.access, 'access'),
    chapters: r.array(o.chapters, 'chapters'),
    source: r.str(o, 'source', ''),
    text: r.str(o, 'text', ''),
    cues: r.objList(o, 'cues', '').map((c, i) => ({
      at: r.num(c, 'at', `cues[${i}]`),
      endAt: r.numOrNull(c, 'endAt', `cues[${i}]`),
      speaker: r.strOrNull(c, 'speaker', `cues[${i}]`),
      text: r.str(c, 'text', `cues[${i}]`),
    })),
    cuesFrom:
      from === null
        ? null
        : {
            assetType: r.str(from, 'assetType', 'cuesFrom'),
            assetKey: r.str(from, 'assetKey', 'cuesFrom'),
            remoteId: r.str(from, 'remoteId', 'cuesFrom'),
            fileType: r.str(from, 'fileType', 'cuesFrom'),
            format: r.str(from, 'format', 'cuesFrom'),
            total: r.num(from, 'total', 'cuesFrom'),
            returned: r.num(from, 'returned', 'cuesFrom'),
            truncated: r.bool(from, 'truncated', 'cuesFrom'),
          },
    sample: r.strListOrNull(o, 'sample', ''),
  }
}

/**
 * 「已授权给谁」——`GET /api/v1/admin/meetings/:meetingId` 的 `grants` 一列。
 *
 * ## 为什么这条窄读在这个文件里
 *
 * spec §4.4 点名右下角要显示「已授权给谁」，而内容那两条端点不下发它。会议单场
 * 端点的完整建模归会议记录页（F2 的 `api/admin/meetings.ts`），本任务不碰那个
 * 文件——两个并行任务往同一个文件里落笔，正是 F0 存在的理由。
 *
 * 所以这里只做一件很窄的事：**从那条端点里读出一列**，别的字段一个都不碰
 * （与地基的 `api/admin/health.ts` 同一个处置）。不要把它当成那条端点的建模，
 * 它不是；F2 建好完整版之后，这里也不必改——多读一次 `grants` 不影响任何东西。
 */
export async function fetchMeetingGrantIds(id: string): Promise<string[]> {
  const endpoint = `GET ${BASE}/meetings/:meetingId`
  const raw = await apiGet<unknown>(`${BASE}/meetings/${encodeURIComponent(id)}`)
  const r = reader(endpoint)
  return r.strList(r.object(raw, ''), 'grants', '')
}
