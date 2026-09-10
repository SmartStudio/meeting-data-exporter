/**
 * 管理端媒体流端点（`GET /api/v1/admin/meetings/:meetingId/media/...`）的测试。
 *
 * **不建测试库**，与 `tests/http/console-content.test.ts` 的第二段同一种手法：这个
 * handler 一行 SQL 都不写，它的全部风险在三处胶水里，而这三处都不在 SQL 里——
 *
 * 1. **路径防穿越**：`archived_assets.nas_path` 是库里的值，库被写坏就是一次任意
 *    文件读取。这一条必须用**真实文件系统**测（临时目录 + 真的把文件放在根目录外），
 *    打桩掉 `resolve` 等于把唯一危险的东西测没了。
 * 2. **Range**：206 的三个头（`Content-Range` / `Content-Length` / 实际字节）必须
 *    互相对得上。少一个对不上，浏览器的表现不是报错而是**画面卡住/没有声音**——
 *    正是这条端点要修的那个故障本身。
 * 3. **审计**：一次拖动进度条会打出几十个 Range 请求。「只在播放起点记一行」这条
 *    裁定如果失守，审计流会被同一场会议刷屏，而那等于没有审计。
 *
 * 判定本身（`explainMeetingAccess` + `policy/stacks.ts`）走**真实**代码，与
 * console-content / console-meetings 两份测试同一条约定：「管理员查看被规则禁止
 * 采集的会议要留痕」这条验收，打桩掉判定就等于把它测没了。
 */
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMedia } from '../../src/http/handlers/console/media'
import { consoleMeetingId, type ConsoleMeetingRow, type ConsoleMeetingsStore, type Triage } from '../../src/store/console-meetings'
import type { AuditEntry } from '../../src/store/audit'
import type { VisibilityDeps } from '../../src/worker/visibility'
import type { ArchivedAssetRecord } from '../../src/store/archives'
import type { MeetingOverride } from '../../src/store/grants'
import type { StackRule } from '../../src/policy/stacks'
import type { Meeting } from '../../src/domain/types'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AppDeps, RouteCtx } from '../../src/http/router'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'

const NOW = 1_700_100_000
const START = 1_700_000_000
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }
const KEY = { meetingId: 'm-1', subMeetingId: '' }
const ROW_ID = consoleMeetingId(KEY.meetingId, KEY.subMeetingId)

// ===========================================================================
// 真实文件：临时 NAS 根 + 一个根目录之外的诱饵
// ===========================================================================

/** 26 字节、每个字节都不同——Range 切出来的片段可以逐字节对，不必猜是不是错位了 */
const BODY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const SIZE = BODY.length

/** `.../mde-media-XXXX/nas` 是根；同一层还有 `nas-evil` 与 `outside`，见下面两条穿越用例 */
const BASE = mkdtempSync(join(tmpdir(), 'mde-media-'))
const NAS_ROOT = join(BASE, 'nas')
/** **前缀陷阱**：`/nas-evil` 与 `/nas` 只差一个字符，纯 startsWith 会放它进来 */
const EVIL_SIBLING = join(BASE, 'nas-evil')
const OUTSIDE = join(BASE, 'outside')

function put(dir: string, name: string, body = BODY): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}

const MEETING_DIR = join(NAS_ROOT, 'all', '2026', '08', 'm-1')
const MP4 = put(MEETING_DIR, 'recording_v-1.mp4')
put(EVIL_SIBLING, 'secret.mp4')
put(OUTSIDE, 'passwd')

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// ===========================================================================
// 假依赖
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
    nasPath: MEETING_DIR,
    sizeBytes: 23_907_140,
    ...over,
  }
}

function meta(over: Partial<Meeting> = {}): Meeting {
  return {
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    meetingRecordId: '',
    recordType: 0,
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

function archivedAsset(over: Partial<ArchivedAssetRecord> = {}): ArchivedAssetRecord {
  return {
    meetingId: KEY.meetingId,
    subMeetingId: KEY.subMeetingId,
    assetType: 'video',
    remoteId: 'v-1',
    fileType: 'mp4',
    localPath: 'local/recording_v-1.mp4',
    nasPath: MP4,
    nasHash: 'a'.repeat(64),
    archivedAt: START + 7200,
    ...over,
  }
}

interface Scenario {
  single?: ConsoleMeetingRow | null
  allowRules?: StackRule[]
  overrides?: MeetingOverride[]
  metas?: Meeting[]
  archivedAssets?: ArchivedAssetRecord[]
  nasRoot?: string | null
  identity?: AdminIdentity
}

interface Harness {
  ctx: RouteCtx
  audits: AuditEntry[]
}

const PARAMS = { meetingId: ROW_ID, assetType: 'video', remoteId: 'v-1', fileType: 'mp4' }

function harness(s: Scenario = {}, params: Record<string, string> = PARAMS): Harness {
  const audits: AuditEntry[] = []
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
      async listMeetingArchives() { return [] },
      async listMeetingsWithCompletedAssets() { return new Set<string>() },
    },
    getMeetings: (keys) => store.getMeetings(keys),
  }

  const deps = {
    now: () => NOW,
    adminAuth: { async verifySession() { return s.identity ?? ADMIN } } as unknown as AdminAuth,
    consoleMeetings: store,
    meetingVisibility: visibility,
    media: { nasRoot: s.nasRoot === undefined ? NAS_ROOT : s.nasRoot },
    archivesStore: {
      async listArchivedAssetsForMeeting() { return s.archivedAssets ?? [archivedAsset()] },
    },
    auditStore: {
      async record(e: AuditEntry) { audits.push(e) },
    },
  } as unknown as AppDeps

  return { ctx: { params, deps }, audits }
}

function req(range?: string, cookie = true): Request {
  const headers = new Headers()
  if (cookie) headers.set('cookie', `${ADMIN_SESSION_COOKIE}=token-1`)
  if (range !== undefined) headers.set('range', range)
  return new Request(
    `https://gw.example/api/v1/admin/meetings/${ROW_ID}/media/video/v-1/mp4`,
    { headers },
  )
}

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

/** 捕获这一次调用里的 console.warn，用完恢复。拒绝要留下运维看得见的痕迹，
 *  但测试输出不该被它刷屏 */
async function captureWarn(fn: () => Promise<Response>): Promise<{ res: Response; warns: string[] }> {
  const warns: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')) }
  try {
    return { res: await fn(), warns }
  } finally {
    console.warn = original
  }
}

// ===========================================================================
// 前置：认证 / 会议 / 参数 / 配置
// ===========================================================================

test('没有管理员会话时 401，且一条审计都不写', async () => {
  const h = harness()
  const res = await getMedia(req(undefined, false), h.ctx)
  expect(res.status).toBe(401)
  expect(h.audits).toEqual([])
})

test('只读角色不降级：看内容是它该有的权限（spec §2 / A8 白名单）', async () => {
  const h = harness({ identity: { adminId: 'admin-2', username: 'bob', role: 'readonly' } })
  const res = await getMedia(req(), h.ctx)
  expect(res.status).toBe(200)
  expect(h.audits.length).toBe(1)
})

test('会议查不到时 404 meeting_not_found', async () => {
  const h = harness({ single: null })
  const res = await getMedia(req(), h.ctx)
  expect(res.status).toBe(404)
  expect((await body(res)).error).toBe('meeting_not_found')
})

test('文本类资产走 content 端点，从这里放出去等于开第二条读正文的路 → 400 not_a_media_asset', async () => {
  for (const assetType of ['transcript', 'meeting_summary', 'ai_minutes', '', 'VIDEO ']) {
    const h = harness({}, { ...PARAMS, assetType })
    const res = await getMedia(req(), h.ctx)
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('not_a_media_asset')
    // 参数不对不是一次「查看」，不该留痕
    expect(h.audits).toEqual([])
  }
})

test('根目录没配时 503 nas_root_unset，不是静默 404——那会让人以为是文件不见了', async () => {
  for (const nasRoot of [null, '']) {
    const h = harness({ nasRoot })
    const res = await getMedia(req(), h.ctx)
    expect(res.status).toBe(503)
    const b = await body(res)
    expect(b.error).toBe('nas_root_unset')
    expect(typeof b.message).toBe('string')
    expect(h.audits).toEqual([])
  }
})

// ===========================================================================
// 定位文件：五个错误码是五件不同的事
// ===========================================================================

test('三段任意一段对不上都是 asset_not_archived，不会退而求其次匹配另一段', async () => {
  const cases: Array<Record<string, string>> = [
    { ...PARAMS, remoteId: 'v-9' },
    { ...PARAMS, fileType: 'webm' },
    { ...PARAMS, assetType: 'audio' },
  ]
  for (const params of cases) {
    const h = harness({}, params)
    const res = await getMedia(req(), h.ctx)
    expect(res.status).toBe(404)
    expect((await body(res)).error).toBe('asset_not_archived')
    expect(h.audits).toEqual([])
  }
})

test('库里有行、盘上没文件（NAS 那份被人删了）→ 404 media_gone，响应体里不出现文件系统路径', async () => {
  const gone = join(MEETING_DIR, 'recording_deleted.mp4')
  const h = harness({ archivedAssets: [archivedAsset({ nasPath: gone })] })
  const res = await getMedia(req(), h.ctx)
  expect(res.status).toBe(404)
  const b = await body(res)
  expect(b.error).toBe('media_gone')
  // 路径是服务端的内部布局，出现在响应体里就是一次免费的目录侦察
  expect(JSON.stringify(b)).not.toContain(gone)
  expect(JSON.stringify(b)).not.toContain(NAS_ROOT)
  expect(h.audits).toEqual([])
})

// ── 路径防穿越 ────────────────────────────────────────────────────────────

test('nas_path 指向根目录之外 → 403 path_outside_root，响应体里不出现那个路径', async () => {
  const evil = join(OUTSIDE, 'passwd')
  for (const nasPath of [evil, '../../etc/passwd', '../outside/passwd']) {
    const h = harness({ archivedAssets: [archivedAsset({ nasPath })] })
    const { res, warns } = await captureWarn(() => getMedia(req(), h.ctx))
    expect(res.status).toBe(403)
    const b = await body(res)
    expect(b.error).toBe('path_outside_root')
    expect(JSON.stringify(b)).not.toContain('passwd')
    expect(JSON.stringify(b)).not.toContain(NAS_ROOT)
    // 拒绝了就要留下运维看得见的痕迹：库里出现这种行本身是个待查的事故
    expect(warns.length).toBe(1)
    expect(h.audits).toEqual([])
  }
})

test('前缀陷阱：`<root>-evil/secret.mp4` 不能因为 startsWith(`<root>`) 就通过', async () => {
  const h = harness({ archivedAssets: [archivedAsset({ nasPath: join(EVIL_SIBLING, 'secret.mp4') })] })
  const { res } = await captureWarn(() => getMedia(req(), h.ctx))
  expect(res.status).toBe(403)
  expect((await body(res)).error).toBe('path_outside_root')
})

test('根目录本身不是一个可播放的文件 → 403，不是「读到一个目录」的 500', async () => {
  for (const nasPath of [NAS_ROOT, `${NAS_ROOT}/`, '']) {
    const h = harness({ archivedAssets: [archivedAsset({ nasPath })] })
    const { res } = await captureWarn(() => getMedia(req(), h.ctx))
    expect(res.status).toBe(403)
    expect((await body(res)).error).toBe('path_outside_root')
  }
})

test('落在根目录内的相对 nas_path 照样服务（库里存相对路径时不该整条端点罢工）', async () => {
  const h = harness({ archivedAssets: [archivedAsset({ nasPath: 'all/2026/08/m-1/recording_v-1.mp4' })] })
  const res = await getMedia(req(), h.ctx)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(BODY)
})

// ===========================================================================
// Range：浏览器靠它拖进度条，Safari 没有 Accept-Ranges 会整个拒播
// ===========================================================================

test('无 Range → 200 全量，Content-Length 是文件大小，且必须带 Accept-Ranges: bytes', async () => {
  const h = harness()
  const res = await getMedia(req(), h.ctx)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-length')).toBe(String(SIZE))
  // 缺了这个头，Safari 不是「不能拖进度条」而是**整个拒播**
  expect(res.headers.get('accept-ranges')).toBe('bytes')
  expect(res.headers.get('content-range')).toBeNull()
  expect(await res.text()).toBe(BODY)
})

test('Range: bytes=start-end → 206，Content-Range / Content-Length / 实际字节三者互相对得上', async () => {
  const h = harness()
  const res = await getMedia(req('bytes=0-9'), h.ctx)
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe(`bytes 0-9/${SIZE}`)
  expect(res.headers.get('content-length')).toBe('10')
  expect(res.headers.get('accept-ranges')).toBe('bytes')
  expect(await res.text()).toBe('ABCDEFGHIJ')
})

test('Range 的 end 省略时到文件末尾（浏览器的第一发就是 bytes=0-）', async () => {
  const h = harness()
  const res = await getMedia(req('bytes=0-'), h.ctx)
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe(`bytes 0-${SIZE - 1}/${SIZE}`)
  expect(res.headers.get('content-length')).toBe(String(SIZE))
  expect(await res.text()).toBe(BODY)

  const h2 = harness()
  const seek = await getMedia(req('bytes=20-'), h2.ctx)
  expect(seek.status).toBe(206)
  expect(seek.headers.get('content-range')).toBe(`bytes 20-${SIZE - 1}/${SIZE}`)
  expect(await seek.text()).toBe('UVWXYZ')
})

test('end 超过文件末尾时钳到末尾（RFC 7233），不是 416', async () => {
  const h = harness()
  const res = await getMedia(req(`bytes=20-99999`), h.ctx)
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe(`bytes 20-${SIZE - 1}/${SIZE}`)
  expect(await res.text()).toBe('UVWXYZ')
})

test('后缀 Range（bytes=-N，取最后 N 字节）——mp4 的 moov 在文件尾时播放器真的会这么发', async () => {
  const h = harness()
  const res = await getMedia(req('bytes=-4'), h.ctx)
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe(`bytes ${SIZE - 4}-${SIZE - 1}/${SIZE}`)
  expect(await res.text()).toBe('WXYZ')
})

test('越界或解析不出来 → 416 + Content-Range: bytes */total', async () => {
  for (const range of ['bytes=999-1000', `bytes=${SIZE}-`, 'bytes=abc', 'bytes=10-5', 'bytes=-', 'bytes=-0']) {
    const h = harness()
    const res = await getMedia(req(range), h.ctx)
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    // 一个字节都没发出去，就没有「查看」可留痕
    expect(h.audits).toEqual([])
  }
})

test('多段 Range 不支持：按无 Range 处理返回 200 全量，好过返回一个假的 206', async () => {
  const h = harness()
  const res = await getMedia(req('bytes=0-99,200-299'), h.ctx)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-length')).toBe(String(SIZE))
  expect(res.headers.get('content-range')).toBeNull()
  expect(await res.text()).toBe(BODY)
})

test('认不出的单位（RFC 7233 要求忽略）→ 200 全量，不是 416', async () => {
  const h = harness()
  const res = await getMedia(req('items=0-9'), h.ctx)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(BODY)
})

// ===========================================================================
// Content-Type 与缓存
// ===========================================================================

test('五种媒体后缀各自的 Content-Type，认不出的落 application/octet-stream', async () => {
  const table: Array<[string, string, string]> = [
    ['video', 'mp4', 'video/mp4'],
    ['audio', 'm4a', 'audio/mp4'],
    ['audio', 'mp3', 'audio/mpeg'],
    ['audio', 'wav', 'audio/wav'],
    ['video', 'webm', 'video/webm'],
    ['video', 'mkv', 'application/octet-stream'],
  ]
  for (const [assetType, fileType, expected] of table) {
    const file = put(MEETING_DIR, `probe_${fileType}.${fileType}`)
    const h = harness(
      { archivedAssets: [archivedAsset({ assetType, remoteId: 'p-1', fileType, nasPath: file })] },
      { ...PARAMS, assetType, remoteId: 'p-1', fileType },
    )
    const res = await getMedia(req(), h.ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(expected)
  }
})

test('inline 播放而不是下载，且不许被任何一层缓存留下副本', async () => {
  const h = harness()
  const res = await getMedia(req(), h.ctx)
  expect(res.headers.get('content-disposition')).toBe('inline')
  expect(res.headers.get('cache-control')).toBe('private, no-store')
})

// ===========================================================================
// 审计：一次播放记一行，不是一次拖动记几十行
// ===========================================================================

test('准许采集的会议：记一行 view_content，decision 恒为 allow', async () => {
  const h = harness()
  await getMedia(req(), h.ctx)
  expect(h.audits.length).toBe(1)
  const a = h.audits[0]!
  expect(a.action).toBe('view_content')
  expect(a.actorType).toBe('admin')
  expect(a.actorId).toBe('admin-1')
  expect(a.meetingId).toBe(KEY.meetingId)
  expect(a.clientKind).toBe('console')
  // 被规则禁掉的是「采集」，不是这次查看——记成 deny 等于宣称一次没发生过的拒绝
  expect(a.decision).toBe('allow')
  // 看了哪个资产在 detail 列（migrations/008），与 content 端点同一口径
  expect(a.assetType).toBeNull()
  expect(a.detail).toContain('video')
  expect(a.detail).toContain('v-1')
})

test('被规则禁止采集的会议：仍然能播，但记 view_restricted_content + 那条规则的 id', async () => {
  const h = harness({ allowRules: [allowRule({ effect: 'deny', note: '财务会议一律不外发' })] })
  const res = await getMedia(req(), h.ctx)
  expect(res.status).toBe(200)
  expect(h.audits.length).toBe(1)
  const a = h.audits[0]!
  expect(a.action).toBe('view_restricted_content')
  expect(a.matchedRuleId).toBe(100)
  expect(a.decision).toBe('allow')

  // 事后要问的是「他看的那一刻，这场会议为什么是禁止采集的」——
  // matched_rule 答不出这个（兜底 deny 时它本来就是 null），所以理由原话要一并记下
  const data = JSON.parse(a.detail!.split('\n')[1]!) as {
    restricted: boolean
    allow: string
    why: { by: string; text: string }
  }
  expect(data.restricted).toBe(true)
  expect(data.allow).toBe('deny')
  expect(data.why.text).toContain('财务会议一律不外发')
})

test('周期性会议的场次落进审计的 assetId 列（audit_log 没有 sub_meeting_id 列）', async () => {
  const subKey = { meetingId: 'm-1', subMeetingId: 'sub-3' }
  const subId = consoleMeetingId(subKey.meetingId, subKey.subMeetingId)
  const h = harness(
    {
      single: row({ ...subKey, id: subId }),
      metas: [meta(subKey)],
      archivedAssets: [archivedAsset({ subMeetingId: 'sub-3' })],
    },
    { ...PARAMS, meetingId: subId },
  )
  const res = await getMedia(req(), h.ctx)
  expect(res.status).toBe(200)
  expect(h.audits[0]!.assetId).toBe('sub:sub-3')
})

test('起始字节为 0 的 Range 是「这一次播放的起点」，记一行', async () => {
  for (const range of ['bytes=0-', 'bytes=0-1023']) {
    const h = harness()
    await getMedia(req(range), h.ctx)
    expect(h.audits.length).toBe(1)
  }
})

test('拖动进度条打出的后续 Range（起始不为 0）一行都不记——几十行审计等于没有审计', async () => {
  const h = harness()
  // 一次真实的拖动：先 0- 起播，再连着几发从中间取
  await getMedia(req('bytes=0-'), h.ctx)
  expect(h.audits.length).toBe(1)
  for (const range of ['bytes=8-', 'bytes=12-19', 'bytes=20-25', 'bytes=-4']) {
    await getMedia(req(range), h.ctx)
  }
  expect(h.audits.length).toBe(1)
})

test('留痕失败就不发文件：审计写不进去就没有对价（与 content 的 recordView 同一条）', async () => {
  const h = harness({ allowRules: [allowRule({ effect: 'deny' })] })
  ;(h.ctx.deps as unknown as { auditStore: { record: () => Promise<void> } }).auditStore = {
    record: async () => { throw new Error('audit_log 写不进去') },
  }
  await expect(getMedia(req(), h.ctx)).rejects.toThrow('audit_log 写不进去')
})
