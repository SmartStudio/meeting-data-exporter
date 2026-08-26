/**
 * 规则页的呈现层：把一条规则读成一句话。
 *
 * ## 这个文件分两半，别把它们混在一起
 *
 * F3 那一轮这里是**一份镜像**：`CONDITION_FIELDS` / `OP_LABEL` / `ASSET_KEYS`
 * 逐字抄自 `src/policy/conds.ts`，因为后端当时没有下发清单的端点。A9（阶段 5）
 * 把清单收回后端并开了 `GET /rules/schema`，F9 把镜像删了。现在：
 *
 * ### 上半：**后端下发的**（`RulesSchema`，唯一事实源）
 *
 * 字段有哪几个、每个字段能用哪些运算符、值是什么形态、单位是什么、
 * 中文名怎么写、三栈的 effect 取值域、八类资产的键名与中文名——**全部**来自
 * `GET /api/v1/admin/rules/schema`。这一半在这里只有查表函数，一个取值都不存。
 *
 * **改这一半要去改后端**，改这里改不动任何东西。
 *
 * ### 下半：**前端自己造的**（`FRONTEND_TEXT` 与它下面那几个函数）
 *
 * 后端没有的、也不该有的那部分：把「字段 + 运算符 + 值」拼成一句中文的排版规矩、
 * 「认不出的东西」怎么说、命中列表里「标题缺失」与「标题为空」两句话。
 *
 * **改这一半随便改**，它不会和后端打架——它一个取值域都不定义。
 *
 * 唯一的例外单独标着：`FACT_LABEL` 仍是一份镜像（schema 没下发它，A9 报告 §4
 * 记为遗留）。它四行、认不出的键原样返回，漂了也只是少说一句。
 *
 * ## `schema` 为 null 是一种真实状态，不是「还没写完」
 *
 * `/rules/schema` 读不到时（后端不可达、契约对不上），下面每个函数都收 `null`，
 * 那时**只报库里的原值，一个字都不猜**——页面另有一条横幅说清「字段清单读不出来」。
 * 绝不在这里塞一份硬编码清单顶上：那份快照会在最不该有它的时刻冒充真相。
 */

import type { RulesSchema, SchemaEffect, SchemaField, SchemaOp, SchemaStack } from '@/api/admin/rules'

/* ══════════════════════════════════════════════════════════════
   上半 · 后端下发的：只查表，不存值
   ══════════════════════════════════════════════════════════════ */

/** 认不出的字段返回 null。**不要退回某个默认字段**——那会让一条写错的规则看起来正常。 */
export function fieldOf(schema: RulesSchema | null, f: string): SchemaField | null {
  return schema?.fields.find((x) => x.f === f) ?? null
}

/** 这个字段支不支持这个运算符。不支持时返回 null，不折成它的第一个运算符。 */
export function opOf(field: SchemaField | null, op: string): SchemaOp | null {
  return field?.ops.find((x) => x.op === op) ?? null
}

export function stackOf(schema: RulesSchema | null, kind: string): SchemaStack | null {
  return schema?.stacks.find((s) => s.kind === kind) ?? null
}

export function effectOf(stack: SchemaStack | null, effect: string): SchemaEffect | null {
  return stack?.effects.find((e) => e.value === effect) ?? null
}

/**
 * 选了这个 effect 之后，「资产类型」那一栏还起不起作用（后端的 `isPositive`）。
 *
 * 取值域之外的 effect 一律 false：说不准的时候不显示资产选择器，比替它猜一个
 * 「大概是正面判定」安全——猜错的方向是让人以为自己勾的资产类型生效了。
 */
export function effectUsesAssetTypes(
  schema: RulesSchema | null,
  kind: string,
  effect: string,
): boolean {
  return effectOf(stackOf(schema, kind), effect)?.withAssetTypes ?? false
}

/**
 * 关键词怎么切。**切法本身是后端下发的**（`value.splitPattern`，与求值器的
 * `splitKeywords` 是同一个正则对象），前端不再抄一份：按另一套切法显示的话，
 * 管理员看到的关键词个数与实际求值的不一样，而这是谁都不会去核对的一条差异。
 *
 * 拿不到切法（不是 keywords 形态、或者后端给了一个编译不了的模式）时**不切**，
 * 整串当一个词。随手补一个 `/[,\s]+/` 顶上就是把镜像请回来了。
 */
export function splitKeywords(field: SchemaField | null, raw: string): string[] {
  const sep = separatorOf(field?.value.splitPattern ?? null)
  if (sep === null) return raw === '' ? [] : [raw]
  return raw.split(sep).filter(Boolean)
}

/** 同一个模式只编译一次。编不出来的记成 null，不抛——一条坏正则不该让整页打不开。 */
const SEPARATOR_CACHE = new Map<string, RegExp | null>()

function separatorOf(pattern: string | null): RegExp | null {
  if (pattern === null) return null
  if (!SEPARATOR_CACHE.has(pattern)) {
    try {
      SEPARATOR_CACHE.set(pattern, new RegExp(pattern))
    } catch {
      SEPARATOR_CACHE.set(pattern, null)
    }
  }
  return SEPARATOR_CACHE.get(pattern) ?? null
}

/* ══════════════════════════════════════════════════════════════
   下半 · 前端自己造的：只管显示，不定义任何取值域
   ══════════════════════════════════════════════════════════════ */

/**
 * 界面上的说法。**后端没有这几句，也不该有**——它们说的是「这一处渲染不出来
 * 的时候怎么措辞」，属于呈现，不属于契约。改这里不会和后端打架。
 *
 * 共同的规矩：**认不出的东西一律说出来，不吞掉、不折成某个已知取值**。
 * 渲染成空白或者悄悄跳过，等于告诉管理员「这条规则没问题」。
 */
export const FRONTEND_TEXT = {
  /** 字段不在清单里（库里的老规则用了一个拼错的字段）。 */
  unknownField: (f: string) => `未知字段「${f}」`,
  /** 字段认得，但它不支持这个运算符。 */
  unsupportedOp: (op: string) => `不支持的运算符「${op}」`,
  /**
   * 运算符在清单里，但**后端没给它登记中文名**（`ops[].label` 是 null）。
   * 这句话是给后端看的：显示成英文原值而不说明，漏登记就永远不会被发现。
   */
  unlabeledOp: (op: string) => `运算符「${op}」（后端没有登记中文名）`,
  /** effect 不在这一栈的取值域里，而这一栈也不是自由填写的。 */
  unknownEffect: (effect: string) => `认不出的 effect「${effect}」`,
  /** 自由填写的那一栈（归档目录模板）读成一句话时的前缀。 */
  freeformEffect: (effect: string) => `归档到 ${effect}`,
  /** 正面判定却一类资产都没列。 */
  noAssetTypes: '未列出任何资产类型',
  /** `conds` 里的一项根本不是 `{ f, op, v }`。 */
  malformedCond: '这个条件写坏了（不是 { f, op, v } 形式的对象）',
  /** 字段没有数据源，而后端**也没说为什么**（契约要求说，但它是一个 nullable 列）。 */
  unavailableNoReason: '后端没有给出原因',
  /** 清单读不出来时，条件与动作只报原值。 */
  schemaMissing: '字段清单读不出来',
} as const

/**
 * 一条条件读成一句话，用于规则行与条件摘要。
 *
 * `schema` 为 null（清单读不出来）时**只报库里的原值**：字段叫什么、
 * 支不支持这个运算符、值该是什么形态，这时一件都说不准。
 */
export function describeCondition(
  schema: RulesSchema | null,
  cond: { f: string; op: string; v?: unknown } | null,
): string {
  if (cond === null) return FRONTEND_TEXT.malformedCond
  if (schema === null) return joinCondParts([cond.f, cond.op, rawValueText(cond.v)])

  const field = fieldOf(schema, cond.f)
  const fieldText = field === null ? FRONTEND_TEXT.unknownField(cond.f) : field.label

  // 字段就认不出的时候**不评价运算符**：这个字段支不支持它，我们无从判断。
  // 照说"不支持的运算符"是在编一个我们没有的结论，而后端的 issues 里
  // 那时说的是"用了未知字段"——两句话对不上，管理员会以为有两个毛病。
  const op = field === null ? null : opOf(field, cond.op)
  const opText =
    field === null
      ? cond.op
      : op === null
        ? FRONTEND_TEXT.unsupportedOp(cond.op)
        : (op.label ?? FRONTEND_TEXT.unlabeledOp(op.op))

  // 字段或运算符认不出时值也不做解释——那时"值该是什么形态"本身就说不准
  const vText = field !== null && op !== null ? valueText(field, op, cond.v) : rawValueText(cond.v)
  return joinCondParts([fieldText, opText, vText])
}

/** 值读成一句人话。形态认不出时原样 `String()`，不猜。 */
function valueText(field: SchemaField, op: SchemaOp, v: unknown): string {
  switch (field.value.kind) {
    case 'none':
      return ''
    case 'keywords':
      return typeof v === 'string'
        ? `「${splitKeywords(field, v).join(' / ')}」`
        : `「${String(v)}」`
    case 'strings':
      return Array.isArray(v) ? `「${v.map(String).join(' / ')}」` : `「${String(v)}」`
    case 'number': {
      // 「在最近 90 天内」：单位与那个「内」都是后端给的，前端不再为 `within`
      // 写一条特例——那条特例正是当初抄一份清单的起点
      const tail = `${field.value.unit ?? ''}${op.unitSuffix ?? ''}`
      return `${String(v)} ${tail}`.trim()
    }
    case 'string':
      return `「${String(v)}」`
    default:
      // 后端加了一种新形态而这里还没有分支：原样显示，不折成上面任何一种
      return `「${String(v)}」`
  }
}

/**
 * 「会议标题 包含任一「财务」」——值自带书名号时不再多一个空格。
 * 纯粹是排版：多出来的那个空格在窄屏上会把括号挤到下一行。
 */
function joinCondParts(parts: readonly string[]): string {
  let out = ''
  for (const part of parts) {
    if (part === '') continue
    if (out === '') out = part
    else out += (part.startsWith('「') ? '' : ' ') + part
  }
  return out
}

function rawValueText(v: unknown): string {
  if (v === undefined) return ''
  return `「${typeof v === 'string' ? v : JSON.stringify(v)}」`
}

/**
 * 一次判定的 effect 读成人话。
 *
 * **取值域来自 schema**（`stacks[].effects[]`），拼句子的规矩留在前端：
 * effect 的中文名与「选了它资产类型还算不算数」都是后端给的，这里只负责把
 * 资产类型接在后面。
 *
 * **「认不出的 effect」这条兜底刻意留着**（A9 报告 §2 差异 7 建议留）：
 * schema 给的是取值域，不是「这条规则的 effect 是什么」——库里那一列是自由
 * 字符串，真的会出现取值域之外的值，而后端的 `describeStackEffect` 只在
 * 归一化之后才被调用，所以它没有这条分支。这里比后端严一点，方向是对的。
 */
export function describeEffect(
  schema: RulesSchema | null,
  kind: string,
  effect: string,
  assetTypes: readonly string[],
): string {
  // 清单读不出来：只报原值。这时连"这个 effect 认不认得"都说不准
  if (schema === null) return effect

  const stack = stackOf(schema, kind)
  if (stack === null) return FRONTEND_TEXT.unknownEffect(effect)

  const known = effectOf(stack, effect)
  if (known !== null) {
    if (!known.withAssetTypes) return known.label
    const assets = assetTypes.length > 0 ? assetTypes.join('、') : FRONTEND_TEXT.noAssetTypes
    return `${known.label}（${assets}）`
  }

  // 取值域之外。这一栈是自由填写的（归档目录模板）就照直念，否则说它认不出
  if (stack.freeform !== null && effect.trim() !== '') return FRONTEND_TEXT.freeformEffect(effect)
  return FRONTEND_TEXT.unknownEffect(effect)
}

/* ── 事实缺失 vs 事实为空（阶段 4 · T13）───────────────────────── */

/**
 * 缺失事实的中文名。
 *
 * ⚠️ **这是本文件里剩下的唯一一份镜像**，源头是 `src/policy/conds.ts` 的
 * `FACT_LABEL`。A9 没有把它下发（它属于「命中列表怎么显示缺失事实」，不属于
 * 条件构建器），记在 A9 报告 §4 的遗留里，建议随
 * `GET /rules/:id/matches` 的响应下发——那里才是它的消费点。
 *
 * 认不出的键**原样返回**——后端将来多报一项，这里少说一句总比说错一句好。
 */
const FACT_LABEL: Record<string, string> = {
  title: '标题',
  hostUserId: '主持人',
  startTime: '开始时间',
  endTime: '结束时间',
}

export function missingFactLabel(key: string): string {
  return FACT_LABEL[key] ?? key
}

export interface TitleDisplay {
  text: string
  /** `missing` 库里没有这一项 · `empty` 存了一个空串 · `ok` 有值 */
  kind: 'missing' | 'empty' | 'ok'
  /** `missing` 时的一句解释，直接上屏。 */
  hint: string | null
}

/**
 * 命中列表里一场会议的标题怎么显示。
 *
 * **这是阶段 4 · T13 的洞在前端这一侧的出口。** 那次修的是把 NULL 标题折成
 * 空串：折完之后一场「标题真的是空串」的会议与一场「标题在库里根本没有」的
 * 会议长得一模一样，于是 `title 含 X → deny` 对后者判"不匹配"，落到了放行的
 * 一侧。后端为此在事实里多带了一个 `missing`，命中列表也把它下发上来了
 * （`GET /rules/:id/matches` 的 `matches[].missing`）。
 *
 * 规则编辑器在展示「这条规则会命中什么」时**不能把这两者重新折回一起**：
 * 都渲染成一个空格子，管理员就再也看不出哪几场是元数据没拉回来的。
 */
export function titleDisplay(title: string, missing: readonly string[]): TitleDisplay {
  if (missing.includes('title')) {
    return {
      text: '标题缺失',
      kind: 'missing',
      hint:
        '这场会议的标题在库里根本不存在（元数据没拉回来），不是"标题是空的"。' +
        '用到标题的条件对它判不出来。',
    }
  }
  if (title === '') return { text: '（标题为空）', kind: 'empty', hint: null }
  return { text: title, kind: 'ok', hint: null }
}
