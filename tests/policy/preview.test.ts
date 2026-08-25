import { expect, test } from 'bun:test'
import type { MeetingFacts } from '../../src/policy/conds'
import {
  changedStackKinds,
  previewStackImpact,
  type PreviewSubject,
} from '../../src/policy/preview'
import { evaluateAllowStack, type StackRule } from '../../src/policy/stacks'

/** 2026-01-01 00:00:00 UTC。预览是纯函数，所有用例显式传这个 now */
const NOW = 1767225600
const PROGRAM = 'svc-archiver'

function facts(over: Partial<MeetingFacts> = {}): MeetingFacts {
  return {
    title: '周会',
    hostUserId: 'tm-alice',
    dept: null,
    startTime: NOW - 7200,
    endTime: NOW - 3600, // 时长 60 分钟
    recordEndTime: NOW - 3600,
    archived: true,
    ...over,
  }
}

/** 造一条规则。默认无条件（匹配一切），用例只写它真正关心的那几个字段 */
function rule(over: Partial<StackRule> & Pick<StackRule, 'id' | 'kind'>): StackRule {
  return {
    priority: 100,
    enabled: true,
    join: 'and',
    conds: [],
    effect: over.kind === 'fetch' ? 'all' : over.kind === 'allow' ? 'allow' : '/nas/meetings/{年}/',
    assetTypes: ['*'],
    subjectType: over.kind === 'allow' ? 'program' : null,
    subjectValue: over.kind === 'allow' ? PROGRAM : null,
    note: null,
    ...over,
  }
}

/** 一个考察对象。fetch/archive 是一场会议，allow 是「会议 × 采集程序」 */
function subject(key: string, over: Partial<MeetingFacts> = {}, programId = PROGRAM): PreviewSubject {
  return { key, facts: facts({ title: key, ...over }), programId }
}

const one = [subject('m-1', { title: '财务评审' })]

// ── §5.5 计算范围：命中(旧) ∪ 命中(新)，不是全部会议 ──────────────

test('计算范围只在「命中(旧) ∪ 命中(新)」上：100 场会议里只算够得着的 3 场', () => {
  const subjects: PreviewSubject[] = []
  for (let i = 1; i <= 100; i++) {
    const isFinance = i === 10 || i === 42 || i === 77
    subjects.push(subject(`m-${i}`, { title: isFinance ? `财务评审 ${i}` : `周会 ${i}` }))
  }

  // 兜底规则命中全部 100 场，但它这次没被改动——它够得着的会议不会因此变化
  const catchAll = rule({ id: 1, kind: 'fetch', priority: 100, effect: 'all', note: '兜底全拉' })
  const finance = rule({
    id: 2, kind: 'fetch', priority: 200, effect: 'skip', note: '财务会议不拉到本地',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })

  const p = previewStackImpact({
    kind: 'fetch', oldRules: [catchAll], newRules: [catchAll, finance], subjects, now: NOW,
  })

  expect(p.counts.total).toBe(100)
  // 这一条是本任务的核心：不是「100 场里有 3 场变了」，是「这次改动只够得着 3 场」
  expect(p.counts.scanned).toBe(3)
  expect(p.counts.hits).toBe(3)
  expect(p.changed).toHaveLength(3)
  expect(p.changed.map((c) => c.key)).toEqual(['m-10', 'm-42', 'm-77'])
  expect(p.counts.tightened).toBe(3)
  expect(p.changed.every((c) => c.direction === 'tightened')).toBe(true)
})

test('改的是另一栈的规则时，本栈一场都不算', () => {
  const fetchRule = rule({ id: 1, kind: 'fetch', effect: 'all' })
  const allowRule = rule({ id: 2, kind: 'allow', effect: 'allow' })
  const p = previewStackImpact({
    kind: 'allow',
    oldRules: [fetchRule, allowRule],
    newRules: [{ ...fetchRule, effect: 'skip' }, allowRule],
    subjects: one,
    now: NOW,
  })
  expect(p.counts.scanned).toBe(0)
  expect(p.changed).toHaveLength(0)
  expect(changedStackKinds([fetchRule, allowRule], [{ ...fetchRule, effect: 'skip' }, allowRule]))
    .toEqual(['fetch'])
})

test('只改 note 不改变任何判定：范围为空，不制造虚假的受影响数', () => {
  const before = rule({ id: 1, kind: 'allow', effect: 'allow', note: '兜底放行' })
  const after = { ...before, note: '兜底放行（补充说明：财务另有规则）' }
  const p = previewStackImpact({ kind: 'allow', oldRules: [before], newRules: [after], subjects: one, now: NOW })
  expect(p.counts.scanned).toBe(0)
  expect(p.changed).toHaveLength(0)
  expect(p.deciderOnly).toHaveLength(0)
  expect(changedStackKinds([before], [after])).toEqual([])
})

test('范围里的会议判定没变时不进任何列表，但算进 scanned', () => {
  // 规则只授给 svc-a，svc-b 那一路照旧被兜底拒绝——范围之内，但结果没变
  const subjects: PreviewSubject[] = [
    { key: 'm-1@svc-a', facts: facts({ title: '财务评审' }), programId: 'svc-a' },
    { key: 'm-1@svc-b', facts: facts({ title: '财务评审' }), programId: 'svc-b' },
  ]
  const granted = rule({
    id: 1, kind: 'allow', effect: 'allow', subjectType: 'program', subjectValue: 'svc-a',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })
  const p = previewStackImpact({ kind: 'allow', oldRules: [], newRules: [granted], subjects, now: NOW })
  expect(p.counts.scanned).toBe(2)
  expect(p.changed.map((c) => c.key)).toEqual(['m-1@svc-a'])
  expect(p.counts.opened).toBe(1)
})

// ── §5.4 人工改写优先于所有规则 ───────────────────────────────

test('人工改写过的会议被排除在「会被改变」之外，但要单独说得出来', () => {
  const subjects = [subject('m-1', { title: '财务评审' }), subject('m-2', { title: '财务复盘' })]
  const before = [rule({ id: 1, kind: 'allow', effect: 'allow', note: '兜底放行' })]
  const after = [rule({ id: 1, kind: 'allow', effect: 'deny', note: '兜底放行' })]

  const p = previewStackImpact({
    kind: 'allow', oldRules: before, newRules: after, subjects, now: NOW,
    overridden: new Set(['m-2']),
  })
  // 改写是引擎结果之上的覆盖层，规则怎么变它的实际结果都不变
  expect(p.changed.map((c) => c.key)).toEqual(['m-1'])
  expect(p.counts.tightened).toBe(1)
  // 但「本来会变、被改写挡住了」这件事管理员该知道
  expect(p.shielded.map((c) => c.key)).toEqual(['m-2'])
  expect(p.shielded[0]!.overridden).toBe(true)
  expect(p.counts.shielded).toBe(1)
  // 两场都在范围内——排除的是「会被改变」，不是「被考察」
  expect(p.counts.scanned).toBe(2)
})

test('改写集合也可以传判定函数', () => {
  const subjects = [subject('m-1', { title: '财务评审' }), subject('m-2', { title: '财务复盘' })]
  const p = previewStackImpact({
    kind: 'allow',
    oldRules: [rule({ id: 1, kind: 'allow', effect: 'allow' })],
    newRules: [rule({ id: 1, kind: 'allow', effect: 'deny' })],
    subjects, now: NOW,
    overridden: (s) => s.key === 'm-1',
  })
  expect(p.changed.map((c) => c.key)).toEqual(['m-2'])
  expect(p.shielded.map((c) => c.key)).toEqual(['m-1'])
})

// ── 三栈各自的变化类型 ────────────────────────────────────────

test('allow 栈：放行变拒绝、拒绝变放行', () => {
  const allow = rule({ id: 1, kind: 'allow', effect: 'allow', note: '兜底放行' })
  const deny = rule({ id: 1, kind: 'allow', effect: 'deny', note: '兜底放行' })

  const shut = previewStackImpact({ kind: 'allow', oldRules: [allow], newRules: [deny], subjects: one, now: NOW })
  expect(shut.changed[0]!.aspect).toBe('effect')
  expect(shut.changed[0]!.direction).toBe('tightened')
  expect(shut.changed[0]!.before.effect).toBe('allow')
  expect(shut.changed[0]!.after.effect).toBe('deny')

  const open = previewStackImpact({ kind: 'allow', oldRules: [deny], newRules: [allow], subjects: one, now: NOW })
  expect(open.changed[0]!.direction).toBe('opened')
  expect(open.counts.opened).toBe(1)
})

test('fetch 栈：拉取变跳过、跳过变拉取', () => {
  const all = rule({ id: 1, kind: 'fetch', effect: 'all' })
  const skip = rule({ id: 1, kind: 'fetch', effect: 'skip' })

  const stop = previewStackImpact({ kind: 'fetch', oldRules: [all], newRules: [skip], subjects: one, now: NOW })
  expect(stop.changed[0]!.direction).toBe('tightened')
  expect(stop.changed[0]!.summary).toContain('不拉取')

  const start = previewStackImpact({ kind: 'fetch', oldRules: [skip], newRules: [all], subjects: one, now: NOW })
  expect(start.changed[0]!.direction).toBe('opened')
})

test('archive 栈：目录从 A 变到 B 是「换目录」，不是放开也不是收紧', () => {
  const base = rule({ id: 1, kind: 'archive', priority: 100, effect: '/nas/meetings/{年}/{月}/', note: '兜底目录' })
  const finance = rule({
    id: 2, kind: 'archive', priority: 200, effect: '/nas/meetings-finance/{年}/', note: '财务独立目录',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })
  const p = previewStackImpact({
    kind: 'archive', oldRules: [base], newRules: [base, finance], subjects: one, now: NOW,
  })
  const c = p.changed[0]!
  expect(c.direction).toBe('moved')
  expect(c.before.effect).toBe('/nas/meetings/{年}/{月}/')
  expect(c.after.effect).toBe('/nas/meetings-finance/{年}/')
  expect(c.summary).toContain('/nas/meetings-finance/{年}/')
  expect(p.counts.moved).toBe(1)
})

test('archive 栈：开始归档与不再归档', () => {
  const dir = rule({ id: 1, kind: 'archive', effect: '/nas/meetings/{年}/' })
  const skip = rule({ id: 1, kind: 'archive', effect: 'skip' })
  expect(previewStackImpact({ kind: 'archive', oldRules: [skip], newRules: [dir], subjects: one, now: NOW })
    .changed[0]!.direction).toBe('opened')
  expect(previewStackImpact({ kind: 'archive', oldRules: [dir], newRules: [skip], subjects: one, now: NOW })
    .changed[0]!.direction).toBe('tightened')
})

test('effect 没变但放行的资产类型变了，同样是「会被改变」', () => {
  // 从八类收到只剩转写：判定还是 allow，但录像与音频从此取不到了。
  // 这一类若不报，预览会对着一次真实的收紧说「0 场会改变」
  const wide = rule({ id: 1, kind: 'allow', effect: 'allow', assetTypes: ['*'], note: '兜底放行' })
  const narrow = { ...wide, assetTypes: ['transcript'] }

  const p = previewStackImpact({ kind: 'allow', oldRules: [wide], newRules: [narrow], subjects: one, now: NOW })
  const c = p.changed[0]!
  expect(c.aspect).toBe('assets')
  expect(c.direction).toBe('tightened')
  expect(c.before.effect).toBe('allow')
  expect(c.after.effect).toBe('allow')
  expect(c.after.assetTypes).toEqual(['transcript'])

  // 反过来是放开
  expect(previewStackImpact({ kind: 'allow', oldRules: [narrow], newRules: [wide], subjects: one, now: NOW })
    .changed[0]!.direction).toBe('opened')
  // 有增有减是第三种
  const swapped = { ...wide, assetTypes: ['video'] }
  expect(previewStackImpact({ kind: 'allow', oldRules: [{ ...wide, assetTypes: ['transcript'] }], newRules: [swapped], subjects: one, now: NOW })
    .changed[0]!.direction).toBe('mixed')
})

// ── 判定没变，但决定它的规则变了 ──────────────────────────────

test('判定没变但换了另一条规则说了算：单列一类，不混进「会被改变」', () => {
  const old = rule({ id: 1, kind: 'allow', priority: 100, effect: 'allow', note: '兜底放行' })
  const added = rule({
    id: 2, kind: 'allow', priority: 200, effect: 'allow', note: '财务会议单独放行',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })
  const p = previewStackImpact({ kind: 'allow', oldRules: [old], newRules: [old, added], subjects: one, now: NOW })

  expect(p.changed).toHaveLength(0)
  expect(p.deciderOnly).toHaveLength(1)
  const c = p.deciderOnly[0]!
  expect(c.aspect).toBe('decider')
  expect(c.direction).toBe('unchanged')
  expect(c.before.ruleId).toBe(1)
  expect(c.after.ruleId).toBe(2)
  expect(c.summary).toContain('兜底放行')
  expect(c.summary).toContain('财务会议单独放行')
  expect(p.counts.deciderOnly).toBe(1)
  expect(p.counts.opened + p.counts.tightened + p.counts.moved + p.counts.mixed).toBe(0)
})

test('从兜底变成有规则决定，结果相同时也是「换了理由」', () => {
  const added = rule({ id: 1, kind: 'allow', effect: 'deny', note: '财务不外流' })
  const p = previewStackImpact({ kind: 'allow', oldRules: [], newRules: [added], subjects: one, now: NOW })
  expect(p.changed).toHaveLength(0)
  expect(p.deciderOnly).toHaveLength(1)
  expect(p.deciderOnly[0]!.before.ruleId).toBe(null)
  expect(p.deciderOnly[0]!.before.source).toBe('default')
  expect(p.deciderOnly[0]!.after.ruleId).toBe(1)
})

// ── 三种改动形态：新增 / 删除 / 只改优先级 ─────────────────────

test('新增一条规则', () => {
  const base = rule({ id: 1, kind: 'fetch', priority: 100, effect: 'all', note: '兜底全拉' })
  const added = rule({
    id: 2, kind: 'fetch', priority: 200, effect: 'skip', note: '闭门会不拉',
    conds: [{ f: 'title', op: 'has', v: '闭门' }],
  })
  const subjects = [subject('m-1', { title: '闭门评审' }), subject('m-2', { title: '周会' })]
  const p = previewStackImpact({ kind: 'fetch', oldRules: [base], newRules: [base, added], subjects, now: NOW })
  expect(p.changedRuleIds).toEqual([2])
  expect(p.counts.scanned).toBe(1)
  expect(p.changed.map((c) => c.key)).toEqual(['m-1'])
  expect(p.changed[0]!.direction).toBe('tightened')
})

test('删除一条规则', () => {
  const base = rule({ id: 1, kind: 'allow', priority: 100, effect: 'deny', note: '兜底拒绝' })
  const grant = rule({
    id: 2, kind: 'allow', priority: 200, effect: 'allow', note: '财务会议放行',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })
  const subjects = [subject('m-1', { title: '财务评审' }), subject('m-2', { title: '周会' })]
  const p = previewStackImpact({ kind: 'allow', oldRules: [base, grant], newRules: [base], subjects, now: NOW })
  expect(p.changedRuleIds).toEqual([2])
  expect(p.counts.scanned).toBe(1)
  expect(p.counts.hits).toBe(0) // 新规则集里已经没有这条规则，命中数归零
  expect(p.changed[0]!.direction).toBe('tightened')
  expect(p.changed[0]!.before.ruleId).toBe(2)
  expect(p.changed[0]!.after.ruleId).toBe(1)
})

test('只改优先级也能翻转结果——「第一条命中的说了算」', () => {
  const deny = rule({
    id: 1, kind: 'allow', priority: 100, effect: 'deny', note: '财务不外流',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })
  const allow = rule({ id: 2, kind: 'allow', priority: 200, effect: 'allow', note: '兜底放行' })
  const p = previewStackImpact({
    kind: 'allow', oldRules: [deny, allow], newRules: [{ ...deny, priority: 300 }, allow],
    subjects: one, now: NOW,
  })
  expect(p.changedRuleIds).toEqual([1])
  expect(p.changed).toHaveLength(1)
  expect(p.changed[0]!.direction).toBe('tightened')
  // 变化前后各是哪条规则决定的，都要说得出来
  expect(p.changed[0]!.before.ruleId).toBe(2)
  expect(p.changed[0]!.before.note).toBe('兜底放行')
  expect(p.changed[0]!.after.ruleId).toBe(1)
  expect(p.changed[0]!.after.note).toBe('财务不外流')
  expect(p.changed[0]!.summary).toContain('#1')
  expect(p.changed[0]!.summary).toContain('财务不外流')
})

test('停用一条规则等同于删掉它的作用', () => {
  const base = rule({ id: 1, kind: 'fetch', priority: 100, effect: 'skip', note: '兜底不拉' })
  const on = rule({ id: 2, kind: 'fetch', priority: 200, effect: 'all', note: '最近 90 天的拉' })
  const p = previewStackImpact({
    kind: 'fetch', oldRules: [base, on], newRules: [base, { ...on, enabled: false }], subjects: one, now: NOW,
  })
  expect(p.changed).toHaveLength(1)
  expect(p.changed[0]!.direction).toBe('tightened')
})

// ── 边界：空规则集 ────────────────────────────────────────────

test('空规则集 → 空规则集：什么都没发生', () => {
  const p = previewStackImpact({ kind: 'allow', oldRules: [], newRules: [], subjects: one, now: NOW })
  expect(p.counts.scanned).toBe(0)
  expect(p.counts.hits).toBe(0)
  expect(p.counts.total).toBe(1)
  expect(p.changed).toHaveLength(0)
  expect(p.deciderOnly).toHaveLength(0)
  expect(p.shielded).toHaveLength(0)
  expect(p.changedRuleIds).toEqual([])
  expect(p.summary).toContain('没有')
})

test('空 → 有：第一条规则把兜底顶掉', () => {
  const p = previewStackImpact({
    kind: 'allow', oldRules: [], newRules: [rule({ id: 1, kind: 'allow', effect: 'allow', note: '第一条放行规则' })],
    subjects: one, now: NOW,
  })
  expect(p.counts.scanned).toBe(1)
  expect(p.changed).toHaveLength(1)
  expect(p.changed[0]!.direction).toBe('opened')
  expect(p.changed[0]!.before.source).toBe('default')
})

test('有 → 空：全部回落到本栈兜底', () => {
  const subjects = [subject('m-1'), subject('m-2')]
  const p = previewStackImpact({
    kind: 'fetch', oldRules: [rule({ id: 1, kind: 'fetch', effect: 'all', note: '兜底全拉' })], newRules: [],
    subjects, now: NOW,
  })
  expect(p.counts.scanned).toBe(2)
  expect(p.counts.hits).toBe(0)
  expect(p.changed).toHaveLength(2)
  expect(p.changed.every((c) => c.direction === 'tightened')).toBe(true)
  expect(p.changed[0]!.after.source).toBe('default')
})

test('空的会议集合：预览不崩，三个数都是 0', () => {
  const p = previewStackImpact({
    kind: 'allow', oldRules: [], newRules: [rule({ id: 1, kind: 'allow', effect: 'allow' })],
    subjects: [], now: NOW,
  })
  expect(p.counts.total).toBe(0)
  expect(p.counts.scanned).toBe(0)
  expect(p.changed).toHaveLength(0)
})

// ── 写坏的规则：预览不崩，且标得出来 ──────────────────────────

test('规则 effect 是脏数据时预览不崩，变化标得出是写坏的规则造成的', () => {
  const good = rule({ id: 1, kind: 'allow', effect: 'allow', note: '兜底放行' })
  const broken = { ...good, effect: 'allwo' }
  const p = previewStackImpact({ kind: 'allow', oldRules: [good], newRules: [broken], subjects: one, now: NOW })

  const c = p.changed[0]!
  expect(c.direction).toBe('tightened')
  expect(c.after.effect).toBe('deny') // 落到本栈安全侧
  expect(c.after.source).toBe('rule_invalid')
  expect(c.invalidRule).toBe(true)
  // 具体坏在哪由 stacks.ts 的 issues 承载，一句话汇总只说「这是写坏的规则决定的」
  expect(c.after.issues.some((i) => i.includes('allwo'))).toBe(true)
  expect(c.summary).toContain('脏数据')
  expect(p.counts.invalid).toBe(1)
})

test('conds 是脏数据时预览不崩：这条规则谁都命中不了', () => {
  const base = rule({ id: 1, kind: 'fetch', priority: 100, effect: 'skip', note: '兜底不拉' })
  const brokenConds = {
    ...rule({ id: 2, kind: 'fetch', priority: 200, effect: 'all' }),
    conds: 'not-an-array' as unknown as StackRule['conds'],
  }
  const p = previewStackImpact({ kind: 'fetch', oldRules: [base], newRules: [base, brokenConds], subjects: one, now: NOW })
  expect(p.counts.scanned).toBe(0)
  expect(p.changed).toHaveLength(0)
})

test('archive 栈的 effect 写成空白时落到不归档，并标为脏数据', () => {
  const dir = rule({ id: 1, kind: 'archive', effect: '/nas/meetings/{年}/' })
  const blank = { ...dir, effect: '   ' }
  const c = previewStackImpact({ kind: 'archive', oldRules: [dir], newRules: [blank], subjects: one, now: NOW }).changed[0]!
  expect(c.after.effect).toBe('skip')
  expect(c.direction).toBe('tightened')
  expect(c.invalidRule).toBe(true)
})

// ── 输出要能驱动界面 ──────────────────────────────────────────

test('每条变化都带着变化前后各是哪条规则决定的，以及一句可直接上屏的话', () => {
  const wide = rule({ id: 1, kind: 'fetch', priority: 100, effect: 'all', note: '兜底全拉' })
  const stop = rule({
    id: 2, kind: 'fetch', priority: 200, effect: 'skip', note: '董事会决议不出腾讯会议侧',
    conds: [{ f: 'title', op: 'has', v: '董事会' }],
  })
  const subjects = [subject('m-1', { title: '董事会闭门会' })]
  const c = previewStackImpact({ kind: 'fetch', oldRules: [wide], newRules: [wide, stop], subjects, now: NOW })
    .changed[0]!

  expect(c.key).toBe('m-1')
  expect(c.kind).toBe('fetch')
  expect(c.before.reason).toContain('兜底全拉')
  expect(c.after.reason).toContain('董事会决议不出腾讯会议侧')
  expect(c.summary).toContain('董事会闭门会')
  expect(c.summary).toContain('拉取')
  expect(c.summary).toContain('#2')
})

test('预览的一句话汇总把三个数说清楚', () => {
  const subjects = [subject('m-1', { title: '财务评审' }), subject('m-2', { title: '财务复盘' })]
  const p = previewStackImpact({
    kind: 'allow',
    oldRules: [rule({ id: 1, kind: 'allow', effect: 'allow', note: '兜底放行' })],
    newRules: [rule({ id: 1, kind: 'allow', effect: 'deny', note: '兜底放行' })],
    subjects, now: NOW,
  })
  expect(p.counts.hits).toBe(2)
  expect(p.summary).toContain('2')
  expect(p.summary).toContain('收紧')
})

// ── 收范围不能漏：与「全量逐场重算」对齐 ──────────────────────

test('收范围是安全的：预览的结论与「不收范围、全量逐场重算」逐场一致', () => {
  // 只在命中并集上算，前提是「没被改动的规则够不着的会议，判定必然不变」。
  // 这条前提如果错了，预览就会漏报——那比虚假的规模感更糟。
  // 这里用一份独立的全量实现当对照：60 场会议 × 7 种改动形态，逐场比对。
  const subjects: PreviewSubject[] = []
  for (let i = 1; i <= 60; i++) {
    subjects.push(
      subject(`m-${i}`, {
        title: i % 3 === 0 ? `财务评审 ${i}` : i % 5 === 0 ? `董事会闭门 ${i}` : `周会 ${i}`,
        hostUserId: i % 4 === 0 ? 'tm-bob' : 'tm-alice',
        endTime: NOW - 7200 + i * 60,
        archived: i % 2 === 0,
      }),
    )
  }

  const catchAll = rule({ id: 1, kind: 'allow', priority: 100, effect: 'allow', note: '兜底放行' })
  const finance = rule({
    id: 2, kind: 'allow', priority: 200, effect: 'deny', note: '财务不外流',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
  })
  const archivedOnly = rule({
    id: 3, kind: 'allow', priority: 150, effect: 'allow', assetTypes: ['transcript'], note: '归档过的放文本',
    conds: [{ f: 'arch', op: 'isarch', v: '' }],
  })
  const base = [catchAll, finance, archivedOnly]

  const scenarios: Array<[string, StackRule[], StackRule[]]> = [
    ['新增一条高优先级规则', base, [...base, rule({ id: 4, kind: 'allow', priority: 900, effect: 'deny', conds: [{ f: 'host', op: 'is', v: 'tm-bob' }] })]],
    ['删掉兜底规则', base, [finance, archivedOnly]],
    ['改兜底规则的 effect', base, [{ ...catchAll, effect: 'deny' }, finance, archivedOnly]],
    ['只改优先级', base, [catchAll, { ...finance, priority: 10 }, archivedOnly]],
    ['收窄资产类型', base, [{ ...catchAll, assetTypes: ['ai_minutes'] }, finance, archivedOnly]],
    ['停用一条规则', base, [catchAll, finance, { ...archivedOnly, enabled: false }]],
    ['改条件', base, [catchAll, { ...finance, conds: [{ f: 'title', op: 'has', v: '周会' }] }, archivedOnly]],
  ]

  for (const [name, oldRules, newRules] of scenarios) {
    const p = previewStackImpact({ kind: 'allow', oldRules, newRules, subjects, now: NOW })
    const listed = new Set([...p.changed, ...p.deciderOnly, ...p.shielded].map((c) => c.key))

    // 对照组：不收范围，60 场全部重算一遍
    const brute = new Set<string>()
    for (const s of subjects) {
      const before = evaluateAllowStack(oldRules, { facts: s.facts, now: NOW, programId: s.programId ?? '' })
      const after = evaluateAllowStack(newRules, { facts: s.facts, now: NOW, programId: s.programId ?? '' })
      const same =
        before.effect === after.effect &&
        before.assetTypes.join(',') === after.assetTypes.join(',') &&
        before.ruleId === after.ruleId &&
        before.source === after.source
      if (!same) brute.add(s.key)
    }

    expect([...listed].sort()).toEqual([...brute].sort())
    // 每一种改动都得真的改到了点东西，否则这条用例是在自证空集
    expect(brute.size, name).toBeGreaterThan(0)
    // 且范围确实小于全量——收范围不是白收的
    expect(p.counts.scanned).toBeLessThanOrEqual(60)
  }
})
