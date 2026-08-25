/**
 * 三栈规则求值（阶段 3 · T3）。
 *
 * 产品模型有三组互相独立的规则栈（spec §4.6 / 计划 §2.2），各管一件事：
 *
 * | 栈 | 决定 | 主体 | effect | asset_types | 兜底 |
 * | --- | --- | --- | --- | --- | --- |
 * | `fetch`   | 去腾讯拉哪些会议、拉哪几类资产 | **无**（系统级） | `all` / `skip` | 拉哪几类 | `skip` |
 * | `archive` | 往 NAS 的哪个目录归档 | **无**（系统级） | 目录模板 | 不用 | `skip` |
 * | `allow`   | 哪些会议准许被外部程序取走 | **采集程序** | `allow` / `deny` | 准许取哪几类 | **`deny`** |
 *
 * **allow 栈的兜底是 deny，另两栈是 skip。** 第三栈是数据出企业边界的唯一闸门
 * （spec §1.4），默认必须是关的——这不是可以「统一一下」的不一致。
 *
 * 三栈的算法完全相同，只有**主体匹配**与**兜底**不同，所以这里是一个
 * `evaluateStack` + 三个薄封装。排序只有 `sortStackRules` 一份实现，
 * 规则列表（阶段 5 · F3）也读它——spec §5.1 明写「规则列表的顺序不再是判定顺序，
 * 管理员就读不出结果了」，两处各排一次早晚会分叉。
 *
 * 本文件**不改** `engine.ts`：那套单栈引擎还在给网关的 `meetings.ts` 供电，
 * 接线是 T4 的事。条件求值一律走 `conds.ts`，这里不重复实现。
 *
 * ## 四条不许含糊的规矩
 *
 * 1. **平局按 id 升序，先建的先命中。** 原型 `gate-console.html:3427` 的
 *    `sort((a, b) => b.pri - a.pri)` 根本没写平局分支，靠 V8 排序恰好稳定。
 *    规格要的是确定性：同一批规则无论以什么顺序传进来，判定结果必须一样。
 * 2. **fetch / archive 显式忽略主体。** 不是「恰好匹配不上」——现有
 *    `policy_rules.subject_type` 是 `NOT NULL`，库里存在带主体的历史行。
 *    若按「主体不符就筛掉」处理，这些规则会整条消失，而不是照系统级行为参与判定。
 *    忽略这件事还要在 trace 与静态检查里说出来，否则脏数据在界面上是隐形的。
 * 3. **allow 栈的主体是采集程序，不是人。** `engine.ts:20-24` 的 `subjectMatches`
 *    只认 `'user'`，那是旧语义。这里只认 `subject_type === 'program'`，
 *    `subject_value` 对应 `service_accounts.id`。
 * 4. **判定理由必须可回溯。** 每次判定都说得出是哪条规则（id **和 note**）决定的；
 *    兜底时说得出「没有任何规则匹配」。阶段 4 的 A2 会议查询 API 要在一行里返回
 *    逐阶段判定理由，阶段 5 的分诊条与详情抽屉全靠它——**这不是调试信息，是产品功能。**
 *
 * ## 「判断不出来就落到安全侧」在栈这一层的样子
 *
 * 命中的规则 effect 是脏数据（`'allwo'`、空串）时，**不继续往下找**：往下找会让一条
 * 写坏的高优先级 deny 被低优先级的 allow 顶掉，那是查不出来的静默放行。
 * 正确处理是「这条规则说了算，但它说不清楚」→ 落到本栈的安全侧（fetch/archive → skip，
 * allow → deny），`source` 记 `'rule_invalid'`，`issues` 里写明为什么。
 */

import { ALL_ASSET_KEYS, type AssetKey } from '@yaowu/mde-engine'
import { describeRuleIssues, evaluateRule, type CondRule, type MeetingFacts } from './conds'

export type StackKind = 'fetch' | 'archive' | 'allow'

/** fetch 栈的 effect：拉全部资产 / 不拉 */
export type FetchEffect = 'all' | 'skip'
/** allow 栈的 effect：准许 / 禁止外部程序取走 */
export type AllowEffect = 'allow' | 'deny'
/** archive 栈的 effect：`'skip'` 或目录模板（`/nas/meetings-finance/{年}/`） */
export type ArchiveEffect = string

/**
 * 一条栈规则。对应 `policy_rules` 改造后的行（计划 §2.1），
 * 由 store 组装——规则从哪来是 store 的事，这里只管求值。
 *
 * 继承 `CondRule` 拿到 `join` / `conds`，条件求值因此完全复用 `conds.ts`。
 */
export interface StackRule extends CondRule {
  id: number
  kind: StackKind
  priority: number
  enabled: boolean
  effect: string
  /** `['*']` 表示全部。用 `AssetKey` 的八个键，不许用原型 HTML 里那套短名 */
  assetTypes: string[]
  /** fetch / archive 两栈留空；allow 栈是 `'program'` */
  subjectType: string | null
  /** allow 栈对应 `service_accounts.id` */
  subjectValue: string | null
  /** 说明文字。spec §6.3：会出现在规则列表**和每场会议的判定理由里** */
  note: string | null
}

/** 判定是谁做出的 */
export type DecisionSource =
  /** 某条规则命中 */
  | 'rule'
  /** 某条规则命中，但它的 effect 是脏数据，落到了本栈的安全侧 */
  | 'rule_invalid'
  /** 一条都没匹配，用了本栈的兜底 */
  | 'default'
  /**
   * 人工改写决定的（T7 · `override.ts`，spec §5.4）。规则栈**不会**产出这个取值——
   * 改写是套在三个 `evaluate*Stack` 外面的一层，引擎本身一个字都不认改写。
   */
  | 'override'
  /**
   * 人工改写决定的，但它的 effect 是脏数据，落到了本栈的安全侧。
   *
   * 与 `override` 分开是必要的，不是对称好看：改写的 effect 来自管理员在界面上填的
   * 自由文本，比 `policy_rules.effect` 更容易脏。两者合成一个取值，详情抽屉就再也分不开
   * 「管理员填错了」和「管理员就是这么定的」——前者要去改，后者是他自己想要的。
   */
  | 'override_invalid'

export type RuleOutcome =
  | 'matched'
  /** 条件不成立 */
  | 'not_matched'
  /** 主体不适用（只可能出现在 allow 栈） */
  | 'subject_mismatch'

/** 一条规则被考察后的结论。按考察顺序排列，就是判定顺序 */
export interface StackRuleTrace {
  ruleId: number
  priority: number
  note: string | null
  outcome: RuleOutcome
  /** 人类可读的一句话，可直接进详情抽屉 */
  detail: string
}

export interface StackDecision<E extends string = string> {
  kind: StackKind
  effect: E
  /** 决定这次判定的规则；兜底时为 null */
  ruleId: number | null
  /** 那条规则的 note；兜底时为 null */
  note: string | null
  source: DecisionSource
  /** 一句话的判定理由，可直接进 A2 的会议行与详情抽屉 */
  reason: string
  /**
   * 这次判定**实际生效**的资产类型。
   * skip / deny 与兜底一律是空数组——不拉就是一类都不拉，不放行就是一类都取不到。
   * archive 栈恒为空（它不用 asset_types）。
   */
  assetTypes: AssetKey[]
  /** 决定这次判定的那条规则身上的问题（effect 非法、资产名不认识…）。兜底时为空 */
  issues: string[]
  /** 实际考察过的规则，按判定顺序，止于命中的那条 */
  trace: StackRuleTrace[]
}

export type FetchDecision = StackDecision<FetchEffect>
export type ArchiveDecision = StackDecision<ArchiveEffect>
export type AllowDecision = StackDecision<AllowEffect>

export interface StackInput {
  facts: MeetingFacts
  now: number
}

export interface AllowStackInput extends StackInput {
  /** 采集程序，对应 `service_accounts.id`。空串匹配不上任何规则 */
  programId: string
}

/**
 * 三栈在判定理由里的称呼。**导出给 `preview.ts`（T5）用**——影响预览要说
 * 「这条规则是哪一栈的」，两处各写一份中文名早晚会分叉。
 */
export const STACK_KIND_LABEL: Record<StackKind, string> = {
  fetch: '拉取规则',
  archive: '归档规则',
  allow: '采集权限规则',
}

/** 本栈的兜底。allow 是 deny，另两栈是 skip */
const FALLBACK: Record<StackKind, string> = { fetch: 'skip', archive: 'skip', allow: 'deny' }

// ── 排序：spec §5.1 的第 2 步，只有这一份实现 ─────────────────────

/**
 * priority 降序、同 priority 按 id 升序。
 *
 * 脏数据下也必须确定：priority 不是有效数字时排到最后（一条写坏的规则不该抢在
 * 正常规则前面），id 不是有效数字时排在同优先级的最后。全程用比较而不是相减，
 * 免得 `Infinity - Infinity` 算出 NaN——那会让排序结果重新变成不确定的。
 */
function compareRules(a: StackRule, b: StackRule): number {
  const pa = Number.isFinite(a.priority) ? a.priority : Number.NEGATIVE_INFINITY
  const pb = Number.isFinite(b.priority) ? b.priority : Number.NEGATIVE_INFINITY
  if (pa !== pb) return pa > pb ? -1 : 1

  const ia = Number.isFinite(a.id) ? a.id : Number.POSITIVE_INFINITY
  const ib = Number.isFinite(b.id) ? b.id : Number.POSITIVE_INFINITY
  if (ia !== ib) return ia < ib ? -1 : 1
  return 0
}

/**
 * 按判定顺序排列规则。**规则列表要用同一个函数**——spec §5.1：判定顺序读不出来，
 * 管理员就读不出结果。不就地改调用方的数组。
 */
export function sortStackRules(rules: readonly StackRule[]): StackRule[] {
  return [...rules].sort(compareRules)
}

// ── effect 与 asset_types 的规范化 ───────────────────────────────

export interface EffectNorm {
  effect: string
  /** 非 null 表示 effect 是脏数据，已落到本栈安全侧 */
  issue: string | null
}

/**
 * effect 收敛到本栈的取值域，收不住就落到本栈安全侧并说明。
 *
 * **导出给 `override.ts`（T7）用**：人工改写的 effect 也是自由文本，也要过同一道
 * 规范化。计划 §3.4 D-c 记着——同一批语义在这个项目里已经有过多套写法，
 * 两份规范化逻辑迟早会漂移，漂移的后果是同一个脏值在规则路径和改写路径下待遇不同。
 */
export function normalizeEffect(kind: StackKind, raw: unknown): EffectNorm {
  const shown = typeof raw === 'string' ? raw : String(raw)
  if (kind === 'fetch') {
    if (raw === 'all' || raw === 'skip') return { effect: raw, issue: null }
    return {
      effect: 'skip',
      issue: `effect「${shown}」不认识（拉取规则只能是 all / skip），按本栈的安全侧「不拉取」处理`,
    }
  }
  if (kind === 'allow') {
    if (raw === 'allow' || raw === 'deny') return { effect: raw, issue: null }
    return {
      effect: 'deny',
      issue: `effect「${shown}」不认识（采集权限规则只能是 allow / deny），按本栈的安全侧「禁止采集」处理`,
    }
  }
  // archive：'skip' 或一段目录模板。空白模板归不到任何地方，按不归档处理
  if (raw === 'skip') return { effect: 'skip', issue: null }
  if (typeof raw === 'string' && raw.trim() !== '') return { effect: raw, issue: null }
  return {
    effect: 'skip',
    issue: `effect「${shown}」不是可用的归档目录模板，按本栈的安全侧「不归档」处理`,
  }
}

const ASSET_KEY_SET: ReadonlySet<string> = new Set<string>(ALL_ASSET_KEYS)

export interface AssetNorm {
  keys: AssetKey[]
  issues: string[]
}

/**
 * `['*']` 展开成全部八类；不认识的名字丢掉并报出来。
 *
 * 计划 §3.4 D-c：**不许把原型的短名（`summary` / `aitr` / `digest`）带进代码**——
 * 同一批资产已经有过三套叫法，M3.5 为此吃过一次亏。丢掉而不是猜，
 * 猜错的那一类会静默多放行或少放行。
 *
 * **导出给 `override.ts`（T7）用**，理由同 `normalizeEffect`：改写里的资产名同样是
 * 管理员填的，两处各写一份映射，某一类资产迟早会在规则路径和改写路径下待遇不同。
 */
export function normalizeAssetTypes(raw: unknown): AssetNorm {
  if (!Array.isArray(raw)) {
    return { keys: [], issues: ['asset_types 不是数组，这条规则没有可用的资产类型'] }
  }
  if (raw.includes('*')) return { keys: [...ALL_ASSET_KEYS], issues: [] }

  const keys: AssetKey[] = []
  const issues: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && ASSET_KEY_SET.has(item)) {
      if (!keys.includes(item as AssetKey)) keys.push(item as AssetKey)
      continue
    }
    issues.push(
      `资产类型「${typeof item === 'string' ? item : String(item)}」不是合法的资产键，已忽略` +
        `（合法取值是 ${ALL_ASSET_KEYS.join(' / ')}；原型里的短名不能进代码，见计划 §3.4 D-c）`,
    )
  }
  return { keys, issues }
}

/** effect 是不是「这一栈的肯定侧」——只有肯定侧才带出资产类型 */
function isPositive(kind: StackKind, effect: string): boolean {
  if (kind === 'fetch') return effect === 'all'
  if (kind === 'allow') return effect === 'allow'
  return effect !== 'skip'
}

/**
 * 一次判定的 effect 读成人话。**导出给 `preview.ts`（T5）用**：影响预览的
 * 「从 A 变成 B」两头必须与判定理由里的说法一字不差，否则同一件事在
 * 详情抽屉与预览面板里读起来是两回事。
 */
export function describeStackEffect(kind: StackKind, effect: string, assetTypes: readonly AssetKey[]): string {
  const assets = assetTypes.length > 0 ? assetTypes.join('、') : '未列出任何资产类型'
  if (kind === 'fetch') return effect === 'all' ? `拉取（${assets}）` : '不拉取'
  if (kind === 'archive') return effect === 'skip' ? '不归档' : `归档到 ${effect}`
  return effect === 'allow' ? `准许采集（${assets}）` : '禁止采集'
}

function describeFallback(kind: StackKind): string {
  if (kind === 'fetch') return '默认不拉取'
  if (kind === 'archive') return '默认不归档'
  return '默认拒绝'
}

/** 规则在判定理由里的称呼：有 note 就带上，没有就只报编号，不留空引号 */
function ruleLabel(kind: StackKind, rule: StackRule): string {
  const base = `${STACK_KIND_LABEL[kind]} #${rule.id}`
  return rule.note !== null && rule.note !== '' ? `${base}「${rule.note}」` : base
}

// ── 主体 ────────────────────────────────────────────────────────

interface SubjectCheck {
  applies: boolean
  /** 有话要说时给一句（系统级栈忽略了残留主体、或主体不适用的原因） */
  detail: string | null
}

function subjectText(rule: StackRule): string {
  return `${rule.subjectType ?? 'null'}:${rule.subjectValue ?? 'null'}`
}

function hasSubject(rule: StackRule): boolean {
  return (rule.subjectType ?? '') !== '' || (rule.subjectValue ?? '') !== ''
}

/**
 * 主体是否适用。**fetch / archive 恒为 true**——系统级行为，规则上残留的主体
 * 是历史脏数据（`subject_type` 曾是 `NOT NULL`），显式忽略它，而不是让它把整条规则筛掉。
 */
function checkSubject(kind: StackKind, rule: StackRule, programId: string): SubjectCheck {
  if (kind !== 'allow') {
    return hasSubject(rule)
      ? {
          applies: true,
          detail: `规则上残留主体「${subjectText(rule)}」，${STACK_KIND_LABEL[kind]}是系统级行为，已忽略`,
        }
      : { applies: true, detail: null }
  }

  if (rule.subjectType !== 'program') {
    return {
      applies: false,
      detail:
        `规则的主体类型是「${rule.subjectType ?? 'null'}」而不是采集程序（program），` +
        '采集权限栈不认这种主体，这条规则不对任何程序生效',
    }
  }
  const value = rule.subjectValue ?? ''
  if (value === '' || programId === '') {
    return {
      applies: false,
      detail: `规则或请求缺少采集程序 id（规则「${value || '空'}」/ 当前「${programId || '空'}」），不适用`,
    }
  }
  if (value !== programId) {
    return {
      applies: false,
      detail: `规则授予的采集程序是「${value}」，当前程序是「${programId}」，不适用`,
    }
  }
  return { applies: true, detail: null }
}

// ── 求值：spec §5.1 逐字实现，三栈共用 ───────────────────────────

function evaluateStack(
  kind: StackKind,
  rules: readonly StackRule[],
  input: StackInput,
  programId: string,
): StackDecision {
  // 1. 取出该 kind 中 enabled 的全部规则（enabled 用真值判断，兼容 tinyint 的 0/1）
  const mine = rules.filter((r) => r.kind === kind && r.enabled)
  // 2. 按 priority 降序，同 priority 按 id 升序
  const ordered = sortStackRules(mine)

  const trace: StackRuleTrace[] = []

  // 3. 从上往下找第一条匹配的，用它的 effect，立即停止
  for (const rule of ordered) {
    const subject = checkSubject(kind, rule, programId)
    if (!subject.applies) {
      trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        note: rule.note,
        outcome: 'subject_mismatch',
        detail: subject.detail ?? '主体不适用',
      })
      continue
    }

    const evaluation = evaluateRule(rule, input.facts, input.now)
    const detail = subject.detail === null ? evaluation.detail : `${evaluation.detail}（${subject.detail}）`
    trace.push({
      ruleId: rule.id,
      priority: rule.priority,
      note: rule.note,
      outcome: evaluation.matched ? 'matched' : 'not_matched',
      detail,
    })
    if (!evaluation.matched) continue

    const { effect, issue } = normalizeEffect(kind, rule.effect)
    // archive 栈不用 asset_types；另两栈只在肯定侧带出资产——
    // 「不拉取」「禁止采集」的资产集合就是空的，不该让调用方自己去想。
    const assets =
      kind === 'archive' || !isPositive(kind, effect)
        ? { keys: [] as AssetKey[], issues: [] as string[] }
        : normalizeAssetTypes(rule.assetTypes)
    const issues = issue === null ? assets.issues : [issue, ...assets.issues]

    return {
      kind,
      effect,
      ruleId: rule.id,
      note: rule.note,
      // 命中了但 effect 说不清楚：仍然是这条规则说了算，**不往下找**（见文件头）
      source: issue === null ? 'rule' : 'rule_invalid',
      reason:
        issue === null
          ? `${ruleLabel(kind, rule)}决定：${describeStackEffect(kind, effect, assets.keys)}`
          : `${ruleLabel(kind, rule)}的${issue}`,
      assetTypes: assets.keys,
      issues,
      trace,
    }
  }

  // 4. 一条都不匹配 → 用该栈的兜底
  const fallback = FALLBACK[kind]!
  const who = kind === 'allow' ? `这场会议（采集程序 ${programId || '未指定'}）` : '这场会议'
  return {
    kind,
    effect: fallback,
    ruleId: null,
    note: null,
    source: 'default',
    reason: `没有任何${STACK_KIND_LABEL[kind]}匹配${who}，按兜底处理：${describeFallback(kind)}`,
    assetTypes: [],
    issues: [],
    trace,
  }
}

/** 拉取栈：去腾讯拉哪些会议、拉哪几类资产。兜底 `skip` */
export function evaluateFetchStack(rules: readonly StackRule[], input: StackInput): FetchDecision {
  // effect 已由 normalizeEffect 收敛到 'all' | 'skip'，这里的断言是它的结论
  return evaluateStack('fetch', rules, input, '') as FetchDecision
}

/** 归档栈：往 NAS 的哪个目录归档。effect 是目录模板，兜底 `skip` */
export function evaluateArchiveStack(rules: readonly StackRule[], input: StackInput): ArchiveDecision {
  return evaluateStack('archive', rules, input, '')
}

/** 采集权限栈：哪些会议准许被**这个采集程序**取走。兜底 **`deny`** */
export function evaluateAllowStack(rules: readonly StackRule[], input: AllowStackInput): AllowDecision {
  return evaluateStack('allow', rules, input, input.programId) as AllowDecision
}

/**
 * 三栈一次算完。阶段 4 的 A2 会议查询 API 要在一行里返回**逐阶段判定理由**，
 * 拿到的就是这三个 decision 的 `reason`。
 */
export function evaluateStacks(
  rules: readonly StackRule[],
  input: AllowStackInput,
): { fetch: FetchDecision; archive: ArchiveDecision; allow: AllowDecision } {
  return {
    fetch: evaluateFetchStack(rules, input),
    archive: evaluateArchiveStack(rules, input),
    allow: evaluateAllowStack(rules, input),
  }
}

/**
 * 这次判定覆不覆盖某一类资产。
 *
 * **资产类型不是筛选条件，是命中那条规则的载荷。** 若把它当筛选条件（像旧的
 * `engine.ts:26-28` 那样先按资产过一遍再排序），一条高优先级的「只放行转写」
 * 会被低优先级的「放行全部」在视频上顶掉——那正是 spec §5.1 禁止的合并式语义。
 * 正确读法是：先按 conds + 主体选出唯一一条决定者，再看它放行了哪几类。
 *
 * `meetings.ts:255`（downloadUrl，注释标明是唯一的真正安全边界）与采集清单
 * 重算（T8）都用这一个函数，两处不会分叉。
 */
export function decisionAllowsAsset(
  decision: StackDecision,
  assetType: AssetKey,
): { allowed: boolean; reason: string } {
  if (decision.assetTypes.includes(assetType)) {
    return { allowed: true, reason: decision.reason }
  }
  if (decision.ruleId === null) {
    return { allowed: false, reason: decision.reason }
  }
  const label = `${STACK_KIND_LABEL[decision.kind]} #${decision.ruleId}` +
    (decision.note !== null && decision.note !== '' ? `「${decision.note}」` : '')
  if (decision.assetTypes.length === 0) {
    return { allowed: false, reason: decision.reason }
  }
  return {
    allowed: false,
    reason: `${label}覆盖的资产类型是 ${decision.assetTypes.join('、')}，不含「${assetType}」`,
  }
}

// ── 静态检查：建完就静默失效的规则要在列表里看得见 ──────────────────

/**
 * 规则的静态检查，**不依赖任何会议数据**。在 `conds.ts` 的条件层检查之上，
 * 补上栈这一层特有的问题：kind / priority 的脏数据、effect 取值域、
 * 三栈各自的主体规矩、资产类型。
 *
 * 规则列表与规则编辑器（阶段 5 · F3）调用它——管理员建了一条永远不会命中、
 * 或者命中了也取不到东西的规则，界面上必须看得见。
 */
export function describeStackRuleIssues(rule: StackRule): string[] {
  const issues: string[] = []
  const kind = rule.kind

  if (!Number.isFinite(rule.priority)) {
    issues.push('priority 不是有效数字，这条规则会排到本栈的最后')
  }

  if (kind !== 'fetch' && kind !== 'archive' && kind !== 'allow') {
    // kind 之后的检查（effect 取值域、主体规矩、资产类型）全都因栈而异，无从判起。
    // 但条件层的检查与 kind 无关，照做——不然管理员改完 kind 还要再撞一次条件的问题。
    issues.push(`kind「${String(kind)}」不是三栈之一（fetch / archive / allow），这条规则不会参与任何判定`)
    issues.push(...describeRuleIssues(rule))
    return issues
  }

  const { issue: effectIssue } = normalizeEffect(kind, rule.effect)
  if (effectIssue !== null) issues.push(effectIssue)

  if (kind === 'allow') {
    if (rule.subjectType !== 'program') {
      issues.push(
        `采集权限规则的主体必须是采集程序（subject_type = 'program'），` +
          `当前是「${rule.subjectType ?? 'null'}」，这条规则不会对任何程序生效`,
      )
    } else if ((rule.subjectValue ?? '') === '') {
      issues.push('采集权限规则没有指定采集程序（subject_value 为空），这条规则不会对任何程序生效')
    }
  } else if (hasSubject(rule)) {
    issues.push(
      `${STACK_KIND_LABEL[kind]}是系统级行为，不针对任何主体；` +
        `规则上残留的主体「${subjectText(rule)}」会被忽略（不影响判定）`,
    )
  }

  // archive 栈不用 asset_types，多余的值静默忽略即可，不值得报给管理员
  if (kind !== 'archive' && isPositive(kind, normalizeEffect(kind, rule.effect).effect)) {
    const assets = normalizeAssetTypes(rule.assetTypes)
    issues.push(...assets.issues)
    if (assets.keys.length === 0) {
      issues.push(
        kind === 'allow'
          ? '这条规则准许采集，但没有列出任何合法的资产类型，实际上一类都取不到'
          : '这条规则要拉取，但没有列出任何合法的资产类型，实际上一类都不会拉',
      )
    }
  }

  issues.push(...describeRuleIssues(rule))
  return issues
}
