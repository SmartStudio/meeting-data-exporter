import { describe, expect, test } from 'vitest'
import type { Rule } from '../../src/api/admin/rules'
import {
  ASSET_KEYS,
  CONDITION_FIELDS,
  OP_LABEL,
  describeCondition,
  describeEffect,
  fieldSpec,
  missingFactLabel,
  titleDisplay,
} from '../../src/pages/Rules/fields'
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

/* ── 字段与运算符清单 ─────────────────────────────────────────── */

describe('条件字段清单（spec §5.3）', () => {
  test('六个字段一个不少，运算符逐字对齐后端 CONDITION_FIELDS', () => {
    expect(Object.keys(CONDITION_FIELDS)).toEqual(['title', 'dept', 'host', 'dur', 'age', 'arch'])
    expect(CONDITION_FIELDS.title!.ops).toEqual(['has', 'nothas'])
    expect(CONDITION_FIELDS.dept!.ops).toEqual(['in', 'notin'])
    expect(CONDITION_FIELDS.host!.ops).toEqual(['is', 'isnot'])
    expect(CONDITION_FIELDS.dur!.ops).toEqual(['gt', 'lt'])
    expect(CONDITION_FIELDS.age!.ops).toEqual(['within', 'before'])
    expect(CONDITION_FIELDS.arch!.ops).toEqual(['isarch', 'notarch'])
  })

  test('每个运算符都有中文名——清单里出现的字一个都不能落到 undefined', () => {
    for (const spec of Object.values(CONDITION_FIELDS)) {
      for (const op of spec.ops) expect(OP_LABEL[op]).toBeTypeOf('string')
    }
  })

  test('dept 可见但禁用，且带得出原因（R0 已定为不做，这是最终形态）', () => {
    expect(CONDITION_FIELDS.dept!.available).toBe(false)
    expect(CONDITION_FIELDS.dept!.unavailableReason).toMatch(/企业微信通讯录/)
    // 其余五个都有数据源
    for (const [key, spec] of Object.entries(CONDITION_FIELDS)) {
      if (key !== 'dept') expect(spec.available).toBe(true)
    }
  })

  test('未知字段返回 null，不当成某个已知字段——静默认错比报错危险', () => {
    expect(fieldSpec('titel')).toBeNull()
    expect(fieldSpec('title')).not.toBeNull()
  })
})

describe('describeCondition', () => {
  test('照后端的分隔口径切关键词（英文逗号 / 中文逗号 / 空白都认）', () => {
    expect(describeCondition({ f: 'title', op: 'has', v: '财务，市场 复盘' })).toBe(
      '会议标题 包含任一「财务 / 市场 / 复盘」',
    )
  })

  test('无值运算符不拼一个空的值', () => {
    expect(describeCondition({ f: 'arch', op: 'isarch' })).toBe('归档状态 已写入 NAS')
  })

  test('数字字段带单位', () => {
    expect(describeCondition({ f: 'dur', op: 'gt', v: 30 })).toBe('会议时长 大于 30 分钟')
    expect(describeCondition({ f: 'age', op: 'within', v: 90 })).toBe('录制结束 在最近 90 天内')
  })

  test('未知字段 / 未知运算符照原样显示并标出来，不假装读得懂', () => {
    expect(describeCondition({ f: 'titel', op: 'has', v: 'x' })).toBe('未知字段「titel」 has「x」')
    expect(describeCondition({ f: 'title', op: 'hasnt', v: 'x' })).toBe(
      '会议标题 不支持的运算符「hasnt」「x」',
    )
  })

  test('写坏的条件项（null）说得出它写坏了，不渲染成空', () => {
    expect(describeCondition(null)).toBe('这个条件写坏了（不是 { f, op, v } 形式的对象）')
  })
})

describe('describeEffect —— 与后端 describeStackEffect 同一套说法', () => {
  test('三栈各自的正反两面', () => {
    expect(describeEffect('fetch', 'all', ['ai_minutes'])).toBe('拉取（ai_minutes）')
    expect(describeEffect('fetch', 'skip', [])).toBe('不拉取')
    expect(describeEffect('archive', 'skip', [])).toBe('不归档')
    expect(describeEffect('archive', '/nas/finance/{年}/', [])).toBe('归档到 /nas/finance/{年}/')
    expect(describeEffect('allow', 'allow', ['*'])).toBe('准许采集（*）')
    expect(describeEffect('allow', 'deny', [])).toBe('禁止采集')
  })

  test('正面判定却一类资产都没列——后端的说法是"未列出任何资产类型"，照抄', () => {
    expect(describeEffect('allow', 'allow', [])).toBe('准许采集（未列出任何资产类型）')
  })

  test('认不出的 effect 原样显示并标出来，不替它落一个兜底', () => {
    expect(describeEffect('fetch', 'text', [])).toBe('认不出的 effect「text」')
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

describe('八类资产', () => {
  test('用网关的键名，不许出现 summary / aitr / digest 那套短名', () => {
    expect(ASSET_KEYS.map((a) => a.key)).toEqual([
      'video',
      'audio',
      'transcript',
      'ai_transcript',
      'ai_minutes',
      'ai_topic_minutes',
      'ai_speaker_minutes',
      'ai_ds_minutes',
    ])
    for (const a of ASSET_KEYS) expect(a.label).toBeTypeOf('string')
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
  test('全是 dept 条件时报得出来（and / or 都一样）', () => {
    expect(neverMatchesForLackOfDataSource(rule({ conds: [{ f: 'dept', op: 'in', v: ['财务部'] }] }))).toBe(
      true,
    )
    expect(
      neverMatchesForLackOfDataSource(
        rule({
          join: 'or',
          conds: [
            { f: 'dept', op: 'in', v: ['财务部'] },
            { f: 'dept', op: 'notin', v: ['市场部'] },
          ],
        }),
      ),
    ).toBe(true)
  })

  test('掺了一个有数据源的字段时，用「或」连就可能命中——不许下断言', () => {
    expect(
      neverMatchesForLackOfDataSource(
        rule({
          join: 'or',
          conds: [
            { f: 'dept', op: 'in', v: ['财务部'] },
            { f: 'title', op: 'has', v: '财务' },
          ],
        }),
      ),
    ).toBe(false)
  })

  test('空条件 / conds 写坏 / 有 null 条件时都不下断言', () => {
    expect(neverMatchesForLackOfDataSource(rule({ conds: [] }))).toBe(false)
    expect(neverMatchesForLackOfDataSource(rule({ conds: [], condsMalformed: true }))).toBe(false)
    expect(neverMatchesForLackOfDataSource(rule({ conds: [null] }))).toBe(false)
  })
})
