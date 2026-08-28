/**
 * 三栈的分组、屏幕顺序，以及两句**说得准**的结构性提示。
 *
 * ## 这个文件不求值
 *
 * spec §5.1 那一节（「这一节需要逐字实现，不能凭直觉」）的实现在
 * `src/policy/stacks.ts`，**只有那一份**。这里做的是它的第 2 步——排序——
 * 而且只用于**屏幕上的先后**：让管理员读得出"这条排第几、第一条命中的是谁"。
 * 一场会议到底会不会被放行，屏幕上的顺序一个字都决定不了，那个答案只从
 * `POST /rules/preview` 与会议行自己带的 `why` 来。
 *
 * 排序照抄后端的 `compareRules`：**priority 降序、同 priority 按 id 升序**。
 * 平局不按 effect 决定——「deny 优先」是另一套（合并式）语义，与「第一条说了算」
 * 互斥，混用会让规则列表的顺序不再是判定顺序，管理员就读不出结果了（spec §5.1）。
 *
 * ## 「会不会被上面那条挡住」只说得准一种
 *
 * 严格讲，一条规则会不会被上面那条顶掉，要拿真实会议跑一遍才知道——那是后端的活。
 * 前端**只在一种情况下敢说**：上面有一条启用的、**无条件**（conds 为空 = 匹配一切）
 * 的规则。那时下面每一条都够不着，与会议数据无关，纯结构可判。
 *
 * 其余情况一律不说。说一句"可能被挡住"看起来体贴，实际是在教管理员不相信这一栏。
 */

import type { Rule, RulesSchema, StackKind } from '../../api/admin/rules'
import { effectOf, fieldOf, stackOf } from './fields'

export interface StackMeta {
  /** 逐字对应 spec §4.6 的组名。 */
  name: string
  /** 序号。spec §4.6 的三组是"一、二、三"，顺序本身是内容的一部分。 */
  index: string
  /** 这一组决定什么。 */
  decides: string
  /** 兜底的 effect 取值。**不上屏**——它是库里那一列的取值，不是给人读的词。 */
  fallback: string
  /** 兜底读给管理员看的一句话。 */
  fallbackText: string
  /**
   * 组下面那一句。**只写「不做这件事会怎样」**——「这一组决定什么」由 `decides`
   * 那颗徽标说，「一条都不匹配会怎样」由 `fallbackText` 说，再复述一遍就是
   * 用段落重讲界面已经讲过的话。
   */
  lede: string
}

/**
 * 三栈的元信息。措辞取 spec §4.6 与原型的 `KINDS`。
 *
 * 第三组的兜底是 deny、前两组是 skip，spec 给的理由必须一起显示：
 * **因为第三组是数据出境闸门，默认必须是关的。**
 */
export const STACK_META: Record<StackKind, StackMeta> = {
  fetch: {
    name: '拉取规则',
    index: '一',
    decides: '决定去腾讯会议拉哪些会议、拉哪几类资产',
    fallback: 'skip',
    fallbackText: '一条都不匹配时不拉取',
    lede: '不拉取的会议，录制仍留在腾讯会议侧。',
  },
  archive: {
    name: '归档规则',
    index: '二',
    decides: '决定往 NAS 的哪个目录归档',
    fallback: 'skip',
    fallbackText: '一条都不匹配时不归档',
    lede: '没有归档成功的会议，本地文件到期后就彻底没有了。',
  },
  allow: {
    name: '采集权限规则',
    index: '三',
    decides: '决定哪些会议准许被外部程序取走',
    fallback: 'deny',
    fallbackText: '一条都不匹配时拒绝，默认全部拒绝',
    lede: '数据离开企业边界的唯一闸门。',
  },
}

/** 排序时脏 priority 排到最后：一条写坏的规则不该抢在正常规则前面。 */
function priorityOf(r: Rule): number {
  return Number.isFinite(r.priority) ? r.priority : Number.NEGATIVE_INFINITY
}

/**
 * 屏幕顺序 = 判定顺序（spec §5.1 第 2 步）。**不改动入参**。
 *
 * 停用的规则留在它启用时会站的那一格——沉底的话，管理员就看不出"把它开回来
 * 会插在哪两条之间"，而那正是决定要不要开回来时唯一有用的信息。
 */
export function sortForDisplay(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => {
    const pa = priorityOf(a)
    const pb = priorityOf(b)
    // 全程用比较而不是相减：Infinity - Infinity 是 NaN，那会让排序重新变得不确定
    if (pa !== pb) return pa > pb ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
}

export interface StackGroups {
  fetch: Rule[]
  archive: Rule[]
  allow: Rule[]
  /** kind 认不出的规则。**不许悄悄丢掉**——它在库里是真的，界面上就得有。 */
  unknown: Rule[]
}

/** 按栈分组，每组内部已按判定顺序排好。 */
export function groupByStack(rules: readonly Rule[]): StackGroups {
  const out: StackGroups = { fetch: [], archive: [], allow: [], unknown: [] }
  for (const r of rules) {
    if (r.kind === 'fetch' || r.kind === 'archive' || r.kind === 'allow') out[r.kind].push(r)
    else out.unknown.push(r)
  }
  return {
    fetch: sortForDisplay(out.fetch),
    archive: sortForDisplay(out.archive),
    allow: sortForDisplay(out.allow),
    unknown: sortForDisplay(out.unknown),
  }
}

/** 这条规则是不是"匹配一切"。conds 列本身写坏时说不准，返回 false。 */
function isUnconditional(r: Rule): boolean {
  return !r.condsMalformed && r.conds.length === 0
}

/**
 * 每条规则被哪一条**无条件**规则挡住（值是那条规则的 id）。见文件头第三节：
 * 这是前端唯一说得准的一种"够不着"。
 *
 * 入参必须是 `sortForDisplay` 排过的同一栈的规则。
 */
export function blockedByUnconditional(sorted: readonly Rule[]): Map<number, number> {
  const out = new Map<number, number>()
  let blocker: number | null = null
  for (const r of sorted) {
    if (blocker !== null) out.set(r.id, blocker)
    // 停用的规则不参与求值，挡不住任何人
    else if (r.enabled && isUnconditional(r)) blocker = r.id
  }
  return out
}

/**
 * 这条规则**永远不会命中**，因为它每一个条件用的字段当前都没有数据源。
 *
 * spec §5.3 明写：「一条只有 `dept` 条件的规则永远不会命中，规则列表要给出
 * 可见提示。」`join` 是 and 还是 or 都一样——`or` 也要至少有一个条件成立，
 * 而没有数据源的条件一个都成立不了。
 *
 * **掺了一个有数据源的字段就不下断言**：`or` 连的时候另一半可能成立，
 * `and` 连的时候仍然是"永不命中"，但那已经是求值的事，交给后端的 issues 说。
 * 有 `null` 条件（写坏了）时同样不下断言——写坏的那条命中什么谁也不知道。
 *
 * 判据读的是 `GET /rules/schema` 下发的 `available`（阶段 5 · F9 之前这里读的
 * 是一份抄来的镜像清单）。**清单读不出来时一句都不说**：这时"这个字段有没有
 * 数据源"根本无从判断，而这条提示的分量是"这条规则是死的"。
 */
export function neverMatchesForLackOfDataSource(
  schema: RulesSchema | null,
  rule: Rule,
): boolean {
  if (schema === null) return false
  if (rule.condsMalformed || rule.conds.length === 0) return false
  return rule.conds.every((c) => {
    if (c === null) return false
    const field = fieldOf(schema, c.f)
    return field !== null && !field.available
  })
}

/* ── 命中数：口径由后端定，前端只读不算 ───────────────────────── */

/**
 * `GET /api/v1/admin/rules` 每条规则自带的两个数（后端契约）：
 *
 * - `matchCount`   这条规则**自身条件**命中的场次
 * - `matchScanned` 这次统计考察了多少场会议（口径可回溯）
 *
 * 口径与 `GET /api/v1/admin/rules/:id/matches` **完全一致**（后端的 `matchesRule`，
 * 即这条规则的 conds 匹配，**不是整栈求值的结果**）。停用的规则也照样有数——
 * 管理员要先看得见「把它开回来会命中什么」。
 *
 * ## 读不到就说读不到，不许前端自己算
 *
 * 字段缺席（旧后端 / 契约不对）、类型不对、后端那次统计取不到会议全集——三种都是
 * **读不出来**，`api/admin/rules.ts` 的宽读把它们统一读成 `null`，屏幕上显示 `—`。
 *
 * - **不兜成 0**：0 是一个具体的答案，管理员会照着它去删一条其实好好的规则。
 * - **不前端自己数一遍**：那就是第二份真相，而两份不一致的地方恰好是判定边界
 *   （`api/admin/rules.ts` 文件头第一节把这条写死了）。
 */

export interface RuleMatchStats {
  /** 命中场次。**null = 读不出来**，不是 0。 */
  count: number | null
  /** 这次统计考察了多少场会议。null = 读不出来。 */
  scanned: number | null
}

/** NaN / Infinity 也算读不出来：它们上屏就是一个不是数的「数」。 */
function finiteOrNull(v: number | null): number | null {
  return v !== null && Number.isFinite(v) ? v : null
}

export function matchStatsOf(rule: Rule): RuleMatchStats {
  return { count: finiteOrNull(rule.matchCount), scanned: finiteOrNull(rule.matchScanned) }
}

/**
 * 一栈的统计范围（给栈头那句「命中按最近 N 场统计」用）。
 *
 * 同一次响应里每条规则的 `matchScanned` 是同一次扫描的结果，所以取第一条说得出来的
 * 就够。一条都说不出来时返回 null，那句话整句不出现——**宁可不说，不编一个数**。
 */
export function scannedOf(rules: readonly Rule[]): number | null {
  for (const r of rules) {
    const s = matchStatsOf(r).scanned
    if (s !== null) return s
  }
  return null
}

/* ── 坏规则的挂号 ─────────────────────────────────────────────── */

/**
 * 一行挂哪一档。**三类坏规则，危险方向不一样**——这一点在界面上曾经是糊的。
 *
 * | 挂号 | 库里长什么样 | 引擎怎么判（`src/policy/conds.ts` 的 `evaluateRule`） | 后果 |
 * | --- | --- | --- | --- |
 * | `unreadable`    | `conds` 列不是数组 / 某一项不是 `{ f, op, v }` | `matched: false`（**不当成空 conds**） | 一场都命中不了，等于没建 |
 * | `unconditional` | `conds` 是空数组 `[]` | `matched: true`「规则没有条件，匹配全部会议」 | 命中全部 |
 * | `ineffective`   | 条件用的字段没有数据源 / 被上面那条挡住 / 后端 issues | —— | 这条是死的 |
 *
 * 前两类看起来像同一件事（"条件不对"），实际正好相反：一条什么都不做，一条什么都放过。
 * `src/store/policy.ts` 的 `CONDS_UNPARSABLE` 注释把这条写死了——「不能当成
 * 『空 conds → 匹配一切』，那等于让一条坏掉的规则放行全部会议」。
 *
 * 所以 `unreadable` 那一行的命中数会是 **0**，而那个 0 **不是「条件写窄了」**；
 * `unconditional` 那一行的命中数是全部。两者在屏幕上必须分得开，否则管理员看见 0
 * 会去调宽条件，看见"全部"会以为规则很有效。
 */
export type RuleFlag = 'unreadable' | 'unconditional' | 'ineffective'

/** 色条与行底色的档。挂号有三类，档只有两级——同一类挂号的档可以随栈变（见下）。 */
export type RuleTone = 'fail' | 'warn'

export interface RuleMark {
  /** 挂哪一号。null = 这一行没有要人处理的事。 */
  flag: RuleFlag | null
  /** 色条与行底色。`flag` 为 null 时同为 null。 */
  tone: RuleTone | null
  /** 挂在这一行下面的说明句子，按严重程度排。 */
  reasons: string[]
}

/** 条件读不出来。写坏的条件项占着位（见 `api/admin/rules.ts` 第二节），所以数得出来。 */
function condsUnreadable(rule: Rule): boolean {
  return rule.condsMalformed || rule.conds.some((c) => c === null)
}

/** 无条件 = `conds` 是**空数组**（不是"读不出来"，那是另一号）。 */
function isEmptyConds(rule: Rule): boolean {
  return !rule.condsMalformed && rule.conds.length === 0
}

/**
 * 空 conds 那句话。**取后端写侧 `validateDraft` 的原话**
 *（`src/store/policy.ts`：「conds 是空数组：空条件在求值器里是「匹配一切」，
 * 这等于一条覆盖全部会议的兜底规则。要写全放行/全拉取的兜底规则，请显式写一个
 * 恒真的条件，不能靠「什么都不填」」）。
 *
 * 前端不另发明一套说法：`api/admin/rules.ts` 文件头写死了两处说的必须是同一件事，
 * 而这一条正是管理员照着去改规则的那句话——控制台从今往后建不出空 conds 的规则，
 * 库里还有的那些是历史数据或别的写入者留下的。
 */
const EMPTY_CONDS_TEXT =
  '空条件在求值器里是「匹配一切」，这等于一条覆盖全部会议的兜底规则。' +
  '要写兜底规则，请显式写一个恒真的条件，不能靠「什么都不填」。'

/**
 * 无条件规则挂哪一档——**问题在任何栈都成立，严重度分栈**。
 *
 * - `allow` 栈 + 正面判定（准许）→ `fail`。这是数据无条件出境，而采集权限栈是唯一的闸门。
 * - `allow` 栈 + 反面判定（拒绝）→ **不挂**。无条件拒绝落在安全侧。它仍然会把同栈里
 *   优先级低于它的规则全挡住，但那件事由那几行自己的「够不着」说（`blockedByUnconditional`），
 *   记在挡路的这一行上等于把同一件事说两遍。
 * - `fetch` / `archive` → `warn`。意图（兜底）是对的，写法不对；而且它会把同栈里
 *   优先级低于它的规则全部挡住，那些永远轮不到。
 * - **`allow` 栈但 effect 的正反判不出来**（`/rules/schema` 读不出来、或 effect 不在取值域里）
 *   → **`fail`**，句子说清楚是**判不出来**、按最坏情况处理。全局约束是「不许静默放行」，
 *   判不出来要落到本栈的安全侧；采集权限栈的安全侧是**假定它在放行**。降成 `warn`
 *   等于在唯一的数据出境闸门上，把最危险的一种情况按第二档处理——猜错的两个方向
 *   代价差着数量级。注意句子不能写成好像已经确认在放行了，那是另一种谎。
 *
 * 正反用的是后端下发的 `withAssetTypes`（= 后端的 `isPositive`），不是前端认 `'allow'`
 * 这个字符串——认字符串就是把取值域又抄了一份。
 */
function unconditionalMark(schema: RulesSchema | null, rule: Rule): { tone: RuleTone; text: string } | null {
  if (rule.kind !== 'allow') {
    return { tone: 'warn', text: `${EMPTY_CONDS_TEXT}而且同栈里优先级低于它的规则永远轮不到。` }
  }
  const eff = effectOf(stackOf(schema, rule.kind), rule.effect)
  if (eff === null) {
    return {
      tone: 'fail',
      text:
        `${EMPTY_CONDS_TEXT}而且判不出它是准许还是拒绝` +
        '（字段清单读不出来，或这个动作不在取值域里）——采集权限栈按最坏情况处理。',
    }
  }
  if (!eff.withAssetTypes) return null
  return {
    tone: 'fail',
    text: `${EMPTY_CONDS_TEXT}而这一栈是数据离开企业边界的唯一闸门——它现在对这个采集程序无条件放行。`,
  }
}

/**
 * 这一行挂哪一号、哪一档，下面写什么。
 *
 * ## 判定只看 `conds` 本身，不看 `issues` 里有没有那句话
 *
 * 后端读侧（`describeStackRuleIssues`）与写侧（`validateDraft`）不是同一份检查，
 * 读侧不报空 conds 的时候，靠 `issues` 判就会整条漏掉。
 *
 * ## 说的是**后果**，不重复行内那句话
 *
 * 「conds 不是数组」「这个条件写坏了」「所有会议（无条件）」这几件事，
 * `describeCondition` 已经逐字写在这一行的句子里了。下面这几行写的是行内说不出来的
 * 那一半：**于是会发生什么**——一场都命中不了 / 覆盖全部会议 / 这条是死的。
 *
 * 「一场都命中不了」与「匹配一切」逐字对齐 `evaluateRule` 的两个分支，不是从形状上猜的。
 *
 * ## 停用的规则不挂前两号
 *
 * 停用的无条件规则现在一场都不命中，说它"正在覆盖全部会议"是无中生有；它的条件那一格
 * 照旧写着「所有会议（无条件）」，要开回来的人看得见。
 */
export function ruleMark(
  schema: RulesSchema | null,
  rule: Rule,
  blockedBy: number | null,
): RuleMark {
  const reasons: string[] = []
  let flag: RuleFlag | null = null
  let tone: RuleTone | null = null

  if (condsUnreadable(rule)) {
    flag = 'unreadable'
    tone = 'fail'
    // 「conds 不是数组」这五个字行内那句已经写着了，这里只补它说不出来的后果。
    // **那个 0 尤其要点名**：不点名的话，管理员看见 0 会去把条件调宽，而条件根本
    // 就没被求值过。
    //
    // 单个条件项写坏了**不在这里补一行**：`describeCondition` 已经把「这个条件写坏了」
    // 红着写在句子里它自己的位置上，那比一句「第 2 个条件读不出来」指得更准；
    // 结论也不外推——「或」连起来时其余条件还可能成立，那是求值的事。
    if (rule.condsMalformed) {
      reasons.push('求值时整条判不成立，这条规则一场都命中不了。它的命中 0 不是「条件写窄了」。')
    }
  } else if (rule.enabled && isEmptyConds(rule)) {
    const mark = unconditionalMark(schema, rule)
    if (mark !== null) {
      flag = 'unconditional'
      tone = mark.tone
      reasons.push(mark.text)
    }
  }

  if (neverMatchesForLackOfDataSource(schema, rule)) {
    reasons.push('永远不会命中：条件用的字段当前都没有数据源。')
  }

  if (blockedBy !== null && rule.enabled) {
    reasons.push(`够不着：上面的 #${blockedBy} 是无条件规则（匹配一切），求值到那里就停了。`)
  }

  // 后端下发的静态检查结果逐条原样转发，不挑一条当摘要——校验刻意不短路
  // 就是为了一次把能说的都说完
  for (const issue of rule.issues) reasons.push(issue)

  if (flag === null && reasons.length > 0) {
    flag = 'ineffective'
    tone = 'warn'
  }

  return { flag, tone, reasons }
}
