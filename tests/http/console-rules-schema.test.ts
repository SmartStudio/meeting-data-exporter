/**
 * `GET /api/v1/admin/rules/schema`——条件字段与运算符清单的下发端点（阶段 5 · A9）。
 *
 * ## 这条端点为什么存在
 *
 * `src/policy/conds.ts` 的 `CONDITION_FIELDS` 自己写着「**这张表是唯一事实源**：
 * 求值、静态检查、将来的规则编辑器都读它，不许任何一处另抄一份 op 列表」。
 * 而 rules 的六条端点里没有一条下发它，于是规则编辑器只能抄一份
 * （`console/src/pages/Rules/fields.ts`，它的文件头把这件事记成了一个缺口）。
 *
 * 镜像的问题不是它今天错，而是**后端加一个新运算符，前端不会知道**，
 * 而且界面上一个字都不会提——漂移是静默的。这条端点把真相收回后端。
 *
 * ## 这份测试钉的三件事
 *
 * 1. **清单下发得全**：六个字段、每个字段的运算符、值的形态、单位与占位符，
 *    以及三栈的 effect 取值域与八类资产键名——前端照它能把整个条件构建器
 *    渲染出来，不必再硬编码任何一份清单。
 * 2. **下发的与求值用的是同一份**：不是另写一张表序列化出去。任何一条
 *    「端点里有、求值器里没有」的运算符都会让下面的一致性用例变红。
 * 3. **只读角色读得到**：它是一条 GET，A8 的角色判断对 GET 全部开放。
 */
import { expect, test } from 'bun:test'
import { rulesSchema } from '../../src/http/handlers/console/rules'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AppDeps, RouteCtx } from '../../src/http/router'
import {
  CONDITION_FIELDS,
  COND_VALUE_TYPE,
  KEYWORD_SEPARATOR_SOURCE,
  OP_LABELS,
  splitKeywords,
} from '../../src/policy/conds'
import { STACK_SCHEMA, effectCarriesAssetTypes, normalizeEffect } from '../../src/policy/stacks'
import { ALL_ASSET_KEYS } from '@yaowu/mde-engine'

const NOW = 1_700_000_000
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }
const READONLY: AdminIdentity = { adminId: 'admin-ro', username: 'watcher', role: 'readonly' }

function fakeAdminAuth(identity: AdminIdentity = ADMIN): AdminAuth {
  return {
    async authenticate() { throw new Error('not stubbed') },
    async hashPassword() { throw new Error('not stubbed') },
    async issueSession() { throw new Error('not stubbed') },
    async verifySession() { return identity },
    async revokeSession() { throw new Error('not stubbed') },
    async revokeAllSessionsFor() { throw new Error('not stubbed') },
    async revokeOtherSessionsFor() { throw new Error('not stubbed') },
  }
}

/**
 * 依赖里**只有** `now` 与 `adminAuth`：这条端点不碰库。
 * 其余字段一个都不给，一旦实现里手滑去查了 policyStore，会当场 TypeError，
 * 而不是安静地多发一条 SQL——「下发一份常量」这件事不该有数据库往返。
 */
function ctxOf(identity: AdminIdentity = ADMIN): RouteCtx {
  return {
    params: {},
    deps: { now: () => NOW, adminAuth: fakeAdminAuth(identity) } as unknown as AppDeps,
  }
}

function req(opts: { cookie?: boolean } = {}): Request {
  const headers = new Headers()
  if (opts.cookie !== false) headers.set('cookie', `${ADMIN_SESSION_COOKIE}=session-token`)
  return new Request('https://gw.example/api/v1/admin/rules/schema', { headers })
}

interface SchemaOption { value: string; label: string }
interface SchemaOp { op: string; label: string; unitSuffix: string | null }
interface SchemaField {
  f: string
  label: string
  available: boolean
  unavailableReason: string | null
  ops: SchemaOp[]
  value: {
    kind: string
    type: string
    multiple: boolean
    options: SchemaOption[] | null
    unit: string | null
    placeholder: string | null
    splitPattern: string | null
  }
}
interface SchemaBody {
  fields: SchemaField[]
  joins: SchemaOption[]
  stacks: Array<{
    kind: string
    label: string
    effects: Array<{ value: string; label: string; hint: string; withAssetTypes: boolean }>
    freeform: string | null
    fallback: SchemaOption
    subjectType: string | null
  }>
  assetTypes: SchemaOption[]
  assetAll: string
}

async function schema(identity: AdminIdentity = ADMIN): Promise<SchemaBody> {
  const res = await rulesSchema(req(), ctxOf(identity))
  expect(res.status).toBe(200)
  return (await res.json()) as SchemaBody
}

// ── 鉴权 ──────────────────────────────────────────────────────────────────

test('未登录返回 401（清单也是内部信息，不对匿名开放）', async () => {
  const res = await rulesSchema(req({ cookie: false }), ctxOf())
  expect(res.status).toBe(401)
})

test('只读角色读得到——它是一条 GET，A8 的角色判断对 GET 全部开放', async () => {
  const res = await rulesSchema(req(), ctxOf(READONLY))
  expect(res.status).toBe(200)
})

// ── 字段清单 ──────────────────────────────────────────────────────────────

test('六个条件字段一个不少，顺序与求值器里的一致', async () => {
  const body = await schema()
  expect(body.fields.map((f) => f.f)).toEqual(Object.keys(CONDITION_FIELDS))
})

test('每个字段带齐：标识、显示名、能配哪些运算符、值的形态', async () => {
  const body = await schema()
  const title = body.fields.find((f) => f.f === 'title')!
  expect(title.label).toBe('会议标题')
  expect(title.ops.map((o) => o.op)).toEqual(['has', 'nothas'])
  expect(title.ops.map((o) => o.label)).toEqual(['包含任一', '不包含'])
  expect(title.value).toMatchObject({ kind: 'keywords', type: 'string', multiple: true })
  // 关键词的切法也下发：前端按另一套切法显示，管理员看到的关键词个数
  // 就与实际求值的不一样
  expect(title.value.splitPattern).toBe(KEYWORD_SEPARATOR_SOURCE)
  expect(splitKeywords('财务, 预算 复盘')).toEqual(['财务', '预算', '复盘'])
  expect('财务, 预算 复盘'.split(new RegExp(title.value.splitPattern!)).filter(Boolean))
    .toEqual(['财务', '预算', '复盘'])
})

test('数字字段带单位，`within` 另带一个「内」字——前端不必硬编码这条特例', async () => {
  const body = await schema()
  const dur = body.fields.find((f) => f.f === 'dur')!
  expect(dur.value).toMatchObject({ kind: 'number', type: 'number', multiple: false, unit: '分钟' })

  const age = body.fields.find((f) => f.f === 'age')!
  expect(age.value.unit).toBe('天')
  expect(age.ops).toEqual([
    { op: 'within', label: '在最近', unitSuffix: '内' },
    { op: 'before', label: '早于', unitSuffix: null },
  ])
})

test('没有数据源的字段：available 为 false，且原因是给管理员看的一句人话', async () => {
  const body = await schema()
  const dept = body.fields.find((f) => f.f === 'dept')!
  expect(dept.available).toBe(false)
  expect(dept.unavailableReason).toContain('企业微信通讯录')
  // 有数据源的字段 unavailableReason 是 null，不是空串——两者在前端要分得开
  expect(body.fields.find((f) => f.f === 'title')!.unavailableReason).toBeNull()
})

test('无值的字段（归档状态）在形态上说明白：type=none，没有输入控件', async () => {
  const body = await schema()
  const arch = body.fields.find((f) => f.f === 'arch')!
  expect(arch.value).toMatchObject({ kind: 'none', type: 'none', multiple: false, unit: null })
  expect(arch.ops.map((o) => o.label)).toEqual(['已写入 NAS', '未归档'])
})

// ── 一致性：下发的就是求值用的那一份 ──────────────────────────────────

test('端点里的字段与运算符，与求值器读的是同一份表', async () => {
  const body = await schema()
  const drift: string[] = []
  for (const [f, spec] of Object.entries(CONDITION_FIELDS)) {
    const served = body.fields.find((x) => x.f === f)
    if (served === undefined) { drift.push(`${f}：端点里没有`); continue }
    if (served.label !== spec.label) drift.push(`${f}：显示名不一致`)
    if (served.available !== spec.available) drift.push(`${f}：available 不一致`)
    const servedOps = served.ops.map((o) => o.op)
    if (servedOps.join(',') !== spec.ops.join(',')) {
      drift.push(`${f}：运算符不一致（端点 ${servedOps.join('/')} · 求值器 ${spec.ops.join('/')}）`)
    }
    if (served.value.kind !== spec.value) drift.push(`${f}：值的形态不一致`)
  }
  expect(drift).toEqual([])
})

test('每一个运算符都有中文名，且没有一条对不上任何字段的孤儿标签', () => {
  const used = new Set(Object.values(CONDITION_FIELDS).flatMap((s) => [...s.ops]))
  expect([...used].filter((op) => !(op in OP_LABELS))).toEqual([])
  expect(Object.keys(OP_LABELS).filter((op) => !used.has(op))).toEqual([])
})

test('每一种值形态都映射到一个粗粒度类型；声明成枚举的必须真的带可选值', async () => {
  // 五种 CondValueKind 一个不漏地有映射——漏一个会让某个字段的 type 是 undefined
  for (const spec of Object.values(CONDITION_FIELDS)) {
    expect(COND_VALUE_TYPE[spec.value]).toBeDefined()
  }
  // 「枚举」这一档的约定：带 options 才算数。今天没有字段是枚举
  // （dept 本该是，但通讯录没接，取不到部门清单——见 spec §5.3 的补注），
  // 这条用例是给将来加枚举字段的人立的规矩：空的下拉框比没有下拉框更糟
  const body = await schema()
  for (const field of body.fields) {
    if (field.value.type !== 'enum') continue
    expect({ f: field.f, empty: (field.value.options ?? []).length === 0 })
      .toEqual({ f: field.f, empty: false })
  }
})

// ── 三栈的 effect 取值域与资产键名 ──────────────────────────────────────

test('三栈都下发 effect 取值域、兜底与主体规矩', async () => {
  const body = await schema()
  expect(body.stacks.map((s) => s.kind)).toEqual(['fetch', 'archive', 'allow'])

  const allow = body.stacks.find((s) => s.kind === 'allow')!
  expect(allow.effects.map((e) => e.value)).toEqual(['allow', 'deny'])
  expect(allow.fallback).toEqual({ value: 'deny', label: '默认拒绝' })
  // allow 栈的主体必须是采集程序，另两栈必须为 null——前端据此决定显不显示主体选择器
  expect(allow.subjectType).toBe('program')
  expect(body.stacks.find((s) => s.kind === 'fetch')!.subjectType).toBeNull()
})

test('archive 栈的 effect 不是闭集，端点里明说这件事而不是列一个假清单', async () => {
  const body = await schema()
  const archive = body.stacks.find((s) => s.kind === 'archive')!
  // 只有 skip 是闭集里的取值，其余是一段目录模板
  expect(archive.effects.map((e) => e.value)).toEqual(['skip'])
  expect(archive.freeform).toContain('目录模板')
  // 另两栈是闭集，freeform 为 null
  expect(body.stacks.find((s) => s.kind === 'fetch')!.freeform).toBeNull()
})

test('下发的 effect 取值域与 normalizeEffect 是同一套（列了但求值器不认的当场报出来）', async () => {
  const body = await schema()
  const drift: string[] = []
  for (const stack of body.stacks) {
    const kind = stack.kind as 'fetch' | 'archive' | 'allow'
    for (const effect of stack.effects) {
      const norm = normalizeEffect(kind, effect.value)
      if (norm.issue !== null) drift.push(`${kind}/${effect.value}：求值器不认（${norm.issue}）`)
      if (effect.withAssetTypes !== effectCarriesAssetTypes(kind, effect.value)) {
        drift.push(`${kind}/${effect.value}：withAssetTypes 与 isPositive 不一致`)
      }
    }
    // 兜底也必须与求值器一致：喂一个用不了的 effect 进去，落到的就该是这个值。
    // 探针用 `undefined` 而不是某个脏字符串——archive 栈把**任何非空字符串**
    // 都当成一段合法的目录模板，脏字符串在那一栈根本不会触发兜底
    const fell = normalizeEffect(kind, undefined).effect
    if (fell !== stack.fallback.value) {
      drift.push(`${kind}：兜底不一致（端点 ${stack.fallback.value} · 求值器 ${fell}）`)
    }
  }
  expect(drift).toEqual([])
})

test('八类资产的键名与顺序取自引擎，中文名一并下发', async () => {
  const body = await schema()
  expect(body.assetTypes.map((a) => a.value)).toEqual([...ALL_ASSET_KEYS])
  // 每一类都有中文名，且不是把键名原样抄一遍
  expect(body.assetTypes.filter((a) => a.label === '' || a.label === a.value)).toEqual([])
  // `['*']` 是「全部八类」的写法，前端不必猜
  expect(body.assetAll).toBe('*')
})

test('连接词也下发（spec §5.2：一条规则内只有一个，不支持括号与混用）', async () => {
  const body = await schema()
  expect(body.joins.map((j) => j.value)).toEqual(['and', 'or'])
  expect(body.joins.every((j) => j.label !== '')).toBe(true)
})

// ── 常量本身 ──────────────────────────────────────────────────────────────

test('STACK_SCHEMA 覆盖三栈，且没有多余的栈', () => {
  expect(STACK_SCHEMA.map((s) => s.kind)).toEqual(['fetch', 'archive', 'allow'])
})
