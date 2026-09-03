/**
 * 三个「与」的**第一个**：逐会议授权（`meeting_grants`）在判定路径上的那一层
 * （阶段 6，2026-09-03）。
 *
 * spec §1.3 的公式是三个条件求交：
 *
 * ```
 * 外部程序真能取到 = 有授权 且 在保留期内 且 规则允许（allow 栈）
 * ```
 *
 * 控制台的采集清单（`src/worker/visibility.ts`）三个都求了交，而**网关真正把数据
 * 放出去的那条路径此前只判了第三个**：`createAccessGate` 从 `notAProgram` 一路走到
 * allow 栈再套人工改写，一次都没查过授权行。后果是只要库里有一条 allow 规则
 * （或一条 allow 改写），任何启用着的采集程序不需要任何授权就能列出会议、拿到
 * 下载地址；而采集授权页按授权行枚举，同一场会议在那边显示「0 场对它开放」。
 * 漂移方向是**控制台说 0、程序实际取得到**——这是最不该出现的那个方向。
 * 今天库里一条 allow 规则都没有，所以还没真的发生，但闸门本身缺了一半。
 *
 * 连带补上的还有另一件事：`meeting_overrides` **没有程序这一维**，一条 allow 改写
 * 在网关等于对**所有**启用中的程序放行。授权行就是那个按程序过滤的环节，
 * 补上它这条也就闭合了。
 *
 * ## 为什么授权排在人工改写**之后**，而不是之前
 *
 * 改写替换的是「**规则**怎么判这场会议」（spec §5.4：单场会议的人工改写优先于
 * 所有规则）。授权是另一个独立的「与」，两者管的不是同一件事：给一场会议加一条
 * allow 改写，是管理员在说「这场会议规则上放行」，**不是**在说「这场会议授权给了
 * 谁」——后者只能在采集授权页做。所以改写不能替代授权，套完改写还要再过一道授权行。
 *
 * 反过来（授权在前、改写在后）的表现是：一条 allow 改写把没授权的会议也放出去了，
 * 而那正是上面说的「改写没有程序维度」那个洞。
 *
 * ## 与 `visibility.ts` 的关系
 *
 * `grantScope` / `intersectGrantScope` 原本长在 `visibility.ts` 里，这次搬到 policy 层
 * **共用同一份**：两边各存一份「空数组算不算不限制」的判断，早晚会漂移，
 * 而漂移的一侧就是一次静默放行或一次没人说得清的静默拒绝。
 *
 * 搬来的只有这两个纯函数。`visibility.ts` **不改用 `applyGrant`**：它要的不是一个
 * 判定，是一张「缺哪几个『与』、各自去哪一页处理」的清单（`InventoryBlocker`），
 * 一场会议同时缺两个时两个都要报。两者是同一条语义的两种输出形状，不是同一段代码。
 */

import type { AssetKey } from '@yaowu/mde-engine'
import type { OverriddenDecision } from './override'
// 「规则侧到底放行了没有」只有 `isVisible` 那一份口径，不在这里把
// `effect === 'allow' && assetTypes.length > 0` 再写一遍——那正是 `isVisible`
// 注释里说的、旧实现踩过的坑的第二份拷贝。它长在 `stacks.ts` 而不是 `access.ts`，
// 就是为了让本文件不必反过来 import `access.ts`（那边要 import 本文件的 `applyGrant`）
import { isVisible, normalizeAssetTypes, type AllowEffect } from './stacks'

/**
 * 一条逐会议授权。**按 policy 层自己的口径声明，不是 `Pick<GrantsStore, …>`**：
 * 这一层只读三个字段，不必反过来依赖库表的行结构（`id` / `programId` /
 * `grantedAt` / `revokedAt` 它一个都不读——按哪个程序筛、撤销了没有，
 * 是 store 那边查询条件的事）。与 `access.ts` 的 `OverrideSource`、
 * `stacks.ts` 的 `StackRule` 是同一个取舍。
 */
export interface GrantLike {
  meetingId: string
  subMeetingId: string
  /**
   * 三态，**读写两侧都不许合并**（与 `meeting_grants.asset_types` 一致）：
   * `null` = 本条不额外限制资产类型，以规则栈的判定为准；
   * 非空数组 = 白名单；`[]` = **什么都不授权**（不是「不限制」）。
   */
  assetTypes: string[] | null
}

/**
 * 授权行的读法。`src/store/grants.ts` 的 `GrantsStore` 结构上已经满足它
 * （`MeetingGrant` 是 `GrantLike` 的超集），装配处直接把 store 递进来即可。
 */
export interface GrantSource {
  /** 单场判定用。查不到返回 null——「没授权」不是错误，是三个「与」里缺了一个 */
  findActiveGrant(
    meetingId: string,
    subMeetingId: string,
    programId: string,
  ): Promise<GrantLike | null>
  /** 批量判定用。列会议一页两百场，逐场查就是两百次同样的往返 */
  listActiveGrantsForProgram(programId: string): Promise<GrantLike[]>
}

/**
 * 授权行给这场会议划的资产范围。三态与 `GrantLike.assetTypes` 逐字一致：
 * `null` = 不额外限制（以规则栈判定为准）· 非空数组 = 白名单 · `[]` = **什么都不授权**。
 *
 * 返回 `null` 表示「不限制」。**不许把空数组读成不限制**——在授权中枢里让空集合
 * 意外等价于全集，正是「不许静默放行」要防的事故。
 */
export function grantScope(grant: GrantLike | null): AssetKey[] | null {
  if (grant === null) return null
  if (grant.assetTypes === null) return null
  // 认不出的资产名在这里被丢掉（normalizeAssetTypes 的既有行为）：授权里写着
  // 原型的短名 'summary' 时，它不该恰好等价于「不限制」。
  return normalizeAssetTypes(grant.assetTypes).keys
}

/**
 * 规则侧放行的那几类与授权范围求交，得出这个程序实际取得到哪几类。
 *
 * **人工改写那一层不在这里再交一次。** 改写**优先于所有规则**（spec §5.4），
 * `applyOverride` 因此是**替换**语义：改写指定了范围就用改写的，`null` 才沿用规则
 * 那份。在这里再与规则侧交一次，一条把 deny 翻成 allow 的改写会与「规则侧的空集」
 * 相交、算出空集，于是改写等于没写。所以传进来的 `ruleKeys` 已经是改写生效之后的
 * 那一份，这里只再交授权行。
 */
export function intersectGrantScope(
  ruleKeys: readonly AssetKey[],
  scope: AssetKey[] | null,
): AssetKey[] {
  if (scope === null) return [...ruleKeys]
  return ruleKeys.filter((k) => scope.includes(k))
}

/**
 * 给一个**已经套过人工改写**的 allow 判定再套上这场会议对这个程序的授权行。
 *
 * 纯函数：不读 store、不读时钟，同一批原料必然算出同一个结果。所以
 * `decide` 与 `decideMany` 共用它，两条路径的语义不可能分叉。
 *
 * 三条规矩：
 *
 * 1. **规则侧本来就不放行 → 原样返回。** 理由仍是规则/改写那一句，一个字都不提授权。
 *    这场会议本来就取不到，再补一句「而且也没授权」只会让管理员先跑一趟采集授权页，
 *    回来发现规则那边照样拦着。
 * 2. **规则放行但没有授权 → 判成拒绝，`source` 记 `not_granted`。**
 *    `ruleId` / `note` **原样留着**：审计里 `matched_rule` 记的就是放行的那条规则，
 *    配上这句理由，事后看得出「规则放行了、是授权没给」——这两句话去的是两个不同的页面。
 * 3. **规则放行且有授权 → 与授权范围求交。** 收窄了就把收窄这件事写进理由；
 *    交集为空时 **effect 仍是 `allow`**，靠 `isVisible` 判成不可见、`allowsAsset`
 *    判成不放行。这与 `visibility.ts` 的 `grant_scope_empty` 是同一件事：
 *    「规则放行了，只是授权一类都没给」与「没有授权」是两句不同的话。
 */
export function applyGrant(
  decision: OverriddenDecision<AllowEffect>,
  grant: GrantLike | null,
  programId: string,
): OverriddenDecision<AllowEffect> {
  // 规矩 1：规则侧不可见（deny，或 allow 但一类资产都没有）
  if (!isVisible(decision)) return decision

  // 规矩 2：没有授权行
  if (grant === null) {
    return {
      ...decision,
      effect: 'deny',
      assetTypes: [],
      source: 'not_granted',
      reason:
        `${decision.reason}；但这场会议没有授权给采集程序「${programId}」，` +
        `三个「与」缺一个都取不到，按拒绝处理`,
    }
  }

  // 规矩 3：与授权范围求交
  const scope = grantScope(grant)
  // 「不限制」时这一层什么都不做——连理由都不加一句，否则每一条判定理由后面
  // 都挂着一句「授权没有额外限制」，真正有限制的那几条反而淹了
  if (scope === null) return decision
  const assets = intersectGrantScope(decision.assetTypes, scope)
  // `assets` 是 `decision.assetTypes` 按顺序过滤出来的子集，所以长度相等就是逐项相同，
  // 不必再逐项比一遍
  if (assets.length === decision.assetTypes.length) return decision
  return {
    ...decision,
    assetTypes: assets,
    reason:
      decision.reason +
      `；授权行只授权了 ${scope.join('、')}，` +
      `实际放行 ${assets.length > 0 ? assets.join('、') : '一类都没有'}`,
  }
}
