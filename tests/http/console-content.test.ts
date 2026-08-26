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
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice' }
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

test('media 块只给去向（NAS 路径 / 直链端点），没有任何正文字段', async () => {
  const h = harness({
    archivedAssets: [archivedAsset({ assetType: 'video', fileType: 'mp4', remoteId: 'v-1', nasPath: '/nas/x/video.mp4' })],
  })
  const b = await body(await getContent(req(), h.ctx))
  expect(b.media.proxied).toBe(false)
  expect(b.media.assets.length).toBe(1)
  expect(b.media.assets[0]).not.toHaveProperty('content')
  expect(b.media.assets[0].nasPath).toBe('/nas/x/video.mp4')
  expect(b.media.text).toContain('/api/v1/assets/')
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

test('章节：chapters 恒为空、source 报 none——腾讯的「章节 + 摘要」在本系统里没有来源，不编', async () => {
  const h = harness()
  const b = await body(await getChapters(req(), h.ctx))
  expect(b.chapters).toEqual([])
  expect(b.source).toBe('none')
  expect(b.text.length).toBeGreaterThan(0)
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
  expect(h.audits[0]!.assetType).toContain('chapters')
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
