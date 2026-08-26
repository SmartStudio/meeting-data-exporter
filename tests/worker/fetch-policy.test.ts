/**
 * A7 · 拉取规则栈接线（阶段 4 · T12）的测试。
 *
 * 这一层要钉住的是**接线**，不是求值：三栈求值本身由 `tests/policy/stacks.test.ts`
 * 覆盖，人工改写由 `tests/policy/override.test.ts` 覆盖。所以这里用真的
 * `evaluateFetchStack` + 真的 `applyOverride`（打桩掉就等于把验收测没了），
 * 假的只有腾讯边界（`AssetSource`）与库（`Store`）。
 *
 * 四条验收判据各自对应下面的一组用例：
 *
 *   1. 兜底 skip 且说得出理由        → 「兜底与判不出来」一组
 *   2. 人工改写优先于所有规则        → 「人工改写」一组
 *   3. why.fetch 有真实来源          → tests/http/console-meetings.test.ts（另一层）
 *   4. 上线安全：规则集为空不停摆    → 「兼容模式」一组
 *
 * 另有一组「不许留下假账」：被规则排除的会议不去腾讯问资产、被排除的资产类型
 * 不留探测行。那是这次接线最容易做错、且做错了不会报错的地方。
 */
import { expect, test } from 'bun:test'
import type {
  AssetKey,
  AssetSource,
  Meeting as EngineMeeting,
  MeetingSelector,
  SourceAsset,
  Store,
} from '@yaowu/mde-engine'
import {
  FETCH_STACK_UNCONFIGURED_REASON,
  decideFetch,
  discoverWithFetchPolicy,
  fetchRulesInEffect,
  type FetchPolicyDeps,
} from '../../src/worker/fetch-policy'
import type { MeetingOverride } from '../../src/policy/override'
import type { StackRule } from '../../src/policy/stacks'
import { archiveStateKey } from '../../src/store/archives'

const NOW = 1_800_000_000
const START = NOW - 7200

/** worker 这一轮想要的资产类型。两类就够分辨「收窄」了 */
const KEYS: AssetKey[] = ['transcript', 'video']
const SEL: MeetingSelector = { kind: 'range', from: START - 86_400, to: NOW }

// ── 造数据 ────────────────────────────────────────────────────────────────

function meeting(over: Partial<EngineMeeting> = {}): EngineMeeting {
  return {
    meetingId: 'm-1',
    subMeetingId: '',
    meetingCode: '881-123-40',
    subject: '产品周会',
    hostUserId: 'u-1',
    startTime: START,
    endTime: START + 3600,
    ...over,
  }
}

function fetchRule(over: Partial<StackRule> = {}): StackRule {
  return {
    id: 10,
    kind: 'fetch',
    priority: 100,
    enabled: true,
    join: 'and',
    conds: [],
    effect: 'all',
    assetTypes: ['*'],
    subjectType: null,
    subjectValue: null,
    note: '全部拉取',
    ...over,
  }
}

function fetchOverride(over: Partial<MeetingOverride> = {}): MeetingOverride {
  return {
    meetingId: 'm-1',
    subMeetingId: '',
    kind: 'fetch',
    effect: 'skip',
    assetTypes: null,
    reason: '这场误录了',
    createdAt: NOW - 100,
    ...over,
  }
}

/** 网关 asset_type 的取值，不是客户端的 AssetKey（见引擎的 ASSET_KEY_TO_GATEWAY_TYPE） */
function sourceAsset(assetType: string): SourceAsset {
  return { assetId: `a-${assetType}`, assetType, remoteId: `f-${assetType}` }
}

const BOTH_ASSETS: SourceAsset[] = [sourceAsset('meeting_summary'), sourceAsset('video')]

// ── 假依赖 ────────────────────────────────────────────────────────────────

interface RigState {
  listMeetingsCalls: number
  listAssetCalls: string[]
  upsertedMeetings: string[]
  upsertedAssets: Array<{ meetingId: string; assetType: string }>
  probes: Array<{ meetingId: string; assetType: string }>
  warnings: string[]
  infos: string[]
}

interface Rig {
  deps: FetchPolicyDeps
  /** **整个对象**交出去，不摊平：`listMeetingsCalls` 是数字，摊平就永远是 0 */
  seen: RigState
}

function rig(opts: {
  meetings: EngineMeeting[]
  assets?: Record<string, SourceAsset[]>
  rules?: StackRule[]
  overrides?: MeetingOverride[]
  /** 已归档的会议键（`arch` 条件的数据源），用 meetingId 写就够 */
  archived?: string[]
}): Rig {
  const state: RigState = {
    listMeetingsCalls: 0,
    listAssetCalls: [] as string[],
    upsertedMeetings: [] as string[],
    upsertedAssets: [] as Array<{ meetingId: string; assetType: string }>,
    probes: [] as Array<{ meetingId: string; assetType: string }>,
    warnings: [] as string[],
    infos: [] as string[],
  }

  const gw: AssetSource = {
    async listMeetings() {
      state.listMeetingsCalls++
      return { meetings: opts.meetings, nextCursor: null }
    },
    async listAssets(meetingId) {
      state.listAssetCalls.push(meetingId)
      return opts.assets?.[meetingId] ?? BOTH_ASSETS
    },
    async getDownloadUrl() {
      throw new Error('getDownloadUrl 不该被发现阶段调用')
    },
  }

  // discover 在 keys 非空时只碰这五个写法，其余方法一律不该被调到——
  // 被调到就说明接线的形状变了，抛出来比静默返回 undefined 强
  const store = {
    async upsertMeeting(m: EngineMeeting) {
      state.upsertedMeetings.push(m.meetingId)
    },
    async upsertAsset(a: { meetingId: string; assetType: string }) {
      state.upsertedAssets.push({ meetingId: a.meetingId, assetType: a.assetType })
    },
    async markSkippedByKey() {},
    async upsertProbe(p: { meetingId: string; assetType: string }) {
      state.probes.push({ meetingId: p.meetingId, assetType: p.assetType })
    },
    async abandonProbe() {},
  } as unknown as Store

  const archivedSet = new Set((opts.archived ?? []).map((id) => archiveStateKey(id, '')))

  const deps: FetchPolicyDeps = {
    gw,
    store,
    archives: { listArchivedMeetingKeys: async () => archivedSet },
    listFetchRules: async () => opts.rules ?? [],
    listFetchOverrides: async () => opts.overrides ?? [],
    log: {
      warn: (m) => state.warnings.push(m),
      info: (m) => state.infos.push(m),
    },
  }

  return { deps, seen: state }
}

/** rig 里的数组是同一批引用，跑完直接读 */
async function run(r: Rig) {
  return discoverWithFetchPolicy(r.deps, SEL, KEYS, NOW)
}

// ── 兼容模式：规则集为空不许让归档链路静默停摆（验收 4）───────────────────

test('一条启用的拉取规则都没有时沿用接线前的行为（时间窗内全拉），不是一场都不拉', async () => {
  const r = rig({ meetings: [meeting()] })
  const out = await run(r)

  expect(out.fetchPolicy.mode).toBe('compat')
  expect(out.meetings).toBe(1)
  // 两类资产都入队 = 与接线前逐字相同的行为
  expect(out.tasks).toBe(2)
  expect(r.seen.upsertedAssets.map((a) => a.assetType).sort()).toEqual(['meeting_summary', 'video'])
})

test('兼容模式每轮都留一条醒目告警，说清「配了第一条规则会发生什么」', async () => {
  const r = rig({ meetings: [meeting()] })
  await run(r)

  const alarm = r.seen.warnings.join('\n')
  expect(alarm).toContain('拉取规则')
  // 运维读了要知道两件事：现在按兼容模式跑，以及建下第一条规则那一刻兜底会翻面
  expect(alarm).toContain('兼容')
  expect(alarm).toContain('skip')
})

test('兼容模式不是「绕过整栈」：人工改写照样优先，关掉的会议仍然不拉', async () => {
  const r = rig({ meetings: [meeting()], overrides: [fetchOverride({ effect: 'skip' })] })
  const out = await run(r)

  expect(out.fetchPolicy.mode).toBe('compat')
  expect(out.fetchPolicy.skipped).toBe(1)
  expect(out.tasks).toBe(0)
  expect(r.seen.listAssetCalls).toEqual([])
})

test('fetchRulesInEffect：库里有规则就用库里的，一条都没有才给出兼容兜底', () => {
  const real = [fetchRule()]
  expect(fetchRulesInEffect(real)).toEqual(real)

  const compat = fetchRulesInEffect([])
  expect(compat).toHaveLength(1)
  expect(compat[0]?.effect).toBe('all')
  expect(compat[0]?.kind).toBe('fetch')
})

// ── 兜底与判不出来（验收 1）────────────────────────────────────────────────

test('配了规则但一条都不匹配 → 兜底 skip，且理由说得出是兜底', async () => {
  const r = rig({
    meetings: [meeting({ subject: '面试' })],
    rules: [fetchRule({ conds: [{ f: 'title', op: 'has', v: '周会' }] })],
  })
  const out = await run(r)

  expect(out.fetchPolicy.mode).toBe('governed')
  expect(out.fetchPolicy.skipped).toBe(1)
  expect(out.tasks).toBe(0)
  expect(r.seen.warnings.join('\n')).toContain('兜底')
})

test('兜底 skip 的会议照样进 meetings 表——界面上要看得出它为什么没被拉', async () => {
  const r = rig({
    meetings: [meeting({ subject: '面试' })],
    rules: [fetchRule({ conds: [{ f: 'title', op: 'has', v: '周会' }] })],
  })
  await run(r)

  expect(r.seen.upsertedMeetings).toEqual(['m-1'])
})

test('元数据不全 → 落到 fetch 栈的安全侧 skip，且说得出是判不出来（T13 那条路径）', () => {
  const rules = [fetchRule({ conds: [{ f: 'title', op: 'has', v: '周会' }] })]
  const d = decideFetch(rules, meeting({ subject: null }), false, null, NOW)

  expect(d.effect).toBe('skip')
  expect(d.source).toBe('undecidable')
  expect(d.reason).toContain('判不出来')
})

test('判不出来的会议在一轮的统计里与「规则说不拉」分开数', async () => {
  const r = rig({
    meetings: [meeting({ subject: null })],
    rules: [fetchRule({ conds: [{ f: 'title', op: 'has', v: '周会' }] })],
  })
  const out = await run(r)

  expect(out.fetchPolicy.skipped).toBe(1)
  expect(out.fetchPolicy.undecidable).toBe(1)
})

test('effect 是脏数据的规则也落到 skip，不往下找', () => {
  const rules = [fetchRule({ id: 7, effect: 'allw' })]
  const d = decideFetch(rules, meeting(), false, null, NOW)

  expect(d.effect).toBe('skip')
  expect(d.source).toBe('rule_invalid')
})

// ── 人工改写优先于所有规则（验收 2）──────────────────────────────────────

test('规则判 all、改写判 skip → 不拉，理由记在改写头上', async () => {
  const r = rig({
    meetings: [meeting()],
    rules: [fetchRule()],
    overrides: [fetchOverride({ effect: 'skip' })],
  })
  const out = await run(r)

  expect(out.tasks).toBe(0)
  expect(out.fetchPolicy.skipped).toBe(1)
  expect(r.seen.warnings.join('\n')).toContain('这场误录了')
})

test('规则判 skip、改写判 all → 拉，与归档那条路径同源（applyOverride）', async () => {
  const r = rig({
    meetings: [meeting({ subject: '面试' })],
    rules: [fetchRule({ conds: [{ f: 'title', op: 'has', v: '周会' }] })],
    overrides: [fetchOverride({ effect: 'all', assetTypes: ['*'] })],
  })
  const out = await run(r)

  expect(out.tasks).toBe(2)
  expect(out.fetchPolicy.skipped).toBe(0)
})

test('别的栈的改写不许顺手改变拉取判定', async () => {
  const r = rig({
    meetings: [meeting()],
    rules: [fetchRule()],
    overrides: [fetchOverride({ kind: 'archive', effect: 'skip' })],
  })
  const out = await run(r)

  expect(out.tasks).toBe(2)
})

// ── 不许留下假账 ──────────────────────────────────────────────────────────

test('规则判 skip 的会议根本不去腾讯问资产', async () => {
  const r = rig({
    meetings: [meeting({ meetingId: 'm-yes' }), meeting({ meetingId: 'm-no', subject: '面试' })],
    rules: [fetchRule({ conds: [{ f: 'title', op: 'has', v: '周会' }] })],
  })
  await run(r)

  expect(r.seen.listAssetCalls).toEqual(['m-yes'])
})

test('规则收窄资产范围时，被排除的类型既不入队也不留探测行', async () => {
  const r = rig({
    meetings: [meeting()],
    rules: [fetchRule({ assetTypes: ['transcript'] })],
  })
  const out = await run(r)

  expect(out.tasks).toBe(1)
  expect(r.seen.upsertedAssets).toEqual([{ meetingId: 'm-1', assetType: 'meeting_summary' }])
  // 探测行是「平台还没产出，等它」的意思。给一个规则明确排除掉的类型留探测行，
  // 等于在库里记一笔永远不会兑现的账，最后还会被记成 upstream_timeout——那是假的
  expect(r.seen.probes).toEqual([])
  expect(out.fetchPolicy.narrowed).toBe(1)
})

test('规则列出的资产类型超出本轮 --assets 范围时按交集算，规则不能越过命令行放大范围', async () => {
  const r = rig({ meetings: [meeting()], rules: [fetchRule({ assetTypes: ['*'] })] })
  const out = await discoverWithFetchPolicy(r.deps, SEL, ['transcript'], NOW)

  expect(out.tasks).toBe(1)
  expect(r.seen.upsertedAssets).toEqual([{ meetingId: 'm-1', assetType: 'meeting_summary' }])
})

test('资产范围不同的会议分组各跑一遍发现，但只向腾讯要一次会议列表', async () => {
  const r = rig({
    meetings: [
      meeting({ meetingId: 'm-all', subject: '产品周会' }),
      meeting({ meetingId: 'm-text', subject: '客户访谈' }),
    ],
    rules: [
      fetchRule({ id: 1, priority: 200, conds: [{ f: 'title', op: 'has', v: '周会' }] }),
      fetchRule({ id: 2, priority: 100, assetTypes: ['transcript'] }),
    ],
  })
  const out = await run(r)

  expect(r.seen.listMeetingsCalls).toBe(1)
  expect(out.tasks).toBe(3)
  expect(r.seen.upsertedAssets.filter((a) => a.meetingId === 'm-text')).toEqual([
    { meetingId: 'm-text', assetType: 'meeting_summary' },
  ])
})

test('arch 条件的事实是查出来的，不是在调用点填 false', async () => {
  const r = rig({
    meetings: [meeting({ meetingId: 'm-old' }), meeting({ meetingId: 'm-new' })],
    rules: [fetchRule({ conds: [{ f: 'arch', op: 'notarch' }] })],
    archived: ['m-old'],
  })
  await run(r)

  expect(r.seen.listAssetCalls).toEqual(['m-new'])
})

// ── 与控制台共用同一句话 ──────────────────────────────────────────────────

test('未配置拉取规则的那句解释是一份，worker 与控制台读同一个常量', () => {
  expect(FETCH_STACK_UNCONFIGURED_REASON).toContain('拉取规则')
  expect(FETCH_STACK_UNCONFIGURED_REASON.length).toBeGreaterThan(20)
})
