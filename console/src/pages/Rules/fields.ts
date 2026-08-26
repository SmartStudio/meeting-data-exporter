/**
 * 条件构建器的字段与运算符清单，以及三栈 effect 的说法。
 *
 * ## 这是一份镜像，不是事实源 —— 后端没有下发清单的端点
 *
 * 唯一的事实源是 `src/policy/conds.ts` 的 `CONDITION_FIELDS`（那个文件自己写着
 * 「**这张表是唯一事实源**：求值、静态检查、将来的规则编辑器都读它，不许任何
 * 一处另抄一份 op 列表」）。而 rules 的六条端点里**没有一条下发这份清单**
 * （核对过 `src/http/router.ts:254-259`），所以前端只能抄一份——这一份就是。
 *
 * **这是一个记在案的缺口**（见 F3 任务报告）：后端加一个新运算符，这里不会
 * 自己知道。所以本文件的每一处"认不出"都必须**说出来而不是吞掉**：
 *
 * - 未知字段 / 未知运算符：原样显示并标明"未知"，绝不折成某个已知取值；
 * - 后端已经在 `Rule.issues` 里说了同一件事（`describeRuleIssues` 会报
 *   「用了未知字段」「不支持运算符」），界面上那几条 issue 是权威，这里
 *   只是让规则行读起来不至于是一片空白。
 *
 * 想核对是否漂移，跑一遍 `grep -n "CONDITION_FIELDS" -A 20 src/policy/conds.ts`
 * 对着看。清单是六个字段、每个字段两个运算符，对照成本很低。
 */

/** 值的形态，条件行据此渲染输入控件。与后端 `CondValueKind` 同名同义。 */
export type CondValueKind = 'keywords' | 'strings' | 'string' | 'number' | 'none'

export interface FieldSpec {
  label: string
  ops: readonly string[]
  value: CondValueKind
  /** 该字段当前有没有数据源。 */
  available: boolean
  /** `available` 为 false 时的原因，**要直接给管理员看**。 */
  unavailableReason?: string
  /** 数字字段的单位，渲染在输入框右边。 */
  unit?: string
  placeholder?: string
}

/**
 * 镜像自 `src/policy/conds.ts` 的 `CONDITION_FIELDS`。
 *
 * 运算符拼写取 `nothas` / `isnot` / `before`。原型 `gate-console.html:3315`
 * 用的是 `hasnt` / `isnt` / `older`——那套拼写在后端会被判成 `unknown_op`
 * （不匹配 + 静态检查报出来）。**照后端写，不照原型写。**
 *
 * `dept` 可见但禁用：spec §5.3 的补注写明 R0（接企微通讯录）**已定为不做**，
 * 「字段可见、禁用、写明原因」不是过渡状态，是当前的最终形态。直接隐藏它
 * 反而不对——管理员会以为这个字段不存在，而它在库里的老规则上真的存在。
 */
export const CONDITION_FIELDS: Record<string, FieldSpec> = {
  title: {
    label: '会议标题',
    ops: ['has', 'nothas'],
    value: 'keywords',
    available: true,
    placeholder: '关键词，逗号分隔',
  },
  dept: {
    label: '主持人部门',
    ops: ['in', 'notin'],
    value: 'strings',
    available: false,
    unavailableReason:
      '需要企业微信通讯录，尚未接入（企微自建应用没有真建，R0 已定为不做）。' +
      '一条只有这个字段的规则永远不会命中——引擎对它显式判不匹配，不是静默漏判。',
  },
  host: { label: '主持人', ops: ['is', 'isnot'], value: 'string', available: true, placeholder: '用户 id' },
  dur: { label: '会议时长', ops: ['gt', 'lt'], value: 'number', available: true, unit: '分钟' },
  age: { label: '录制结束', ops: ['within', 'before'], value: 'number', available: true, unit: '天' },
  arch: { label: '归档状态', ops: ['isarch', 'notarch'], value: 'none', available: true },
}

/** 运算符的中文名。措辞取 spec §5.3 的表格，不取原型（原型的 op 拼写就是错的）。 */
export const OP_LABEL: Record<string, string> = {
  has: '包含任一',
  nothas: '不包含',
  in: '属于',
  notin: '不属于',
  is: '是',
  isnot: '不是',
  gt: '大于',
  lt: '小于',
  within: '在最近',
  before: '早于',
  isarch: '已写入 NAS',
  notarch: '未归档',
}

/** 认不出的字段返回 null。**不要退回某个默认字段**——那会让一条写错的规则看起来正常。 */
export function fieldSpec(f: string): FieldSpec | null {
  return CONDITION_FIELDS[f] ?? null
}

/**
 * 关键词分隔：英文逗号、中文逗号、空白，三种都认。
 * 与 `src/policy/conds.ts` 的 `splitKeywords` 逐字一致——前端按另一套切法显示，
 * 管理员看到的关键词个数就会与实际求值的不一样。
 */
export function splitKeywords(raw: string): string[] {
  return raw.split(/[,，\s]+/).filter(Boolean)
}

/** 值读成一句人话。形态认不出时原样 `String()`，不猜。 */
function valueText(spec: FieldSpec | null, op: string, v: unknown): string {
  if (spec === null) return v === undefined ? '' : `「${String(v)}」`
  switch (spec.value) {
    case 'none':
      return ''
    case 'keywords':
      return typeof v === 'string' ? `「${splitKeywords(v).join(' / ')}」` : `「${String(v)}」`
    case 'strings':
      return Array.isArray(v) ? `「${v.map(String).join(' / ')}」` : `「${String(v)}」`
    case 'number': {
      const unit = spec.unit ?? ''
      // 「在最近 90 天内」：spec §5.3 的原话，"内"字跟在单位后面
      const tail = op === 'within' ? `${unit}内` : unit
      return `${String(v)} ${tail}`.trim()
    }
    case 'string':
      return `「${String(v)}」`
  }
}

/**
 * 一条条件读成一句话，用于规则行与条件摘要。
 *
 * **认不出的东西一律说出来**：未知字段、不支持的运算符、写坏的条件项各有各的
 * 说法。渲染成空白或者悄悄跳过，就等于告诉管理员"这条规则没问题"。
 */
export function describeCondition(cond: { f: string; op: string; v?: unknown } | null): string {
  if (cond === null) return '这个条件写坏了（不是 { f, op, v } 形式的对象）'
  const spec = fieldSpec(cond.f)
  const fieldText = spec === null ? `未知字段「${cond.f}」` : spec.label

  // 字段就认不出的时候**不评价运算符**：这个字段支不支持它，我们无从判断。
  // 照说"不支持的运算符"是在编一个我们没有的结论，而后端的 issues 里
  // 那时说的是"用了未知字段"——两句话对不上，管理员会以为有两个毛病。
  const opOk = spec !== null && spec.ops.includes(cond.op)
  const opText =
    spec === null ? cond.op : opOk ? (OP_LABEL[cond.op] ?? cond.op) : `不支持的运算符「${cond.op}」`

  // 字段或运算符认不出时值也不做解释——那时"值该是什么形态"本身就说不准
  const vText = spec !== null && opOk ? valueText(spec, cond.op, cond.v) : rawValueText(cond.v)
  return joinCondParts([fieldText, opText, vText])
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
 * 一次判定的 effect 读成人话。**逐字对齐后端的 `describeStackEffect`**
 * （`src/policy/stacks.ts:307`）——预览面板里的"从 A 变成 B"两头是后端下发的
 * 字符串，规则行里的说法必须与它一字不差，否则同一条规则在两处读起来是两回事。
 *
 * 资产类型用网关的键名（`ai_minutes`），不换成中文：后端下发的理由里用的就是
 * 键名，一屏之内出现两套叫法比多认几个英文单词更糟。中文名只在资产选择器里
 * 与键名一起出现（`ASSET_KEYS`）。
 */
export function describeEffect(kind: string, effect: string, assetTypes: readonly string[]): string {
  const assets = assetTypes.length > 0 ? assetTypes.join('、') : '未列出任何资产类型'
  if (kind === 'fetch') {
    if (effect === 'all') return `拉取（${assets}）`
    if (effect === 'skip') return '不拉取'
    return `认不出的 effect「${effect}」`
  }
  if (kind === 'archive') {
    if (effect === 'skip') return '不归档'
    return effect.trim() === '' ? `认不出的 effect「${effect}」` : `归档到 ${effect}`
  }
  if (kind === 'allow') {
    if (effect === 'allow') return `准许采集（${assets}）`
    if (effect === 'deny') return '禁止采集'
    return `认不出的 effect「${effect}」`
  }
  return `认不出的 effect「${effect}」`
}

/* ── 事实缺失 vs 事实为空（阶段 4 · T13）───────────────────────── */

/**
 * 缺失事实的中文名，镜像自 `src/policy/conds.ts` 的 `FACT_LABEL`。
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

/* ── 八类资产 ─────────────────────────────────────────────────── */

/**
 * 八类资产，键名与顺序取 `packages/engine/src/domain/types.ts` 的 `ALL_ASSET_KEYS`。
 *
 * **不许出现 `summary` / `aitr` / `digest` 那套原型短名**——同一批资产已经有过
 * 三套叫法，M3.5 为此吃过一次亏（`api/types.ts` 开头也钉着这句）。
 *
 * 中文名暂时只有这一页用，所以按 G-b 放在消费者旁边。第二页（F4 采集授权 /
 * F6 内容预览）要用的时候，把它提到 `lib/format.ts` 去，别各抄一份。
 */
export const ASSET_KEYS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'video', label: '录像' },
  { key: 'audio', label: '音频' },
  { key: 'transcript', label: '完整转写' },
  { key: 'ai_transcript', label: 'AI 转写' },
  { key: 'ai_minutes', label: 'AI 纪要' },
  { key: 'ai_topic_minutes', label: '话题纪要' },
  { key: 'ai_speaker_minutes', label: '发言人纪要' },
  { key: 'ai_ds_minutes', label: '会议摘要' },
]

/** `['*']` 是"全部八类"的写法，后端 `normalizeAssetTypes` 会展开它。 */
export const ASSET_ALL = '*'
