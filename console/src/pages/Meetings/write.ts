import type { Consumer, Meeting, Why, WhyKind } from '@/api/types'

/**
 * 会议记录页所有写操作的**唯一收口**。
 *
 * 为什么要有这个文件：「改了状态却不改与之绑定的理由」在这个计划里已经栽过四次
 * （T2 的种子数据、T6 的 `FetchState` 缺 `'off'`、批量写操作一处都不更新 `why`、
 * 关掉拉取连带改 `archive` 却不记 `hand`）。每次都是同一个形状——某条写路径只
 * 维护它直接改的那个字段，把 `why` / `hand` / 连带失效留在原地，于是同一行里
 * 圆点说「已完成」、理由说「失败」、分诊条把它算进「待授权」、点授权又被挡回
 * 「需要先归档成功」。
 *
 * 所以这里定死一条规矩：**页面里任何改 `fetch` / `archive` / `grants` / `keep`
 * 的地方都必须经过 `applyWrite`**，单行路径和批量路径共用同一套推导，不许各写
 * 一份。判定谁能被授权（`grantCellKind`）和理由该归哪一类（`allowWhyKind`）也
 * 放在这里，因为它们必须和写操作看同一份规则——分开放就是下一次说法打架的起点。
 */

/** 本地保留窗口的长度。延长一次多加一个完整窗口。 */
export const KEEP_DAYS = 30

export type Stage = 'fetch' | 'archive'

const STAGE_NAME: Record<Stage, string> = { fetch: '拉取', archive: '归档到 NAS' }

const CLEARED_KEEP: Meeting['keep'] = {
  archivedAt: null,
  expiresAt: null,
  extended: 0,
  filesGone: false,
}

/** 按自然日加天数（用 `Date` 的月末进位，避免夏令时环境下的整点漂移）。 */
export function addDays(unixSec: number, days: number): number {
  const d = new Date(unixSec * 1000)
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes()).getTime() / 1000,
  )
}

function withHand(hand: Meeting['hand'], stage: Stage): Meeting['hand'] {
  return hand.includes(stage) ? hand : [...hand, stage]
}

/** `grants` 存的是 `Consumer.id`，显示名要现查——查不到就退回 id，不显示空白。 */
export function consumerName(consumers: Consumer[], id: string): string {
  return consumers.find((c) => c.id === id)?.name ?? id
}

/* ── 判定：状态决定理由归哪一类 ──────────────────────────────── */

/**
 * 「能不能授权」的理由该归到哪一类，**只看状态**。
 *
 * 生命周期原因优先于权限原因（spec.md §6.1）：本地文件已清理、没有录制、
 * 还没归档成功——这三种情况下没有任何规则参与判断，不能说成「规则禁止采集」。
 */
export type AllowWhyKind = 'expired' | 'na' | 'wait' | 'deny' | 'rule'

export function allowWhyKind(m: Meeting): AllowWhyKind {
  if (m.keep.filesGone) return 'expired'
  if (m.fetch === 'none') return 'na'
  if (m.archive !== 'done') return 'wait'
  if (m.allow === 'deny') return 'deny'
  return 'rule'
}

/**
 * 归档阶段的理由里**能由状态定死**的那几类。返回 `null` 表示状态不足以断定
 * （`blocked` 到底是哪条规则拦的、`done` 是规则还是人工，只有数据源知道）。
 */
export function archiveWhyKind(m: Meeting): WhyKind | null {
  if (m.archive === 'none') return 'na'
  if (m.archive === 'failed') return 'fail'
  if (m.archive !== 'done' && m.fetch !== 'done') return 'wait'
  return null
}

export type GrantCellKind =
  | { kind: 'expired' }
  | { kind: 'na' }
  | { kind: 'wait' }
  | { kind: 'denied'; hand: boolean }
  | { kind: 'grantable' }

/**
 * 「已授权给」这一栏该画成什么，以及**这场会议这次会不会被真的改到**——
 * 表格、授权浮层、批量确认三处共用同一个谓词。
 *
 * 生命周期原因先答（见 `allowWhyKind`）。之后**判据是 `m.allow` 本身，不是理由
 * 的 `by`**：只按 `by` 判会开一个反向的洞——`allow: 'deny'` 配 `by: 'rule' | 'hand'`
 * 的行会落到 `grantable`，画成「＋ 授权给…」而且真能授权出去。`by` 只决定文案。
 */
export function grantCellKind(m: Meeting): GrantCellKind {
  const by = m.why.allow.by
  if (by === 'expired' || m.keep.filesGone) return { kind: 'expired' }
  if (by === 'na') return { kind: 'na' }
  if (by === 'wait' || m.archive !== 'done') return { kind: 'wait' }
  if (m.allow === 'deny') return { kind: 'denied', hand: by === 'hand' }
  return { kind: 'grantable' }
}

/* ── 写 ─────────────────────────────────────────────────────── */

export type MeetingWrite =
  | { op: 'stage'; stage: Stage; next: 'done' | 'off' }
  | { op: 'grants'; next: string[] }
  | { op: 'extend' }

export interface WriteCtx {
  /** 「现在」的 unix 秒——归档成功的那一刻，本地保留期从这里起算。 */
  nowSec: number
  consumers: Consumer[]
}

/**
 * 判断某次写操作会不会真的改到这场会议。批量条要用它数「已对 N 场执行」，
 * `applyWrite` 自己也用它兜底——**看得见的数字和真正改掉的行必须是同一批**。
 */
export function canWrite(m: Meeting, w: MeetingWrite): boolean {
  if (w.op === 'extend') return m.keep.expiresAt !== null && !m.keep.filesGone
  if (w.op === 'grants') {
    // 收回授权任何时候都允许；发出授权必须过 grantCellKind 这一关。
    if (w.next.length === 0) return m.grants.length > 0
    return grantCellKind(m).kind === 'grantable'
  }
  const cur = w.stage === 'fetch' ? m.fetch : m.archive
  if (cur === 'none') return false // 压根没有录制，没有可操作的资产
  if (w.stage === 'archive' && w.next === 'done' && m.fetch !== 'done') return false // 归档要等拉取
  return cur !== w.next
}

/**
 * 施加一次写操作。**状态与理由在这里一起变，没有第二个出口。**
 * 前置条件不满足的一律原样返回（`canWrite` 是同一套判据）。
 */
export function applyWrite(m: Meeting, w: MeetingWrite, ctx: WriteCtx): Meeting {
  if (!canWrite(m, w)) return m

  if (w.op === 'extend') {
    // 只动保留窗口、不动任何阶段状态——所以一个理由都不用改。
    return {
      ...m,
      keep: {
        ...m.keep,
        expiresAt: m.keep.expiresAt === null ? null : addDays(m.keep.expiresAt, KEEP_DAYS),
        extended: m.keep.extended + 1,
      },
    }
  }

  const next = w.op === 'grants' ? { ...m, grants: w.next } : setStage(m, w.stage, w.next, ctx.nowSec)
  return { ...next, why: { ...next.why, allow: nextAllowWhy(next, m.why.allow, ctx.consumers) } }
}

function handWhy(stage: Stage, on: boolean): Why {
  return { by: 'hand', text: `陈运维 刚刚手动${on ? '执行' : '关闭'}了${STAGE_NAME[stage]}，覆盖了规则。` }
}

/** 阶段状态 + 该阶段的理由 + 人工改写环 + 连带失效，四件事一次做完。 */
function setStage(m: Meeting, stage: Stage, next: 'done' | 'off', nowSec: number): Meeting {
  const on = next === 'done'

  if (stage === 'fetch') {
    if (!on) {
      // 关掉拉取，后面所有阶段跟着失效——没拉下来的东西谈不上归档和授权。
      // **被连带改掉的阶段同样要留下人工改写环和新的理由**：状态说「未执行」、
      // 理由却还写着「已成功写入 NAS 并校验哈希」，正是这一页栽过的那类洞。
      return {
        ...m,
        fetch: 'off',
        archive: 'off',
        grants: [],
        keep: { ...CLEARED_KEEP, filesGone: m.keep.filesGone },
        hand: withHand(withHand(m.hand, 'fetch'), 'archive'),
        why: {
          ...m.why,
          fetch: handWhy('fetch', false),
          archive: { by: 'hand', text: '陈运维 关闭了拉取，归档随之失效。' },
        },
      }
    }
    return {
      ...m,
      fetch: 'done',
      hand: withHand(m.hand, 'fetch'),
      why: {
        ...m.why,
        fetch: handWhy('fetch', true),
        // 重新拉取不等于重新归档。归档还停在原地，但它的旧理由（「未拉取，
        // 无从归档」/「关闭了拉取」）刚刚失效了，要一并换掉。
        archive:
          m.archive === 'off'
            ? { by: 'hand', text: '拉取已重新执行，归档尚未重跑。' }
            : m.why.archive.by === 'wait'
              ? { by: 'wait', text: '拉取刚刚完成，归档尚未执行。' }
              : m.why.archive,
      },
    }
  }

  return {
    ...m,
    archive: next,
    grants: on ? m.grants : [],
    // 关掉归档＝保留期作废，但 `filesGone` 是磁盘上的事实（本地文件真的被到期
    // 清理掉了），不是归档阶段的附属状态，不能顺手抹掉。
    keep: on
      ? { archivedAt: nowSec, expiresAt: addDays(nowSec, KEEP_DAYS), extended: 0, filesGone: false }
      : { ...CLEARED_KEEP, filesGone: m.keep.filesGone },
    hand: withHand(m.hand, 'archive'),
    why: { ...m.why, archive: handWhy('archive', on) },
  }
}

/**
 * 授权理由跟着状态走。
 *
 * 两条保命规矩：
 * 1. **人工改写优先于所有规则**（spec.md §5）——状态还是 deny 的话，不要把
 *    「已人工设为禁止」改写成「规则禁止」。
 * 2. **分类没变就保留原文**——数据源给的理由（命中哪条规则、超时多少秒）
 *    比我们现编的准，只有分类真的变了才换。`rule` 是例外：它的文字里带着
 *    被授权的程序名，授权一变就得重写。
 */
function nextAllowWhy(m: Meeting, prev: Why, consumers: Consumer[]): Why {
  const by = allowWhyKind(m)
  if (by === 'deny' && prev.by === 'hand') return prev
  if (by === prev.by && by !== 'rule') return prev
  if (by === 'rule') {
    const text =
      m.grants.length > 0
        ? `权限规则准许采集，已授权给 ${m.grants.map((id) => consumerName(consumers, id)).join('、')}。`
        : '权限规则允许采集，但还没有授权给任何程序——外部现在取不到。'
    return prev.by === 'rule' && prev.text === text ? prev : { by, text }
  }
  return { by, text: ALLOW_WHY_TEXT[by] }
}

const ALLOW_WHY_TEXT: Record<'expired' | 'na' | 'wait' | 'deny', string> = {
  expired: '本地文件已到期清理，授权自动失效。历史数据请到 NAS 取。',
  na: '这场会议没有录制，没有可授权的资产。',
  wait: '尚未归档成功，保留期没有开始计时，没有可授权的资产。',
  deny: '权限规则禁止采集。已归档进 NAS，但任何程序都取不到。',
}
