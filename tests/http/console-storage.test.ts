/**
 * T8 · 归档存储与保留窗口 API 的 handler 测试。
 *
 * 与 tests/http/console/auth.test.ts 同一套做法：只关心 handler 自身的胶水逻辑
 * （鉴权、参数校验、状态码、审计有没有落、响应里回显的是不是**写后重读**的真值），
 * 因此注入假的 StorageDeps 直接调用 handler，不经过真实数据库、不经过路由派发。
 * 新建的那个只读聚合 store 的 SQL 语义由 tests/store/console-storage.test.ts
 * 打在真库上，两边不重复。
 *
 * 有一条例外：`cleanup_paused` 的极性判定测试**真的调用** src/worker/retention.ts
 * 的 executeCleanup。理由写在那条用例上——那是本文件里唯一一处"两份实现必须一致"
 * 的地方，靠注释叮嘱挡不住漂移。
 */
import { expect, test } from 'bun:test'
import {
  getStorage,
  setRetentionDays,
  setCleanupPause,
  cleanupNow,
  extendMeetingRetention,
  type StorageDeps,
  type CleanupRunner,
} from '../../src/http/handlers/console/storage'
import type { StorageAggregates, ConsoleStorageStore } from '../../src/store/console-storage'
import { createApp, type AppDeps, type RouteCtx } from '../../src/http/router'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AuditEntry, AuditStore } from '../../src/store/audit'
import type { ArchivesStore, MeetingArchiveRecord } from '../../src/store/archives'
import type { NasProbeResult } from '../../src/worker/nas-probe'
import type { CleanupExecuted, CleanupPreview } from '../../src/worker/retention'
import { executeCleanup, expiresAt } from '../../src/worker/retention'
import { AdminSessionInvalidError } from '../../src/auth/admin'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'

const NOW = 1_700_000_000
const DAY = 86_400
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice' }

function req(method: string, body?: unknown, withCookie = true): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (withCookie) headers.cookie = `${ADMIN_SESSION_COOKIE}=tok`
  return new Request('https://gw.example/api/v1/admin/storage', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function fakeAdminAuth(overrides: Partial<AdminAuth> = {}): AdminAuth {
  const notStubbed = (name: string) => async (): Promise<never> => {
    throw new Error(`fakeAdminAuth.${name} not stubbed for this test`)
  }
  return {
    authenticate: notStubbed('authenticate'),
    hashPassword: notStubbed('hashPassword'),
    issueSession: notStubbed('issueSession'),
    async verifySession() {
      return ADMIN
    },
    revokeSession: notStubbed('revokeSession'),
    revokeAllSessionsFor: notStubbed('revokeAllSessionsFor'),
    ...overrides,
  } as AdminAuth
}

const ZERO_AGGREGATES: StorageAggregates = {
  archivedMeetings: 0,
  nasBytes: 0,
  localBytes: 0,
  grantedLiveMeetings: 0,
}

function reachableProbe(over: Partial<NasProbeResult> = {}): NasProbeResult {
  return {
    reachable: true,
    checkedAt: NOW - 60,
    latencyMs: 12,
    totalBytes: 4_000_000_000_000,
    availableBytes: 1_400_000_000_000,
    error: null,
    ...over,
  }
}

function archiveRecord(over: Partial<MeetingArchiveRecord> = {}): MeetingArchiveRecord {
  return {
    meetingId: 'm-1',
    subMeetingId: '',
    nasDir: '/mnt/nas/2026/08/m-1',
    archivedAt: NOW - 10 * DAY,
    retentionDays: 30,
    extendedDays: 0,
    localPurgedAt: null,
    ...over,
  }
}

interface Rig {
  ctx: RouteCtx
  audits: AuditEntry[]
  settings: Map<string, string>
  extendCalls: Array<{ meetingId: string; subMeetingId: string; addDays: number; now: number }>
  cleanupCalls: string[]
  probeCalls: number
}

interface RigOptions {
  settings?: Record<string, string>
  probe?: NasProbeResult | (() => Promise<NasProbeResult>)
  aggregates?: Partial<StorageAggregates>
  unpurged?: MeetingArchiveRecord[]
  needingArchive?: Array<{ meetingId: string; subMeetingId: string }>
  archive?: MeetingArchiveRecord | null
  cleanup?: CleanupRunner | null
  nasRoot?: string | null
  verifySession?: AdminAuth['verifySession']
  /** 审计写入抛错，用来验证"审计写不进去时不能装作写操作成功了" */
  auditFails?: boolean
}

function rig(opts: RigOptions = {}): Rig {
  const audits: AuditEntry[] = []
  const settings = new Map(Object.entries(opts.settings ?? {}))
  const extendCalls: Rig['extendCalls'] = []
  const cleanupCalls: string[] = []
  const state = { probeCalls: 0 }

  const auditStore: Pick<AuditStore, 'record'> = {
    async record(entry) {
      if (opts.auditFails === true) throw new Error('audit store down')
      audits.push(entry)
    },
  }

  const archives: Pick<
    ArchivesStore,
    | 'getSetting'
    | 'setSetting'
    | 'extendRetention'
    | 'findMeetingArchive'
    | 'listExpiredUnpurged'
    | 'listMeetingsNeedingArchive'
  > = {
    async getSetting(key) {
      return settings.get(key) ?? null
    },
    async setSetting(key, value) {
      settings.set(key, value)
    },
    async extendRetention(meetingId, subMeetingId, addDays, now) {
      extendCalls.push({ meetingId, subMeetingId, addDays, now })
      const rec = opts.archive
      if (rec) rec.extendedDays += addDays
    },
    async findMeetingArchive() {
      // 返回副本，与真 store 一致（mapMeetingArchiveRow 每次都造新对象）。
      // 返回同一个引用会让下面 extendRetention 的累加"倒灌"回 handler 手里那份，
      // 于是 +30 看起来变成了 +60——那是假件的假象，不是 handler 的行为。
      return opts.archive === undefined || opts.archive === null ? null : { ...opts.archive }
    },
    async listExpiredUnpurged() {
      return opts.unpurged ?? []
    },
    async listMeetingsNeedingArchive() {
      return opts.needingArchive ?? []
    },
  }

  const stats: ConsoleStorageStore = {
    async aggregates() {
      return { ...ZERO_AGGREGATES, ...opts.aggregates }
    },
  }

  const defaultCleanup: CleanupRunner = {
    async preview() {
      cleanupCalls.push('preview')
      return { dryRun: true, items: [], totalBytes: 0 }
    },
    async execute() {
      cleanupCalls.push('execute')
      return { dryRun: false, paused: false, purged: [], verificationFailed: [], failed: [] }
    },
  }

  const storage: StorageDeps = {
    nasRoot: opts.nasRoot === undefined ? '/mnt/nas' : opts.nasRoot,
    async probeNas() {
      state.probeCalls++
      const p = opts.probe ?? reachableProbe()
      return typeof p === 'function' ? await p() : p
    },
    stats,
    archives,
    audit: auditStore,
    cleanup: opts.cleanup === undefined ? defaultCleanup : opts.cleanup,
  }

  const deps = {
    now: () => NOW,
    adminAuth: fakeAdminAuth(opts.verifySession ? { verifySession: opts.verifySession } : {}),
    storage,
  } as unknown as AppDeps

  return {
    ctx: { params: {}, deps },
    audits,
    settings,
    extendCalls,
    cleanupCalls,
    get probeCalls() {
      return state.probeCalls
    },
  }
}

// ── 鉴权 ────────────────────────────────────────────────────────

test('五个端点全部要求管理员会话：没有 cookie 一律 401', async () => {
  const r = rig()
  const calls: Array<Promise<Response>> = [
    getStorage(req('GET', undefined, false), r.ctx),
    setRetentionDays(req('POST', { days: 45 }, false), r.ctx),
    setCleanupPause(req('POST', { paused: true }, false), r.ctx),
    cleanupNow(req('POST', {}, false), r.ctx),
    extendMeetingRetention(req('POST', {}, false), { ...r.ctx, params: { meetingId: 'm-1' } }),
  ]
  for (const res of await Promise.all(calls)) {
    expect(res.status).toBe(401)
  }
  // 未鉴权的请求一件事都不许发生：不探 NAS、不写设置、不记审计
  expect(r.probeCalls).toBe(0)
  expect(r.settings.size).toBe(0)
  expect(r.audits).toEqual([])
})

test('会话无效（cookie 有但过期/被撤销）同样 401，且不产生任何副作用', async () => {
  const r = rig({
    verifySession: async () => {
      throw new AdminSessionInvalidError()
    },
  })
  const res = await setCleanupPause(req('POST', { paused: true }), r.ctx)
  expect(res.status).toBe(401)
  expect(r.settings.size).toBe(0)
  expect(r.audits).toEqual([])
})

// ── GET /api/v1/admin/storage ───────────────────────────────────

test('GET：NAS 那一块原样透出探测结果，容量拆成「本系统 / 其他 / 剩余」', async () => {
  const r = rig({
    aggregates: { archivedMeetings: 71, nasBytes: 842_000_000_000 },
    needingArchive: [
      { meetingId: 'm-a', subMeetingId: '' },
      { meetingId: 'm-b', subMeetingId: '' },
    ],
  })
  const res = await getStorage(req('GET'), r.ctx)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, any>

  expect(body.nas.root).toBe('/mnt/nas')
  expect(body.nas.reachable).toBe(true)
  expect(body.nas.checkedAt).toBe(NOW - 60)
  expect(body.nas.latencyMs).toBe(12)
  expect(body.nas.totalBytes).toBe(4_000_000_000_000)
  expect(body.nas.availableBytes).toBe(1_400_000_000_000)
  expect(body.nas.usedByUsBytes).toBe(842_000_000_000)
  // 其他 = 总 - 剩余 - 本系统
  expect(body.nas.usedByOthersBytes).toBe(4_000_000_000_000 - 1_400_000_000_000 - 842_000_000_000)
  expect(body.nas.archivedMeetings).toBe(71)
  expect(body.nas.pendingMeetings).toBe(2)
  // 容量只探一次，handler 自己不另跑 statfs
  expect(r.probeCalls).toBe(1)
})

test('GET：归档失败数没有数据源时如实报 null 并说明原因，不编一个数字', async () => {
  const r = rig()
  const body = (await (await getStorage(req('GET'), r.ctx)).json()) as Record<string, any>
  expect(body.nas.failedMeetings).toBeNull()
  expect(typeof body.nas.failedMeetingsNote).toBe('string')
  expect(body.nas.failedMeetingsNote.length).toBeGreaterThan(0)
})

test('GET：NAS 探不通时返回 200 而不是 500，把不可达本身当成要展示的内容', async () => {
  const r = rig({
    probe: {
      reachable: false,
      checkedAt: NOW,
      latencyMs: 5000,
      totalBytes: null,
      availableBytes: null,
      error: 'stat(/mnt/nas) timed out after 5000ms',
    },
  })
  const res = await getStorage(req('GET'), r.ctx)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, any>
  expect(body.nas.reachable).toBe(false)
  expect(body.nas.error).toContain('timed out')
  expect(body.nas.totalBytes).toBeNull()
  expect(body.nas.usedByOthersBytes).toBeNull()
})

test('GET：本系统记账大于 NAS 实际已用时，「其他占用」钳到 0 而不是负数', async () => {
  const r = rig({
    probe: reachableProbe({ totalBytes: 1_000, availableBytes: 900 }),
    aggregates: { nasBytes: 5_000 },
  })
  const body = (await (await getStorage(req('GET'), r.ctx)).json()) as Record<string, any>
  expect(body.nas.usedByOthersBytes).toBe(0)
})

test('GET：保留窗口的四个数按 retention.expiresAt 的口径算，延长过的会议不算到期', async () => {
  const unpurged: MeetingArchiveRecord[] = [
    // 早就过期（10 天前归档，保留 3 天）
    archiveRecord({ meetingId: 'm-expired', archivedAt: NOW - 10 * DAY, retentionDays: 3 }),
    // 同样早就过期，但被人工延长了 30 天——公式里漏掉 extendedDays 就会把它算成到期
    archiveRecord({
      meetingId: 'm-extended',
      archivedAt: NOW - 10 * DAY,
      retentionDays: 3,
      extendedDays: 30,
    }),
    // 3 天后到期 → 落在「7 天内到期」
    archiveRecord({ meetingId: 'm-soon', archivedAt: NOW - 27 * DAY, retentionDays: 30 }),
    // 20 天后到期 → 既不到期也不在 7 天窗口里
    archiveRecord({ meetingId: 'm-far', archivedAt: NOW - 10 * DAY, retentionDays: 30 }),
  ]
  const r = rig({ unpurged, aggregates: { grantedLiveMeetings: 2, localBytes: 123_456 } })
  const body = (await (await getStorage(req('GET'), r.ctx)).json()) as Record<string, any>

  expect(body.retention.liveMeetings).toBe(4)
  expect(body.retention.grantedMeetings).toBe(2)
  expect(body.retention.expiringIn7dMeetings).toBe(1)
  expect(body.retention.expiredMeetings).toBe(1)
  expect(body.retention.localBytes).toBe(123_456)

  // 与唯一定义处对齐：被延长的那场的到期时刻确实还在未来
  const extended = unpurged[1]!
  expect(expiresAt(extended)).toBeGreaterThan(NOW)
})

test('GET：default_retention_days 未设置时报内置默认值，并说明这是回退值', async () => {
  const r = rig()
  const body = (await (await getStorage(req('GET'), r.ctx)).json()) as Record<string, any>
  expect(body.retention.defaultDays).toBe(30)
  expect(body.retention.defaultDaysSource).toBe('fallback')
})

test('GET：default_retention_days 设过就用设过的值', async () => {
  const r = rig({ settings: { default_retention_days: '45' } })
  const body = (await (await getStorage(req('GET'), r.ctx)).json()) as Record<string, any>
  expect(body.retention.defaultDays).toBe(45)
  expect(body.retention.defaultDaysSource).toBe('setting')
})

test('GET：default_retention_days 是认不出来的值时报 invalid，不悄悄换成 30', async () => {
  const r = rig({ settings: { default_retention_days: 'abc' } })
  const body = (await (await getStorage(req('GET'), r.ctx)).json()) as Record<string, any>
  expect(body.retention.defaultDays).toBeNull()
  expect(body.retention.defaultDaysSource).toBe('invalid')
  expect(body.retention.defaultDaysRaw).toBe('abc')
})

test('GET：cleanup_paused 的回显与到期清理实际会做的判断同侧', async () => {
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false],
    ['0', false],
    ['1', true],
    ['true', true],
    ['', true],
    [' 0', true],
  ]
  for (const [raw, expected] of cases) {
    const r = rig({ settings: raw === undefined ? {} : { cleanup_paused: raw } })
    const body = (await (await getStorage(req('GET'), r.ctx)).json()) as Record<string, any>
    expect(body.retention.cleanupPaused).toBe(expected)
  }
})

/**
 * 这一条是"两份实现必须一致"的钉子，不是重复测试。
 *
 * 暂停判定的极性（"除了明确说没暂停，一律算暂停"）在 retention.ts 里是私有函数
 * isPaused，本 handler 只能另写一份来回显。两份一旦漂移，页面会说"清理正常运行"
 * 而清理其实停着（或者反过来）——而这是全系统唯一能拦住不可逆删除的开关。
 * 所以这里拿同一批原始值同时喂给真的 executeCleanup 和 handler，逐值比对。
 */
test('钉子：暂停判定与 retention.executeCleanup 的实际行为逐值一致', async () => {
  const raws: Array<string | null> = [null, '0', '1', 'true', '', ' 0', '01']
  for (const raw of raws) {
    const archives = {
      async getSetting() {
        return raw
      },
      async listExpiredUnpurged() {
        return []
      },
    } as unknown as ArchivesStore
    const actual = await executeCleanup({ archives, localRoot: '/nonexistent' }, NOW, true)

    const r = rig({ settings: raw === null ? {} : { cleanup_paused: raw } })
    const body = (await (await getStorage(req('GET'), r.ctx)).json()) as Record<string, any>
    expect([raw, body.retention.cleanupPaused]).toEqual([raw, actual.paused])
  }
})

// ── POST /storage/retention-days ────────────────────────────────

test('改默认保留天数：落 system_settings、记审计、回显新旧值', async () => {
  const r = rig({ settings: { default_retention_days: '30' } })
  const res = await setRetentionDays(req('POST', { days: 45 }), r.ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ defaultDays: 45, previousDefaultDays: 30 })
  expect(r.settings.get('default_retention_days')).toBe('45')

  expect(r.audits).toHaveLength(1)
  const a = r.audits[0]!
  expect(a.actorType).toBe('admin')
  expect(a.actorId).toBe('admin-1')
  expect(a.action).toBe('set_retention_days')
  expect(a.decision).toBe('allow')
  // 一句话明细在 detail 列（migrations/008），不再塞进 asset_type
  expect(a.detail).toContain('45')
  expect(a.assetType).toBeNull()
  expect(a.occurredAt).toBe(NOW)
})

test('改默认保留天数：非法值一律 400，且既不落库也不记审计', async () => {
  for (const days of [0, -1, 366, 1.5, '45', null, undefined]) {
    const r = rig()
    const res = await setRetentionDays(req('POST', { days }), r.ctx)
    expect([days, res.status]).toEqual([days, 400])
    expect(r.settings.size).toBe(0)
    expect(r.audits).toEqual([])
  }
})

// ── POST /storage/cleanup-pause ─────────────────────────────────

test('暂停到期清理：持久化 + 记审计 + 回显当前状态（三条缺一不可）', async () => {
  const r = rig()
  const res = await setCleanupPause(req('POST', { paused: true }), r.ctx)
  expect(res.status).toBe(200)

  // 1. 持久化：写进 system_settings，不是内存标志
  expect(r.settings.get('cleanup_paused')).toBe('1')
  // 2. 记审计
  expect(r.audits).toHaveLength(1)
  expect(r.audits[0]!.action).toBe('set_cleanup_paused')
  expect(r.audits[0]!.actorType).toBe('admin')
  // 3. 回显
  expect(await res.json()).toEqual({ cleanupPaused: true })
})

test('恢复到期清理：写回 0，同样记审计并回显', async () => {
  const r = rig({ settings: { cleanup_paused: '1' } })
  const res = await setCleanupPause(req('POST', { paused: false }), r.ctx)
  expect(res.status).toBe(200)
  expect(r.settings.get('cleanup_paused')).toBe('0')
  expect(await res.json()).toEqual({ cleanupPaused: false })
  expect(r.audits).toHaveLength(1)
})

test('暂停开关的回显来自写后重读，不是把请求体原样抄回去', async () => {
  // 造一个"写进去的和读出来的不一样"的 store：无论写什么，读到的永远是 '1'。
  // 回显若抄请求体，这里会返回 false（与库里真实状态相反）——那正是这条开关
  // 最不能出的错：页面说"清理已恢复"，实际还停着。
  const r = rig()
  const storage = r.ctx.deps.storage
  storage.archives = {
    ...storage.archives,
    async setSetting() {
      /* 假装写了 */
    },
    async getSetting(key) {
      return key === 'cleanup_paused' ? '1' : null
    },
  }
  const res = await setCleanupPause(req('POST', { paused: false }), r.ctx)
  expect(await res.json()).toEqual({ cleanupPaused: true })
})

test('暂停开关：缺 paused 字段或类型不对时 400，不写不记', async () => {
  for (const body of [{}, { paused: 'yes' }, { paused: 1 }, null]) {
    const r = rig()
    const res = await setCleanupPause(req('POST', body ?? undefined), r.ctx)
    expect([body, res.status]).toEqual([body, 400])
    expect(r.settings.size).toBe(0)
    expect(r.audits).toEqual([])
  }
})

// ── POST /storage/cleanup-now ───────────────────────────────────

test('立即清理：不带 confirm 时只做预览，绝不调用真删', async () => {
  const preview: CleanupPreview = {
    dryRun: true,
    items: [{ meetingId: 'm-1', subMeetingId: '', localBytes: 1000, assetCount: 3 }],
    totalBytes: 1000,
  }
  const r = rig({
    cleanup: {
      async preview() {
        return preview
      },
      async execute() {
        throw new Error('不带 confirm 时不许调用 executeCleanup')
      },
    },
  })
  const res = await cleanupNow(req('POST', {}), r.ctx)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, any>
  expect(body.dryRun).toBe(true)
  expect(body.totalBytes).toBe(1000)
  expect(body.items).toHaveLength(1)
  // 只读，不记审计
  expect(r.audits).toEqual([])
})

test('立即清理：confirm=true 时逐场记审计，外加一条汇总', async () => {
  const executed: CleanupExecuted = {
    dryRun: false,
    paused: false,
    purged: [
      { meetingId: 'm-1', subMeetingId: '', localBytes: 1000, assetCount: 3 },
      { meetingId: 'm-2', subMeetingId: 'sub-2', localBytes: 2000, assetCount: 1 },
    ],
    verificationFailed: [{ meetingId: 'm-3', subMeetingId: '', reason: 'NAS 上的归档文件哈希与归档记录不一致' }],
    failed: [],
  }
  const r = rig({
    cleanup: {
      async preview() {
        throw new Error('confirm=true 时不该走预览')
      },
      async execute() {
        return executed
      },
    },
  })
  const res = await cleanupNow(req('POST', { confirm: true }), r.ctx)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, any>
  expect(body.dryRun).toBe(false)
  expect(body.purged).toHaveLength(2)

  const actions = r.audits.map((a) => a.action)
  expect(actions.filter((x) => x === 'purge_local')).toHaveLength(2)
  expect(actions.filter((x) => x === 'purge_blocked')).toHaveLength(1)
  expect(actions.filter((x) => x === 'cleanup_now')).toHaveLength(1)
  // 每场被删的会议都指名道姓，详情抽屉的操作历史才查得到
  const purgeRows = r.audits.filter((a) => a.action === 'purge_local')
  expect(purgeRows.map((a) => a.meetingId).sort()).toEqual(['m-1', 'm-2'])
  // 校验不过 = 拒绝删除，是「被拒绝」的红色记录
  const blocked = r.audits.find((a) => a.action === 'purge_blocked')!
  expect(blocked.decision).toBe('deny')
  // spec §4.10：被拒绝的记录写明拒绝原因。校验失败的原因带着 NAS 路径与哈希，
  // 从前会被 asset_type 的 64 字符切掉后半段——而那半段正是能查下去的部分
  expect(blocked.detail ?? '').toContain('哈希与归档记录不一致')
  expect(r.audits.every((a) => a.actorType === 'admin')).toBe(true)
  expect(r.audits.every((a) => a.assetType === null)).toBe(true)
})

test('立即清理：清理正被暂停时如实报 paused，且审计记成被拒绝', async () => {
  const r = rig({
    settings: { cleanup_paused: '1' },
    cleanup: {
      async preview() {
        throw new Error('unused')
      },
      async execute() {
        return { dryRun: false, paused: true, purged: [], verificationFailed: [], failed: [] }
      },
    },
  })
  const res = await cleanupNow(req('POST', { confirm: true }), r.ctx)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, any>
  expect(body.paused).toBe(true)
  expect(body.purged).toEqual([])
  const summary = r.audits.find((a) => a.action === 'cleanup_now')!
  expect(summary.decision).toBe('deny')
})

test('立即清理：本进程没挂本地归档区时 503，不静默返回「没有可清理的」', async () => {
  const r = rig({ cleanup: null })
  const res = await cleanupNow(req('POST', { confirm: true }), r.ctx)
  expect(res.status).toBe(503)
  const body = (await res.json()) as Record<string, any>
  expect(body.error).toBe('local_archive_root_not_configured')
  expect(r.audits).toEqual([])
})

// ── POST /meetings/:meetingId/extend ────────────────────────────

test('延长保留：默认 +30 天，记审计，返回按唯一公式算出的新到期时刻', async () => {
  const rec = archiveRecord({ archivedAt: NOW - 10 * DAY, retentionDays: 30, extendedDays: 0 })
  const r = rig({ archive: rec })
  const res = await extendMeetingRetention(req('POST', {}), { ...r.ctx, params: { meetingId: 'm-1' } })
  expect(res.status).toBe(200)

  expect(r.extendCalls).toEqual([{ meetingId: 'm-1', subMeetingId: '', addDays: 30, now: NOW }])
  const body = (await res.json()) as Record<string, any>
  expect(body.addedDays).toBe(30)
  expect(body.extendedDays).toBe(30)
  // 与 retention.expiresAt 逐字一致，不在 handler 里另算一遍
  expect(body.expiresAt).toBe(expiresAt({ ...rec, extendedDays: 30 }))

  expect(r.audits).toHaveLength(1)
  expect(r.audits[0]!.action).toBe('extend_retention')
  expect(r.audits[0]!.meetingId).toBe('m-1')
  expect(r.audits[0]!.actorType).toBe('admin')
})

test('延长保留：周期性会议的场次由 subMeetingId 指定，默认空串', async () => {
  const rec = archiveRecord({ meetingId: 'm-1', subMeetingId: 'sub-9' })
  const r = rig({ archive: rec })
  await extendMeetingRetention(req('POST', { subMeetingId: 'sub-9', days: 7 }), {
    ...r.ctx,
    params: { meetingId: 'm-1' },
  })
  expect(r.extendCalls).toEqual([{ meetingId: 'm-1', subMeetingId: 'sub-9', addDays: 7, now: NOW }])
})

test('延长保留：这场会议根本没有归档记录时 404，不发一条 0 行的 UPDATE', async () => {
  const r = rig({ archive: null })
  const res = await extendMeetingRetention(req('POST', {}), { ...r.ctx, params: { meetingId: 'm-x' } })
  expect(res.status).toBe(404)
  expect(r.extendCalls).toEqual([])
  expect(r.audits).toEqual([])
})

test('延长保留：本地文件已经被清理掉的会议不给延长（延也延不回来）', async () => {
  const r = rig({ archive: archiveRecord({ localPurgedAt: NOW - DAY }) })
  const res = await extendMeetingRetention(req('POST', {}), { ...r.ctx, params: { meetingId: 'm-1' } })
  expect(res.status).toBe(409)
  expect((await res.json()) as Record<string, any>).toMatchObject({ error: 'already_purged' })
  expect(r.extendCalls).toEqual([])
  expect(r.audits).toEqual([])
})

test('延长保留：非法天数 400，且不动库', async () => {
  for (const days of [0, -5, 366, 2.5, 'x']) {
    const r = rig({ archive: archiveRecord() })
    const res = await extendMeetingRetention(req('POST', { days }), {
      ...r.ctx,
      params: { meetingId: 'm-1' },
    })
    expect([days, res.status]).toEqual([days, 400])
    expect(r.extendCalls).toEqual([])
    expect(r.audits).toEqual([])
  }
})

// ── 审计行本身的约束 ────────────────────────────────────────────

test('长失败原因完整落进 detail，其余定宽列一个都不许被撑爆', async () => {
  const longReason = `哈希不一致：/mnt/nas/2026/07/${'很长的路径段/'.repeat(40)}video.mp4`
  const r = rig({
    cleanup: {
      async preview() {
        throw new Error('unused')
      },
      async execute() {
        return {
          dryRun: false,
          paused: false,
          purged: [],
          verificationFailed: [{ meetingId: 'm-3', subMeetingId: '', reason: longReason }],
          failed: [{ meetingId: 'm-4', subMeetingId: '', reason: longReason }],
        }
      },
    },
  })
  await cleanupNow(req('POST', { confirm: true }), r.ctx)
  const blocked = r.audits.find((a) => a.action === 'purge_blocked')!
  // 原因整句都在——从前 64 字符只放得下开头那几个字，NAS 路径整段没了，
  // 而运维要拿着那条路径去看文件到底怎么了
  expect(blocked.detail).toBe(longReason)
  expect(blocked.detail!.length).toBeGreaterThan(64)
  for (const a of r.audits) {
    // 定宽列一个都不许被自由文本撑爆：明细搬走之后它们本来就装不下自由文本了
    expect(a.assetType).toBeNull()
    expect((a.actorId ?? '').length).toBeLessThanOrEqual(128)
    expect(a.action.length).toBeLessThanOrEqual(32)
  }
})

test('审计写不进去时写操作按失败报，不返回 200 让人以为暂停生效了', async () => {
  const r = rig({ auditFails: true })
  await expect(setCleanupPause(req('POST', { paused: true }), r.ctx)).rejects.toThrow('audit store down')
})

// ── 路由接线 ────────────────────────────────────────────────────

/**
 * 上面所有用例都是直接调 handler 函数，路径写错一个字它们照样全绿。
 * 这两条走真的 `createApp` 派发：不带 cookie 时期望 401 而不是 404——
 * 401 说明请求确实落到了那个 handler 上（鉴权是它做的第一件事），
 * 404 说明路由表里根本没有这条路径。
 */
test('五条路由都接进了 router：未登录时是 401 而不是 404', async () => {
  const r = rig()
  const app = createApp(r.ctx.deps)
  const cases: Array<[string, string]> = [
    ['GET', '/api/v1/admin/storage'],
    ['POST', '/api/v1/admin/storage/retention-days'],
    ['POST', '/api/v1/admin/storage/cleanup-pause'],
    ['POST', '/api/v1/admin/storage/cleanup-now'],
    ['POST', '/api/v1/admin/meetings/m-1/extend'],
  ]
  for (const [method, path] of cases) {
    const res = await app(new Request(`https://gw.example${path}`, { method }))
    expect([method, path, res.status]).toEqual([method, path, 401])
  }
})

test('路径参数被正确解出来：延长端点拿到的是 URL 里那个 meetingId', async () => {
  const r = rig({ archive: archiveRecord({ meetingId: 'm-1 #2', subMeetingId: '' }) })
  const app = createApp(r.ctx.deps)
  const res = await app(
    new Request(`https://gw.example/api/v1/admin/meetings/${encodeURIComponent('m-1 #2')}/extend`, {
      method: 'POST',
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=tok`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
  expect(res.status).toBe(200)
  expect(r.extendCalls[0]?.meetingId).toBe('m-1 #2')
})
