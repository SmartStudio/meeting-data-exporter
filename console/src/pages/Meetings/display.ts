import type { AdminMeeting } from '@/api/admin/meetings'
import type { ServiceProgram } from '@/api/admin/grants'
import type { StatusDotState } from '@/ui/StatusDot'
import { STATUS_DOT_LABEL } from '@/ui/StatusDot'

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
