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
import { fieldOf } from './fields'

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
