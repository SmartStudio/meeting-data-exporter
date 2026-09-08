/**
 * T10 · A6 内容读取 API 的测试。
 *
 * 分两段，理由与 `tests/http/console-audit.test.ts` 逐字相同——这个 handler 有两类
 * 风险，用同一种手法测其中一类必然测不到另一类：
 *
 * 1. **`createContentLookup` 的 SQL** 走真实测试库。这一层的全部价值在 SQL 语义里：
 *    `asset_contents` 的主键是**五段**，同一场会议的同一类文本资产可以有多段
 *    （引擎为此留了 `transcript_2.txt` 的序号消歧）。按四段查会漏掉第二段，而漏掉的
 *    表现是「预览页显示的是最后归档的那一段，没有任何痕迹说明还有另一段」——
 *    mock 掉这层等于把这条唯一真正危险的东西测没了。
 * 2. **handler 自身的胶水**（留痕、琥珀标记、未解析 vs 查无此物、本地已清理仍可读、
 *    录像不代理）用假依赖直接调 handler。这样才能断言「写进 audit_log 的那一行长什么样」
 *    ——连真库跑一遍只能看到「返回了 200」，看不出留痕到底记没记。
 *
 * 判定本身（`explainMeetingAccess`）走**真实**的 `policy/stacks.ts` + `policy/override.ts`,
 * 与 `tests/http/console-meetings.test.ts` 同一条约定：那正是「管理员查看被规则禁止采集
 * 的会议要留痕」这条验收要钉的东西，打桩掉就等于把它测没了。
 */
import { expect, test } from 'bun:test'
import {
  createContentLookup,
  getContent,
  getChapters,
  parseTranscriptCues,
  type ContentLookup,
} from '../../src/http/handlers/console/content'
import { consoleMeetingId, type ConsoleMeetingRow, type ConsoleMeetingsStore, type Triage } from '../../src/store/console-meetings'
import type { AuditEntry } from '../../src/store/audit'
import type { VisibilityDeps } from '../../src/worker/visibility'
import type { ArchivedAssetRecord, CompletedAssetRow, MeetingArchiveRecord, MissingAssetRow } from '../../src/store/archives'
import type { MeetingOverride } from '../../src/store/grants'
import type { StackRule } from '../../src/policy/stacks'
import type { Meeting } from '../../src/domain/types'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AppDeps, RouteCtx } from '../../src/http/router'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'
import { createApp } from '../../src/http/router'
import { withTestDb } from '../helpers/testdb'
import type { Pool } from '../../src/store/db'

const NOW = 1_700_100_000
const START = 1_700_000_000
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }
const KEY = { meetingId: 'm-1', subMeetingId: '' }
const ROW_ID = consoleMeetingId(KEY.meetingId, KEY.subMeetingId)

// ===========================================================================
// 第一段 · createContentLookup 的 SQL（真实测试库）
// ===========================================================================

async function seedContent(
  pool: Pool,
  input: {
    meetingId?: string
    subMeetingId?: string
    assetType?: string
    remoteId?: string
    fileType?: string
    status?: 'parsed' | 'unsupported_format' | 'too_large'
    content?: string | null
    reason?: string | null
    bytes?: number
  },
): Promise<void> {
  const {
    meetingId = KEY.meetingId,
    subMeetingId = '',
    assetType = 'meeting_summary',
    remoteId = 'r-1',
    fileType = 'txt',
    status = 'parsed',
    content = '正文',
    reason = null,
    bytes = 6,
  } = input
  await pool.execute(
    `INSERT INTO asset_contents
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type,
        status, content, content_hash, bytes, reason, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meetingId, subMeetingId, assetType, remoteId, fileType,
      status,
      status === 'parsed' ? content : null,
      status === 'parsed' ? 'c'.repeat(64) : null,
      bytes,
      status === 'parsed' ? null : (reason ?? '未解析'),
      NOW - 500,
    ],
  )
}

async function withLookup(fn: (rig: { pool: Pool; lookup: ContentLookup }) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try {
    await fn({ pool, lookup: createContentLookup(pool) })
  } finally {
    await cleanup()
  }
}

test('listSegments 按三段查，同一 asset_type 的多段（remote_id 不同）一段都不漏', async () => {
  await withLookup(async ({ pool, lookup }) => {
    // 引擎的 assetKeyToFilename 为这种情况留了 transcript_2.txt 的序号消歧，
    // 说明「同一场会议同一类文本资产有多段」是真实存在的形状（见 007 的表头）
    await seedContent(pool, { remoteId: 'r-1', content: '第一段转写' })
    await seedContent(pool, { remoteId: 'r-2', content: '第二段转写' })

    const segs = await lookup.listSegments(KEY.meetingId, '', 'meeting_summary')
    expect(segs.map((s) => s.remoteId)).toEqual(['r-1', 'r-2'])
    expect(segs.map((s) => s.content)).toEqual(['第一段转写', '第二段转写'])
  })
})

test('listSegments 不跨会议、不跨场次、不跨 asset_type', async () => {
  await withLookup(async ({ pool, lookup }) => {
    await seedContent(pool, { content: '本场' })
    await seedContent(pool, { meetingId: 'm-2', content: '别的会议' })
    await seedContent(pool, { subMeetingId: 'sub-9', content: '别的场次' })
    await seedContent(pool, { assetType: 'ai_minutes', content: '别的类型' })

    const segs = await lookup.listSegments(KEY.meetingId, '', 'meeting_summary')
    expect(segs.map((s) => s.content)).toEqual(['本场'])
  })
})

test('listSegments 的 fileType 过滤只在显式传入时生效（同一段的 txt / docx 是两行）', async () => {
  await withLookup(async ({ pool, lookup }) => {
    await seedContent(pool, { fileType: 'txt', content: '纯文本' })
    await seedContent(pool, { fileType: 'docx', status: 'unsupported_format', reason: '不解析 docx' })

    expect((await lookup.listSegments(KEY.meetingId, '', 'meeting_summary')).length).toBe(2)
    const txt = await lookup.listSegments(KEY.meetingId, '', 'meeting_summary', 'txt')
    expect(txt.map((s) => s.fileType)).toEqual(['txt'])
  })
})

test('listForMeeting 不取正文，但给得出字符数与未解析的原因', async () => {
  await withLookup(async ({ pool, lookup }) => {
    await seedContent(pool, { content: '一二三四五', bytes: 15 })
    await seedContent(pool, {
      assetType: 'ai_minutes', fileType: 'docx', status: 'unsupported_format',
      reason: 'file_type=docx 不是纯文本', bytes: 240_000,
    })

    const rows = await lookup.listForMeeting(KEY.meetingId, '')
    expect(rows.length).toBe(2)
    const summary = rows.find((r) => r.assetType === 'meeting_summary')!
    // chars 是字符数、bytes 是字节数——中文两者不同，混用会让「这份纪要多长」显示成三倍
    expect(summary.chars).toBe(5)
    expect(summary.bytes).toBe(15)
    expect(summary).not.toHaveProperty('content')

    const minutes = rows.find((r) => r.assetType === 'ai_minutes')!
    expect(minutes.status).toBe('unsupported_format')
    expect(minutes.chars).toBeNull()
    expect(minutes.reason).toContain('docx')
  })
})

// ===========================================================================
// 第二段 · handler（假依赖）
// ===========================================================================

function row(over: Partial<ConsoleMeetingRow> = {}): ConsoleMeetingRow {
  return {
    id: ROW_ID,
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    title: '产品周会',
    code: '881-123-40',
    startAt: START,
    durationSec: 3600,
    host: 'zouyanjian',
    hostName: null,
    missing: [],
    assets: { ai_minutes: { got: 1, total: 1 } },
    unknownAssetTypes: [],
    fetch: 'done',
    archive: 'done',
    grants: [],
    hand: [],
    keep: {
      archivedAt: START + 7200,
      expiresAt: START + 7200 + 30 * 86400,
      extended: 0,
      extendedSource: 'none',
      extendedDays: 0,
      retentionDays: 30,
      filesGone: false,
    },
    nasPath: '/nas/meetings/2023/11/88112340-产品周会/',
    sizeBytes: 23_907_140,
    ...over,
  }
}

function meta(over: Partial<Meeting> = {}): Meeting {
  return {
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    meetingRecordId: '',
    meetingCode: '881-123-40',
    subject: '产品周会',
    hostUserId: 'zouyanjian',
    startTime: START,
    endTime: START + 3600,
    state: 'completed',
    ...over,
  }
}

function allowRule(over: Partial<StackRule> = {}): StackRule {
  return {
    id: 100,
    kind: 'allow',
    priority: 10,
    enabled: true,
    join: 'and',
    conds: [],
    effect: 'allow',
    assetTypes: ['*'],
    subjectType: 'program',
    subjectValue: 'kb-indexer',
    note: '知识库可以采集全部会议',
    ...over,
  }
}

function archiveRecord(over: Partial<MeetingArchiveRecord> = {}): MeetingArchiveRecord {
  return {
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    nasDir: '/nas/meetings/2023/11/88112340-产品周会/',
    archivedAt: START + 7200,
    retentionDays: 30,
    extendedDays: 0,
    localPurgedAt: null,
    ...over,
  }
}

function archivedAsset(over: Partial<ArchivedAssetRecord> = {}): ArchivedAssetRecord {
  return {
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    assetType: 'meeting_summary',
    remoteId: 'r-1',
    fileType: 'txt',
    localPath: 'local/transcript.txt',
    nasPath: '/nas/meetings/2023/11/88112340-产品周会/transcript.txt',
    nasHash: 'a'.repeat(64),
    archivedAt: START + 7200,
    ...over,
  }
}

function contentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    assetType: 'meeting_summary',
    remoteId: 'r-1',
    fileType: 'txt',
    status: 'parsed',
    bytes: 12,
    reason: null,
    contentHash: 'c'.repeat(64),
    parsedAt: NOW - 500,
    chars: 4,
    ...over,
  }
}

interface Scenario {
  single?: ConsoleMeetingRow | null
  allowRules?: StackRule[]
  overrides?: MeetingOverride[]
  metas?: Meeting[]
  archive?: MeetingArchiveRecord | null
  archivedAssets?: ArchivedAssetRecord[]
  completed?: CompletedAssetRow[]
  missing?: MissingAssetRow[]
  index?: Record<string, unknown>[]
  segments?: Record<string, unknown>[]
}

interface Harness {
  ctx: RouteCtx
  audits: AuditEntry[]
  segmentCalls: Array<{ assetType: string; fileType: string | undefined }>
}

function harness(s: Scenario = {}, params: Record<string, string> = { meetingId: ROW_ID }): Harness {
  const audits: AuditEntry[] = []
  const segmentCalls: Array<{ assetType: string; fileType: string | undefined }> = []
  const metas = s.metas ?? [meta()]

  const store: ConsoleMeetingsStore = {
    async list() { return { rows: [], total: 0 } },
    async triage() {
      return { archiveFailed: 0, expiringIn7d: 0, awaitingGrant: 0, inProgress: 0, nasOnly: 0 } as Triage
    },
    async get() { return s.single === undefined ? row() : s.single },
    async getMeetings(keys) {
      const wanted = new Set(keys.map((k) => `${k.meetingId} ${k.subMeetingId}`))
      return metas.filter((m) => wanted.has(`${m.meetingId} ${m.subMeetingId}`))
    },
  }

  const visibility: VisibilityDeps = {
    policy: {
      async listEnabledStackRules(kind) {
        return kind === 'allow' ? (s.allowRules ?? [allowRule()]) : []
      },
    },
    grants: {
      async listActiveGrantsForProgram() { return [] },
      async findActiveGrant() { return null },
      async listActiveOverridesForMeetings() { return s.overrides ?? [] },
    },
    archives: {
      async listMeetingArchives() { return s.archive == null ? [] : [s.archive] },
      async listMeetingsWithCompletedAssets() { return new Set<string>() },
    },
    getMeetings: (keys) => store.getMeetings(keys),
  }

  const contents = {
    async listForMeeting() { return s.index ?? [] },
    async listSegments(_m: string, _sub: string, assetType: string, fileType?: string) {
      segmentCalls.push({ assetType, fileType })
      return (s.segments ?? []).filter((seg) => seg.assetType === assetType)
    },
  }

  const deps = {
    now: () => NOW,
    adminAuth: { async verifySession() { return ADMIN } } as unknown as AdminAuth,
    consoleMeetings: store,
    meetingVisibility: visibility,
    contents,
    archivesStore: {
      async findMeetingArchive() { return s.archive ?? null },
      async listArchivedAssetsForMeeting() { return s.archivedAssets ?? [] },
      async listCompletedAssets() { return s.completed ?? [] },
      async listMissingAssets() { return s.missing ?? [] },
    },
    auditStore: {
      async record(e: AuditEntry) { audits.push(e) },
    },
  } as unknown as AppDeps

  return { ctx: { params, deps }, audits, segmentCalls }
}

function req(query = '', cookie = true): Request {
  const headers = new Headers()
  if (cookie) headers.set('cookie', `${ADMIN_SESSION_COOKIE}=token-1`)
  return new Request(`https://gw.example/api/v1/admin/meetings/${ROW_ID}/content${query}`, { headers })
}

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

// ── 认证 ──────────────────────────────────────────────────────────────────

test('两个端点在没有管理员会话时一律 401，且一条审计都不写', async () => {
  const h = harness()
  for (const handler of [getContent, getChapters]) {
    const res = await handler(req('', false), h.ctx)
    expect(res.status).toBe(401)
  }
  expect(h.audits).toEqual([])
})

test('会议查不到时 404', async () => {
  const h = harness({ single: null })
  expect((await getContent(req(), h.ctx)).status).toBe(404)
})

// ── 验收 1：被规则禁止采集要留痕 + 琥珀标记 ──────────────────────────────

test('准许采集的会议：restricted 为 false，留痕记 view_content', async () => {
  const h = harness({ allowRules: [allowRule()] })
  const res = await getContent(req(), h.ctx)
  expect(res.status).toBe(200)
  const b = await body(res)

  expect(b.access.allow).toBe('allow')
  expect(b.access.restricted).toBe(false)
  expect(b.access.banner).toBeNull()

  expect(h.audits.length).toBe(1)
  expect(h.audits[0]!.action).toBe('view_content')
  expect(h.audits[0]!.actorType).toBe('admin')
  expect(h.audits[0]!.actorId).toBe('admin-1')
  expect(h.audits[0]!.meetingId).toBe(KEY.meetingId)
  // 查看成功了就是 allow：管理员这次查看**是被准许的**（豁免），
  // 记成 deny 等于宣称一次没发生过的拒绝
  expect(h.audits[0]!.decision).toBe('allow')
})

test('被规则禁止采集的会议：仍然 200 能看，但 restricted=true、banner 非空、留痕换成 view_restricted_content', async () => {
  // 一条明确 deny 的规则：管理员要判断这条规则拦对了没有，所以他仍然能看（spec §2）
  const h = harness({
    allowRules: [allowRule({ effect: 'deny', note: '财务会议一律不外发' })],
    index: [contentRow()],
    segments: [contentRow({ content: '第一季度财务复盘' })],
  })
  const res = await getContent(req('?type=transcript'), h.ctx)
  expect(res.status).toBe(200)
  const b = await body(res)

  expect(b.access.allow).toBe('deny')
  expect(b.access.restricted).toBe(true)
  expect(typeof b.access.banner).toBe('string')
  expect(b.access.banner.length).toBeGreaterThan(0)
  // 判定理由要对得回一条真跑过的规则，不是一句「不允许」
  expect(b.access.why.text).toContain('财务会议一律不外发')
  // 正文照给——「管理员仍然能看」是 spec §2 明写的豁免
  expect(b.selected.segments[0].content).toBe('第一季度财务复盘')

  expect(h.audits.length).toBe(1)
  expect(h.audits[0]!.action).toBe('view_restricted_content')
  // 是哪条规则拦的要落进审计，否则事后查不出「他看的是被哪条规则禁掉的会议」
  expect(h.audits[0]!.matchedRuleId).toBe(100)
})

/**
 * 界面文案里不许出现内部标识与规格引用（2026-08-31）。
 *
 * 这三个字段（`access.banner` / `local.text` / `media.text`）会被控制台**逐字上屏**,
 * 所以它们是给管理员写的，不是给读代码的人写的。上一版三段全都不是：
 *
 * - banner：`（spec §2）`、`（动作 view_restricted_content）`，外加一整句
 *   「留痕就是…的对价，不是可选项」——那是在跟一个想删掉这行审计的开发者辩论。
 * - local.text：`（spec §4.9）`，以及把同一格行值里的「本地文件还在」和下一行的
 *   NAS 路径又各说了一遍。
 * - media.text：`` `asset_contents` 是文本表 ``、`GET .../media/:assetType/...`,
 *   四句话全在讲这条 API 为什么长这样。
 *
 * spec §1.4 已经为同一类错误定过案（右下角那块「刻意不做」的问答框），原话是
 * 「拿管理员的注意力去养一条产品笔记」。这一条更深一层，养的是架构决策笔记。
 *
 * 钉的是**规则**不是措辞：将来怎么改文案都行，规格章节号、`snake_case` 的机器名、
 * 端点模板、反引号里的代码标识，一个都不许再上屏。
 */
test('上屏的三段文案里没有规格引用 / 机器名 / 端点模板 / 反引号代码', async () => {
  const forbidden: Array<[RegExp, string]> = [
    [/spec\s*§/, '规格章节号——管理员手里没有 spec'],
    [/view_(restricted_)?content|asset_contents|local_purged_at/, '机器名，它的位置是 title 或审计流'],
    [/`[^`]+`/, '反引号里的代码标识'],
    [/GET\s|\/:\w+/, 'HTTP 端点模板'],
  ]
  const check = (label: string, text: string | null): void => {
    if (text === null) return
    for (const [re, why] of forbidden) {
      expect(re.test(text), `${label} 里出现了${why}：${text}`).toBe(false)
    }
  }

  // 三种保留状态各来一次：文案是按状态分支写的，只测一条会漏掉另外两条
  const deny = await body(
    await getContent(req(), harness({ allowRules: [allowRule({ effect: 'deny' })] }).ctx),
  )
  check('banner', deny.access.banner)
  check('local.text', deny.local.text)
  check('media.text', deny.media.text)

  const purged = await body(
    await getContent(
      req(),
      harness({
        archive: archiveRecord({ localPurgedAt: 1700300000 }),
        archivedAssets: [archivedAsset({ assetType: 'video', fileType: 'mp4', remoteId: 'v-1' })],
      }).ctx,
    ),
  )
  check('local.text（已清理）', purged.local.text)
  check('media.text（已清理）', purged.media.text)

  const fresh = await body(await getContent(req(), harness({ archive: null }).ctx))
  check('local.text（未归档）', fresh.local.text)

  // 时间轴那段话按「有没有章节」分两条，同样上屏，同样受这条规则管
  const noChapters = await body(await getChapters(req(), harness().ctx))
  check('chapters.text（没有章节）', noChapters.text)
  const hasChapters = await body(
    await getChapters(
      req(),
      harness({ segments: [chaptersRow({ content: chaptersJson([{ chapterId: 'C1', name: '开场', startMs: 0 }]) })] }).ctx,
    ),
  )
  check('chapters.text（有章节）', hasChapters.text)
})

test('留痕失败时不返回正文：审计写不进去就没有「豁免的对价」，整个请求失败', async () => {
  const h = harness({ allowRules: [allowRule({ effect: 'deny' })] })
  ;(h.ctx.deps as unknown as { auditStore: { record: () => Promise<void> } }).auditStore = {
    record: async () => { throw new Error('audit_log 写不进去') },
  }
  await expect(getContent(req(), h.ctx)).rejects.toThrow('audit_log 写不进去')
})

test('周期性会议的场次落进审计的 assetId 列（audit_log 没有 sub_meeting_id 列）', async () => {
  const subKey = { meetingId: 'm-1', subMeetingId: 'sub-3' }
  const h = harness(
    { single: row({ ...subKey, id: consoleMeetingId(subKey.meetingId, subKey.subMeetingId) }), metas: [meta(subKey)] },
    { meetingId: consoleMeetingId(subKey.meetingId, subKey.subMeetingId) },
  )
  await getContent(req(), h.ctx)
  expect(h.audits[0]!.assetId).toBe('sub:sub-3')
})

// ── 验收 2：本地已清理照样能读正文 ───────────────────────────────────────

test('本地已清理：正文照样返回，且响应说明本地文件已不在、录像要去 NAS 取', async () => {
  const purgedAt = START + 7200 + 31 * 86400
  const h = harness({
    single: row({ keep: { ...row().keep, filesGone: true } }),
    archive: archiveRecord({ localPurgedAt: purgedAt }),
    archivedAssets: [archivedAsset(), archivedAsset({ assetType: 'video', fileType: 'mp4', remoteId: 'v-1', nasPath: '/nas/…/video.mp4' })],
    index: [contentRow()],
    segments: [contentRow({ content: '纪要正文还在库里' })],
  })
  const b = await body(await getContent(req('?type=transcript'), h.ctx))

  // 这正是 E-f 选「入库」而不是「预览时现解析」的理由：文件没了，记录还在
  expect(b.selected.segments[0].content).toBe('纪要正文还在库里')
  expect(b.local.filesGone).toBe(true)
  expect(b.local.purgedAt).toBe(purgedAt)
  expect(b.local.nasDir).toBe('/nas/meetings/2023/11/88112340-产品周会/')
  expect(b.local.text).toContain('NAS')
  // 录像不入库，本地又清理了——只能去 NAS 取，这句话必须说出来
  expect(b.media.text).toContain('NAS')
  expect(b.media.assets.some((a: Record<string, unknown>) => a.assetKey === 'video' && a.localGone === true)).toBe(true)
})

// ── 验收 3：录像走直链，不代理内容 ───────────────────────────────────────

test('?type=video 直接 400，不代理二进制资产的内容', async () => {
  const h = harness()
  const res = await getContent(req('?type=video'), h.ctx)
  expect(res.status).toBe(400)
  const b = await body(res)
  expect(b.error).toBe('binary_asset_not_proxied')
  expect(b.detail).toContain('直链')
})

test('media 块只给去向（NAS 路径 + 播放端点），没有任何正文字段', async () => {
  const h = harness({
    archivedAssets: [archivedAsset({ assetType: 'video', fileType: 'mp4', remoteId: 'v-1', nasPath: '/nas/x/video.mp4' })],
  })
  const b = await body(await getContent(req(), h.ctx))
  // `proxied` 说的是**这条端点**下不下发媒体字节，2026-08-30 新开的
  // `GET .../media/...` 是另一条端点，不改变这一条的事实
  expect(b.media.proxied).toBe(false)
  expect(b.media.assets.length).toBe(1)
  expect(b.media.assets[0]).not.toHaveProperty('content')
  expect(b.media.assets[0].nasPath).toBe('/nas/x/video.mp4')
  /*
   * `media.text` 在保留期内是**空串**（2026-08-31）。
   *
   * 它上一版是四句「这条 API 为什么不下发媒体字节」——`asset_contents` 是文本表、
   * 单个几个 GB、播放走哪条端点、带 Range 所以能拖动。那四句占了预览页右栏面板的
   * 整个底部，而管理员拿不走任何一句去做事：屏幕上早有更短的版本（录像那一组行尾
   * 的「不入库，只给去向」、每个 mp4 自己的 NAS 路径、以及左边正在播的播放器）。
   *
   * 这条断言换成钉**事实**而不是钉那句话：不管文案怎么写，都不许再出现
   * `download-url`。那是 2026-08-30 之前的谎——那条端点走采集程序的 JWT，管理员
   * 会话签不出来，本地文件按 §4.10 清理之后平台那份也早就没了。
   */
  expect(b.media.text).toBe('')
  expect(JSON.stringify(b.media)).not.toContain('download-url')
})

// ── 只有 txt 入了库：未解析 ≠ 查无此物 ───────────────────────────────────

test('docx 只有一行「未解析」：selected.state 是 unparsed，不是 absent，且带得出原因', async () => {
  const h = harness({
    index: [contentRow({ fileType: 'docx', status: 'unsupported_format', content: null, chars: null, reason: 'file_type=docx 不是纯文本，本版本只解析 txt' })],
    segments: [contentRow({ fileType: 'docx', status: 'unsupported_format', content: null, chars: null, reason: 'file_type=docx 不是纯文本，本版本只解析 txt' })],
  })
  const b = await body(await getContent(req('?type=transcript'), h.ctx))
  expect(b.selected.state).toBe('unparsed')
  expect(b.selected.segments[0].reason).toContain('docx')
  expect(b.selected.text).not.toContain('没有')
})

test('这场会议压根没有这一类资产：state 是 absent，与 unparsed 是两句不同的话', async () => {
  const h = harness({ index: [], segments: [] })
  const b = await body(await getContent(req('?type=ai_minutes'), h.ctx))
  expect(b.selected.state).toBe('absent')
  expect(b.selected.segments).toEqual([])
  expect(b.selected.text).not.toBe((await body(await getContent(req('?type=transcript'), harness({
    index: [contentRow({ fileType: 'docx', status: 'unsupported_format' })],
    segments: [contentRow({ fileType: 'docx', status: 'unsupported_format' })],
  }).ctx))).selected.text)
})

test('已归档但 asset_contents 里没有行：报 not_ingested，不报「没有纪要」', async () => {
  const h = harness({
    archivedAssets: [archivedAsset({ assetType: 'ai_minutes', remoteId: 'x-1' })],
    index: [],
  })
  const b = await body(await getContent(req(), h.ctx))
  const entry = b.assets.find((a: Record<string, unknown>) => a.assetType === 'ai_minutes')
  expect(entry).toBeDefined()
  expect(entry.availability).toBe('not_ingested')
  expect(entry.reason).toContain('回填')
})

test('确认取不到的资产（skipped / dead）单列一档 missing，与「有但没解析」分得开', async () => {
  const h = harness({
    missing: [{
      meetingId: KEY.meetingId, subMeetingId: '', assetType: 'ai_minutes', remoteId: 'x-1',
      fileType: 'txt', status: 'dead', lastError: '重试用尽',
    }],
  })
  const b = await body(await getContent(req(), h.ctx))
  const entry = b.assets.find((a: Record<string, unknown>) => a.assetType === 'ai_minutes')
  expect(entry.availability).toBe('missing')
  expect(entry.reason).toContain('重试用尽')
})

// ── 参数 ──────────────────────────────────────────────────────────────────

test('type 同时认 AssetKey 与网关 asset_type（transcript / meeting_summary 是同一件事）', async () => {
  const h = harness({ segments: [contentRow({ content: '转写' })] })
  await getContent(req('?type=transcript'), h.ctx)
  await getContent(req('?type=meeting_summary'), h.ctx)
  expect(h.segmentCalls.map((c) => c.assetType)).toEqual(['meeting_summary', 'meeting_summary'])
})

test('listSegments 拿到的是三段键，remoteId 一律不参与筛选（多段一段都不能漏）', async () => {
  const h = harness({ segments: [contentRow(), contentRow({ remoteId: 'r-2' })] })
  await getContent(req('?type=transcript&format=txt'), h.ctx)
  expect(h.segmentCalls[0]).toEqual({ assetType: 'meeting_summary', fileType: 'txt' })
})

test('认不出的 type 一律 400，不悄悄退回索引', async () => {
  const h = harness()
  const res = await getContent(req('?type=summary'), h.ctx)
  expect(res.status).toBe(400)
  expect((await body(res)).error).toBe('invalid_asset_type')
})

// ── 章节 ──────────────────────────────────────────────────────────────────

/** `src/tencent/smart.ts` 的 serializeChapters 写进 chapters.json 的形状 */
function chaptersJson(chapters: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, recordFileId: 'rf-1', chapters }, null, 2) + '\n'
}

function chaptersRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return contentRow({ assetType: 'chapters', remoteId: 'rf-1', fileType: 'json', ...over })
}

test('章节：库里没有 chapters 类正文时 chapters 为空、source 报 none，并说清为什么', async () => {
  const h = harness()
  const b = await body(await getChapters(req(), h.ctx))
  expect(b.chapters).toEqual([])
  expect(b.source).toBe('none')
  expect(b.text.length).toBeGreaterThan(0)
})

test('章节：库里有 chapters 类正文时解析成章节，source=tencent，按起点升序', async () => {
  const h = harness({
    segments: [
      chaptersRow({
        content: chaptersJson([
          { chapterId: 'C2', name: '第二段', startMs: 120500 },
          { chapterId: 'C1', name: '开场', startMs: 7837 },
        ]),
      }),
    ],
  })
  const b = await body(await getChapters(req(), h.ctx))
  expect(b.source).toBe('tencent')
  // at 是秒、向下取整：120500ms 落在第 120 秒，7837ms 落在第 7 秒
  expect(b.chapters).toEqual([
    { id: 'C1', name: '开场', at: 7 },
    { id: 'C2', name: '第二段', at: 120 },
  ])
})

test('章节：正文不是合法 JSON 时 chapters 为空、source=none，不抛也不 500', async () => {
  const h = harness({ segments: [chaptersRow({ content: '{not json' })] })
  const res = await getChapters(req(), h.ctx)
  expect(res.status).toBe(200)
  const b = await body(res)
  expect(b.chapters).toEqual([])
  expect(b.source).toBe('none')
})

test('章节：没解析的行与缺 chapterId / startMs 的条目一律跳过，不上屏半条章节', async () => {
  const h = harness({
    segments: [
      // status 不是 parsed 的行没有正文可读，跳过
      chaptersRow({ remoteId: 'rf-0', status: 'unsupported_format', content: null, reason: '不是合法 UTF-8' }),
      chaptersRow({
        content: chaptersJson([
          { name: '没有 id', startMs: 1000 },
          { chapterId: 'C9', name: '没有起点' },
          { chapterId: 'C3', startMs: 3000 },
        ]),
      }),
    ],
  })
  const b = await body(await getChapters(req(), h.ctx))
  // 只剩下 id 与 startMs 都齐的那一条；name 缺失退成空串，不是丢掉整条
  expect(b.chapters).toEqual([{ id: 'C3', name: '', at: 3 }])
  expect(b.source).toBe('tencent')
})

test('章节：转写正文里的时间戳被解析成 cues，供「点一下跳转」用（明确标为转写分段，不是章节）', async () => {
  const transcript = [
    '00:00:05 张三：今天讨论三件事',
    '00:01:20 李四：第二件事我来说',
  ].join('\n')
  const h = harness({ segments: [contentRow({ content: transcript })] })
  const b = await body(await getChapters(req(), h.ctx))
  expect(b.cues.length).toBe(2)
  expect(b.cues[0].at).toBe(5)
  expect(b.cues[0].speaker).toBe('张三')
  expect(b.cues[1].at).toBe(80)
  expect(b.cuesFrom.format).toBe('bracket')
})

test('章节：转写格式认不出时给 sample，而不是一个说不出为什么的空时间轴', async () => {
  const h = harness({ segments: [contentRow({ content: '这是一段没有任何时间戳的纪要\n第二行' })] })
  const b = await body(await getChapters(req(), h.ctx))
  expect(b.cues).toEqual([])
  expect(b.cuesFrom.format).toBe('none')
  expect(b.sample).toEqual(['这是一段没有任何时间戳的纪要', '第二行'])
})

test('章节端点同样留痕（管理员查看会议内容会留痕，spec §2）', async () => {
  const h = harness({ allowRules: [allowRule({ effect: 'deny' })] })
  await getChapters(req(), h.ctx)
  expect(h.audits.length).toBe(1)
  expect(h.audits[0]!.action).toBe('view_restricted_content')
  // 「看了什么」在 detail 列（migrations/008），不再塞进 asset_type
  expect(h.audits[0]!.assetType).toBeNull()
  expect(h.audits[0]!.detail).toContain('chapters')
  // 受限查看的对价是留痕，所以留痕要留得住话：当时为什么禁止采集也一并记下
  const data = JSON.parse(h.audits[0]!.detail!.split('\n')[1]!) as {
    restricted: boolean
    allow: string
    why: { by: string; text: string }
  }
  expect(data.restricted).toBe(true)
  expect(data.allow).toBe('deny')
  expect(data.why.text.length).toBeGreaterThan(0)
})

// ── 转写解析器（纯函数） ──────────────────────────────────────────────────

test('parseTranscriptCues 认 SRT / WebVTT 的箭头行，带出结束时刻', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:05,500',
    '大家好',
    '',
    '2',
    '00:00:06,000 --> 00:00:09,000',
    '第二句',
  ].join('\n')
  const r = parseTranscriptCues(srt)
  expect(r.format).toBe('srt')
  expect(r.cues.length).toBe(2)
  expect(r.cues[0]).toMatchObject({ at: 1, endAt: 5, text: '大家好' })
  expect(r.cues[1]!.at).toBe(6)
})

test('parseTranscriptCues 认 mm:ss 与带方括号的时间戳，续行并进同一段', () => {
  const r = parseTranscriptCues('[01:05] 张三：第一句\n还是第一句\n[02:00] 第二句')
  expect(r.format).toBe('bracket')
  expect(r.cues.length).toBe(2)
  expect(r.cues[0]).toMatchObject({ at: 65, speaker: '张三' })
  expect(r.cues[0]!.text).toContain('还是第一句')
  expect(r.cues[1]!.speaker).toBeNull()
})

/**
 * 腾讯会议**真实**导出的转写格式：发言人在前，时间戳在括号里。
 *
 * 2026-08-28 的真实故障：库里 95 份转写正文全部解析成 `none`、零分段——时间轴 tab
 * 空、进度条上没有标记、也没有字幕。原因是这两个解析器都要求**时间戳在行首**
 * （SRT 的箭头行、`[01:05]` 的引导括号），而平台给的是 `曾慧(00:00:21): 正文`。
 *
 * 界面上当时如实写着「没有转写分段」——它没说谎，是解析器不认这个格式。
 *
 * 下面这段是从 `/tmp/mde-nas/.../transcript.txt` 逐字取的真实样例（人名保留,
 * 内容截断）。
 */
test('parseTranscriptCues 认「发言人(时间戳): 正文」——腾讯真实导出的那一种', () => {
  const raw = [
    '曾慧(00:00:21): 打了鹏哥。这个需求不行，后面？',
    '',
    '刘振鹏(00:00:29): 喂喂他们，他那个不不具备的，',
    '这一行没有时间戳，是上一段的续行',
    '',
    '曾慧(00:00:31): 问题。',
  ].join('\n')
  const r = parseTranscriptCues(raw)
  expect(r.format).toBe('speaker')
  expect(r.cues.length).toBe(3)
  expect(r.cues[0]).toMatchObject({ at: 21, endAt: null, speaker: '曾慧', text: '打了鹏哥。这个需求不行，后面？' })
  expect(r.cues[1]!.at).toBe(29)
  expect(r.cues[1]!.speaker).toBe('刘振鹏')
  // 续行并进上一段——丢掉它等于把长发言截成第一句
  expect(r.cues[1]!.text).toContain('这一行没有时间戳')
  expect(r.cues[2]!.at).toBe(31)
})

test('「发言人(时间戳)」不许抢走行首时间戳那两种格式', () => {
  // 行首中括号仍然判 bracket：`[01:05]` 前面没有人名
  expect(parseTranscriptCues('[01:05] 张三：第一句').format).toBe('bracket')
  // SRT 的箭头行仍然判 srt
  expect(parseTranscriptCues('1\n00:00:01,000 --> 00:00:05,500\n大家好').format).toBe('srt')
})

test('正文里出现「（三点五）」这类括号不会被当成时间戳分段', () => {
  const r = parseTranscriptCues('这句话里有个(3.5)的括号，不是时间戳\n另一句也没有时间')
  expect(r.format).toBe('none')
  expect(r.cues).toEqual([])
})

test('parseTranscriptCues 对没有时间戳的文本返回 none，不硬凑一个 0:00', () => {
  const r = parseTranscriptCues('纯文字纪要\n没有任何时间')
  expect(r.format).toBe('none')
  expect(r.cues).toEqual([])
})

// ── 路由挂载 ──────────────────────────────────────────────────────────────

test('两条路由都挂上了：没有会话时是 401 而不是 404（404 说明路由压根没注册）', async () => {
  const app = createApp(harness().ctx.deps)
  for (const path of [
    `/api/v1/admin/meetings/${ROW_ID}/content`,
    `/api/v1/admin/meetings/${ROW_ID}/content/chapters`,
  ]) {
    const res = await app(new Request(`https://gw.example${path}`))
    expect([path, res.status]).toEqual([path, 401])
  }
})

test('/content/chapters 不会被 /content 或 /:meetingId 吃掉——多一段就是另一条路由', async () => {
  const app = createApp(harness().ctx.deps)
  const res = await app(
    new Request(`https://gw.example/api/v1/admin/meetings/${ROW_ID}/content/chapters`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=tok` },
    }),
  )
  expect(res.status).toBe(200)
  // 内容端点没有 chapters 字段，章节端点没有 assets 字段——两条路由确实分开了
  const b = await body(res)
  expect(b).toHaveProperty('chapters')
  expect(b).not.toHaveProperty('assets')
})

test('周期性会议：路径段解回 (meetingId, subMeetingId) 两段，不撞成同一场', async () => {
  const subKey = { meetingId: 'm-1', subMeetingId: 'sub-3' }
  const id = consoleMeetingId(subKey.meetingId, subKey.subMeetingId)
  const h = harness(
    { single: row({ ...subKey, id }), metas: [meta(subKey)] },
    { meetingId: id },
  )
  const app = createApp(h.ctx.deps)
  const res = await app(
    new Request(`https://gw.example/api/v1/admin/meetings/${encodeURIComponent(id)}/content`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=tok` },
    }),
  )
  expect(res.status).toBe(200)
  expect((await body(res)).meeting.subMeetingId).toBe('sub-3')
})

/**
 * 抬头必须带 `hostName`。
 *
 * 少这一个字段的后果不是「少个可选信息」：预览页拿不到姓名就只能把 `host`
 * 那串 32 位 userid 原样摆上去，而那正是会议记录页 2026-08-28 刚修掉的问题
 * ——两页读的是同一个 `assembleRow`，抬头这里漏一个字段就等于漏一整页。
 */
test('内容抬头带 hostName：查到姓名给姓名，查不到给 null（不许回落成 userid）', async () => {
  const REAL_ID = 'woaJARCQAAt_hKBw--YKZeVjEaIMGFQQ'

  for (const [hostName, expected] of [['邹燕建', '邹燕建'], [null, null]] as const) {
    const h = harness({ single: row({ host: REAL_ID, hostName }) })
    const app = createApp(h.ctx.deps)
    const res = await app(
      new Request(`https://gw.example/api/v1/admin/meetings/${encodeURIComponent(ROW_ID)}/content`, {
        headers: { cookie: `${ADMIN_SESSION_COOKIE}=tok` },
      }),
    )
    expect(res.status).toBe(200)
    const m = (await body(res)).meeting
    expect(m.hostName).toBe(expected)
    // 查不到姓名时**尤其**不许把 userid 塞进 hostName 冒充结果
    expect(m.hostName).not.toBe(REAL_ID)
    expect(m.host).toBe(REAL_ID)
  }
})
