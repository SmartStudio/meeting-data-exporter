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
 *
 * ## 三个「与」里的第一个也在这里判（阶段 6，2026-09-03）
 *
 * spec §1.3：`外部程序真能取到 = 有授权 且 在保留期内 且 规则允许`。本模块判**第一个
 * 和第三个**：授权行（`meeting_grants`）与 allow 栈。此前它只判第三个——于是只要库里
 * 有一条 allow 规则，任何启用中的采集程序不需要任何授权就能列出会议、拿到下载地址，
 * 而采集授权页照样显示「0 场对它开放」。**漂移方向是控制台说 0、程序实际取得到**。
 *
 * 判定顺序是：`notAProgram` → `programDisabled` → 规则栈 → 套改写 → **套授权行**。
 * 授权在改写**之后**：改写替换的是「规则怎么判」（spec §5.4），授权是另一个独立的
 * 「与」，两者管的不是同一件事。给一场会议加一条 allow 改写，没授权的程序照样取不到——
 * 这也顺带补上了「`meeting_overrides` 没有程序维度、一条 allow 改写等于对所有程序放行」
 * 那个洞：授权行就是那个按程序过滤的环节。完整理由见 `grant.ts` 的文件头。
 *
 * 第二个「与」（在保留期内）**不在这一层**，网关上也还没有：`download-url` 返回的是
 * 腾讯云的下载地址，不走本地/NAS 文件（见 spec §11 第 10 行登记的缺口）。
 *
 * 控制台的采集清单（`src/worker/visibility.ts`）与这里**共用 `grant.ts`**——
 * 两边各存一份「空数组算不算不限制」的判断，早晚会漂移，而漂移的一侧就是一次
 * 静默放行或一次没人说得清的静默拒绝。
 */

import { GATEWAY_TYPE_TO_ASSET_KEY, type AssetKey } from '@yaowu/mde-engine'
import type { ActorIdentity, AssetType, Meeting } from '../domain/types'
import type { PolicyStore } from '../store/policy'
import type { MeetingFactKey, MeetingFacts } from './conds'
import { applyGrant, type GrantLike, type GrantSource } from './grant'
import { applyOverride, type MeetingOverride, type OverriddenDecision } from './override'
import {
  decisionAllowsAsset,
  evaluateAllowStack,
  isVisible,
  STACK_KIND_LABEL,
  type AllowDecision,
  type StackKind,
} from './stacks'

// `isVisible` 阶段 6 搬去了 `stacks.ts`（`grant.ts` 也要用它，留在这里就是一个
// 互相 import 的环）。原地 re-export，`handlers/meetings.ts`、`worker/visibility.ts`
// 那几处调用方一个都不用改
export { isVisible }

/**
 * `Meeting` + 「这一行**哪几列在库里是 NULL**」（阶段 4 · T13）。
 *
 * 为什么要多这么一层，而不是把可空性做进 `domain/types.ts` 的 `Meeting`：
 * 那个域模型的字段非空是一条被大量代码依赖的约定（腾讯 API 的响应里这些字段就是有的，
 * 引擎侧、归档侧、下载侧全按非空写），为一张表的 nullable 列把它整体放开，
 * 换来的是几十处新的 `?? ''`——而每一处 `?? ''` 都是这次要修的那个缺口的复制品。
 * 所以「值」照旧按仓库既有口径折成空串 / 0（`store/console-meetings.ts` 的
 * `toDomainMeeting`），**折的时候顺手记一笔账**，账就在这个字段上。
 *
 * **字段是可选的**：省略 = 每一项事实都有真值，也就是这个字段加进来之前的语义，
 * 于是既有的调用方（`meeting_cache` 那条路径——001 建表时那几列都是 NOT NULL，
 * 本来就不会缺）与既有测试一个字都不必改。代价是「漏传就退回放行侧」，
 * 所以真正会读到 NULL 的那两处（`store/console-meetings.ts` 的 `toDomainMeeting`、
 * `worker/archive.ts` 的 `factsFor`）都把这件事写在注释里钉住了。
 */
export interface MeetingMeta extends Meeting {
  missingFacts?: readonly MeetingFactKey[]
}

export interface AccessInput {
  actor: ActorIdentity
  /** 元数据不全时带上 `missingFacts`，判定才分得开「标题是空的」与「没有标题」 */
  meeting: MeetingMeta
  /**
   * 这场会议是否已写入 NAS——`arch` 条件（`isarch` / `notarch`）的数据源。
   * **由调用方查出来传进来，不在这里猜**：随手填 `false` 会让一条
   * `arch notarch → allow` 的规则把已归档的会议也放行，是查不出来的静默放行。
   */
  archived: boolean
  /** unix 秒。求值器不读时钟 */
  now: number
}

/** 判定结果。`overriddenFrom` 非空表示这场会议被人工改写过（spec §5.4） */
export type AccessDecision = OverriddenDecision<AllowDecision['effect']>

export interface AccessGate {
  /**
   * 整场会议对这个 actor 的采集权限判定。**一场会议只判一次**，
   * 具体哪几类资产取得到由 `allowsAsset` 作用在判定结果之上（计划 §3.4.1 D-e）。
   */
  decide(input: AccessInput): Promise<AccessDecision>
  /**
   * 批量版，列会议用。语义与逐场调 `decide` **完全一致**，只是把规则、改写与
   * 授权行各取一次而不是每场取一次。
   */
  decideMany(inputs: readonly AccessInput[]): Promise<AccessDecision[]>
}

export interface AccessGateDeps {
  store: Pick<PolicyStore, 'listEnabledStackRules'>
  /**
   * 「这个采集程序还启用着吗」（阶段 5 · A8，spec §11 缺口 4）。
   *
   * **为什么这道判断必须在这一层，而不是只在 `auth/service.ts` 里。**
   * 那里挡的是「拿凭据换访问令牌」，可访问令牌是 JWT，签出去之后到自然过期
   * 为止服务端不再查库。于是「停用」这个按钮在最长一个令牌生命周期内什么都
   * 没做——管理员看到程序卡片灰了，数据还在往外走。
   *
   * 它排在读规则**和读改写**之前：停用压过人工改写。给一个停用中的程序套一条
   * allow 改写不该让它取到数据——那是另一条出境路径（spec §1.4），
   * 与 `notAProgram` 那条短路同一个理由。
   */
  programs: ProgramStatusSource
  /**
   * 人工改写的来源（spec §5.4：**单场会议的人工改写优先于所有规则**）。
   *
   * **为什么由本模块自己取，而不是像 `archived` 那样让调用方传进来**：
   * 这是数据出境的闸门（spec §1.4）。让调用方负责递改写，等于每新增一个
   * 调用点就多一次「忘了递就静默绕过改写」的机会——而绕过的方向是放行。
   * `archived` 那样处理是可以的，因为漏了它最多让一条 `arch` 规则判错；
   * 漏了改写则是让管理员明确按下的那个「不许取」失效。
   *
   * **字段叫 `overrides` 而不是 `grants`**（阶段 6 改名）：它从头到尾只取改写，
   * 一次都没查过授权行。名字说的是「授权」而做的是「改写」，正是这次要补的那个
   * 缺口能在代码里活这么久的原因之一——读装配处的人看见 `grants: grantsStore`
   * 会以为授权已经判过了。
   */
  overrides: OverrideSource
  /**
   * 逐会议授权的来源（spec §1.3 三个「与」的**第一个**）。
   *
   * **与改写同一个理由，由本模块自己取而不是让调用方递进来**：这是数据出境的闸门
   * （spec §1.4），每新增一个调用点就多一次「忘了递就静默绕过授权」的机会，
   * 而绕过的方向是放行。
   */
  grants: GrantSource
}

/**
 * 采集程序的启用状态。**按 policy 层自己的需要声明，不是
 * `Pick<ProgramsStore, 'find'>`**：这一层只问一个是非题，不必反过来依赖
 * `ServiceProgram` 那个行结构（`tmUserId` / `createdAt` 它一个都不读）。
 * 与下面 `OverrideSource` 是同一个取舍。
 */
export interface ProgramStatusSource {
  /**
   * 这个采集程序此刻是不是启用的。
   *
   * **查不到这个 id 时返回 `false`**（不是抛、也不是 true）：程序被删掉之后
   * 它的令牌可能还没过期，而「查不到」与「停用了」对判定而言是同一件事——
   * 都不该再取到数据。装配处照这条实现（见 src/index.ts）。
   */
  isProgramEnabled(programId: string): Promise<boolean>
}

/**
 * 改写的读法。**按 policy 层自己的 `MeetingOverride` 声明，不是
 * `Pick<GrantsStore, …>`**：真正的 store 结构上满足它，而这一层不必反过来
 * 依赖库表的行结构（`id` / `revokedAt` 这些它一个都不读）。
 * `stacks.ts` 的 `StackRule` 是同一个取舍。
 */
export interface OverrideSource {
  findActiveOverride(
    meetingId: string,
    subMeetingId: string,
    kind: StackKind,
  ): Promise<MeetingOverride | null>
  listActiveOverridesForMeetings(
    keys: { meetingId: string; subMeetingId: string }[],
  ): Promise<MeetingOverride[]>
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
 *
 * `missing` 是第二处（阶段 4 · T13）：**「事实为空」与「没有这个事实」不是一回事**。
 * 这里只做转运——真话从 `MeetingMeta.missingFacts` 来，由读到 NULL 的那一层填。
 * 空数组一律传 `undefined`，让下游的判断只有「有没有」一种形态。
 */
export function meetingFacts(meeting: MeetingMeta, archived: boolean): MeetingFacts {
  const hasRealEnd = meeting.endTime > meeting.startTime
  const missing = meeting.missingFacts
  return {
    title: meeting.subject,
    hostUserId: meeting.hostUserId,
    dept: null,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    recordEndTime: hasRealEnd ? meeting.endTime : 0,
    archived,
    missing: missing === undefined || missing.length === 0 ? undefined : missing,
  }
}

/**
 * 采集程序已停用（或者已经不存在）时的判定。**在读规则和改写之前**就得出。
 *
 * 理由写在判定里而不是含糊成「没有规则匹配」：管理员读到「没有规则匹配」会去
 * **再建一条规则**，而那条规则永远不会生效。判定理由是产品功能
 * （spec §4.2/§4.3），说错了比不说更贵——与 `notAProgram` 同一个道理。
 */
function programDisabled(programId: string): AccessDecision {
  return {
    kind: 'allow',
    effect: 'deny',
    ruleId: null,
    note: null,
    source: 'default',
    reason:
      `采集程序「${programId}」已被停用（或已不存在），一律拒绝。` +
      `它已有的逐会议授权与人工改写都还在（停用是可逆的，不连带删授权），` +
      `重新启用之后即刻恢复——要恢复采集请在采集授权页启用这个程序，再建规则没有用`,
    assetTypes: [],
    issues: [],
    trace: [],
    // 这条判定压根没经过规则栈，所以「若无改写本会判成什么」无从谈起
    overriddenFrom: null,
  }
}

/** 身份不是采集程序时的判定。**在读规则之前**就得出，与规则集无关 */
function notAProgram(actor: ActorIdentity): AccessDecision {
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
    // 这条判定压根没经过规则栈，所以「若无改写本会判成什么」无从谈起
    overriddenFrom: null,
  }
}

export function createAccessGate(deps: AccessGateDeps): AccessGate {
  return {
    async decide(input) {
      // 不是采集程序的，在读规则**和改写**之前就拒。改写改的是「规则对这场会议
      // 会怎么判」，不是「谁算采集程序」——给企微用户套一条 allow 改写也不该
      // 让他取到数据，那是另一条出境路径（spec §1.4），要当成采集程序来接
      if (input.actor.programId === null || input.actor.programId === '') {
        return notAProgram(input.actor)
      }
      // 停用压过一切，包括人工改写——所以这一句在取改写之前
      if (!(await deps.programs.isProgramEnabled(input.actor.programId))) {
        return programDisabled(input.actor.programId)
      }

      const rules = await deps.store.listEnabledStackRules('allow')
      const override = await deps.overrides.findActiveOverride(
        input.meeting.meetingId,
        input.meeting.subMeetingId,
        'allow',
      )
      const decision = decideOne(rules, input, override)
      // 第一个「与」：授权行。**只在规则侧确实放行了的时候才查**——规则已经拒了的
      // 会议，授权行怎么写都改不了结论（`applyGrant` 的规矩 1 会原样返回），
      // 多这一次往返只是白花。列会议那条路上这一省就是一页里被拒的那些场次全免。
      if (!isVisible(decision)) return decision
      const grant = await deps.grants.findActiveGrant(
        input.meeting.meetingId,
        input.meeting.subMeetingId,
        input.actor.programId,
      )
      return applyGrant(decision, grant, input.actor.programId)
    },

    async decideMany(inputs) {
      if (inputs.length === 0) return []

      // 程序的启用状态**按不同的 programId 各查一次**（列会议时一整批共用同一个
      // actor，所以实际就是一次）。用 Map 缓存而不是逐场查：一页 200 场就是
      // 200 次同样的往返
      const enabledCache = new Map<string, boolean>()
      const isEnabled = async (programId: string): Promise<boolean> => {
        const hit = enabledCache.get(programId)
        if (hit !== undefined) return hit
        const value = await deps.programs.isProgramEnabled(programId)
        enabledCache.set(programId, value)
        return value
      }
      // 授权行**按不同的 programId 各取一次**（同一个 actor 的一整批就是一次），
      // 与上面的启用状态同一个做法。逐场 findActiveGrant 是一页 200 次往返
      const grantsCache = new Map<string, Map<string, GrantLike>>()
      const grantsOf = async (programId: string): Promise<Map<string, GrantLike>> => {
        const hit = grantsCache.get(programId)
        if (hit !== undefined) return hit
        const rows = await deps.grants.listActiveGrantsForProgram(programId)
        const byMeeting = new Map<string, GrantLike>()
        for (const g of rows) byMeeting.set(overrideKey(g.meetingId, g.subMeetingId), g)
        grantsCache.set(programId, byMeeting)
        return byMeeting
      }
      for (const input of inputs) {
        const pid = input.actor.programId
        if (pid !== null && pid !== '') {
          await isEnabled(pid)
          // 停用的程序不必再取它的授权行：下面那一轮在读规则之前就返回
          // programDisabled 了，取回来也没人看
          if (enabledCache.get(pid) === true) await grantsOf(pid)
        }
      }

      // 规则与改写各取一次。逐场取的话，同一次列会议里前后两场可能按不同的
      // 规则集判——列表里两行的判定理由互相矛盾，而且不可复现
      const rules = await deps.store.listEnabledStackRules('allow')
      const overrides = await deps.overrides.listActiveOverridesForMeetings(
        inputs.map((i) => ({
          meetingId: i.meeting.meetingId,
          subMeetingId: i.meeting.subMeetingId,
        })),
      )
      const byMeeting = new Map<string, (typeof overrides)[number]>()
      for (const o of overrides) {
        if (o.kind !== 'allow') continue
        byMeeting.set(overrideKey(o.meetingId, o.subMeetingId), o)
      }

      return inputs.map((input) => {
        if (input.actor.programId === null || input.actor.programId === '') {
          return notAProgram(input.actor)
        }
        // 缓存在上面已经被填满，这里只读——`decide` 与本分支因此判得一模一样
        if (enabledCache.get(input.actor.programId) !== true) {
          return programDisabled(input.actor.programId)
        }
        const key = overrideKey(input.meeting.meetingId, input.meeting.subMeetingId)
        const override = byMeeting.get(key)
        const decision = decideOne(rules, input, override ?? null)
        // 第一个「与」：授权行。两个缓存在上面都已经填满，这里只读——`decide`
        // 与本分支因此判得一模一样。`decide` 里那句「不可见就不查」在这里体现为
        // `applyGrant` 的规矩 1（原样返回），批量路径本来就只查一次，不必再省
        const grants = grantsCache.get(input.actor.programId)
        return applyGrant(decision, grants?.get(key) ?? null, input.actor.programId)
      })
    },
  }
}

/**
 * 两个 id 拼成一场会议的键。改写与授权行在批量路径上都按它索引。
 * 用 NUL 分隔而不是 `/`——会议 id 是外部系统给的，拿可打印分隔符去赌它不出现在
 * id 里，撞上一次就是两场会议共用一条改写（或一条授权）。
 * 与 `override.ts` 的 `targetKey` 同一个理由。
 */
function overrideKey(meetingId: string, subMeetingId: string): string {
  return `${meetingId}\u0000${subMeetingId}`
}

/**
 * 规则求值 + 套改写。`decide` 与 `decideMany` 共用这一段，
 * 两条路径的语义因此不可能分叉。
 */
function decideOne(
  rules: Awaited<ReturnType<PolicyStore['listEnabledStackRules']>>,
  input: AccessInput,
  override: Parameters<typeof applyOverride>[1],
): AccessDecision {
  const decision = evaluateAllowStack(rules, {
    facts: meetingFacts(input.meeting, input.archived),
    now: input.now,
    programId: input.actor.programId as string,
  })
  return applyOverride(decision, override)
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

