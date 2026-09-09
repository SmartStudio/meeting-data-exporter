/**
 * A7 · 拉取规则栈的接线（阶段 4 · T12，计划 §0 E-c）。
 *
 * ## 这个文件补的是哪个洞
 *
 * 阶段 3 的 R1 交付的是**三栈求值引擎**，接线是另一件事，而三栈只接了两栈：
 * 归档栈接在 `src/worker/archive.ts`、allow 栈接在 `src/policy/access.ts`。
 * `evaluateFetchStack` 在全仓库只有一个引用点，是影响预览（`src/policy/preview.ts`）
 * ——**没有任何一条拉取规则参与过真实的拉取决策**。discovery 走的仍是 CLI 那套
 * 「按时间窗发现全部录制」，spec §4.6 第一组规则管理员配了也不生效。
 *
 * 本文件是那次接线：discovery 发现一场会议之后，按拉取规则栈判**拉不拉、拉哪几类资产**。
 *
 * ## 为什么不是「在 discover 里加一个过滤器」
 *
 * `discover`（`packages/engine/src/discovery`）是**两个宿主共用**的那一段：CLI 与
 * worker 走同一条代码路径，行为不许分叉。而规则、人工改写、`meeting_overrides`
 * 这些概念在引擎里根本不存在（引擎不认识 MySQL 里的策略表）。所以接线只能在**宿主侧**，
 * 而且要在不改引擎一个字的前提下做到：
 *
 *   ① 一趟**枚举**：借 `discover` 走它的时间窗切分与翻页（`wantedKeys` 传空数组，
 *      它就只会 `upsertMeeting`，不问资产、不建探测行），把每一页会议录在「磁带」上。
 *      **发现到的会议全部落库**——拉不拉是下一步的事，被判不拉的那些也要在
 *      `meetings` 表里留一行，否则控制台连"这场会议存在过"都不知道，
 *      spec §1.3 那句"界面随时答得出为什么取不到"就没了着落。
 *   ② 逐场判定（规则 + 人工改写 + `arch` 事实），按**判出来的资产范围**把会议分组。
 *   ③ 每组**重放**磁带再走一遍 `discover`，这一次带上该组的资产类型。重放只过滤
 *      会议，不再向腾讯要一次会议列表。
 *
 * 代价只有一处，明写在这里：被拉的会议会被 `upsertMeeting` 两次（枚举一次、它那组
 * 重放一次）。那是一条 `ON DUPLICATE KEY UPDATE` 的幂等写，为省掉它去给枚举那趟套
 * 一个"假 store"，换来的是一个必须跟着引擎改的隐形耦合，不划算。
 * **省下来的是有配额的腾讯 `listAssets`**——被判不拉的会议一次都不问。
 *
 * 为什么不图省事，只在 `listAssets` 的返回值里把不要的资产类型滤掉：`discover` 对
 * 「本轮想要、但清单里没有」的类型会**建一条探测行**（等平台产出），到期再标成
 * `upstream_timeout`。被规则明确排除的类型走这条路，等于在库里记一笔永远不会兑现的账，
 * 而且最后落成一个假的失败原因。这正是本仓库反复在消灭的失效形态。
 *
 * ## 上线安全：规则集为空**不是**「一场都不拉」（本任务最危险的地方）
 *
 * 接线之前的行为是「时间窗内全拉」。照 spec §4.6 的字面接上去，
 * **规则集为空 = 兜底 skip = 一场都不拉**，而一个刚部署完、还没来得及配规则的环境
 * 就是这个状态：归档链路会静默停摆，第二天才有人发现，界面上还看不出原因。
 *
 * 裁定（计划给的三个方向里的第三个，"配了规则才切换"）：
 * **开关就是规则集本身，不另开环境变量。**
 *
 *   - 库里**一条启用的拉取规则都没有** → 兼容模式：用一条合成的「全拉」兜底规则
 *     代替空规则集，行为与接线前逐字相同，并且**每一轮都留一条醒目告警**。
 *   - 库里**有**拉取规则 → 规则说了算，兜底就是 spec §4.6 的 `skip`。
 *
 * 为什么不用环境变量（`MDE_FETCH_POLICY=off` 那种）：控制台的 `why.fetch` 与 worker
 * 必须给出同一个答案，而控制台是**另一个进程**，读不到 worker 的环境变量。
 * 把开关做成"库里有没有规则"，两个进程读的是同一张表，结论不可能不一致。
 * 回滚也不需要重新部署——在规则页把拉取规则全部停用，下一轮就回到兼容模式。
 *
 * **兼容模式不是"绕过整栈"**：人工改写照样优先（`applyOverride` 套在合成规则之外），
 * 否则一条"这场误录了，别拉"的改写在界面上显示成已生效、实际却被绕过去了。
 *
 * **那处已知的边界已修（阶段 4 · T16）**。原来的毛病：影响预览（`src/policy/preview.ts`）
 * 按**库里**的规则集算，兼容兜底不参与，于是管理员建**第一条**拉取规则时，预览把
 * "本来就在拉"的会议算成「新放行」，又把落在新规则之外、本来也在拉的会议漏报为不变
 * ——两个数都偏乐观，而漏掉的那一半正是事故本身（这条规则给整条拉取链路装上了闸门）。
 *
 * **修法**：兼容兜底的定义搬到 `src/policy/fetch-compat.ts`（本文件原样 re-export，
 * 论证仍在这里），预览与真实判定从此读**同一个** `fetchRulesInEffect`。预览里落地成两件事：
 *
 *   1. 预览 fetch 栈时，新旧两侧的规则集各自过一遍 `fetchRulesInEffect`——
 *      "当前规则集为空"算成兼容兜底（全拉），不再算成 `skip`。
 *   2. 兜底翻面（`fetchStackUnconfigured` 在新旧两侧结论不同）时，
 *      spec §5.5 那句"只算命中(旧) ∪ 命中(新)"的安全性论证**不再成立**——
 *      整栈的兜底行为换了，没被任何规则命中的会议照样会变。所以那一次**逐场全算**，
 *      于是"这一条会让 M 场会议从在拉变成不拉"报得出来。
 *      规则编辑器还会为此额外出一条琥珀警告（`src/http/handlers/console/rules.ts`
 *      的 `fetch_compat_off`，与 §4.7「从未对外开放过却将被放行」是同一个先例）。
 *
 * archive 栈（兜底 `skip`）与 allow 栈（兜底 `deny`）**没有兼容模式**，预览行为一个字没变。
 *
 * ⚠️ **部署这次改动前运维要做什么**：什么都不用做，链路不会停。
 * 但要知道**建下第一条拉取规则的那一刻兜底就翻面**——从那一刻起，没有被任何一条
 * 拉取规则命中的会议不再被拉取。所以第一条规则要么是一条无条件的「全拉」（把现状
 * 显式化，再逐步收紧），要么先用规则编辑器的影响预览看清"会新收紧多少场"。
 */

import {
  discover,
  type AssetKey,
  type AssetSource,
  type Meeting as EngineMeeting,
  type MeetingSelector,
  type Store,
} from '@yaowu/mde-engine'
import { meetingFacts } from '../policy/access'
import type { MeetingFactKey, MeetingFacts } from '../policy/conds'
import {
  applyOverride,
  indexOverrides,
  type MeetingOverride,
  type OverriddenDecision,
} from '../policy/override'
import {
  FETCH_STACK_UNCONFIGURED_REASON,
  fetchRulesInEffect,
  fetchStackUnconfigured,
} from '../policy/fetch-compat'
import { evaluateFetchStack, type FetchEffect, type StackRule } from '../policy/stacks'
import { archiveStateKey, type ArchivesStore } from '../store/archives'
import type { MeetingKey } from '../store/grants'

// ── 兼容模式 ──────────────────────────────────────────────────────────────

/**
 * 兼容兜底的定义本体在 `src/policy/fetch-compat.ts`，这里**原样 re-export**。
 *
 * 为什么挪走：T16 给影响预览接上了同一个兜底，于是读者从两个（worker、控制台）
 * 变成三个，而 `src/policy/preview.ts` 是纯函数模块，反向 import 本文件会把
 * `@yaowu/mde-engine` 的 `discover` 与 `src/store/*` 一起拽进规则求值的依赖图。
 * **「兼容兜底是什么」只许有一处定义**——那正是 T16 在修的毛病的根源。
 *
 * 这条决定的完整论证仍然在本文件的文件头，没有搬走。
 */
export {
  FETCH_STACK_UNCONFIGURED_REASON,
  fetchRulesInEffect,
  fetchStackUnconfigured,
} from '../policy/fetch-compat'

/** 兼容模式每轮都喊一次。喊的是配置状态，不是故障，所以与会议数无关、一轮一条 */
const COMPAT_ALARM =
  `[fetch-policy] ${FETCH_STACK_UNCONFIGURED_REASON}` +
  ' 要让拉取真正由规则决定，请在控制台「自动规则 · 拉取规则」里至少建一条；' +
  '想先把现状显式化，就建一条无条件的「全拉」规则，再用规则编辑器的影响预览逐步收紧。'

// ── 形状 ──────────────────────────────────────────────────────────────────

export interface FetchPolicyLog {
  warn(message: string): void
  info(message: string): void
}

const DEFAULT_LOG: FetchPolicyLog = {
  warn: (m) => console.warn(m),
  info: (m) => console.log(m),
}

/**
 * 接线要的依赖。**规则与改写都是注入的函数，不是整个 store**——与
 * `ArchiveDeps.listArchiveRules` / `getMeeting` 同一个先例：发现这一层需要的只是
 * 「fetch 这一栈当前启用的规则」和「这批会议的改写」，把整个 store 递进来会让它
 * 顺手够得着 `policy_rules` / `meeting_overrides` 之外的东西。
 */
export interface FetchPolicyDeps {
  /** 腾讯边界。**原样递给 `discover`**，本文件只在它外面套一层"磁带" */
  gw: AssetSource
  /** 引擎的 Store。`discover` 要的是完整接口，这里不缩小 */
  store: Store
  /**
   * `arch`（isarch / notarch）条件的数据源。**查出来传，不猜**——随手填 false 会让
   * 一条 `arch notarch → all` 的规则把已归档的会议每轮重新拉一遍。整批一次查完，
   * 不逐场往返（同 `archive.ts` 的 `listArchivedMeetingKeys` 注释）。
   */
  archives: Pick<ArchivesStore, 'listArchivedMeetingKeys'>
  /** fetch 栈当前**启用**的规则。每轮取一次，不是每场会议取一次 */
  listFetchRules: () => Promise<readonly StackRule[]>
  /** 这批会议当前生效的人工改写（三栈都会回来，本文件只取 fetch 那一条） */
  listFetchOverrides: (keys: readonly MeetingKey[]) => Promise<readonly MeetingOverride[]>
  /** 日志出口。缺省 console；测试注入一个数组来读那条兼容模式告警 */
  log?: FetchPolicyLog
}

export type FetchPolicyMode =
  /** 库里一条启用的拉取规则都没有，用兼容兜底（行为 = 接线前） */
  | 'compat'
  /** 库里有拉取规则，规则说了算，兜底 skip */
  | 'governed'

export interface FetchPolicySummary {
  mode: FetchPolicyMode
  /** **库里**的启用规则条数。兼容兜底不算在内，所以 0 就是 0 */
  ruleCount: number
  /** 判为要拉的会议数 */
  fetched: number
  /** 判为不拉的会议数。**不是故障**：拉取栈的兜底就是 skip（spec §4.6） */
  skipped: number
  /**
   * 上面那 `skipped` 里**判不出来**的那部分（元数据不全，阶段 4 · T13）。
   * 与"规则说不拉"分开数：前者要去补这场会议的元数据，后者是规则的本意，
   * 合成一个数字就再也分不开"规则没覆盖到"和"数据不全"。
   */
  undecidable: number
  /** 判为要拉、但资产范围比本轮 `--assets` 窄的会议数 */
  narrowed: number
}

export interface FetchPolicyRound {
  /** 本轮**发现**的会议数。含被判不拉的那些——与接线前同口径 */
  meetings: number
  /** 本轮发现的就绪资产条数。被规则排除的类型不计入 */
  tasks: number
  fetchPolicy: FetchPolicySummary
}

// ── 判定 ──────────────────────────────────────────────────────────────────

/**
 * 求值器要的事实。**事实本身仍由 `policy/access.ts` 的 `meetingFacts` 构造**，
 * 这里只做一次类型归一——与 `src/worker/archive.ts` 的 `factsFor` 是同一件事、
 * 同一个理由（仓库里有两个 `Meeting`：引擎那个字段可空，网关那个非空且多两个字段）。
 *
 * **为什么不把 archive.ts 那个拿过来共用**：它不是导出的，而且它把 `state` 写死成
 * `'completed'` 并附了一条只在归档时刻成立的论证（"能走到归档的会议，其录制早已
 * 转码完成"）——发现阶段的会议可能还在转码。把它导出来共用，等于把那条论证也一起
 * 搬到一个它不成立的地方。真正不许各写一份的是**回落识别**（`endTime <= startTime`
 * 视为没有结束时间数据），那一份在 `meetingFacts` 里，两处都调它。
 *
 * `state` 在 `meetingFacts` 里一个字都不读（它只取标题 / 主持人 / 起止时间 / 归档状态），
 * 填什么都不参与判定；填 `'completed'` 只是为了满足 `MeetingMeta` 的类型。
 *
 * **补空值的同时要记账**（阶段 4 · T13）：`?? ''` 一折，「这场会议没有标题」就变得和
 * 「标题是空串」一模一样，于是一条 `title has 财务 → all` 的规则对它判「不匹配」、
 * 被低优先级的规则接手。`missingFacts` 把这笔账带给求值器，判不出来就落到 fetch 栈的
 * 安全侧（skip）并说明是判不出来。**改回去（只 `?? ''` 不记账）会怎样**：那条路原样
 * 回来，且没有任何报错。
 */
function factsFor(meeting: EngineMeeting, archived: boolean): MeetingFacts {
  const missingFacts: MeetingFactKey[] = []
  if (meeting.subject === null || meeting.subject === undefined) missingFacts.push('title')
  if (meeting.hostUserId === null || meeting.hostUserId === undefined) missingFacts.push('hostUserId')
  if (meeting.startTime === null || meeting.startTime === undefined) missingFacts.push('startTime')
  if (meeting.endTime === null || meeting.endTime === undefined) missingFacts.push('endTime')
  return meetingFacts(
    {
      meetingId: meeting.meetingId,
      subMeetingId: meeting.subMeetingId,
      meetingRecordId: '',
      meetingCode: meeting.meetingCode ?? '',
      subject: meeting.subject ?? '',
      hostUserId: meeting.hostUserId ?? '',
      startTime: meeting.startTime ?? 0,
      endTime: meeting.endTime ?? 0,
      state: 'completed',
      ...(missingFacts.length > 0 ? { missingFacts } : {}),
    },
    archived,
  )
}

/**
 * 一场会议拉不拉。
 *
 * 人工改写优先于**所有**规则（spec §5.4），套在求值**外面**而不是混进
 * `evaluateFetchStack`：规则求值是纯函数、可预览、可回放，把「某场会议的人工决定」
 * 混进去，影响预览就再也算不准了——它算的是"规则改了会怎样"，而被改写的会议
 * 根本不受规则支配。**与 `src/worker/archive.ts` 的 `decideArchiveDir` 逐字同一条路径。**
 */
export function decideFetch(
  rules: readonly StackRule[],
  meeting: EngineMeeting,
  archived: boolean,
  override: MeetingOverride | null,
  now: number,
): OverriddenDecision<FetchEffect> {
  return applyOverride(
    evaluateFetchStack(rules, { facts: factsFor(meeting, archived), now }),
    override,
  )
}

/**
 * 这次判定最终要拉哪几类资产。
 *
 * 与本轮 `--assets`（`wanted`）取**交集**，规则不能越过命令行把范围放大：那两个东西
 * 回答的是不同的问题——`--assets` 是"这个宿主这一趟负责搬哪几类"（一次性补跑经常
 * 只跑一类），规则是"这场会议允许拉哪几类"。规则能放大的话，一次
 * `--assets transcript` 的补跑会顺手把几个 GB 的录像也拖下来。
 */
export function fetchableKeys(
  decision: OverriddenDecision<FetchEffect>,
  wanted: readonly AssetKey[],
): AssetKey[] {
  if (decision.effect !== 'all') return []
  return wanted.filter((k) => decision.assetTypes.includes(k))
}

// ── 会议列表的"磁带"：录一遍，重放若干遍 ──────────────────────────────────

interface TapePage {
  meetings: EngineMeeting[]
  nextCursor: string | null
}

/**
 * 把 `discover` 走过的**会议列表调用序列**录下来，之后可以按同样的序列重放。
 *
 * 为什么按"调用次序"重放而不是按 cursor 建索引：`collectMeetings` 的遍历是确定的
 * ——range 选择器按 `splitWindow` 切出的窗口顺序、每个窗口内按上一页给的 `nextCursor`
 * 往下走。重放时把每一页的 `nextCursor` 原样交还，遍历就会走出一模一样的序列，
 * 于是"第 i 次调用"能唯一对上"录到的第 i 页"。走过头一律抛错，不许悄悄回落到
 * 真的去问一次腾讯——那会让一轮里出现两份不同的会议列表。
 *
 * ## `enumerator.listAssets` 为什么直接给空清单，而不是转发给腾讯
 *
 * `discover` 对每场会议**无条件**调一次 `listAssets`，然后才按 `wantedKeys` 逐类看
 * （见 `packages/engine/src/discovery/index.ts`）。枚举那一趟的 `wantedKeys` 是空数组，
 * 那次返回值它一个字段都读不到——转发上去就是纯粹白打一趟**有配额的**腾讯接口，
 * 而且是对**包括将被规则判为不拉的**每一场会议都打一趟。整个接线要省下的正是这些调用。
 *
 * 这一条依赖"空 `wantedKeys` ⇒ 不读资产清单"这个事实。真出错也炸不远：枚举这一趟
 * 只用来落 `meetings` 行和录会议列表，真正要资产的是下面每一组的重放，那些走的是
 * **真的 gw**。
 */
function createMeetingTape(gw: AssetSource) {
  const pages: TapePage[] = []

  const enumerator: AssetSource = {
    async listMeetings(sel, cursor, limit) {
      const page = await gw.listMeetings(sel, cursor, limit)
      pages.push({ meetings: page.meetings, nextCursor: page.nextCursor })
      return page
    },
    listAssets: async () => [],
    getDownloadUrl: (assetId) => gw.getDownloadUrl(assetId),
  }

  function replay(members: ReadonlySet<string>): AssetSource {
    let next = 0
    return {
      async listMeetings() {
        const page = pages[next++]
        if (page === undefined) {
          throw new Error(
            `拉取规则接线：重放会议列表时走过了录制到的页数（录到 ${pages.length} 页）。` +
              '这说明枚举那一趟与重放那一趟的遍历序列不一致，见 src/worker/fetch-policy.ts 的 createMeetingTape',
          )
        }
        return {
          meetings: page.meetings.filter((m) => members.has(meetingKey(m))),
          nextCursor: page.nextCursor,
        }
      },
      listAssets: (meetingId, subMeetingId, from, to) => gw.listAssets(meetingId, subMeetingId, from, to),
      getDownloadUrl: (assetId) => gw.getDownloadUrl(assetId),
    }
  }

  return { enumerator, replay, all: (): EngineMeeting[] => pages.flatMap((p) => p.meetings) }
}

/** 两个 id 拼成一场会议的键，与 `archiveStateKey` / `override.ts` 的 `targetKey` 同一种编码 */
function meetingKey(m: EngineMeeting): string {
  return archiveStateKey(m.meetingId, m.subMeetingId)
}

/** 日志里的会议名。标题拿不到就说拿不到，不编一个 */
function meetingLabel(m: EngineMeeting): string {
  const id = m.subMeetingId === '' ? m.meetingId : `${m.meetingId}/${m.subMeetingId}`
  return `${id}「${m.subject ?? '(标题缺失)'}」`
}

/**
 * 一轮最多逐场打印多少条"不拉"的理由。超出的收成一句汇总——
 * 一个窗口里几百场会议全被规则排除时，几百行日志会把这一轮真正的异常淹掉，
 * 而逐场理由在控制台的 `why.fetch` 里随时算得出来，不必靠日志留存。
 */
const SKIP_LOG_CAP = 10

// ── 接线本体 ──────────────────────────────────────────────────────────────

/**
 * 带拉取规则判定的一轮发现。**替换掉 `discover` 的直接调用**，返回形状对
 * `{ meetings, tasks }` 是超集，所以既有调用方一个字都不用改。
 */
export async function discoverWithFetchPolicy(
  deps: FetchPolicyDeps,
  sel: MeetingSelector,
  keys: readonly AssetKey[],
  now: number,
): Promise<FetchPolicyRound> {
  const log = deps.log ?? DEFAULT_LOG
  const configured = await deps.listFetchRules()
  const rules = fetchRulesInEffect(configured)
  // 「什么时候算兼容模式」与 `fetchRulesInEffect` 读同一个谓词，不各写一个
  // `length` 判断——两处漂移的后果是日志说 governed 而判定走的是兜底
  const mode: FetchPolicyMode = fetchStackUnconfigured(configured) ? 'compat' : 'governed'
  if (mode === 'compat') log.warn(COMPAT_ALARM)

  // ① 枚举。`wantedKeys` 传空数组 ⇒ discover 只会 upsertMeeting：不向腾讯要资产清单、
  //    不建探测行。发现到的会议**全部落库**，被判不拉的那些也在里面——控制台按
  //    `meetings` 表枚举，不落库的会议在界面上根本不存在，"为什么这场没拉"也就无从答起。
  const tape = createMeetingTape(deps.gw)
  await discover({ gw: tape.enumerator, store: deps.store }, sel, [], now)
  const found = tape.all()

  // 同一 (meeting_id, sub_meeting_id) 在一轮里可能出现多次（周期性会议、窗口边界）。
  // 判定按会议做一次就够，重复的那些跟着同一个结论走。
  const uniq = new Map<string, EngineMeeting>()
  for (const m of found) {
    const k = meetingKey(m)
    if (!uniq.has(k)) uniq.set(k, m)
  }
  const keyList: MeetingKey[] = [...uniq.values()].map((m) => ({
    meetingId: m.meetingId,
    subMeetingId: m.subMeetingId,
  }))

  // ② 判定要的两笔外部事实，各一次批量查询——与会议数无关，不逐场往返
  const [overrideRows, archivedKeys] = await Promise.all([
    deps.listFetchOverrides(keyList),
    deps.archives.listArchivedMeetingKeys(keyList),
  ])
  const overridesByMeeting = new Map<string, MeetingOverride[]>()
  for (const o of overrideRows) {
    const k = archiveStateKey(o.meetingId, o.subMeetingId)
    const list = overridesByMeeting.get(k)
    if (list === undefined) overridesByMeeting.set(k, [o])
    else list.push(o)
  }

  const summary: FetchPolicySummary = {
    mode,
    ruleCount: configured.length,
    fetched: 0,
    skipped: 0,
    undecidable: 0,
    narrowed: 0,
  }

  // 按"判出来的资产范围"分组：范围相同的会议可以共用一趟 discover。
  // 绝大多数部署只会分出一组（所有会议同一个范围），此时下面的循环只跑一次。
  const groups = new Map<string, { keys: AssetKey[]; members: Set<string> }>()
  let skipLogged = 0
  for (const [k, m] of uniq) {
    // `indexOverrides` 负责"同一栈上有多条改写时挑最新的那条"——那条挑法只有一份实现
    const override = indexOverrides(overridesByMeeting.get(k) ?? []).fetch ?? null
    const decision = decideFetch(rules, m, archivedKeys.has(k), override, now)
    const want = fetchableKeys(decision, keys)

    if (want.length === 0) {
      summary.skipped++
      if (decision.source === 'undecidable') summary.undecidable++
      if (skipLogged < SKIP_LOG_CAP) {
        log.warn(`[fetch-policy] 不拉取 ${meetingLabel(m)}：${decision.reason}`)
        skipLogged++
      }
      continue
    }

    summary.fetched++
    if (want.length < keys.length) summary.narrowed++
    const sig = want.join(',')
    const group = groups.get(sig)
    if (group === undefined) groups.set(sig, { keys: want, members: new Set([k]) })
    else group.members.add(k)
  }
  if (summary.skipped > skipLogged) {
    log.warn(
      `[fetch-policy] 另有 ${summary.skipped - skipLogged} 场按拉取规则判为不拉，` +
        '逐场理由在控制台会议列表的 why.fetch 里随时算得出来',
    )
  }

  // ③ 逐组重放。重放只过滤会议，不再向腾讯要一次会议列表
  let tasks = 0
  for (const group of groups.values()) {
    const round = await discover(
      { gw: tape.replay(group.members), store: deps.store },
      sel,
      [...group.keys],
      now,
    )
    tasks += round.tasks
  }

  log.info(
    `[fetch-policy] mode=${mode} rules=${summary.ruleCount} meetings=${found.length} ` +
      `fetched=${summary.fetched} skipped=${summary.skipped} ` +
      `undecidable=${summary.undecidable} narrowed=${summary.narrowed} tasks=${tasks}`,
  )

  return { meetings: found.length, tasks, fetchPolicy: summary }
}
