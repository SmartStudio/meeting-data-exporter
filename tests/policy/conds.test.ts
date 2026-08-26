import { expect, test } from 'bun:test'
import {
  describeRuleIssues,
  evaluateCond,
  evaluateRule,
  matchesRule,
  type CondRule,
  type MeetingFacts,
} from '../../src/policy/conds'

/** 2026-01-01 00:00:00 UTC。所有用例都显式传这个 now，求值器里不许读时钟 */
const NOW = 1767225600

function facts(over: Partial<MeetingFacts> = {}): MeetingFacts {
  return {
    title: '季度财务评审',
    hostUserId: 'tm-alice',
    dept: null, // 生产上恒为 null（企微通讯录未接入），要测比对逻辑的用例自己覆盖
    startTime: NOW - 7200,
    endTime: NOW - 3600, // 时长 60 分钟
    recordEndTime: NOW - 3600, // 距今 1 小时 ≈ 0.042 天
    archived: false,
    ...over,
  }
}

function rule(conds: CondRule['conds'], join?: 'and' | 'or'): CondRule {
  return join === undefined ? { conds } : { join, conds }
}

function hit(f: string, op: string, v?: unknown, over: Partial<MeetingFacts> = {}): boolean {
  return matchesRule(rule([{ f, op, v }]), facts(over), NOW)
}

// ── 六个字段 × 各自两个 op = 12 条基本语义 ────────────────────────────

test('title has：关键词任一被标题包含', () => {
  expect(hit('title', 'has', '财务')).toBe(true)
  expect(hit('title', 'has', '人事,财务')).toBe(true) // 任一命中即可
  expect(hit('title', 'has', '人事')).toBe(false)
})

test('title nothas：一个关键词都不包含', () => {
  expect(hit('title', 'nothas', '人事')).toBe(true)
  expect(hit('title', 'nothas', '财务')).toBe(false)
  expect(hit('title', 'nothas', '人事,财务')).toBe(false) // 命中任一就不算「都不包含」
})

test('dept in / notin：部门有数据时按集合比对', () => {
  expect(hit('dept', 'in', ['财务部', '市场部'], { dept: '财务部' })).toBe(true)
  expect(hit('dept', 'in', ['市场部'], { dept: '财务部' })).toBe(false)
  expect(hit('dept', 'notin', ['市场部'], { dept: '财务部' })).toBe(true)
  expect(hit('dept', 'notin', ['财务部'], { dept: '财务部' })).toBe(false)
})

test('host is / isnot：主持人等值比对', () => {
  expect(hit('host', 'is', 'tm-alice')).toBe(true)
  expect(hit('host', 'is', 'tm-bob')).toBe(false)
  expect(hit('host', 'isnot', 'tm-bob')).toBe(true)
  expect(hit('host', 'isnot', 'tm-alice')).toBe(false)
})

test('dur gt / lt：时长分钟数比对', () => {
  expect(hit('dur', 'gt', 30)).toBe(true) // 60 分钟 > 30
  expect(hit('dur', 'gt', 90)).toBe(false)
  expect(hit('dur', 'lt', 90)).toBe(true)
  expect(hit('dur', 'lt', 30)).toBe(false)
})

test('age within / before：录制结束距今天数比对', () => {
  expect(hit('age', 'within', 7)).toBe(true) // 1 小时前
  expect(hit('age', 'before', 7)).toBe(false)
  const old = { recordEndTime: NOW - 30 * 86400 }
  expect(hit('age', 'within', 7, old)).toBe(false)
  expect(hit('age', 'before', 7, old)).toBe(true)
})

test('arch isarch / notarch：归档状态，无值', () => {
  expect(hit('arch', 'isarch', undefined, { archived: true })).toBe(true)
  expect(hit('arch', 'isarch', undefined, { archived: false })).toBe(false)
  expect(hit('arch', 'notarch', undefined, { archived: false })).toBe(true)
  expect(hit('arch', 'notarch', undefined, { archived: true })).toBe(false)
})

// ── 规则级语义 ────────────────────────────────────────────────────────

test('conds 为空匹配一切', () => {
  expect(matchesRule({ conds: [] }, facts(), NOW)).toBe(true)
  expect(matchesRule({ join: 'or', conds: [] }, facts(), NOW)).toBe(true)
})

test('join=and：全部条件成立才匹配', () => {
  const both = [{ f: 'title', op: 'has', v: '财务' }, { f: 'host', op: 'is', v: 'tm-alice' }]
  const one = [{ f: 'title', op: 'has', v: '财务' }, { f: 'host', op: 'is', v: 'tm-bob' }]
  expect(matchesRule({ join: 'and', conds: both }, facts(), NOW)).toBe(true)
  expect(matchesRule({ join: 'and', conds: one }, facts(), NOW)).toBe(false)
})

test('join=or：任一条件成立即匹配', () => {
  const one = [{ f: 'title', op: 'has', v: '财务' }, { f: 'host', op: 'is', v: 'tm-bob' }]
  const none = [{ f: 'title', op: 'has', v: '人事' }, { f: 'host', op: 'is', v: 'tm-bob' }]
  expect(matchesRule({ join: 'or', conds: one }, facts(), NOW)).toBe(true)
  expect(matchesRule({ join: 'or', conds: none }, facts(), NOW)).toBe(false)
})

test('join 缺失时按 and 处理', () => {
  const one = [{ f: 'title', op: 'has', v: '财务' }, { f: 'host', op: 'is', v: 'tm-bob' }]
  expect(matchesRule({ conds: one }, facts(), NOW)).toBe(false) // or 的话就会是 true
  expect(evaluateRule({ conds: one }, facts(), NOW).join).toBe('and')
})

test('join 取值不是 and/or 时按 and 处理，并留下可查的理由', () => {
  const one = [{ f: 'title', op: 'has', v: '财务' }, { f: 'host', op: 'is', v: 'tm-bob' }]
  const r = { join: 'xor' as unknown as 'and', conds: one }
  expect(matchesRule(r, facts(), NOW)).toBe(false)
  expect(describeRuleIssues(r).some((s) => s.includes('连接词'))).toBe(true)
})

// ── 不许静默放行：未知字段 / 未知 op / 值类型不对 ────────────────────

test('未知字段判不匹配（拼错字段名不该意外放行）', () => {
  expect(hit('titel', 'has', '财务')).toBe(false)
  expect(evaluateCond({ f: 'titel', op: 'has', v: '财务' }, facts(), NOW).reason).toBe('unknown_field')
})

test('未知 op 判不匹配：不会落进否定分支被当成「不包含 → 匹配」', () => {
  // 原型的二元 else 写法（op === 'has' ? hit : !hit）在这里会返回 true——
  // 标题里没有「人事」，否定分支就把未知 op 当成了 nothas。授权中枢里查不出来。
  expect(hit('title', 'nonsense', '人事')).toBe(false)
  expect(hit('title', 'nonsense', '财务')).toBe(false)
  expect(hit('host', 'nonsense', 'tm-bob')).toBe(false)
  expect(hit('dept', 'nonsense', ['市场部'], { dept: '财务部' })).toBe(false)
  expect(hit('dur', 'nonsense', 30)).toBe(false)
  expect(hit('age', 'nonsense', 7)).toBe(false)
  expect(hit('arch', 'nonsense')).toBe(false)
  expect(evaluateCond({ f: 'title', op: 'nonsense', v: '人事' }, facts(), NOW).reason).toBe('unknown_op')
})

test('op 张冠李戴（把别的字段的 op 用在本字段上）也一律不匹配', () => {
  expect(hit('title', 'is', '季度财务评审')).toBe(false)
  expect(hit('host', 'has', 'tm-alice')).toBe(false)
  expect(hit('dur', 'within', 30)).toBe(false)
})

test('值类型不对一律不匹配（不得落到某个 return true）', () => {
  // in/notin 的 v 不是数组
  expect(hit('dept', 'in', '财务部', { dept: '财务部' })).toBe(false)
  expect(hit('dept', 'notin', '市场部', { dept: '财务部' })).toBe(false)
  // dur/age 的 v 不是数字
  expect(hit('dur', 'gt', '30')).toBe(false)
  expect(hit('dur', 'lt', null)).toBe(false)
  expect(hit('age', 'within', 'abc')).toBe(false)
  expect(hit('age', 'before', NaN)).toBe(false)
  // title 的 v 是空串 / 只有分隔符：has 与 nothas 都不匹配，不能靠「没关键词 → 都不包含」放行
  expect(hit('title', 'has', '')).toBe(false)
  expect(hit('title', 'nothas', '')).toBe(false)
  expect(hit('title', 'nothas', ' ，, ')).toBe(false)
  expect(hit('title', 'has', ['财务'])).toBe(false)
  // host 的 v 不是非空字符串
  expect(hit('host', 'is', 123)).toBe(false)
  expect(hit('host', 'isnot', '')).toBe(false)
  expect(evaluateCond({ f: 'dur', op: 'gt', v: '30' }, facts(), NOW).reason).toBe('bad_value')
})

test('条件项本身不是 {f, op, v} 对象时判不匹配', () => {
  expect(matchesRule({ conds: [null as unknown as { f: string; op: string }] }, facts(), NOW)).toBe(false)
  expect(matchesRule({ conds: ['title has 财务' as unknown as { f: string; op: string }] }, facts(), NOW)).toBe(false)
})

test('conds 不是数组时判不匹配（不能当成「空 conds → 匹配一切」）', () => {
  const broken = { conds: null as unknown as CondRule['conds'] }
  expect(matchesRule(broken, facts(), NOW)).toBe(false)
  expect(describeRuleIssues(broken).some((s) => s.includes('数组'))).toBe(true)
})

// ── dept 无数据源：与「字段拼错」是两条不同的路径 ────────────────────

test('dept 在无数据源（null）时判不匹配，in 与 notin 都不匹配', () => {
  expect(hit('dept', 'in', ['财务部'])).toBe(false)
  // notin 尤其重要：部门未知不等于「不属于财务部」，不能靠这条静默放行
  expect(hit('dept', 'notin', ['财务部'])).toBe(false)
})

test('dept 无数据源与未知字段是两条不同的路径，理由说得出区别', () => {
  const noSource = evaluateCond({ f: 'dept', op: 'in', v: ['财务部'] }, facts({ dept: null }), NOW)
  const unknown = evaluateCond({ f: 'depat', op: 'in', v: ['财务部'] }, facts(), NOW)
  const plain = evaluateCond({ f: 'dept', op: 'in', v: ['市场部'] }, facts({ dept: '财务部' }), NOW)
  expect(noSource.matched).toBe(false)
  expect(unknown.matched).toBe(false)
  expect(plain.matched).toBe(false)
  expect(noSource.reason).toBe('no_data_source')
  expect(unknown.reason).toBe('unknown_field')
  expect(plain.reason).toBe('not_matched')
  expect(noSource.detail).toContain('企业微信')
  expect(noSource.reason).not.toBe(unknown.reason)
})

// ── title 的关键词分隔 ───────────────────────────────────────────────

test('title 关键词分隔：英文逗号、中文逗号、空白三种都认', () => {
  expect(hit('title', 'has', '人事,财务')).toBe(true)
  expect(hit('title', 'has', '人事，财务')).toBe(true)
  expect(hit('title', 'has', '人事 财务')).toBe(true)
  expect(hit('title', 'has', '人事,  行政，\t财务')).toBe(true) // 混用 + 多余空白
  expect(hit('title', 'nothas', '人事，行政 采购')).toBe(true)
  expect(hit('title', 'nothas', '人事，行政 评审')).toBe(false)
})

// ── dur / age 的边界 ────────────────────────────────────────────────

test('dur 的边界：正好等于阈值时 gt 与 lt 都不成立', () => {
  expect(hit('dur', 'gt', 60)).toBe(false)
  expect(hit('dur', 'lt', 60)).toBe(false)
  expect(hit('dur', 'gt', 59.999)).toBe(true)
  expect(hit('dur', 'lt', 60.001)).toBe(true)
})

test('age 的边界：正好第 N 天算「在最近 N 天内」，不算「早于 N 天」', () => {
  const exact = { recordEndTime: NOW - 7 * 86400 }
  expect(hit('age', 'within', 7, exact)).toBe(true)
  expect(hit('age', 'before', 7, exact)).toBe(false)
  // 差一秒就翻面，两个 op 互补、不留空隙
  const past = { recordEndTime: NOW - 7 * 86400 - 1 }
  expect(hit('age', 'within', 7, past)).toBe(false)
  expect(hit('age', 'before', 7, past)).toBe(true)
})

test('now 是显式参数：同一场会议换个 now 就换判定，求值器不读时钟', () => {
  const f = facts({ recordEndTime: NOW - 3 * 86400 })
  expect(matchesRule(rule([{ f: 'age', op: 'within', v: 7 }]), f, NOW)).toBe(true)
  expect(matchesRule(rule([{ f: 'age', op: 'within', v: 7 }]), f, NOW + 10 * 86400)).toBe(false)
})

// ── 时间数据缺失：expr.ts 那段 end_time 教训的当代版本 ────────────────

test('endTime 回落成 startTime 的镜像时，dur 的两个 op 都不匹配（不是「时长 0 分钟」）', () => {
  // record_files 全缺 record_end_time 时 endTime === startTime（domain/types.ts）。
  // 若照直算成 0 分钟，「dur lt 30」会把这类会议全部静默命中——正是 expr.ts
  // 当年拒绝 end_time 想避免的那种「查不出来的错误」。
  const noEnd = { startTime: NOW - 3600, endTime: NOW - 3600 }
  expect(hit('dur', 'lt', 30, noEnd)).toBe(false)
  expect(hit('dur', 'gt', 30, noEnd)).toBe(false)
  expect(evaluateCond({ f: 'dur', op: 'lt', v: 30 }, facts(noEnd), NOW).reason).toBe('no_data_source')
})

test('recordEndTime 缺失时 age 的两个 op 都不匹配（不是「1970 年，早于任何 N 天」）', () => {
  const noRec = { recordEndTime: 0 }
  expect(hit('age', 'before', 7, noRec)).toBe(false)
  expect(hit('age', 'within', 7, noRec)).toBe(false)
  expect(evaluateCond({ f: 'age', op: 'before', v: 7 }, facts(noRec), NOW).reason).toBe('no_data_source')
})

// ── T13 「事实为空」与「没有这个事实」是两条路径 ──────────────────────

test('missing 里的事实：条件判成 fact_missing，与 not_matched 分得开', () => {
  const noTitle = facts({ title: '', missing: ['title'] })
  // 空标题但**有**这个事实：真的比对过，不成立
  expect(evaluateCond({ f: 'title', op: 'has', v: '财务' }, facts({ title: '' }), NOW).reason)
    .toBe('not_matched')
  // 标题这个事实压根不存在：判不出来
  const ev = evaluateCond({ f: 'title', op: 'has', v: '财务' }, noTitle, NOW)
  expect(ev.matched).toBe(false)
  expect(ev.reason).toBe('fact_missing')
  expect(ev.detail).toContain('NULL')
  // 否定运算符尤其不许取巧判成 true——「没有标题」不等于「标题不含财务」
  expect(evaluateCond({ f: 'title', op: 'nothas', v: '财务' }, noTitle, NOW).matched).toBe(false)
})

test('只有用得上那项事实的字段才受影响', () => {
  const noTitle = facts({ title: '', missing: ['title'] })
  // 主持人这项事实还在，照常比对
  expect(evaluateCond({ f: 'host', op: 'is', v: 'tm-alice' }, noTitle, NOW).matched).toBe(true)
  // 归档状态来自 meeting_archives，与 meetings 表的 NULL 列无关
  expect(evaluateCond({ f: 'arch', op: 'notarch' }, noTitle, NOW).matched).toBe(true)
})

test('缺 startTime 时 dur 判不出来，而不是算出一个几十年的时长', () => {
  const noStart = facts({ startTime: 0, missing: ['startTime'] })
  // 照直算的话 endTime - 0 是五十多年，dur gt 30 会静默命中
  expect(evaluateCond({ f: 'dur', op: 'gt', v: 30 }, noStart, NOW).reason).toBe('fact_missing')
  expect(evaluateCond({ f: 'dur', op: 'lt', v: 30 }, noStart, NOW).reason).toBe('fact_missing')
})

test('字段拼错 / 值写错仍然优先报出来——静态问题在缺事实之前判', () => {
  // store/policy.ts 的写侧静态校验拿一组假事实探这几种 reason，顺序不能倒
  const noTitle = facts({ title: '', missing: ['title'] })
  expect(evaluateCond({ f: 'titel', op: 'has', v: '财务' }, noTitle, NOW).reason).toBe('unknown_field')
  expect(evaluateCond({ f: 'title', op: 'hasnt', v: '财务' }, noTitle, NOW).reason).toBe('unknown_op')
  expect(evaluateCond({ f: 'title', op: 'has', v: 42 }, noTitle, NOW).reason).toBe('bad_value')
})

test('evaluateRule.undecidable：或规则有一条缺事实就判不出来；且规则要其余都不确定', () => {
  const noTitle = facts({ title: '', missing: ['title'] })
  const titleCond = { f: 'title', op: 'has', v: '财务' }

  const or = evaluateRule({ join: 'or', conds: [titleCond, { f: 'host', op: 'is', v: 'tm-bob' }] }, noTitle, NOW)
  expect(or.matched).toBe(false)
  expect(or.undecidable).toBe(true)

  // 「且」里已经有一条确定不成立 → 整条确定不命中，不是判不出来
  const and = evaluateRule({ join: 'and', conds: [{ f: 'host', op: 'is', v: 'tm-bob' }, titleCond] }, noTitle, NOW)
  expect(and.matched).toBe(false)
  expect(and.undecidable).toBe(false)

  // 「或」里有一条成立 → 命中了就是判出来了
  const hit = evaluateRule({ join: 'or', conds: [titleCond, { f: 'host', op: 'is', v: 'tm-alice' }] }, noTitle, NOW)
  expect(hit.matched).toBe(true)
  expect(hit.undecidable).toBe(false)

  // 规则自己写坏了（conds 不是数组）确定不命中，不算判不出来
  expect(evaluateRule({ conds: 'nope' as unknown as CondRule['conds'] }, noTitle, NOW).undecidable).toBe(false)
})

test('missing 省略 / 为空时语义与这个字段加进来之前完全一致', () => {
  expect(evaluateRule({ conds: [{ f: 'title', op: 'has', v: '财务' }] }, facts(), NOW).undecidable).toBe(false)
  expect(evaluateRule({ conds: [{ f: 'title', op: 'has', v: '人事' }] }, facts({ missing: [] }), NOW).undecidable)
    .toBe(false)
})

// ── evaluateRule：逐条理由可回溯 ────────────────────────────────────

test('evaluateRule 逐条给出理由，供判定理由与规则编辑器使用', () => {
  const r: CondRule = {
    join: 'and',
    conds: [{ f: 'title', op: 'has', v: '财务' }, { f: 'dept', op: 'in', v: ['财务部'] }],
  }
  const ev = evaluateRule(r, facts(), NOW)
  expect(ev.matched).toBe(false)
  expect(ev.conds.length).toBe(2)
  expect(ev.conds[0]!.matched).toBe(true)
  expect(ev.conds[1]!.reason).toBe('no_data_source')
})

// ── describeRuleIssues：不依赖任何会议数据的静态检查 ──────────────────

test('describeRuleIssues：条件全是 dept 的规则永远不会命中', () => {
  const issues = describeRuleIssues({ join: 'or', conds: [
    { f: 'dept', op: 'in', v: ['财务部'] },
    { f: 'dept', op: 'notin', v: ['市场部'] },
  ] })
  expect(issues.length).toBeGreaterThan(0)
  expect(issues.some((s) => s.includes('永远不会命中'))).toBe(true)
  expect(issues.some((s) => s.includes('企业微信'))).toBe(true)
})

test('describeRuleIssues：and 规则里只要有一个 dept 条件，整条就永远不会命中', () => {
  const issues = describeRuleIssues({ join: 'and', conds: [
    { f: 'title', op: 'has', v: '财务' },
    { f: 'dept', op: 'in', v: ['财务部'] },
  ] })
  expect(issues.some((s) => s.includes('永远不会命中'))).toBe(true)
})

test('describeRuleIssues：or 规则里的 dept 条件只是形同虚设，不判整条失效', () => {
  const issues = describeRuleIssues({ join: 'or', conds: [
    { f: 'title', op: 'has', v: '财务' },
    { f: 'dept', op: 'in', v: ['财务部'] },
  ] })
  expect(issues.some((s) => s.includes('企业微信'))).toBe(true)
  expect(issues.some((s) => s.includes('永远不会命中'))).toBe(false)
})

test('describeRuleIssues：未知字段名', () => {
  const issues = describeRuleIssues({ conds: [{ f: 'titel', op: 'has', v: '财务' }] })
  expect(issues.some((s) => s.includes('titel'))).toBe(true)
})

test('describeRuleIssues：字段不支持的 op', () => {
  const issues = describeRuleIssues({ conds: [{ f: 'title', op: 'hasnt', v: '财务' }] })
  // 原型用的是 hasnt/isnt/older，本实现按计划 §3.3 取 nothas/isnot/before——
  // 拼写不一致时必须被看见，而不是悄悄按否定分支求值
  expect(issues.some((s) => s.includes('hasnt'))).toBe(true)
})

test('describeRuleIssues：值的类型与 op 不匹配', () => {
  expect(describeRuleIssues({ conds: [{ f: 'dept', op: 'in', v: '财务部' }] })
    .some((s) => s.includes('数组'))).toBe(true)
  expect(describeRuleIssues({ conds: [{ f: 'dur', op: 'gt', v: '30' }] })
    .some((s) => s.includes('数字'))).toBe(true)
  expect(describeRuleIssues({ conds: [{ f: 'title', op: 'has', v: '' }] })
    .some((s) => s.includes('关键词'))).toBe(true)
  expect(describeRuleIssues({ conds: [{ f: 'host', op: 'is', v: 42 }] }).length).toBeGreaterThan(0)
  expect(describeRuleIssues({ conds: [{ f: 'age', op: 'within', v: -3 }] })
    .some((s) => s.includes('负'))).toBe(true)
})

test('describeRuleIssues：一条正常规则没有任何问题', () => {
  expect(describeRuleIssues({ join: 'and', conds: [
    { f: 'title', op: 'has', v: '财务,预算' },
    { f: 'dur', op: 'gt', v: 30 },
    { f: 'arch', op: 'isarch' },
  ] })).toEqual([])
  expect(describeRuleIssues({ conds: [] })).toEqual([])
})
