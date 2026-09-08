import { expect, test } from 'bun:test'
import type { AssetKey } from '@yaowu/mde-engine'
import type { MeetingMeta } from '../../src/policy/access'
import type { StackRule } from '../../src/policy/stacks'
import { archiveStateKey, type MeetingArchiveRecord } from '../../src/store/archives'
import type { MeetingGrant, MeetingOverride } from '../../src/store/grants'
import {
  computeProgramInventory,
  explainMeetingAccess,
  type InventoryBlockCode,
  type InventoryEntry,
  type VisibilityDeps,
} from '../../src/worker/visibility'

/**
 * 采集清单重算（阶段 3 · T8）。spec §1.3 的三个「与」求交之后的**实际结果**，
 * 不是配置值。
 *
 * 这里一律不连数据库：本模块是纯计算 + 若干批量读法，store 用**会计数的假实现**注入。
 * 计数不是为了跑得快，是为了钉住「批量，不要 N+1」这一条——一个程序可能授权了成百上千场
 * 会议，逐场 findMeetingArchive 就是成百上千次往返。只有假实现才能对着调用次数下断言。
 */

const DAY = 86_400
/** 2026-06-01T00:00:00Z——整数秒，好让下面每个 now 都能心算复核 */
const ARCHIVED_AT = Date.UTC(2026, 5, 1) / 1000
const NOW = ARCHIVED_AT + 10 * DAY
const PROGRAM = 'prog-1'

// ── 造数据 ────────────────────────────────────────────────────

function meeting(meetingId: string, over: Partial<MeetingMeta> = {}): MeetingMeta {
  return {
    meetingId,
    subMeetingId: '',
    meetingRecordId: `rec-${meetingId}`,
    meetingCode: '881-108-71',
    subject: `会议 ${meetingId}`,
    hostUserId: 'host-1',
    startTime: ARCHIVED_AT - 2 * DAY,
    endTime: ARCHIVED_AT - 2 * DAY + 3600,
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
    assetTypes: ['*'],
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
    grantedAt: ARCHIVED_AT,
    revokedAt: null,
  }
}

function archive(meetingId: string, over: Partial<MeetingArchiveRecord> = {}): MeetingArchiveRecord {
  return {
    meetingId,
    subMeetingId: '',
    nasDir: `/nas/2026/06/${meetingId}`,
    archivedAt: ARCHIVED_AT,
    retentionDays: 30,
    extendedDays: 0,
    localPurgedAt: null,
    ...over,
  }
}

function override(meetingId: string, over: Partial<MeetingOverride> = {}): MeetingOverride {
  return {
    id: 1,
    meetingId,
    subMeetingId: '',
    kind: 'allow',
    effect: 'allow',
    assetTypes: null,
    reason: '法务要求单独放行',
    createdAt: ARCHIVED_AT,
    revokedAt: null,
    ...over,
  }
}

interface Fixture {
  rules?: StackRule[]
  grants?: MeetingGrant[]
  archives?: MeetingArchiveRecord[]
  /** 本地有 completed 资产的会议 id */
  localAssets?: string[]
  meetings?: MeetingMeta[]
  overrides?: MeetingOverride[]
}

interface Rig {
  deps: VisibilityDeps
  /** 每个 store 读法被调了几次。批量的那条断言全靠它 */
  calls: Record<string, number>
}

function rig(f: Fixture): Rig {
  const calls: Record<string, number> = {
    listEnabledStackRules: 0,
    listActiveGrantsForProgram: 0,
    findActiveGrant: 0,
    listActiveOverridesForMeetings: 0,
    listMeetingArchives: 0,
    listMeetingsWithCompletedAssets: 0,
    getMeetings: 0,
  }
  const bump = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1
  }
  const has = (
    keys: readonly { meetingId: string; subMeetingId: string }[],
    id: string,
    sub: string,
  ): boolean => keys.some((k) => k.meetingId === id && k.subMeetingId === sub)

  const deps: VisibilityDeps = {
    policy: {
      async listEnabledStackRules(kind) {
        bump('listEnabledStackRules')
        return (f.rules ?? []).filter((r) => r.kind === kind)
      },
    },
    grants: {
      async listActiveGrantsForProgram(programId) {
        bump('listActiveGrantsForProgram')
        return (f.grants ?? []).filter((g) => g.programId === programId)
      },
      async findActiveGrant(meetingId, subMeetingId, programId) {
        bump('findActiveGrant')
        return (
          (f.grants ?? []).find(
            (g) =>
              g.meetingId === meetingId &&
              g.subMeetingId === subMeetingId &&
              g.programId === programId,
          ) ?? null
        )
      },
      async listActiveOverridesForMeetings(keys) {
        bump('listActiveOverridesForMeetings')
        return (f.overrides ?? []).filter((o) => has(keys, o.meetingId, o.subMeetingId))
      },
    },
    archives: {
      async listMeetingArchives(keys) {
        bump('listMeetingArchives')
        return (f.archives ?? []).filter((a) => has(keys, a.meetingId, a.subMeetingId))
      },
      async listMeetingsWithCompletedAssets(keys) {
        bump('listMeetingsWithCompletedAssets')
        return new Set(
          (f.localAssets ?? []).filter((id) => has(keys, id, '')).map((id) => archiveStateKey(id, '')),
        )
      },
    },
    async getMeetings(keys) {
      bump('getMeetings')
      return (f.meetings ?? []).filter((m) => has(keys, m.meetingId, m.subMeetingId))
    },
  }
  return { deps, calls }
}

/** 三个「与」都成立的基线场景，各用例只改其中一个条件 */
function healthy(over: Partial<Fixture> = {}): Fixture {
  return {
    rules: [rule()],
    grants: [grant('m-1')],
    archives: [archive('m-1')],
    meetings: [meeting('m-1')],
    ...over,
  }
}

function codes(entry: InventoryEntry): InventoryBlockCode[] {
  return entry.blockers.map((b) => b.code)
}

function only(entries: readonly InventoryEntry[], meetingId: string): InventoryEntry {
  const found = entries.find((e) => e.meetingId === meetingId)
  if (found === undefined) throw new Error(`no entry for ${meetingId}`)
  return found
}

// ── 三个「与」 ────────────────────────────────────────────────

test('三个条件齐备时会议进清单，assetTypes 是求交后的实际结果', async () => {
  const { deps } = rig(healthy())
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable.map((e) => e.meetingId)).toEqual(['m-1'])
  expect(inv.blocked).toEqual([])
  expect(only(inv.entries, 'm-1').blockers).toEqual([])
  expect(only(inv.entries, 'm-1').assetTypes).toEqual([
    'video',
    'audio',
    'transcript',
    'ai_transcript',
    'ai_minutes',
    'chapters',
  ])
})

test('缺「有授权」：没有授权行的会议不在清单里，理由指向授权页', async () => {
  const { deps } = rig(healthy({ grants: [] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  // 清单重算是从授权行枚举的，所以这里连一条 entry 都不该有
  expect(inv.entries).toEqual([])
  expect(inv.fetchable).toEqual([])

  // 但「为什么这场会议这个程序取不到」必须答得出（spec §1.3）
  const entry = await explainMeetingAccess(deps, {
    programId: PROGRAM,
    meetingId: 'm-1',
    subMeetingId: '',
    now: NOW,
  })
  expect(entry.fetchable).toBe(false)
  expect(codes(entry)).toEqual(['not_granted'])
  expect(entry.blockers[0]!.remedy).toBe('grants')
})

test('缺「在保留期内」：本地已清理的会议不在清单里，理由是「本地已到期，请去 NAS 取」', async () => {
  const { deps } = rig(healthy({ archives: [archive('m-1', { localPurgedAt: NOW - DAY })] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  const entry = only(inv.entries, 'm-1')
  expect(codes(entry)).toEqual(['local_purged'])
  expect(entry.blockers[0]!.reason).toContain('本地已到期，请去 NAS 取')
  expect(entry.blockers[0]!.remedy).toBe('nas')
  // NAS 上那份还在，所以目录要说得出来——否则「去 NAS 取」是句空话
  expect(entry.blockers[0]!.reason).toContain('/nas/2026/06/m-1')
})

test('缺「规则允许」：规则判 deny 的会议不在清单里，理由说得出是哪条规则', async () => {
  const denyRule = rule({ id: 7, effect: 'deny', note: '财务会议一律不外放' })
  const { deps } = rig(healthy({ rules: [denyRule] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  const entry = only(inv.entries, 'm-1')
  expect(codes(entry)).toEqual(['rule_denied'])
  expect(entry.blockers[0]!.ruleId).toBe(7)
  expect(entry.blockers[0]!.note).toBe('财务会议一律不外放')
  expect(entry.blockers[0]!.remedy).toBe('rules')
})

test('三个都缺时三个理由都报，不是报第一个就停', async () => {
  const { deps } = rig({
    rules: [rule({ id: 9, effect: 'deny', note: '默认收紧' })],
    grants: [],
    archives: [archive('m-1', { localPurgedAt: NOW - DAY })],
    meetings: [meeting('m-1')],
  })

  const entry = await explainMeetingAccess(deps, {
    programId: PROGRAM,
    meetingId: 'm-1',
    subMeetingId: '',
    now: NOW,
  })
  expect(entry.fetchable).toBe(false)
  // 补上授权后还是取不到、补上保留期后还是取不到——只报第一个的话管理员要来回三趟
  expect(codes(entry).slice().sort()).toEqual(['local_purged', 'not_granted', 'rule_denied'])
  expect(new Set(entry.blockers.map((b) => b.remedy))).toEqual(new Set(['grants', 'nas', 'rules']))
})

// ── D-u：「在保留期内」= 本地文件还在，不是 expiresAt >= now ──────

test('窗口已过期但清理被暂停（local_purged_at 仍是 NULL）→ 仍然可取', async () => {
  // 30 天窗口，now 落在归档后第 100 天：expiresAt < now，但文件一个都没删
  const late = ARCHIVED_AT + 100 * DAY
  const { deps } = rig(healthy())
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: late })

  expect(inv.fetchable.map((e) => e.meetingId)).toEqual(['m-1'])
  // 到期时刻照样报出来，「几天算快到期」是调用方的事
  expect(only(inv.entries, 'm-1').expiresAt).toBe(ARCHIVED_AT + 30 * DAY)
})

test('还没归档但本地有 completed 资产 → 文件在，算数（expiresAt 尚未开始计时）', async () => {
  const { deps } = rig(healthy({ archives: [], localAssets: ['m-1'] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable.map((e) => e.meetingId)).toEqual(['m-1'])
  expect(only(inv.entries, 'm-1').expiresAt).toBeNull()
})

test('既没归档行、本地也没有 completed 资产 → 取不到，理由不是「去 NAS 取」', async () => {
  const { deps } = rig(healthy({ archives: [], localAssets: [] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  const entry = only(inv.entries, 'm-1')
  expect(codes(entry)).toEqual(['no_local_files'])
  // NAS 上也没有，让人去 NAS 取是把他支到一个空目录
  expect(entry.blockers[0]!.remedy).not.toBe('nas')
})

// ── D-v：expiresAt 必须把 extendedDays 算进去 ──────────────────

test('expiresAt 把 extendedDays 算进去——延长过保留期的会议不该被误报为即将到期', async () => {
  const { deps } = rig(healthy({ archives: [archive('m-1', { retentionDays: 30, extendedDays: 60 })] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(only(inv.entries, 'm-1').expiresAt).toBe(ARCHIVED_AT + 90 * DAY)
  // 漏掉 extendedDays 的话这里会是 +30 天，一场刚被延长 60 天的会议会显示成早就该到期
  expect(only(inv.entries, 'm-1').expiresAt).not.toBe(ARCHIVED_AT + 30 * DAY)
})

// ── D-x：人工改写 ────────────────────────────────────────────

test('人工改写把规则的 deny 翻成 allow → 进清单，且带改写标记', async () => {
  const { deps } = rig(
    healthy({
      rules: [rule({ id: 3, effect: 'deny', note: '默认收紧' })],
      overrides: [override('m-1', { assetTypes: ['transcript', 'ai_minutes'] })],
    }),
  )
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  const entry = only(inv.entries, 'm-1')
  expect(entry.fetchable).toBe(true)
  expect(entry.overridden).toBe(true)
  expect(entry.assetTypes).toEqual(['transcript', 'ai_minutes'])
  // 「若无这次改写规则本会判什么」不能丢——那是管理员最需要知道的半句话
  expect(entry.decision?.overriddenFrom?.effect).toBe('deny')
})

test('人工改写把规则的 allow 翻成 deny → 不进清单，且仍标成被改写过', async () => {
  const { deps } = rig(healthy({ overrides: [override('m-1', { effect: 'deny' })] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  const entry = only(inv.entries, 'm-1')
  expect(entry.overridden).toBe(true)
  expect(codes(entry)).toEqual(['rule_denied'])
})

test('改写的 effect 是脏数据时落到 deny，且照样算「被改写过」（不能写成 source === override）', async () => {
  const { deps } = rig(healthy({ overrides: [override('m-1', { effect: 'allwo' })] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  const entry = only(inv.entries, 'm-1')
  expect(entry.fetchable).toBe(false)
  expect(entry.decision?.source).toBe('override_invalid')
  expect(entry.overridden).toBe(true)
})

test('别的栈的改写不影响采集权限判定', async () => {
  const { deps } = rig(healthy({ overrides: [override('m-1', { kind: 'fetch', effect: 'skip' })] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  const entry = only(inv.entries, 'm-1')
  expect(entry.fetchable).toBe(true)
  expect(entry.overridden).toBe(false)
})

// ── D-y：资产类型三者求交 ────────────────────────────────────

test('授权的 asset_types 是白名单时与规则求交', async () => {
  const { deps } = rig(healthy({ grants: [grant('m-1', ['transcript', 'video'])] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(only(inv.entries, 'm-1').assetTypes).toEqual(['video', 'transcript'])
  expect(only(inv.entries, 'm-1').fetchable).toBe(true)
})

test('授权的 asset_types 是 NULL 时不额外限制，沿用规则的范围', async () => {
  const { deps } = rig(
    healthy({ rules: [rule({ assetTypes: ['ai_minutes'] })], grants: [grant('m-1', null)] }),
  )
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(only(inv.entries, 'm-1').assetTypes).toEqual(['ai_minutes'])
})

test('授权的 asset_types 是 [] 时什么都不授权，该会议不计进 N', async () => {
  const { deps } = rig(healthy({ grants: [grant('m-1', [])] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  const entry = only(inv.entries, 'm-1')
  expect(codes(entry)).toEqual(['grant_scope_empty'])
  expect(entry.assetTypes).toEqual([])
  expect(entry.blockers[0]!.remedy).toBe('grants')
})

test('授权里的资产名一个都不认识时，理由说的是「名字不认识」而不是「你填了空数组」', async () => {
  // 管理员照着原型抄了短名。范围确实收成了空集，但他对着一个非空的白名单，
  // 被告知「空数组」只会更糊涂——两种收法要说成两句话
  const { deps } = rig(healthy({ grants: [grant('m-1', ['summary', 'aitr'])] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  const entry = only(inv.entries, 'm-1')
  expect(codes(entry)).toEqual(['grant_scope_empty'])
  expect(entry.blockers[0]!.reason).toContain('summary')
  expect(entry.blockers[0]!.reason).not.toContain('空数组')
})

test('规则与授权的资产范围不相交 → 实际一类都取不到，不计进 N', async () => {
  const { deps } = rig(
    healthy({ rules: [rule({ assetTypes: ['video'] })], grants: [grant('m-1', ['transcript'])] }),
  )
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  expect(codes(only(inv.entries, 'm-1'))).toEqual(['grant_scope_empty'])
})

test('规则判 allow 但一个合法资产键都没有 → 与 isVisible 同源，不计进 N', async () => {
  // 原型里的短名不是合法资产键，normalizeAssetTypes 会把它们全丢掉
  const { deps } = rig(healthy({ rules: [rule({ id: 5, assetTypes: ['summary', 'aitr'] })] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  expect(codes(only(inv.entries, 'm-1'))).toEqual(['rule_denied'])
})

// ── 汇总：spec §4.5 那句蓝底的话 ──────────────────────────────

test('N 是求交之后的实际结果：授权 4 场只有 2 场真取得到', async () => {
  const { deps } = rig({
    rules: [rule({ assetTypes: ['ai_minutes', 'transcript'] })],
    grants: [grant('m-1'), grant('m-2'), grant('m-3'), grant('m-4')],
    archives: [
      archive('m-1'),
      archive('m-2'),
      archive('m-3', { localPurgedAt: NOW - DAY }), // 本地已清理
      archive('m-4'),
    ],
    meetings: [meeting('m-1'), meeting('m-2'), meeting('m-3'), meeting('m-4')],
    overrides: [override('m-4', { effect: 'deny', reason: '当事人要求撤回' })],
  })
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.entries).toHaveLength(4)
  expect(inv.fetchable.map((e) => e.meetingId)).toEqual(['m-1', 'm-2'])
  expect(inv.blocked.map((e) => e.meetingId)).toEqual(['m-3', 'm-4'])
  // 「4 场会议的 AI 纪要 + 完整转写」后半句：可取会议的资产类型并集
  expect(inv.assetTypes).toEqual(['transcript', 'ai_minutes'] as AssetKey[])
})

test('一个程序一场授权都没有时，清单是空的但不报错', async () => {
  const { deps, calls } = rig(healthy({ grants: [] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.entries).toEqual([])
  expect(inv.assetTypes).toEqual([])
  // 一场都没有就不该再去问归档、改写、会议元数据
  expect(calls.listMeetingArchives).toBe(0)
  expect(calls.listActiveOverridesForMeetings).toBe(0)
  expect(calls.getMeetings).toBe(0)
})

// ── 会议元数据缺失：判不出来就落到拒绝一侧 ──────────────────────

test('会议在 meetings 表里查不到 → 判不出来，落到拒绝一侧并说明', async () => {
  const { deps } = rig(healthy({ meetings: [] }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  const entry = only(inv.entries, 'm-1')
  expect(codes(entry)).toEqual(['meeting_unknown'])
  expect(entry.decision).toBeNull()
})

// ── T13 元数据不全：行是在的，但判不出来 ──────────────────────

/** 缺口的原样复现：按标题拒绝的高优先级规则 + 放行全部的低优先级规则 */
const T13_RULES: StackRule[] = [
  rule({ id: 1, priority: 200, effect: 'deny', note: '财务会议不外放',
    conds: [{ f: 'title', op: 'has', v: '财务' }] }),
  rule({ id: 2, priority: 50, effect: 'allow', note: '其余一律放行' }),
]

test('T13：标题在库里是 NULL 的会议不许被低优先级的 allow 放出去', async () => {
  const { deps } = rig(healthy({
    rules: T13_RULES,
    meetings: [meeting('m-1', { subject: '', missingFacts: ['title'] })],
  }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toEqual([])
  const entry = only(inv.entries, 'm-1')
  expect(entry.decision?.effect).toBe('deny')
  expect(entry.decision?.source).toBe('undecidable')
  expect(entry.assetTypes).toEqual([])
})

test('T13：理由报「行在、元数据不全」，不是「在 meetings 表里查不到」——对一行存在的记录那句话是假的', async () => {
  const { deps } = rig(healthy({
    rules: T13_RULES,
    meetings: [meeting('m-1', { subject: '', missingFacts: ['title'] })],
  }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })
  const entry = only(inv.entries, 'm-1')

  // 与「查不到」共用同一档 code（对管理员是同一件事：元数据有问题，不是规则做的决定）
  expect(codes(entry)).toEqual(['meeting_unknown'])
  const blocker = entry.blockers[0]!
  expect(blocker.gate).toBe('rule')
  expect(blocker.remedy).toBe('pipeline')
  // 但话不一样：说得出行是在的、是哪条规则判不出来
  expect(blocker.reason).toContain('有这一行')
  expect(blocker.reason).toContain('判不出来')
  expect(blocker.ruleId).toBe(1)
  // 判定本身留下来了（不是 null）——详情抽屉要拿它说话，而查不到的那种压根没跑过规则
  expect(entry.decision).not.toBeNull()
})

test('T13：元数据不全但规则用不到那项事实时，照常判定，不被牵连', async () => {
  const { deps } = rig(healthy({
    // 规则问的是主持人，缺的是标题
    rules: [rule({ id: 1, priority: 200, effect: 'allow', conds: [{ f: 'host', op: 'is', v: 'host-1' }] })],
    meetings: [meeting('m-1', { subject: '', missingFacts: ['title'] })],
  }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })
  expect(inv.fetchable.map((e) => e.meetingId)).toEqual(['m-1'])
})

test('T13：人工改写优先于所有规则——判不出来也一样被改写接管', async () => {
  const { deps } = rig(healthy({
    rules: T13_RULES,
    meetings: [meeting('m-1', { subject: '', missingFacts: ['title'] })],
    overrides: [override('m-1', { effect: 'allow', assetTypes: ['transcript'] })],
  }))
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })
  const entry = only(inv.entries, 'm-1')

  expect(entry.decision?.effect).toBe('allow')
  expect(entry.overridden).toBe(true)
  expect(entry.fetchable).toBe(true)
  // 改写接管之后就不再是「规则判不出来」了，那条 blocker 不该出现
  expect(codes(entry)).toEqual([])
})

// ── 批量：调用次数必须是常数级 ────────────────────────────────

test('给 200 场会议重算，store 的读法各只调一次——不是 O(N)', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `m-${i}`)
  const { deps, calls } = rig({
    rules: [rule()],
    grants: ids.map((id) => grant(id)),
    archives: ids.map((id) => archive(id)),
    meetings: ids.map((id) => meeting(id)),
  })
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toHaveLength(200)
  expect(calls.listEnabledStackRules).toBe(1)
  expect(calls.listActiveGrantsForProgram).toBe(1)
  expect(calls.listMeetingArchives).toBe(1)
  expect(calls.listActiveOverridesForMeetings).toBe(1)
  expect(calls.getMeetings).toBe(1)
  // 逐场 findActiveGrant 正是要防的那种 N+1
  expect(calls.findActiveGrant).toBe(0)
  // 有归档行的会议不必再问本地资产，一次都不用查
  expect(calls.listMeetingsWithCompletedAssets).toBe(0)
})

test('缺归档行的会议只用一次批量查询问清本地资产', async () => {
  const ids = Array.from({ length: 50 }, (_, i) => `m-${i}`)
  const { deps, calls } = rig({
    rules: [rule()],
    grants: ids.map((id) => grant(id)),
    archives: [],
    localAssets: ids,
    meetings: ids.map((id) => meeting(id)),
  })
  const inv = await computeProgramInventory(deps, { programId: PROGRAM, now: NOW })

  expect(inv.fetchable).toHaveLength(50)
  expect(calls.listMeetingsWithCompletedAssets).toBe(1)
})
