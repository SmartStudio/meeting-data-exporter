import type { AdminMeeting } from '@/api/admin/meetings'
import type { ServiceProgram } from '@/api/admin/grants'
import type { StatusDotState } from '@/ui/StatusDot'
import { STATUS_DOT_LABEL } from '@/ui/StatusDot'
import { daysLeft } from '@/lib/format'

/**
 * 会议记录页的**纯展示映射**。这个文件是 `write.ts` 的遗产：那个文件同时装着
 * 展示映射和「改了 `fetch` 就要连带改 `why` / `hand` / `keep`」的状态推导，
 * 后者在接真 API 之后按裁定 G-c 删掉了——后端也有一份而且带测试，留两份
 * 就是两份真相，而它们不一致的地方恰好是判定边界。
 *
 * **留下的只有「这个取值该画成什么」**：阶段名、状态文案、理由的归类与着色、
 * 「已授权给」那一栏画哪一种。它们不推导下一个状态，也不生成任何 `why` 文本
 * ——界面上显示的判定理由一律来自后端下发的 `why`。
 *
 * ## 认不出的取值一律显式落到「未知」
 *
 * `AdminMeeting` 的状态字段是 `string`（见 `api/admin/meetings.ts` 文件头）。
 * 这里把它翻成界面取值时，**认不出的一律给 `'unknown'`**，不给任何默认值。
 * 计划 §1 第 2 条：拿不到状态时显示「未知」，不许默认成「正常」。
 */

export type Stage = 'fetch' | 'archive'

/** 阶段名。与原型的 `STAGE_LABEL` 逐字一致，不另造叫法。 */
export const STAGE_NAME: Record<Stage, string> = { fetch: '拉取', archive: '归档到 NAS' }

/**
 * 表格里那一格用的短名。列头已经写着「拉取 · 归档」，格子里再写一遍
 * 「归档到 NAS」会把这一列撑宽一倍，而 NAS 这三个字母在这里不携带新信息
 * （去哪儿归档是详情抽屉回答的事）。**只在表格里短**——详情抽屉、人工改写面板
 * 一律仍用 `STAGE_NAME`。
 */
export const STAGE_SHORT: Record<Stage, string> = { fetch: '拉取', archive: '归档' }

/** 界面上的阶段状态。`'unknown'` 不是后端的取值，是「后端给了个我们不认识的取值」。 */
export type DotState = StatusDotState | 'unknown'

const FETCH_STATES = new Set<string>(['done', 'running', 'blocked', 'off', 'none'])
const ARCHIVE_STATES = new Set<string>(['done', 'running', 'failed', 'off', 'blocked', 'none'])

export function dotState(stage: Stage, raw: string): DotState {
  const allowed = stage === 'fetch' ? FETCH_STATES : ARCHIVE_STATES
  return allowed.has(raw) ? (raw as StatusDotState) : 'unknown'
}

/** 未知状态的文案。**不是空白**——空白看起来像「这个阶段不适用」。 */
export const UNKNOWN_STATE_LABEL = '未知'

export function stateLabel(state: DotState): string {
  return state === 'unknown' ? UNKNOWN_STATE_LABEL : STATUS_DOT_LABEL[state]
}

/** 采集权限的三个取值。同样：认不出的不算「准许」。 */
export type AllowView = 'allow' | 'deny' | 'unknown'

export function allowView(raw: string): AllowView {
  return raw === 'allow' || raw === 'deny' ? raw : 'unknown'
}

/* ── 表格里那两个方块旁边的「异常注记」（阶段 7）──────────────────

   此前这一栏是两行文字（「拉取 已完成」「归档 已完成」），每行 87px 的一半
   花在复述"一切正常"上——59 场里 50 多场读出来都是同一句。现在正常态**一个
   字都不写**：两个并排的小方块，颜色即状态。

   代价是"出问题的那几场"不能再靠读文字发现，所以异常必须自己冒出来：
   `stageNote` 回答的就是「这一行有没有一句非说不可的话」。返回 `null` 就是
   正常态，那时这一格只有两个方块。

   **优先级是排过的，不是随手写的 if 链**：一格只放得下一句，那句必须是最贵的
   那一件事。失败 > 读不懂后端 > 有人绕过规则 > 压根没录 > 规则不执行 > 未执行。
   归档失败排第一的理由与 design-system.md §2.2 一致：它意味着一个月后永久丢失。 */

export type StageNoteTone = 'fail' | 'warn' | 'neutral'

export interface StageNote {
  text: string
  tone: StageNoteTone
}

/** 正常态返回 `null`——那一格因此一个字都不写。 */
export function stageNote(m: AdminMeeting): StageNote | null {
  const f = dotState('fetch', m.fetch)
  const a = dotState('archive', m.archive)

  if (a === 'failed') return { text: '归档失败', tone: 'fail' }
  // 读不懂后端下发的取值。**不静默**——认不出的状态画成方块等于替后端下结论
  if (f === 'unknown') return { text: `${STAGE_SHORT.fetch}未知`, tone: 'warn' }
  if (a === 'unknown') return { text: `${STAGE_SHORT.archive}未知`, tone: 'warn' }
  // 琥珀在 §2.2 里只有一个含义：有人手动改写了规则
  if (m.hand.includes('fetch') && (f === 'off' || f === 'blocked')) {
    return { text: '人工设为不拉取', tone: 'warn' }
  }
  if (m.hand.includes('archive') && (a === 'off' || a === 'blocked')) {
    return { text: '人工设为不归档', tone: 'warn' }
  }
  if (f === 'none') return { text: '无录制', tone: 'neutral' }
  if (f === 'blocked') return { text: '规则不拉取', tone: 'neutral' }
  if (a === 'blocked') return { text: '规则不归档', tone: 'neutral' }
  if (f === 'off') return { text: '未拉取', tone: 'neutral' }
  if (a === 'off') return { text: '未归档', tone: 'neutral' }
  return null
}

/* ── 整行的告警条（左侧 3px 色条）────────────────────────────────

   异常行**不整行变红**：一屏 20 行里只要有三行变红，红就不再是"最严重"的
   意思，而是"这几行长得不一样"。改成行首一道色条——它在余光里看得见，
   又不会把这一行的正文压成红底。

   只有两种成因配得上这道条，与 §2.2 的两个语义色一一对应：
   归档失败（红＝一个月后永久丢失）、保留期七天内到期（琥珀＝该看一眼了）。
   **人工改写不挂条**：它已经在阶段注记里写着「人工设为不拉取」，再挂一道条
   就是同一件事收两次费，而配了人工改写的部署会得到一屏永久琥珀。 */

export type RowFlag = 'fail' | 'warn'

export function rowFlag(m: AdminMeeting, now: Date): RowFlag | null {
  if (dotState('archive', m.archive) === 'failed') return 'fail'
  if (!m.keep.filesGone && m.keep.expiresAt !== null && daysLeft(m.keep.expiresAt, now) <= 7) {
    return 'warn'
  }
  return null
}

/* ── 采集程序的两字母标记 ────────────────────────────────────────

   「可取走的程序」此前有三种形态表达同一件事：蓝色 chip（有授权）、`＋` 按钮
   （再加一个）、虚线「＋ 授权给…」（一个都没有）。三种形态、三种宽度，一列
   扫下来看不出哪几行真的把数据放出去了。统一成一枚 24×20 的等宽标记。

   ## 缩写从 `key` 派生，不从中文名查表

   在前端写一张「知识库索引器 → KB」的表，等于把后端的程序清单抄一份到界面上：
   运维新建一个程序，界面上就是一个没有缩写的空格，而没有人会想到要回来改这张表。
   所以规则只吃 `id`（也就是程序的 key，`kb-indexer` / `daily-digest` / `dw-sync`）：

   1. 按 `-` `_` `.` 空白切段，只保留纯 ASCII 字母数字的段；
   2. **第一段恰好两个字符**就直接用它（`kb-indexer` → `KB`、`dw-sync` → `DW`）
      ——这类 id 的第一段本来就是缩写，拆开取首字母反而会得到 `KI` / `DS`；
   3. 否则取前两段的首字母（`daily-digest` → `DD`）；
   4. 只有一段且长度够，取它的前两个字符（`archiver` → `AR`）；
   5. **派生不出来就返回 `null`**（纯中文 id、单字符 id）。调用方据此退回显示
      完整程序名——瞎缩一个出来，界面上就会有一枚谁也对不上号的标记。 */

const ABBR_SEP = /[-_.\s]+/
const ABBR_SEG = /^[a-z0-9]+$/
const ABBR_LEN = 2

export function programAbbr(id: string): string | null {
  const segs = id.trim().toLowerCase().split(ABBR_SEP).filter((s) => ABBR_SEG.test(s))
  const first = segs[0]
  if (first === undefined) return null
  if (first.length === ABBR_LEN) return first.toUpperCase()
  const second = segs[1]
  if (second !== undefined) return (first[0]! + second[0]!).toUpperCase()
  if (first.length > ABBR_LEN) return first.slice(0, ABBR_LEN).toUpperCase()
  return null
}

/* ── 判定理由的呈现（spec.md §6.1）────────────────────────────── */

/** 理由分类的中文名。`by` 决定样式，不是随手挑的颜色。 */
const WHY_LABEL: Record<string, string> = {
  rule: '来自规则',
  hand: '人工改写',
  fail: '失败',
  expired: '已到期',
  wait: '前置未完成',
  na: '不适用',
  deny: '规则禁止',
}

/** 后端没下发这一段理由时显示的话。**不许留空**（计划 §1 第 2 条）。 */
export const WHY_MISSING_LABEL = '理由缺失'

/**
 * 后端没给理由时补的一句话。它说的是「我们不知道」，
 * 不是替后端编一个理由——两者的区别是这一页存在的前提。
 */
export const WHY_MISSING_TEXT = '后端没有下发这一段的判定理由。这不代表没有理由，只代表这里读不到。'

export function whyLabel(by: string): string {
  if (by === '') return WHY_MISSING_LABEL
  return WHY_LABEL[by] ?? `未知理由类型（${by}）`
}

export type WhyTone = 'neutral' | 'warn' | 'fail'

/**
 * 理由的着色。
 *
 * 琥珀只有一个含义：**这需要你看一眼**（design-system.md §2.2）。所以只有
 * `hand`（有人手动改写、绕过了规则）配得上它。
 *
 * `deny` 特意**不**用琥珀，尽管原型是琥珀的：一条 deny 规则命中是规则系统在
 * 正确地干活，绝大多数被拒的会议是故意且永久被拒的。画成琥珀，配了这类规则的
 * 组织就会有一大片永久琥珀，真正该被看见的琥珀淹死在里面。
 *
 * `expired` / `wait` / `na` 是生命周期原因，不是谁的过错，同样中性。
 * 理由缺失也中性——它是一条待查的线索，不是一次失败。
 */
export function whyTone(by: string): WhyTone {
  if (by === 'fail') return 'fail'
  if (by === 'hand') return 'warn'
  return 'neutral'
}

/* ── 判定理由的拆解（规则引用 / 事实 / 注意事项）─────────────────

   后端把一段判定理由拼成一句话下发。归档完成那一句尤其长：
   「已归档到 X（时间）。当前归档规则栈的判定是「归档规则 #4「名字」决定：归档到 all」
   ——那是此刻这一次求值，不是当初归档时跑的那一次；已经写进 NAS 的副本不受规则改动
   影响。」一整段读下来才能知道是哪条规则判的，而抽屉是「点开看是哪条规则」的地方。

   这里只做**切分**，不生成任何文字：切出来的每一段仍然是后端那句话的子串
   （计划 §1 第 3 条「文本一律来自后端下发的 `why`，前端不自己编」）。切成三份：

   1. `rule` —— 规则号 + 规则名 + 判成了什么。排成结构，一眼能扫。
   2. `text` —— 引用之外的事实（归档到哪、什么时候）。原样照登。
   3. `aside` —— 引用后面由「——」引出的那段。**它在每一场已归档的会议上都是同一句
      话**，同一句话重复出现在每一处就不再有人读它，所以它不进正文，由调用方挂到
      「来自规则」这个标签上。意思一个字不删——那是个真实且不直观的陷阱。

   ## 认不出格式就原样照登

   后端还有一堆不长这样的理由（兜底「没有任何归档规则匹配……」、人工改写、
   「元数据查不到，无从判定」）。它们一律落到 `rule: null` + 正文原样，
   **不去猜**——猜错的代价是把一句判定理由拆成两个半句。 */

/** 后端拼理由的格式：`{栈名} #{id}「{note}」决定：{效果}`（`src/policy/stacks.ts`）。
 *  规则没起名字时中间那对「」不出现，所以是可选组。 */
const WHY_RULE_RE = /([^\s「」]*规则)\s*#(\d+)\s*(?:「(.+?)」)?\s*决定：\s*([^。；「」]+)/

/** 注意事项由一个破折号引出。它只出现在引用**后面**，规则名里的破折号在引用之内。 */
const ASIDE_MARK = '——'

export interface WhyRuleRef {
  /** 「归档规则 #4」。逐字来自后端，规则号在这里可回溯 */
  ref: string
  /** 规则名（后端的 `note`）。没起名字的规则是 null，不编一个 */
  name: string | null
  /** 判成了什么：「归档到 all」「不拉取」「准许采集（video、audio）」 */
  result: string
}

export interface WhyParts {
  rule: WhyRuleRef | null
  /** 引用之外的事实。可能是空串（整句话就是一条引用时） */
  text: string
  /** 每场会议都一样的那句注意事项。null = 这一段没有 */
  aside: string | null
}

export function parseWhy(text: string): WhyParts {
  const m = WHY_RULE_RE.exec(text)
  if (m === null) return { rule: null, text, aside: null }

  const head = text.slice(0, m.index)
  // 归档完成那一句把引用包在一对外层「」里。引用已经排成结构了，
  // 剩下那半个「」是标点残渣，不是内容
  const tail = text.slice(m.index + m[0].length).replace(/^」/, '')

  const cut = tail.indexOf(ASIDE_MARK)
  const aside = cut < 0 ? '' : tail.slice(cut + ASIDE_MARK.length).trim()
  const rest = cut < 0 ? tail : tail.slice(0, cut)

  // 引用前面**只留说完整了的句子**。引出引用的那半句连接词（「当前归档规则栈的
  // 判定是」）在引用被抬成结构之后就没有下文了，留着比去掉更难读。
  // 判据是句号，不是一张连接词表——后端换个说法这里不用跟着改。
  const kept = head.slice(0, head.lastIndexOf('。') + 1)

  return {
    rule: { ref: `${m[1]!} #${m[2]!}`, name: m[3] ?? null, result: m[4]!.trim() },
    text: `${kept}${rest}`.trim(),
    aside: aside === '' ? null : aside,
  }
}

/* ── 主持人这一栏 ─────────────────────────────────────────────── */

/**
 * 搬去了 `lib/host.ts`：内容预览页的抬头也要用它（那里原来把同一串 32 位 id
 * 原样上屏）。这里原样转出去，会议记录页的 import 一个字不用改。
 */
export type { HostSource, HostView } from '@/lib/host'
export { HOST_MISSING_LABEL, HOST_UNKNOWN_LABEL, hostLabel, hostView, shortHostId } from '@/lib/host'

/* ── 「已授权给」这一栏画哪一种 ───────────────────────────────── */

export type GrantCellKind =
  | { kind: 'expired' }
  | { kind: 'na' }
  | { kind: 'wait' }
  | { kind: 'denied'; hand: boolean }
  | { kind: 'grantable' }
  | { kind: 'unknown' }

/**
 * 「已授权给」这一栏该画成什么。**这是展示分类，不是状态推导**——它只回答
 * 「现在这一格长什么样、能不能点出授权面板」，不推导任何写操作之后的状态。
 *
 * 生命周期原因先答（spec.md §6.1：它们优先于权限原因）。之后**判据是
 * `m.allow` 本身，不是理由的 `by`**：只按 `by` 判会开一个反向的洞——
 * `allow: 'deny'` 配 `by: 'rule'` 的行会落到 `grantable`，画成「＋ 授权给…」
 * 而且真能把授权发出去。`by` 只决定文案。
 *
 * `allow` 是个认不出的取值时落到 `unknown`——**不落到 grantable**。
 * 授权是数据出企业边界的闸门，闸门在读不懂状态时必须是关着的。
 */
export function grantCellKind(m: AdminMeeting): GrantCellKind {
  const by = m.why.allow.by
  if (m.keep.filesGone || by === 'expired') return { kind: 'expired' }
  if (by === 'na' || m.fetch === 'none') return { kind: 'na' }
  if (by === 'wait' || m.archive !== 'done') return { kind: 'wait' }
  const allow = allowView(m.allow)
  if (allow === 'deny') return { kind: 'denied', hand: m.hand.includes('allow') }
  if (allow === 'allow') return { kind: 'grantable' }
  return { kind: 'unknown' }
}

/** 授权面板 / 批量条上说明「这一场为什么会被跳过」。返回 null = 不会跳过。 */
export function grantSkipReason(m: AdminMeeting): string | null {
  switch (grantCellKind(m).kind) {
    case 'denied':
      return '规则禁止，将跳过'
    case 'expired':
      return '已到期，将跳过'
    case 'na':
      return '无资产，将跳过'
    case 'wait':
      return '未归档，将跳过'
    case 'unknown':
      return '状态未知，将跳过'
    default:
      return null
  }
}

/* ── 其他 ─────────────────────────────────────────────────────── */

/** `grants` 存的是采集程序 id，显示名要现查——查不到就退回 id，不显示空白。 */
export function programName(programs: readonly ServiceProgram[], id: string): string {
  return programs.find((p) => p.id === id)?.name ?? id
}

/** 八类资产的「已拿到 / 应有」合计。某个键不出现＝该类不适用，不参与计数。 */
export function assetTotals(m: AdminMeeting): { got: number; total: number } {
  let got = 0
  let total = 0
  for (const v of Object.values(m.assets)) {
    got += v.got
    total += v.total
  }
  return { got, total }
}

/**
 * 会议标题。库里是 NULL 时后端给空串并在 `missing` 里标出来——
 * 直接渲染空串会让「这场会议没标题」和「元数据没拉回来」在界面上长得一模一样。
 */
export function meetingTitle(m: AdminMeeting): string {
  if (m.missing.includes('title')) return '（标题未取到）'
  return m.title === '' ? '（无标题）' : m.title
}

/**
 * 「已延长过几次」那一句。**`extendedSource === 'floor'` 时它只是下界**——
 * 审计是从阶段 4 · T8 才开始记延长操作的，在那之前延长过的会议数不出真实次数，
 * 后端报 1 并把这件事标在 `extendedSource` 上。把下界渲染成「已延长 1 次」
 * 就是把一个「至少」说成了「正好」。
 *
 * 「延长了多少天」只看 `extendedDays`，**不要拿次数乘 30**：一次延长几天是
 * 可以指定的。
 */
export function extendedText(keep: AdminMeeting['keep']): string | null {
  if (keep.extended <= 0) return null
  const head = keep.extendedSource === 'floor' ? '至少延长过' : '已延长'
  return `${head} ${keep.extended} 次，共 ${keep.extendedDays} 天`
}

/** 一场会议的写操作定位。周期性会议靠 `subMeetingId` 区分场次。 */
export function refOf(m: AdminMeeting): { meetingId: string; subMeetingId: string } {
  return { meetingId: m.meetingId, subMeetingId: m.subMeetingId }
}
