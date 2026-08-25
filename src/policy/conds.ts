/**
 * 规则条件的求值器（阶段 3 · T2）。
 *
 * 表示法是 `{ join, conds: [{ f, op, v }] }`，取代旧的 `resource_expr`
 * （见 `docs/superpowers/plans/2026-08-25-console-stage3-rules-and-grants.md` §3.2/§3.3）。
 * 本文件只认「事实」，不认领域对象——「Meeting → MeetingFacts」的组装是调用方
 * （T3/T4）的事。这样求值是纯函数：给同样的 facts 与 now，永远得同样的判定。
 *
 * ## 三条继承自 expr.ts 的硬规矩
 *
 * 1. **判断不出来就落到不匹配那一侧。** 未知字段、未知运算符、值类型不对，
 *    一律 `matched: false`，绝不能有哪条路径悄悄落到「通过」。原型
 *    `gate-console.html:3401` 的二元 else 写法（`op === 'has' ? hit : !hit`）
 *    正是反例：写错的运算符会静默落进否定分支，`title op:'typo'` 会被当成
 *    「不包含 → 匹配」。授权中枢里这种错误查不出来，所以这里逐个 op 显式枚举。
 * 2. **「不匹配」要说得出是哪一种不匹配。** `dept` 当前没有数据源（企微通讯录
 *    未接入，计划 §1.1）与「字段名拼错了」都会不匹配，但它们是两条不同的路径、
 *    两个不同的 reason，判定理由里读起来也不一样。
 * 3. **静态问题要能在没有会议数据时说出来**，见 `describeRuleIssues`：
 *    一条只有 `dept` 条件的规则永远不会命中，管理员必须在规则列表里看得见，
 *    而不是建完一条静默失效的规则就以为生效了。
 *
 * ## 关于 dur / age 用到的结束时间（expr.ts 那段教训的下文）
 *
 * `expr.ts` 曾**故意拒绝** `end_time` 字段，理由记在它的头部注释里：当时平台
 * `/v1/records` 不返回结束时间，`Meeting.endTime` 是 `startTime` 的镜像，
 * 一旦开放，「按结束时间管控」的规则会静默按开始时间比对——一个授权中枢里
 * 查不出来的错误。**曾经如此；`d191f5b`（2026-08-21）之后有了真实数据源**：
 * `endTime` 改为取自 `record_files[].record_end_time` 的最大值，M3.5 联调用真实
 * 响应确认该字段存在。所以 `dur` / `age` 现在可以真的按结束时间算。
 *
 * 但那段教训只是换了个位置：`record_files` **全缺** `record_end_time` 时
 * `endTime` 仍会回落成 `startTime`（见 `domain/types.ts` 的注释）。照直算就是
 * 「时长 0 分钟」，于是 `dur lt 30` 会把这类会议**全部静默命中**。这里因此显式
 * 把 `endTime <= startTime` 判成「没有结束时间数据」，两个 op 都不匹配，
 * 并留下 `no_data_source` 的理由。`age` 遇到缺失的 `recordEndTime` 同理——
 * 不能让它当成 1970 年、于是「早于 N 天」恒成立。
 */

/** 求值所需的全部事实。由调用方从 Meeting + 归档状态组装 */
export interface MeetingFacts {
  title: string
  hostUserId: string
  /** 主持人部门。**当前恒为 null**：企微通讯录未接入（计划 §1.1，R0 已定不做） */
  dept: string | null
  /** unix 秒 */
  startTime: number
  /** unix 秒。等于 startTime 时视为「没有结束时间数据」，见文件头注释 */
  endTime: number
  /** 录制结束时间，unix 秒。<= 0 视为缺失 */
  recordEndTime: number
  /** 是否已写入 NAS */
  archived: boolean
}

/** 一条条件。来自无 schema 校验的 JSON 列，字段类型一概不可信 */
export interface RuleCond {
  f: string
  op: string
  v?: unknown
}

/** 一条规则的条件部分。一条规则内只有一个连接词，不支持括号与混用 */
export interface CondRule {
  join?: 'and' | 'or'
  conds: RuleCond[]
}

/**
 * 不匹配的种类。判定理由要能区分它们——
 * 「这个字段当前无数据源」和「字段名拼错了」在界面上是两句不同的话。
 */
export type CondReason =
  | 'matched'
  /** 真的比对过，不成立 */
  | 'not_matched'
  /** 字段有效，但它当前没有数据源（dept；或这场会议缺结束时间） */
  | 'no_data_source'
  /** 字段名不认识（多半是拼写错误） */
  | 'unknown_field'
  /** 字段认识，但不支持这个运算符 */
  | 'unknown_op'
  /** 规则里的值类型/内容不对 */
  | 'bad_value'
  /** 条件项本身不是 { f, op, v } 对象 */
  | 'malformed'

export interface CondEvaluation {
  matched: boolean
  reason: CondReason
  /** 人类可读的一句话，可直接进判定理由 */
  detail: string
}

export interface RuleEvaluation {
  matched: boolean
  /** 实际生效的连接词。join 缺失或取值非法时是 'and' */
  join: 'and' | 'or'
  /** 与 conds 一一对应；conds 不是数组时为空 */
  conds: CondEvaluation[]
  detail: string
}

/** 值的形态，规则编辑器（阶段 5 · F3）据此渲染输入控件 */
export type CondValueKind = 'keywords' | 'strings' | 'string' | 'number' | 'none'

export interface FieldSpec {
  label: string
  ops: readonly string[]
  value: CondValueKind
  /** 该字段当前是否有数据源 */
  available: boolean
  /** available 为 false 时的原因，要直接给管理员看 */
  unavailableReason?: string
}

/**
 * 合法字段与它们各自的合法运算符。**这张表是唯一事实源**：求值、静态检查、
 * 将来的规则编辑器都读它，不许任何一处另抄一份 op 列表。
 *
 * 运算符拼写按计划 §3.3 取 `nothas` / `isnot` / `before`。原型
 * `gate-console.html:3315-3322` 用的是 `hasnt` / `isnt` / `older`——那套拼写在这里
 * 会被判成 unknown_op（不匹配 + 静态检查报出来），这是故意的：与其悄悄认两套名字，
 * 不如让不一致当场可见。
 */
export const CONDITION_FIELDS: Record<string, FieldSpec> = {
  title: { label: '会议标题', ops: ['has', 'nothas'], value: 'keywords', available: true },
  dept: {
    label: '主持人部门',
    ops: ['in', 'notin'],
    value: 'strings',
    available: false,
    unavailableReason: '需要企业微信通讯录，尚未接入',
  },
  host: { label: '主持人', ops: ['is', 'isnot'], value: 'string', available: true },
  dur: { label: '会议时长', ops: ['gt', 'lt'], value: 'number', available: true },
  age: { label: '录制结束', ops: ['within', 'before'], value: 'number', available: true },
  arch: { label: '归档状态', ops: ['isarch', 'notarch'], value: 'none', available: true },
}

/** 关键词分隔：英文逗号、中文逗号、空白，三种都认（与原型一致） */
export function splitKeywords(raw: string): string[] {
  return raw.split(/[,，\s]+/).filter(Boolean)
}

function ok(detail: string): CondEvaluation {
  return { matched: true, reason: 'matched', detail }
}

function no(reason: Exclude<CondReason, 'matched'>, detail: string): CondEvaluation {
  return { matched: false, reason, detail }
}

function isCond(cond: unknown): cond is RuleCond {
  if (cond === null || typeof cond !== 'object') return false
  const c = cond as { f?: unknown; op?: unknown }
  return typeof c.f === 'string' && typeof c.op === 'string'
}

/**
 * 值的**阻断性**问题：有问题就一律不匹配。返回 null 表示值可用。
 * 求值与静态检查共用这一个函数，两处结论不会分叉。
 */
function blockingValueIssue(field: string, v: unknown): string | null {
  switch (field) {
    case 'title': {
      if (typeof v !== 'string') return '值必须是字符串（逗号或空白分隔的关键词）'
      // 关键词为空时 has 与 nothas 都不匹配。原型在这里会让 nothas 恒成立
      //（kws 为空 → hit=false → !hit=true），等于一条空规则放行全部会议。
      if (splitKeywords(v).length === 0) return '关键词为空，这条条件不会成立'
      return null
    }
    case 'dept': {
      if (!Array.isArray(v)) return '值必须是数组（部门名的列表）'
      if (v.length === 0) return '部门列表为空，这条条件不会成立'
      if (!v.every((x) => typeof x === 'string' && x !== '')) return '部门列表里必须都是非空的部门名'
      return null
    }
    case 'host':
      return typeof v === 'string' && v !== '' ? null : '值必须是非空的用户 id'
    case 'dur':
    case 'age':
      return typeof v === 'number' && Number.isFinite(v) ? null : '值必须是数字'
    case 'arch':
      return null
    default:
      return null
  }
}

function evalTitle(op: string, v: string, title: string): CondEvaluation {
  const kws = splitKeywords(v)
  // 大小写敏感，与原型一致：关键词多为中文，且「悄悄放宽匹配」在授权规则里不是好意
  const matchedKw = kws.find((k) => title.includes(k))
  if (op === 'has') {
    return matchedKw !== undefined
      ? ok(`标题包含关键词「${matchedKw}」`)
      : no('not_matched', `标题不包含任何一个关键词（${kws.join('、')}）`)
  }
  // nothas
  return matchedKw === undefined
    ? ok(`标题不包含任何一个关键词（${kws.join('、')}）`)
    : no('not_matched', `标题包含关键词「${matchedKw}」`)
}

function evalDept(op: string, v: string[], dept: string | null): CondEvaluation {
  if (dept === null || dept === '') {
    // 与「字段拼错」是两条不同的路径：字段是对的，是数据没有。
    // notin 尤其不能取巧判成 true——部门未知不等于「不属于财务部」。
    return no(
      'no_data_source',
      '主持人部门当前没有数据源（需要企业微信通讯录，尚未接入），这条条件无从成立',
    )
  }
  const inSet = v.includes(dept)
  if (op === 'in') {
    return inSet ? ok(`主持人部门「${dept}」在列表内`) : no('not_matched', `主持人部门「${dept}」不在列表内`)
  }
  // notin
  return inSet ? no('not_matched', `主持人部门「${dept}」在列表内`) : ok(`主持人部门「${dept}」不在列表内`)
}

function evalHost(op: string, v: string, hostUserId: string): CondEvaluation {
  const same = hostUserId === v
  if (op === 'is') {
    return same ? ok(`主持人是 ${v}`) : no('not_matched', `主持人是 ${hostUserId}，不是 ${v}`)
  }
  // isnot
  return same ? no('not_matched', `主持人就是 ${v}`) : ok(`主持人是 ${hostUserId}，不是 ${v}`)
}

function evalDur(op: string, v: number, facts: MeetingFacts): CondEvaluation {
  const { startTime, endTime } = facts
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    // 见文件头：endTime 回落成 startTime 的镜像时不能算成「0 分钟」，
    // 否则 dur lt 30 会把所有缺结束时间的会议静默命中。
    return no(
      'no_data_source',
      '这场会议没有真实的结束时间（录制文件缺 record_end_time），时长无从计算',
    )
  }
  const minutes = (endTime - startTime) / 60
  const shown = `${Math.round(minutes * 10) / 10} 分钟`
  if (op === 'gt') {
    return minutes > v ? ok(`时长 ${shown}，超过 ${v} 分钟`) : no('not_matched', `时长 ${shown}，未超过 ${v} 分钟`)
  }
  // lt。正好等于阈值时 gt 与 lt 都不成立——两个 op 都取严格不等号，边界不重叠
  return minutes < v ? ok(`时长 ${shown}，不足 ${v} 分钟`) : no('not_matched', `时长 ${shown}，不低于 ${v} 分钟`)
}

function evalAge(op: string, v: number, facts: MeetingFacts, now: number): CondEvaluation {
  const { recordEndTime } = facts
  if (!Number.isFinite(recordEndTime) || recordEndTime <= 0 || !Number.isFinite(now)) {
    // 缺失的 recordEndTime 若照直算，会被当成 1970 年、于是「早于 N 天」恒成立
    return no('no_data_source', '这场会议没有录制结束时间，距今天数无从计算')
  }
  const days = (now - recordEndTime) / 86400
  const shown = `${Math.round(days * 10) / 10} 天前`
  // within 取 <=、before 取 >：正好第 N 天算「在最近 N 天内」。
  // 两个 op 在边界上互补，既不重叠也不留空隙。
  if (op === 'within') {
    return days <= v ? ok(`录制结束于 ${shown}，在最近 ${v} 天内`) : no('not_matched', `录制结束于 ${shown}，早于 ${v} 天`)
  }
  // before
  return days > v ? ok(`录制结束于 ${shown}，早于 ${v} 天`) : no('not_matched', `录制结束于 ${shown}，在最近 ${v} 天内`)
}

function evalArch(op: string, archived: boolean): CondEvaluation {
  if (op === 'isarch') {
    return archived ? ok('已写入 NAS') : no('not_matched', '尚未写入 NAS')
  }
  // notarch
  return archived ? no('not_matched', '已写入 NAS') : ok('尚未写入 NAS')
}

/**
 * 求值一条条件。**任何落不进合法分支的输入都返回不匹配**，
 * 并带上说得出口的理由。
 */
export function evaluateCond(cond: RuleCond, facts: MeetingFacts, now: number): CondEvaluation {
  if (!isCond(cond)) return no('malformed', '条件不是 { f, op, v } 形式的对象')

  const spec = CONDITION_FIELDS[cond.f]
  if (!spec) return no('unknown_field', `未知字段「${cond.f}」，可能是拼写错误`)
  if (!spec.ops.includes(cond.op)) {
    return no('unknown_op', `字段「${spec.label}」不支持运算符「${cond.op}」`)
  }
  const valueIssue = blockingValueIssue(cond.f, cond.v)
  if (valueIssue) return no('bad_value', `字段「${spec.label}」的${valueIssue}`)

  // 到这里字段、运算符、值都已校验过，下面的类型断言是校验的结论而不是假设
  switch (cond.f) {
    case 'title':
      return evalTitle(cond.op, cond.v as string, facts.title)
    case 'dept':
      return evalDept(cond.op, cond.v as string[], facts.dept)
    case 'host':
      return evalHost(cond.op, cond.v as string, facts.hostUserId)
    case 'dur':
      return evalDur(cond.op, cond.v as number, facts)
    case 'age':
      return evalAge(cond.op, cond.v as number, facts, now)
    case 'arch':
      return evalArch(cond.op, facts.archived)
    default:
      // 字段在 CONDITION_FIELDS 里但这里没有分支：只可能是加字段时漏了实现。
      // 兜底同样是不匹配，不是放行。
      return no('unknown_field', `字段「${cond.f}」还没有求值实现`)
  }
}

function effectiveJoin(join: unknown): 'and' | 'or' {
  return join === 'or' ? 'or' : 'and'
}

/**
 * 求值一整条规则。**不短路**：每条条件都算一遍，判定理由与规则编辑器要看到
 * 逐条结论，而不是「第一条就没过」。
 */
export function evaluateRule(rule: CondRule, facts: MeetingFacts, now: number): RuleEvaluation {
  const join = effectiveJoin(rule.join)
  if (!Array.isArray(rule.conds)) {
    // conds 是无 schema 校验的 JSON 列。不是数组时不能当成「空 conds → 匹配一切」——
    // 那等于让一条坏掉的规则放行全部会议。
    return { matched: false, join, conds: [], detail: 'conds 不是数组，这条规则不参与匹配' }
  }
  if (rule.conds.length === 0) {
    return { matched: true, join, conds: [], detail: '规则没有条件，匹配全部会议' }
  }

  const conds = rule.conds.map((c) => evaluateCond(c, facts, now))
  if (join === 'or') {
    const first = conds.findIndex((c) => c.matched)
    return first >= 0
      ? { matched: true, join, conds, detail: `第 ${first + 1} 个条件成立：${conds[first]!.detail}` }
      : { matched: false, join, conds, detail: `没有任何一个条件成立：${conds.map((c) => c.detail).join('；')}` }
  }
  const firstBad = conds.findIndex((c) => !c.matched)
  return firstBad >= 0
    ? { matched: false, join, conds, detail: `第 ${firstBad + 1} 个条件不成立：${conds[firstBad]!.detail}` }
    : { matched: true, join, conds, detail: `全部 ${conds.length} 个条件都成立：${conds.map((c) => c.detail).join('；')}` }
}

/** 一条规则在这场会议上成不成立 */
export function matchesRule(rule: CondRule, facts: MeetingFacts, now: number): boolean {
  return evaluateRule(rule, facts, now).matched
}

/** 这条条件是否**无论哪场会议**都不可能成立（静态可知，不依赖会议数据） */
function neverTrue(cond: RuleCond): boolean {
  if (!isCond(cond)) return true
  const spec = CONDITION_FIELDS[cond.f]
  if (!spec) return true
  if (!spec.ops.includes(cond.op)) return true
  if (blockingValueIssue(cond.f, cond.v) !== null) return true
  return !spec.available
}

/**
 * 规则的静态检查：**不依赖任何会议数据**，返回人类可读的问题描述。
 * 规则列表与规则编辑器（阶段 5 · F3）调用它——管理员建了一条永远不会命中的规则，
 * 界面上必须看得见，而不是等着他自己发现「怎么一场都没匹配」。
 */
export function describeRuleIssues(rule: CondRule): string[] {
  const issues: string[] = []

  if (rule.join !== undefined && rule.join !== 'and' && rule.join !== 'or') {
    issues.push(`连接词「${String(rule.join)}」不认识，按「且」处理`)
  }
  if (!Array.isArray(rule.conds)) {
    issues.push('conds 不是数组，这条规则不会命中任何会议')
    return issues
  }

  rule.conds.forEach((cond, i) => {
    const at = `第 ${i + 1} 个条件`
    if (!isCond(cond)) {
      issues.push(`${at}不是 { f, op, v } 形式的对象`)
      return
    }
    const spec = CONDITION_FIELDS[cond.f]
    if (!spec) {
      issues.push(`${at}用了未知字段「${cond.f}」，可能是拼写错误，这条条件永远不成立`)
      return
    }
    if (!spec.ops.includes(cond.op)) {
      issues.push(
        `${at}的字段「${spec.label}」不支持运算符「${cond.op}」` +
          `（支持 ${spec.ops.join(' / ')}），这条条件永远不成立`,
      )
      return
    }
    const valueIssue = blockingValueIssue(cond.f, cond.v)
    if (valueIssue) {
      issues.push(`${at}（${spec.label}）的${valueIssue}`)
      return
    }
    if (!spec.available) {
      issues.push(
        `${at}的字段「${spec.label}」当前没有数据源（${spec.unavailableReason ?? '暂不可用'}），这条条件恒不成立`,
      )
    }
    // 以下是提醒，不阻断求值：值本身合法，只是多半不是管理员想写的
    if ((cond.f === 'dur' || cond.f === 'age') && typeof cond.v === 'number' && cond.v < 0) {
      issues.push(`${at}（${spec.label}）的值是负数 ${cond.v}，多半不是想写的`)
    }
    if (cond.f === 'arch' && cond.v !== undefined && cond.v !== null && cond.v !== '') {
      issues.push(`${at}（${spec.label}）不需要值，多余的值会被忽略`)
    }
  })

  if (rule.conds.length > 0) {
    // 「且」规则里只要有一条恒不成立，整条就永远不会命中；
    // 「或」规则要全部恒不成立才失效——这是两句不同的话，不能合并成
    //「全部条件都是 dept」一句了事。
    const dead =
      effectiveJoin(rule.join) === 'and' ? rule.conds.some(neverTrue) : rule.conds.every(neverTrue)
    if (dead) {
      issues.push(
        effectiveJoin(rule.join) === 'and'
          ? '这条规则永远不会命中：「且」规则里有恒不成立的条件'
          : '这条规则永远不会命中：所有条件都恒不成立',
      )
    }
  }

  return issues
}
