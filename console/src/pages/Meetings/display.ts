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

/* ── 主持人这一栏 ─────────────────────────────────────────────── */

/**
 * 主持人一格该显示什么。
 *
 * ## 为什么需要这个函数
 *
 * `m.host` 是主持人的 **userid**，真实取值长这样：
 * `woaJARCQAAt_hKBw--YKZeVjEaIMGFQQ`。这一列此前直接渲染它，于是每一行都有
 * 一串 32 位机器码，占掉表格约五分之一的宽度，而且**这些行带批量勾选框**
 * ——只认得 id 的人没法在勾选前确认自己勾的是谁的会议。
 *
 * ## 三条路径，且中间那条是常态
 *
 * 1. 库里就没有主持人（`missing` 里有 `host`）→ 说「未取到」，不是空白；
 * 2. **查不到姓名**（`hostName === null`）→ 降级：说清这是「未知主持人」，
 *    再挂一截 id 的尾巴让两行区分得开，全量 id 放进 `title` 供复制。
 *    身份映射在本部署里一行都没有，所以**这条就是当前唯一会跑到的路径**；
 * 3. 查到了 → 显示姓名，全量 id 仍进 `title`（排查时只有它有用）。
 *
 * ## 为什么降级不是「直接显示 id」，也不是「显示一个占位符」
 *
 * 直接显示 id：那正是要修的问题——一串主键被当成人名读。
 * 只显示「未知主持人」：一屏里十几行长得一模一样，分不出这是不是同一个人，
 * 而「这几场是不是同一个人主持的」恰好是勾选前要判断的事。
 * 所以取尾 6 位——足够把不同的人分开，又短到不会被误读成姓名。
 */
export interface HostView {
  /** 主文本。姓名，或者「未知主持人」/「未取到」 */
  text: string
  /** 跟在主文本后面那截 id 尾巴。查到姓名或压根没有 id 时是 null */
  tail: string | null
  /** 原生 title：全量 id 供复制。没有 id 可给时是 null */
  title: string | null
  /** `text` 是不是一个真的姓名。样式据它决定，别让「未知主持人」长得像人名 */
  resolved: boolean
}

/** 尾巴取几位。6 位 base64 ≈ 3.6 万种取值，一屏之内撞车的概率可以忽略 */
const HOST_TAIL_LEN = 6
/** 短到这个长度以内的 id 整串显示——给它掐头去尾反而更难认 */
const HOST_SHORT_MAX = 12

export function shortHostId(host: string): string {
  return host.length <= HOST_SHORT_MAX ? host : `…${host.slice(-HOST_TAIL_LEN)}`
}

export const HOST_MISSING_LABEL = '未取到'
export const HOST_UNKNOWN_LABEL = '未知主持人'

export function hostView(m: AdminMeeting): HostView {
  if (m.missing.includes('host') || m.host === '') {
    return { text: HOST_MISSING_LABEL, tail: null, title: null, resolved: false }
  }
  if (m.hostName !== null && m.hostName !== '') {
    return { text: m.hostName, tail: null, title: `主持人 ID：${m.host}`, resolved: true }
  }
  return {
    text: HOST_UNKNOWN_LABEL,
    tail: shortHostId(m.host),
    title: `主持人 ID：${m.host}\n姓名查不到——企业通讯录还没有同步过来`,
    resolved: false,
  }
}

/** 一行文本形式的主持人。用在详情、授权面板这类不分两段排版的地方 */
export function hostLabel(m: AdminMeeting): string {
  const v = hostView(m)
  // 离开「主持人」那一列之后就没有列头了，光说「未取到」不知道说的是哪一样东西
  if (v.text === HOST_MISSING_LABEL) return `主持人${HOST_MISSING_LABEL}`
  return v.tail === null ? v.text : `${v.text} · ${v.tail}`
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
