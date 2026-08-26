/**
 * A2 · 会议查询 API（阶段 4 · T5）。
 *
 * ```
 * GET /api/v1/admin/meetings          列表（分页 / 搜索 / 筛选）
 * GET /api/v1/admin/meetings/triage   分诊条五计数
 * GET /api/v1/admin/meetings/:id      单场详情（why 三段 + 操作历史）
 * ```
 *
 * ## 这一层做的是「叠加」，不是「再查一遍」
 *
 * `ConsoleMeetingsStore`（T1）已经把 `meetings` / `meeting_assets` /
 * `meeting_archives` / `meeting_grants` / `meeting_overrides` 五张表拼成了
 * `ConsoleMeetingRow`，字段名与契约（`console/src/api/types.ts` 的 `Meeting`）对齐。
 * 它**刻意没产出**四个字段——它们要么需要求值规则、要么要读 `audit_log`：
 *
 * | 契约字段 | 本文件怎么给 |
 * | --- | --- |
 * | `allow` / `why.allow` | 采集权限栈的判定，走 `explainMeetingAccess` / `evaluateInventory`（见下） |
 * | `why.fetch` | `evaluateFetchStack` + `applyOverride`，与 `src/worker/fetch-policy.ts` 同源 |
 * | `why.archive` | `evaluateArchiveStack` + `applyOverride`，与 `src/worker/archive.ts` 同源 |
 * | `history` | `AuditQueryStore.listForMeeting`，**只在详情端点**（见 `getMeeting`） |
 *
 * store 给的 `fetch` / `archive` 是**库里看得见的那一半**：`'off'`（被人工改写关掉）
 * 给得出来，`'blocked'`（规则做的决定）永远不会从 store 返回。本文件用同一套
 * `evaluate*Stack` 把 `'blocked'` 叠上去——但**只叠归档那一栈**，理由见 `overlayArchive`。
 *
 * ## `why.fetch` 从「说不出」变成一次真判定（A7 / T12 的收尾）
 *
 * 本文件最初按计划 §0 E-c 对拉取阶段一律报 `na`，理由是当时
 * `evaluateFetchStack` 全仓库只有一个引用点（影响预览），worker 的 discovery 走的
 * 仍是「按时间窗发现全部录制」——**没有任何一条拉取规则参与过真实的拉取决策**，
 * 报「由规则 #3 决定」而 #3 从没跑过，比不说更糟。
 *
 * T12 把那条线接上了（`src/worker/fetch-policy.ts`），所以这里改成真判定：
 * 与 worker 读同一批规则、调同一个 `evaluateFetchStack` + `applyOverride`，
 * 连"规则集为空时顶上兼容兜底"这一步也走同一个 `fetchRulesInEffect`。
 * **两处各判一遍必然分叉**，分叉的表现是界面说"这场被规则拦下了"而 worker 其实拉了它。
 *
 * 仍然报 `na` 的只剩两种情况，且两种都不是"某条规则做的决定"：
 * 会议元数据查不到（规则根本没跑过），以及**库里一条启用的拉取规则都没有**
 * ——后者 worker 走兼容模式全拉，那句解释是共用的
 * `FETCH_STACK_UNCONFIGURED_REASON`，不在本文件里另写一份。
 *
 * ## 「准许采集」在没有采集程序的前提下是什么意思
 *
 * 契约的 `Meeting.allow` 是一场会议一个值，而采集权限栈的主体是**采集程序**
 * （`policy/stacks.ts` 的 `checkSubject`），一条规则只对 `subject_value` 那个程序生效。
 * 「规则判 allow」离开程序就没有意义。
 *
 * 这里沿用 T1 给分诊条「待授权」那一格定下的同一条裁定（见
 * `console-meetings.ts` 的 `awaitingGrantKeys`）：**「准许采集」= 至少有一个采集程序
 * 会被判 allow**，候选程序取「启用的 allow 规则上出现过的 `subject_value`」。
 * **两处必须是同一条裁定**，否则分诊条数出来的「待授权 4 场」与列表里那 4 行的
 * `allow` 值会打架——管理员点进那一格，看到的是一批显示「禁止采集」的会议。
 *
 * ## 列表为什么不逐行调 `explainMeetingAccess`
 *
 * 验收判据 2 要求 `why.allow` 走 `explainMeetingAccess`，理由是「两处各判一遍
 * 必然分叉，分叉的表现是『详情抽屉说准许、程序取的时候被拒』」。**详情端点照做**。
 *
 * 列表端点不能照抄：`explainMeetingAccess` 是**单场**入口，它内部是
 * 「gather（4–5 条查询）+ `evaluateInventory`」。一页 50 行 × 候选程序数 P，
 * 就是 50P 次调用、几百条查询——而 T1 刚把「列一页的查询数与行数无关」做成了
 * 它的验收判据。所以列表走的是**同一个纯函数** `evaluateInventory`，原料由本文件
 * 整页批量取一次（规则 3 次、归档 1 次、改写 1 次、会议元数据 1 次）。
 *
 * 这不是「再判一遍」：`explainMeetingAccess` 本身就是
 * `gather` + `evaluateInventory`，两条路径落到的是同一段判定代码、同一批原料，
 * 结论不可能不同。`tests/http/console-meetings.test.ts` 里有一条用例同时打两个端点、
 * 断言 `allow` 与 `why.allow` 逐字相同，钉的就是这件事。
 */

import { GATEWAY_TYPE_TO_ASSET_KEY, type AssetKey } from '@yaowu/mde-engine'
import { isVisible, meetingFacts, type MeetingMeta } from '../../../policy/access'
import {
  applyOverride,
  indexOverrides,
  wasOverridden,
  type MeetingOverride as PolicyOverride,
  type MeetingOverrideSet,
  type OverriddenDecision,
} from '../../../policy/override'
import {
  evaluateArchiveStack,
  evaluateFetchStack,
  type AllowEffect,
  type ArchiveEffect,
  type FetchEffect,
  type StackRule,
} from '../../../policy/stacks'
import { archiveStateKey } from '../../../store/archives'
import type { AuditRecord } from '../../../store/audit'
import {
  ARCHIVE_GRACE_SEC,
  parseConsoleMeetingId,
  type ArchiveState,
  type ConsoleMeetingRow,
  type FetchState,
  type MeetingQuery,
  type TriageBucket,
} from '../../../store/console-meetings'
import type { MeetingKey } from '../../../store/grants'
import {
  FETCH_STACK_UNCONFIGURED_REASON,
  fetchRulesInEffect,
  fetchStackUnconfigured,
} from '../../../policy/fetch-compat'
import { evaluateInventory, explainMeetingAccess } from '../../../worker/visibility'
import { requireAdminAuth } from '../../middleware'
import { json } from '../../respond'
import type { RouteCtx } from '../../router'

// ── 契约形状（与 console/src/api/types.ts 逐字一致）──────────────────────

/**
 * 判定理由的来源。呈现样式由它决定，取值与契约的 `WhyKind` 逐字一致——
 * 这里重新声明而不是 import，与 `console-meetings.ts` 同一个理由：
 * `console/` 是独立的 npm 工程，跨不过去。
 *
 * `deny` **专指「有一条规则明确拒绝」**，只能配 `allow: 'deny'` 用。
 * 兜底 deny（没有任何规则匹配）不算——那不是某条规则做的决定，报 `deny`
 * 会让管理员去找那条根本不存在的规则。
 */
type WhyKind = 'rule' | 'hand' | 'fail' | 'expired' | 'wait' | 'na' | 'deny'

interface Why {
  by: WhyKind
  text: string
}

type AllowState = 'allow' | 'deny'

/**
 * 下发给控制台的一场会议。`ConsoleMeetingRow` 的四个后端事实字段
 * （`meetingId` / `subMeetingId` / `missing` / `unknownAssetTypes`）与
 * `keep.extendedDays` / `keep.extendedSource` / `keep.retentionDays` 一并带出去：
 * 契约里没有它们，前端会忽略，**但少一个字段前端就崩**，多的不会。
 *
 * `keep.extendedSource` 尤其别裁——它回答的是「`extended` 这个次数准不准」
 * （阶段 4 · T17）。裁掉之后一个「至少延长过 1 次」的下界会被渲染成
 * 「已延长 1 次」，看起来是准确值。
 *
 * `missing` 尤其不该被裁掉——它回答的是「这场会议的标题是空的，还是元数据没拉回来」，
 * 而这两件事在界面上长得一模一样。
 */
interface ApiMeeting extends ConsoleMeetingRow {
  allow: AllowState
  why: { fetch: Why; archive: Why; allow: Why }
  history: Array<{ at: number; text: string }>
}

// ── 常量 ──────────────────────────────────────────────────────────────────

/**
 * 单页上限。**与 `console-meetings.ts` 的 `MAX_LIMIT` 是同一个数**（那边没导出）。
 *
 * 超了直接 400，不跟着 store 一起静默钳制：钳制会让翻页算错——客户端以为一页
 * 1000 条、实际拿到 500，`offset += 1000` 之后中间那 500 场会议谁都看不见，
 * 而界面上一切正常。
 */
const MAX_LIMIT = 500

/** 不给 limit 时的页大小。同样与 `console-meetings.ts` 的 `DEFAULT_LIMIT` 是同一个数——
 *  回显给客户端是为了让翻页有个确定的步长，回显实际行数会在最后一页把步长报小 */
const DEFAULT_LIMIT = 50

const TRIAGE_BUCKETS: readonly TriageBucket[] = [
  'archiveFailed',
  'expiringIn7d',
  'awaitingGrant',
  'inProgress',
  'nasOnly',
]

/**
 * 八类资产的中文名。**来源是 spec §6.2 那张表**，只用于审计历史那一句人话
 * （「取走了 AI 纪要」）。
 *
 * 键用契约的 `AssetKey`，不是网关的 `asset_type`——原型 HTML 里那套短名
 * （`summary` / `aitr` / `digest`）一个字都不许进代码，同一批资产在这个项目里
 * 已经有过三套叫法，M3.5 为此吃过一次亏（dev-plan §5 C7）。
 */
const ASSET_LABEL: Record<AssetKey, string> = {
  video: '录像',
  audio: '音频',
  transcript: '完整转写',
  ai_transcript: 'AI 转写',
  ai_minutes: 'AI 纪要',
  ai_topic_minutes: '话题纪要',
  ai_speaker_minutes: '发言人纪要',
  ai_ds_minutes: '会议摘要',
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/** unix 秒读成一句人话，只为进判定理由。不做本地化，UTC 就是审计里的口径
 *  （与 `src/worker/visibility.ts` 的 `stamp` 同一口径，两处显示的时间不该不一样） */
function stamp(sec: number): string {
  return `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

function keyOf(k: MeetingKey): string {
  return archiveStateKey(k.meetingId, k.subMeetingId)
}

/**
 * 候选采集程序：启用的 allow 规则上出现过的 `subject_value`。
 *
 * **与 `console-meetings.ts` 的 `awaitingGrantKeys` 逐字同一套推导**（含「一条规则
 * 都没有时用 `['']` 再跑一轮」这一条）。那一轮不是多余的：人工改写**优先于所有规则**
 * （spec §5.4），一条把 deny 翻成 allow 的改写不需要任何规则存在就能生效，
 * 空 programId 让规则侧全部判不适用、改写照样套得上去（`applyOverride` 是替换语义）。
 *
 * 没有规则指向的程序永远走兜底 deny，把它算进来也不会改变任何一场会议的结论，
 * 所以枚举源取规则而不是 `service_accounts` 全表。
 */
function candidatePrograms(allowRules: readonly StackRule[]): string[] {
  const out: string[] = []
  for (const r of allowRules) {
    const v = r.subjectValue ?? ''
    if (r.subjectType === 'program' && v !== '' && !out.includes(v)) out.push(v)
  }
  return out.length > 0 ? out : ['']
}

/** 一个候选程序对这场会议的判定。`decision` 为 null = 会议元数据查不到，规则根本没跑过 */
interface AllowVerdict {
  programId: string
  decision: OverriddenDecision<AllowEffect> | null
}

/**
 * 把若干程序的判定收成契约要的一个 `allow` + 一句 `why.allow`。
 *
 * **列表与详情共用这一个函数**：两个端点取判定的路径不同（批量的
 * `evaluateInventory` / 单场的 `explainMeetingAccess`），落到文案上必须一模一样，
 * 否则同一场会议在表格里和抽屉里会显示成两句话。
 */
function summarizeAllow(verdicts: readonly AllowVerdict[]): { allow: AllowState; why: Why } {
  const passed = verdicts.find((v) => v.decision !== null && isVisible(v.decision))
  if (passed !== undefined && passed.decision !== null) {
    return {
      allow: 'allow',
      why: {
        // 改写优先于所有规则，管理员最需要知道的就是「这一条不是规则说的」
        by: wasOverridden(passed.decision) ? 'hand' : 'rule',
        text: withProgram(passed.programId, passed.decision.reason),
      },
    }
  }

  const judged = verdicts.filter((v) => v.decision !== null)
  if (judged.length === 0) {
    // 判不出来就落到拒绝一侧，**并且说出是判不出来**——不是静默放行，也不是编一个判定
    return {
      allow: 'deny',
      why: {
        by: 'na',
        text:
          '这场会议在 meetings 表里查不到元数据（标题、主持人、时间），' +
          '采集权限规则求值所需的事实取不到，无从判定，按拒绝处理。' +
          '这多半是数据完整性问题，不是某条规则做出的决定。',
      },
    }
  }

  const example = judged[0]!
  const decision = example.decision!
  const by: WhyKind = wasOverridden(decision)
    ? 'hand'
    : // 元数据不全、规则判不出来（阶段 4 · T13）：与上面那条「表里查不到」是同一件事的
      // 另一种形态，报 `na` ——它不是某条规则做出的决定，管理员去改规则改不动它。
      // 报 `rule` 会把他送去自动规则页找一条并不存在的规则。
      decision.source === 'undecidable'
      ? 'na'
      : // deny 只配「有一条规则明确拒绝」用：兜底（source='default'）与
        // 「规则判 allow 却一类合法资产都没列出」都不是明确拒绝，报 rule
        decision.source === 'rule' && decision.effect === 'deny'
        ? 'deny'
        : 'rule'

  const head =
    verdicts.length > 1
      ? `考察过的 ${verdicts.length} 个采集程序（${verdicts.map((v) => v.programId).join('、')}）没有一个被准许采集这场会议。以「${example.programId}」为例：`
      : ''
  return { allow: 'deny', why: { by, text: `${head}${withProgram(example.programId, decision.reason)}` } }
}

/** 判定理由前面挂上是哪个程序的判定。程序 id 为空串（一条 allow 规则都没有）时不挂——
 *  `采集程序「」` 读起来像个 bug，而兜底的 reason 里已经写了「采集程序 未指定」 */
function withProgram(programId: string, reason: string): string {
  return programId === '' ? reason : `采集程序「${programId}」：${reason}`
}

// ── 阶段状态与理由的叠加 ──────────────────────────────────────────────────

/** 叠加需要的原料。列表整页取一次，详情取一场 */
interface StageMaterial {
  now: number
  /** **库里**启用的拉取规则。为空 = 兼容模式，见 `fetchWhy` 与 `fetchRulesInEffect` */
  fetchRules: readonly StackRule[]
  archiveRules: readonly StackRule[]
  /**
   * 会议元数据。查不到时 undefined——**不造空壳顶上**，见 `VisibilityDeps.getMeetings`。
   * 查得到但元数据不全的行带着 `missingFacts`，归档栈据此判「判不出来」（阶段 4 · T13）。
   */
  meta: MeetingMeta | undefined
  overrides: MeetingOverrideSet
}

/**
 * 归档阶段的 `'blocked'`。
 *
 * **只在 `'running'` / `'failed'` 两个状态上叠**，理由分两半：
 *
 * - `'done'` / `'off'` 不叠：前者已经归档完了（归档规则后来改成 skip 也不能追认成
 *   「被拦下」，NAS 上的副本还在），后者是人关的、契约里 `off` 与 `blocked` 的分工
 *   就是「人关的」与「规则关的」。
 * - `'none'` 不叠：那是「一个下载完成的资产都没有」。归档流水线
 *   （`archivePendingMeetings`）只处理有 completed 资产的会议，**这场会议的归档规则
 *   从来没跑过**。报 `blocked` 就是 E-c 那件事的翻版：宣称一次没发生过的判定。
 *
 * 反过来，`'running'` / `'failed'` 上必须叠：归档规则判 skip 的会议本地资产齐了、
 * 却永远进不了 `meeting_archives`，store 会先给 `'running'`，过了 6 小时宽限翻成
 * `'failed'`——而 `'failed'` 是分诊条**最高级别的红色告警**（「到期会永久丢失」）。
 * 不叠这一层，每一场被规则拦下的会议都会变成一条假警报，真正的归档故障淹死在里面。
 */
function overlayArchive(
  state: ArchiveState,
  decision: OverriddenDecision<ArchiveEffect> | null,
): ArchiveState {
  if (state !== 'running' && state !== 'failed') return state
  if (decision !== null && decision.effect === 'skip') return 'blocked'
  return state
}

/**
 * 拉取阶段的 `'blocked'`（阶段 4 · T12 接上之后才有意义）。
 *
 * **只在 `'none'` 上叠**，与 `overlayArchive` 恰好相反，理由也恰好相反：
 * 拉取规则是在 discovery 里**先判后拉**的（`src/worker/fetch-policy.ts`），
 * 被判 skip 的会议一条 `meeting_assets` 行都不会有，store 因此给出 `'none'`
 * ——那正是"被规则拦下"的样子。不叠这一层，管理员看到的是一个"无录制"的灰点，
 * 而真相是"有录制，规则不让拉"，这两件事要做的处置完全不同。
 *
 * 其余状态一律不叠：`'done'` / `'running'` 说明资产已经拉了（可能是规则改之前拉的，
 * 规则后来改成 skip 也不能追认成"被拦下"），`'off'` 是人关的——契约里 `off` 与
 * `blocked` 的分工就是"人关的"与"规则关的"。
 *
 * 已知代价，写在这里免得以后当 bug 修：一场**真的没有录制**的会议，若同时被拉取
 * 规则判 skip，也会显示成 `'blocked'`。这是诚实的——规则判 skip 的会议我们压根
 * 没去问过它有没有录制（`fetch-policy.ts` 的枚举那一趟不调 `listAssets`）。
 */
function overlayFetch(
  state: FetchState,
  decision: OverriddenDecision<FetchEffect> | null,
): FetchState {
  if (state !== 'none') return state
  if (decision !== null && decision.effect === 'skip') return 'blocked'
  return state
}

/**
 * 拉取阶段的理由。走 `evaluateFetchStack` + `applyOverride`，
 * 与 `src/worker/fetch-policy.ts` 同源——那边怎么判这场会议拉不拉，这边就怎么显示。
 */
function fetchWhy(
  row: ConsoleMeetingRow,
  stage: StageMaterial,
  decision: OverriddenDecision<FetchEffect> | null,
): Why {
  if (row.fetch === 'off') {
    const reason = stage.overrides.fetch?.reason
    return {
      by: 'hand',
      text:
        `这场会议的拉取被人工关掉了${reason ? `：${reason}` : '（没有填改写说明）'}。` +
        `人工改写优先于所有规则（spec §5.4）。`,
    }
  }

  if (decision === null) {
    return {
      by: 'na',
      text:
        '这场会议在 meetings 表里查不到元数据，拉取规则求值所需的事实取不到，无从判定。' +
        'discovery 遇到同一件事时的处理是不拉（见 src/worker/fetch-policy.ts），不是照拉不误。',
    }
  }

  // 改写不是规则，是一次真发生过的人的决定。它优先于所有规则，也优先于下面
  // 「一条规则都没配」那一支——兼容模式同样认改写（fetch-policy.ts 的文件头）
  if (wasOverridden(decision)) return { by: 'hand', text: decision.reason }

  // 「算不算兼容模式」不在这里再写一个 `length === 0`：与 worker、与影响预览
  // 共用 `fetchStackUnconfigured`，三处漂移的后果就是界面、预览、worker 各说各话
  if (fetchStackUnconfigured(stage.fetchRules)) {
    // 兼容模式：判定确实发生了，但做决定的是一条**合成的**兜底规则，不在库里。
    // 报 `by:'rule'` 会把管理员送去规则页找一条并不存在的规则，那正是 E-c 骂过的事
    return { by: 'na', text: FETCH_STACK_UNCONFIGURED_REASON }
  }

  // 元数据不全、规则判不出来（阶段 4 · T13）：不是某条规则做出的决定，
  // 管理员去改规则改不动它，要去补的是这场会议的元数据
  if (decision.source === 'undecidable') return { by: 'na', text: decision.reason }

  return { by: 'rule', text: decision.reason }
}

/** 归档阶段的理由。走 `evaluateArchiveStack` + `applyOverride`，与 `src/worker/archive.ts` 同源 */
function archiveWhy(
  row: ConsoleMeetingRow,
  state: ArchiveState,
  decision: OverriddenDecision<ArchiveEffect> | null,
  overrides: MeetingOverrideSet,
): Why {
  if (state === 'off') {
    const reason = overrides.archive?.reason
    return {
      by: 'hand',
      text:
        `这场会议的归档被人工关掉了${reason ? `：${reason}` : '（没有填改写说明）'}。` +
        `本地文件到期后不会有 NAS 副本兜底。`,
    }
  }

  if (decision === null) {
    return {
      by: 'na',
      text:
        '这场会议在 meetings 表里查不到元数据，归档规则求值所需的事实取不到，无从判定。' +
        '归档流水线遇到同一件事时的处理是不归档（见 src/worker/archive.ts），不是换个默认目录。',
    }
  }

  if (state === 'done') {
    const at = row.keep.archivedAt
    return {
      by: wasOverridden(decision) ? 'hand' : 'rule',
      text:
        `已归档到 ${row.nasPath ?? '（记录里没有 NAS 路径）'}${at === null ? '' : `（${stamp(at)}）`}。` +
        `当前归档规则栈的判定是「${decision.reason}」——那是此刻这一次求值，不是当初归档时跑的那一次；` +
        `已经写进 NAS 的副本不受规则改动影响。`,
    }
  }

  if (state === 'blocked') return { by: 'rule', text: decision.reason }

  if (state === 'failed') {
    return {
      by: 'fail',
      text:
        `最后一个资产下载完成已超过 ${ARCHIVE_GRACE_SEC / 3600} 小时，仍然没有归档记录。` +
        `归档任务每小时整点跑一次，连续这么多轮都没归成，不是「还没轮到」能解释的。` +
        `归档不成功，本地保留期一到这场会议就**永久**没有了。` +
        `真正的失败原因目前不落库（只走 worker 的 console.error），要等 A4 建 job_failures 才查得到——` +
        `所以这条判据是时间上的启发式，不是一条读出来的失败记录。`,
    }
  }

  if (state === 'none') {
    return {
      by: 'wait',
      text:
        '还没有任何下载完成的资产，归档没有可做的事。归档流水线只处理有 completed 资产的会议，' +
        '所以这场会议的归档规则还一次都没跑过——这里不报规则判定。',
    }
  }

  // running
  return { by: 'wait', text: `资产已下载完成，等待归档任务把它搬到 NAS。${decision.reason}` }
}

// ── 审计历史 ──────────────────────────────────────────────────────────────

/** 一条审计记录读成抽屉里的一行。资产名走 spec §6.2 那张表，认不出的类型原样带出 */
function historyText(r: AuditRecord): string {
  const asset = assetLabel(r.assetType)
  const rule = r.matchedRuleId === null ? '' : `（规则 #${r.matchedRuleId}）`
  const who = `${r.actorId}（${r.actorType}）`

  if (r.action === 'issue_download_url') {
    return r.decision === 'allow'
      ? `${who} 取走了 ${asset}${rule}`
      : `${who} 想取 ${asset}，被拒绝${rule}`
  }
  // 认不出的动作原样带出：管理员写操作的审计（T6–T8）会陆续加进来，
  // 在这里硬编一张动作表意味着每加一个动作就要改这个文件，而漏改的表现是
  // 一条真发生过的操作在抽屉里显示成空白
  return `${who} ${r.action}${asset === '' ? '' : ` · ${asset}`}${r.decision === 'deny' ? '，被拒绝' : ''}${rule}`
}

function assetLabel(assetType: string | null): string {
  if (assetType === null || assetType === '') return ''
  const key = GATEWAY_TYPE_TO_ASSET_KEY[assetType]
  return key === undefined ? assetType : ASSET_LABEL[key]
}

// ── 查询串 ────────────────────────────────────────────────────────────────

type QueryResult = { ok: true; query: MeetingQuery } | { ok: false; response: Response }

/**
 * `?a=b` 读成 `MeetingQuery`。
 *
 * **认不出的取值一律 400，不是悄悄忽略**：`?triage=archivefailed`（大小写写错）
 * 被忽略掉的话，管理员看到的是一整页会议，而他以为自己在看归档失败的那几场。
 */
function parseListQuery(url: URL, now: number): QueryResult {
  const q: MeetingQuery = { now }
  const bad = (error: string, detail: string): QueryResult => ({
    ok: false,
    response: json(400, { error, detail }),
  })

  const search = url.searchParams.get('search')
  if (search !== null && search !== '') q.search = search

  const triage = url.searchParams.get('triage')
  if (triage !== null && triage !== '') {
    if (!TRIAGE_BUCKETS.includes(triage as TriageBucket)) {
      return bad('invalid_triage', `triage 只能是 ${TRIAGE_BUCKETS.join(' / ')}，收到「${triage}」`)
    }
    q.triage = triage as TriageBucket
  }

  for (const name of ['hasGrant', 'hasOverride', 'inRetention'] as const) {
    const raw = url.searchParams.get(name)
    if (raw === null || raw === '') continue
    if (raw !== 'true' && raw !== 'false') {
      return bad('invalid_filter', `${name} 只能是 true / false，收到「${raw}」`)
    }
    // 三态：不给 = 不筛选。给成 false 会把「不筛选」变成「只要没有的那些」
    q[name] = raw === 'true'
  }

  const limit = url.searchParams.get('limit')
  if (limit !== null && limit !== '') {
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return bad('invalid_limit', `limit 必须是 1..${MAX_LIMIT} 的整数，收到「${limit}」`)
    }
    q.limit = n
  }

  const offset = url.searchParams.get('offset')
  if (offset !== null && offset !== '') {
    const n = Number(offset)
    if (!Number.isInteger(n) || n < 0) {
      return bad('invalid_offset', `offset 必须是 >= 0 的整数，收到「${offset}」`)
    }
    q.offset = n
  }

  return { ok: true, query: q }
}

// ── 端点 ──────────────────────────────────────────────────────────────────

export async function listMeetings(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, now)
  if (!auth.ok) return auth.response

  const parsed = parseListQuery(new URL(req.url), now)
  if (!parsed.ok) return parsed.response

  const { rows, total } = await ctx.deps.consoleMeetings.list(parsed.query)
  const rendered = await renderPage(ctx, rows, now)

  return json(200, {
    rows: rendered,
    total,
    limit: parsed.query.limit ?? DEFAULT_LIMIT,
    offset: parsed.query.offset ?? 0,
  })
}

export async function meetingTriage(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, now)
  if (!auth.ok) return auth.response
  return json(200, await ctx.deps.consoleMeetings.triage(now))
}

export async function getMeeting(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, now)
  if (!auth.ok) return auth.response

  // 路径段与 `ConsoleMeetingRow.id` 是一对：`consoleMeetingId` 编、这个解。
  // 只用 meeting_id 的话周期性会议的各场次会撞成同一行。
  //
  // ⚠️ 调用方拼 URL 时必须 `encodeURIComponent(id)` 再拼进路径段：路由派发
  // （`router.ts` 的 `compile`）会对捕获到的路径段做一次 `decodeURIComponent`，
  // 而 `consoleMeetingId` 本身已经把 id 里的字面逗号编成了 `%2C`。少这一次编码，
  // 一个 meeting_id 里真带逗号的会议会被拆成 `(meetingId, subMeetingId)` 两段。
  // 平台给的 id 目前都是纯数字，所以这只是一条写在这里备查的边界。
  const key = parseConsoleMeetingId(ctx.params.meetingId ?? '')
  const row = await ctx.deps.consoleMeetings.get(key.meetingId, key.subMeetingId, now)
  if (row === null) return json(404, { error: 'meeting_not_found' })

  const vis = ctx.deps.meetingVisibility
  const [allowRules, archiveRules, fetchRules, metas, overrideRows] = await Promise.all([
    vis.policy.listEnabledStackRules('allow'),
    vis.policy.listEnabledStackRules('archive'),
    // A7（T12）接线之后 `why.fetch` 是一次真判定，所以这一栈也要取
    vis.policy.listEnabledStackRules('fetch'),
    vis.getMeetings([key]),
    vis.grants.listActiveOverridesForMeetings([key]),
  ])

  // 验收 2：单场走 `explainMeetingAccess`，与采集清单重算（`computeProgramInventory`）
  // 是同一段判定。**一个程序被准许就够了**（见文件头「准许采集」那一节），
  // 所以判出 allow 就停——多数部署只有 1–3 个采集程序，这个循环最多跑几轮。
  const verdicts: AllowVerdict[] = []
  for (const programId of candidatePrograms(allowRules)) {
    const entry = await explainMeetingAccess(vis, {
      programId,
      meetingId: key.meetingId,
      subMeetingId: key.subMeetingId,
      now,
    })
    verdicts.push({ programId, decision: entry.decision })
    if (entry.decision !== null && isVisible(entry.decision)) break
  }

  // ⚠️ `since` 必须传：`audit_log` 上没有 `meeting_id` 的索引，不给时间下界这条
  // 查询就是一次全索引扫。下界取这场会议的开始时间——审计记录不可能早于会议本身。
  //
  // `startAt` 为 0（`meetings.start_time` 是 NULL，`missing` 里会有 'startAt'）时
  // **不传**：那种会议没有任何可信的时间下界，编一个出来会把真实记录藏掉，
  // 而「历史是空的」和「历史被下界截掉了」在抽屉里长得一模一样。宁可慢一次。
  const history = await ctx.deps.meetingHistory.listForMeeting(
    key.meetingId,
    row.startAt > 0 ? { since: row.startAt } : {},
  )

  const stage: StageMaterial = {
    now,
    fetchRules,
    archiveRules,
    meta: metas.find((m) => keyOf(m) === keyOf(key)),
    overrides: indexOverrides(overrideRows as readonly PolicyOverride[]),
  }
  return json(200, render(row, stage, verdicts, history))
}

// ── 整页叠加 ──────────────────────────────────────────────────────────────

/**
 * 一页会议的叠加。**发出去的查询数与行数无关**：规则 3 次（allow / archive / fetch）、
 * 归档 1 次、改写 1 次、会议元数据 1 次，共 6 次，列 50 行和列 3 行完全相同。
 *
 * 逐行调 `explainMeetingAccess` 会是 50 × 候选程序数 次调用、每次 4–5 条查询，
 * 那正是 T1 花了力气避开的 N+1（见文件头）。
 */
async function renderPage(
  ctx: RouteCtx,
  rows: readonly ConsoleMeetingRow[],
  now: number,
): Promise<ApiMeeting[]> {
  if (rows.length === 0) return []
  const vis = ctx.deps.meetingVisibility
  const keys: MeetingKey[] = rows.map((r) => ({
    meetingId: r.meetingId,
    subMeetingId: r.subMeetingId,
  }))

  const [allowRules, archiveRules, fetchRules, archives, overrideRows, metas] = await Promise.all([
    vis.policy.listEnabledStackRules('allow'),
    vis.policy.listEnabledStackRules('archive'),
    // 第三栈。整页取一次，与行数无关——列表的查询数不许随行数长（T1 的验收判据）
    vis.policy.listEnabledStackRules('fetch'),
    // 规则的 `arch` 条件（isarch / notarch）要它：`evaluateInventory` 的入参形状
    // 就是一批 `MeetingArchiveRecord`，`gather` 也是这么取的。它与下面 `render` 里
    // 用来判 `archived` 的 `row.keep.archivedAt` 是**同一列**（`meeting_archives.archived_at`，
    // store 那条 LEFT JOIN 带出来的），所以两处不会给出不同的事实
    vis.archives.listMeetingArchives(keys),
    vis.grants.listActiveOverridesForMeetings([...keys]),
    vis.getMeetings(keys),
  ])

  const metaByKey = new Map(metas.map((m) => [keyOf(m), m]))
  const overridesByKey = new Map<string, PolicyOverride[]>()
  for (const o of overrideRows as readonly PolicyOverride[]) {
    const k = keyOf(o)
    const list = overridesByKey.get(k)
    if (list === undefined) overridesByKey.set(k, [o])
    else list.push(o)
  }

  // 逐个候选程序跑一轮**同一个纯函数**。原料除了 programId 全部复用，
  // 所以 P 轮求值一条查询都不再发。
  const byProgram = new Map<string, Map<string, OverriddenDecision<AllowEffect> | null>>()
  const programs = candidatePrograms(allowRules)
  for (const programId of programs) {
    const entries = evaluateInventory({
      programId,
      now,
      meetings: keys,
      rules: allowRules,
      // **刻意为空**：本页只读 `entry.decision`，而 decision 由「规则 + 人工改写 +
      // 会议事实」决定，与授权行无关（授权那一维在列表里由 store 的 `grants` 字段
      // 直接给）。传真授权行要么逐场 findActiveGrant（N+1），要么逐程序拉它的全部
      // 授权（可能上千行），两者都是为一个用不到的字段付钱。
      // 代价：`entry.blockers` 里会多出 not_granted / no_local_files，本函数一个都不读。
      grants: [],
      archives,
      localAssets: new Set<string>(),
      meta: metas,
      overrides: overrideRows as readonly PolicyOverride[],
    })
    byProgram.set(programId, new Map(entries.map((e) => [keyOf(e), e.decision])))
  }

  return rows.map((r) => {
    const k = keyOf(r)
    const verdicts: AllowVerdict[] = programs.map((programId) => ({
      programId,
      decision: byProgram.get(programId)?.get(k) ?? null,
    }))
    const stage: StageMaterial = {
      now,
      fetchRules,
      archiveRules,
      meta: metaByKey.get(k),
      overrides: indexOverrides(overridesByKey.get(k) ?? []),
    }
    // 列表**不查审计**：一页 50 行就是 50 次 listForMeeting（每次两条查询）。
    // 操作历史是详情抽屉底部那一段（spec §4.3），由单场端点给。
    return render(r, stage, verdicts, [])
  })
}

/** 一行的最终形状。列表与详情共用，所以两处不可能给出不同的字段 */
function render(
  row: ConsoleMeetingRow,
  stage: StageMaterial,
  verdicts: readonly AllowVerdict[],
  history: readonly AuditRecord[],
): ApiMeeting {
  // 事实只构造一次，两栈共用：同一场会议在拉取与归档两栈上读到的必须是同一批事实，
  // 各算一遍迟早会在"结束时间回落"这类边界上分叉（见 meetingFacts 的注释）
  const facts =
    stage.meta === undefined ? null : meetingFacts(stage.meta, row.keep.archivedAt !== null)

  // 人工改写优先于**所有**规则（spec §5.4）。套在求值外面而不是混进
  // evaluate*Stack——与 `src/worker/archive.ts` / `src/worker/fetch-policy.ts`
  // 逐字同一条路径，那边怎么算这场会议拉不拉、归不归档，这边就怎么显示。
  const archiveDecision =
    facts === null
      ? null
      : applyOverride(
          evaluateArchiveStack(stage.archiveRules, { facts, now: stage.now }),
          stage.overrides.archive,
        )

  // `fetchRulesInEffect` 与 worker 共用：库里一条规则都没有时它顶上兼容兜底，
  // 所以这里算出来的就是 worker 真会做的那件事，不是"按 spec 字面应该是什么"
  const fetchDecision =
    facts === null
      ? null
      : applyOverride(
          evaluateFetchStack(fetchRulesInEffect(stage.fetchRules), { facts, now: stage.now }),
          stage.overrides.fetch,
        )

  const archive = overlayArchive(row.archive, archiveDecision)
  const fetch = overlayFetch(row.fetch, fetchDecision)
  const { allow, why } = summarizeAllow(verdicts)

  return {
    ...row,
    fetch,
    archive,
    allow,
    why: {
      fetch: fetchWhy(row, stage, fetchDecision),
      archive: archiveWhy(row, archive, archiveDecision, stage.overrides),
      allow: why,
    },
    history: history.map((r) => ({ at: r.occurredAt, text: historyText(r) })),
  }
}
