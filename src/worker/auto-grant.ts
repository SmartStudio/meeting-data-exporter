/**
 * 程序级自动授权（方案 2 · 定时任务五「自动授权」）。
 *
 * spec §1.3 的公式一个字都不改：
 *
 * ```
 * 外部程序真能取到 = 有授权 且 在保留期内 且 规则允许采集
 * ```
 *
 * 此前那三个「与」里的**第一个**只有一条产生途径：管理员在会议记录页一场一场点。
 * 规则、保留期都是自动的，唯独「给谁」要人每天再点一遍今天新进来的那批会议。
 * 本文件补的就是这一条途径——**不是第四种判定**，是一个「系统代人点」的写入源：
 * 它往 `meeting_grants` 里写的是**和人点出来的一模一样的授权行**，清单、网关闸门、
 * 待授权分诊、审计、批量撤销全部原样能用。区别只在审计里那一条 `auto_grant_meeting`
 * 记着这次是系统按规则代点的。
 *
 * ## 三条规矩（它们才是这个功能的全部风险面）
 *
 * 1. **候选判定不比规则更宽。** 会议要同时满足：文件还在本地、采集权限栈（含人工
 *    改写）判「准许」、尚无生效授权、从未被人工撤销过。程序 `enabled = 0` 时**整个
 *    程序跳过**——停用是「先别取」，不该在停用期间替它堆授权。
 * 2. **人工撤销过的会议不再自动补回。** 只要 `meeting_grants` 里这个
 *    (会议, 场次, 程序) 有过 `revoked_at <> 0` 的行，就跳过。人的决定压过开关：
 *    没有这一条的话，管理员撤销一次、下一轮自动写回来，两边都不报错。
 * 3. **关掉开关不收回已有授权。** 那是 handler 那一侧的事（本文件压根没有撤销路径），
 *    记在这里是因为读这个文件的人多半正想知道「关掉之后呢」。可逆动作不该带
 *    不可逆后果，要收回请去会议记录页批量收回。
 *
 * ## 结构：纯函数 + 一小段 store 读法
 *
 * 与 `visibility.ts` 同一个分工，理由也同一个：判定这件事必须能在测试里逐条构造、
 * 能回放。`planAutoGrants` 一次 store 都不读、一次时钟都不读，同一批原料必然算出
 * 同一份计划；`runAutoGrantRound` 负责把原料**批量**取齐（发出去的查询数与会议数
 * 无关）、按计划写授权行与审计。
 *
 * 判定本身**一行都不新写**：`evaluateAllowStack` + `applyOverride` + `isVisible`，
 * 与采集清单、与网关 `AccessGate` 是同一段代码。另写一份「差不多的」判定，
 * 意味着控制台说取不到而自动授权照样授权出去——那正是 §1.3 要防的漂移。
 *
 * ## 为什么候选源不是「授权行」而是「本地文件还在的会议」
 *
 * 清单重算（`computeProgramInventory`）按授权行枚举，因为它问的是「已经授权的这些
 * 现在还取不取得到」。自动授权问的是反过来的问题——「**还没**授权的里面，哪些该
 * 授权」——所以它的枚举源只能是会议那一侧。用 `local_purged_at IS NULL` ∪
 * `status='completed'` 这个集合（`ArchivesStore.listMeetingKeysWithLocalFiles`），
 * 与 spec §1.3 第二个「与」的判据逐字相同：不这么取的话，一场还没归档、但本地资产
 * 已经下完的新会议会被整批漏掉——而那正是「每天新进来的会议」最常见的形态。
 */

import type { AssetKey } from '@yaowu/mde-engine'
import { meetingFacts, type MeetingMeta } from '../policy/access'
import {
  applyOverride,
  indexOverrides,
  type MeetingOverride as PolicyOverride,
} from '../policy/override'
import { evaluateAllowStack, isVisible, type AllowEffect, type StackRule } from '../policy/stacks'
import { archiveStateKey, type ArchivesStore, type MeetingArchiveRecord } from '../store/archives'
import type { GrantsStore, MeetingKey } from '../store/grants'
import type { PolicyStore } from '../store/policy'
import type { ProgramsStore, ServiceProgram } from '../store/programs'
import { AUDIT_ACTION, AUTO_GRANT_ACTOR_ID } from '../audit/actions'
import { buildAuditDetail, type AuditStore } from '../store/audit'

// ── 输出形状 ──────────────────────────────────────────────────

/** 计划里的一场会议：这一场要授权，理由是这个 */
export interface AutoGrantItem {
  meetingId: string
  subMeetingId: string
  /**
   * 判定理由，**原样进审计 detail**。它已经说得出是哪条规则、放行了哪几类
   * （`采集权限规则 #5「…」决定：准许采集（video、transcript）`），所以这里不再
   * 另拼一句——两句话早晚会说得不一样，而审计里那句才是事后唯一的凭据。
   */
  reason: string
  /** 决定这次放行的规则 id；兜底与人工改写决定时为 null，进 `audit_log.matched_rule` */
  ruleId: number | null
  /** 采集权限栈（含改写）放行的资产类型。写授权行时**不用它**，见 `runAutoGrantRound` */
  assetTypes: AssetKey[]
}

/**
 * 一个程序这一轮的计划。**只是计划**——一行都还没写。
 *
 * 四个「跳过」的计数各自分开而不是合成一个 `skipped`：它们是四件不同的事，
 * 需要人做的动作也不同（补元数据 / 什么都不用做 / 改规则 / 人已经撤过了）。
 */
export interface AutoGrantPlan {
  programId: string
  /** 这一轮要写的授权，顺序与候选会议的顺序一致（审计因此可对账） */
  toGrant: AutoGrantItem[]
  /**
   * 规则放行、文件在本地、**且尚无生效授权**的场次数。
   * = `toGrant.length + skippedRevoked`——差额就是「人撤过所以没补回」的那些。
   */
  candidates: number
  /** 因为人工撤销过而跳过的场次数（规矩 2） */
  skippedRevoked: number
  /** 已经有生效授权、这一轮不必再管的场次数 */
  skippedGranted: number
  /** 会议元数据缺失、判不出来、按不授权处理的场次数 */
  meetingUnknown: number
  /** 规则（或人工改写）不放行的场次数 */
  ruleDenied: number
}

// ── 输入：纯函数那一半 ────────────────────────────────────────

/**
 * 一次自动授权判定要用到的全部原料。**已经取好了**——`planAutoGrants` 一次 store
 * 都不读，于是「同一批原料 ⇒ 同一份计划」，可回放、可在测试里逐条构造。
 */
export interface AutoGrantMaterial {
  /** 采集程序，对应 `service_accounts.id`。也是 allow 栈的主体值 */
  programId: string
  /**
   * 这个程序自动写出去的授权行的资产范围（`service_accounts.auto_grant_asset_types`）。
   * 只是**原样带进授权行**，不参与判定——判定是规则的事，范围是授权行的事，
   * 在这里拿它去筛会议就等于凭空多出一条谁都没写过的规则。
   */
  autoGrantAssetTypes: string[] | null
  /** unix 秒 */
  now: number
  /**
   * 候选会议：**本地文件还在**的那些（清单第二个「与」的同一判据）。
   * 调用方从 `listMeetingKeysWithLocalFiles()` 取，本函数不再判一次保留期——
   * 这个集合的定义本身就是那个判据。
   */
  meetings: readonly MeetingKey[]
  /** 采集权限栈的启用规则。**每轮取一次**，不是每场会议取一次 */
  rules: readonly StackRule[]
  /** 这批会议当前生效的人工改写，三栈混在一起给就行——这里只挑 allow 那一条 */
  overrides: readonly PolicyOverride[]
  /** 会议元数据。查不到的会议**不要造一个空壳顶上**，见 `planAutoGrants` */
  meta: readonly MeetingMeta[]
  /** 归档行。这里只用来答 `arch` 条件（isarch / notarch）要的「归档过没有」 */
  archives: readonly MeetingArchiveRecord[]
  /** 这个程序当前**已有生效授权**的会议键（`archiveStateKey()` 编码） */
  grantedKeys: ReadonlySet<string>
  /** 这个程序**曾被人工撤销过**的会议键（`archiveStateKey()` 编码），规矩 2 */
  revokedKeys: ReadonlySet<string>
}

// ── store 依赖 ────────────────────────────────────────────────

export interface AutoGrantDeps {
  programs: Pick<ProgramsStore, 'list'>
  policy: Pick<PolicyStore, 'listEnabledStackRules'>
  grants: Pick<
    GrantsStore,
    | 'grant'
    | 'listActiveGrantsForProgram'
    | 'listActiveOverridesForMeetings'
    | 'listRevokedMeetingKeysForProgram'
  >
  archives: Pick<ArchivesStore, 'listMeetingKeysWithLocalFiles' | 'listMeetingArchives'>
  /**
   * 会议元数据，**批量**。与 `VisibilityDeps.getMeetings` 是同一个注入点、同一条
   * 约定：查不到的会议不要造空壳（那会让一条 `title has 财务` 的规则对着空标题判
   * 不匹配，看起来一切正常）；元数据不全的行照样返回并带上 `missingFacts`。
   */
  getMeetings: (keys: readonly MeetingKey[]) => Promise<readonly MeetingMeta[]>
  /** 每授权一场记一条 `auto_grant_meeting`。系统代人做的事更要留痕，不是更不用 */
  audit: AuditStore
}

// ── 一轮的结果 ────────────────────────────────────────────────

/** 摘要里逐程序的那一行 */
export interface AutoGrantProgramSummary {
  programId: string
  name: string
  candidates: number
  granted: number
  skippedRevoked: number
}

/** 整个程序这一轮算不出来（或写到一半抛了）。调用方据此落一条失败项 */
export interface AutoGrantFailure {
  /** `service_accounts.id`，进 `job_failures.target` */
  programId: string
  /** 程序名，进 `job_failures.target_label`——失败项表里要显示人读的名字 */
  name: string
  reason: string
}

/**
 * 一轮的结果。
 *
 * ⚠️ **不要把整个对象原样丢进 `job_runs.summary`**：`failures` 不属于摘要，它是给
 * 调用方去落 `job_failures` 的料。摘要的形状只有四个字段（`programs` / `granted` /
 * `skippedRevoked` / `failedPrograms`），由调度器那一格显式拼出来——见
 * `scheduler.ts` 的 `auto_grant` 运行体。
 *
 * 失败项不在本文件落，是因为「影响」那句话与重试阈值属于**任务定义**
 * （`JOB_CATALOG`），而自动授权这一层不认识「任务」这个词汇。与 `retention.ts` 的
 * `executeCleanup` 把 `verificationFailed` / `failed` 交出去、由 `cleanup_expired`
 * 那一格逐条 `ctx.fail` 是同一个分工。
 */
export interface AutoGrantRound {
  programs: AutoGrantProgramSummary[]
  /** 本轮**新写**的授权数 */
  granted: number
  /** 因人工撤销过而跳过的数 */
  skippedRevoked: number
  /** 整个程序算不出来（抛了）的个数。= `failures.length` */
  failedPrograms: number
  /** 那几个程序各自的原因。**不进摘要**，见本接口的说明 */
  failures: AutoGrantFailure[]
}

// ── 纯函数入口 ────────────────────────────────────────────────

function keyOf(k: MeetingKey): string {
  return archiveStateKey(k.meetingId, k.subMeetingId)
}

/**
 * 逐场会议判「该不该自动授权给这个程序」。**纯函数**：不读 store、不读时钟。
 *
 * ## 判定顺序，以及为什么「曾撤销」这一条排在判定之后
 *
 * 顺序是：元数据缺失 → 已有生效授权 → 跑判定 → 曾撤销 → 进 `toGrant`。
 *
 * 「曾撤销」**放在判定之后**只有一个原因：`candidates` 这个数要说得出实话。它的
 * 定义是「规则放行、文件在本地、尚无生效授权的场次数」，而摘要里 `candidates` 与
 * `granted` 的差额正是运维用来判断「自动授权为什么没写那么多」的那个量。撤销过的
 * 会议若不跑一遍判定就计进候选，一场规则本来就不放行的会议会把这个差额虚报成
 * 「被人撤过」。
 *
 * **安全侧一步都没让**：撤销过的会议仍然在进入 `toGrant` **之前**被拦下，
 * 判定跑不跑都不改变它一定不被授权这件事。判定是内存里的纯计算，多跑一遍不发查询。
 *
 * 其余三条落的都是「不授权」那一侧：
 *
 * - **元数据查不到 → 不授权**（记 `meetingUnknown`）。规则要用的事实（标题、主持人、
 *   时间）取不到就判不出来，而判不出来不能当成放行。造一个空壳会更糟：一条
 *   `title has 财务 → allow` 的规则对着空标题判不匹配，于是一切「看起来正常」。
 * - **已有生效授权 → 跳过**。不是幂等的托词：`grant` 在范围不同时会**撤旧插新**，
 *   于是每一轮都调一次的话，管理员手工收窄过的那条授权会在下一轮被开关里的范围
 *   悄悄改回去——一次没人点过的放宽。
 * - **规则不放行 → 不授权**。含人工改写：`applyOverride` 是替换语义，改写说 allow
 *   就按 allow 授权（管理员写改写就是在说「这场规则上放行」），改写说 deny 就不授权。
 */
export function planAutoGrants(material: AutoGrantMaterial): AutoGrantPlan {
  const archives = new Set(material.archives.map((a) => keyOf(a)))
  const meta = new Map(material.meta.map((m) => [keyOf(m), m]))

  // 改写按会议归位。`indexOverrides` 一次只认一场会议的若干条（它要在同一栈上挑最新
  // 的那条），整批一股脑喂进去会让 A 会议的改写盖住 B 的——与 visibility.ts 同一坑
  const overridesByMeeting = new Map<string, PolicyOverride[]>()
  for (const o of material.overrides) {
    const k = keyOf(o)
    const list = overridesByMeeting.get(k)
    if (list === undefined) overridesByMeeting.set(k, [o])
    else list.push(o)
  }

  const plan: AutoGrantPlan = {
    programId: material.programId,
    toGrant: [],
    candidates: 0,
    skippedRevoked: 0,
    skippedGranted: 0,
    meetingUnknown: 0,
    ruleDenied: 0,
  }

  for (const key of material.meetings) {
    const k = keyOf(key)

    const m = meta.get(k)
    if (m === undefined) {
      plan.meetingUnknown++
      continue
    }
    if (material.grantedKeys.has(k)) {
      plan.skippedGranted++
      continue
    }

    const base = evaluateAllowStack(material.rules, {
      // `arch` 条件的数据源是「meeting_archives 里有没有行」，与「本地文件还在不在」
      // 是两件事：清理过的会议照样是已归档的（这里的候选本来就都还没清理）
      facts: meetingFacts(m, archives.has(k)),
      now: material.now,
      programId: material.programId,
    })
    const set = indexOverrides(overridesByMeeting.get(k) ?? [])
    const decision = applyOverride<AllowEffect>(base, set.allow)
    if (!isVisible(decision)) {
      plan.ruleDenied++
      continue
    }

    // 规则放行、文件在本地、尚无生效授权——够得上被授权的一场
    plan.candidates++

    // 规矩 2：人的决定压过开关。**必须在 toGrant 之前**
    if (material.revokedKeys.has(k)) {
      plan.skippedRevoked++
      continue
    }

    plan.toGrant.push({
      meetingId: key.meetingId,
      subMeetingId: key.subMeetingId,
      reason: decision.reason,
      ruleId: decision.ruleId,
      assetTypes: decision.assetTypes,
    })
  }

  return plan
}

// ── store 入口 ────────────────────────────────────────────────
// 本轮在 `audit_log.actor_id` 里的固定身份（`AUTO_GRANT_ACTOR_ID`）**定义在
// `src/audit/actions.ts`**，与动作登记表放在一起：读侧（控制台审计页）要拿它把这个
// id 显示成「系统 · 自动授权」，而那是网关进程里的代码——不该为了一个字符串常量
// 去 import 一个 worker 模块。这里原样转出一条，写侧与测试引用哪一处都是同一个值。
export { AUTO_GRANT_ACTOR_ID } from '../audit/actions'


/**
 * 审计 `asset_id` 里那个「对谁」的键，与 `handlers/console/grants.ts` 的
 * `auditTarget` **同一个编码**：主场次不写 `@` 后缀，周期性会议写 `程序@场次`。
 *
 * 两处必须一致——会议详情的操作历史把人点的 `grant_meeting` 与系统代点的
 * `auto_grant_meeting` 混在一条时间轴上显示，编码不同的话同一场会议的两条记录
 * 看起来指着两个不同的对象。
 */
function auditTarget(programId: string, subMeetingId: string): string {
  return subMeetingId === '' ? programId : `${programId}@${subMeetingId}`
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 跑一轮自动授权（定时任务五）。
 *
 * ## 查询计划：与会议数无关，也与程序数**基本**无关
 *
 * 每轮固定 5 次：程序列表、候选会议键、allow 规则、会议元数据、归档行、改写
 * （后四条只在真有候选程序与候选会议时才发）。**逐程序**再各 2 次：这个程序当前
 * 的生效授权、它撤销过的会议键——这两条按定义就是按程序问的，没有一次问清的形状。
 * 与 `visibility.ts` 的 `gather` 同一个原则：想知道一轮发了几次查询，数这一段就够。
 *
 * 写侧则是**逐场**两次（一条授权 + 一条审计）。这一半没法批量，也不该批量：
 * `grant` 自己在一个事务里处理「已有生效行」的幂等与撤旧插新，而审计要一场一条。
 * 真正保证它不失控的是候选集合——稳态下每轮的新候选是「上一轮之后新下完的会议」，
 * 个位数。第一次开开关的那一轮会写一大批，那正是管理员按下开关时想要的。
 *
 * ## 一个程序抛错不拖垮整轮
 *
 * 计 `failedPrograms`、把原因记进 `failures`（由调度器那一格落成 `job_failures`
 * 里的一行），继续下一个程序。逐场写授权时抛出同样落在这一层：那个程序这一轮
 * **部分写成**，下一轮会把剩下的接着写完——授权行是幂等的（已经写成的那些会被
 * 「已有生效授权」跳过），没有需要回滚的东西。
 */
export async function runAutoGrantRound(
  deps: AutoGrantDeps,
  now: number,
): Promise<AutoGrantRound> {
  const all = await deps.programs.list()
  // 停用的程序整个跳过：停用 = 先别取，不该在停用期间替它堆授权。
  // 这一条与 `AccessGate` 里 `enabled = 0` 一律拒绝是同一条产品语义的两面
  const programs = all.filter((p) => p.autoGrant && p.enabled)

  const round: AutoGrantRound = {
    programs: [],
    granted: 0,
    skippedRevoked: 0,
    failedPrograms: 0,
    failures: [],
  }
  // 一个程序都没开就不必再问会议：四条白跑的查询，而「一个都没开」是这个开关的常态
  if (programs.length === 0) return round

  const keys = await deps.archives.listMeetingKeysWithLocalFiles()
  if (keys.length === 0) {
    // 候选会议为空时仍然把程序逐行列出来（全 0）：摘要要答得出「这一轮考察了谁」，
    // 空数组会让「没开开关」与「开了但没有会议」在运行记录里长得一模一样
    round.programs = programs.map((p) => ({
      programId: p.id,
      name: p.name,
      candidates: 0,
      granted: 0,
      skippedRevoked: 0,
    }))
    return round
  }

  // 规则 / 元数据 / 归档行 / 改写各取一次，**全部程序共用**：它们都不带程序这一维
  // （改写没有程序维度，见 policy/grant.ts 的文件头）。逐程序各取一次的话，
  // 查询数会跟着程序数翻倍，而那几批数据一模一样
  const [rules, meta, archives, overrides] = await Promise.all([
    deps.policy.listEnabledStackRules('allow'),
    deps.getMeetings(keys),
    deps.archives.listMeetingArchives(keys),
    deps.grants.listActiveOverridesForMeetings([...keys]),
  ])

  for (const program of programs) {
    try {
      const summary = await runForProgram(deps, program, now, {
        keys,
        rules,
        meta,
        archives,
        overrides,
      })
      round.programs.push(summary)
      round.granted += summary.granted
      round.skippedRevoked += summary.skippedRevoked
    } catch (err) {
      // 一个程序算不出来（或写到一半炸了）不该让整轮 failed——另外几个程序写出去的
      // 授权仍然有效，而把整轮标红会让「这一个程序有问题」变成「自动授权坏了」。
      // 但它必须留痕：这一行进失败项表，不是一句日志
      round.failedPrograms++
      round.failures.push({ programId: program.id, name: program.name, reason: errText(err) })
    }
  }

  return round
}

/** 一轮里全部程序共用的那批原料，取一次 */
interface SharedMaterial {
  keys: readonly MeetingKey[]
  rules: readonly StackRule[]
  meta: readonly MeetingMeta[]
  archives: readonly MeetingArchiveRecord[]
  overrides: readonly PolicyOverride[]
}

async function runForProgram(
  deps: AutoGrantDeps,
  program: ServiceProgram,
  now: number,
  shared: SharedMaterial,
): Promise<AutoGrantProgramSummary> {
  const [granted, revoked] = await Promise.all([
    deps.grants.listActiveGrantsForProgram(program.id),
    deps.grants.listRevokedMeetingKeysForProgram(program.id),
  ])

  const plan = planAutoGrants({
    programId: program.id,
    autoGrantAssetTypes: program.autoGrantAssetTypes,
    now,
    meetings: shared.keys,
    rules: shared.rules,
    overrides: shared.overrides,
    meta: shared.meta,
    archives: shared.archives,
    grantedKeys: new Set(granted.map((g) => keyOf(g))),
    revokedKeys: new Set(revoked.map((r) => keyOf(r))),
  })

  let written = 0
  for (const item of plan.toGrant) {
    await deps.grants.grant({
      meetingId: item.meetingId,
      subMeetingId: item.subMeetingId,
      programId: program.id,
      // **开关上那个范围，不是判定算出来的那一份。** 授权行的范围是「授权给了什么」，
      // 判定的范围是「规则准许什么」，两者在网关那边还要再求一次交（policy/grant.ts）。
      // 把判定的结果写死进授权行，等于把这一刻的规则快照冻进授权里：日后规则放宽了，
      // 这些会议还卡在旧范围上，而界面上完全看不出为什么
      assetTypes: program.autoGrantAssetTypes,
      now,
    })
    // 授权行先落、审计再落。反过来的话，写授权那一步抛出时账本上会留下一条
    // 「已经授权了」的假记录——审计是数据出境的唯一账本，宁可漏记也不能记错
    await deps.audit.record({
      occurredAt: now,
      // 这次授权不是任何一个管理员做的。落 'admin' 会让审计页把它归到某个人名下，
      // 而那个人当时可能正在休假——`actor_type = 'system'` + 固定的 actor_id
      // 让「系统代点的」在筛选里就分得开（读侧的名字见 handlers/console/audit.ts）
      actorType: 'system',
      actorId: AUTO_GRANT_ACTOR_ID,
      action: AUDIT_ACTION.autoGrantMeeting,
      meetingId: item.meetingId,
      assetId: auditTarget(program.id, item.subMeetingId),
      // 这次动作的对象是一场会议对一个程序的授权，不是某一份资产
      assetType: null,
      decision: 'allow',
      // 放行的是哪条规则要留住：事后「这场会议凭什么被自动授权」只有这一个凭据
      matchedRuleId: item.ruleId,
      // 不是从控制台来的，也不是网关。留 null 而不是编一个客户端类型
      clientKind: null,
      detail: buildAuditDetail({
        text: `自动授权给采集程序「${program.name}」：${item.reason}`,
      }),
    })
    written++
  }

  return {
    programId: program.id,
    name: program.name,
    candidates: plan.candidates,
    granted: written,
    skippedRevoked: plan.skippedRevoked,
  }
}
