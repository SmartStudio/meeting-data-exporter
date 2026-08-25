import { expect, test } from 'bun:test'
import type { MeetingFacts } from '../../src/policy/conds'
import { previewStackImpact, type PreviewSubject } from '../../src/policy/preview'
import {
  evaluateAllowStack,
  evaluateArchiveStack,
  evaluateFetchStack,
  evaluateStacks,
  type StackRule,
} from '../../src/policy/stacks'
import {
  applyOverride,
  applyOverrides,
  indexOverrides,
  overriddenPreviewFilter,
  wasOverridden,
  type MeetingOverride,
} from '../../src/policy/override'

/** 2026-01-01 00:00:00 UTC。求值器里不许读时钟，所有用例显式传这个 now */
const NOW = 1767225600
const PROGRAM = 'svc-archiver'

function facts(over: Partial<MeetingFacts> = {}): MeetingFacts {
  return {
    title: '季度财务评审',
    hostUserId: 'tm-alice',
    dept: null,
    startTime: NOW - 7200,
    endTime: NOW - 3600,
    recordEndTime: NOW - 3600,
    archived: false,
    ...over,
  }
}

/** 造一条规则。默认无条件（匹配一切） */
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

/** 造一条人工改写。默认落在会议 m-1/s-1 上，资产范围不另行指定（D-r 的 null 态） */
function ov(
  over: Partial<MeetingOverride> & Pick<MeetingOverride, 'kind' | 'effect'>,
): MeetingOverride {
  return {
    meetingId: 'm-1',
    subMeetingId: 's-1',
    assetTypes: null,
    reason: null,
    ...over,
  }
}

const fetchIn = { facts: facts(), now: NOW }
const allowIn = { facts: facts(), now: NOW, programId: PROGRAM }

// ── §5.4 改写优先于所有规则 ─────────────────────────────────────

test('改写优先于任何规则，包括 priority 最高的那条', () => {
  const rules = [rule({ id: 7, kind: 'allow', priority: 9999, effect: 'allow', note: '董事会全放行' })]
  const byRule = evaluateAllowStack(rules, allowIn)
  expect(byRule.effect).toBe('allow')

  const d = applyOverride(byRule, ov({ kind: 'allow', effect: 'deny', reason: '法务要求这场不外发' }))
  expect(d.effect).toBe('deny')
  expect(d.source).toBe('override')
  // D-t：改写没有规则，ruleId 置 null，note 放管理员写的 reason
  expect(d.ruleId).toBeNull()
  expect(d.note).toBe('法务要求这场不外发')
  expect(d.assetTypes).toEqual([])
  expect(d.issues).toEqual([])
  // 判定理由要同时说出「人工改写决定了什么」与「规则本来会判什么」
  expect(d.reason).toContain('人工改写')
  expect(d.reason).toContain('准许采集')
  expect(d.reason).toContain('法务要求这场不外发')

  // 纯函数：不改动传进来的判定
  expect(byRule.effect).toBe('allow')
  expect(byRule.source).toBe('rule')
  expect('overriddenFrom' in byRule).toBe(false)
})

test('撤销改写后逐字回落到规则判定，overriddenFrom 为 null', () => {
  const rules = [rule({ id: 1, kind: 'fetch', effect: 'all', assetTypes: ['video'], note: '默认拉取' })]
  const byRule = evaluateFetchStack(rules, fetchIn)

  const gone = applyOverride(byRule, null)
  expect(gone.overriddenFrom).toBeNull()
  expect(gone).toEqual({ ...byRule, overriddenFrom: null })
  expect(wasOverridden(gone)).toBe(false)

  // undefined（该会议在改写表里根本没有行）与 null 同义
  expect(applyOverride(byRule, undefined)).toEqual({ ...byRule, overriddenFrom: null })
})

test('改写只对该场会议生效，别的会议照规则判', () => {
  const rules = [rule({ id: 3, kind: 'allow', effect: 'allow', assetTypes: ['transcript'], note: '放行转写' })]
  const a = evaluateStacks(rules, { facts: facts({ title: 'A 会' }), now: NOW, programId: PROGRAM })
  const b = evaluateStacks(rules, { facts: facts({ title: 'B 会' }), now: NOW, programId: PROGRAM })

  const table = new Map([
    ['m-a/s-1', indexOverrides([ov({ kind: 'allow', effect: 'deny', reason: '只关这一场' })])],
  ])

  const outA = applyOverrides(a, table.get('m-a/s-1'))
  const outB = applyOverrides(b, table.get('m-b/s-1'))

  expect(outA.allow.effect).toBe('deny')
  expect(outA.allow.source).toBe('override')
  expect(outB.allow.effect).toBe('allow')
  expect(outB.allow.source).toBe('rule')
  expect(outB.allow.ruleId).toBe(3)
  expect(outB.allow.overriddenFrom).toBeNull()
  expect(outB.allow.assetTypes).toEqual(['transcript'])
})

test('三个 kind 互不干扰：改写了 allow 不影响 fetch / archive', () => {
  const rules = [
    rule({ id: 1, kind: 'fetch', effect: 'all', assetTypes: ['video', 'audio'] }),
    rule({ id: 2, kind: 'archive', effect: '/nas/finance/{年}/' }),
    rule({ id: 3, kind: 'allow', effect: 'allow', assetTypes: ['*'] }),
  ]
  const plain = evaluateStacks(rules, allowIn)
  const out = applyOverrides(plain, indexOverrides([ov({ kind: 'allow', effect: 'deny' })]))

  expect(out.allow.effect).toBe('deny')
  expect(out.allow.overriddenFrom).not.toBeNull()

  expect(out.fetch).toEqual({ ...plain.fetch, overriddenFrom: null })
  expect(out.archive).toEqual({ ...plain.archive, overriddenFrom: null })
  expect(out.fetch.source).toBe('rule')
  expect(out.archive.effect).toBe('/nas/finance/{年}/')
})

// ── D-p 脏 effect：override_invalid，而且三栈安全侧各不相同 ────────

test('脏 effect 的改写落到本栈安全侧，source 是 override_invalid 而不是 override', () => {
  const rules = [
    rule({ id: 1, kind: 'fetch', effect: 'all' }),
    rule({ id: 2, kind: 'archive', effect: '/nas/finance/{年}/' }),
    rule({ id: 3, kind: 'allow', effect: 'allow' }),
  ]
  const plain = evaluateStacks(rules, allowIn)
  const out = applyOverrides(
    plain,
    indexOverrides([
      ov({ kind: 'fetch', effect: 'allwo' }),
      ov({ kind: 'archive', effect: '   ' }),
      ov({ kind: 'allow', effect: 'aloww' }),
    ]),
  )

  // 三栈的安全侧不同：fetch → skip，archive → skip，allow → deny
  expect(out.fetch.effect).toBe('skip')
  expect(out.archive.effect).toBe('skip')
  expect(out.allow.effect).toBe('deny')

  for (const d of [out.fetch, out.archive, out.allow]) {
    expect(d.source).toBe('override_invalid')
    expect(d.issues.length).toBeGreaterThan(0)
    expect(d.issues.join('')).toContain('安全侧')
    expect(d.assetTypes).toEqual([])
    // 脏归脏，它仍然是一次人工改写，规则一样被顶掉了
    expect(d.overriddenFrom).not.toBeNull()
    expect(wasOverridden(d)).toBe(true)
  }
  expect(out.fetch.reason).toContain('人工改写')
  expect(out.fetch.reason).toContain('allwo')
})

test('改写记的 kind 与所套的栈对不上时，落到本栈安全侧并说明，不拿它当本栈的决定', () => {
  const rules = [rule({ id: 2, kind: 'archive', effect: '/nas/finance/{年}/' })]
  const byRule = evaluateArchiveStack(rules, fetchIn)

  // 一条 fetch 改写（effect 'all'）被套到归档栈上：'all' 恰好是个「非空字符串」，
  // 若不查 kind 就会被当成一个叫 all 的目录模板，把这场会议归到 all 这个目录去
  const d = applyOverride(byRule, ov({ kind: 'fetch', effect: 'all' }))
  expect(d.effect).toBe('skip')
  expect(d.source).toBe('override_invalid')
  expect(d.issues.join('')).toContain('拉取规则')
  expect(d.overriddenFrom?.effect).toBe('/nas/finance/{年}/')
})

// ── D-r assetTypes 三态 ────────────────────────────────────────

test('assetTypes 为 null 时沿用被改写掉的那个判定的资产范围', () => {
  const rules = [rule({ id: 3, kind: 'allow', effect: 'allow', assetTypes: ['transcript', 'video'] })]
  const byRule = evaluateAllowStack(rules, allowIn)

  const d = applyOverride(byRule, ov({ kind: 'allow', effect: 'allow', assetTypes: null }))
  expect(d.effect).toBe('allow')
  expect(d.assetTypes).toEqual(['transcript', 'video'])
  expect(d.issues).toEqual([])
})

test('assetTypes 是非空数组时当白名单，不认识的名字丢掉并报出来', () => {
  const rules = [rule({ id: 3, kind: 'allow', effect: 'allow', assetTypes: ['*'] })]
  const byRule = evaluateAllowStack(rules, allowIn)

  const d = applyOverride(
    byRule,
    ov({ kind: 'allow', effect: 'allow', assetTypes: ['transcript', 'summary'] }),
  )
  expect(d.assetTypes).toEqual(['transcript'])
  expect(d.issues.join('')).toContain('summary')
  expect(d.issues.join('')).toContain('不是合法的资产键')
})

test('assetTypes 是空数组时一类都不放行', () => {
  const rules = [rule({ id: 3, kind: 'allow', effect: 'allow', assetTypes: ['*'] })]
  const byRule = evaluateAllowStack(rules, allowIn)

  const d = applyOverride(byRule, ov({ kind: 'allow', effect: 'allow', assetTypes: [] }))
  expect(d.effect).toBe('allow')
  expect(d.assetTypes).toEqual([])
  expect(d.issues.length).toBeGreaterThan(0)
})

test('改写成放行但没指定资产范围、规则侧本来就一类都不放行时，实际仍取不到，且必须带 issue', () => {
  // 规则侧判 deny，按 StackDecision.assetTypes 的注释它恒为空数组
  const rules = [rule({ id: 3, kind: 'allow', effect: 'deny' })]
  const byRule = evaluateAllowStack(rules, allowIn)
  expect(byRule.assetTypes).toEqual([])

  const d = applyOverride(byRule, ov({ kind: 'allow', effect: 'allow', assetTypes: null }))
  // 故意的安全侧：null 不等于「全部八类」，一次没填完的改写不许悄悄放宽范围
  expect(d.effect).toBe('allow')
  expect(d.assetTypes).toEqual([])
  expect(d.issues.length).toBeGreaterThan(0)
  expect(d.issues.join('')).toContain('资产')
  // 这句话必须是人话：管理员会盯着「放行了却取不到」发懵
  expect(d.issues.join('')).toContain('取不到')
})

test('null 的沿用不会把范围放宽：规则只拉转写时，改写成拉取也只拉转写', () => {
  const rules = [rule({ id: 1, kind: 'fetch', effect: 'all', assetTypes: ['transcript'] })]
  const byRule = evaluateFetchStack(rules, fetchIn)

  const d = applyOverride(byRule, ov({ kind: 'fetch', effect: 'all', assetTypes: null }))
  expect(d.assetTypes).toEqual(['transcript'])
})

// ── D-q overriddenFrom 与 trace ────────────────────────────────

test('overriddenFrom 带着原本那条规则的 ruleId / note / reason', () => {
  const rules = [
    rule({ id: 42, kind: 'allow', effect: 'allow', assetTypes: ['video'], note: '销售复盘可外发' }),
  ]
  const byRule = evaluateAllowStack(rules, allowIn)

  const d = applyOverride(byRule, ov({ kind: 'allow', effect: 'deny', reason: '客户要求删除' }))
  expect(d.overriddenFrom).not.toBeNull()
  expect(d.overriddenFrom?.ruleId).toBe(42)
  expect(d.overriddenFrom?.note).toBe('销售复盘可外发')
  expect(d.overriddenFrom?.source).toBe('rule')
  expect(d.overriddenFrom?.assetTypes).toEqual(['video'])
  expect(d.overriddenFrom?.reason).toBe(byRule.reason)
})

test('trace 在有改写时仍是规则侧那份考察记录', () => {
  const rules = [
    rule({
      id: 1,
      kind: 'allow',
      priority: 200,
      effect: 'deny',
      conds: [{ f: 'title', op: 'has', v: '董事会' }],
    }),
    rule({ id: 2, kind: 'allow', priority: 150, effect: 'allow', subjectType: 'user', subjectValue: 'tm-alice' }),
    rule({ id: 3, kind: 'allow', priority: 100, effect: 'allow', assetTypes: ['audio'], note: '兜底放行' }),
  ]
  const byRule = evaluateAllowStack(rules, allowIn)
  expect(byRule.trace.map((t) => t.outcome)).toEqual(['not_matched', 'subject_mismatch', 'matched'])

  const d = applyOverride(byRule, ov({ kind: 'allow', effect: 'deny' }))
  // 规则确实被考察过，那段考察记录是真的，只是最后没轮到它说话
  expect(d.trace).toEqual(byRule.trace)
  expect(d.trace).toEqual(d.overriddenFrom!.trace)
})

// ── 索引与预览钩子 ─────────────────────────────────────────────

test('indexOverrides 按 kind 归位，同一 kind 多条时取 createdAt 最新的那条', () => {
  const set = indexOverrides([
    ov({ kind: 'allow', effect: 'allow', reason: '旧的', createdAt: 100 }),
    ov({ kind: 'allow', effect: 'deny', reason: '新的', createdAt: 200 }),
    ov({ kind: 'fetch', effect: 'skip', reason: '别栈的' }),
  ])
  expect(set.allow?.reason).toBe('新的')
  expect(set.fetch?.effect).toBe('skip')
  expect(set.archive).toBeUndefined()
})

test('预览钩子：一批会议里只有被改写的那些落进 shielded', () => {
  const base = rule({ id: 5, kind: 'allow', effect: 'allow', assetTypes: ['*'], subjectValue: 'svc-a', note: '全放行' })
  const oldRules = [base]
  const newRules = [{ ...base, effect: 'deny' }]

  const subjects: PreviewSubject[] = ['m-1', 'm-2', 'm-3'].map((meetingId) => ({
    key: `${meetingId}|svc-a`,
    facts: facts({ title: `会议 ${meetingId}` }),
    programId: 'svc-a',
  }))
  const targetOf = (subject: PreviewSubject) => ({
    meetingId: subject.key.split('|')[0]!,
    subMeetingId: 's-1',
  })

  const preview = previewStackImpact({
    kind: 'allow',
    oldRules,
    newRules,
    subjects,
    now: NOW,
    overridden: overriddenPreviewFilter(
      [ov({ kind: 'allow', effect: 'deny', meetingId: 'm-2' })],
      'allow',
      targetOf,
    ),
  })

  expect(preview.shielded.map((c) => c.key)).toEqual(['m-2|svc-a'])
  expect(preview.changed.map((c) => c.key)).toEqual(['m-1|svc-a', 'm-3|svc-a'])
  expect(preview.counts.shielded).toBe(1)
  expect(preview.counts.tightened).toBe(2)
})

test('预览钩子：一条改写挡住这场会议的所有采集程序，别栈的改写不算数', () => {
  const a = rule({ id: 5, kind: 'allow', effect: 'allow', assetTypes: ['*'], subjectValue: 'svc-a' })
  const b = rule({ id: 6, kind: 'allow', effect: 'allow', assetTypes: ['*'], subjectValue: 'svc-b' })
  const oldRules = [a, b]
  const newRules = [
    { ...a, effect: 'deny' },
    { ...b, effect: 'deny' },
  ]
  const subjects: PreviewSubject[] = [
    { key: 'm-1|svc-a', facts: facts(), programId: 'svc-a' },
    { key: 'm-1|svc-b', facts: facts(), programId: 'svc-b' },
    { key: 'm-9|svc-a', facts: facts(), programId: 'svc-a' },
  ]
  const targetOf = (subject: PreviewSubject) => ({
    meetingId: subject.key.split('|')[0]!,
    subMeetingId: 's-1',
  })

  const preview = previewStackImpact({
    kind: 'allow',
    oldRules,
    newRules,
    subjects,
    now: NOW,
    overridden: overriddenPreviewFilter(
      [
        // 会议 m-1 上的一条改写，挡住这场会议对 svc-a 与 svc-b 两条判定
        ov({ kind: 'allow', effect: 'deny', meetingId: 'm-1' }),
        // m-9 上有的是拉取栈的改写，挡不住采集权限栈
        ov({ kind: 'fetch', effect: 'skip', meetingId: 'm-9' }),
      ],
      'allow',
      targetOf,
    ),
  })

  expect(preview.shielded.map((c) => c.key)).toEqual(['m-1|svc-a', 'm-1|svc-b'])
  expect(preview.changed.map((c) => c.key)).toEqual(['m-9|svc-a'])
})
