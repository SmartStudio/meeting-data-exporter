/**
 * 采集清单重算（阶段 3 · T8）。
 *
 * spec §1.3 只有一个公式，但它是这一页的全部价值：
 *
 * ```
 * 外部程序真能取到 =
 *        有授权（这场会议授权给了这个程序）
 *   且  在保留期内（本地文件还没被删）
 *   且  规则允许采集（权限规则栈判定 allow）
 * ```
 *
 * 三个「与」分别由不同的人、在不同的页面维护，所以 §4.5 那句蓝底的话
 * 「现在可取走 **4** 场会议的 AI 纪要 + 完整转写」**是求交之后的实际结果，不是配置值**。
 * 本文件算的就是这个交集。
 *
 * ## 一、这一层给事实，不给阈值
 *
 * §4.5 还要求把快到期的用琥珀额外标出（「其中 1 场 7 天内到期」）。**「几天算快到期」
 * 是调用方的事**，所以这里只给 `expiresAt` 这个事实，不在这一层判阈值——阈值在这里
 * 写死，界面上想换个天数就得改 worker。
 *
 * ## 二、「在保留期内」的判据是本地文件还在，不是窗口算出来到没到期（D-u）
 *
 * spec §1.3 括号里写的是「**本地文件还没被删**」——那才是定义，`expiresAt` 只是预告。
 * 于是：
 *
 * | `meeting_archives` | 判定 |
 * | --- | --- |
 * | 没有行 + 本地有 completed 资产 | **文件在，算数**（保留窗口还没开始计时而已） |
 * | 没有行 + 本地也没有资产 | 取不到，但理由**不是**「去 NAS 取」——NAS 上也没有 |
 * | 有行，`local_purged_at IS NULL` | **文件在，算数** |
 * | 有行，`local_purged_at` 非空 | 取不到，「本地已到期，请去 NAS 取」（§4.10） |
 *
 * 由此产生一个真实状态：**窗口已过期但清理被暂停**（`system_settings.cleanup_paused`，
 * 见 `retention.ts` 的硬要求 2）的会议，文件还在，所以**仍然可取**。这是对的——
 * 清单描述的是此刻的事实，不是政策。它下一轮清理就会消失，所以 `expiresAt` 照样报出来。
 *
 * 反过来，把 `expiresAt < now` 当成「取不到」会让一批文件明明还在的会议凭空从清单里
 * 消失：对接方来问「接口是不是坏了」，管理员照着控制台看又确实是 0 场，谁都查不出来。
 *
 * ## 三、三个条件缺哪一个都要说得出是缺哪一个（D-w）
 *
 * spec §1.3 明写「界面必须随时能回答『为什么这场会议这个程序取不到』」，所以本文件
 * **不只返回一个可取会议的数组**：每一场都带着 `blockers`，三个原因互不相同，
 * 各自指向不同的一页（`remedy`）。
 *
 * **一场会议同时缺两个时两个都报，不是报第一个就停。** 只报第一个的话，管理员补上
 * 授权后会发现还是取不到，再去改规则又发现本地已清理——同一件事来回三趟。
 *
 * ## 四、批量，不要 N+1
 *
 * 清单是按程序算的，一个程序可能授权了成百上千场会议。所以：规则每次重算**取一次**，
 * 归档状态、人工改写、会议元数据各**一次问清一批**。`evaluateInventory` 本身是纯函数，
 * 一次 store 都不读——读法集中在 `computeProgramInventory` 那一小段里，
 * 想知道这次重算发了几次查询，数那一段就够了。
 *
 * ## 五、不做的事
 *
 * 定时任务的调度接线（`src/worker/index.ts`）不在这里。本文件交付的是一个能被调用的
 * 纯计算模块 + 它需要的批量读法，谁多久调一次是调度那一层的事。
 */

import { ALL_ASSET_KEYS, type AssetKey } from '@yaowu/mde-engine'
import type { Meeting } from '../domain/types'
import { isVisible, meetingFacts } from '../policy/access'
import {
  applyOverride,
  indexOverrides,
  wasOverridden,
  type MeetingOverride as PolicyOverride,
  type OverriddenDecision,
} from '../policy/override'
import {
  evaluateAllowStack,
  normalizeAssetTypes,
  type AllowEffect,
  type StackRule,
} from '../policy/stacks'
import { archiveStateKey, type ArchivesStore, type MeetingArchiveRecord } from '../store/archives'
import type { GrantsStore, MeetingGrant, MeetingKey } from '../store/grants'
import type { PolicyStore } from '../store/policy'
// 保留窗口的定义只有一处：到期清理按它挑候选，清单按它答「还剩几天」。
// 两处各存一份公式的话，清单说「还剩 3 天」而清理昨天就删了文件
import { expiresAt } from './retention'

// ── 输出形状 ──────────────────────────────────────────────────

/**
 * 一场会议对一个采集程序取不到的原因。**三个「与」各有各的说法，不许合并成
 * 一句「不满足条件」**——那句话管理员读完不知道该去哪一页。
 */
export type InventoryBlockCode =
  /** 第一个「与」：这场会议没有授权给这个程序 */
  | 'not_granted'
  /** 第二个「与」：本地文件已被到期清理，NAS 上还有（§4.10） */
  | 'local_purged'
  /** 第二个「与」的另一面：还没归档，本地也没有下载完成的资产——哪儿都没有 */
  | 'no_local_files'
  /** 第三个「与」：采集权限规则（或人工改写）判定不放行 */
  | 'rule_denied'
  /** 规则放行了，但授权行把资产范围收成了空集，实际一类都取不到（D-y） */
  | 'grant_scope_empty'
  /** 会议元数据查不到，判不出来——落到拒绝一侧，不是静默放行 */
  | 'meeting_unknown'

/** 管理员该去哪儿处理。三个「与」由不同的人在不同的页面维护，这个字段就是那条指路 */
export type InventoryRemedy =
  /** 采集授权页 */
  | 'grants'
  /** 本地没有了，去 NAS 按归档目录取 */
  | 'nas'
  /** 自动规则页（或单场会议的人工改写） */
  | 'rules'
  /** 谁都改不了：等归档流水线，或者去看这场会议的归档失败告警 */
  | 'pipeline'

export interface InventoryBlocker {
  code: InventoryBlockCode
  /** 卡在三个「与」的哪一个上 */
  gate: 'grant' | 'retention' | 'rule'
  /** 一句话理由，可直接进会议详情抽屉与审计（§1.3 / §4.10） */
  reason: string
  remedy: InventoryRemedy
  /** 规则不放行时是哪条规则决定的；兜底 deny 与人工改写都没有规则，为 null */
  ruleId: number | null
  /** 那条规则的 note（人工改写时是管理员写的 reason）。spec §6.3：它会进判定理由 */
  note: string | null
}

/** 一场会议 × 一个采集程序的重算结果 */
export interface InventoryEntry {
  meetingId: string
  subMeetingId: string
  /** 三个「与」都成立，且求交之后至少还剩一类资产 */
  fetchable: boolean
  /**
   * 这个程序**实际**取得到的资产类型：规则（含人工改写）判定的范围 ∩ 授权行的范围。
   * 取不到时是空数组——「现在可取走 N 场会议」里的 N 不该包含这种会议（D-y）。
   */
  assetTypes: AssetKey[]
  /**
   * 本地文件的到期时刻，unix 秒。**没有归档行时为 null**：保留窗口从归档成功那一刻
   * 才开始计时，没归档过就没有到期时刻可言，填 0 或者填 now 都是编数据。
   *
   * 已经清理掉的会议照样给出这个值——它是一件发生过的事实，界面要拿它说
   * 「什么时候到的期」。**「几天算快到期」不在这一层判**（D-v）。
   */
  expiresAt: number | null
  /**
   * 采集权限栈的判定，已经套过人工改写（`applyOverride`）。
   * `overriddenFrom` 上挂着「若无这次改写规则本会判什么」。
   *
   * **会议元数据查不到时为 null**：那种情况下规则根本没跑过，给一个假的判定
   * 比给 null 更难查——详情抽屉会显示一条从未发生过的判定。
   */
  decision: OverriddenDecision<AllowEffect> | null
  /** 这次判定是不是人工改写决定的（spec §5.4 的列表标记）。走 `wasOverridden`，
   *  不写 `source === 'override'`——那会漏掉 `override_invalid` */
  overridden: boolean
  /** 卡在哪几个「与」上。**三个都缺就三条都在**，不是报第一个就停（D-w） */
  blockers: InventoryBlocker[]
}

/** 一个采集程序的完整清单。spec §4.5 那张卡片要的东西全在这里 */
export interface ProgramInventory {
  programId: string
  /** 这次重算用的时刻，unix 秒。求值器不读时钟，重算结果因此可回放 */
  now: number
  /** 授权给这个程序的每一场会议，含现在取不到的那些 */
  entries: InventoryEntry[]
  /** 现在真能取走的那些——**§4.5 那句话里的 N 数的是它，不是 `entries`** */
  fetchable: InventoryEntry[]
  /** 已授权但现在取不到的那些，各自带着理由（原型的「已授权但现在取不到的 N 场」） */
  blocked: InventoryEntry[]
  /** 可取会议的资产类型并集，按 `ALL_ASSET_KEYS` 的顺序。
   *  §4.5 那句话的后半句「……的 AI 纪要 + 完整转写」读的是它 */
  assetTypes: AssetKey[]
}

// ── 输入：纯函数那一半 ────────────────────────────────────────

/**
 * 一次重算要用到的全部原料。**已经取好了**——`evaluateInventory` 一次 store 都不读，
 * 于是「同一批原料 ⇒ 同一个结果」，可回放、可在测试里逐条构造。
 */
export interface InventoryMaterial {
  /** 采集程序，对应 `service_accounts.id` */
  programId: string
  /** unix 秒 */
  now: number
  /**
   * 要考察的会议。清单重算传「这个程序的全部授权会议」；单场答疑传那一场，
   * **哪怕它根本没有授权**——「没授权」正是要报的第一条理由。
   */
  meetings: readonly MeetingKey[]
  /** 采集权限栈的启用规则。**每次重算取一次**，不是每场会议取一次 */
  rules: readonly StackRule[]
  grants: readonly MeetingGrant[]
  archives: readonly MeetingArchiveRecord[]
  /** 本地还有 completed 资产的会议，用 `archiveStateKey()` 编码 */
  localAssets: ReadonlySet<string>
  /** 会议元数据。规则求值只认事实，事实从这里来 */
  meta: readonly Meeting[]
  /** 这批会议当前生效的人工改写，三栈混在一起给就行——这里只挑 allow 那一条 */
  overrides: readonly PolicyOverride[]
}

// ── store 依赖 ────────────────────────────────────────────────

export interface VisibilityDeps {
  policy: Pick<PolicyStore, 'listEnabledStackRules'>
  grants: Pick<
    GrantsStore,
    'listActiveGrantsForProgram' | 'findActiveGrant' | 'listActiveOverridesForMeetings'
  >
  archives: Pick<ArchivesStore, 'listMeetingArchives' | 'listMeetingsWithCompletedAssets'>
  /**
   * 会议元数据，**批量**。
   *
   * 由调用方注入而不是从 `ArchivesStore` 拿：那个 store **刻意不读 `meetings` 表**
   * （见它的文件头），`src/worker/archive.ts` 的 `ArchiveDeps.getMeeting` 是同一个先例。
   * 区别只在这里必须是批量的——清单是按程序算的，逐场取就是成百上千次往返。
   *
   * 查不到的会议**不要造一个空壳顶上**：返回的数组里没有它，本文件会把它判成
   * 「判不出来」并落到拒绝一侧。空壳会让一条 `title has 财务` 的规则对着空标题
   * 判不匹配，看起来一切正常。
   */
  getMeetings: (keys: readonly MeetingKey[]) => Promise<readonly Meeting[]>
}

// ── 到期时刻 ──────────────────────────────────────────────────

// ── 求交 ──────────────────────────────────────────────────────

function keyOf(k: MeetingKey): string {
  return archiveStateKey(k.meetingId, k.subMeetingId)
}

function byKey<T extends MeetingKey>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [keyOf(r), r]))
}

/** unix 秒读成一句人话，只为进判定理由——不做本地化，UTC 就是审计里的口径 */
function stamp(sec: number): string {
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

/**
 * 授权行给这场会议划的资产范围。三态与 D-n 逐字一致：
 * `null` = 不额外限制（以规则栈判定为准）· 非空数组 = 白名单 · `[]` = **什么都不授权**。
 *
 * 返回 `null` 表示「不限制」。**不许把空数组读成不限制**——在授权中枢里让空集合
 * 意外等价于全集，正是「不许静默放行」要防的事故。
 */
function grantScope(grant: MeetingGrant | null): AssetKey[] | null {
  if (grant === null) return null
  if (grant.assetTypes === null) return null
  // 认不出的资产名在这里被丢掉（normalizeAssetTypes 的既有行为）：授权里写着
  // 原型的短名 'summary' 时，它不该恰好等价于「不限制」。
  return normalizeAssetTypes(grant.assetTypes).keys
}

/**
 * 这个程序实际取得到哪几类。
 *
 * **人工改写那一层不在这里再交一次。** D-y 把它写成「规则 ∩ 授权 ∩ 改写」三者求交，
 * 但改写**优先于所有规则**（spec §5.4 / D-x），`applyOverride` 因此是**替换**语义：
 * 改写指定了范围就用改写的，`null` 才沿用规则那份（D-o）。在这里再与规则侧交一次，
 * 一条把 deny 翻成 allow 的改写会与「规则侧的空集」相交、算出空集，
 * 于是改写等于没写——正好废掉 D-x。所以 `decision.assetTypes` 已经是改写生效之后的
 * 那一份，这里只再交授权行。
 */
function intersect(ruleKeys: readonly AssetKey[], scope: AssetKey[] | null): AssetKey[] {
  if (scope === null) return [...ruleKeys]
  return ruleKeys.filter((k) => scope.includes(k))
}

// ── 一场会议 ──────────────────────────────────────────────────

interface RetentionCheck {
  /** 到期时刻；没有归档行时为 null（窗口还没开始计时） */
  expiresAt: number | null
  /** 文件还在就是 null。这一个字段既是判定也是理由，不另留一个会与它对不上的布尔 */
  blocker: InventoryBlocker | null
}

/**
 * 第二个「与」：本地文件还在没有（D-u）。
 *
 * 判据是 `local_purged_at IS NULL`，**不是** `expiresAt >= now`。窗口过了但清理被
 * 暂停的会议文件还在，此刻真取得到；`expiresAt` 只是预告，照样带出去给界面用。
 */
function checkRetention(
  key: MeetingKey,
  rec: MeetingArchiveRecord | undefined,
  hasLocalAssets: boolean,
): RetentionCheck {
  if (rec === undefined) {
    // 还没归档过。保留窗口没开始计时，所以没有到期时刻可言
    if (hasLocalAssets) return { expiresAt: null, blocker: null }
    return {
      expiresAt: null,
      blocker: {
        code: 'no_local_files',
        gate: 'retention',
        reason:
          `这场会议还没有归档到 NAS，本地也没有任何下载完成的资产——现在没有文件可取。` +
          `这不是「本地已到期」：NAS 上也没有副本，去 NAS 取会扑空。` +
          `要么归档流水线还没轮到它，要么归档一直在失败（那是最高级别的告警，见 spec §1.2）`,
        remedy: 'pipeline',
        ruleId: null,
        note: null,
      },
    }
  }

  const due = expiresAt(rec)
  if (rec.localPurgedAt === null) return { expiresAt: due, blocker: null }

  return {
    expiresAt: due,
    blocker: {
      code: 'local_purged',
      gate: 'retention',
      // §4.10 的原话，审计里那条红记录写的也是这一句，两处必须一字不差
      reason:
        `本地已到期，请去 NAS 取：本地文件已于 ${stamp(rec.localPurgedAt)} 到期清理` +
        `（保留期到 ${stamp(due)}），NAS 上的副本在 ${rec.nasDir}。` +
        `数据库记录永久保留，会议 ${key.meetingId} 照样搜得到，只是要按这个路径去 NAS 取`,
      remedy: 'nas',
      ruleId: null,
      note: null,
    },
  }
}

/** 规则不放行时那条 blocker。理由直接用判定的 `reason`——它已经说得出是哪条规则 */
function ruleBlocker(decision: OverriddenDecision<AllowEffect>): InventoryBlocker {
  // 判定是 allow 却一类合法资产都没列出：与 `isVisible` 同源的那半条
  // （`effect === 'allow' && assetTypes.length > 0`）。此时把会议列进清单，
  // 等于在没有任何可取内容的前提下泄露它的标题与主持人。
  const emptyAllow =
    decision.effect === 'allow'
      ? '——判定虽是准许，却没有列出任何合法的资产类型，实际一类都取不到'
      : ''
  return {
    code: 'rule_denied',
    gate: 'rule',
    reason: `${decision.reason}${emptyAllow}`,
    remedy: 'rules',
    ruleId: decision.ruleId,
    note: decision.note,
  }
}

/** 授权行把范围收成空集时那条 blocker。三种收法要分得开，见函数体 */
function scopeBlocker(
  grant: MeetingGrant,
  ruleKeys: readonly AssetKey[],
  scope: AssetKey[],
): InventoryBlocker {
  const allowed = `采集权限规则放行的是 ${ruleKeys.join('、')}`
  // 三种收成空集的方式在界面上是三句不同的话：管理员要改的东西不一样。
  // 尤其中间那种——授权里明明列了资产名，却一个都不认识——报成「你填了空数组」
  // 会让他对着一个非空的白名单百思不得其解。
  let reason: string
  if (grant.assetTypes !== null && grant.assetTypes.length > 0 && scope.length === 0) {
    reason =
      `${allowed}，而这条授权列的资产名（${grant.assetTypes.join('、')}）一个都不是合法的资产键，` +
      `全部被忽略了，于是实际取不到任何东西——原型里的短名不能进代码，合法取值见 D-c`
  } else if (scope.length === 0) {
    reason =
      `这条授权的资产范围是空数组——按 D-n 那是「什么都不授权」，不是「不限制」。` +
      `${allowed}，但授权一类都没给，实际取不到任何东西`
  } else {
    reason = `${allowed}，而这条授权只授权了 ${scope.join('、')}，两者没有交集，实际取不到任何东西`
  }
  return {
    code: 'grant_scope_empty',
    gate: 'grant',
    reason: `${reason}（授权行 #${grant.id}）`,
    remedy: 'grants',
    ruleId: null,
    note: null,
  }
}

// ── 纯函数入口 ────────────────────────────────────────────────

/**
 * 逐场会议求三个「与」的交集。**纯函数**：不读 store、不读时钟，
 * 同一批原料必然算出同一个结果。
 *
 * 返回顺序与 `material.meetings` 一致——调用方给的是授权行的顺序，
 * 清单在界面上的顺序因此是稳定的。
 */
export function evaluateInventory(material: InventoryMaterial): InventoryEntry[] {
  const grants = byKey(material.grants)
  const archives = byKey(material.archives)
  const meta = byKey(material.meta)

  // 改写按会议归位。indexOverrides 一次只认一场会议的若干条（它要在同一栈上挑最新的
  // 那条），所以先按会议分组，不能把整批一股脑喂进去——那会让 A 会议的改写盖住 B 的。
  const overridesByMeeting = new Map<string, PolicyOverride[]>()
  for (const o of material.overrides) {
    const k = keyOf(o)
    const list = overridesByMeeting.get(k)
    if (list === undefined) overridesByMeeting.set(k, [o])
    else list.push(o)
  }

  return material.meetings.map((key) => {
    const k = keyOf(key)
    const blockers: InventoryBlocker[] = []

    // 第一个「与」：有授权
    const grant = grants.get(k) ?? null
    if (grant === null) {
      blockers.push({
        code: 'not_granted',
        gate: 'grant',
        reason:
          `这场会议没有授权给采集程序「${material.programId}」。` +
          `采集权限规则放行与否是另一回事——三个「与」缺任何一个都取不到，` +
          `要让它取得到，先去采集授权页把这场会议授权给这个程序`,
        remedy: 'grants',
        ruleId: null,
        note: null,
      })
    }

    // 第二个「与」：在保留期内 = 本地文件还在（D-u）
    const retention = checkRetention(key, archives.get(k), material.localAssets.has(k))
    if (retention.blocker !== null) blockers.push(retention.blocker)

    // 第三个「与」：规则允许采集（改写套在规则之外，D-x）
    const m = meta.get(k)
    let decision: OverriddenDecision<AllowEffect> | null = null
    let ruleOk = false
    if (m === undefined) {
      // 判不出来就落到拒绝一侧，并且说出是判不出来——不是静默放行，也不是编一个判定
      blockers.push({
        code: 'meeting_unknown',
        gate: 'rule',
        reason:
          `会议 ${key.meetingId}${key.subMeetingId === '' ? '' : `/${key.subMeetingId}`} ` +
          `在 meetings 表里查不到，取不到判定采集权限规则所需的事实（标题、主持人、时间），` +
          `无从判定，按拒绝处理。这多半是数据完整性问题：授权行指着一场不存在的会议`,
        remedy: 'pipeline',
        ruleId: null,
        note: null,
      })
    } else {
      const archived = archives.has(k)
      const base = evaluateAllowStack(material.rules, {
        // `arch` 条件（isarch / notarch）的数据源是「meeting_archives 里有没有行」，
        // 与「本地文件还在不在」是两件事：清理过的会议照样是已归档的。
        facts: meetingFacts(m, archived),
        now: material.now,
        programId: material.programId,
      })
      const set = indexOverrides(overridesByMeeting.get(k) ?? [])
      decision = applyOverride(base, set.allow)
      ruleOk = isVisible(decision)
      if (!ruleOk) blockers.push(ruleBlocker(decision))
    }

    // 资产类型求交（D-y）。规则侧那一份已经含了人工改写，见 intersect 的注释
    const ruleKeys = decision === null ? [] : decision.assetTypes
    const scope = grantScope(grant)
    const assetTypes = intersect(ruleKeys, scope)
    // 只有规则确实放行了才谈得上「授权把范围收成了空」——规则本来就不放行时，
    // 空集是规则那条 blocker 已经解释过的事，再报一条只是把同一件事说两遍
    if (ruleOk && grant !== null && assetTypes.length === 0) {
      blockers.push(scopeBlocker(grant, ruleKeys, scope ?? []))
    }

    const fetchable = blockers.length === 0
    return {
      meetingId: key.meetingId,
      subMeetingId: key.subMeetingId,
      fetchable,
      // 取不到就是一类都取不到。规则那边本来放行哪几类仍然留在 decision.assetTypes 上
      // 供详情抽屉用；把它原样搬到这个字段里，卡在保留期上的会议会显示成
      // 「可取 video、transcript」，而那正是此刻取不到的东西
      assetTypes: fetchable ? assetTypes : [],
      expiresAt: retention.expiresAt,
      decision,
      overridden: decision !== null && wasOverridden(decision),
      blockers,
    }
  })
}

/** 可取会议的资产类型并集，按 `ALL_ASSET_KEYS` 的顺序——顺序稳定，界面上不会跳 */
export function inventoryAssetTypes(entries: readonly InventoryEntry[]): AssetKey[] {
  const seen = new Set<AssetKey>()
  for (const e of entries) {
    if (!e.fetchable) continue
    for (const a of e.assetTypes) seen.add(a)
  }
  return ALL_ASSET_KEYS.filter((k) => seen.has(k))
}

// ── store 入口 ────────────────────────────────────────────────

/**
 * 一批会议要用到的原料，一次问清。**发出去的查询数与会议数无关**：
 * 规则 1 次、归档 1 次、改写 1 次、会议元数据 1 次，外加「缺归档行的那些会议本地
 * 还有没有资产」至多 1 次。
 */
async function gather(
  deps: VisibilityDeps,
  programId: string,
  now: number,
  keys: readonly MeetingKey[],
  grants: readonly MeetingGrant[],
): Promise<InventoryMaterial> {
  const [rules, archives, overrides, meta] = await Promise.all([
    deps.policy.listEnabledStackRules('allow'),
    deps.archives.listMeetingArchives(keys),
    deps.grants.listActiveOverridesForMeetings([...keys]),
    deps.getMeetings(keys),
  ])

  // 有归档行的会议已经用 local_purged_at 答完了「文件在不在」，不必再问本地资产。
  // 只有没归档过的那些才需要这一问，所以这条查询多数轮次根本不会发出去。
  const archivedKeys = new Set(archives.map((a) => keyOf(a)))
  const unarchived = keys.filter((k) => !archivedKeys.has(keyOf(k)))
  const localAssets =
    unarchived.length === 0
      ? new Set<string>()
      : await deps.archives.listMeetingsWithCompletedAssets(unarchived)

  return { programId, now, meetings: keys, rules, grants, archives, localAssets, meta, overrides }
}

/**
 * 一个采集程序的清单重算（定时任务四）。
 *
 * 枚举源是**授权行**：spec §4.5 那张卡片问的是「这个程序现在实际能取到多少东西」，
 * 没授权给它的会议压根不在讨论范围内。所以 `entries` 里不会出现 `not_granted`——
 * 那条理由属于单场答疑（`explainMeetingAccess`）。
 */
export async function computeProgramInventory(
  deps: VisibilityDeps,
  input: { programId: string; now: number },
): Promise<ProgramInventory> {
  const grants = await deps.grants.listActiveGrantsForProgram(input.programId)
  if (grants.length === 0) {
    // 一场都没授权就不必再问归档、改写、会议元数据——四次白跑的查询，
    // 而「刚接进来还没授权任何会议」正是新程序的常态
    return {
      programId: input.programId,
      now: input.now,
      entries: [],
      fetchable: [],
      blocked: [],
      assetTypes: [],
    }
  }

  const keys: MeetingKey[] = grants.map((g) => ({
    meetingId: g.meetingId,
    subMeetingId: g.subMeetingId,
  }))
  const entries = evaluateInventory(
    await gather(deps, input.programId, input.now, keys, grants),
  )

  return {
    programId: input.programId,
    now: input.now,
    entries,
    fetchable: entries.filter((e) => e.fetchable),
    blocked: entries.filter((e) => !e.fetchable),
    assetTypes: inventoryAssetTypes(entries),
  }
}

/**
 * 「为什么这场会议这个程序取不到」——spec §1.3 要求界面**随时**答得出的那句话。
 *
 * 与清单重算走的是同一段判定，所以两处不会给出不同的答案。差别只在枚举源：
 * 这里认的是调用方指定的那一场会议，**没有授权也照样算**——「没授权」是三条理由
 * 里的第一条，答不出来这一层就白做了。
 */
export async function explainMeetingAccess(
  deps: VisibilityDeps,
  input: { programId: string; meetingId: string; subMeetingId: string; now: number },
): Promise<InventoryEntry> {
  const key: MeetingKey = { meetingId: input.meetingId, subMeetingId: input.subMeetingId }
  const grant = await deps.grants.findActiveGrant(
    input.meetingId,
    input.subMeetingId,
    input.programId,
  )
  const material = await gather(
    deps,
    input.programId,
    input.now,
    [key],
    grant === null ? [] : [grant],
  )
  const entry = evaluateInventory(material)[0]
  // evaluateInventory 逐场返回，传一场就一定回来一场
  if (entry === undefined) throw new Error('evaluateInventory returned no entry for a single key')
  return entry
}
