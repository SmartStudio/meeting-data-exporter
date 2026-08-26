/**
 * A3 授权 API + 采集清单（阶段 4 · T7）。
 *
 * 跟随 `tests/http/console/auth.test.ts` 的分层：`GrantsStore` 的 SQL 语义已经由
 * `tests/store/grants.test.ts` 覆盖，`computeProgramInventory` 的求交语义已经由
 * `tests/worker/visibility.test.ts` 覆盖，`ProgramsStore` 由 `tests/store/programs.test.ts`
 * 覆盖。**这一层只测 handler 自己的那部分**：参数校验、状态码、三态资产范围有没有
 * 被悄悄合并、`kind` 有没有被 handler 私自转换、明文凭据有没有只出现一次、
 * 以及每一次写操作是不是真的留下了审计。
 *
 * 因此这里全部用假 store 直接注入、直接调用 handler 函数断言 `Response`，
 * 不经过真实数据库，也不经过路由派发。**唯一的例外是采集清单**：
 * 它跑的是真的 `computeProgramInventory`（假 store 喂原料），因为 T7 的验收判据 1
 * 说的正是「走 `computeProgramInventory`，现算」——换成假清单就把这条判据测没了。
 */
import { expect, test } from 'bun:test'
import type { AssetKey } from '@yaowu/mde-engine'
import {
  listPrograms,
  createProgram,
  programInventory,
  grantMeeting,
  revokeGrant,
  putOverride,
  revokeOverride,
} from '../../src/http/handlers/console/grants'
import { createServiceAuth } from '../../src/auth/service'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import { AdminSessionInvalidError } from '../../src/auth/admin'
import type { AppDeps, RouteCtx } from '../../src/http/router'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'
import type { ProgramsStore, ServiceProgram } from '../../src/store/programs'
import type { GrantsStore, MeetingGrant, MeetingOverride } from '../../src/store/grants'
import type { AuditEntry, AuditStore } from '../../src/store/audit'
import type { StackRule } from '../../src/policy/stacks'
import { archiveStateKey, type MeetingArchiveRecord } from '../../src/store/archives'
import type { Meeting } from '../../src/domain/types'
import type { ServiceAccount } from '../../src/store/auth'
import type { RowDataPacket } from 'mysql2/promise'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp, insertPolicyRule } from './testApp'

const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice' }
const DAY = 86_400
/** 2026-06-01T00:00:00Z——整数秒，好让每个到期时刻都能心算复核 */
const NOW = Date.UTC(2026, 5, 1) / 1000
const PROGRAM = 'kb-indexer'

// ── 造数据 ────────────────────────────────────────────────────

function program(over: Partial<ServiceProgram> = {}): ServiceProgram {
  return {
    id: PROGRAM,
    name: '知识库索引器',
    tmUserId: 'tm-001',
    enabled: true,
    expiresAt: null,
    createdAt: NOW - 100 * DAY,
    ...over,
  }
}

function meeting(meetingId: string, over: Partial<Meeting> = {}): Meeting {
  return {
    meetingId,
    subMeetingId: '',
    meetingRecordId: `rec-${meetingId}`,
    meetingCode: '881-108-71',
    subject: `会议 ${meetingId}`,
    hostUserId: 'host-1',
    startTime: NOW - 40 * DAY,
    endTime: NOW - 40 * DAY + 3600,
    state: 'completed',
    ...over,
  }
}

function rule(over: Partial<StackRule> = {}): StackRule {
  return {
    id: 1,
    kind: 'allow',
    priority: 100,
    enabled: true,
    effect: 'allow',
    assetTypes: ['ai_minutes', 'transcript'],
    join: 'and',
    conds: [],
    subjectType: 'program',
    subjectValue: PROGRAM,
    note: null,
    ...over,
  }
}

function grant(meetingId: string, assetTypes: string[] | null = null): MeetingGrant {
  return {
    id: 1,
    meetingId,
    subMeetingId: '',
    programId: PROGRAM,
    assetTypes,
    grantedAt: NOW - 50 * DAY,
    revokedAt: null,
  }
}

/** 默认 archivedAt 使 expiresAt 落在 NOW + 20 天（30 天窗口，已过 10 天） */
function archive(meetingId: string, over: Partial<MeetingArchiveRecord> = {}): MeetingArchiveRecord {
  return {
    meetingId,
    subMeetingId: '',
    nasDir: `/nas/2026/05/${meetingId}`,
    archivedAt: NOW - 10 * DAY,
    retentionDays: 30,
    extendedDays: 0,
    localPurgedAt: null,
    ...over,
  }
}

// ── 假依赖 ────────────────────────────────────────────────────

interface Rig {
  ctx: RouteCtx
  audits: AuditEntry[]
  /** grantsStore 上每个写方法收到的原始入参，逐字断言用 */
  writes: { grant: unknown[]; revoke: unknown[]; putOverride: unknown[]; revokeOverride: unknown[] }
  /** programs.create 收到的入参（凭据哈希在这里被截获） */
  created: Parameters<ProgramsStore['create']>[0][]
}

interface Fixture {
  params?: Record<string, string>
  programs?: ServiceProgram[]
  /** create 返回 false 模拟重名 */
  createReturns?: boolean
  rules?: StackRule[]
  grants?: MeetingGrant[]
  archives?: MeetingArchiveRecord[]
  /** 本地有 completed 资产的会议 id（尚未归档时才会被问到） */
  localAssets?: string[]
  meetings?: Meeting[]
  overrides?: MeetingOverride[]
  /** putOverride / revokeOverride 抛错（模拟 store 侧 assertOverrideKind 的防线开火） */
  overrideThrows?: Error
  loggedIn?: boolean
}

function rig(f: Fixture = {}): Rig {
  const audits: AuditEntry[] = []
  const writes: Rig['writes'] = { grant: [], revoke: [], putOverride: [], revokeOverride: [] }
  const created: Parameters<ProgramsStore['create']>[0][] = []

  const has = (
    keys: readonly { meetingId: string; subMeetingId: string }[],
    id: string,
    sub: string,
  ): boolean => keys.some((k) => k.meetingId === id && k.subMeetingId === sub)

  const adminAuth: Partial<AdminAuth> = {
    async verifySession(token) {
      if (f.loggedIn === false || token !== 'good-token') throw new AdminSessionInvalidError()
      return ADMIN
    },
  }

  const programs: ProgramsStore = {
    async list() {
      return f.programs ?? []
    },
    async find(id) {
      return (f.programs ?? []).find((p) => p.id === id) ?? null
    },
    async create(input) {
      created.push(input)
      return f.createReturns ?? true
    },
  }

  const grantsStore: Partial<GrantsStore> = {
    async grant(input) {
      writes.grant.push(input)
      return {
        id: 99,
        meetingId: input.meetingId,
        subMeetingId: input.subMeetingId,
        programId: input.programId,
        assetTypes: input.assetTypes,
        grantedAt: input.now,
        revokedAt: null,
      }
    },
    async revoke(meetingId, subMeetingId, programId, now) {
      writes.revoke.push({ meetingId, subMeetingId, programId, now })
      return (f.grants ?? []).some((g) => g.meetingId === meetingId && g.programId === programId)
    },
    async putOverride(input) {
      writes.putOverride.push(input)
      if (f.overrideThrows) throw f.overrideThrows
      return {
        id: 7,
        meetingId: input.meetingId,
        subMeetingId: input.subMeetingId,
        kind: input.kind,
        effect: input.effect,
        assetTypes: input.assetTypes,
        reason: input.reason,
        createdAt: input.now,
        revokedAt: null,
      }
    },
    async revokeOverride(meetingId, subMeetingId, kind, now) {
      writes.revokeOverride.push({ meetingId, subMeetingId, kind, now })
      if (f.overrideThrows) throw f.overrideThrows
      return (f.overrides ?? []).some((o) => o.meetingId === meetingId && o.kind === kind)
    },
    async listActiveGrantsForProgram(programId) {
      return (f.grants ?? []).filter((g) => g.programId === programId)
    },
    async findActiveGrant(meetingId, subMeetingId, programId) {
      return (
        (f.grants ?? []).find(
          (g) =>
            g.meetingId === meetingId && g.subMeetingId === subMeetingId && g.programId === programId,
        ) ?? null
      )
    },
    async listActiveOverridesForMeetings(keys) {
      return (f.overrides ?? []).filter((o) => has(keys, o.meetingId, o.subMeetingId))
    },
  }

  const auditStore: AuditStore = {
    async record(entry) {
      audits.push(entry)
    },
  }

  const deps = {
    now: () => NOW,
    adminAuth: adminAuth as AdminAuth,
    programs,
    grantsStore: grantsStore as GrantsStore,
    auditStore,
    policyStore: {
      async listEnabledStackRules(kind: string) {
        return (f.rules ?? []).filter((r) => r.kind === kind)
      },
    },
    archivesStore: {
      async listMeetingArchives(keys: readonly { meetingId: string; subMeetingId: string }[]) {
        return (f.archives ?? []).filter((a) => has(keys, a.meetingId, a.subMeetingId))
      },
      async listMeetingsWithCompletedAssets(
        keys: readonly { meetingId: string; subMeetingId: string }[],
      ) {
        return new Set(
          (f.localAssets ?? [])
            .filter((id) => has(keys, id, ''))
            .map((id) => archiveStateKey(id, '')),
        )
      },
    },
    async getMeetings(keys: readonly { meetingId: string; subMeetingId: string }[]) {
      return (f.meetings ?? []).filter((m) => has(keys, m.meetingId, m.subMeetingId))
    },
  }

  return { ctx: { params: f.params ?? {}, deps: deps as unknown as AppDeps }, audits, writes, created }
}

function req(method: string, path: string, body?: unknown, loggedIn = true): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (loggedIn) headers.cookie = `${ADMIN_SESSION_COOKIE}=good-token`
  return new Request(`https://gw.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** 未登录：不带 cookie */
function anon(method: string, path: string, body?: unknown): Request {
  return req(method, path, body, false)
}

// ── GET /api/v1/admin/programs ────────────────────────────────

test('listPrograms 未登录返回 401', async () => {
  const r = rig()
  const res = await listPrograms(anon('GET', '/api/v1/admin/programs'), r.ctx)
  expect(res.status).toBe(401)
})

test('listPrograms 返回程序列表，响应里不含任何凭据字段', async () => {
  const r = rig({ programs: [program(), program({ id: 'dw-sync', name: '数据仓库同步' })] })
  const res = await listPrograms(req('GET', '/api/v1/admin/programs'), r.ctx)
  expect(res.status).toBe(200)
  const body = (await res.json()) as ServiceProgram[]
  expect(body.map((p) => p.id)).toEqual([PROGRAM, 'dw-sync'])
  expect(body[0]).toEqual({
    id: PROGRAM,
    name: '知识库索引器',
    tmUserId: 'tm-001',
    enabled: true,
    expiresAt: null,
    createdAt: NOW - 100 * DAY,
  })
  expect(JSON.stringify(body)).not.toContain('secret')
})

// ── POST /api/v1/admin/programs（接入新程序） ──────────────────

test('createProgram 未登录返回 401，且一行都不写', async () => {
  const r = rig()
  const res = await createProgram(
    anon('POST', '/api/v1/admin/programs', { id: 'x', name: 'X', tmUserId: 't' }),
    r.ctx,
  )
  expect(res.status).toBe(401)
  expect(r.created).toEqual([])
  expect(r.audits).toEqual([])
})

test('createProgram 缺 id / name / tmUserId 一律 400', async () => {
  for (const body of [
    { name: 'X', tmUserId: 't' },
    { id: 'x', tmUserId: 't' },
    { id: 'x', name: 'X' },
  ]) {
    const r = rig()
    const res = await createProgram(req('POST', '/api/v1/admin/programs', body), r.ctx)
    expect(res.status).toBe(400)
    expect(r.created).toEqual([])
  }
})

test('createProgram 的 id 必须是安全字符集——它同时是规则主体与 URL 的一段', async () => {
  for (const id of ['有中文', 'has space', 'a/b', '-leading', '', 'x'.repeat(65)]) {
    const r = rig()
    const res = await createProgram(
      req('POST', '/api/v1/admin/programs', { id, name: 'X', tmUserId: 't' }),
      r.ctx,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_program_id' })
  }
})

test('createProgram 成功：明文只在这一次响应里出现，库里收到的是 argon2id 哈希', async () => {
  const r = rig()
  const res = await createProgram(
    req('POST', '/api/v1/admin/programs', { id: 'new-prog', name: '新程序', tmUserId: 'tm-9' }),
    r.ctx,
  )
  expect(res.status).toBe(201)
  const body = (await res.json()) as { id: string; secret: string }
  expect(body.id).toBe('new-prog')
  expect(body.secret.length).toBeGreaterThan(20)

  // store 收到的必须是哈希，不是明文
  const written = r.created[0]!
  expect(written.secretHash).not.toBe(body.secret)
  expect(written.secretHash.startsWith('$argon2id$')).toBe(true)
  expect(written.tmUserId).toBe('tm-9')
  expect(written.expiresAt).toBeNull()
})

test('createProgram 给出的明文凭据真能通过 ServiceAuth 的校验', async () => {
  // 「明文只出现一次」如果配上一份验不过的哈希，就是发了一把打不开门的钥匙——
  // 而这件事要等对接方第一次调用失败才会被发现。在这里当场验一遍。
  const r = rig()
  const res = await createProgram(
    req('POST', '/api/v1/admin/programs', { id: 'verify-prog', name: 'V', tmUserId: 'tm-9' }),
    r.ctx,
  )
  const { secret } = (await res.json()) as { secret: string }
  const account: ServiceAccount = {
    id: 'verify-prog',
    name: 'V',
    secretHash: r.created[0]!.secretHash,
    tmUserId: 'tm-9',
    enabled: true,
    expiresAt: null,
    createdAt: NOW,
  }
  const auth = createServiceAuth({ store: { async findServiceAccount() { return account } } })
  const identity = await auth.authenticate('verify-prog', secret, NOW)
  expect(identity.programId).toBe('verify-prog')
})

test('createProgram 重名返回 409，不覆盖已有程序', async () => {
  const r = rig({ createReturns: false })
  const res = await createProgram(
    req('POST', '/api/v1/admin/programs', { id: 'dup', name: 'D', tmUserId: 't' }),
    r.ctx,
  )
  expect(res.status).toBe(409)
  expect(await res.json()).toMatchObject({ error: 'program_id_taken' })
  // 重名不算一次写操作，不留审计
  expect(r.audits).toEqual([])
})

test('createProgram 记审计，且审计里绝不出现明文凭据', async () => {
  const r = rig()
  const res = await createProgram(
    req('POST', '/api/v1/admin/programs', { id: 'audited', name: 'A', tmUserId: 't' }),
    r.ctx,
  )
  const { secret } = (await res.json()) as { secret: string }
  expect(r.audits).toHaveLength(1)
  expect(r.audits[0]).toMatchObject({
    occurredAt: NOW,
    actorType: 'admin',
    actorId: 'admin-1',
    action: 'create_program',
    decision: 'allow',
    clientKind: 'console',
  })
  expect(JSON.stringify(r.audits)).not.toContain(secret)
})

// ── GET /api/v1/admin/programs/:id/inventory ───────────────────

test('programInventory 未登录返回 401', async () => {
  const r = rig({ params: { id: PROGRAM } })
  const res = await programInventory(anon('GET', `/api/v1/admin/programs/${PROGRAM}/inventory`), r.ctx)
  expect(res.status).toBe(401)
})

test('programInventory 对不存在的程序返回 404，而不是一份「0 场」的空清单', async () => {
  // 空清单与「接进来了但还没授权任何会议」在界面上长得一模一样：
  // 管理员会以为授权没生效，去授权页反复点，而问题其实是 id 拼错了
  const r = rig({ params: { id: 'nope' }, programs: [program()] })
  const res = await programInventory(req('GET', '/api/v1/admin/programs/nope/inventory'), r.ctx)
  expect(res.status).toBe(404)
  expect(await res.json()).toMatchObject({ error: 'program_not_found' })
})

test('programInventory 给出 §4.5 那句话的三个部分：N 场、资产类型、7 天内到期数', async () => {
  const r = rig({
    params: { id: PROGRAM },
    programs: [program()],
    rules: [rule()],
    grants: [grant('m-1'), grant('m-2')],
    archives: [
      // m-1：25 天前归档，30 天窗口 → 5 天后到期，落在 7 天阈值内
      archive('m-1', { archivedAt: NOW - 25 * DAY }),
      // m-2：10 天前归档 → 20 天后到期，不算快到期
      archive('m-2', { archivedAt: NOW - 10 * DAY }),
    ],
    meetings: [meeting('m-1'), meeting('m-2')],
  })
  const res = await programInventory(req('GET', `/api/v1/admin/programs/${PROGRAM}/inventory`), r.ctx)
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    programId: string
    now: number
    fetchableCount: number
    blockedCount: number
    expiringSoonCount: number
    expiringSoonDays: number
    assetTypes: AssetKey[]
    fetchable: { meetingId: string; expiresAt: number | null; expiringSoon: boolean }[]
  }

  expect(body.programId).toBe(PROGRAM)
  expect(body.now).toBe(NOW)
  expect(body.fetchableCount).toBe(2)
  expect(body.blockedCount).toBe(0)
  // 「其中 1 场 7 天内到期」
  expect(body.expiringSoonCount).toBe(1)
  // 阈值随响应下发，界面不再把 7 抄一遍
  expect(body.expiringSoonDays).toBe(7)
  // 「……的 AI 纪要 + 完整转写」——按 ALL_ASSET_KEYS 的顺序
  expect(body.assetTypes).toEqual(['transcript', 'ai_minutes'])

  const m1 = body.fetchable.find((e) => e.meetingId === 'm-1')!
  expect(m1.expiresAt).toBe(NOW + 5 * DAY)
  expect(m1.expiringSoon).toBe(true)
  expect(body.fetchable.find((e) => e.meetingId === 'm-2')!.expiringSoon).toBe(false)
})

test('窗口已过但清理被暂停的会议仍算可取，且算进「快到期」——它比 7 天内更紧急', async () => {
  const r = rig({
    params: { id: PROGRAM },
    programs: [program()],
    rules: [rule()],
    grants: [grant('m-1')],
    // 40 天前归档、30 天窗口 → 10 天前就该到期了，但 local_purged_at 仍是 null
    archives: [archive('m-1', { archivedAt: NOW - 40 * DAY })],
    meetings: [meeting('m-1')],
  })
  const res = await programInventory(req('GET', `/api/v1/admin/programs/${PROGRAM}/inventory`), r.ctx)
  const body = (await res.json()) as {
    fetchableCount: number
    expiringSoonCount: number
    fetchable: { expiresAt: number; expiringSoon: boolean }[]
  }
  expect(body.fetchableCount).toBe(1)
  expect(body.fetchable[0]!.expiresAt).toBe(NOW - 10 * DAY)
  expect(body.expiringSoonCount).toBe(1)
})

test('还没归档过的会议没有到期时刻，不算快到期（null 不能当 0 算）', async () => {
  const r = rig({
    params: { id: PROGRAM },
    programs: [program()],
    rules: [rule()],
    grants: [grant('m-1')],
    archives: [],
    localAssets: ['m-1'],
    meetings: [meeting('m-1')],
  })
  const res = await programInventory(req('GET', `/api/v1/admin/programs/${PROGRAM}/inventory`), r.ctx)
  const body = (await res.json()) as {
    fetchableCount: number
    expiringSoonCount: number
    fetchable: { expiresAt: number | null; expiringSoon: boolean }[]
  }
  expect(body.fetchableCount).toBe(1)
  expect(body.fetchable[0]!.expiresAt).toBeNull()
  expect(body.fetchable[0]!.expiringSoon).toBe(false)
  expect(body.expiringSoonCount).toBe(0)
})

test('取不到的会议进 blocked，各自带着 blockers 与「该去哪一页」', async () => {
  const r = rig({
    params: { id: PROGRAM },
    programs: [program()],
    rules: [rule()],
    grants: [grant('m-purged'), grant('m-unknown')],
    archives: [archive('m-purged', { localPurgedAt: NOW - DAY })],
    // m-unknown 故意不给会议元数据：判不出来要落到拒绝一侧
    meetings: [meeting('m-purged')],
  })
  const res = await programInventory(req('GET', `/api/v1/admin/programs/${PROGRAM}/inventory`), r.ctx)
  const body = (await res.json()) as {
    fetchableCount: number
    blockedCount: number
    blocked: { meetingId: string; blockers: { code: string; remedy: string; reason: string }[] }[]
  }
  expect(body.fetchableCount).toBe(0)
  expect(body.blockedCount).toBe(2)

  const purged = body.blocked.find((e) => e.meetingId === 'm-purged')!
  expect(purged.blockers.map((b) => b.code)).toEqual(['local_purged'])
  expect(purged.blockers[0]!.remedy).toBe('nas')
  expect(purged.blockers[0]!.reason).toContain('/nas/2026/05/m-purged')

  // m-unknown 既没有归档行、本地也没有资产，同时又查不到会议元数据——
  // **两个「与」都缺就两条都在**（阶段 3 的 D-w）。只报第一条的话，管理员补完
  // 元数据会发现还是取不到，再回来查一遍，同一件事来回两趟
  const unknown = body.blocked.find((e) => e.meetingId === 'm-unknown')!
  expect(unknown.blockers.map((b) => b.code)).toEqual(['no_local_files', 'meeting_unknown'])
  expect(unknown.blockers.map((b) => b.remedy)).toEqual(['pipeline', 'pipeline'])
})

test('一场都没授权时清单是空的，但仍是 200 —— 与「程序不存在」分得开', async () => {
  const r = rig({ params: { id: PROGRAM }, programs: [program()], rules: [rule()] })
  const res = await programInventory(req('GET', `/api/v1/admin/programs/${PROGRAM}/inventory`), r.ctx)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { fetchableCount: number; blockedCount: number; assetTypes: string[] }
  expect(body).toMatchObject({ fetchableCount: 0, blockedCount: 0, assetTypes: [] })
})

// ── POST /api/v1/admin/meetings/:meetingId/grants ──────────────

test('grantMeeting 未登录返回 401，且不写库不记审计', async () => {
  const r = rig({ params: { meetingId: 'm-1' }, programs: [program()] })
  const res = await grantMeeting(
    anon('POST', '/api/v1/admin/meetings/m-1/grants', { programId: PROGRAM, assetTypes: null }),
    r.ctx,
  )
  expect(res.status).toBe(401)
  expect(r.writes.grant).toEqual([])
  expect(r.audits).toEqual([])
})

test('grantMeeting 缺 programId 返回 400', async () => {
  const r = rig({ params: { meetingId: 'm-1' }, programs: [program()] })
  const res = await grantMeeting(
    req('POST', '/api/v1/admin/meetings/m-1/grants', { assetTypes: null }),
    r.ctx,
  )
  expect(res.status).toBe(400)
  expect(r.writes.grant).toEqual([])
})

test('grantMeeting 缺 assetTypes 键返回 400——不把"没写"悄悄当成"不限制"', async () => {
  // 三态里 null 是最宽的那一个。让它成为字段缺失时的默认值，等于一次静默放行：
  // 前端少发一个字段，管理员本想只授权 AI 纪要，实际授权了规则放行的全部资产
  const r = rig({ params: { meetingId: 'm-1' }, programs: [program()] })
  const res = await grantMeeting(
    req('POST', '/api/v1/admin/meetings/m-1/grants', { programId: PROGRAM }),
    r.ctx,
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ error: 'missing_asset_types' })
  expect(r.writes.grant).toEqual([])
})

test('grantMeeting 的 assetTypes = [] 原样递给 store，不被合并成 null', async () => {
  const r = rig({ params: { meetingId: 'm-1' }, programs: [program()] })
  const res = await grantMeeting(
    req('POST', '/api/v1/admin/meetings/m-1/grants', { programId: PROGRAM, assetTypes: [] }),
    r.ctx,
  )
  expect(res.status).toBe(200)
  expect(r.writes.grant[0]).toMatchObject({ assetTypes: [] })
})

test('grantMeeting 对不存在的程序返回 404，不留一条指向空气的授权', async () => {
  const r = rig({ params: { meetingId: 'm-1' }, programs: [] })
  const res = await grantMeeting(
    req('POST', '/api/v1/admin/meetings/m-1/grants', { programId: 'ghost', assetTypes: null }),
    r.ctx,
  )
  expect(res.status).toBe(404)
  expect(await res.json()).toMatchObject({ error: 'program_not_found' })
  expect(r.writes.grant).toEqual([])
})

test('grantMeeting 成功：把 sub 场次带进 store，返回生效的授权行，并记审计', async () => {
  const r = rig({ params: { meetingId: 'm-1' }, programs: [program()] })
  const res = await grantMeeting(
    req('POST', '/api/v1/admin/meetings/m-1/grants?sub=s-7', {
      programId: PROGRAM,
      assetTypes: ['ai_minutes'],
    }),
    r.ctx,
  )
  expect(res.status).toBe(200)
  expect(r.writes.grant[0]).toEqual({
    meetingId: 'm-1',
    subMeetingId: 's-7',
    programId: PROGRAM,
    assetTypes: ['ai_minutes'],
    now: NOW,
  })
  expect(await res.json()).toMatchObject({ meetingId: 'm-1', subMeetingId: 's-7', programId: PROGRAM })

  expect(r.audits).toHaveLength(1)
  expect(r.audits[0]).toMatchObject({
    actorType: 'admin',
    actorId: 'admin-1',
    action: 'grant_meeting',
    meetingId: 'm-1',
    decision: 'allow',
    clientKind: 'console',
  })
  // 场次与目标程序都要能从审计记录里读出来
  expect(r.audits[0]!.assetId).toContain(PROGRAM)
  expect(r.audits[0]!.assetId).toContain('s-7')
})

test('grantMeeting 的审计明细不会超出 audit_log.asset_type 的 64 字符', async () => {
  const r = rig({ params: { meetingId: 'm-1' }, programs: [program()] })
  await grantMeeting(
    req('POST', '/api/v1/admin/meetings/m-1/grants', {
      programId: PROGRAM,
      assetTypes: [
        'video', 'audio', 'transcript', 'ai_transcript',
        'ai_minutes', 'ai_topic_minutes', 'ai_speaker_minutes', 'ai_ds_minutes',
      ],
    }),
    r.ctx,
  )
  expect((r.audits[0]!.assetType ?? '').length).toBeLessThanOrEqual(64)
})

// ── DELETE /api/v1/admin/meetings/:meetingId/grants/:programId ──

test('revokeGrant 未登录返回 401', async () => {
  const r = rig({ params: { meetingId: 'm-1', programId: PROGRAM } })
  const res = await revokeGrant(anon('DELETE', `/api/v1/admin/meetings/m-1/grants/${PROGRAM}`), r.ctx)
  expect(res.status).toBe(401)
  expect(r.writes.revoke).toEqual([])
})

test('revokeGrant 撤掉一条生效授权：revoked = true，并记审计', async () => {
  const r = rig({ params: { meetingId: 'm-1', programId: PROGRAM }, grants: [grant('m-1')] })
  const res = await revokeGrant(req('DELETE', `/api/v1/admin/meetings/m-1/grants/${PROGRAM}`), r.ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ revoked: true })
  expect(r.writes.revoke[0]).toEqual({
    meetingId: 'm-1',
    subMeetingId: '',
    programId: PROGRAM,
    now: NOW,
  })
  expect(r.audits[0]).toMatchObject({ action: 'revoke_grant', actorType: 'admin', meetingId: 'm-1' })
})

test('revokeGrant 撤了个本来就没有的授权：revoked = false，但仍然留审计', async () => {
  // 管理员点了「撤销」这件事本身发生过。不记的话，日后查「谁动了这条授权」时
  // 会看到一段空白，而当事人记得自己点过
  const r = rig({ params: { meetingId: 'm-1', programId: PROGRAM }, grants: [] })
  const res = await revokeGrant(req('DELETE', `/api/v1/admin/meetings/m-1/grants/${PROGRAM}`), r.ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ revoked: false })
  expect(r.audits).toHaveLength(1)
  expect(r.audits[0]!.decision).toBe('allow')
  expect(r.audits[0]!.assetType).toContain('noop')
})

// ── PUT /api/v1/admin/meetings/:meetingId/override ─────────────

test('putOverride 未登录返回 401', async () => {
  const r = rig({ params: { meetingId: 'm-1' } })
  const res = await putOverride(
    anon('PUT', '/api/v1/admin/meetings/m-1/override', {
      kind: 'allow', effect: 'allow', assetTypes: null, reason: 'x',
    }),
    r.ctx,
  )
  expect(res.status).toBe(401)
  expect(r.writes.putOverride).toEqual([])
})

test('putOverride 缺 reason 返回 400——改写的理由会进判定理由，不能为空', async () => {
  const r = rig({ params: { meetingId: 'm-1' } })
  const res = await putOverride(
    req('PUT', '/api/v1/admin/meetings/m-1/override', {
      kind: 'allow', effect: 'allow', assetTypes: null, reason: '   ',
    }),
    r.ctx,
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ error: 'missing_reason' })
  expect(r.writes.putOverride).toEqual([])
})

test('putOverride 缺 assetTypes 键返回 400（与授权同一条理由）', async () => {
  const r = rig({ params: { meetingId: 'm-1' } })
  const res = await putOverride(
    req('PUT', '/api/v1/admin/meetings/m-1/override', {
      kind: 'allow', effect: 'allow', reason: '法务要求',
    }),
    r.ctx,
  )
  expect(res.status).toBe(400)
  expect(r.writes.putOverride).toEqual([])
})

test('putOverride 把 kind 与 effect 原样递给 store，一个字符都不转换', async () => {
  // 阶段 3 的 D-u：kind 是改写行上唯一没有安全侧可落的字段，防线在 store 的
  // assertOverrideKind 与 migrations/006 的 CHECK。handler 这层再判一次
  // 就成了第三份「合法值清单」，三份早晚会分叉
  const r = rig({ params: { meetingId: 'm-1' } })
  await putOverride(
    req('PUT', '/api/v1/admin/meetings/m-1/override?sub=s-2', {
      kind: 'ALLOW', effect: 'AlLoW', assetTypes: ['ai_minutes'], reason: '法务要求单独放行',
    }),
    r.ctx,
  )
  expect(r.writes.putOverride[0]).toEqual({
    meetingId: 'm-1',
    subMeetingId: 's-2',
    kind: 'ALLOW',
    effect: 'AlLoW',
    assetTypes: ['ai_minutes'],
    reason: '法务要求单独放行',
    now: NOW,
  })
})

test('store 的 kind 防线开火时不落审计——没写成的事不能留一条说写成了的记录', async () => {
  const r = rig({
    params: { meetingId: 'm-1' },
    overrideThrows: new Error('meeting_overrides.kind must be one of fetch / archive / allow'),
  })
  await expect(
    putOverride(
      req('PUT', '/api/v1/admin/meetings/m-1/override', {
        kind: 'nonsense', effect: 'allow', assetTypes: null, reason: 'r',
      }),
      r.ctx,
    ),
  ).rejects.toThrow(/kind must be one of/)
  expect(r.audits).toEqual([])
})

test('putOverride 成功返回生效的改写行并记审计', async () => {
  const r = rig({ params: { meetingId: 'm-1' } })
  const res = await putOverride(
    req('PUT', '/api/v1/admin/meetings/m-1/override', {
      kind: 'allow', effect: 'deny', assetTypes: null, reason: '涉密，单独关闭',
    }),
    r.ctx,
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ kind: 'allow', effect: 'deny', reason: '涉密，单独关闭' })
  expect(r.audits[0]).toMatchObject({
    action: 'put_override',
    actorType: 'admin',
    actorId: 'admin-1',
    meetingId: 'm-1',
    clientKind: 'console',
  })
  expect(r.audits[0]!.assetId).toContain('allow')
})

// ── DELETE /api/v1/admin/meetings/:meetingId/override/:kind ────

test('revokeOverride 未登录返回 401', async () => {
  const r = rig({ params: { meetingId: 'm-1', kind: 'allow' } })
  const res = await revokeOverride(anon('DELETE', '/api/v1/admin/meetings/m-1/override/allow'), r.ctx)
  expect(res.status).toBe(401)
  expect(r.writes.revokeOverride).toEqual([])
})

test('revokeOverride 把路径上的 kind 原样递给 store', async () => {
  const r = rig({
    params: { meetingId: 'm-1', kind: 'Archive' },
    overrideThrows: new Error('meeting_overrides.kind must be one of fetch / archive / allow'),
  })
  await expect(
    revokeOverride(req('DELETE', '/api/v1/admin/meetings/m-1/override/Archive'), r.ctx),
  ).rejects.toThrow(/kind must be one of/)
  expect(r.writes.revokeOverride[0]).toMatchObject({ kind: 'Archive' })
  expect(r.audits).toEqual([])
})

test('revokeOverride 成功：revoked = true 并记审计；无操作时 false 但仍记', async () => {
  const withOne = rig({
    params: { meetingId: 'm-1', kind: 'allow' },
    overrides: [{
      id: 1, meetingId: 'm-1', subMeetingId: '', kind: 'allow', effect: 'allow',
      assetTypes: null, reason: 'r', createdAt: NOW - DAY, revokedAt: null,
    }],
  })
  const res = await revokeOverride(req('DELETE', '/api/v1/admin/meetings/m-1/override/allow'), withOne.ctx)
  expect(await res.json()).toEqual({ revoked: true })
  expect(withOne.audits[0]).toMatchObject({ action: 'revoke_override', actorType: 'admin' })

  const empty = rig({ params: { meetingId: 'm-1', kind: 'allow' } })
  const res2 = await revokeOverride(req('DELETE', '/api/v1/admin/meetings/m-1/override/allow'), empty.ctx)
  expect(await res2.json()).toEqual({ revoked: false })
  expect(empty.audits).toHaveLength(1)
})

// ── 路由接线 ──────────────────────────────────────────────────

/**
 * 上面全部用例都是直接调用 handler 函数，绕过了路由派发——好处是不用连库，
 * 坏处是**路由行里的一个拼写错误它们一条都发现不了**：路径写错就是 404，
 * 而 404 与「这个端点还没做」在前端看来一模一样。
 *
 * 这一条补上那个缺口：七个端点各发一个不带 cookie 的请求，要的是 401
 * （被 requireAdminAuth 拦下 = 路由匹配上了、handler 跑到了），不是 404。
 */
test('七个端点都在路由表里，且都被 requireAdminAuth 挡在门外', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const { app } = buildTestApp(pool)
    const cases: [string, string][] = [
      ['GET', '/api/v1/admin/programs'],
      ['POST', '/api/v1/admin/programs'],
      ['GET', '/api/v1/admin/programs/kb-indexer/inventory'],
      ['POST', '/api/v1/admin/meetings/m-1/grants'],
      ['DELETE', '/api/v1/admin/meetings/m-1/grants/kb-indexer'],
      ['PUT', '/api/v1/admin/meetings/m-1/override'],
      ['DELETE', '/api/v1/admin/meetings/m-1/override/allow'],
    ]
    for (const [method, path] of cases) {
      const res = await app(
        new Request(`https://gw.example${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
        }),
      )
      // 把方法与路径拼进断言值，失败时一眼看得出是哪一条路由写错了
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 401`)
    }
  } finally {
    await cleanup()
  }
})

test('走真实路由派发：授权落到 ?sub= 那一场，清单现算，审计真的进了库', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const { app, deps } = buildTestApp(pool)
    // 直接建一个管理员会话，省去走一遍登录端点
    await deps.adminStore.createAccount({
      id: 'admin-1',
      username: 'alice',
      passwordHash: 'x',
      now: 1_000,
    })
    const { token } = await deps.adminAuth.issueSession('admin-1', false, deps.now())
    const cookie = `${ADMIN_SESSION_COOKIE}=${token}`

    await deps.programs.create({
      id: PROGRAM,
      name: '知识库索引器',
      secretHash: 'h',
      tmUserId: 'tm-1',
      expiresAt: null,
      now: deps.now(),
    })
    // 会议元数据走 meetings 表（计划 E-a：它才是控制台主表）
    await pool.execute(
      `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid,
                             start_time, end_time, created_at, updated_at)
       VALUES ('m-1', 's-7', '881-108-71', '季度财务复盘', 'host-1', ?, ?, ?, ?)`,
      [deps.now() - 7200, deps.now() - 3600, deps.now(), deps.now()],
    )
    await insertPolicyRule(pool, {
      priority: 100,
      programId: PROGRAM,
      assetTypes: ['ai_minutes'],
      effect: 'allow',
    })

    const granted = await app(
      new Request('https://gw.example/api/v1/admin/meetings/m-1/grants?sub=s-7', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ programId: PROGRAM, assetTypes: null }),
      }),
    )
    expect(granted.status).toBe(200)
    expect(await granted.json()).toMatchObject({ meetingId: 'm-1', subMeetingId: 's-7' })

    // 清单现算：这一场没归档、本地也没有下载完成的资产，所以取不到，但理由说得出
    // 是哪一条——而且它顺带证明了 getMeetings 真的把 meetings 表那一行读了回来
    const inv = await app(
      new Request(`https://gw.example/api/v1/admin/programs/${PROGRAM}/inventory`, {
        headers: { cookie },
      }),
    )
    expect(inv.status).toBe(200)
    const body = (await inv.json()) as {
      fetchableCount: number
      blocked: { meetingId: string; subMeetingId: string; blockers: { code: string }[] }[]
    }
    expect(body.fetchableCount).toBe(0)
    expect(body.blocked[0]).toMatchObject({ meetingId: 'm-1', subMeetingId: 's-7' })
    expect(body.blocked[0]!.blockers.map((b) => b.code)).toEqual(['no_local_files'])

    const [audits] = await pool.execute<RowDataPacket[]>(
      `SELECT actor_type, actor_id, action, meeting_id, asset_id, client_kind
         FROM audit_log WHERE action = 'grant_meeting'`,
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actor_type: 'admin',
      actor_id: 'admin-1',
      meeting_id: 'm-1',
      asset_id: `${PROGRAM}@s-7`,
      client_kind: 'console',
    })
  } finally {
    await cleanup()
  }
})

test('T13：subject 是 NULL 的会议不会被低优先级的 allow 规则放出去（从真库到清单整条路）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const { app, deps } = buildTestApp(pool)
    await deps.adminStore.createAccount({ id: 'admin-1', username: 'alice', passwordHash: 'x', now: 1_000 })
    const { token } = await deps.adminAuth.issueSession('admin-1', false, deps.now())
    const cookie = `${ADMIN_SESSION_COOKIE}=${token}`
    await deps.programs.create({
      id: PROGRAM, name: '知识库索引器', secretHash: 'h', tmUserId: 'tm-1',
      expiresAt: null, now: deps.now(),
    })

    // meetings 表的列全部 nullable，这一行的 subject 就是 NULL——
    // 会议真的存在，只是元数据不全
    await pool.execute(
      `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid,
                             start_time, end_time, created_at, updated_at)
       VALUES ('m-null', '', '881-108-71', NULL, 'host-1', ?, ?, ?, ?)`,
      [deps.now() - 7200, deps.now() - 3600, deps.now(), deps.now()],
    )
    // 本地有下载完成的资产，保留期那个「与」就成立了，判定卡在哪一环因此没有歧义
    await pool.execute(
      `INSERT INTO meeting_assets
         (meeting_id, sub_meeting_id, asset_type, remote_id, asset_id,
          status, completed_at, created_at, updated_at)
       VALUES ('m-null', '', 'ai_minutes', 'r-1', 'a-1', 'completed', ?, ?, ?)`,
      [deps.now() - 1000, deps.now(), deps.now()],
    )

    // 缺口的原样复现：按标题拒绝的高优先级规则 + 放行全部的低优先级规则。
    // 标题被折成空串时，deny 判「不匹配」落到放行侧，再被下面这条 allow 接手
    await insertPolicyRule(pool, {
      priority: 200, programId: PROGRAM, assetTypes: ['*'], effect: 'deny',
      conds: [{ f: 'title', op: 'has', v: '财务' }], note: '财务会议不外放',
    })
    await insertPolicyRule(pool, {
      priority: 50, programId: PROGRAM, assetTypes: ['*'], effect: 'allow', note: '其余一律放行',
    })

    const granted = await app(
      new Request('https://gw.example/api/v1/admin/meetings/m-null/grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ programId: PROGRAM, assetTypes: null }),
      }),
    )
    expect(granted.status).toBe(200)

    const inv = await app(
      new Request(`https://gw.example/api/v1/admin/programs/${PROGRAM}/inventory`, { headers: { cookie } }),
    )
    const body = (await inv.json()) as {
      fetchableCount: number
      blocked: {
        meetingId: string
        decision: { effect: string; source: string } | null
        blockers: { code: string; reason: string; remedy: string }[]
      }[]
    }

    // 缺口修好之前这里是 1：会议被静默放行
    expect(body.fetchableCount).toBe(0)
    const blocked = body.blocked.find((e) => e.meetingId === 'm-null')!
    expect(blocked.decision).toMatchObject({ effect: 'deny', source: 'undecidable' })
    expect(blocked.blockers.map((b) => b.code)).toEqual(['meeting_unknown'])
    // 理由必须说得出是「元数据不全，判不出来」，而不是「不匹配」或「按兜底拒绝」；
    // 也不能说成「在 meetings 表里查不到」——这一行是真的在
    expect(blocked.blockers[0]!.reason).toContain('有这一行')
    expect(blocked.blockers[0]!.reason).toContain('判不出来')
    expect(blocked.blockers[0]!.reason).not.toContain('按兜底处理')
  } finally {
    await cleanup()
  }
})
