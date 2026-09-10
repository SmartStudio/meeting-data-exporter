/**
 * 程序级自动授权（方案 2 · 定时任务五）。
 *
 * 这是**授权中枢里唯一一段没有人在场的写入**：它往 `meeting_grants` 里写的是真的
 * 授权行，写错的后果是外部程序取到了本不该给它的会议，而界面上一切正常
 * （那些行与人点出来的一模一样）。所以本文件盯的不是「功能能不能跑通」，
 * 是**每一条不该授权的路径都真的没授权**：
 *
 *   规则不放行 / 元数据缺失 / 程序停用 / 人工撤销过 / 已有生效授权
 *
 * 分两层：
 *
 *   - `planAutoGrants` 是纯函数，逐条规矩在内存里构造原料断言，不碰库；
 *   - `runAutoGrantRound` 在**真库**上跑一遍——授权行、审计行、幂等、
 *     以及「人工撤销之后不再补回」这条只有在真库上才验得了的时序。
 */
import { expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import {
  AUTO_GRANT_ACTOR_ID,
  planAutoGrants,
  runAutoGrantRound,
  type AutoGrantDeps,
  type AutoGrantMaterial,
} from '../../src/worker/auto-grant'
import { archiveStateKey, createArchivesStore } from '../../src/store/archives'
import { createGrantsStore, type MeetingKey } from '../../src/store/grants'
import { createPolicyStore } from '../../src/store/policy'
import { createProgramsStore } from '../../src/store/programs'
import { createAuditStore } from '../../src/store/audit'
import type { MeetingMeta } from '../../src/policy/access'
import type { MeetingOverride as PolicyOverride } from '../../src/policy/override'
import type { StackRule } from '../../src/policy/stacks'
import type { MeetingArchiveRecord } from '../../src/store/archives'
import type { Pool } from '../../src/store/db'
import type { RowDataPacket } from 'mysql2'
import { insertPolicyRule } from '../http/testApp'

const PROGRAM = 'kb-indexer'
/** 2026-06-01T00:00:00Z */
const NOW = Date.UTC(2026, 5, 1) / 1000

// ── 造原料 ────────────────────────────────────────────────────

function meta(meetingId: string, over: Partial<MeetingMeta> = {}): MeetingMeta {
  return {
    meetingId,
    subMeetingId: '',
    meetingRecordId: `rec-${meetingId}`,
    recordType: 0,
    meetingCode: '881-108-71',
    subject: `会议 ${meetingId}`,
    hostUserId: 'host-1',
    startTime: NOW - 40 * 86_400,
    endTime: NOW - 40 * 86_400 + 3600,
    state: 'completed',
    ...over,
  }
}

function allowRule(over: Partial<StackRule> = {}): StackRule {
  return {
    id: 5,
    kind: 'allow',
    priority: 100,
    enabled: true,
    effect: 'allow',
    assetTypes: ['video', 'transcript'],
    join: 'and',
    conds: [],
    subjectType: 'program',
    subjectValue: PROGRAM,
    note: null,
    ...over,
  }
}

function material(over: Partial<AutoGrantMaterial> = {}): AutoGrantMaterial {
  return {
    programId: PROGRAM,
    autoGrantAssetTypes: null,
    now: NOW,
    meetings: [{ meetingId: 'm-1', subMeetingId: '' }],
    rules: [allowRule()],
    overrides: [],
    meta: [meta('m-1')],
    archives: [],
    grantedKeys: new Set<string>(),
    revokedKeys: new Set<string>(),
    ...over,
  }
}

const key = (id: string, sub = ''): string => archiveStateKey(id, sub)

// ── planAutoGrants：逐条规矩 ──────────────────────────────────

test('规则放行 → 进 toGrant，并带上判定理由（那句话直接进审计）', () => {
  const plan = planAutoGrants(material())
  expect(plan.toGrant).toHaveLength(1)
  expect(plan.toGrant[0]!.meetingId).toBe('m-1')
  expect(plan.toGrant[0]!.ruleId).toBe(5)
  // 理由不是这一层现拼的，是判定引擎自己给的原话——两处各拼一句早晚会说得不一样
  expect(plan.toGrant[0]!.reason).toContain('准许采集')
  expect(plan.toGrant[0]!.assetTypes).toEqual(['video', 'transcript'])
  expect(plan.candidates).toBe(1)
})

test('规则判 deny → 不授权，计 ruleDenied', () => {
  const plan = planAutoGrants(material({ rules: [allowRule({ effect: 'deny' })] }))
  expect(plan.toGrant).toEqual([])
  expect(plan.ruleDenied).toBe(1)
  expect(plan.candidates).toBe(0)
})

test('一条规则都没有 → 兜底 deny，不授权', () => {
  // allow 栈的兜底是拒绝。规则表空着时自动授权一场都不该写出去
  const plan = planAutoGrants(material({ rules: [] }))
  expect(plan.toGrant).toEqual([])
  expect(plan.ruleDenied).toBe(1)
})

test('规则准许但一个合法资产键都没列出 → 不授权（isVisible 的另一半）', () => {
  // effect='allow' 而 asset_types 全是原型里的短名时，判定是 allow 而实际一类都取不到。
  // 把它授权出去等于在没有任何可取内容的前提下把这场会议登记进授权表
  const plan = planAutoGrants(material({ rules: [allowRule({ assetTypes: ['summary'] })] }))
  expect(plan.toGrant).toEqual([])
  expect(plan.ruleDenied).toBe(1)
})

test('人工改写把 deny 翻成 allow → 照样授权（改写优先于所有规则）', () => {
  const override: PolicyOverride = {
    meetingId: 'm-1',
    subMeetingId: '',
    kind: 'allow',
    effect: 'allow',
    assetTypes: ['transcript'],
    reason: '法务批准',
    createdAt: NOW - 100,
  }
  const plan = planAutoGrants(
    material({ rules: [allowRule({ effect: 'deny' })], overrides: [override] }),
  )
  expect(plan.toGrant).toHaveLength(1)
  expect(plan.toGrant[0]!.assetTypes).toEqual(['transcript'])
  expect(plan.toGrant[0]!.reason).toContain('人工改写')
})

test('人工改写把 allow 翻成 deny → 不授权', () => {
  const override: PolicyOverride = {
    meetingId: 'm-1',
    subMeetingId: '',
    kind: 'allow',
    effect: 'deny',
    assetTypes: null,
    reason: '这场不许',
    createdAt: NOW - 100,
  }
  const plan = planAutoGrants(material({ overrides: [override] }))
  expect(plan.toGrant).toEqual([])
  expect(plan.ruleDenied).toBe(1)
})

test('别的会议的改写不许盖到这一场上（改写要按会议归位）', () => {
  const override: PolicyOverride = {
    meetingId: 'm-other',
    subMeetingId: '',
    kind: 'allow',
    effect: 'deny',
    assetTypes: null,
    reason: '别人的改写',
    createdAt: NOW - 100,
  }
  const plan = planAutoGrants(material({ overrides: [override] }))
  expect(plan.toGrant).toHaveLength(1)
})

test('已有生效授权 → 跳过（不能每轮重调 grant，那会把人工收窄过的范围改回去）', () => {
  const plan = planAutoGrants(material({ grantedKeys: new Set([key('m-1')]) }))
  expect(plan.toGrant).toEqual([])
  expect(plan.skippedGranted).toBe(1)
  // 已经授权的不算「候选」——它不在「还该给谁」这个问题的答案里
  expect(plan.candidates).toBe(0)
})

test('人工撤销过 → 跳过，计 skippedRevoked（人的决定压过开关）', () => {
  const plan = planAutoGrants(material({ revokedKeys: new Set([key('m-1')]) }))
  expect(plan.toGrant).toEqual([])
  expect(plan.skippedRevoked).toBe(1)
  // 它仍然算一场候选：摘要里 candidates 与 granted 的差额就是「被人撤过所以没补回」
  expect(plan.candidates).toBe(1)
})

test('元数据缺失 → 跳过，计 meetingUnknown，绝不静默放行', () => {
  const plan = planAutoGrants(material({ meta: [] }))
  expect(plan.toGrant).toEqual([])
  expect(plan.meetingUnknown).toBe(1)
  expect(plan.candidates).toBe(0)
  // 元数据缺失不该被算成「规则拒绝」：两件事的处理方式完全不同
  expect(plan.ruleDenied).toBe(0)
})

test('元数据不全（missingFacts）时规则判不出来 → 落到不授权一侧', () => {
  const plan = planAutoGrants(
    material({
      // 规则按标题匹配，而这场会议的标题恰好是缺的那一项
      rules: [allowRule({ conds: [{ f: 'title', op: 'has', v: '财务' }] })],
      meta: [meta('m-1', { subject: '', missingFacts: ['title'] })],
    }),
  )
  expect(plan.toGrant).toEqual([])
  expect(plan.ruleDenied).toBe(1)
})

test('规则的主体是别的程序时不匹配 → 兜底 deny，不授权', () => {
  const plan = planAutoGrants(material({ rules: [allowRule({ subjectValue: 'other-prog' })] }))
  expect(plan.toGrant).toEqual([])
})

test('多场会议：各判各的，顺序与候选顺序一致（审计因此可对账）', () => {
  const plan = planAutoGrants(
    material({
      meetings: [
        { meetingId: 'm-a', subMeetingId: '' },
        { meetingId: 'm-b', subMeetingId: '' },
        { meetingId: 'm-c', subMeetingId: '' },
      ],
      meta: [meta('m-a'), meta('m-b'), meta('m-c')],
      grantedKeys: new Set([key('m-b')]),
      revokedKeys: new Set([key('m-c')]),
    }),
  )
  expect(plan.toGrant.map((i) => i.meetingId)).toEqual(['m-a'])
  expect(plan.candidates).toBe(2)
  expect(plan.skippedGranted).toBe(1)
  expect(plan.skippedRevoked).toBe(1)
})

test('周期性会议的场次各判各的：撤过 s-1 不影响 s-2', () => {
  const plan = planAutoGrants(
    material({
      meetings: [
        { meetingId: 'm-r', subMeetingId: 's-1' },
        { meetingId: 'm-r', subMeetingId: 's-2' },
      ],
      meta: [meta('m-r', { subMeetingId: 's-1' }), meta('m-r', { subMeetingId: 's-2' })],
      revokedKeys: new Set([key('m-r', 's-1')]),
    }),
  )
  expect(plan.toGrant.map((i) => i.subMeetingId)).toEqual(['s-2'])
})

test('autoGrantAssetTypes 不参与判定——它只是待会儿写进授权行的范围', () => {
  // 拿它去筛会议就等于凭空多出一条谁都没写过的规则
  const narrow = planAutoGrants(material({ autoGrantAssetTypes: ['ai_minutes'] }))
  // 规则放行的是 video / transcript，与这个白名单毫无交集，但判定不变
  expect(narrow.toGrant).toHaveLength(1)
  expect(narrow.toGrant[0]!.assetTypes).toEqual(['video', 'transcript'])
})

test('归档行只用来答 arch 条件（isarch / notarch），不再判一次保留期', () => {
  const archived: MeetingArchiveRecord = {
    meetingId: 'm-1',
    subMeetingId: '',
    nasDir: '/nas/m-1',
    archivedAt: NOW - 10 * 86_400,
    retentionDays: 30,
    extendedDays: 0,
    localPurgedAt: null,
  }
  const rules = [allowRule({ conds: [{ f: 'arch', op: 'isarch' }] })]
  expect(planAutoGrants(material({ rules })).toGrant).toEqual([])
  expect(planAutoGrants(material({ rules, archives: [archived] })).toGrant).toHaveLength(1)
})

// ── runAutoGrantRound：真库 ───────────────────────────────────

interface Rig {
  deps: AutoGrantDeps
  pool: Pool
}

function rigOf(pool: Pool, metas: readonly MeetingMeta[]): Rig {
  return {
    pool,
    deps: {
      programs: createProgramsStore(pool),
      policy: createPolicyStore(pool),
      grants: createGrantsStore(pool),
      archives: createArchivesStore(pool),
      // 与清单重算同一条约定：查不到的会议**不造空壳顶上**
      getMeetings: async (keys: readonly MeetingKey[]) =>
        metas.filter((m) =>
          keys.some((k) => k.meetingId === m.meetingId && k.subMeetingId === m.subMeetingId),
        ),
      audit: createAuditStore(pool),
    },
  }
}

async function seedProgram(
  pool: Pool,
  opts: { id?: string; enabled?: boolean; autoGrant?: boolean; assetTypes?: string[] | null } = {},
): Promise<string> {
  const id = opts.id ?? PROGRAM
  const programs = createProgramsStore(pool)
  await programs.create({
    id,
    name: `程序 ${id}`,
    secretHash: 'not-a-real-hash',
    tmUserId: `tm-${id}`,
    expiresAt: null,
    now: 0,
  })
  if (opts.enabled === false) await programs.setEnabled(id, false)
  if (opts.autoGrant !== false) {
    await programs.setAutoGrant(id, {
      enabled: opts.autoGrant ?? true,
      assetTypes: opts.assetTypes ?? null,
    })
  }
  return id
}

/** 一条本地还有 completed 资产的会议——「文件还在本地」的第二种来源 */
async function seedLocalAsset(pool: Pool, meetingId: string, subMeetingId = ''): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path,
        bytes_written, created_at, updated_at)
     VALUES (?, ?, 'video', ?, 'mp4', 'completed', '2026/06/d/v.mp4', 1, 0, 0)`,
    [meetingId, subMeetingId, `r-${meetingId}-${subMeetingId}`],
  )
}

async function auditRows(pool: Pool): Promise<RowDataPacket[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT actor_type, actor_id, action, meeting_id, asset_id, matched_rule, detail
       FROM audit_log ORDER BY id`,
  )
  return rows
}

test('真库一轮：写授权行 + 一条 actor_type=system 的审计', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool, { assetTypes: ['transcript'] })
    await insertPolicyRule(pool, {
      priority: 100, programId: PROGRAM, assetTypes: ['video', 'transcript'],
      effect: 'allow', note: '知识库全量',
    })
    await seedLocalAsset(pool, 'm-1')

    const { deps } = rigOf(pool, [meta('m-1')])
    const round = await runAutoGrantRound(deps, NOW)

    expect(round.granted).toBe(1)
    expect(round.failedPrograms).toBe(0)
    expect(round.failures).toEqual([])
    expect(round.programs).toEqual([
      { programId: PROGRAM, name: `程序 ${PROGRAM}`, candidates: 1, granted: 1, skippedRevoked: 0 },
    ])

    // 授权行是真的，而且带着**开关上那个范围**，不是判定算出来的那一份
    const g = await createGrantsStore(pool).findActiveGrant('m-1', '', PROGRAM)
    expect(g?.assetTypes).toEqual(['transcript'])
    expect(g?.grantedAt).toBe(NOW)

    const rows = await auditRows(pool)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor_type).toBe('system')
    expect(rows[0]!.actor_id).toBe(AUTO_GRANT_ACTOR_ID)
    expect(rows[0]!.action).toBe('auto_grant_meeting')
    expect(rows[0]!.meeting_id).toBe('m-1')
    expect(rows[0]!.asset_id).toBe(PROGRAM)
    // 放行的是哪条规则要留住：事后「这场会议凭什么被自动授权」只有这一个凭据
    expect(Number(rows[0]!.matched_rule)).toBeGreaterThan(0)
    const detail = String(rows[0]!.detail)
    expect(detail).toContain('自动授权给采集程序')
    expect(detail).toContain('知识库全量')
    expect(detail).toContain('准许采集')
  } finally {
    await cleanup()
  }
})

test('第二轮幂等：granted = 0，不重复写授权行也不重复记审计', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool)
    await insertPolicyRule(pool, {
      priority: 100, programId: PROGRAM, assetTypes: ['video'], effect: 'allow',
    })
    await seedLocalAsset(pool, 'm-1')

    const { deps } = rigOf(pool, [meta('m-1')])
    expect((await runAutoGrantRound(deps, NOW)).granted).toBe(1)

    const second = await runAutoGrantRound(deps, NOW + 300)
    expect(second.granted).toBe(0)
    // 已经授权的不算候选——它不在「还该给谁」这个问题的答案里
    expect(second.programs[0]?.candidates).toBe(0)

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM meeting_grants`,
    )
    expect(Number(rows[0]!.n)).toBe(1)
    expect(await auditRows(pool)).toHaveLength(1)
  } finally {
    await cleanup()
  }
})

test('人工撤销之后第三轮**不补回**——人的决定压过开关', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool)
    await insertPolicyRule(pool, {
      priority: 100, programId: PROGRAM, assetTypes: ['video'], effect: 'allow',
    })
    await seedLocalAsset(pool, 'm-1')

    const { deps } = rigOf(pool, [meta('m-1')])
    const grants = createGrantsStore(pool)
    expect((await runAutoGrantRound(deps, NOW)).granted).toBe(1)

    // 管理员撤销。规则没变、文件还在、开关还开着——只有「人撤过」这一件事变了
    expect(await grants.revoke('m-1', '', PROGRAM, NOW + 100)).toBe(true)

    const third = await runAutoGrantRound(deps, NOW + 600)
    expect(third.granted).toBe(0)
    expect(third.skippedRevoked).toBe(1)
    expect(third.programs[0]).toEqual({
      programId: PROGRAM,
      name: `程序 ${PROGRAM}`,
      // 规则本来会放行它，差额就是「被人撤过所以没补回」
      candidates: 1,
      granted: 0,
      skippedRevoked: 1,
    })
    expect(await grants.findActiveGrant('m-1', '', PROGRAM)).toBeNull()
    // 没有第二条审计：这一轮什么都没写
    expect(await auditRows(pool)).toHaveLength(1)
  } finally {
    await cleanup()
  }
})

test('程序停用 → 整个程序跳过，一行都不写', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool, { enabled: false })
    await insertPolicyRule(pool, {
      priority: 100, programId: PROGRAM, assetTypes: ['video'], effect: 'allow',
    })
    await seedLocalAsset(pool, 'm-1')

    const { deps } = rigOf(pool, [meta('m-1')])
    const round = await runAutoGrantRound(deps, NOW)
    // 摘要里连这个程序都不该出现：它这一轮压根没被考察
    expect(round.programs).toEqual([])
    expect(round.granted).toBe(0)
    expect(await createGrantsStore(pool).findActiveGrant('m-1', '', PROGRAM)).toBeNull()
  } finally {
    await cleanup()
  }
})

test('开关关着的程序整个跳过', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool, { autoGrant: false })
    await insertPolicyRule(pool, {
      priority: 100, programId: PROGRAM, assetTypes: ['video'], effect: 'allow',
    })
    await seedLocalAsset(pool, 'm-1')

    const round = await runAutoGrantRound(rigOf(pool, [meta('m-1')]).deps, NOW)
    expect(round.programs).toEqual([])
    expect(await auditRows(pool)).toEqual([])
  } finally {
    await cleanup()
  }
})

test('本地文件已清理的会议不进候选——那种会议此刻一个字节都取不到', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool)
    await insertPolicyRule(pool, {
      priority: 100, programId: PROGRAM, assetTypes: ['video'], effect: 'allow',
    })
    const archives = createArchivesStore(pool)
    await archives.upsertMeetingArchive({
      meetingId: 'm-purged', subMeetingId: '', nasDir: '/nas/m-purged',
      archivedAt: NOW - 60 * 86_400, retentionDays: 30, now: 0,
    })
    await archives.markLocalPurged('m-purged', '', NOW - 100)

    const round = await runAutoGrantRound(rigOf(pool, [meta('m-purged')]).deps, NOW)
    expect(round.granted).toBe(0)
    expect(round.programs[0]?.candidates).toBe(0)
  } finally {
    await cleanup()
  }
})

test('一个程序抛错不拖垮整轮：另一个照写，抛错那个进 failures', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool, { id: 'p-bad' })
    await seedProgram(pool, { id: 'p-good' })
    for (const id of ['p-bad', 'p-good']) {
      await insertPolicyRule(pool, {
        priority: 100, programId: id, assetTypes: ['video'], effect: 'allow',
      })
    }
    await seedLocalAsset(pool, 'm-1')

    const { deps } = rigOf(pool, [meta('m-1')])
    const real = deps.grants.listRevokedMeetingKeysForProgram.bind(deps.grants)
    const broken: AutoGrantDeps = {
      ...deps,
      grants: {
        ...deps.grants,
        listRevokedMeetingKeysForProgram: async (id: string) => {
          if (id === 'p-bad') throw new Error('撤销历史读不到')
          return real(id)
        },
      },
    }

    const round = await runAutoGrantRound(broken, NOW)
    expect(round.failedPrograms).toBe(1)
    expect(round.failures).toEqual([
      { programId: 'p-bad', name: '程序 p-bad', reason: '撤销历史读不到' },
    ])
    // 另一个程序的授权照样写出去了——把整轮标红会让「这一个程序有问题」
    // 变成「自动授权坏了」
    expect(round.granted).toBe(1)
    expect(await createGrantsStore(pool).findActiveGrant('m-1', '', 'p-good')).not.toBeNull()
  } finally {
    await cleanup()
  }
})

test('一个程序都没开自动授权时，一次会议查询都不发', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool, { autoGrant: false })
    const { deps } = rigOf(pool, [])
    let asked = 0
    const counted: AutoGrantDeps = {
      ...deps,
      archives: {
        ...deps.archives,
        listMeetingKeysWithLocalFiles: async () => {
          asked++
          return []
        },
      },
    }
    expect((await runAutoGrantRound(counted, NOW)).programs).toEqual([])
    // 「一个都没开」是这个开关的常态，那几条查询白跑一辈子
    expect(asked).toBe(0)
  } finally {
    await cleanup()
  }
})

test('开了开关但一场候选会议都没有：程序仍然逐行列在摘要里（全 0）', async () => {
  // 空数组会让「没开开关」与「开了但没有会议」在运行记录里长得一模一样
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool)
    const round = await runAutoGrantRound(rigOf(pool, []).deps, NOW)
    expect(round.programs).toEqual([
      { programId: PROGRAM, name: `程序 ${PROGRAM}`, candidates: 0, granted: 0, skippedRevoked: 0 },
    ])
  } finally {
    await cleanup()
  }
})

test('会议元数据查不到时不授权，也不抛——授权行不该指着一场不存在的会议', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedProgram(pool)
    await insertPolicyRule(pool, {
      priority: 100, programId: PROGRAM, assetTypes: ['video'], effect: 'allow',
    })
    await seedLocalAsset(pool, 'm-ghost')

    // getMeetings 一条都不返回（元数据还没补上）
    const round = await runAutoGrantRound(rigOf(pool, []).deps, NOW)
    expect(round.granted).toBe(0)
    expect(round.failedPrograms).toBe(0)
    expect(await auditRows(pool)).toEqual([])
  } finally {
    await cleanup()
  }
})
