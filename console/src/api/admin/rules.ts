/**
 * 三栈规则 + 影响预览（`src/http/handlers/console/rules.ts` 的 7 条端点）。
 *
 * ```
 * GET    /api/v1/admin/rules              列出三栈（含 disabled）
 * GET    /api/v1/admin/rules/schema       条件字段 / 运算符 / 三栈 effect 的清单
 * POST   /api/v1/admin/rules              新建
 * PATCH  /api/v1/admin/rules/:id          改（含启用 / 停用）
 * DELETE /api/v1/admin/rules/:id          删
 * POST   /api/v1/admin/rules/preview      影响预览（不落库）
 * GET    /api/v1/admin/rules/:id/matches  这条规则命中哪几场
 * ```
 *
 * ## 零、`/schema` 是条件构建器的**唯一**清单来源
 *
 * F3 那一轮后端没有这条端点，`pages/Rules/fields.ts` 因此抄了一份
 * `CONDITION_FIELDS` / `OP_LABEL` / `ASSET_KEYS`。A9 把清单收回后端并加了这条
 * 端点，F9 接线时把那几份镜像**删掉**了。
 *
 * 所以：**这条端点读不到时不许回退到任何硬编码清单**。回退回去的那一份
 * 恰好在最不该有它的时刻（后端不可达 / 契约变了）冒充成真相，而界面上
 * 一个字都不会提。读不到就说「字段清单读不出来」并把条件构建器停掉。
 *
 * ## 一、这个文件不实现求值语义
 *
 * spec §5「规则引擎语义」那一节的实现在后端（`src/policy/`），**只有那一份**。
 * 前端这一侧：
 *
 * - **判定结果**（某场会议会不会被放行 / 拉取 / 归档到哪）一律来自后端——
 *   `preview` 的 `before` / `after`，或者会议行自己带的 `why`。
 * - **影响预览的三个数**来自 `POST /rules/preview`，前端不算。spec §5.5 写死了
 *   预览的计算范围（`命中(旧) ∪ 命中(新)`，不是全部会议），前端另算一遍就是
 *   第二份真相，而两份不一致的地方恰好是判定边界。
 * - 前端只做**呈现**：把规则按判定顺序排出来（`pages/Rules/order.ts`），
 *   好让管理员读得出"这条排第几"。排序规则与后端 `ORDER BY` 一致，
 *   但它决定的只是屏幕上的先后，不决定任何一场会议的去向。
 *
 * ## 二、响应宽读，但不静默
 *
 * `policy_rules.conds` 是没有 schema 的 JSON 列，库里真的可能有写坏的规则
 * （后端的 `describeRuleIssues` 专门为此写着"conds 不是数组"这句话）。
 * 那条坏规则**恰恰是管理员打开这一页要来修的**，所以：
 *
 * - `conds` 不是数组 → 读成 `[]` 并把 `condsMalformed` 置真，不抛；
 * - 单个条件项不是 `{ f, op }` → 那一格读成 `null`，**占着位**，
 *   不悄悄少一行（少一行会让"第 3 个条件写不进去"这句 issue 指不到东西）。
 *
 * 除此之外的必填字段（id / priority / effect …）缺了就抛 `ApiShapeError`：
 * 那说明契约对不上，是要立刻看见的事，不是要容忍的数据。
 *
 * ## 三、类型定义在这里，不进 `api/types.ts`（计划 G-b）
 *
 * `Rule` / `RuleCondition` / `PreviewResult` 只有自动规则页一个消费者。
 */

import { apiGet, apiSend } from '../client'
import { reader, type FieldReader } from '../validate'

/* ── 类型 ───────────────────────────────────────────────────────── */

/** 三栈。`fetch` 拉取、`archive` 归档、`allow` 采集权限（数据出境闸门）。 */
export type StackKind = 'fetch' | 'archive' | 'allow'

export const STACK_KINDS: readonly StackKind[] = ['fetch', 'archive', 'allow']

/**
 * 一条条件。`v` 的形态随字段变（关键词串 / 部门数组 / 数字 / 无值），
 * 所以留 `unknown`——前端替它猜一个类型，猜错的那一次会静默改变规则的含义。
 */
export interface RuleCondition {
  f: string
  op: string
  v?: unknown
}

/**
 * 一条规则（= 后端的 `AdminRule`）。
 *
 * `kind` / `join` / `effect` **不收窄成联合类型**：后端加一个新取值时，
 * 前端应当把它原样显示出来（并靠 `issues` 说明它有没有问题），
 * 而不是因为不在枚举里就崩掉或者悄悄折成别的取值。
 */
export interface Rule {
  id: number
  kind: string
  priority: number
  enabled: boolean
  join: string
  /** 坏掉的条件项占一个 `null` 的位，见文件头第二节。 */
  conds: Array<RuleCondition | null>
  /** `conds` 列本身不是数组。后端的 `issues` 里也会说这件事。 */
  condsMalformed: boolean
  /** allow 栈是 `'program'`；fetch / archive 两栈留空。 */
  subjectType: string | null
  /** allow 栈对应 `service_accounts.id`。 */
  subjectValue: string | null
  /** `['*']` 表示全部八类。 */
  assetTypes: string[]
  /** 取值随 kind：fetch 是 all/skip，allow 是 allow/deny，archive 是目录模板。 */
  effect: string
  /** 说明。会出现在规则列表**和每场会议的判定理由里**（spec §6.3）。 */
  note: string | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
  /**
   * 这条规则**静态**问题的中文描述，由后端的 `describeStackRuleIssues` 给出。
   * 「建完就静默失效」的规则靠它在列表里看得见——**原样显示，不要挑一条当摘要**。
   */
  issues: string[]
  /**
   * 这条规则**自身条件**命中的场次（`GET /rules` 改版新增，见后端 `withMatchCounts`）。
   *
   * 口径与 `ruleMatches()` 完全一致：命中 = 这条规则的 conds 匹配，不是整栈求值的结果，
   * 停用的规则也算得出来。
   *
   * `null` = **读不出来**，不是「命中 0 场」——字段缺失（旧后端 / 契约不对）、
   * 类型不对，或者后端那次统计里会议全集本身取不到（库不可达），三种情况都归到
   * 这一个值，页面把它显示成"—"。**绝不把这些情况兜成 0**：0 是一个具体的答案，
   * 管理员会照着它去删一条其实好好的规则；"读不出来"不该长得像"算出来是 0"。
   */
  matchCount: number | null
  /**
   * 这次统计实际考察了多少场会议——`matchCount` 要配着它读，"8 / matchScanned"
   * 才回答得出"8 是多是少"。宽读规则与 `matchCount` 相同，见上面那条注释。
   */
  matchScanned: number | null
}

/* ── 条件字段与运算符的清单（GET /rules/schema）─────────────── */

/** `{ value, label }`：连接词、兜底、资产类型、闭集字段的可选值都是这个形状。 */
export interface SchemaChoice {
  value: string
  label: string
}

/**
 * 一个运算符。
 *
 * `label` 为 **null = 后端没有登记中文名**，不是「它就叫这个英文名」。契约明写
 * 不拿 `op` 原值顶上去：顶上去之后下拉框里会出现一个看着像中文名的英文单词，
 * 谁都不会去核对。前端要把「没登记」这件事显示出来（见 `pages/Rules/fields.ts`）。
 *
 * `unitSuffix` 是跟在**值与单位之后**的那个字：`age within 90` 读作
 * 「在最近 90 天内」，那个「内」既不属于单位也不属于运算符名。它随清单下发，
 * 就是为了前端不必再写一条 `op === 'within'` 的特例——那正是镜像的起点。
 */
export interface SchemaOp {
  op: string
  label: string | null
  unitSuffix: string | null
}

export interface SchemaValue {
  /** 后端 `CondValueKind` 原值，细粒度：keywords / strings / string / number / none。 */
  kind: string
  /** 粗粒度类型，决定渲染哪一类控件：string / number / enum / none。 */
  type: string
  multiple: boolean
  /** **`type === 'enum'` 时才非 null，且非空**。空的下拉框比没有下拉框更糟。 */
  options: SchemaChoice[] | null
  /** 数字字段的单位（`分钟` / `天`），渲染在输入框右边。 */
  unit: string | null
  placeholder: string | null
  /** **仅 `kind === 'keywords'`** 非 null。`new RegExp(...)` 即可，不必抄一份。 */
  splitPattern: string | null
}

export interface SchemaField {
  /** 标识，就是 `RuleCond.f` 里写的那个。 */
  f: string
  label: string
  available: boolean
  /**
   * `available: false` 时的原因，**要直接上屏**。有数据源时是 `null` 而不是
   * 空串——「有数据源」与「没数据源但没人写原因」在界面上要分得开。
   */
  unavailableReason: string | null
  /** **顺序即下拉框顺序**。 */
  ops: SchemaOp[]
  value: SchemaValue
}

export interface SchemaEffect {
  value: string
  label: string
  hint: string
  /** 选了它之后「资产类型」那一栏还起不起作用（后端的 `isPositive`）。 */
  withAssetTypes: boolean
}

export interface SchemaStack {
  kind: string
  label: string
  /** 闭集取值。**不是闭集的栈（archive）这里只有 `skip`**，见 `freeform`。 */
  effects: SchemaEffect[]
  /**
   * effect 不是闭集时的说明。只有 `archive` 非 null：除 `skip` 外它是一段
   * 归档目录模板。列一个假的「全部目录」清单比不列更糟。
   */
  freeform: string | null
  /** 一条规则都不匹配时的兜底（spec §5.1 第 4 步）。 */
  fallback: SchemaChoice
  /** allow 栈是 `program`，另两栈是系统级行为、必须为 null。 */
  subjectType: string | null
}

export interface RulesSchema {
  fields: SchemaField[]
  joins: SchemaChoice[]
  stacks: SchemaStack[]
  assetTypes: SchemaChoice[]
  /** `'*'`：「全部资产类型」的写法，后端 `normalizeAssetTypes` 会展开它。 */
  assetAll: string
}

/** 新建规则的请求体。`createdBy` 不在内：建立人只能是当前登录管理员。 */
export interface RuleInput {
  kind: StackKind
  priority: number
  join: 'and' | 'or'
  conds: RuleCondition[]
  subjectType: string | null
  subjectValue: string | null
  assetTypes: string[]
  effect: string
  note: string | null
}

/**
 * 改规则。**只把真的要改的字段放进来**——没出现的字段后端不碰。
 *
 * 只想启用/停用时用 `setRuleEnabled()`，不要用这个：后端对"只有 enabled 一个键"
 * 的 patch 走不做内容校验的分支，那是故意的（出事时"把这条规则关掉"必须永远
 * 能成功，否则最该关掉的那条坏规则会变成关不掉的）。
 */
export type RulePatch = Partial<RuleInput> & { enabled?: boolean }

/** 预览用的候选规则。`id` 省略时后端分配一个负数合成 id（不会与库里的撞上）。 */
export interface CandidateRule extends Partial<RuleInput> {
  id?: number
  enabled?: boolean
}

export interface PreviewInput {
  /** 单条编辑：只发正在编的这一条，服务端按 id 合进当前规则集。 */
  rule?: CandidateRule
  /** 整份候选集（三栈混着传也行）。与 `rule` 二选一。 */
  rules?: CandidateRule[]
  /** `rule` 写法下表示"删掉这条"。 */
  deleted?: boolean
  /** 只看这一栈；不传则由后端判定哪些栈发生了变化。 */
  kind?: StackKind
  /** 考察的会议数上限，后端默认/上限 500，超了静默钳制。 */
  limit?: number
}

/** 一次判定。`source` / `effect` 同样不收窄，理由见 `Rule`。 */
export interface PreviewDecision {
  effect: string
  ruleId: number | null
  note: string | null
  /** rule / rule_invalid / undecidable / default … */
  source: string
  /** 一句可直接上屏的判定理由。**空串要显示成"理由缺失"，不能留白。** */
  reason: string
  assetTypes: string[]
  issues: string[]
}

/**
 * 一次判定变化。
 *
 * `aspect`：`effect` 判定本身变了 · `assets` 判定没变但资产类型变了 ·
 * `decider` 结果没变、只是换了另一条规则说了算。
 * `direction`：`opened` / `tightened` / `moved` / `mixed` / `unchanged`。
 */
export interface PreviewChange {
  key: string
  meetingId: string | null
  title: string
  programId: string | null
  aspect: string
  direction: string
  /** 前后任一侧是被写坏的规则决定的——那要去改规则，不是管理员想要的收紧。 */
  invalidRule: boolean
  /** 这场会议被人工改写过。只会出现在 `shielded` 里。 */
  overridden: boolean
  summary: string
  before: PreviewDecision
  after: PreviewDecision
}

/**
 * 影响预览的计数。spec §4.7 屏幕上的三个数是 `hits` / `opened` / `tightened`；
 * 其余几个不是装饰——`deciderOnly` / `shielded` / `invalid` 各自回答一个
 * 「为什么这个数不是我以为的那个数」。
 */
export interface PreviewCounts {
  /** 传进去考察的对象总数（会议，或 allow 栈的会议 × 程序）。 */
  total: number
  /** 实际考察过的对象数 = `命中(旧) ∪ 命中(新)`，这才是这次改动够得着的规模。 */
  scanned: number
  /** 命中改动后规则的对象数 —— spec §4.7 的「场命中」。 */
  hits: number
  /** 「场新放行」。 */
  opened: number
  /** 「场新收紧」。 */
  tightened: number
  /** archive 栈的目录从 A 换到 B：既不是放开也不是收紧。 */
  moved: number
  /** 资产类型有增有减。 */
  mixed: number
  /** 判定没变、只是换了规则说了算。 */
  deciderOnly: number
  /** 本来会变、被人工改写挡住的（改写优先于所有规则，spec §5.4）。 */
  shielded: number
  /** `changed` 里有多少是被写坏的规则决定的。 */
  invalid: number
}

export interface PreviewStack {
  kind: string
  counts: PreviewCounts
  summary: string
  changedRuleIds: number[]
  changed: PreviewChange[]
  deciderOnly: PreviewChange[]
  shielded: PreviewChange[]
  /** 明细被截断了没有。`counts` 里的数字永远是全量的。 */
  sampled: { changed: boolean; deciderOnly: boolean; shielded: boolean }
}

/** `code`：`newly_opened`（有会议从未开放过却将被放行）/ `fetch_compat_off`（拉取兜底翻面）。 */
export interface PreviewWarning {
  level: string
  code: string
  text: string
  meetings: Array<{ id: string; title: string }>
}

export interface PreviewScope {
  /** 这次实际考察了多少场。 */
  meetings: number
  /** 库里一共多少场。两者不等时预览说的是"这一批里"，不是"全库"。 */
  meetingsTotal: number
  truncated: boolean
  /** 这次改动够得着的采集程序（allow 栈用）。 */
  programs: string[]
}

export interface PreviewResult {
  scope: PreviewScope
  stacks: PreviewStack[]
  warnings: PreviewWarning[]
  candidateIssues: Array<{ id: number; kind: string; issues: string[] }>
}

/**
 * 一条命中的会议。
 *
 * `missing` 是**这几项事实在库里根本不存在**（`meetings` 表对应列是 NULL），
 * 与"值是空串"不是一回事——阶段 4 的 T13 修的就是把两者折在一起的洞：
 * 折完之后 `title 含 X → deny` 会对着一场元数据没拉回来的会议判"不匹配"，
 * 于是落到放行的一侧。**界面上必须分得开**（`pages/Rules/fields.ts` 的 `missingLabel`）。
 */
export interface RuleMatch {
  /** `consoleMeetingId(meetingId, subMeetingId)` 编出来的行标识。 */
  id: string
  meetingId: string
  subMeetingId: string
  title: string
  startAt: number
  missing: string[]
}

export interface RuleMatchesResult {
  rule: Rule
  scope: { meetings: number; meetingsTotal: number; truncated: boolean }
  matches: RuleMatch[]
}

/* ── 路径 ───────────────────────────────────────────────────────── */

const BASE = '/api/v1/admin'

/**
 * `policy_rules.id` 是自增主键，永远是正整数。不是的话当场抛开发期错误——
 * 发出去只会拿到一条 400 `invalid_rule_id`，而那时错误信息里已经没有
 * "是谁传了个 1.5 进来"了。
 */
function rulePath(id: number, suffix = ''): string {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`api/admin/rules: 规则 id 必须是正整数，收到「${String(id)}」`)
  }
  return `${BASE}/rules/${id}${suffix}`
}

/* ── 校验 ───────────────────────────────────────────────────────── */

/**
 * 条件项宽读。见文件头第二节：坏数据在这里不抛，抛了整页就打不开，
 * 而打不开的那一页正是用来修它的。
 */
function readConds(raw: unknown): { conds: Array<RuleCondition | null>; malformed: boolean } {
  if (!Array.isArray(raw)) return { conds: [], malformed: true }
  const conds = raw.map((item): RuleCondition | null => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const o = item as Record<string, unknown>
    if (typeof o.f !== 'string' || typeof o.op !== 'string') return null
    return { f: o.f, op: o.op, v: o.v }
  })
  return { conds, malformed: false }
}

/**
 * `matchCount` / `matchScanned` 的宽读：**缺失与类型不对都归到同一个"读不出来"**，
 * 不用 `FieldReader.numOrNull`——那一个对"键缺失"是抛 `ApiShapeError` 的（它的契约是
 * "有就必须是 number | null，没有就是没接对契约"），而这两个字段是后来才加的，
 * 旧后端 / mock 装载早于这次改动时响应里根本没有这两个键，那不该让整页打不开。
 * 与文件头第二节同一个原则：坏数据 / 缺字段不抛，抛了整页就打不开。
 */
function readMatchStat(o: Record<string, unknown>, key: string): number | null {
  const v = o[key]
  return typeof v === 'number' && !Number.isNaN(v) ? v : null
}

function readRule(r: FieldReader, raw: unknown, where: string): Rule {
  const o = r.object(raw, where)
  const { conds, malformed } = readConds(o.conds)
  return {
    id: r.num(o, 'id', where),
    kind: r.str(o, 'kind', where),
    priority: r.num(o, 'priority', where),
    enabled: r.bool(o, 'enabled', where),
    join: r.str(o, 'join', where),
    conds,
    condsMalformed: malformed,
    subjectType: r.strOrNull(o, 'subjectType', where),
    subjectValue: r.strOrNull(o, 'subjectValue', where),
    assetTypes: r.strList(o, 'assetTypes', where),
    effect: r.str(o, 'effect', where),
    note: r.strOrNull(o, 'note', where),
    createdBy: r.strOrNull(o, 'createdBy', where),
    createdAt: r.num(o, 'createdAt', where),
    updatedAt: r.num(o, 'updatedAt', where),
    issues: r.strList(o, 'issues', where),
    matchCount: readMatchStat(o, 'matchCount'),
    matchScanned: readMatchStat(o, 'matchScanned'),
  }
}

/** `{ rule: … }` 这一层壳，四条写端点共用。 */
function readRuleEnvelope(endpoint: string, raw: unknown): Rule {
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return readRule(r, o.rule, 'rule')
}

function readDecision(r: FieldReader, raw: unknown, where: string): PreviewDecision {
  const o = r.object(raw, where)
  return {
    effect: r.str(o, 'effect', where),
    ruleId: r.numOrNull(o, 'ruleId', where),
    note: r.strOrNull(o, 'note', where),
    source: r.str(o, 'source', where),
    reason: r.str(o, 'reason', where),
    assetTypes: r.strList(o, 'assetTypes', where),
    issues: r.strList(o, 'issues', where),
  }
}

function readChange(r: FieldReader, raw: unknown, where: string): PreviewChange {
  const o = r.object(raw, where)
  return {
    key: r.str(o, 'key', where),
    meetingId: r.strOrNull(o, 'meetingId', where),
    title: r.str(o, 'title', where),
    programId: r.strOrNull(o, 'programId', where),
    aspect: r.str(o, 'aspect', where),
    direction: r.str(o, 'direction', where),
    invalidRule: r.bool(o, 'invalidRule', where),
    overridden: r.bool(o, 'overridden', where),
    summary: r.str(o, 'summary', where),
    before: readDecision(r, o.before, `${where}.before`),
    after: readDecision(r, o.after, `${where}.after`),
  }
}

/** `number[]`。`validate.ts` 只给了 `strList`，规则 id 的列表要自己数一遍。 */
function numList(r: FieldReader, raw: unknown, where: string): number[] {
  return r.array(raw, where).map((n, i) => {
    if (typeof n !== 'number' || Number.isNaN(n)) {
      r.fail(`${where}[${i}] 应该是 number，实际是 ${n === null ? 'null' : typeof n}`, raw)
    }
    return n
  })
}

function readCounts(r: FieldReader, raw: unknown, where: string): PreviewCounts {
  const o = r.object(raw, where)
  return {
    total: r.num(o, 'total', where),
    scanned: r.num(o, 'scanned', where),
    hits: r.num(o, 'hits', where),
    opened: r.num(o, 'opened', where),
    tightened: r.num(o, 'tightened', where),
    moved: r.num(o, 'moved', where),
    mixed: r.num(o, 'mixed', where),
    deciderOnly: r.num(o, 'deciderOnly', where),
    shielded: r.num(o, 'shielded', where),
    invalid: r.num(o, 'invalid', where),
  }
}

function readChoice(r: FieldReader, raw: Record<string, unknown>, where: string): SchemaChoice {
  return { value: r.str(raw, 'value', where), label: r.str(raw, 'label', where) }
}

function readSchemaValue(r: FieldReader, raw: unknown, where: string): SchemaValue {
  const o = r.object(raw, where)
  const type = r.str(o, 'type', where)
  const options =
    o.options === null
      ? null
      : r.objList(o, 'options', where).map((x, i) => readChoice(r, x, `${where}.options[${i}]`))

  // 契约里的一条硬约定：**声明成 enum 就必须带非空的 options**。
  // 违反它的后果是界面上一个空下拉框——那比一个自由文本框更糟，因为它看起来
  // 是"这个字段没有可选值"，而真相是"清单取不到"。当场报出来，不静默渲染。
  if (type === 'enum' && (options === null || options.length === 0)) {
    r.fail(`${where} 声明成 enum 却没有可选值（options 为 ${options === null ? 'null' : '空数组'}）`, raw)
  }

  return {
    kind: r.str(o, 'kind', where),
    type,
    multiple: r.bool(o, 'multiple', where),
    options,
    unit: r.strOrNull(o, 'unit', where),
    placeholder: r.strOrNull(o, 'placeholder', where),
    splitPattern: r.strOrNull(o, 'splitPattern', where),
  }
}

function readSchemaField(r: FieldReader, raw: Record<string, unknown>, where: string): SchemaField {
  return {
    f: r.str(raw, 'f', where),
    label: r.str(raw, 'label', where),
    available: r.bool(raw, 'available', where),
    unavailableReason: r.strOrNull(raw, 'unavailableReason', where),
    ops: r.objList(raw, 'ops', where).map((op, i) => ({
      op: r.str(op, 'op', `${where}.ops[${i}]`),
      // 漏登记时是 null，**这里绝不 `?? op`**：那样一来"没登记"与"登记成了
      // 一个英文名"在前端就再也分不开，而后端加的两道门就白加了
      label: r.strOrNull(op, 'label', `${where}.ops[${i}]`),
      unitSuffix: r.strOrNull(op, 'unitSuffix', `${where}.ops[${i}]`),
    })),
    value: readSchemaValue(r, raw.value, `${where}.value`),
  }
}

function readSchemaStack(r: FieldReader, raw: Record<string, unknown>, where: string): SchemaStack {
  return {
    kind: r.str(raw, 'kind', where),
    label: r.str(raw, 'label', where),
    effects: r.objList(raw, 'effects', where).map((e, i) => ({
      value: r.str(e, 'value', `${where}.effects[${i}]`),
      label: r.str(e, 'label', `${where}.effects[${i}]`),
      hint: r.str(e, 'hint', `${where}.effects[${i}]`),
      withAssetTypes: r.bool(e, 'withAssetTypes', `${where}.effects[${i}]`),
    })),
    freeform: r.strOrNull(raw, 'freeform', where),
    fallback: readChoice(r, r.object(raw.fallback, `${where}.fallback`), `${where}.fallback`),
    subjectType: r.strOrNull(raw, 'subjectType', where),
  }
}

/* ── 七条端点 ───────────────────────────────────────────────────── */

/**
 * `GET /api/v1/admin/rules/schema`。条件字段、运算符、三栈 effect 的清单。
 *
 * **只读、不碰库**（后端把一份常量序列化出去），所以它便宜到可以每次打开
 * 规则页都取一次——不做缓存正是刻意的：缓存就要管失效，而"要管失效的第二份
 * 真相"正是这个仓库反复拒绝的形状。
 *
 * 失败一律抛出去。见文件头第零节：**这里没有兜底清单**。
 */
export async function fetchRulesSchema(): Promise<RulesSchema> {
  const endpoint = `GET ${BASE}/rules/schema`
  const raw = await apiGet<unknown>(`${BASE}/rules/schema`)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    fields: r.objList(o, 'fields', '').map((f, i) => readSchemaField(r, f, `fields[${i}]`)),
    joins: r.objList(o, 'joins', '').map((j, i) => readChoice(r, j, `joins[${i}]`)),
    stacks: r.objList(o, 'stacks', '').map((s, i) => readSchemaStack(r, s, `stacks[${i}]`)),
    assetTypes: r.objList(o, 'assetTypes', '').map((a, i) => readChoice(r, a, `assetTypes[${i}]`)),
    assetAll: r.str(o, 'assetAll', ''),
  }
}

/**
 * `GET /api/v1/admin/rules`。不传 `kind` 返回三栈全部，**含停用的规则**——
 * 停用一条之后它必须还在界面上，否则再也开不回来。
 */
export async function listRules(kind?: StackKind): Promise<Rule[]> {
  const endpoint = `GET ${BASE}/rules`
  const raw = await apiGet<unknown>(`${BASE}/rules`, kind === undefined ? undefined : { kind })
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return r.objList(o, 'rules', '').map((item, i) => readRule(r, item, `rules[${i}]`))
}

/**
 * `POST /api/v1/admin/rules`。201。
 *
 * 400 `rule_invalid` 时逐条中文原因在 `ApiError.body.issues` 里，**一行都没落库**。
 * 编辑器要逐条显示它们，不要挑一条当 message——校验刻意不短路就是为了一次说完。
 */
export async function createRule(input: RuleInput): Promise<Rule> {
  const raw = await apiSend<unknown>('POST', `${BASE}/rules`, {
    kind: input.kind,
    priority: input.priority,
    join: input.join,
    conds: input.conds,
    subjectType: input.subjectType,
    subjectValue: input.subjectValue,
    assetTypes: input.assetTypes,
    effect: input.effect,
    note: input.note,
  })
  return readRuleEnvelope(`POST ${BASE}/rules`, raw)
}

/** `PATCH /api/v1/admin/rules/:id`。只发出现过的字段。 */
export async function patchRule(id: number, patch: RulePatch): Promise<Rule> {
  const path = rulePath(id)
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) body[key] = value
  }
  if (Object.keys(body).length === 0) {
    // 后端会回 400 empty_patch。跑这一趟只是为了拿一句我们已经知道的话
    throw new Error('api/admin/rules: patch 至少要改一个字段')
  }
  const raw = await apiSend<unknown>('PATCH', path, body)
  return readRuleEnvelope(`PATCH ${BASE}/rules/:id`, raw)
}

/**
 * 启用 / 停用。**只发 `enabled` 一个键**，这不是省事：
 * 后端对"只有 enabled"的 patch 走 `setEnabled`，不做整体内容校验——
 * 出事时"把这条规则关掉"必须永远能成功，否则最该关掉的那条坏规则会关不掉。
 * 顺手多发一个字段就把这个保证丢了。
 */
export async function setRuleEnabled(id: number, enabled: boolean): Promise<Rule> {
  const raw = await apiSend<unknown>('PATCH', rulePath(id), { enabled })
  return readRuleEnvelope(`PATCH ${BASE}/rules/:id`, raw)
}

/**
 * `DELETE /api/v1/admin/rules/:id`。200 而不是 204：回的是**被删那条的完整内容**。
 * `policy_rules` 没有软删除列，删完再查也查不回来，"删掉的是哪一条"只能靠这一份。
 */
export async function deleteRule(id: number): Promise<Rule> {
  const raw = await apiSend<unknown>('DELETE', rulePath(id))
  return readRuleEnvelope(`DELETE ${BASE}/rules/:id`, raw)
}

/**
 * `POST /api/v1/admin/rules/preview`。**不落库**。
 *
 * 影响预览的全部数字来自这里，前端一个都不算（spec §5.5 定义了计算范围）。
 */
export async function previewRules(input: PreviewInput): Promise<PreviewResult> {
  const endpoint = `POST ${BASE}/rules/preview`
  const body: Record<string, unknown> = {}
  if (input.rule !== undefined) body.rule = stripUndefined(input.rule)
  if (input.rules !== undefined) body.rules = input.rules.map(stripUndefined)
  if (input.deleted !== undefined) body.deleted = input.deleted
  if (input.kind !== undefined) body.kind = input.kind
  if (input.limit !== undefined) body.limit = input.limit

  const raw = await apiSend<unknown>('POST', `${BASE}/rules/preview`, body)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  const scopeRaw = r.object(o.scope, 'scope')

  return {
    scope: {
      meetings: r.num(scopeRaw, 'meetings', 'scope'),
      meetingsTotal: r.num(scopeRaw, 'meetingsTotal', 'scope'),
      truncated: r.bool(scopeRaw, 'truncated', 'scope'),
      programs: r.strList(scopeRaw, 'programs', 'scope'),
    },
    stacks: r.objList(o, 'stacks', '').map((s, i) => {
      const where = `stacks[${i}]`
      const sampled = r.object(s.sampled, `${where}.sampled`)
      return {
        kind: r.str(s, 'kind', where),
        counts: readCounts(r, s.counts, `${where}.counts`),
        summary: r.str(s, 'summary', where),
        changedRuleIds: numList(r, s.changedRuleIds, `${where}.changedRuleIds`),
        changed: r.objList(s, 'changed', where).map((c, j) => readChange(r, c, `${where}.changed[${j}]`)),
        deciderOnly: r
          .objList(s, 'deciderOnly', where)
          .map((c, j) => readChange(r, c, `${where}.deciderOnly[${j}]`)),
        shielded: r
          .objList(s, 'shielded', where)
          .map((c, j) => readChange(r, c, `${where}.shielded[${j}]`)),
        sampled: {
          changed: r.bool(sampled, 'changed', `${where}.sampled`),
          deciderOnly: r.bool(sampled, 'deciderOnly', `${where}.sampled`),
          shielded: r.bool(sampled, 'shielded', `${where}.sampled`),
        },
      }
    }),
    warnings: r.objList(o, 'warnings', '').map((w, i) => ({
      level: r.str(w, 'level', `warnings[${i}]`),
      code: r.str(w, 'code', `warnings[${i}]`),
      text: r.str(w, 'text', `warnings[${i}]`),
      meetings: r.objList(w, 'meetings', `warnings[${i}]`).map((m, j) => ({
        id: r.str(m, 'id', `warnings[${i}].meetings[${j}]`),
        title: r.str(m, 'title', `warnings[${i}].meetings[${j}]`),
      })),
    })),
    candidateIssues: r.objList(o, 'candidateIssues', '').map((c, i) => ({
      id: r.num(c, 'id', `candidateIssues[${i}]`),
      kind: r.str(c, 'kind', `candidateIssues[${i}]`),
      issues: r.strList(c, 'issues', `candidateIssues[${i}]`),
    })),
  }
}

/**
 * `GET /api/v1/admin/rules/:id/matches`。spec §4.7：规则行右侧的命中数可点。
 *
 * 「命中」= **这条规则自身的条件匹配**，不是整栈求值的结果：主体不符、
 * 被更高优先级顶掉的规则照样算命中。这与影响预览的口径一致，两处必须是同一件事。
 * 停用的规则也算得出来——管理员要先看得见"把它开回来会命中什么"。
 */
export async function ruleMatches(id: number, limit?: number): Promise<RuleMatchesResult> {
  const endpoint = `GET ${BASE}/rules/:id/matches`
  const raw = await apiGet<unknown>(
    rulePath(id, '/matches'),
    limit === undefined ? undefined : { limit },
  )
  const r = reader(endpoint)
  const o = r.object(raw, '')
  const scopeRaw = r.object(o.scope, 'scope')
  return {
    rule: readRule(r, o.rule, 'rule'),
    scope: {
      meetings: r.num(scopeRaw, 'meetings', 'scope'),
      meetingsTotal: r.num(scopeRaw, 'meetingsTotal', 'scope'),
      truncated: r.bool(scopeRaw, 'truncated', 'scope'),
    },
    matches: r.objList(o, 'matches', '').map((m, i) => ({
      id: r.str(m, 'id', `matches[${i}]`),
      meetingId: r.str(m, 'meetingId', `matches[${i}]`),
      subMeetingId: r.str(m, 'subMeetingId', `matches[${i}]`),
      title: r.str(m, 'title', `matches[${i}]`),
      startAt: r.num(m, 'startAt', `matches[${i}]`),
      missing: r.strList(m, 'missing', `matches[${i}]`),
    })),
  }
}

/** `JSON.stringify` 会丢掉值为 undefined 的键，但显式删掉更好读，也好断言。 */
function stripUndefined(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
