/**
 * 人工改写覆盖层（阶段 3 · T7）。
 *
 * spec §5.4 只有一句话，但它是阶段 3 里语义最强的一条：
 *
 * > **单场会议的人工改写优先于所有规则。** 改写过的会议在列表里有标记，
 * > 且规则的影响预览要把它们排除在「会被改变」之外。
 *
 * ## 一、为什么改写要在引擎之外
 *
 * 计划 §3.5：`evaluateFetchStack` / `evaluateArchiveStack` / `evaluateAllowStack`
 * **一个字都不改**，它们继续只认规则；改写是套在它们**外面**的一层。
 *
 * 理由不是洁癖：规则求值是纯函数、可预览、可回放，`preview.ts`（T5）靠的就是
 * 「同一批规则 + 同一批会议 + 同一个 now ⇒ 同一个结果」。把「某场会议的人工决定」
 * 混进去，影响预览就再也算不准了——它算的是**规则改了会怎样**，而被改写的会议
 * 根本不受规则支配。混进引擎的那一刻，预览面板上的每个数字都掺了假。
 *
 * 所以这一层只做一件事：拿规则栈算出来的 `StackDecision`，套上这场会议的人工决定，
 * 产出 `OverriddenDecision`。规则那一份判定不丢，挂在 `overriddenFrom` 上。
 *
 * ## 二、被改写掉的那个判定必须留着（D-n）
 *
 * spec §1.3 要求界面**随时能回答「为什么这场会议这个程序取不到」**。被改写的会议
 * 若只剩一个结论，管理员就看不到「规则本来会放行、是人工关掉的」这件事，
 * 而这恰恰是他最需要知道的。`trace` 照抄规则侧那份——规则确实被逐条考察过，
 * 那段记录是真的，只是最后没轮到它说话。
 *
 * ## 三、脏数据一律落到本栈安全侧，并且说出来
 *
 * 改写的 effect 来自管理员在界面上填的自由文本，比 `policy_rules.effect`
 * **更容易脏**。规则那边有 `rule_invalid`（计划 §3.4.1 D-d），改写这边就有
 * `override_invalid`（D-m）——少这一个取值，「管理员填错了」和「管理员就是这么定的」
 * 会在详情抽屉里混成同一件事。
 *
 * effect 与资产名的规范化**一律复用 `stacks.ts` 的那两个函数**（D-p）。
 * 计划 §3.4 D-c 记着：同一批资产在这个项目里已经有过三套叫法，M3.5 为此吃过一次亏。
 * 两份规范化逻辑迟早会漂移，漂移的后果是某一类资产在规则路径和改写路径下待遇不同。
 *
 * ## 四、不 import store 层
 *
 * 改写的输入形状在这里自己定义，不从 `src/store/` 拿——policy 层不依赖 store 层，
 * 这是本仓库既有的分层（`stacks.ts` 的 `StackRule` 同样是自己定义的）。
 * 库里怎么存是 T6 的事，这一层只关心「一条改写长什么样」。
 */

import {
  describeStackEffect,
  normalizeAssetTypes,
  normalizeEffect,
  STACK_KIND_LABEL,
  type AllowDecision,
  type AllowEffect,
  type ArchiveDecision,
  type ArchiveEffect,
  type AssetNorm,
  type DecisionSource,
  type EffectNorm,
  type FetchDecision,
  type FetchEffect,
  type StackDecision,
  type StackKind,
} from './stacks'
import type { PreviewSubject } from './preview'

// ── 输入形状 ──────────────────────────────────────────────────

/** 一场会议。改写是按「会议 × 栈」记的，会议本身由这两个 id 唯一确定 */
export interface OverrideTarget {
  meetingId: string
  subMeetingId: string
}

/**
 * 一条人工改写。对应 `meeting_overrides` 的行（计划 §2.3 + T6 追加的 `reason` 列），
 * 由调用方从库里组装——改写从哪来是 store 的事，这里只管把它套在判定上。
 *
 * **`effect` 与 `assetTypes` 一概不可信**：它们是管理员在界面上填的，
 * 进到这里之前没有任何一层做过取值域校验。
 */
export interface MeetingOverride extends OverrideTarget {
  /** 改哪一栈。与被套的判定对不上时不予采信，见 `applyOverride` */
  kind: StackKind
  /** 自由文本，落到本栈安全侧的可能性比规则的 effect 更大 */
  effect: string
  /**
   * 三态，与 `meeting_grants.asset_types` 一致（D-o）：
   * `null` = 不另行指定，沿用被改写掉的那个判定的范围；
   * 非空数组 = 白名单；`[]` = 一类都不放行。
   */
  assetTypes: string[] | null
  /** 管理员写的改写说明。会进判定理由与详情抽屉（spec §1.3） */
  reason: string | null
  /** unix 秒。同一栈上有多条改写时用它挑最新的那条 */
  createdAt?: number
  /** 谁改的。有就写进判定理由 */
  createdBy?: string | null
}

/** 一场会议的改写集合，按栈索引。三栈各自最多一条 */
export type MeetingOverrideSet = Partial<Record<StackKind, MeetingOverride | null>>

// ── 输出形状 ──────────────────────────────────────────────────

/**
 * 套过改写的判定。**`StackDecision` 本身不动**，只加一个字段：
 * 若无人工改写，规则栈本会判成什么（D-n）。没有改写时为 null。
 */
export interface OverriddenDecision<E extends string = string> extends StackDecision<E> {
  /** 若无人工改写，规则栈本会判成什么。没有改写时为 null */
  overriddenFrom: StackDecision<E> | null
}

/** `evaluateStacks` 的返回形状，原样接进来 */
export interface StackDecisionSet {
  fetch: FetchDecision
  archive: ArchiveDecision
  allow: AllowDecision
}

export interface OverriddenDecisionSet {
  fetch: OverriddenDecision<FetchEffect>
  archive: OverriddenDecision<ArchiveEffect>
  allow: OverriddenDecision<AllowEffect>
}

// ── 安全侧 ────────────────────────────────────────────────────

/**
 * 本栈的安全侧（fetch / archive → 不拉取、不归档；allow → 禁止采集）。
 *
 * **不另抄一份 `FALLBACK` 表**：拿一个必定非法的 effect 让 `normalizeEffect`
 * 自己说出安全侧。抄一份表就等于把「allow 栈的安全侧是 deny」这条规矩写了两遍，
 * 哪天改了一处，另一处就是一次静默放行。`tests/policy/override.test.ts`
 * 里有一条用例逐栈钉死这三个值。
 */
function safeSide(kind: StackKind): string {
  return normalizeEffect(kind, null).effect
}

/**
 * 这个 effect 是不是「本栈的肯定侧」——只有肯定侧才带出资产类型。
 *
 * **只对已经过 `normalizeEffect` 的 effect 成立**：那之后 fetch 只剩 all/skip、
 * allow 只剩 allow/deny，archive 只剩 skip 或一段非空模板，于是「不是安全侧」
 * 与 `stacks.ts` 里那个私有的 `isPositive` 逐栈等价。这样写是为了不把
 * 「哪一侧是肯定侧」在第二个文件里再判一遍。
 */
function isPositive(kind: StackKind, normalizedEffect: string): boolean {
  return normalizedEffect !== safeSide(kind)
}

/** 栈的中文名。kind 是脏数据时不假装认识它 */
function kindLabel(kind: StackKind): string {
  return STACK_KIND_LABEL[kind] ?? `未知的栈「${String(kind)}」`
}

// ── 套一次改写 ────────────────────────────────────────────────

/**
 * 改写的 effect 收敛到**被套的那一栈**的取值域。
 *
 * kind 对不上时**不采信它的 effect**：一条 fetch 改写（`effect: 'all'`）套到归档栈上，
 * `'all'` 恰好是个非空字符串，会被当成一个叫 all 的目录模板，把会议归到别处去。
 * 这种情况下既不能照做（那是凭空发明一条没人做过的决定），也不能当没看见
 * （那是把一条真的人工决定静默丢掉），所以落到本栈安全侧并说明——
 * 与 D-d 对写坏规则的处理是同一条规矩：**说了算，但它说不清楚。**
 */
function normalizeOverrideEffect(kind: StackKind, override: MeetingOverride): EffectNorm {
  if (override.kind !== kind) {
    const safe = safeSide(kind)
    return {
      effect: safe,
      issue:
        `这条人工改写记的是${kindLabel(override.kind)}，却被套在${kindLabel(kind)}的判定上，` +
        `无从当作本栈的决定，按本栈的安全侧「${describeStackEffect(kind, safe, [])}」处理`,
    }
  }
  return normalizeEffect(kind, override.effect)
}

/**
 * 改写实际生效的资产范围（D-o）。三态与 `meeting_grants.asset_types` 一致。
 *
 * **`null` 沿用被改写掉的那个判定的范围，不是「全部八类」。** 把 null 读成全部，
 * 一次没填完的改写就会把规则原本限定的范围悄悄放宽——那正是全局约束
 * 「不许静默放行」要防的事故。代价是：规则侧本来判 deny/skip（`assetTypes` 恒为空）时，
 * 「改写成放行但没指定范围」的结果是**放行了，但一类都取不到**。
 * 这是故意的安全侧，但它会让管理员困惑，所以必须在 `issues` 里说成人话。
 */
function overrideAssets(
  kind: StackKind,
  effect: string,
  override: MeetingOverride,
  from: StackDecision,
): AssetNorm {
  // archive 栈不用 asset_types；否定侧一类都不带——不拉就是一类都不拉，不放行就是一类都取不到
  if (kind === 'archive' || !isPositive(kind, effect)) return { keys: [], issues: [] }

  if (override.assetTypes === null || override.assetTypes === undefined) {
    const keys = [...from.assetTypes]
    if (keys.length > 0) return { keys, issues: [] }
    return {
      keys,
      issues: [
        '这次人工改写没有指定资产范围（asset_types 为 null，按「沿用规则侧的范围」处理），' +
          '而规则侧一类资产都没有，所以改写虽然放开了这一栈，实际仍一类都取不到——' +
          '要放开哪几类，必须在改写里明确列出',
      ],
    }
  }

  const assets = normalizeAssetTypes(override.assetTypes)
  if (assets.keys.length > 0) return assets
  return {
    keys: assets.keys,
    issues: [
      ...assets.issues,
      '这次人工改写放开了这一栈，却没有列出任何合法的资产类型，实际上一类都取不到',
    ],
  }
}

/**
 * 给一个判定套上人工改写。`override` 为 null / undefined（这场会议没被改写过）时，
 * 原样回落到规则判定，只多一个 `overriddenFrom: null`。
 *
 * 纯函数：不改动传进来的判定，也不读时钟。
 */
export function applyOverride<E extends string = string>(
  decision: StackDecision<E>,
  override?: MeetingOverride | null,
): OverriddenDecision<E> {
  if (override === null || override === undefined) return { ...decision, overriddenFrom: null }

  const kind = decision.kind
  const { effect, issue } = normalizeOverrideEffect(kind, override)
  const assets = overrideAssets(kind, effect, override, decision)
  const issues = issue === null ? assets.issues : [issue, ...assets.issues]

  const who =
    override.createdBy !== null && override.createdBy !== undefined && override.createdBy !== ''
      ? `人工改写（${override.createdBy}）`
      : '人工改写'
  const head =
    issue === null
      ? `${who}决定：${describeStackEffect(kind, effect, assets.keys)}`
      : `${who}的${issue}`
  const why = override.reason !== null && override.reason !== '' ? `，改写理由：${override.reason}` : ''
  // 「本来会判什么」必须留在这句话里：spec §1.3 要界面随时答得出「为什么取不到」，
  // 而「规则本来会放行、是人工关掉的」正是管理员最需要知道的那半句
  const wouldBe = `若无这次改写，${kindLabel(kind)}会判：${describeStackEffect(kind, decision.effect, decision.assetTypes)}`

  const source: DecisionSource = issue === null ? 'override' : 'override_invalid'
  return {
    kind,
    // effect 已由 normalizeOverrideEffect 收敛到本栈取值域，这里的断言是它的结论
    effect: effect as E,
    // D-q：改写没有规则。它有的是管理员写的 reason，语义与 note 一致——
    // 「决定这次判定的那个东西身上的人写的说明」
    ruleId: null,
    note: override.reason ?? null,
    source,
    reason: `${head}${why}；${wouldBe}`,
    assetTypes: assets.keys,
    issues,
    // 规则确实被逐条考察过，那段考察记录是真的，只是最后没轮到它说话（D-n）
    trace: decision.trace,
    overriddenFrom: decision,
  }
}

/**
 * 给 `evaluateStacks` 的三个判定一起套上这场会议的改写集合。
 *
 * 三栈**互不干扰**：改写了 allow 的那场会议，fetch 与 archive 照规则判。
 * 改写是按「会议 × 栈」记的，一条 allow 改写不该顺手把这场会议的归档也关掉。
 */
export function applyOverrides(
  decisions: StackDecisionSet,
  overrides?: MeetingOverrideSet | null,
): OverriddenDecisionSet {
  return {
    fetch: applyOverride(decisions.fetch, overrides?.fetch),
    archive: applyOverride(decisions.archive, overrides?.archive),
    allow: applyOverride(decisions.allow, overrides?.allow),
  }
}

/**
 * 这次判定是不是人工改写决定的。**会议列表的改写标记（spec §5.4）用它**，
 * 不要在调用方写 `source === 'override'`——那会漏掉 `override_invalid`，
 * 于是一条填错了的改写在列表里看不出被改写过，正好是最该看见的那种。
 */
export function wasOverridden(decision: { source: DecisionSource }): boolean {
  return decision.source === 'override' || decision.source === 'override_invalid'
}

// ── 索引与预览钩子 ─────────────────────────────────────────────

/**
 * 一场会议的若干条改写行按栈归位。
 *
 * 同一栈上有多条时取 `createdAt` 最新的那条（持平取后来的，库里按 id 升序读出来
 * 就是后建的那条）——库里本该有唯一键管住，但读出来的顺序不该决定谁说了算。
 *
 * **kind 不是三栈之一的行会被丢掉**：无从判断管理员想改哪一栈，套到任何一栈上
 * 都是凭空发明一条决定。这种行不该存在，拦住它是 T6 写入侧的事
 * （`meeting_overrides.kind` 要有取值域约束），这里拦不了也报不出来。
 */
export function indexOverrides(overrides: Iterable<MeetingOverride>): MeetingOverrideSet {
  const set: MeetingOverrideSet = {}
  for (const override of overrides) {
    const kind = override.kind
    if (kind !== 'fetch' && kind !== 'archive' && kind !== 'allow') continue
    const current = set[kind]
    if (current === undefined || current === null) {
      set[kind] = override
      continue
    }
    if ((override.createdAt ?? 0) >= (current.createdAt ?? 0)) set[kind] = override
  }
  return set
}

/**
 * 两个 id 拼成一场会议的键。用 NUL 分隔而不是 `/`：会议 id 是外部系统给的，
 * 拿分隔符去赌它不出现在 id 里，撞上一次就是两场会议共用一条改写。
 */
const TARGET_SEP = '\u0000'

function targetKey(target: OverrideTarget): string {
  return `${target.meetingId}${TARGET_SEP}${target.subMeetingId}`
}

/**
 * 把改写集合变成 `StackImpactOptions.overridden` 那个钩子——T5 的影响预览
 * 已经留好了 `shielded` 这条路（spec §5.5：改写过的会议要排除在「会被改变」之外），
 * 这里负责让它能被真正填上。
 *
 * **返回的是判定函数而不是 `Set<string>`**，因为这是一对多：allow 栈的考察对象是
 * 「会议 × 采集程序」，同一场会议对 A 程序、B 程序是两条判定，而改写记在会议上——
 * 一条改写要挡住这场会议的**所有**程序。用 subject key 的集合就得让调用方先把
 * 程序枚举一遍，漏一个就有一条判定假装没被改写过。
 *
 * `targetOf` 由调用方给：`PreviewSubject.key` 是调用方自己的标识，
 * 只有它知道那把钥匙对应哪场会议。返回 null 表示这个考察对象不对应任何会议。
 */
export function overriddenPreviewFilter(
  overrides: Iterable<MeetingOverride>,
  kind: StackKind,
  targetOf: (subject: PreviewSubject) => OverrideTarget | null,
): (subject: PreviewSubject) => boolean {
  // 别的栈的改写挡不住本栈：改 fetch 的那条改写不该让采集权限的预览少报一场
  const keys = new Set<string>()
  for (const override of overrides) {
    if (override.kind === kind) keys.add(targetKey(override))
  }
  return (subject) => {
    const target = targetOf(subject)
    if (target === null || target === undefined) return false
    return keys.has(targetKey(target))
  }
}
