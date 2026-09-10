import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../src/api/client'
import { ApiShapeError } from '../../src/api/validate'
import {
  createRule,
  deleteRule,
  fetchRulesSchema,
  listRules,
  patchRule,
  previewRules,
  ruleMatches,
  setRuleEnabled,
} from '../../src/api/admin/rules'
import { RULES_SCHEMA_BODY } from '../helpers/rulesSchema'

/**
 * `api/admin/rules.ts` 的六条端点。
 *
 * 这一层要守住的两件事：
 *
 * 1. **请求体逐字对齐契约**。字段名错一个字母，TypeScript 一个字都不会说，
 *    后端会 400 或者——更糟——收下一条语义不同的规则。
 * 2. **响应宽读但不静默**。`policy_rules.conds` 是无 schema 的 JSON 列，
 *    库里真的可能有写坏的规则；那条坏规则恰恰是管理员打开这一页要来修的，
 *    整页不能因为它而变成错误态。坏在哪里由后端的 `issues` 说，前端只负责
 *    别把它渲染成"看起来正常"。
 */

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

function install(status: number, body: unknown): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

function sentBody(): unknown {
  return JSON.parse(String(calls[0]!.init.body))
}

afterEach(() => vi.unstubAllGlobals())

const RULE = {
  id: 101,
  kind: 'allow',
  priority: 50,
  enabled: true,
  join: 'and',
  conds: [{ f: 'title', op: 'has', v: '财务' }],
  subjectType: 'program',
  subjectValue: 'kb-indexer',
  assetTypes: ['ai_minutes'],
  effect: 'allow',
  note: '财务会议给数据组',
  createdBy: 'admin-0',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  issues: [],
}

/* ── GET /rules ───────────────────────────────────────────────── */

describe('listRules', () => {
  test('路径写全，kind 进查询串，逐字段读出来', async () => {
    install(200, { rules: [RULE] })
    const rules = await listRules('allow')

    expect(calls[0]!.url).toBe('/api/v1/admin/rules?kind=allow')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.credentials).toBe('include')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      id: 101,
      kind: 'allow',
      priority: 50,
      enabled: true,
      join: 'and',
      subjectType: 'program',
      subjectValue: 'kb-indexer',
      assetTypes: ['ai_minutes'],
      effect: 'allow',
      note: '财务会议给数据组',
      createdBy: 'admin-0',
      condsMalformed: false,
    })
    expect(rules[0]!.conds).toEqual([{ f: 'title', op: 'has', v: '财务' }])
  })

  test('不传 kind 就不带查询串（三栈全部，含 disabled）', async () => {
    install(200, { rules: [] })
    await listRules()
    expect(calls[0]!.url).toBe('/api/v1/admin/rules')
  })

  test('issues 原样带出来——一条静默失效的规则要在列表里看得见', async () => {
    install(200, {
      rules: [{ ...RULE, issues: ['第 1 个条件的字段「主持人部门」当前没有数据源'] }],
    })
    const rules = await listRules()
    expect(rules[0]!.issues).toEqual(['第 1 个条件的字段「主持人部门」当前没有数据源'])
  })

  test('conds 不是数组时宽读成空并标记，不整页崩——那条坏规则正是要来修的', async () => {
    install(200, { rules: [{ ...RULE, conds: 'oops', issues: ['conds 不是数组'] }] })
    const rules = await listRules()
    expect(rules[0]!.conds).toEqual([])
    expect(rules[0]!.condsMalformed).toBe(true)
  })

  test('单个条件项写坏时占一个 null 的位，不悄悄少一行', async () => {
    install(200, { rules: [{ ...RULE, conds: [{ f: 'title', op: 'has', v: 'x' }, 42, { f: 1 }] }] })
    const rules = await listRules()
    expect(rules[0]!.conds).toEqual([{ f: 'title', op: 'has', v: 'x' }, null, null])
    expect(rules[0]!.condsMalformed).toBe(false)
  })

  test('v 缺省的条件（arch 一类无值运算符）读得出来', async () => {
    install(200, { rules: [{ ...RULE, conds: [{ f: 'arch', op: 'isarch' }] }] })
    const rules = await listRules()
    expect(rules[0]!.conds[0]).toEqual({ f: 'arch', op: 'isarch', v: undefined })
  })

  test('matchCount / matchScanned 正常读出', async () => {
    install(200, { rules: [{ ...RULE, matchCount: 8, matchScanned: 42 }] })
    const rules = await listRules()
    expect(rules[0]!.matchCount).toBe(8)
    expect(rules[0]!.matchScanned).toBe(42)
  })

  test(
    'matchCount / matchScanned 缺失时宽读成 null（不整页崩，不当成 0）——' +
      '这两个字段是后加的，旧后端 / 装载早于这次改动的 mock 响应里根本没有这两个键',
    async () => {
      install(200, { rules: [RULE] })
      const rules = await listRules()
      expect(rules[0]!.matchCount).toBeNull()
      expect(rules[0]!.matchScanned).toBeNull()
    },
  )

  test('matchCount / matchScanned 类型不对时也宽读成 null，不是 0——0 是一个具体答案，不能顶替"读不出来"', async () => {
    install(200, { rules: [{ ...RULE, matchCount: '8', matchScanned: {} }] })
    const rules = await listRules()
    expect(rules[0]!.matchCount).toBeNull()
    expect(rules[0]!.matchScanned).toBeNull()
  })

  test('matchCount / matchScanned 显式为 null（后端那次统计里会议全集取不到）时原样透传', async () => {
    install(200, { rules: [{ ...RULE, matchCount: null, matchScanned: null }] })
    const rules = await listRules()
    expect(rules[0]!.matchCount).toBeNull()
    expect(rules[0]!.matchScanned).toBeNull()
  })

  test('必填字段缺了就抛 ApiShapeError，报错里带端点名与字段路径', async () => {
    install(200, { rules: [{ ...RULE, priority: undefined }] })
    await expect(listRules()).rejects.toBeInstanceOf(ApiShapeError)
    await expect(listRules()).rejects.toThrow(/GET \/api\/v1\/admin\/rules/)
    await expect(listRules()).rejects.toThrow(/rules\[0\]\.priority/)
  })

  test('400 unknown_stack_kind 变成带错误码的 ApiError', async () => {
    install(400, { error: 'unknown_stack_kind', allowed: ['fetch', 'archive', 'allow'] })
    await expect(listRules('nope' as 'fetch')).rejects.toBeInstanceOf(ApiError)
    await expect(listRules('nope' as 'fetch')).rejects.toThrow(/unknown_stack_kind/)
  })
})

/* ── POST /rules ──────────────────────────────────────────────── */

describe('createRule', () => {
  test('请求体逐字对齐契约，201 的 rule 读出来', async () => {
    install(201, { rule: RULE })
    const created = await createRule({
      kind: 'allow',
      priority: 50,
      join: 'and',
      conds: [{ f: 'title', op: 'has', v: '财务' }],
      subjectType: 'program',
      subjectValue: 'kb-indexer',
      assetTypes: ['ai_minutes'],
      effect: 'allow',
      note: '财务会议给数据组',
    })

    expect(calls[0]!.url).toBe('/api/v1/admin/rules')
    expect(calls[0]!.init.method).toBe('POST')
    expect(sentBody()).toEqual({
      kind: 'allow',
      priority: 50,
      join: 'and',
      conds: [{ f: 'title', op: 'has', v: '财务' }],
      subjectType: 'program',
      subjectValue: 'kb-indexer',
      assetTypes: ['ai_minutes'],
      effect: 'allow',
      note: '财务会议给数据组',
    })
    expect(created.id).toBe(101)
  })

  test('createdBy 不发——建立人只能是当前登录管理员，请求体里写了也被忽略', async () => {
    install(201, { rule: RULE })
    await createRule({
      kind: 'fetch',
      priority: 100,
      join: 'and',
      conds: [{ f: 'age', op: 'within', v: 90 }],
      subjectType: null,
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'all',
      note: null,
    })
    expect(Object.keys(sentBody() as object)).not.toContain('createdBy')
  })

  test('rule_invalid 的逐条 issues 留在 ApiError.body 里，编辑器要逐条标红', async () => {
    install(400, { error: 'rule_invalid', issues: ['conds 是空数组：空条件在求值器里是「匹配一切」'] })
    const err = await createRule({
      kind: 'allow',
      priority: 1,
      join: 'and',
      conds: [],
      subjectType: 'program',
      subjectValue: 'x',
      assetTypes: [],
      effect: 'allow',
      note: null,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
    expect((err as ApiError).body).toMatchObject({
      error: 'rule_invalid',
      issues: ['conds 是空数组：空条件在求值器里是「匹配一切」'],
    })
  })
})

/* ── PATCH /rules/:id ─────────────────────────────────────────── */

describe('patchRule / setRuleEnabled', () => {
  test('只把真的要改的字段放进 patch', async () => {
    install(200, { rule: RULE })
    await patchRule(101, { priority: 80, note: null })
    expect(calls[0]!.url).toBe('/api/v1/admin/rules/101')
    expect(calls[0]!.init.method).toBe('PATCH')
    expect(sentBody()).toEqual({ priority: 80, note: null })
  })

  test('setRuleEnabled 只发 enabled 一个键——后端据此走不做内容校验的 setEnabled', async () => {
    install(200, { rule: { ...RULE, enabled: false } })
    const r = await setRuleEnabled(101, false)
    expect(sentBody()).toEqual({ enabled: false })
    expect(Object.keys(sentBody() as object)).toEqual(['enabled'])
    expect(r.enabled).toBe(false)
  })

  test('id 不是正整数当场抛，不去发一条注定 400 的请求', async () => {
    install(200, { rule: RULE })
    await expect(patchRule(0, { note: 'x' })).rejects.toThrow(/规则 id/)
    await expect(patchRule(1.5, { note: 'x' })).rejects.toThrow(/规则 id/)
    expect(calls).toHaveLength(0)
  })

  test('空 patch 当场抛——后端会回 empty_patch，没必要跑一趟', async () => {
    install(200, { rule: RULE })
    await expect(patchRule(101, {})).rejects.toThrow(/至少要改一个字段/)
    expect(calls).toHaveLength(0)
  })

  test('404 rule_not_found 原样上抛（含并发删除）', async () => {
    install(404, { error: 'rule_not_found' })
    await expect(patchRule(101, { note: 'x' })).rejects.toThrow(/rule_not_found/)
  })
})

/* ── DELETE /rules/:id ────────────────────────────────────────── */

describe('deleteRule', () => {
  test('回的是被删那条的完整内容——库里没有软删除，再查也查不回来', async () => {
    install(200, { rule: RULE })
    const gone = await deleteRule(101)
    expect(calls[0]!.url).toBe('/api/v1/admin/rules/101')
    expect(calls[0]!.init.method).toBe('DELETE')
    expect(gone.id).toBe(101)
    expect(gone.note).toBe('财务会议给数据组')
  })
})

/* ── POST /rules/preview ──────────────────────────────────────── */

const PREVIEW = {
  scope: { meetings: 320, meetingsTotal: 480, truncated: true, programs: ['kb-indexer'] },
  stacks: [
    {
      kind: 'allow',
      counts: {
        total: 480,
        scanned: 12,
        hits: 7,
        opened: 3,
        tightened: 1,
        moved: 0,
        mixed: 0,
        deciderOnly: 2,
        shielded: 1,
        invalid: 0,
      },
      summary: '这次采集权限规则改动够得着 12 场会议',
      changedRuleIds: [101],
      changed: [
        {
          key: 'm-1|kb-indexer',
          meetingId: 'm-1',
          title: '产品周会',
          programId: 'kb-indexer',
          aspect: 'effect',
          direction: 'opened',
          invalidRule: false,
          overridden: false,
          summary: '从「禁止采集」变成「准许采集」',
          before: {
            effect: 'deny',
            ruleId: null,
            note: null,
            source: 'default',
            reason: '没有任何规则命中，按兜底禁止采集',
            assetTypes: [],
            issues: [],
          },
          after: {
            effect: 'allow',
            ruleId: 101,
            note: '财务会议给数据组',
            source: 'rule',
            reason: '规则 #101 命中',
            assetTypes: ['ai_minutes'],
            issues: [],
          },
        },
      ],
      deciderOnly: [],
      shielded: [],
      sampled: { changed: false, deciderOnly: false, shielded: false },
    },
  ],
  warnings: [
    {
      level: 'amber',
      code: 'newly_opened',
      text: '有 3 场此前判定为「禁止采集」的会议将被这条规则放行给外部采集程序。',
      meetings: [{ id: 'm-1', title: '产品周会' }],
    },
  ],
  candidateIssues: [{ id: 101, kind: 'allow', issues: [] }],
}

describe('previewRules', () => {
  test('单条编辑写法：rule + kind + limit 一起发出去', async () => {
    install(200, PREVIEW)
    const res = await previewRules({
      rule: {
        id: 101,
        kind: 'allow',
        priority: 50,
        join: 'and',
        conds: [{ f: 'title', op: 'has', v: '财务' }],
        subjectType: 'program',
        subjectValue: 'kb-indexer',
        assetTypes: ['ai_minutes'],
        effect: 'allow',
        note: null,
        enabled: true,
      },
      kind: 'allow',
      limit: 200,
    })

    expect(calls[0]!.url).toBe('/api/v1/admin/rules/preview')
    expect(sentBody()).toMatchObject({ kind: 'allow', limit: 200 })
    expect((sentBody() as { rule: { id: number } }).rule.id).toBe(101)

    expect(res.scope).toEqual({
      meetings: 320,
      meetingsTotal: 480,
      truncated: true,
      programs: ['kb-indexer'],
    })
    expect(res.stacks[0]!.counts.hits).toBe(7)
    expect(res.stacks[0]!.counts.opened).toBe(3)
    expect(res.stacks[0]!.counts.tightened).toBe(1)
    expect(res.stacks[0]!.counts.shielded).toBe(1)
    expect(res.stacks[0]!.changed[0]!.before.effect).toBe('deny')
    expect(res.stacks[0]!.changed[0]!.after.reason).toBe('规则 #101 命中')
    expect(res.warnings[0]!.code).toBe('newly_opened')
    expect(res.candidateIssues[0]!.id).toBe(101)
  })

  test('删除预览：deleted:true 一起发', async () => {
    install(200, { ...PREVIEW, warnings: [], candidateIssues: [] })
    await previewRules({ rule: { id: 101 }, deleted: true })
    expect(sentBody()).toMatchObject({ deleted: true })
  })

  test('草稿没有 id 时不发 id（后端会分配一个负数合成 id）', async () => {
    install(200, { ...PREVIEW, warnings: [], candidateIssues: [] })
    await previewRules({
      rule: {
        kind: 'fetch',
        priority: 100,
        join: 'and',
        conds: [{ f: 'age', op: 'within', v: 90 }],
        subjectType: null,
        subjectValue: null,
        assetTypes: ['*'],
        effect: 'all',
        note: null,
        enabled: true,
      },
    })
    expect(Object.keys((sentBody() as { rule: object }).rule)).not.toContain('id')
  })

  test('counts 少一个字段就抛——三个数少一个，预览就在说谎', async () => {
    const broken = structuredClone(PREVIEW) as unknown as {
      stacks: Array<{ counts: Record<string, number | undefined> }>
    }
    broken.stacks[0]!.counts.opened = undefined
    install(200, broken)
    await expect(previewRules({ rule: { id: 1 } })).rejects.toThrow(/stacks\[0\]\.counts\.opened/)
  })

  test('sampled 标记读出来——明细被截断时界面要说"只列了前 N 条"', async () => {
    const sampled = structuredClone(PREVIEW)
    sampled.stacks[0]!.sampled = { changed: true, deciderOnly: false, shielded: false }
    install(200, sampled)
    const res = await previewRules({ rule: { id: 101 } })
    expect(res.stacks[0]!.sampled.changed).toBe(true)
  })
})

/* ── GET /rules/:id/matches ───────────────────────────────────── */

describe('ruleMatches', () => {
  test('命中列表带 missing——"标题缺失"与"标题为空"必须分得开', async () => {
    install(200, {
      rule: RULE,
      scope: { meetings: 320, meetingsTotal: 480, truncated: true },
      matches: [
        { id: 'm-1|', meetingId: 'm-1', subMeetingId: '', title: '产品周会', startAt: 1, missing: [] },
        { id: 'm-2|', meetingId: 'm-2', subMeetingId: '', title: '', startAt: 2, missing: ['title'] },
        { id: 'm-3|', meetingId: 'm-3', subMeetingId: '', title: '', startAt: 3, missing: [] },
      ],
    })
    const res = await ruleMatches(101, 200)

    expect(calls[0]!.url).toBe('/api/v1/admin/rules/101/matches?limit=200')
    expect(res.scope.truncated).toBe(true)
    expect(res.matches[1]!.missing).toEqual(['title'])
    // 第三场标题真的是空串，missing 是空数组——两者不能折成同一件事
    expect(res.matches[2]!.missing).toEqual([])
    expect(res.rule.id).toBe(101)
  })

  test('不传 limit 就不带查询串', async () => {
    install(200, { rule: RULE, scope: { meetings: 1, meetingsTotal: 1, truncated: false }, matches: [] })
    await ruleMatches(101)
    expect(calls[0]!.url).toBe('/api/v1/admin/rules/101/matches')
  })
})

/* ── GET /rules/schema（阶段 5 · A9 新增，F9 接线）───────────── */

describe('fetchRulesSchema', () => {
  test('六个字段、运算符、值形态原样读出来——前端不再自己存一份清单', async () => {
    install(200, RULES_SCHEMA_BODY)
    const s = await fetchRulesSchema()

    expect(calls[0]!.url).toBe('/api/v1/admin/rules/schema')
    expect(s.fields.map((f) => f.f)).toEqual(['title', 'dept', 'host', 'dur', 'age', 'arch'])
    expect(s.fields[0]!.ops.map((o) => o.op)).toEqual(['has', 'nothas'])
    expect(s.fields[0]!.value.splitPattern).toBe('[,\\uFF0C\\s]+')
    expect(s.fields[3]!.value.unit).toBe('分钟')
    expect(s.fields[4]!.ops[0]!.unitSuffix).toBe('内')
    expect(s.stacks.map((k) => k.kind)).toEqual(['fetch', 'archive', 'allow'])
    expect(s.stacks[1]!.freeform).toMatch(/归档目录模板/)
    expect(s.assetTypes).toHaveLength(5)
    expect(s.assetAll).toBe('*')
  })

  test('dept 的「为什么不可用」原样带上来，不是空串也不是前端改写过的另一句', async () => {
    install(200, RULES_SCHEMA_BODY)
    const s = await fetchRulesSchema()
    const dept = s.fields.find((f) => f.f === 'dept')!
    expect(dept.available).toBe(false)
    expect(dept.unavailableReason).toBe(
      '需要企业微信通讯录，尚未接入（企微自建应用没有真建，R0 已定为不做，见 spec §5.3）',
    )
    // 有数据源的字段是 null 而不是空串——「有数据源」与「没写原因」要分得开
    expect(s.fields.find((f) => f.f === 'title')!.unavailableReason).toBeNull()
  })

  test('运算符没登记中文名时读成 null，绝不拿 op 原值顶上', async () => {
    const body = structuredClone(RULES_SCHEMA_BODY)
    body.fields[0]!.ops[0]!.label = null as unknown as string
    install(200, body)
    const s = await fetchRulesSchema()
    expect(s.fields[0]!.ops[0]!.label).toBeNull()
  })

  test('声明成 enum 却给不出可选值 → 当场报形状错，不渲染一个空下拉框', async () => {
    const body = structuredClone(RULES_SCHEMA_BODY)
    body.fields[0]!.value.type = 'enum'
    install(200, body)
    await expect(fetchRulesSchema()).rejects.toBeInstanceOf(ApiShapeError)
  })

  test('enum 带上非空 options 时正常读出来', async () => {
    const body = structuredClone(RULES_SCHEMA_BODY)
    body.fields[1]!.value.type = 'enum'
    body.fields[1]!.value.options = [{ value: 'fin', label: '财务部' }] as never
    install(200, body)
    const s = await fetchRulesSchema()
    expect(s.fields[1]!.value.options).toEqual([{ value: 'fin', label: '财务部' }])
  })

  test('少一个必填字段就报形状错，带字段路径——不静默当成空清单', async () => {
    const body = structuredClone(RULES_SCHEMA_BODY) as unknown as Record<string, unknown>
    const fields = body.fields as Array<Record<string, unknown>>
    delete fields[0]!.label
    install(200, body)
    await expect(fetchRulesSchema()).rejects.toThrow(/fields\[0\]\.label/)
  })

  test('后端不可达时把错误抛出去，不回退到一份硬编码清单', async () => {
    install(500, { error: 'db_down' })
    await expect(fetchRulesSchema()).rejects.toBeInstanceOf(ApiError)
  })
})
