import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createPolicyStore, PolicyRuleInvalid, type RuleDraft } from '../../src/store/policy'
import { matchesRule, type MeetingFacts, type RuleCond } from '../../src/policy/conds'
import { sortStackRules, type StackKind } from '../../src/policy/stacks'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

async function insertRule(opts: {
  kind: string
  priority: number
  join?: string
  conds?: unknown
  condsRaw?: string
  subjectType?: string
  subjectValue?: string
  assetTypes: unknown[]
  effect: string
  note?: string | null
  createdBy?: string | null
  enabled?: number
}): Promise<number> {
  const [res] = await pool.execute(
    `INSERT INTO policy_rules
       (kind, priority, join_op, conds, subject_type, subject_value, asset_types, effect,
        note, created_by, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      opts.kind,
      opts.priority,
      opts.join ?? 'and',
      opts.condsRaw ?? JSON.stringify(opts.conds ?? []),
      opts.subjectType ?? '',
      opts.subjectValue ?? '',
      JSON.stringify(opts.assetTypes),
      opts.effect,
      opts.note ?? null,
      opts.createdBy ?? null,
      opts.enabled ?? 1,
    ],
  )
  return Number((res as { insertId: number }).insertId)
}

const facts: MeetingFacts = {
  title: '季度评审',
  hostUserId: 'tm-alice',
  dept: null,
  startTime: 1_700_000_000,
  endTime: 1_700_003_600,
  recordEndTime: 1_700_003_600,
  archived: false,
}

test('只返回指定栈的规则，别的栈不串进来', async () => {
  const store = createPolicyStore(pool)
  const allowId = await insertRule({
    kind: 'allow', priority: 10, subjectType: 'program', subjectValue: 'prog-a',
    assetTypes: ['*'], effect: 'allow', note: '放行 prog-a',
  })
  const fetchId = await insertRule({
    kind: 'fetch', priority: 10, assetTypes: ['video'], effect: 'all',
  })

  const allow = await store.listEnabledStackRules('allow')
  expect(allow.map((r) => r.id)).toContain(allowId)
  expect(allow.map((r) => r.id)).not.toContain(fetchId)
  expect(allow.every((r) => r.kind === 'allow')).toBe(true)

  const fetch = await store.listEnabledStackRules('fetch')
  expect(fetch.map((r) => r.id)).toContain(fetchId)
  expect(fetch.map((r) => r.id)).not.toContain(allowId)
})

test('listEnabledRules 一次取三栈，kind 原样带出', async () => {
  const store = createPolicyStore(pool)
  const archiveId = await insertRule({
    kind: 'archive', priority: 10, assetTypes: [], effect: '/nas/meetings/{年}/',
  })

  const all = await store.listEnabledRules()
  const row = all.find((r) => r.id === archiveId)
  expect(row).toBeDefined()
  expect(row?.kind).toBe('archive')
  expect(row?.effect).toBe('/nas/meetings/{年}/')
})

test('enabled = 0 的规则不返回', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 30, subjectType: 'program', subjectValue: 'prog-disabled',
    assetTypes: ['video'], effect: 'deny', enabled: 0,
  })
  const rules = await store.listEnabledStackRules('allow')
  expect(rules.map((r) => r.id)).not.toContain(id)
})

/**
 * 判定顺序的事实源是 stacks.ts 的 sortStackRules，不是 SQL。这里断言的是
 * 「SQL 读出来的顺序已经与它一致」——两处一致才让 DB 里翻出来的规则表
 * 与管理员在控制台看到的判定顺序对得上。真正的判定顺序仍由引擎负责。
 */
test('SQL 的读出顺序与 sortStackRules 一致：priority 降序、同 priority 按 id 升序', async () => {
  const store = createPolicyStore(pool)
  const low = await insertRule({
    kind: 'fetch', priority: 5, assetTypes: ['*'], effect: 'all', note: 'low-pri',
  })
  const highFirst = await insertRule({
    kind: 'fetch', priority: 90, assetTypes: ['*'], effect: 'all', note: 'high-1',
  })
  const highSecond = await insertRule({
    kind: 'fetch', priority: 90, assetTypes: ['*'], effect: 'all', note: 'high-2',
  })

  const rules = await store.listEnabledStackRules('fetch')
  const ids = rules.map((r) => r.id)
  expect(ids.indexOf(highFirst)).toBeLessThan(ids.indexOf(highSecond)) // 平局按 id 升序
  expect(ids.indexOf(highSecond)).toBeLessThan(ids.indexOf(low)) // priority 降序
  expect(ids).toEqual(sortStackRules(rules).map((r) => r.id))
})

test('JSON 列往返：conds 与 assetTypes 解析为数组，中文与 emoji 不失真', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow',
    priority: 40,
    join: 'or',
    conds: [
      { f: 'title', op: 'has', v: '季度评审 🎉' },
      { f: 'host', op: 'is', v: 'tm-alice' },
    ],
    subjectType: 'program',
    subjectValue: 'prog-json',
    assetTypes: ['video', 'audio'],
    effect: 'allow',
    note: '中文说明 🎉',
    createdBy: 'admin-1',
  })

  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  expect(rule).toBeDefined()
  expect(rule?.join).toBe('or')
  expect(rule?.conds).toEqual([
    { f: 'title', op: 'has', v: '季度评审 🎉' },
    { f: 'host', op: 'is', v: 'tm-alice' },
  ])
  expect(rule?.assetTypes).toEqual(['video', 'audio'])
  expect(rule?.note).toBe('中文说明 🎉')
  expect(rule?.subjectType).toBe('program')
  expect(rule?.subjectValue).toBe('prog-json')
  expect(matchesRule(rule!, facts, 1_700_003_600)).toBe(true)
})

test('asset_types 存 ["*"] 时原样读出（展开成八类是引擎的事，不是 store 的）', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 50, subjectType: 'program', subjectValue: 'prog-star',
    assetTypes: ['*'], effect: 'allow',
  })
  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  expect(rule?.assetTypes).toEqual(['*'])
})

test('fetch / archive 栈的空主体读出来是 null，不是空串', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({ kind: 'archive', priority: 60, assetTypes: [], effect: 'skip' })
  const rule = (await store.listEnabledStackRules('archive')).find((r) => r.id === id)
  expect(rule?.subjectType).toBeNull()
  expect(rule?.subjectValue).toBeNull()
})

test('note 没填时读出 null（与空说明是两回事，判定理由的措辞也不同）', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 70, subjectType: 'program', subjectValue: 'prog-nonote',
    assetTypes: ['*'], effect: 'allow', note: null,
  })
  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  expect(rule?.note).toBeNull()
})

/**
 * conds 是无 schema 校验的 JSON 列，装得下对象、数字、字符串。
 * **它读出来绝不能变成一个空数组**——空 conds 在求值器里是「匹配一切」，
 * 一条形状坏掉的规则会因此变成放行全部会议的兜底规则。
 */
test('conds 不是数组时不会被当成「匹配一切」', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 80, subjectType: 'program', subjectValue: 'prog-badconds',
    condsRaw: JSON.stringify({ f: 'title', op: 'has', v: '评审' }),
    assetTypes: ['*'], effect: 'allow',
  })
  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  expect(rule).toBeDefined()
  expect(Array.isArray(rule?.conds)).toBe(false)
  expect(matchesRule(rule!, facts, 1_700_003_600)).toBe(false)
})

/**
 * join_op 是脏数据时 store **不悄悄改成 'and'**：求值器本来就把认不出的连接词
 * 当「且」处理，但静态检查（describeRuleIssues）要能报出「连接词不认识」。
 * store 一旦归一化，管理员在规则列表里就再也看不见这个错。
 */
test('join_op 是脏数据时原样带出，交给静态检查报给管理员', async () => {
  const store = createPolicyStore(pool)
  const id = await insertRule({
    kind: 'allow', priority: 85, join: 'xor', subjectType: 'program', subjectValue: 'prog-badjoin',
    assetTypes: ['*'], effect: 'allow',
  })
  const rule = (await store.listEnabledStackRules('allow')).find((r) => r.id === id)
  // 类型上 join 是 'and' | 'or'，这里断言的正是「脏数据穿过了类型」这件事本身
  expect(rule?.join as string | undefined).toBe('xor')
})

// ═════════════════════════════════════════════════════════════════════════════
// 写侧（阶段 4 · T2）
//
// 这一段测的不是 CRUD 往返，是**写侧比读侧严**这件事本身。
// 读侧必须容忍已经躺在库里的坏数据（上面几条测的就是这个：原样带出、交给静态检查
// 报给管理员）；写侧没有这个理由——管理员就站在写侧，能当场改。
//
// 三条不变量：
//
// 1. **校验失败是 reject，不是同步 throw**。这个接口全是 async 方法，同步抛会绕过
//    调用方的 `.catch()`（阶段 3 的 putOverride 踩过，见 grants.ts 那条注释）。
// 2. **conds 为空数组一律拒绝**。空 conds 在 evaluateRule 里是「匹配一切」，
//    一条空条件的 allow 规则就是放行全库的兜底规则。这与读侧的 CONDS_UNPARSABLE
//    是同一件事的两面：读侧堵坏数据，写侧不放它进来。
// 3. **拒绝是整体拒绝**：被拒的写入一行都不落库，被拒的 update 一个字段都不改。
// ═════════════════════════════════════════════════════════════════════════════

function draft(over: Partial<RuleDraft & { now: number }> = {}): RuleDraft & { now: number } {
  return {
    kind: 'allow',
    priority: 10,
    join: 'and',
    conds: [{ f: 'title', op: 'has', v: '周会' }],
    subjectType: 'program',
    subjectValue: 'prog-w',
    assetTypes: ['*'],
    effect: 'allow',
    note: null,
    createdBy: 'admin-1',
    now: 1_700_000_000_000,
    ...over,
  }
}

interface CountRow extends RowDataPacket {
  cnt: number
}

/** 绕过 store 数某个主体下有多少行（含 disabled），用来断言「一行都没落库」 */
async function countBySubject(subjectValue: string): Promise<number> {
  const [rows] = await pool.execute<CountRow[]>(
    'SELECT COUNT(*) AS cnt FROM policy_rules WHERE subject_value = ?',
    [subjectValue],
  )
  return Number(rows[0]!.cnt)
}

/** 绕过 store 读一行原始列，用来断言「被拒的 update 一个字段都没改」 */
async function rawRule(id: number): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT kind, priority, join_op, conds, subject_type, subject_value, asset_types,
            effect, note, created_by, enabled, created_at, updated_at
       FROM policy_rules WHERE id = ?`,
    [id],
  )
  return rows[0]
}

// ── 不变量 1：reject，不是同步 throw ─────────────────────────────────────

test('校验失败是 reject 而不是同步 throw（同步抛会绕过调用方的 .catch）', async () => {
  const store = createPolicyStore(pool)
  let p: Promise<unknown> | undefined
  // 调用这一步本身绝不能抛：抛了就说明校验发生在 promise 之外
  expect(() => {
    p = store.createRule(draft({ conds: [], subjectValue: 'prog-sync-throw' }))
  }).not.toThrow()
  await expect(p!).rejects.toThrow(PolicyRuleInvalid)

  let q: Promise<unknown> | undefined
  expect(() => {
    q = store.updateRule(1, { now: 1, kind: 'nope' as StackKind })
  }).not.toThrow()
  await expect(q!).rejects.toThrow(PolicyRuleInvalid)
})

// ── 不变量 2：空 conds 是放行全库的兜底规则，写侧必须拒 ────────────────────

test('conds 为空数组拒绝写入：空 conds 在求值器里是「匹配一切」', async () => {
  const store = createPolicyStore(pool)
  await expect(store.createRule(draft({ conds: [], subjectValue: 'prog-empty' }))).rejects.toThrow(
    PolicyRuleInvalid,
  )
  expect(await countBySubject('prog-empty')).toBe(0)

  // 三栈一视同仁：fetch 栈的空 conds 是「全拉」，archive 栈的是「全归档到同一个目录」
  await expect(
    store.createRule(
      draft({ kind: 'fetch', conds: [], subjectType: null, subjectValue: null, effect: 'all' }),
    ),
  ).rejects.toThrow(PolicyRuleInvalid)
})

test('conds 不是数组同样拒绝（读侧原样带出，写侧不放进来）', async () => {
  const store = createPolicyStore(pool)
  await expect(
    store.createRule(
      draft({
        conds: { f: 'title', op: 'has', v: '周会' } as unknown as RuleCond[],
        subjectValue: 'prog-notarr',
      }),
    ),
  ).rejects.toThrow(PolicyRuleInvalid)
  expect(await countBySubject('prog-notarr')).toBe(0)
})

test('已存在的规则被改成空 conds 时拒绝，且旧行一个字段都不变', async () => {
  const store = createPolicyStore(pool)
  const created = await store.createRule(draft({ subjectValue: 'prog-keep', note: '原样' }))
  const before = await rawRule(created.id)
  expect(before).toBeDefined() // 免得下面的比对在两个 undefined 之间空转

  await expect(store.updateRule(created.id, { now: 1_700_000_009_000, conds: [] })).rejects.toThrow(
    PolicyRuleInvalid,
  )
  expect(await rawRule(created.id)).toEqual(before)
})

// ── 不变量 3：其余校验项，逐条落到「拒绝」而不是「悄悄改掉」 ────────────────

test('kind 不是三栈之一：拒绝（填错没有安全侧可落，见阶段 3 的 D-u）', async () => {
  const store = createPolicyStore(pool)
  await expect(
    store.createRule(draft({ kind: 'alow' as StackKind, subjectValue: 'prog-badkind' })),
  ).rejects.toThrow(PolicyRuleInvalid)
  expect(await countBySubject('prog-badkind')).toBe(0)
})

test('join_op 不是 and / or：拒绝（求值器会当「且」处理，那不是管理员写的意思）', async () => {
  const store = createPolicyStore(pool)
  await expect(
    store.createRule(draft({ join: 'xor' as 'and' | 'or', subjectValue: 'prog-badjoin-w' })),
  ).rejects.toThrow(PolicyRuleInvalid)
  expect(await countBySubject('prog-badjoin-w')).toBe(0)
})

test('effect 脏数据：拒绝，不替管理员落到本栈安全侧', async () => {
  const store = createPolicyStore(pool)
  // 读侧遇到 'allwo' 会落到 deny 并报 issue（容忍库里已有的坏行）；写侧不给这个待遇
  const err = await store
    .createRule(draft({ effect: 'allwo', subjectValue: 'prog-badeffect' }))
    .catch((e: unknown) => e)
  expect(err).toBeInstanceOf(PolicyRuleInvalid)
  expect((err as PolicyRuleInvalid).issues.join('\n')).toContain('allwo')
  expect(await countBySubject('prog-badeffect')).toBe(0)

  // archive 栈的 effect 是目录模板，空白模板归不到任何地方
  await expect(
    store.createRule(
      draft({ kind: 'archive', subjectType: null, subjectValue: null, effect: '  ', assetTypes: [] }),
    ),
  ).rejects.toThrow(PolicyRuleInvalid)
})

test('资产类型名不认识：拒绝，不静默丢掉（原型短名 summary / aitr 不能进代码）', async () => {
  const store = createPolicyStore(pool)
  const err = await store
    .createRule(draft({ assetTypes: ['video', 'summary'], subjectValue: 'prog-badasset' }))
    .catch((e: unknown) => e)
  expect(err).toBeInstanceOf(PolicyRuleInvalid)
  expect((err as PolicyRuleInvalid).issues.join('\n')).toContain('summary')
  // 丢掉那一类会让管理员以为 summary 已经授权出去了——存进去的和填的不是一回事
  expect(await countBySubject('prog-badasset')).toBe(0)
})

test('allow 栈缺采集程序主体：拒绝（这条规则不会对任何程序生效）', async () => {
  const store = createPolicyStore(pool)
  await expect(store.createRule(draft({ subjectType: null, subjectValue: null }))).rejects.toThrow(
    PolicyRuleInvalid,
  )
  await expect(
    store.createRule(draft({ subjectType: 'user', subjectValue: 'tm-alice' })),
  ).rejects.toThrow(PolicyRuleInvalid)
})

test('fetch / archive 栈带主体：拒绝（系统级行为，带主体的规则看起来像限定了范围）', async () => {
  const store = createPolicyStore(pool)
  await expect(
    store.createRule(
      draft({ kind: 'fetch', effect: 'all', subjectType: 'program', subjectValue: 'prog-sys' }),
    ),
  ).rejects.toThrow(PolicyRuleInvalid)
  expect(await countBySubject('prog-sys')).toBe(0)
})

test('条件里的字段名 / 运算符拼错：拒绝（写侧有人能当场改，读侧只能报出来）', async () => {
  const store = createPolicyStore(pool)
  await expect(
    store.createRule(draft({ conds: [{ f: 'titel', op: 'has', v: '周会' }], subjectValue: 'prog-typo' })),
  ).rejects.toThrow(PolicyRuleInvalid)
  await expect(
    store.createRule(draft({ conds: [{ f: 'title', op: 'hasnt', v: '周会' }], subjectValue: 'prog-typo' })),
  ).rejects.toThrow(PolicyRuleInvalid)
  // 值的类型不对同理：title 的关键词为空时 has / nothas 都不成立
  await expect(
    store.createRule(draft({ conds: [{ f: 'title', op: 'has', v: '   ' }], subjectValue: 'prog-typo' })),
  ).rejects.toThrow(PolicyRuleInvalid)
  expect(await countBySubject('prog-typo')).toBe(0)
})

test('priority 不是整数或超出 INT 范围：拒绝（MySQL 会取整，判定顺序会跟着变）', async () => {
  const store = createPolicyStore(pool)
  await expect(store.createRule(draft({ priority: 10.5, subjectValue: 'prog-pri' }))).rejects.toThrow(
    PolicyRuleInvalid,
  )
  await expect(
    store.createRule(draft({ priority: 3_000_000_000, subjectValue: 'prog-pri' })),
  ).rejects.toThrow(PolicyRuleInvalid)
  await expect(
    store.createRule(draft({ priority: Number.NaN, subjectValue: 'prog-pri' })),
  ).rejects.toThrow(PolicyRuleInvalid)
  expect(await countBySubject('prog-pri')).toBe(0)
})

test('note 超过 255 字：拒绝，不让 MySQL 截断（note 会原样进判定理由）', async () => {
  const store = createPolicyStore(pool)
  await expect(
    store.createRule(draft({ note: '会'.repeat(256), subjectValue: 'prog-longnote' })),
  ).rejects.toThrow(PolicyRuleInvalid)
  expect(await countBySubject('prog-longnote')).toBe(0)
  // 255 个字符是合法的
  const ok = await store.createRule(draft({ note: '会'.repeat(255), subjectValue: 'prog-longnote-ok' }))
  expect(ok.note).toHaveLength(255)
})

// ── 「只是没用」的规则照写，用 issues 报出来（验收 3） ──────────────────────

test('只是永远不会命中的规则照样写得进去，issues 里说清楚为什么', async () => {
  const store = createPolicyStore(pool)
  // dept 当前没有数据源（企微通讯录未接入）。这是系统能力缺口，不是管理员写错了，
  // 所以拦不得——他可以先配着，等通讯录接上就生效。
  const rule = await store.createRule(
    draft({ conds: [{ f: 'dept', op: 'in', v: ['财务部'] }], subjectValue: 'prog-dept' }),
  )
  expect(rule.issues.join('\n')).toContain('没有数据源')
  expect(rule.issues.join('\n')).toContain('永远不会命中')
  // 真的落库了
  expect((await store.getRule(rule.id))?.id).toBe(rule.id)
})

test('准许采集却没列出任何资产类型：照写，issues 报出「一类都取不到」', async () => {
  const store = createPolicyStore(pool)
  // 这条落在安全侧（一类都不放行），不是「比本意更宽」，所以只报不拦
  const rule = await store.createRule(draft({ assetTypes: [], subjectValue: 'prog-noasset' }))
  expect(rule.issues.join('\n')).toContain('一类都取不到')
})

// ── 读侧：列出全部规则（含 disabled） ────────────────────────────────────

test('listAllRules 带出停用的规则——否则管理员停用一条之后它就再也开不回来', async () => {
  const store = createPolicyStore(pool)
  const rule = await store.createRule(draft({ subjectValue: 'prog-toggle', note: '会被停用' }))

  const off = await store.setEnabled(rule.id, false, 1_700_000_001_000)
  expect(off?.enabled).toBe(false)
  expect((await store.listEnabledStackRules('allow')).map((r) => r.id)).not.toContain(rule.id)

  const all = await store.listAllRules('allow')
  const found = all.find((r) => r.id === rule.id)
  expect(found).toBeDefined()
  expect(found?.enabled).toBe(false)
  expect(found?.note).toBe('会被停用')

  // 开得回来
  expect((await store.setEnabled(rule.id, true, 1_700_000_002_000))?.enabled).toBe(true)
  expect((await store.listEnabledStackRules('allow')).map((r) => r.id)).toContain(rule.id)
})

test('listAllRules 不传 kind 时三栈都在，传了只出那一栈；顺序与判定顺序一致', async () => {
  const store = createPolicyStore(pool)
  const f = await store.createRule(
    draft({ kind: 'fetch', effect: 'all', subjectType: null, subjectValue: null, note: 'all-fetch' }),
  )
  const a = await store.createRule(draft({ subjectValue: 'prog-all', note: 'all-allow' }))

  const all = await store.listAllRules()
  expect(all.map((r) => r.id)).toContain(f.id)
  expect(all.map((r) => r.id)).toContain(a.id)

  const onlyFetch = await store.listAllRules('fetch')
  expect(onlyFetch.every((r) => r.kind === 'fetch')).toBe(true)
  expect(onlyFetch.map((r) => r.id)).not.toContain(a.id)
  expect(onlyFetch.map((r) => r.id)).toEqual(sortStackRules(onlyFetch).map((r) => r.id))
})

test('listAllRules 带出 describeStackRuleIssues 的结果，坏行也不抛（读侧照旧容忍）', async () => {
  const store = createPolicyStore(pool)
  // 绕过 store 直接写一行坏的：库外还有别的写入者时读侧必须扛得住
  const id = await insertRule({
    kind: 'allow',
    priority: 15,
    subjectType: 'program',
    subjectValue: 'prog-rawbad',
    condsRaw: JSON.stringify({ f: 'title', op: 'has', v: '评审' }),
    assetTypes: ['*'],
    effect: 'allwo',
    enabled: 0,
  })
  const found = (await store.listAllRules('allow')).find((r) => r.id === id)
  expect(found).toBeDefined()
  expect(found?.issues.join('\n')).toContain('conds 不是数组')
  expect(found?.issues.join('\n')).toContain('allwo')
})

// ── 往返与元数据 ──────────────────────────────────────────────────────────

test('createRule 往返：读回来的就是引擎要的 StackRule，enabled 默认开', async () => {
  const store = createPolicyStore(pool)
  const rule = await store.createRule(
    draft({
      join: 'or',
      conds: [
        { f: 'title', op: 'has', v: '季度评审 🎉' },
        { f: 'host', op: 'is', v: 'tm-alice' },
      ],
      subjectValue: 'prog-roundtrip',
      assetTypes: ['video', 'audio'],
      note: '中文说明 🎉',
      now: 1_700_000_005_000,
    }),
  )
  expect(rule.enabled).toBe(true)
  expect(rule.createdAt).toBe(1_700_000_005_000)
  expect(rule.updatedAt).toBe(1_700_000_005_000)
  expect(rule.createdBy).toBe('admin-1')
  expect(rule.issues).toEqual([])

  const read = (await store.listEnabledStackRules('allow')).find((r) => r.id === rule.id)
  expect(read?.join).toBe('or')
  expect(read?.assetTypes).toEqual(['video', 'audio'])
  expect(read?.note).toBe('中文说明 🎉')
  expect(matchesRule(read!, facts, 1_700_003_600)).toBe(true)
})

test('updateRule 是合并后整体校验：跨字段的矛盾也拦得住', async () => {
  const store = createPolicyStore(pool)
  const rule = await store.createRule(draft({ subjectValue: 'prog-merge' }))
  // 只改 kind：合并之后这条 fetch 规则还带着采集程序主体，整体不合法
  await expect(
    store.updateRule(rule.id, { now: 1_700_000_006_000, kind: 'fetch', effect: 'all' }),
  ).rejects.toThrow(PolicyRuleInvalid)
  // 同时把主体清掉就合法了
  const moved = await store.updateRule(rule.id, {
    now: 1_700_000_006_000,
    kind: 'fetch',
    effect: 'all',
    subjectType: null,
    subjectValue: null,
  })
  expect(moved?.kind).toBe('fetch')
  expect(moved?.subjectType).toBeNull()
})

test('updateRule 没给的字段原样保留，不被清空；updated_at 推进而 created_at / created_by 不动', async () => {
  const store = createPolicyStore(pool)
  const rule = await store.createRule(
    draft({ subjectValue: 'prog-patch', note: '旧说明', now: 1_700_000_007_000 }),
  )
  const patched = await store.updateRule(rule.id, { now: 1_700_000_008_000, note: '新说明' })
  expect(patched?.note).toBe('新说明')
  expect(patched?.conds).toEqual([{ f: 'title', op: 'has', v: '周会' }])
  expect(patched?.assetTypes).toEqual(['*'])
  expect(patched?.priority).toBe(10)
  expect(patched?.subjectValue).toBe('prog-patch')
  expect(patched?.createdAt).toBe(1_700_000_007_000)
  expect(patched?.createdBy).toBe('admin-1')
  expect(patched?.updatedAt).toBe(1_700_000_008_000)
})

test('规则不存在时 update / setEnabled / delete 返回 null，不抛', async () => {
  const store = createPolicyStore(pool)
  expect(await store.getRule(999_999)).toBeNull()
  expect(await store.updateRule(999_999, { now: 1_700_000_009_000, note: 'x' })).toBeNull()
  expect(await store.setEnabled(999_999, false, 1_700_000_009_000)).toBeNull()
  expect(await store.deleteRule(999_999)).toBeNull()
})

test('deleteRule 返回被删规则的完整内容——表里没有软删除，痕迹只能落在审计里', async () => {
  const store = createPolicyStore(pool)
  const rule = await store.createRule(draft({ subjectValue: 'prog-del', note: '要删的' }))
  const deleted = await store.deleteRule(rule.id)
  expect(deleted?.note).toBe('要删的')
  expect(deleted?.conds).toEqual([{ f: 'title', op: 'has', v: '周会' }])
  expect(deleted?.effect).toBe('allow')
  expect(await store.getRule(rule.id)).toBeNull()
  expect(await countBySubject('prog-del')).toBe(0)
})

test('坏行仍然停得掉、删得掉：setEnabled / deleteRule 不校验', async () => {
  const store = createPolicyStore(pool)
  // 一条 conds 坏掉的行。若这两个方法也走校验，管理员就再也关不掉它了——
  // 而「关掉一条规则」正是出事时唯一能立刻止血的动作
  const id = await insertRule({
    kind: 'allow',
    priority: 15,
    subjectType: 'program',
    subjectValue: 'prog-badstop',
    condsRaw: JSON.stringify('全是坏的'),
    assetTypes: ['*'],
    effect: 'allow',
  })
  expect((await store.setEnabled(id, false, 1_700_000_010_000))?.enabled).toBe(false)
  expect((await store.deleteRule(id))?.id).toBe(id)
})
