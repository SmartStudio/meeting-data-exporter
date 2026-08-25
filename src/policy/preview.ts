/**
 * 规则变更的影响预览（阶段 3 · T5）。
 *
 * spec §4.7 的原话：
 *
 * > 规则的难点从来不是「怎么填」，是「填完之后有多少场会议的状态会变」。
 *
 * 条件构建器和影响预览必须同屏，所以这里是**纯函数、不落库、不读时钟**：
 * 给同一批规则、同一批会议、同一个 now，永远得同一个结果。
 *
 * ## 一、计算范围只在 `命中(旧) ∪ 命中(新)`（spec §5.5）
 *
 * > 把所有会议都列成「受影响」是虚假的规模感。
 *
 * 这不是优化，是功能本身。一个 5000 场会议的库里改一条只影响 3 场的规则，
 * 预览必须说「3 场」；说「5000 场里有 3 场变了」会让管理员对每一次改动都产生
 * 同等的恐惧感，久而久之就不看了。
 *
 * **范围由「被改动的规则」张开，不是由整个规则集张开。** spec §5.5 写的
 * `命中(旧规则) ∪ 命中(新规则)` 里的「规则」是**被编辑的那一条**（原型
 * `gate-console.html:3570` 的 `hitsOf(draft) ∪ hitsOf(draftOrig)` 是事实源）。
 * 若按「整个旧规则集 ∪ 整个新规则集」算，只要规则集里有一条兜底规则
 * （`conds: []` 匹配一切，现有种子数据就是这样），范围立刻等于全部会议——
 * 那正是这一节要防的虚假规模感。
 *
 * 这样收范围是**安全的**，不是近似：若一条规则在新旧两版里逐字相同，
 * 它在两次求值里的位置与结论都一样；一场会议若没被任何**改动过的**规则命中，
 * 两次求值经过的「命中的规则」序列完全相同，判定必然相同。所以
 * 「判定变了」⇒「至少被一条改动过的规则命中」，取并集不会漏。
 *
 * 「命中」指**该条规则自身的 conds 匹配**（`matchesRule`），不是整栈求值的结果——
 * 主体不符、被更高优先级顶掉的规则照样算「够得着」，因为改动它们仍可能改变结果。
 *
 * ## 二、人工改写过的会议排除在「会被改变」之外（spec §5.4）
 *
 * 改写是引擎结果之上的**覆盖层**，规则怎么变，被改写过的那场会议的实际结果都不变，
 * 把它算进「会被改变」是错的。但它也不该被静默丢掉——`shielded` 单列一类：
 * 「这几场本来会变，是人工改写挡住了」，管理员该知道。
 *
 * `meeting_overrides` 表要到 T6 才建，所以改写集合**作为参数传进来**
 * （`Set` 或判定函数），这里不查库。
 *
 * ## 三、四类变化，「换了理由」不与「结果变了」混为一谈
 *
 * | aspect | 意思 | 进哪个列表 |
 * | --- | --- | --- |
 * | `effect` | 判定本身变了（放行↔拒绝、拉取↔跳过、归档目录 A→B） | `changed` |
 * | `assets` | 判定没变，但放行/拉取的**资产类型**变了 | `changed` |
 * | `decider` | 判定与资产都没变，只是换了另一条规则说了算 | `deciderOnly` |
 *
 * `assets` 是本任务加的一类，计划 §4 的 T5 段没列：allow 规则从 `['*']` 改成
 * `['transcript']`，effect 还是 `allow`，但录像与音频从此取不到。只比 effect 的话，
 * 预览会对着一次真实的收紧说「0 场会改变」——那是 §4.7 最不该出现的那种谎。
 *
 * `decider` 单列而不是混进 `changed`（本任务的判断）：结果没变但理由变了，
 * 管理员该知道——判定理由会出现在详情抽屉与会议行里，换了一条规则说了算，
 * 那句话就变了；但它不该制造与真正变更同等的警觉。混进去会让每次调优先级都
 * 报出一堆「受影响」，几次之后这个数字就没人看了。
 *
 * 顺带一条：**只改 `note` 不算改动**。note 不参与判定，只影响判定理由的措辞；
 * 若把它算进指纹，改个错别字就会让全库会议进入范围、报出一堆 `decider`。
 *
 * ## 四、写坏的规则要标出来
 *
 * 命中的规则 effect 是脏数据时，`stacks.ts` 会落到本栈安全侧并标
 * `source: 'rule_invalid'`。一条写坏的规则造成的「收紧」和一条正常规则造成的收紧，
 * 对管理员意义不同——前者要去改规则，后者是他自己想要的。`invalidRule` 说的就是这个。
 */

import { matchesRule, type MeetingFacts } from './conds'
import {
  describeStackEffect,
  evaluateAllowStack,
  evaluateArchiveStack,
  evaluateFetchStack,
  STACK_KIND_LABEL,
  type StackDecision,
  type StackKind,
  type StackRule,
} from './stacks'

/**
 * 一个考察对象。fetch / archive 栈是**一场会议**；allow 栈是**会议 × 采集程序**
 * （同一场会议对 A 程序放行、对 B 程序拒绝，是两条不同的判定）。
 */
export interface PreviewSubject {
  /** 调用方自己的标识，原样带回。会议 × 程序时要把程序也编进去 */
  key: string
  facts: MeetingFacts
  /** allow 栈用，对应 `service_accounts.id`。fetch / archive 忽略 */
  programId?: string
}

/** 变化变在哪一层 */
export type ImpactAspect =
  /** 判定本身变了 */
  | 'effect'
  /** 判定没变，放行/拉取的资产类型变了 */
  | 'assets'
  /** 判定与资产都没变，只是换了另一条规则说了算 */
  | 'decider'

/** 变化的方向。界面按它上色：放开是品牌色，收紧是警示色 */
export type ImpactDirection =
  /** 更放开了（放行 / 开始拉取 / 开始归档 / 多放行了几类资产） */
  | 'opened'
  /** 更收紧了 */
  | 'tightened'
  /** archive 栈的目录从 A 换到 B：既不是放开也不是收紧 */
  | 'moved'
  /** 资产类型有增有减 */
  | 'mixed'
  /** 结果没变（只可能出现在 `decider`） */
  | 'unchanged'

export interface ImpactChange {
  key: string
  kind: StackKind
  aspect: ImpactAspect
  direction: ImpactDirection
  /** 改动前的判定，含是哪条规则（`ruleId` / `note` / `reason`）决定的 */
  before: StackDecision
  /** 改动后的判定 */
  after: StackDecision
  /** 前后任一侧是被写坏的规则决定的（`source === 'rule_invalid'`） */
  invalidRule: boolean
  /** 这场会议被人工改写过。只可能出现在 `shielded` 里 */
  overridden: boolean
  /** 一句可直接上屏的话：从什么变成什么，前后各是哪条规则决定的 */
  summary: string
}

export interface ImpactCounts {
  /** 传进来的考察对象总数。只用于「只算了其中 N 场」这句说明 */
  total: number
  /** 实际考察过的对象数 = `命中(旧) ∪ 命中(新)`。**这才是这次改动够得着的规模** */
  scanned: number
  /** 命中改动后规则的对象数，对应 spec §4.7 的「场命中」 */
  hits: number
  opened: number
  tightened: number
  moved: number
  mixed: number
  /** 判定没变、只是换了规则说了算 */
  deciderOnly: number
  /** 本来会变、被人工改写挡住的 */
  shielded: number
  /** `changed` 里有多少是被写坏的规则决定的 */
  invalid: number
}

export interface StackImpactPreview {
  kind: StackKind
  counts: ImpactCounts
  /** 判定或资产真的变了的对象，按传入顺序 */
  changed: ImpactChange[]
  /** 结果没变，但换了另一条规则说了算 */
  deciderOnly: ImpactChange[]
  /** 本来会变，但这场会议被人工改写过——改写优先于所有规则 */
  shielded: ImpactChange[]
  /** 这次改动涉及的规则 id（新旧两侧，按出现顺序） */
  changedRuleIds: number[]
  /** 一句话汇总，可直接进预览面板 */
  summary: string
}

export interface StackImpactOptions {
  /** 预览哪一栈 */
  kind: StackKind
  /** 改动前的全部规则（三栈混在一起也行，本函数只看本栈的） */
  oldRules: readonly StackRule[]
  /** 改动后的全部规则 */
  newRules: readonly StackRule[]
  subjects: readonly PreviewSubject[]
  /** unix 秒。求值器不读时钟，这里必须显式给 */
  now: number
  /**
   * 被人工改写过的对象（T6 的 `meeting_overrides` 落地前由调用方传入）。
   * 改写是按「会议 × 栈」记的，所以传进来的集合应当已经按 `kind` 筛过。
   */
  overridden?: ReadonlySet<string> | ((subject: PreviewSubject) => boolean)
}

// ── 规则的异同：只比会改变判定的字段 ──────────────────────────

/** 深比较。`conds` 来自无 schema 校验的 JSON 列，形状一概不可信 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/**
 * 两版规则是不是「同一条、没改过」。
 *
 * **`note` 不参与比较**：它不改变判定，只影响判定理由的措辞。把它算进来，
 * 改个错别字就会让全库会议进入范围、报出一堆「换了理由」。
 * 拿不准的字段一律算「改过」——范围宁可宽一点，也不能漏掉真会变的会议。
 */
function sameRule(a: StackRule, b: StackRule): boolean {
  return (
    a.kind === b.kind &&
    Object.is(a.priority, b.priority) &&
    Boolean(a.enabled) === Boolean(b.enabled) &&
    Object.is(a.effect, b.effect) &&
    a.subjectType === b.subjectType &&
    a.subjectValue === b.subjectValue &&
    a.join === b.join &&
    deepEqual(a.assetTypes, b.assetTypes) &&
    deepEqual(a.conds, b.conds)
  )
}

/** 同一个 id 可能有多行（脏数据）。按 id 分组后整组比较，重复行因此不会被吞掉 */
function groupById(rules: readonly StackRule[]): Map<number, StackRule[]> {
  const out = new Map<number, StackRule[]>()
  for (const rule of rules) {
    const group = out.get(rule.id)
    if (group) group.push(rule)
    else out.set(rule.id, [rule])
  }
  return out
}

function sameGroup(a: readonly StackRule[], b: readonly StackRule[]): boolean {
  return a.length === b.length && a.every((rule, i) => sameRule(rule, b[i]!))
}

/** 一条规则 id 在这次改动里的新旧两版。新增时 `before` 为空，删除时 `after` 为空 */
interface RuleChange {
  id: number
  before: StackRule[]
  after: StackRule[]
}

function diffRules(oldRules: readonly StackRule[], newRules: readonly StackRule[]): RuleChange[] {
  const before = groupById(oldRules)
  const after = groupById(newRules)

  const ids: number[] = []
  const seen = new Set<number>()
  for (const rule of [...oldRules, ...newRules]) {
    if (seen.has(rule.id)) continue
    seen.add(rule.id)
    ids.push(rule.id)
  }

  const changes: RuleChange[] = []
  for (const id of ids) {
    const a = before.get(id) ?? []
    const b = after.get(id) ?? []
    if (sameGroup(a, b)) continue
    changes.push({ id, before: a, after: b })
  }
  return changes
}

/**
 * 这次改动碰了哪几栈。规则改了 kind（fetch → allow）时**两栈都要重算**——
 * 规则编辑器只知道自己在编哪一栈，不知道这条规则原来是哪一栈的。
 */
export function changedStackKinds(
  oldRules: readonly StackRule[],
  newRules: readonly StackRule[],
): StackKind[] {
  const kinds: StackKind[] = []
  for (const change of diffRules(oldRules, newRules)) {
    for (const rule of [...change.before, ...change.after]) {
      if (rule.kind !== 'fetch' && rule.kind !== 'archive' && rule.kind !== 'allow') continue
      if (!kinds.includes(rule.kind)) kinds.push(rule.kind)
    }
  }
  return kinds
}

// ── 求值：一律走 stacks.ts，这里不重复实现 ────────────────────

function decide(
  kind: StackKind,
  rules: readonly StackRule[],
  subject: PreviewSubject,
  now: number,
): StackDecision {
  const facts = subject.facts
  if (kind === 'allow') {
    return evaluateAllowStack(rules, { facts, now, programId: subject.programId ?? '' })
  }
  if (kind === 'fetch') return evaluateFetchStack(rules, { facts, now })
  return evaluateArchiveStack(rules, { facts, now })
}

/** 这一版规则里，有没有哪一行**自身的 conds** 命中这场会议 */
function hitBy(versions: readonly StackRule[], subject: PreviewSubject, now: number): boolean {
  return versions.some((rule) => matchesRule(rule, subject.facts, now))
}

// ── 变化的判别 ────────────────────────────────────────────────

function effectDirection(kind: StackKind, before: string, after: string): ImpactDirection {
  if (kind === 'archive') {
    // effect 是目录模板：'skip' 是不归档，其余是归档到某个目录
    if (before === 'skip') return 'opened'
    if (after === 'skip') return 'tightened'
    return 'moved'
  }
  // fetch / allow 的 effect 已被 stacks.ts 收敛到两个取值，前后不同必有一侧是肯定侧
  const positive = kind === 'fetch' ? 'all' : 'allow'
  return after === positive ? 'opened' : 'tightened'
}

function assetDirection(before: readonly string[], after: readonly string[]): ImpactDirection {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const added = after.filter((k) => !beforeSet.has(k))
  const removed = before.filter((k) => !afterSet.has(k))
  if (added.length > 0 && removed.length === 0) return 'opened'
  if (removed.length > 0 && added.length === 0) return 'tightened'
  return 'mixed'
}

function sameAssets(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  return setA.size === setB.size && [...setA].every((k) => setB.has(k))
}

interface Diff {
  aspect: ImpactAspect
  direction: ImpactDirection
}

/** 前后两次判定差在哪。完全一样时返回 null——不进任何列表 */
function diffDecisions(kind: StackKind, before: StackDecision, after: StackDecision): Diff | null {
  if (before.effect !== after.effect) {
    return { aspect: 'effect', direction: effectDirection(kind, before.effect, after.effect) }
  }
  if (!sameAssets(before.assetTypes, after.assetTypes)) {
    return { aspect: 'assets', direction: assetDirection(before.assetTypes, after.assetTypes) }
  }
  // 判定与资产都一样，但换了一条规则说了算（或从兜底变成有规则决定）：
  // 结果没变，理由变了。source 也要比——同一条规则从正常变成 effect 脏数据，
  // 落到的安全侧恰好与原判定相同时，那也是「同一个结果，两回事」
  if (before.ruleId !== after.ruleId || before.source !== after.source) {
    return { aspect: 'decider', direction: 'unchanged' }
  }
  return null
}

// ── 说人话 ────────────────────────────────────────────────────

/** 一次判定是谁做出的，一句话 */
function describeDecider(decision: StackDecision): string {
  const label = STACK_KIND_LABEL[decision.kind]
  if (decision.ruleId === null) return `兜底（没有任何${label}匹配）`
  const note = decision.note !== null && decision.note !== '' ? `「${decision.note}」` : ''
  const broken = decision.source === 'rule_invalid' ? '（这条规则的 effect 是脏数据，判定落到了本栈的安全侧）' : ''
  return `${label} #${decision.ruleId}${note}${broken}`
}

function changeSummary(
  kind: StackKind,
  subject: PreviewSubject,
  before: StackDecision,
  after: StackDecision,
  aspect: ImpactAspect,
): string {
  const who = subject.facts.title !== '' ? `「${subject.facts.title}」` : `会议 ${subject.key}`
  const from = describeStackEffect(kind, before.effect, before.assetTypes)
  const to = describeStackEffect(kind, after.effect, after.assetTypes)
  const by = `原先由${describeDecider(before)}决定，改动后由${describeDecider(after)}决定`
  if (aspect === 'decider') return `${who}的判定没变（${to}），但${by}`
  return `${who}从「${from}」变为「${to}」：${by}`
}

/** 方向在各栈里的说法。同一件事在三栈里是三句不同的话 */
const DIRECTION_LABEL: Record<StackKind, Record<Exclude<ImpactDirection, 'unchanged'>, string>> = {
  fetch: { opened: '新增拉取', tightened: '停止拉取', moved: '换目标', mixed: '拉取的资产类型有增有减' },
  archive: { opened: '开始归档', tightened: '不再归档', moved: '换归档目录', mixed: '资产类型有增有减' },
  allow: { opened: '新放行', tightened: '新收紧', moved: '换目标', mixed: '放行的资产类型有增有减' },
}

function previewSummary(kind: StackKind, counts: ImpactCounts): string {
  const label = STACK_KIND_LABEL[kind]
  if (counts.scanned === 0) {
    return `这次${label}改动没有够得着任何会议（共 ${counts.total} 场），不会有任何判定改变。`
  }

  const parts: string[] = []
  const dirs = DIRECTION_LABEL[kind]
  if (counts.opened > 0) parts.push(`${counts.opened} 场${dirs.opened}`)
  if (counts.tightened > 0) parts.push(`${counts.tightened} 场${dirs.tightened}`)
  if (counts.moved > 0) parts.push(`${counts.moved} 场${dirs.moved}`)
  if (counts.mixed > 0) parts.push(`${counts.mixed} 场${dirs.mixed}`)

  const head = `这次${label}改动够得着 ${counts.scanned} 场会议（命中 ${counts.hits} 场，共 ${counts.total} 场）`
  const body =
    parts.length > 0
      ? `，其中${parts.join('、')}`
      : '，没有任何会议的判定会改变'
  const tail: string[] = []
  if (counts.deciderOnly > 0) tail.push(`另有 ${counts.deciderOnly} 场判定不变、只是换了规则说了算`)
  if (counts.shielded > 0) tail.push(`${counts.shielded} 场被人工改写挡住（改写优先于所有规则）`)
  if (counts.invalid > 0) tail.push(`其中 ${counts.invalid} 场是被写坏的规则决定的，先去修规则`)
  return `${head}${body}${tail.length > 0 ? `；${tail.join('；')}` : ''}。`
}

// ── 主函数 ────────────────────────────────────────────────────

function toPredicate(
  overridden: StackImpactOptions['overridden'],
): (subject: PreviewSubject) => boolean {
  if (overridden === undefined) return () => false
  if (typeof overridden === 'function') return overridden
  return (subject) => overridden.has(subject.key)
}

/**
 * 算一栈的影响预览。**纯函数**：不查库、不读时钟、不改入参。
 *
 * 只在 `命中(旧) ∪ 命中(新)` 上算（见文件头），所以传 5000 场会议进来
 * 也只会对够得着的那几场跑两次整栈求值。
 */
export function previewStackImpact(options: StackImpactOptions): StackImpactPreview {
  const { kind, oldRules, newRules, subjects, now } = options
  const isOverridden = toPredicate(options.overridden)

  // 1. 这次改动动了哪几条**本栈**的规则。别的栈的改动够不着本栈的判定
  const touched = diffRules(oldRules, newRules).filter((change) =>
    [...change.before, ...change.after].some((rule) => rule.kind === kind),
  )

  const changed: ImpactChange[] = []
  const deciderOnly: ImpactChange[] = []
  const shielded: ImpactChange[] = []
  const counts: ImpactCounts = {
    total: subjects.length,
    scanned: 0,
    hits: 0,
    opened: 0,
    tightened: 0,
    moved: 0,
    mixed: 0,
    deciderOnly: 0,
    shielded: 0,
    invalid: 0,
  }

  for (const subject of subjects) {
    // 2. 范围：被改动的规则里，新旧任一版命中这场会议就算够得着
    const hitAfter = touched.some((change) => hitBy(change.after, subject, now))
    const hitBefore = touched.some((change) => hitBy(change.before, subject, now))
    if (hitAfter) counts.hits += 1
    if (!hitAfter && !hitBefore) continue
    counts.scanned += 1

    // 3. 只在范围内跑两次整栈求值做对比
    const before = decide(kind, oldRules, subject, now)
    const after = decide(kind, newRules, subject, now)
    const diff = diffDecisions(kind, before, after)
    if (diff === null) continue

    const change: ImpactChange = {
      key: subject.key,
      kind,
      aspect: diff.aspect,
      direction: diff.direction,
      before,
      after,
      invalidRule: before.source === 'rule_invalid' || after.source === 'rule_invalid',
      overridden: isOverridden(subject),
      summary: changeSummary(kind, subject, before, after, diff.aspect),
    }

    // 4. 人工改写优先于所有规则：这场会议的实际结果不会变，不能算进「会被改变」
    if (change.overridden) {
      shielded.push(change)
      counts.shielded += 1
      continue
    }
    if (diff.aspect === 'decider') {
      deciderOnly.push(change)
      counts.deciderOnly += 1
      continue
    }
    changed.push(change)
    if (change.invalidRule) counts.invalid += 1
    if (diff.direction === 'opened') counts.opened += 1
    else if (diff.direction === 'tightened') counts.tightened += 1
    else if (diff.direction === 'moved') counts.moved += 1
    else if (diff.direction === 'mixed') counts.mixed += 1
  }

  return {
    kind,
    counts,
    changed,
    deciderOnly,
    shielded,
    changedRuleIds: touched.map((change) => change.id),
    summary: previewSummary(kind, counts),
  }
}
