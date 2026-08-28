import type { Meeting } from '../types'
import { MEETINGS, MOCK_NOW } from './meetings'

/**
 * 三栈规则的种子 + 一个够用的判定引擎（原型模式）。
 *
 * ## 为什么这里有一个"引擎"，而不是一份钉死的预览结果
 *
 * spec §5 的求值语义在后端（`src/policy/`），**只有那一份**。这个文件不是
 * 第二份实现，它是**假后端在演示时说的话**——与 `install.ts` 文件头第二节
 * 是同一个口径：原型模式扮演的正是那个本该做推导的后端。
 *
 * 但"命中数"与"影响预览的三个数"如果写成常量，规则编辑器就变成一块贴纸：
 * 条件改成什么，屏幕上都是同一个 7。那既不能演示，也没法让 a11y 门槛扫到
 * `opened > 0` / `tightened > 0` 那两种不同颜色的形态。所以这里按种子里那 9 场
 * 会议真的算一遍——**只算这一层"这条规则自己的条件匹配上了吗"**，不算整栈
 * 求值、不算优先级顶替，那些是后端的事。
 *
 * ## 时间在种子空间里
 *
 * 种子会议的时间戳是以 `MOCK_NOW` 为"今天"写的（`install.ts` 装载时才整体
 * 平移到当下）。所以条件里的「录制结束在近 N 天内」拿 `MOCK_NOW` 当现在算，
 * 与平移之后的显示是同一个相对关系。
 */

/** 一条规则的**下发形状**（= 后端的 `AdminRule`）。 */
export interface ProtoRule {
  id: number
  kind: string
  priority: number
  enabled: boolean
  join: string
  /**
   * 留 `unknown` 不留数组：`policy_rules.conds` 是没有 schema 的 JSON 列，
   * 库里真的可能有写坏的规则，而那条坏规则**恰恰是管理员打开这一页要来修的**。
   * 种子里因此有一条 `conds` 根本不是数组的。
   */
  conds: unknown
  subjectType: string | null
  subjectValue: string | null
  assetTypes: string[]
  effect: string
  note: string | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
  /** 后端 `describeStackRuleIssues` 给的静态问题。**建完就静默失效的规则靠它看得见**。 */
  issues: string[]
  /**
   * 这条规则命中的场次（`GET /rules` 改版新增）。**用 `ruleHits()` 算，不是另一份
   * 判法**——与 `buildMatches()` / `buildPreview()` 是同一个函数。种子里那条
   * 「conds 不是数组」的坏规则（#320）命中 **0** 场，不是全部：见 `ruleHits()`
   * 里那段注释，真实后端就是这个语义。
   *
   * **可选**是刻意的：`install.ts` 的 `POST /rules` 直接手写一份 `ProtoRule` 字面量
   * （不经过这个文件的 `buildRules()`），不会补这两个字段——那条端点不在这次改动
   * 范围内，我不能改它去调用 `ruleHits()`。装载时种子里的 12 条规则一定有这两个
   * 字段；原型模式下现建的一条暂时没有，前端的宽读会把它显示成"—"，
   * 而不是编一个假的 0（`api/admin/rules.ts` 的 `readMatchStat` 就是为这个写的）。
   */
  matchCount?: number
  /** 这次统计考察了多少场会议。种子里恒为 `MEETINGS.length`（9 场）；同上，可选。 */
  matchScanned?: number
}

const DAY = 86_400

/**
 * 七条规则，逐条对得上种子会议里的一条判定理由（`api/mock/meetings.ts` 的 `why`）。
 * 两处对不上的话，规则页说的和会议页说的就是两个不同的系统。
 */
export function buildRules(nowSec: number): ProtoRule[] {
  const made = (days: number): number => nowSec - days * DAY
  const base: Array<Omit<ProtoRule, 'matchCount' | 'matchScanned'>> = [
    /* ── 一、拉取 ─────────────────────────────────────────────── */
    {
      id: 100,
      kind: 'fetch',
      priority: 900,
      enabled: true,
      join: 'and',
      conds: [{ f: 'age', op: 'within', v: 90 }],
      subjectType: null,
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'all',
      note: '录制结束在近 90 天内 → 拉取全部八类资产',
      createdBy: '陈运维',
      createdAt: made(120),
      updatedAt: made(120),
      issues: [],
    },
    {
      id: 110,
      kind: 'fetch',
      priority: 500,
      enabled: true,
      join: 'and',
      conds: [{ f: 'dept', op: 'in', v: ['人事部'] }],
      subjectType: null,
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'skip',
      note: '人事部的会议不拉取',
      createdBy: '周HR',
      createdAt: made(40),
      updatedAt: made(40),
      issues: [
        '条件用到了「所属部门」，本系统没有这个事实（腾讯会议的接口不下发部门）——这条规则永远不会命中，等于没建。',
      ],
    },

    /* ── 二、归档 ─────────────────────────────────────────────── */
    {
      id: 200,
      kind: 'archive',
      priority: 800,
      enabled: true,
      join: 'and',
      conds: [{ f: 'host', op: 'is', v: '赵财务' }],
      subjectType: null,
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'meetings-finance/{年}/{会议号}-{标题}/',
      note: '主持人属于财务部 → 归档到财务独立目录',
      createdBy: '陈运维',
      createdAt: made(95),
      updatedAt: made(60),
      issues: [],
    },
    {
      id: 205,
      kind: 'archive',
      priority: 750,
      enabled: true,
      join: 'and',
      conds: [{ f: 'host', op: 'is', v: '周HR' }],
      subjectType: null,
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'meetings-hr/{年}/{月}/{会议号}-{标题}/',
      note: '主持人属于人事部 → 归档到人事独立目录',
      createdBy: '周HR',
      createdAt: made(70),
      updatedAt: made(70),
      issues: [],
    },
    {
      id: 210,
      kind: 'archive',
      priority: 400,
      enabled: true,
      join: 'and',
      conds: [],
      subjectType: null,
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'meetings/{年}/{月}/{会议号}-{标题}/',
      note: '兜底：全部归档到按月份分的主目录',
      createdBy: '陈运维',
      createdAt: made(120),
      updatedAt: made(120),
      // `issues` 这里**留空是对的**，不是漏了。真实后端的读侧
      // （`src/policy/conds.ts` 的 `describeRuleIssues`）对空数组 conds 一句话都不说——
      // 只有写侧 `validateDraft` 拒绝它。假后端要说的话必须与真实后端一样多，
      // 多说一句同样是分叉，只是方向反过来。
      //
      // 「这条规则没有条件、会命中全部」这件事由规则页自己从 conds 判并挂号
      // （allow 栈 fail / 其余 warn），不依赖这个数组——真实后端不下发它，
      // 依赖它就等于原型下看得见、真实环境里看不见。
      issues: [],
    },
    {
      id: 220,
      kind: 'archive',
      priority: 100,
      enabled: false,
      join: 'and',
      conds: [{ f: 'dur', op: 'lt', v: 5 }],
      subjectType: null,
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'meetings-short/{年}/{月}/',
      note: '短会单独放一个目录（上线前先停用）',
      createdBy: '陈运维',
      createdAt: made(30),
      updatedAt: made(12),
      issues: [],
    },

    /* ── 三、采集权限 ─────────────────────────────────────────── */
    {
      id: 350,
      kind: 'allow',
      priority: 950,
      enabled: true,
      join: 'or',
      conds: [
        { f: 'title', op: 'has', v: '面试' },
        { f: 'title', op: 'has', v: '薪酬' },
        { f: 'title', op: 'has', v: '绩效' },
      ],
      subjectType: 'program',
      // 不限主体 = 对所有采集程序都禁止。它必须压过下面那条写坏了的 #320
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'deny',
      note: '标题含「面试」「薪酬」「绩效」→ 禁止采集',
      createdBy: '周HR',
      createdAt: made(75),
      updatedAt: made(75),
      issues: [],
    },
    {
      id: 300,
      kind: 'allow',
      priority: 900,
      enabled: true,
      join: 'and',
      conds: [
        { f: 'title', op: 'has', v: '周会' },
        { f: 'arch', op: 'isarch' },
      ],
      subjectType: 'program',
      subjectValue: 'kb-indexer',
      assetTypes: ['ai_minutes', 'transcript'],
      effect: 'allow',
      note: '标题含「周会」且已归档 → 准许知识库索引器采集',
      createdBy: '陈运维',
      createdAt: made(110),
      updatedAt: made(110),
      issues: [],
    },
    {
      id: 310,
      kind: 'allow',
      priority: 700,
      enabled: true,
      join: 'and',
      conds: [{ f: 'title', op: 'has', v: '大会' }],
      subjectType: 'program',
      subjectValue: 'daily-digest',
      assetTypes: ['*'],
      effect: 'allow',
      note: '全员大会 → 准许简报机器人采集',
      createdBy: '陈运维',
      createdAt: made(88),
      updatedAt: made(88),
      issues: [],
    },
    {
      id: 320,
      kind: 'allow',
      priority: 500,
      enabled: true,
      join: 'or',
      // 这一条的 conds 列被写坏了（不是数组）。**库里真的会有**，见 ProtoRule.conds
      conds: { title: '复盘' },
      subjectType: 'program',
      subjectValue: 'dw-sync',
      assetTypes: ['*'],
      effect: 'allow',
      note: '经营复盘 → 准许数据仓库同步采集',
      createdBy: '王总',
      createdAt: made(52),
      updatedAt: made(52),
      issues: [
        'conds 不是数组，这条规则不会命中任何会议——它读不出来，等于没建。管理员以为配了一道闸门，其实没有。',
      ],
    },
    {
      id: 330,
      kind: 'allow',
      priority: 300,
      enabled: true,
      join: 'and',
      // 第 2 个条件项写坏了：它不是 `{ f, op }` 形式。占着位，不静默少一行
      conds: [{ f: 'title', op: 'has', v: '财务' }, 42],
      subjectType: 'program',
      subjectValue: 'dw-sync',
      assetTypes: ['ai_ds_minutes'],
      effect: 'allow',
      note: '财务复盘的会议摘要 → 准许数据仓库同步采集',
      createdBy: '赵财务',
      createdAt: made(26),
      updatedAt: made(9),
      issues: ['第 2 个条件写坏了（不是 { f, op, v } 形式的对象），求值时会被跳过。'],
    },
    {
      id: 340,
      kind: 'allow',
      priority: 200,
      enabled: false,
      join: 'and',
      conds: [{ f: 'host', op: 'is', v: '周HR' }],
      subjectType: 'program',
      subjectValue: 'kb-indexer',
      assetTypes: [],
      effect: 'deny',
      note: '这位主持人的会议一律不外发（已被 #350 那条更宽的覆盖，先停用）',
      createdBy: '周HR',
      createdAt: made(18),
      updatedAt: made(4),
      issues: [],
    },
  ]

  // matchCount / matchScanned 按种子会议真算一遍——不是常量，理由与影响预览的数字
  // 是真算的同一条（文件头第一节）：条件改成什么，命中数就得跟着变，界面上才不是
  // 一块贴纸。**必须用 `MEETINGS`（原始种子），不是运行时那份可变的 `world`**：
  // `buildRules()` 只在 `resetProtoWorld()`（`install.ts`）里被调用一次，调用的
  // 那一刻 `world` 恰好被重置成 `structuredClone(MEETINGS)`，两者是同一份数据，
  // 这里直接读常量省得给这个文件多开一个"读当前世界"的口子。
  //
  // 代价：这两个字段是装载那一刻算的快照，往后会话里如果改了某条规则的 conds
  // （`PATCH /rules/:id`，在 `install.ts` 里，不在这个文件），矩阵不会跟着重算——
  // `install.ts` 的 `POST` / `PATCH /rules/:id` 都不在这次改动范围内。这与
  // `ProtoRule.matchCount` 那条注释是同一件事，我只能在这里把口子留出来。
  //
  // `ruleHits()` 不传 nowSec 时默认取 `MOCK_NOW`——种子会议的时间戳本来就是拿
  // `MOCK_NOW` 当"今天"写的（文件头「时间在种子空间里」一节），装载时的 `nowSec`
  // 参数（真实墙钟时间，只用来算 `createdAt` / `updatedAt` 那类展示用的时间戳）
  // 与这里无关，不能拿来传。
  return base.map((r) => ({
    ...r,
    matchScanned: MEETINGS.length,
    matchCount: ruleHits(r, MEETINGS).length,
  }))
}

/* ══════════════════════════════════════════════════════════════════
   判定：这条规则自己的条件匹配上了吗
   ══════════════════════════════════════════════════════════════════ */

export interface Cond {
  f: string
  op: string
  v?: unknown
}

/** 坏掉的条件项读成 `null` 占位；`conds` 整个不是数组则读成"无条件"。 */
export function readConds(raw: unknown): { conds: Array<Cond | null>; malformed: boolean } {
  if (!Array.isArray(raw)) return { conds: [], malformed: true }
  return {
    malformed: false,
    conds: raw.map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
      const o = item as Record<string, unknown>
      if (typeof o.f !== 'string' || typeof o.op !== 'string') return null
      return { f: o.f, op: o.op, v: o.v }
    }),
  }
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : Number.NaN
}

/**
 * 一个条件项。
 *
 * `dept` **恒不匹配**：本系统拿不到部门这个事实（`pages/Rules/fields.ts` 把它
 * 标成 `available: false`）。这里如实照办——于是那条用了部门的规则命中数是 0，
 * 与它 `issues` 里那句"永远不会命中"说的是同一件事。两处不一致，界面上就会
 * 出现"警告说它永不命中、右边写着命中 7 场"。
 */
function condHits(c: Cond, m: Meeting, nowSec: number): boolean {
  switch (`${c.f}:${c.op}`) {
    case 'title:has':
      return m.title.includes(text(c.v))
    case 'title:nothas':
      return !m.title.includes(text(c.v))
    case 'host:is':
      return m.host === text(c.v)
    case 'host:isnot':
      return m.host !== text(c.v)
    case 'dur:gt':
      return m.durationSec / 60 > num(c.v)
    case 'dur:lt':
      return m.durationSec / 60 < num(c.v)
    case 'age:within':
      return (nowSec - m.startAt) / DAY <= num(c.v)
    case 'age:before':
      return (nowSec - m.startAt) / DAY > num(c.v)
    case 'arch:isarch':
      return m.keep.archivedAt !== null
    case 'arch:notarch':
      return m.keep.archivedAt === null
    default:
      // dept 的两个 op，以及后端将来加的取值：判不出来就是判不出来，不猜
      return false
  }
}

/**
 * 一条规则（或一条候选规则）命中哪几场。
 *
 * **命中 ≠ 说了算**：主体不符、被更高优先级顶掉的规则照样算命中。这与影响预览
 * 的口径一致（`api/admin/rules.ts` 文件头写死了这件事），两处必须是同一件事。
 */
export function ruleHits(
  rule: { conds: unknown; join?: string },
  meetings: readonly Meeting[],
  nowSec: number = MOCK_NOW,
): Meeting[] {
  const { conds, malformed } = readConds(rule.conds)
  const live = conds.filter((c): c is Cond => c !== null)
  // **这两件事是相反的，别再合并。** 真实后端 `src/policy/conds.ts` 的 `evaluateRule`：
  //   - conds **不是数组** → `matched: false`，这条规则**不命中任何会议**。
  //     `src/store/policy.ts` 的 `CONDS_UNPARSABLE` 注释写死了原因：兜底值绝不能是
  //     `[]`，"那等于让一条坏掉的规则放行全部会议——授权中枢里最不该出现的那种静默放行"。
  //   - conds 是**合法的空数组** → `matched: true`，"规则没有条件，匹配全部会议"。
  // 这个假后端原来把两者都当"无条件 → 命中全部"，于是 `?proto=1` 下那条种子坏规则
  // （#320）显示"命中全部 9 场"，而同一条规则在真实系统里命中 0 场。替身比真实依赖
  // **宽容**，而且宽容的方向恰好在数据出境的那道闸门上——这个仓库栽过的同一个坑。
  if (malformed) return []
  if (live.length === 0) return [...meetings]
  const or = rule.join === 'or'
  return meetings.filter((m) =>
    or ? live.some((c) => condHits(c, m, nowSec)) : live.every((c) => condHits(c, m, nowSec)),
  )
}

/**
 * 候选规则自己的静态问题。与种子里那两条的 `issues` 是同一套说法——
 * 编辑器里刚敲出来的坏规则，和列表里躺着的坏规则，必须被同一句话说明白。
 */
export function candidateIssues(rule: { conds: unknown }): string[] {
  const { conds, malformed } = readConds(rule.conds)
  const out: string[] = []
  if (malformed) out.push('conds 不是数组，这条规则不会命中任何会议——它读不出来，等于没建。')
  conds.forEach((c, i) => {
    if (c === null) {
      out.push(`第 ${i + 1} 个条件写坏了（不是 { f, op, v } 形式的对象），求值时会被跳过。`)
      return
    }
    if (c.f === 'dept') {
      out.push(
        '条件用到了「所属部门」，本系统没有这个事实——这条规则永远不会命中，建完就是静默失效的。',
      )
    }
  })
  return out
}

/* ══════════════════════════════════════════════════════════════════
   命中列表与影响预览
   ══════════════════════════════════════════════════════════════════ */

/** 判定顺序：优先级高的先说话，同优先级按 id。与后端的 `ORDER BY` 一致。 */
export function byPrecedence(a: ProtoRule, b: ProtoRule): number {
  return b.priority - a.priority || a.id - b.id
}

/** `GET /rules/:id/matches` 的下发形状。`startAt` 要平移到当下，见 install.ts 文件头。 */
export function buildMatches(
  rule: ProtoRule,
  meetings: readonly Meeting[],
  shiftSec: number,
): Record<string, unknown> {
  const hits = ruleHits(rule, meetings)
  return {
    rule,
    scope: { meetings: meetings.length, meetingsTotal: meetings.length, truncated: false },
    matches: hits.map((m) => ({
      id: m.id,
      meetingId: m.id,
      subMeetingId: '',
      title: m.title,
      startAt: m.startAt + shiftSec,
      missing: [],
    })),
  }
}

/** 一次判定（`PreviewDecision`）。`reason` 是空串时界面上会显示「理由缺失」，别给空的。 */
interface Decision {
  effect: string
  ruleId: number | null
  note: string | null
  source: string
  reason: string
  assetTypes: string[]
  issues: string[]
}

const DEFAULT_EFFECT: Record<string, string> = {
  fetch: 'all',
  archive: 'meetings/{年}/{月}/{会议号}-{标题}/',
  allow: 'deny',
}

/** `why.by` → 判定来源。认不出的一律算 `default`，不猜成 `rule`。 */
const SOURCE_BY: Record<string, string> = {
  rule: 'rule',
  hand: 'override',
  deny: 'rule',
  wait: 'undecidable',
  na: 'undecidable',
  fail: 'default',
  expired: 'default',
}

/**
 * 这一场会议**现在**的判定。
 *
 * 取的是会议自己带的状态与理由（`why`），不是在这里重新跑一遍规则栈：会议记录页
 * 显示的就是这一份，预览的「改之前」与它不一致的话，同一件事在两页上就有了两个
 * 说法。规则 id 从理由原文里那个 `#NNN` 取——种子里的理由与 `buildRules()` 的 id
 * 是对着写的。
 */
function before(m: Meeting, kind: string, rules: readonly ProtoRule[]): Decision {
  const why = m.why[kind as 'fetch' | 'archive' | 'allow']
  const idMatch = /#(\d+)/.exec(why.text)
  const rule = idMatch === null ? null : (rules.find((r) => r.id === Number(idMatch[1])) ?? null)

  let effect: string
  if (kind === 'allow') effect = m.allow
  else if (kind === 'fetch') effect = m.fetch === 'done' || m.fetch === 'running' ? 'all' : 'skip'
  else if (m.keep.archivedAt === null) effect = '（还没归档，目录未定）'
  else effect = rule?.effect ?? DEFAULT_EFFECT.archive!

  return {
    effect,
    ruleId: rule === null ? null : rule.id,
    note: rule?.note ?? null,
    source: SOURCE_BY[why.by] ?? 'default',
    reason: why.text,
    assetTypes: rule?.assetTypes ?? ['*'],
    issues: rule?.issues ?? [],
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function directionOf(kind: string, from: Decision, to: Decision): string {
  if (from.effect === to.effect) {
    return sameList(from.assetTypes, to.assetTypes) ? 'unchanged' : 'mixed'
  }
  if (kind === 'archive') return 'moved'
  const opened = kind === 'allow' ? to.effect === 'allow' : to.effect === 'all'
  return opened ? 'opened' : 'tightened'
}

const DIRECTION_TEXT: Record<string, string> = {
  opened: '新放行',
  tightened: '新收紧',
  moved: '换一个归档目录',
  mixed: '资产类型有增有减',
  unchanged: '判定不变',
}

/**
 * 影响预览。**数字是真算的**（按种子那几场会议逐条比对改前改后），不是常量——
 * 见文件头第一节。计算范围与 spec §5.5 一致：`命中(旧) ∪ 命中(新)`，不是全部会议。
 *
 * 这个页面不会发 `deleted` / `rules`（`pages/Rules/RuleEditor.tsx` 只发单条 `rule`），
 * 所以那两条路径这里只做最低限度的兜底，不假装实现了它们。
 */
export function buildPreview(
  body: Record<string, unknown>,
  meetings: readonly Meeting[],
  rules: readonly ProtoRule[],
): Record<string, unknown> {
  const raw = (body.rule ?? (Array.isArray(body.rules) ? body.rules[0] : null)) as Record<
    string,
    unknown
  > | null
  const cand = raw ?? {}
  const kind = String(body.kind ?? cand.kind ?? 'fetch')
  const candId = typeof cand.id === 'number' ? cand.id : -1
  const issues = candidateIssues({ conds: cand.conds })

  const hitsNew = ruleHits({ conds: cand.conds, join: String(cand.join ?? 'and') }, meetings)
  const old = rules.find((r) => r.id === candId && r.kind === kind)
  const hitsOld = old === undefined ? [] : ruleHits(old, meetings)
  const union = new Map<string, Meeting>()
  for (const m of [...hitsOld, ...hitsNew]) union.set(m.id, m)
  const scanned = [...union.values()]

  const afterOf = (m: Meeting): Decision => {
    if (!hitsNew.includes(m)) return before(m, kind, rules)
    return {
      effect: String(cand.effect ?? DEFAULT_EFFECT[kind] ?? ''),
      ruleId: candId,
      note: typeof cand.note === 'string' ? cand.note : null,
      source: issues.length > 0 ? 'rule_invalid' : 'rule',
      reason:
        issues.length > 0
          ? '这条候选规则本身有问题，它说了算的判定不可信。'
          : `候选规则命中（优先级 ${String(cand.priority ?? '?')}）。`,
      assetTypes: Array.isArray(cand.assetTypes) ? (cand.assetTypes as string[]) : ['*'],
      issues,
    }
  }

  const changed: Array<Record<string, unknown>> = []
  const deciderOnly: Array<Record<string, unknown>> = []
  const shielded: Array<Record<string, unknown>> = []
  const newlyOpened: Meeting[] = []
  const counts = { opened: 0, tightened: 0, moved: 0, mixed: 0 }

  for (const m of scanned) {
    const from = before(m, kind, rules)
    const to = afterOf(m)
    const direction = directionOf(kind, from, to)
    const row = {
      key: `${m.id}|${kind}`,
      meetingId: m.id,
      title: m.title,
      programId: kind === 'allow' ? ((cand.subjectValue as string | null) ?? null) : null,
      aspect: direction === 'unchanged' ? 'decider' : direction === 'mixed' ? 'assets' : 'effect',
      direction,
      invalidRule: from.issues.length > 0 || to.issues.length > 0,
      // 这个世界里唯一一处人工改写是「永不拉取」——没拉取就无从归档、无从授权，
      // 所以它挡住的不止拉取那一栈。改写优先于所有规则（spec §5.4）。
      overridden: m.hand.length > 0,
      summary: `「${m.title}」${DIRECTION_TEXT[direction] ?? direction}`,
      before: from,
      after: to,
    }

    if (direction === 'unchanged') {
      if (hitsNew.includes(m) && from.ruleId !== to.ruleId) deciderOnly.push(row)
      continue
    }
    if (row.overridden) {
      shielded.push(row)
      continue
    }
    changed.push(row)
    counts[direction as 'opened' | 'tightened' | 'moved' | 'mixed'] += 1
    if (direction === 'opened' && from.effect === 'deny') newlyOpened.push(m)
  }

  const summary =
    changed.length === 0
      ? '这次改动不会让任何一场会议的判定发生变化。'
      : `这次改动会让 ${counts.opened} 场新放行、${counts.tightened} 场新收紧` +
        (counts.moved > 0 ? `、${counts.moved} 场换目录` : '') +
        (counts.mixed > 0 ? `、${counts.mixed} 场资产范围变了` : '') +
        '。'

  const warnings: Array<Record<string, unknown>> = []
  if (kind === 'allow' && newlyOpened.length > 0) {
    warnings.push({
      level: 'warn',
      code: 'newly_opened',
      text: `有 ${newlyOpened.length} 场会议从来没有对外开放过，这次改动之后它们将被放行。`,
      meetings: newlyOpened.slice(0, 8).map((m) => ({ id: m.id, title: m.title })),
    })
  }
  if (
    kind === 'fetch' &&
    String(cand.effect ?? '') === 'skip' &&
    hitsNew.length === meetings.length
  ) {
    warnings.push({
      level: 'warn',
      code: 'fetch_compat_off',
      text: '这条规则无条件命中全部会议、判定为不拉取——拉取栈的兼容兜底会被翻面，新录制将一场都不拉。',
      meetings: [],
    })
  }

  return {
    scope: {
      meetings: scanned.length,
      meetingsTotal: meetings.length,
      truncated: false,
      programs: kind === 'allow' && typeof cand.subjectValue === 'string' ? [cand.subjectValue] : [],
    },
    stacks: [
      {
        kind,
        counts: {
          total: meetings.length,
          scanned: scanned.length,
          hits: hitsNew.length,
          ...counts,
          deciderOnly: deciderOnly.length,
          shielded: shielded.length,
          invalid: changed.filter((c) => c.invalidRule === true).length,
        },
        summary,
        changedRuleIds: [candId],
        changed,
        deciderOnly,
        shielded,
        // 明细一条都没截断：这个世界一共九场会议，列得完
        sampled: { changed: false, deciderOnly: false, shielded: false },
      },
    ],
    warnings,
    candidateIssues: issues.length === 0 ? [] : [{ id: candId, kind, issues }],
  }
}

/* ── GET /rules/schema ─────────────────────────────────────────── */

/**
 * 条件字段与运算符的清单（`GET /api/v1/admin/rules/schema`）。
 *
 * **假后端在这里有一份清单是本分，前端有才是缺陷**：这个文件扮演的正是那个
 * 该下发清单的后端（见 `install.ts` 文件头第二节）。`src/pages/Rules/` 下
 * 一个取值都没有，全部从这条端点读——`?proto=1` 下少了这条，规则页整页
 * 就只剩一条「字段清单读不出来」的横幅，`npm run a11y` 的三个规则页场景
 * 也会扫不到内容。
 *
 * 逐字对齐 `src/policy/conds.ts` 与 `src/policy/stacks.ts`：这里说的与
 * `condHits()` 真的算的必须是同一套，否则演示里会出现「下拉框有这个运算符、
 * 选了之后命中数恒为 0」。
 */
export function buildRulesSchema(): Record<string, unknown> {
  return {
    fields: [
      {
        f: 'title',
        label: '会议标题',
        available: true,
        unavailableReason: null,
        ops: [
          { op: 'has', label: '包含任一', unitSuffix: null },
          { op: 'nothas', label: '不包含', unitSuffix: null },
        ],
        value: {
          kind: 'keywords',
          type: 'string',
          multiple: true,
          options: null,
          unit: null,
          placeholder: '关键词，逗号分隔',
          splitPattern: '[,\\uFF0C\\s]+',
        },
      },
      {
        f: 'dept',
        label: '主持人部门',
        available: false,
        // 与 `condHits()` 里 dept 恒不匹配是同一件事的两个说法
        unavailableReason:
          '需要企业微信通讯录，尚未接入（企微自建应用没有真建，R0 已定为不做，见 spec §5.3）',
        ops: [
          { op: 'in', label: '属于', unitSuffix: null },
          { op: 'notin', label: '不属于', unitSuffix: null },
        ],
        value: {
          kind: 'strings',
          type: 'string',
          multiple: true,
          options: null,
          unit: null,
          placeholder: null,
          splitPattern: null,
        },
      },
      {
        f: 'host',
        label: '主持人',
        available: true,
        unavailableReason: null,
        ops: [
          { op: 'is', label: '是', unitSuffix: null },
          { op: 'isnot', label: '不是', unitSuffix: null },
        ],
        value: {
          kind: 'string',
          type: 'string',
          multiple: false,
          options: null,
          unit: null,
          placeholder: '用户 id',
          splitPattern: null,
        },
      },
      {
        f: 'dur',
        label: '会议时长',
        available: true,
        unavailableReason: null,
        ops: [
          { op: 'gt', label: '大于', unitSuffix: null },
          { op: 'lt', label: '小于', unitSuffix: null },
        ],
        value: {
          kind: 'number',
          type: 'number',
          multiple: false,
          options: null,
          unit: '分钟',
          placeholder: null,
          splitPattern: null,
        },
      },
      {
        f: 'age',
        label: '录制结束',
        available: true,
        unavailableReason: null,
        ops: [
          // 「内」跟在值与单位之后：「在最近 90 天内」
          { op: 'within', label: '在最近', unitSuffix: '内' },
          { op: 'before', label: '早于', unitSuffix: null },
        ],
        value: {
          kind: 'number',
          type: 'number',
          multiple: false,
          options: null,
          unit: '天',
          placeholder: null,
          splitPattern: null,
        },
      },
      {
        f: 'arch',
        label: '归档状态',
        available: true,
        unavailableReason: null,
        ops: [
          { op: 'isarch', label: '已写入 NAS', unitSuffix: null },
          { op: 'notarch', label: '未归档', unitSuffix: null },
        ],
        value: {
          kind: 'none',
          type: 'none',
          multiple: false,
          options: null,
          unit: null,
          placeholder: null,
          splitPattern: null,
        },
      },
    ],
    joins: [
      { value: 'and', label: '全部满足' },
      { value: 'or', label: '任一满足' },
    ],
    stacks: [
      {
        kind: 'fetch',
        label: '拉取规则',
        effects: [
          {
            value: 'all',
            label: '拉取',
            hint: '把这场会议的资产拉回本系统。具体拉哪几类由资产类型决定',
            withAssetTypes: true,
          },
          {
            value: 'skip',
            label: '不拉取',
            hint: '本系统不持有副本。腾讯会议侧的保留期一到，这场会议就没有了',
            withAssetTypes: false,
          },
        ],
        freeform: null,
        fallback: { value: 'skip', label: '默认不拉取' },
        subjectType: null,
      },
      {
        kind: 'archive',
        label: '归档规则',
        effects: [
          {
            value: 'skip',
            label: '不归档',
            hint: '拉回来的副本只留在本地，不写进 NAS',
            withAssetTypes: false,
          },
        ],
        freeform:
          '除 skip 外，归档规则的 effect 是一段**归档目录模板**（例如 /nas/meetings/{yyyy}/{mm}），' +
          '不是一组固定取值。改目录不会搬迁已经归档过的文件——历史文件留在原路径，' +
          '只有之后新归档的会写到新目录。',
        fallback: { value: 'skip', label: '默认不归档' },
        subjectType: null,
      },
      {
        kind: 'allow',
        label: '采集权限规则',
        effects: [
          {
            value: 'allow',
            label: '准许采集',
            hint: '仍需在会议列表里授权给具体程序才真的能取走，两者是「与」的关系',
            withAssetTypes: true,
          },
          {
            value: 'deny',
            label: '禁止采集',
            hint: '照常拉取、照常归档进 NAS，但任何外部程序都取不到',
            withAssetTypes: false,
          },
        ],
        freeform: null,
        fallback: { value: 'deny', label: '默认拒绝' },
        subjectType: 'program',
      },
    ],
    // 键名与顺序取引擎的 ALL_ASSET_KEYS；**不许出现 summary / aitr 那套短名**
    assetTypes: [
      { value: 'video', label: '录像' },
      { value: 'audio', label: '音频' },
      { value: 'transcript', label: '完整转写' },
      { value: 'ai_transcript', label: 'AI 转写' },
      { value: 'ai_minutes', label: 'AI 纪要' },
      { value: 'ai_topic_minutes', label: '话题纪要' },
      { value: 'ai_speaker_minutes', label: '发言人纪要' },
      { value: 'ai_ds_minutes', label: '会议摘要' },
    ],
    assetAll: '*',
  }
}
