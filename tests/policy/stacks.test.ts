import { expect, test } from 'bun:test'
import { ALL_ASSET_KEYS } from '@yaowu/mde-engine'
import type { MeetingFacts } from '../../src/policy/conds'
import {
  decisionAllowsAsset,
  describeStackRuleIssues,
  evaluateAllowStack,
  evaluateArchiveStack,
  evaluateFetchStack,
  evaluateStacks,
  sortStackRules,
  type StackRule,
} from '../../src/policy/stacks'

/** 2026-01-01 00:00:00 UTC。求值器里不许读时钟，所有用例显式传这个 now */
const NOW = 1767225600
const PROGRAM = 'svc-archiver'

function facts(over: Partial<MeetingFacts> = {}): MeetingFacts {
  return {
    title: '季度财务评审',
    hostUserId: 'tm-alice',
    dept: null,
    startTime: NOW - 7200,
    endTime: NOW - 3600, // 时长 60 分钟
    recordEndTime: NOW - 3600,
    archived: false,
    ...over,
  }
}

/** 造一条规则。默认无条件（匹配一切），这样用例只需要写它真正关心的那几个字段 */
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

const fetchIn = { facts: facts(), now: NOW }
const allowIn = { facts: facts(), now: NOW, programId: PROGRAM }

// ── §5.1 求值顺序 ─────────────────────────────────────────────

test('按 priority 降序取第一条命中的，立即停止', () => {
  // 乱序输入：排序必须自己做，不能指望调用方按判定顺序传进来
  const rules = [
    rule({ id: 1, kind: 'fetch', priority: 50, effect: 'all', note: '兜底全拉' }),
    rule({ id: 2, kind: 'fetch', priority: 200, effect: 'skip', note: '董事会不出腾讯侧',
      conds: [{ f: 'title', op: 'has', v: '财务' }] }),
    rule({ id: 3, kind: 'fetch', priority: 120, effect: 'all', note: '中间那条' }),
  ]
  const d = evaluateFetchStack(rules, fetchIn)
  expect(d.effect).toBe('skip')
  expect(d.ruleId).toBe(2)
  expect(d.source).toBe('rule')
  // 「第一条命中的说了算」：命中之后不再往下看
  expect(d.trace.map((t) => t.ruleId)).toEqual([2])
})

test('优先级高但不匹配时，继续往下找', () => {
  const rules = [
    rule({ id: 1, kind: 'fetch', priority: 50, effect: 'all' }),
    rule({ id: 2, kind: 'fetch', priority: 200, effect: 'skip',
      conds: [{ f: 'title', op: 'has', v: '人事' }] }),
    rule({ id: 3, kind: 'fetch', priority: 120, effect: 'skip',
      conds: [{ f: 'host', op: 'is', v: 'tm-bob' }] }),
  ]
  const d = evaluateFetchStack(rules, fetchIn)
  expect(d.ruleId).toBe(1)
  // 考察顺序就是判定顺序：200 → 120 → 50
  expect(d.trace.map((t) => t.ruleId)).toEqual([2, 3, 1])
  expect(d.trace[0]!.outcome).toBe('not_matched')
  expect(d.trace[2]!.outcome).toBe('matched')
})

test('同 priority 按 id 升序，先建的先命中——且与输入顺序无关（D-a）', () => {
  const small = rule({ id: 7, kind: 'fetch', priority: 100, effect: 'skip', note: '先建的' })
  const big = rule({ id: 99, kind: 'fetch', priority: 100, effect: 'all', note: '后建的' })

  // 倒序输入：大 id 在前。若排序没写平局分支，稳定排序会让 99 留在前面
  expect(evaluateFetchStack([big, small], fetchIn).ruleId).toBe(7)
  // 正序输入：结果必须一模一样
  expect(evaluateFetchStack([small, big], fetchIn).ruleId).toBe(7)
  // effect 也跟着走，避免「id 对了但拿错了 effect」
  expect(evaluateFetchStack([big, small], fetchIn).effect).toBe('skip')
})

test('sortStackRules 是判定顺序本身：规则列表与引擎共用同一个排序', () => {
  const rules = [
    rule({ id: 99, kind: 'fetch', priority: 100 }),
    rule({ id: 7, kind: 'fetch', priority: 100 }),
    rule({ id: 3, kind: 'fetch', priority: 200 }),
    rule({ id: 5, kind: 'fetch', priority: 50 }),
  ]
  expect(sortStackRules(rules).map((r) => r.id)).toEqual([3, 7, 99, 5])
  // 不就地改调用方的数组——规则列表拿到的顺序不该被引擎悄悄改掉
  expect(rules.map((r) => r.id)).toEqual([99, 7, 3, 5])
})

test('priority 不是有效数字的脏数据排到最后，且平局仍按 id 升序', () => {
  const broken = rule({ id: 1, kind: 'fetch', priority: Number.NaN, effect: 'skip' })
  const brokenLater = rule({ id: 2, kind: 'fetch', priority: Number.NaN, effect: 'skip' })
  const good = rule({ id: 9, kind: 'fetch', priority: 0, effect: 'all' })
  expect(sortStackRules([broken, brokenLater, good]).map((r) => r.id)).toEqual([9, 1, 2])
  expect(sortStackRules([brokenLater, good, broken]).map((r) => r.id)).toEqual([9, 1, 2])
})

// ── §5.1 兜底：三栈各不相同 ───────────────────────────────────

test('兜底：一条都不匹配时，fetch 与 archive 是 skip、allow 是 deny', () => {
  const miss = [{ f: 'title', op: 'has', v: '压根不存在的关键词' }]
  const f = evaluateFetchStack([rule({ id: 1, kind: 'fetch', conds: miss })], fetchIn)
  const a = evaluateArchiveStack([rule({ id: 2, kind: 'archive', conds: miss })], fetchIn)
  const p = evaluateAllowStack([rule({ id: 3, kind: 'allow', conds: miss })], allowIn)

  expect(f.effect).toBe('skip')
  expect(a.effect).toBe('skip')
  expect(p.effect).toBe('deny')
  for (const d of [f, a, p]) {
    expect(d.source).toBe('default')
    expect(d.ruleId).toBe(null)
    expect(d.assetTypes).toEqual([])
  }
})

test('兜底：一条规则都没有时同样落到各自的兜底', () => {
  expect(evaluateFetchStack([], fetchIn).effect).toBe('skip')
  expect(evaluateArchiveStack([], fetchIn).effect).toBe('skip')
  // 数据出企业边界的闸门，空规则集必须是关的
  expect(evaluateAllowStack([], allowIn).effect).toBe('deny')
})

test('只取本栈的规则：别的 kind 不参与，也不进 trace', () => {
  const rules = [
    rule({ id: 1, kind: 'allow', priority: 500, effect: 'deny' }),
    rule({ id: 2, kind: 'archive', priority: 400, effect: '/nas/x/' }),
    rule({ id: 3, kind: 'fetch', priority: 10, effect: 'all' }),
  ]
  const d = evaluateFetchStack(rules, fetchIn)
  expect(d.ruleId).toBe(3)
  expect(d.trace.map((t) => t.ruleId)).toEqual([3])
})

test('enabled 为 false 的规则不参与判定', () => {
  const rules = [
    rule({ id: 1, kind: 'fetch', priority: 200, enabled: false, effect: 'skip' }),
    rule({ id: 2, kind: 'fetch', priority: 100, effect: 'all' }),
  ]
  const d = evaluateFetchStack(rules, fetchIn)
  expect(d.ruleId).toBe(2)
  expect(d.effect).toBe('all')
  expect(d.trace.map((t) => t.ruleId)).toEqual([2])

  // 停用了唯一一条规则 → 落兜底，而不是照旧生效
  expect(evaluateFetchStack([rules[0]!], fetchIn).source).toBe('default')
})

// ── §6.3 主体：三栈含义不同 ───────────────────────────────────

test('fetch 栈显式忽略主体：带 subject 的历史脏数据照样参与判定', () => {
  // policy_rules.subject_type 是 NOT NULL，库里存在带主体的旧行。
  // 系统级栈必须「显式忽略」它，而不是「恰好匹配不上」被筛掉。
  const dirty = rule({
    id: 1, kind: 'fetch', priority: 200, effect: 'skip',
    subjectType: 'user', subjectValue: 'tm-someone-else',
  })
  const fallback = rule({ id: 2, kind: 'fetch', priority: 100, effect: 'all' })
  const d = evaluateFetchStack([dirty, fallback], fetchIn)

  expect(d.ruleId).toBe(1)
  expect(d.effect).toBe('skip')
  expect(d.trace[0]!.outcome).toBe('matched')
  // 忽略这件事要说得出口，否则脏数据在界面上是隐形的
  expect(d.trace[0]!.detail).toContain('忽略')
  expect(describeStackRuleIssues(dirty).some((s) => s.includes('主体'))).toBe(true)
})

test('archive 栈同样显式忽略主体', () => {
  const dirty = rule({
    id: 1, kind: 'archive', priority: 200, effect: '/nas/meetings-finance/{年}/',
    subjectType: 'program', subjectValue: 'svc-other',
  })
  const d = evaluateArchiveStack([dirty], fetchIn)
  expect(d.effect).toBe('/nas/meetings-finance/{年}/')
  expect(d.ruleId).toBe(1)
})

test('allow 栈按采集程序匹配主体：程序不符的规则不参与', () => {
  const other = rule({
    id: 1, kind: 'allow', priority: 200, effect: 'deny',
    subjectType: 'program', subjectValue: 'svc-someone-else',
  })
  const mine = rule({ id: 2, kind: 'allow', priority: 100, effect: 'allow' })
  const d = evaluateAllowStack([other, mine], allowIn)

  expect(d.ruleId).toBe(2)
  expect(d.effect).toBe('allow')
  expect(d.trace[0]!.outcome).toBe('subject_mismatch')
  expect(d.trace[0]!.detail).toContain('svc-someone-else')

  // 换个程序来问，判定就换一条规则
  const asOther = evaluateAllowStack([other, mine], { ...allowIn, programId: 'svc-someone-else' })
  expect(asOther.ruleId).toBe(1)
  expect(asOther.effect).toBe('deny')
})

test('allow 栈不认 user 主体：旧语义的规则不会对任何程序生效', () => {
  // engine.ts 的 subjectMatches 只认 'user'，那是旧语义。allow 栈的主体是程序，不是人
  const legacy = rule({
    id: 1, kind: 'allow', priority: 900, effect: 'allow',
    subjectType: 'user', subjectValue: PROGRAM,
  })
  const d = evaluateAllowStack([legacy], allowIn)
  expect(d.effect).toBe('deny')
  expect(d.source).toBe('default')
  expect(d.trace[0]!.outcome).toBe('subject_mismatch')
  expect(describeStackRuleIssues(legacy).some((s) => s.includes('program'))).toBe(true)
})

test('allow 栈：主体为空的规则匹配不上任何程序，空 programId 也匹配不上任何规则', () => {
  const blank = rule({ id: 1, kind: 'allow', effect: 'allow', subjectType: 'program', subjectValue: '' })
  expect(evaluateAllowStack([blank], { ...allowIn, programId: '' }).effect).toBe('deny')
  expect(evaluateAllowStack([blank], allowIn).effect).toBe('deny')

  const real = rule({ id: 2, kind: 'allow', effect: 'allow' })
  expect(evaluateAllowStack([real], { ...allowIn, programId: '' }).effect).toBe('deny')
})

// ── §5.2 条件（栈这一层的端到端） ──────────────────────────────

test('conds 为空的规则匹配一切', () => {
  const d = evaluateFetchStack([rule({ id: 1, kind: 'fetch', conds: [], effect: 'all' })], fetchIn)
  expect(d.effect).toBe('all')
  expect(d.trace[0]!.detail).toContain('匹配全部会议')
})

test('join 为 or 时任一条件成立即命中，and 时要全部成立', () => {
  const conds = [
    { f: 'title', op: 'has', v: '人事' }, // 不成立
    { f: 'host', op: 'is', v: 'tm-alice' }, // 成立
  ]
  expect(evaluateFetchStack([rule({ id: 1, kind: 'fetch', join: 'or', conds, effect: 'skip' })], fetchIn).effect)
    .toBe('skip')
  expect(evaluateFetchStack([rule({ id: 1, kind: 'fetch', join: 'and', conds, effect: 'skip' })], fetchIn).source)
    .toBe('default')
})

test('条件里的坏字段不会让规则静默命中', () => {
  // 未知字段一律不匹配（conds.ts 的规矩），栈这层因此落到兜底而不是放行
  const d = evaluateAllowStack(
    [rule({ id: 1, kind: 'allow', effect: 'allow', conds: [{ f: 'titel', op: 'has', v: '财务' }] })],
    allowIn,
  )
  expect(d.effect).toBe('deny')
  expect(d.source).toBe('default')
})

// ── §3.4 D-c 资产类型 ────────────────────────────────────────

test('allow 栈的 assetTypes：星号展开成全部八类', () => {
  const d = evaluateAllowStack([rule({ id: 1, kind: 'allow', effect: 'allow', assetTypes: ['*'] })], allowIn)
  expect(d.assetTypes).toEqual(ALL_ASSET_KEYS)
  expect(decisionAllowsAsset(d, 'video').allowed).toBe(true)
  expect(decisionAllowsAsset(d, 'ai_ds_minutes').allowed).toBe(true)
})

test('allow 栈的 assetTypes：只放行列出的那几类，其余按拒绝', () => {
  const d = evaluateAllowStack(
    [rule({ id: 1, kind: 'allow', effect: 'allow', note: '只放行文本类纪要', assetTypes: ['transcript', 'ai_minutes'] })],
    allowIn,
  )
  expect(d.effect).toBe('allow')
  expect(d.assetTypes).toEqual(['transcript', 'ai_minutes'])

  const yes = decisionAllowsAsset(d, 'transcript')
  expect(yes.allowed).toBe(true)
  const no = decisionAllowsAsset(d, 'video')
  expect(no.allowed).toBe(false)
  // 「哪条规则决定的」在按资产拒绝时同样要说得出来
  expect(no.reason).toContain('#1')
  expect(no.reason).toContain('只放行文本类纪要')
})

test('effect 为 deny / skip 时不带出任何资产类型', () => {
  const d = evaluateAllowStack([rule({ id: 1, kind: 'allow', effect: 'deny', assetTypes: ['*'] })], allowIn)
  expect(d.effect).toBe('deny')
  expect(d.assetTypes).toEqual([])
  expect(decisionAllowsAsset(d, 'video').allowed).toBe(false)

  // 兜底同理
  expect(decisionAllowsAsset(evaluateAllowStack([], allowIn), 'video').allowed).toBe(false)
})

test('原型的资产短名不被接受：忽略掉并报出来，不当成合法键', () => {
  // 计划 §3.4 D-c：同一批资产已经有过三套叫法，M3.5 为此吃过一次亏
  const r = rule({ id: 1, kind: 'allow', effect: 'allow', assetTypes: ['summary', 'aitr', 'transcript'] })
  const d = evaluateAllowStack([r], allowIn)
  expect(d.assetTypes).toEqual(['transcript'])
  expect(decisionAllowsAsset(d, 'ai_minutes').allowed).toBe(false)
  expect(d.issues.some((s) => s.includes('summary'))).toBe(true)
  expect(describeStackRuleIssues(r).some((s) => s.includes('aitr'))).toBe(true)
})

test('准许采集却一类资产都没列出：判定成立但取不到东西，必须报出来', () => {
  const r = rule({ id: 1, kind: 'allow', effect: 'allow', assetTypes: [] })
  const d = evaluateAllowStack([r], allowIn)
  expect(d.effect).toBe('allow')
  expect(d.assetTypes).toEqual([])
  expect(describeStackRuleIssues(r).some((s) => s.includes('资产'))).toBe(true)
})

test('fetch 栈的 all 带出要拉的资产类型，skip 不带', () => {
  const all = evaluateFetchStack(
    [rule({ id: 1, kind: 'fetch', effect: 'all', assetTypes: ['video', 'transcript'] })], fetchIn)
  expect(all.effect).toBe('all')
  expect(all.assetTypes).toEqual(['video', 'transcript'])
  expect(decisionAllowsAsset(all, 'audio').allowed).toBe(false)

  const skip = evaluateFetchStack(
    [rule({ id: 1, kind: 'fetch', effect: 'skip', assetTypes: ['*'] })], fetchIn)
  expect(skip.assetTypes).toEqual([])
})

// ── archive 栈的 effect 是目录模板 ────────────────────────────

test('archive 栈的 effect 是目录模板，原样带出（8 字符装不下，不能截）', () => {
  const tpl = '/nas/meetings/{年}/{月}/{会议号}-{标题}/'
  const d = evaluateArchiveStack([rule({ id: 1, kind: 'archive', effect: tpl, note: '兜底目录' })], fetchIn)
  expect(d.effect).toBe(tpl)
  expect(d.ruleId).toBe(1)
  expect(d.assetTypes).toEqual([]) // archive 栈不用 asset_types
})

test('archive 栈的 skip 表示不归档', () => {
  const d = evaluateArchiveStack([rule({ id: 1, kind: 'archive', effect: 'skip' })], fetchIn)
  expect(d.effect).toBe('skip')
  expect(d.source).toBe('rule')
})

// ── §6「不许静默放行」：effect 是脏数据时 ──────────────────────

test('命中的规则 effect 非法时落到本栈的安全侧，且不再往下找', () => {
  // 往下找会让一条写坏的高优先级 deny 被低优先级的 allow 顶掉——静默放行
  const broken = rule({ id: 1, kind: 'allow', priority: 200, effect: 'allwo' })
  const permissive = rule({ id: 2, kind: 'allow', priority: 100, effect: 'allow' })
  const d = evaluateAllowStack([broken, permissive], allowIn)

  expect(d.effect).toBe('deny')
  expect(d.ruleId).toBe(1) // 仍然说得出是哪条规则决定的
  expect(d.source).toBe('rule_invalid')
  expect(d.issues.some((s) => s.includes('allwo'))).toBe(true)
  expect(d.trace.map((t) => t.ruleId)).toEqual([1])
})

test('fetch 栈的非法 effect 落到 skip，archive 的空 effect 落到 skip', () => {
  expect(evaluateFetchStack([rule({ id: 1, kind: 'fetch', effect: 'allow' })], fetchIn).effect).toBe('skip')
  expect(evaluateFetchStack([rule({ id: 1, kind: 'fetch', effect: 'allow' })], fetchIn).source).toBe('rule_invalid')
  expect(evaluateArchiveStack([rule({ id: 1, kind: 'archive', effect: '   ' })], fetchIn).effect).toBe('skip')
})

// ── §6「判定理由必须可回溯」 ──────────────────────────────────

test('判定理由说得出是哪条规则（id + note）决定的', () => {
  const d = evaluateFetchStack(
    [rule({ id: 42, kind: 'fetch', priority: 200, effect: 'skip', note: '董事会决议不出腾讯会议侧' })],
    fetchIn,
  )
  expect(d.ruleId).toBe(42)
  expect(d.note).toBe('董事会决议不出腾讯会议侧')
  expect(d.reason).toContain('#42')
  expect(d.reason).toContain('董事会决议不出腾讯会议侧')
})

test('规则没写 note 时，判定理由退回到规则编号，不留空句子', () => {
  const d = evaluateFetchStack([rule({ id: 7, kind: 'fetch', effect: 'skip', note: null })], fetchIn)
  expect(d.note).toBe(null)
  expect(d.reason).toContain('#7')
  expect(d.reason.length).toBeGreaterThan(6)
})

test('兜底时的判定理由说得出「没有任何规则匹配」', () => {
  const p = evaluateAllowStack([], allowIn)
  expect(p.reason).toContain('没有任何')
  expect(p.reason).toContain('拒绝')
  expect(evaluateFetchStack([], fetchIn).reason).toContain('没有任何')
})

test('trace 逐条留下考察结论，供详情抽屉展开', () => {
  const rules = [
    rule({ id: 1, kind: 'fetch', priority: 200, effect: 'skip', note: '人事会不拉',
      conds: [{ f: 'title', op: 'has', v: '面试' }] }),
    rule({ id: 2, kind: 'fetch', priority: 100, effect: 'all', note: '兜底全拉' }),
  ]
  const d = evaluateFetchStack(rules, fetchIn)
  expect(d.trace).toHaveLength(2)
  expect(d.trace[0]).toMatchObject({ ruleId: 1, priority: 200, note: '人事会不拉', outcome: 'not_matched' })
  expect(d.trace[0]!.detail).toContain('面试')
  expect(d.trace[1]).toMatchObject({ ruleId: 2, outcome: 'matched' })
})

// ── 三栈一次算完：A2 的「逐阶段判定理由」 ──────────────────────

test('evaluateStacks 一次给出三栈的判定，各走各的兜底', () => {
  const rules = [
    rule({ id: 1, kind: 'fetch', priority: 100, effect: 'all', assetTypes: ['*'] }),
    rule({ id: 2, kind: 'archive', priority: 100, effect: '/nas/meetings-finance/{年}/',
      conds: [{ f: 'title', op: 'has', v: '财务' }] }),
    rule({ id: 3, kind: 'allow', priority: 100, effect: 'deny',
      conds: [{ f: 'title', op: 'has', v: '财务' }], note: '财务内容不出企业边界' }),
  ]
  const { fetch, archive, allow } = evaluateStacks(rules, allowIn)
  expect(fetch.effect).toBe('all')
  expect(archive.effect).toBe('/nas/meetings-finance/{年}/')
  expect(allow.effect).toBe('deny')
  expect(allow.reason).toContain('财务内容不出企业边界')

  // 换一场不含「财务」的会议：归档与权限都落兜底，拉取照旧
  const other = evaluateStacks(rules, { ...allowIn, facts: facts({ title: '周会' }) })
  expect(other.fetch.effect).toBe('all')
  expect(other.archive.effect).toBe('skip')
  expect(other.allow.effect).toBe('deny')
  expect(other.allow.source).toBe('default')
})

// ── 静态检查：建完就静默失效的规则要在列表里看得见 ──────────────

test('describeStackRuleIssues 把条件层的问题一并带出来', () => {
  const r = rule({ id: 1, kind: 'allow', effect: 'allow', conds: [{ f: 'dept', op: 'in', v: ['财务部'] }] })
  const issues = describeStackRuleIssues(r)
  expect(issues.some((s) => s.includes('企业微信'))).toBe(true)
  expect(issues.some((s) => s.includes('永远不会命中'))).toBe(true)
})

test('describeStackRuleIssues：一条正常规则没有任何问题', () => {
  expect(describeStackRuleIssues(rule({
    id: 1, kind: 'fetch', effect: 'all', assetTypes: ['*'],
    conds: [{ f: 'age', op: 'within', v: 90 }],
  }))).toEqual([])
  expect(describeStackRuleIssues(rule({
    id: 2, kind: 'allow', effect: 'allow', assetTypes: ['transcript'],
  }))).toEqual([])
  expect(describeStackRuleIssues(rule({ id: 3, kind: 'archive', effect: '/nas/meetings/{年}/' }))).toEqual([])
})

test('describeStackRuleIssues：kind 与 priority 的脏数据', () => {
  const r = { ...rule({ id: 1, kind: 'fetch' }), kind: 'fetchh' as StackRule['kind'], priority: Number.NaN }
  const issues = describeStackRuleIssues(r)
  expect(issues.some((s) => s.includes('fetchh'))).toBe(true)
  expect(issues.some((s) => s.includes('priority'))).toBe(true)
})
