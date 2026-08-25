/**
 * 网关侧的采集权限判定（阶段 3 · T4）——把 HTTP 层接到三栈引擎的 **allow 栈**上。
 *
 * 网关只关心第三栈：「这场会议准不准被这个采集程序取走」。拉取栈与归档栈是
 * 服务端 worker 的事（`src/worker/`），网关一条都不读——多读两栈只是白花两次查询，
 * 还会让「网关到底按什么判的」这句话变得说不清。
 *
 * 这一层自己不实现任何求值语义，只做三件换算，每一件都能悄悄改变判定结果：
 *
 * 1. **谁是主体。** 旧引擎按 `ActorIdentity.tmUserId` 匹配（主体是**人**），
 *    新 allow 栈按 `service_accounts.id` 匹配（主体是**采集程序**）。这两者之间
 *    没有机械对应关系，所以 `ActorIdentity` 带上了 `programId`，认证链路填它。
 * 2. **`Meeting` → `MeetingFacts`。** 求值器只认事实，不认领域对象。
 *    结束时间的回落路径要在这里识别出来，见 `meetingFacts`。
 * 3. **资产类型的两套词汇。** 网关 emit 的是 `AssetType`（`meeting_summary` /
 *    `ai_meeting_transcripts`），规则里存的是 `AssetKey`（`transcript` /
 *    `ai_transcript`）。同一批资产已经有过三套叫法，M3.5 为此吃过一次亏
 *    （见 `packages/engine/src/domain/types.ts` 的 `ASSET_KEY_TO_GATEWAY_TYPE`），
 *    所以换算只走那份唯一的映射表，这里不另抄一份。
 *
 * ## 企微用户走到这里判什么
 *
 * **显式拒绝，并说出「你不是采集程序」这件事本身。** 设备授权流程登录的是人，
 * 人没有 `service_accounts.id`，allow 栈的主体规矩对他不适用。
 *
 * 让它落进 `checkSubject` 的「主体匹配不上」分支也能得到 deny，但理由会变成
 * 「没有任何采集权限规则匹配这场会议（采集程序 未指定）」——管理员读了会去
 * **再建一条规则**，而那条规则永远不会生效。判定理由是产品功能（spec §4.2/§4.3），
 * 说错了比不说更贵。所以这里在读规则之前就短路，理由里写清楚是身份类型不对。
 */

import { GATEWAY_TYPE_TO_ASSET_KEY, type AssetKey } from '@yaowu/mde-engine'
import type { ActorIdentity, AssetType, Meeting } from '../domain/types'
import type { PolicyStore } from '../store/policy'
import type { MeetingFacts } from './conds'
import { decisionAllowsAsset, evaluateAllowStack, STACK_KIND_LABEL, type AllowDecision } from './stacks'

export interface AccessInput {
  actor: ActorIdentity
  meeting: Meeting
  /**
   * 这场会议是否已写入 NAS——`arch` 条件（`isarch` / `notarch`）的数据源。
   * **由调用方查出来传进来，不在这里猜**：随手填 `false` 会让一条
   * `arch notarch → allow` 的规则把已归档的会议也放行，是查不出来的静默放行。
   */
  archived: boolean
  /** unix 秒。求值器不读时钟 */
  now: number
}

export interface AccessGate {
  /**
   * 整场会议对这个 actor 的采集权限判定。**一场会议只判一次**，
   * 具体哪几类资产取得到由 `allowsAsset` 作用在判定结果之上（计划 §3.4.1 D-e）。
   */
  decide(input: AccessInput): Promise<AllowDecision>
}

export interface AccessGateDeps {
  store: Pick<PolicyStore, 'listEnabledStackRules'>
}

/**
 * `Meeting` + 归档状态 → 求值器要的事实。
 *
 * `recordEndTime` 是这里唯一需要动脑子的一处：`Meeting.endTime` 在
 * `record_files` 全缺 `record_end_time` 时会**回落成 `startTime` 的镜像**
 * （见 `domain/types.ts`）。照直传下去，`age before N` 会把这类会议当成
 * 「录制结束于很久以前」恒命中。所以 `endTime <= startTime` 一律传 0，
 * 由 `conds.ts` 判成「没有录制结束时间，距今天数无从计算」——
 * 两个 op 都不匹配，落在不命中一侧。
 *
 * `dept` 恒为 null：企业微信通讯录未接入（计划 §1.1，R0 已定不做）。
 * 求值器对它有专门的 `no_data_source` 分支，与「字段拼错了」是两句不同的话。
 */
export function meetingFacts(meeting: Meeting, archived: boolean): MeetingFacts {
  const hasRealEnd = meeting.endTime > meeting.startTime
  return {
    title: meeting.subject,
    hostUserId: meeting.hostUserId,
    dept: null,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    recordEndTime: hasRealEnd ? meeting.endTime : 0,
    archived,
  }
}

/** 身份不是采集程序时的判定。**在读规则之前**就得出，与规则集无关 */
function notAProgram(actor: ActorIdentity): AllowDecision {
  const who = actor.kind === 'wecom_user' ? '企业微信用户' : '当前身份'
  return {
    kind: 'allow',
    effect: 'deny',
    ruleId: null,
    note: null,
    source: 'default',
    reason:
      `${who}（${actor.tmUserId}）不是采集程序，而${STACK_KIND_LABEL.allow}的主体是采集程序` +
      `（service_accounts.id）——这类身份不参与采集权限判定，一律拒绝。` +
      `再建规则也不会对它生效`,
    assetTypes: [],
    issues: [],
    trace: [],
  }
}

export function createAccessGate(deps: AccessGateDeps): AccessGate {
  return {
    async decide({ actor, meeting, archived, now }) {
      if (actor.programId === null || actor.programId === '') return notAProgram(actor)

      const rules = await deps.store.listEnabledStackRules('allow')
      return evaluateAllowStack(rules, {
        facts: meetingFacts(meeting, archived),
        now,
        programId: actor.programId,
      })
    },
  }
}

/**
 * 这次判定放不放行**某一类资产**。入参用网关自己的 `asset_type` 词汇，
 * 内部换算成规则里存的 `AssetKey`。
 *
 * 认不出的 `asset_type`（将来网关新增一类资产而规则词汇表还没跟上）一律拒绝，
 * 并说明原因——不是静默 false，也绝不是「不认识就放过」。
 */
export function allowsAsset(
  decision: AllowDecision,
  assetType: AssetType,
): { allowed: boolean; reason: string } {
  const key: AssetKey | undefined = GATEWAY_TYPE_TO_ASSET_KEY[assetType]
  if (key === undefined) {
    return {
      allowed: false,
      reason: `资产类型「${assetType}」不在规则的资产词汇表里，无从判定，按拒绝处理`,
    }
  }
  return decisionAllowsAsset(decision, key)
}

/**
 * 整场会议对这个 actor 是否**至少有一类资产**取得到。
 *
 * 列会议与单场详情用它做展示过滤（**UI 便利，不是安全边界**）。
 *
 * 它不能简写成 `effect === 'allow'`：一条 `effect='allow'` 但 `asset_types`
 * 里一个合法资产键都没有的规则（写坏了，或者只填了原型里的短名），判定是 allow
 * 而实际一类都取不到。此时把会议列出来，等于在没有任何可取内容的前提下
 * 泄露它的标题与主持人——旧实现「遍历八类、有一类 allow 就算可见」恰好排除了
 * 这种情况，这里保持同一口径。
 */
export function isVisible(decision: AllowDecision): boolean {
  return decision.effect === 'allow' && decision.assetTypes.length > 0
}
