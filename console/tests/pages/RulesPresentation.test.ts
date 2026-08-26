import { describe, expect, test } from 'vitest'
import type { Rule } from '../../src/api/admin/rules'
import {
  describeCondition,
  describeEffect,
  effectUsesAssetTypes,
  fieldOf,
  opOf,
  splitKeywords,
  missingFactLabel,
  titleDisplay,
} from '../../src/pages/Rules/fields'
import { RULES_SCHEMA } from '../helpers/rulesSchema'
import {
  STACK_META,
  blockedByUnconditional,
  groupByStack,
  neverMatchesForLackOfDataSource,
  sortForDisplay,
} from '../../src/pages/Rules/order'

function rule(over: Partial<Rule>): Rule {
  return {
    id: 1,
    kind: 'allow',
    priority: 100,
    enabled: true,
    join: 'and',
    conds: [{ f: 'title', op: 'has', v: '财务' }],
    condsMalformed: false,
    subjectType: 'program',
    subjectValue: 'kb-indexer',
    assetTypes: ['ai_minutes'],
    effect: 'allow',
    note: null,
    createdBy: 'admin-0',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    issues: [],
    ...over,
  }
}

/* ── 字段与运算符清单：全部来自 GET /rules/schema ──────────────── */

describe('条件字段清单（后端下发，前端不存一份）', () => {
  test('查表读的就是 schema 里那几项，前端没有第二份清单', () => {
    expect(RULES_SCHEMA.fields.map((f) => f.f)).toEqual([
      'title',
      'dept',
      'host',
      'dur',
      'age',
      'arch',
    ])
    expect(fieldOf(RULES_SCHEMA, 'title')!.label).toBe('会议标题')
    expect(opOf(fieldOf(RULES_SCHEMA, 'age'), 'within')!.label).toBe('在最近')
  })

  test('未知字段返回 null，不当成某个已知字段——静默认错比报错危险', () => {
    expect(fieldOf(RULES_SCHEMA, 'titel')).toBeNull()
    expect(fieldOf(RULES_SCHEMA, 'title')).not.toBeNull()
  })

  test('字段认得但不支持这个运算符时返回 null，不折成它的第一个运算符', () => {
    expect(opOf(fieldOf(RULES_SCHEMA, 'title'), 'hasnt')).toBeNull()
  })

  test('清单读不出来（schema 为 null）时查不到任何东西，也不会凭空变出一份', () => {
    expect(fieldOf(null, 'title')).toBeNull()
    expect(effectUsesAssetTypes(null, 'fetch', 'all')).toBe(false)
  })

  test('关键词的切法用后端下发的那一个（英文逗号 / 中文逗号 / 空白都认）', () => {
    expect(splitKeywords(fieldOf(RULES_SCHEMA, 'title'), '财务，市场 复盘')).toEqual([
      '财务',
      '市场',
      '复盘',
    ])
  })

  test('拿不到切法时整串当一个词，不随手补一个正则顶上', () => {
    expect(splitKeywords(fieldOf(RULES_SCHEMA, 'host'), '财务，市场')).toEqual(['财务，市场'])
    expect(splitKeywords(null, '财务，市场')).toEqual(['财务，市场'])
  })

  test('资产类型选了之后算不算数，也是后端说的', () => {
    expect(effectUsesAssetTypes(RULES_SCHEMA, 'fetch', 'all')).toBe(true)
    expect(effectUsesAssetTypes(RULES_SCHEMA, 'fetch', 'skip')).toBe(false)
    expect(effectUsesAssetTypes(RULES_SCHEMA, 'allow', 'allow')).toBe(true)
    // 取值域之外的一律 false：说不准的时候不显示资产选择器
    expect(effectUsesAssetTypes(RULES_SCHEMA, 'fetch', 'garbage')).toBe(false)
  })
})

describe('describeCondition', () => {
  const desc = (cond: { f: string; op: string; v?: unknown } | null) =>
    describeCondition(RULES_SCHEMA, cond)

  test('照后端下发的分隔口径切关键词（英文逗号 / 中文逗号 / 空白都认）', () => {
    expect(desc({ f: 'title', op: 'has', v: '财务，市场 复盘' })).toBe(
      '会议标题 包含任一「财务 / 市场 / 复盘」',
    )
  })

  test('无值运算符不拼一个空的值', () => {
    expect(desc({ f: 'arch', op: 'isarch' })).toBe('归档状态 已写入 NAS')
  })

  test('数字字段带单位，「内」也是后端给的，不是前端为 within 写的特例', () => {
    expect(desc({ f: 'dur', op: 'gt', v: 30 })).toBe('会议时长 大于 30 分钟')
    expect(desc({ f: 'age', op: 'within', v: 90 })).toBe('录制结束 在最近 90 天内')
  })

  test('未知字段 / 未知运算符照原样显示并标出来，不假装读得懂', () => {
    expect(desc({ f: 'titel', op: 'has', v: 'x' })).toBe('未知字段「titel」 has「x」')
    expect(desc({ f: 'title', op: 'hasnt', v: 'x' })).toBe('会议标题 不支持的运算符「hasnt」「x」')
  })

  test('后端漏登记运算符中文名时说出来，不拿 op 原值冒充中文名', () => {
    const holey = structuredClone(RULES_SCHEMA)
    holey.fields[0]!.ops[0]!.label = null
    expect(describeCondition(holey, { f: 'title', op: 'has', v: 'x' })).toBe(
      '会议标题 运算符「has」（后端没有登记中文名）「x」',
    )
  })

  test('清单读不出来时只报库里的原值，一个字都不猜', () => {
    expect(describeCondition(null, { f: 'title', op: 'has', v: '财务' })).toBe('title has「财务」')
  })

  test('写坏的条件项（null）说得出它写坏了，不渲染成空', () => {
    expect(desc(null)).toBe('这个条件写坏了（不是 { f, op, v } 形式的对象）')
    expect(describeCondition(null, null)).toBe('这个条件写坏了（不是 { f, op, v } 形式的对象）')
  })
})

describe('describeEffect —— 取值域来自 schema，句子的拼法留在前端', () => {
  const eff = (kind: string, effect: string, assets: string[] = []) =>
    describeEffect(RULES_SCHEMA, kind, effect, assets)

  test('三栈各自的正反两面', () => {
    expect(eff('fetch', 'all', ['ai_minutes'])).toBe('拉取（ai_minutes）')
    expect(eff('fetch', 'skip')).toBe('不拉取')
    expect(eff('archive', 'skip')).toBe('不归档')
    expect(eff('archive', '/nas/finance/{年}/')).toBe('归档到 /nas/finance/{年}/')
    expect(eff('allow', 'allow', ['*'])).toBe('准许采集（*）')
    expect(eff('allow', 'deny')).toBe('禁止采集')
  })

  test('正面判定却一类资产都没列，说出来', () => {
    expect(eff('allow', 'allow', [])).toBe('准许采集（未列出任何资产类型）')
  })

  test('认不出的 effect 原样显示并标出来，不替它落一个兜底', () => {
    // 这条兜底比后端严：后端的 describeStackEffect 只在归一化之后才被调用，
    // 而前端拿到的 `rule.effect` 是库里那一列的原值
    expect(eff('fetch', 'text')).toBe('认不出的 effect「text」')
    expect(eff('archive', '   ')).toBe('认不出的 effect「   」')
    expect(eff('sideways', 'all')).toBe('认不出的 effect「all」')
  })

  test('清单读不出来时只报 effect 原值，不说它认不认得', () => {
    expect(describeEffect(null, 'fetch', 'all', ['*'])).toBe('all')
  })
})

/* ── 事实缺失 vs 事实为空（阶段 4 · T13）─────────────────────── */

describe('titleDisplay —— "标题缺失"与"标题为空"必须分得开', () => {
  test('标题缺失：库里那一列是 NULL', () => {
    expect(titleDisplay('', ['title'])).toEqual({
      text: '标题缺失',
      kind: 'missing',
      hint: '这场会议的标题在库里根本不存在（元数据没拉回来），不是"标题是空的"。用到标题的条件对它判不出来。',
    })
  })

  test('标题为空：真的存了一个空串', () => {
    expect(titleDisplay('', [])).toEqual({ text: '（标题为空）', kind: 'empty', hint: null })
  })

  test('有标题就是有标题', () => {
    expect(titleDisplay('产品周会', [])).toEqual({ text: '产品周会', kind: 'ok', hint: null })
  })

  test('标题有值但 missing 里也报了标题——以 missing 为准，宁可多说一句', () => {
    expect(titleDisplay('产品周会', ['title']).kind).toBe('missing')
  })

  test('缺失项的中文名逐字对齐后端 FACT_LABEL', () => {
    expect(missingFactLabel('title')).toBe('标题')
    expect(missingFactLabel('hostUserId')).toBe('主持人')
    expect(missingFactLabel('startTime')).toBe('开始时间')
    expect(missingFactLabel('endTime')).toBe('结束时间')
  })

  test('后端将来加一项缺失事实时原样显示，不悄悄丢掉', () => {
    expect(missingFactLabel('somethingNew')).toBe('somethingNew')
  })
})

describe('八类资产（同样来自 schema，前端不再抄一份键名）', () => {
  test('用网关的键名，不许出现 summary / aitr / digest 那套短名', () => {
    expect(RULES_SCHEMA.assetTypes.map((a) => a.value)).toEqual([
      'video',
      'audio',
      'transcript',
      'ai_transcript',
      'ai_minutes',
      'ai_topic_minutes',
      'ai_speaker_minutes',
      'ai_ds_minutes',
    ])
    for (const a of RULES_SCHEMA.assetTypes) expect(a.label).toBeTypeOf('string')
  })
})

/* ── 呈现用的排序 ─────────────────────────────────────────────── */

describe('sortForDisplay —— 屏幕顺序 = 判定顺序（spec §5.1 第 2 步）', () => {
  test('priority 降序', () => {
    const out = sortForDisplay([rule({ id: 1, priority: 10 }), rule({ id: 2, priority: 200 })])
    expect(out.map((r) => r.id)).toEqual([2, 1])
  })

  test('同 priority 按 id 升序——先建的先命中，不按 effect 决定平局', () => {
    const out = sortForDisplay([
      rule({ id: 7, priority: 50, effect: 'deny' }),
      rule({ id: 3, priority: 50, effect: 'allow' }),
    ])
    expect(out.map((r) => r.id)).toEqual([3, 7])
  })

  test('停用的规则留在它启用时会站的那一格，不沉底', () => {
    const out = sortForDisplay([
      rule({ id: 1, priority: 10 }),
      rule({ id: 2, priority: 100, enabled: false }),
    ])
    expect(out.map((r) => r.id)).toEqual([2, 1])
  })

  test('priority 是脏数据时排到最后，且顺序仍然确定', () => {
    const out = sortForDisplay([
      rule({ id: 1, priority: Number.NaN }),
      rule({ id: 2, priority: 1 }),
      rule({ id: 3, priority: Number.NaN }),
    ])
    expect(out.map((r) => r.id)).toEqual([2, 1, 3])
  })

  test('不改动传进来的数组', () => {
    const input = [rule({ id: 1, priority: 1 }), rule({ id: 2, priority: 2 })]
    sortForDisplay(input)
    expect(input.map((r) => r.id)).toEqual([1, 2])
  })
})

describe('groupByStack', () => {
  test('三栈各自一组，认不出的 kind 单独一组——不许悄悄丢掉', () => {
    const g = groupByStack([
      rule({ id: 1, kind: 'fetch' }),
      rule({ id: 2, kind: 'allow' }),
      rule({ id: 3, kind: 'archive' }),
      rule({ id: 4, kind: 'sideways' }),
    ])
    expect(g.fetch.map((r) => r.id)).toEqual([1])
    expect(g.archive.map((r) => r.id)).toEqual([3])
    expect(g.allow.map((r) => r.id)).toEqual([2])
    expect(g.unknown.map((r) => r.id)).toEqual([4])
  })

  test('每栈的兜底逐字对齐 spec §4.6：allow 是 deny，另两栈是 skip', () => {
    expect(STACK_META.allow.fallback).toBe('deny')
    expect(STACK_META.fetch.fallback).toBe('skip')
    expect(STACK_META.archive.fallback).toBe('skip')
    expect(STACK_META.allow.fallbackText).toMatch(/默认全部拒绝/)
  })
})

describe('blockedByUnconditional —— 只说得准的那一种"被上面挡住"', () => {
  test('上面有一条启用的无条件规则时，下面每一条都够不着', () => {
    const rules = sortForDisplay([
      rule({ id: 1, priority: 200, conds: [] }),
      rule({ id: 2, priority: 100 }),
      rule({ id: 3, priority: 50 }),
    ])
    const blocked = blockedByUnconditional(rules)
    expect(blocked.get(2)).toBe(1)
    expect(blocked.get(3)).toBe(1)
    expect(blocked.has(1)).toBe(false)
  })

  test('停用的无条件规则挡不住任何人', () => {
    const rules = sortForDisplay([
      rule({ id: 1, priority: 200, conds: [], enabled: false }),
      rule({ id: 2, priority: 100 }),
    ])
    expect(blockedByUnconditional(rules).size).toBe(0)
  })

  test('有条件的规则不算挡住——那要真的求值一遍，前端说不准就不说', () => {
    const rules = sortForDisplay([
      rule({ id: 1, priority: 200, conds: [{ f: 'title', op: 'has', v: 'x' }] }),
      rule({ id: 2, priority: 100 }),
    ])
    expect(blockedByUnconditional(rules).size).toBe(0)
  })

  test('conds 列本身写坏的规则不算无条件——它命中什么谁也不知道', () => {
    const rules = sortForDisplay([
      rule({ id: 1, priority: 200, conds: [], condsMalformed: true }),
      rule({ id: 2, priority: 100 }),
    ])
    expect(blockedByUnconditional(rules).size).toBe(0)
  })
})

describe('neverMatchesForLackOfDataSource —— 只有 dept 条件的规则永远不会命中', () => {
  const never = (over: Partial<Rule>) => neverMatchesForLackOfDataSource(RULES_SCHEMA, rule(over))

  test('全是 dept 条件时报得出来（and / or 都一样）', () => {
    expect(never({ conds: [{ f: 'dept', op: 'in', v: ['财务部'] }] })).toBe(true)
    expect(
      never({
        join: 'or',
        conds: [
          { f: 'dept', op: 'in', v: ['财务部'] },
          { f: 'dept', op: 'notin', v: ['市场部'] },
        ],
      }),
    ).toBe(true)
  })

  test('掺了一个有数据源的字段时，用「或」连就可能命中——不许下断言', () => {
    expect(
      never({
        join: 'or',
        conds: [
          { f: 'dept', op: 'in', v: ['财务部'] },
          { f: 'title', op: 'has', v: '财务' },
        ],
      }),
    ).toBe(false)
  })

  test('空条件 / conds 写坏 / 有 null 条件时都不下断言', () => {
    expect(never({ conds: [] })).toBe(false)
    expect(never({ conds: [], condsMalformed: true })).toBe(false)
    expect(never({ conds: [null] })).toBe(false)
  })

  test('清单读不出来时一句都不说——「这条规则是死的」不是能猜的结论', () => {
    expect(
      neverMatchesForLackOfDataSource(null, rule({ conds: [{ f: 'dept', op: 'in', v: ['财务部'] }] })),
    ).toBe(false)
  })
})
