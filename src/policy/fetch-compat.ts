/**
 * 拉取栈的**兼容兜底**：库里一条启用的拉取规则都没有时，实际发生的是什么
 * （阶段 4 · T12 定的行为，T16 把它挪到这里）。
 *
 * ## 为什么这一小段单独成文件
 *
 * T12 把兼容兜底定义在 `src/worker/fetch-policy.ts` 里，那时它只有两个读者
 * （worker 与控制台的 `why.fetch`），两个都在宿主侧，放哪儿都行。
 * T16 加进来第三个读者：**影响预览**（`src/policy/preview.ts`）。
 *
 * 预览若自己再写一遍「规则集为空 = 全拉」，就会有两份定义——而 T16 修的正是
 * 「预览与真实判定各算各的」造成的事故（见下面那一节）。所以定义必须只有一处。
 * 挂在 `src/policy/` 而不是让 `preview.ts` 反向 import `src/worker/`：
 * `preview.ts` 通篇是纯函数（不查库、不读时钟），而 `worker/fetch-policy.ts`
 * 拖着 `@yaowu/mde-engine` 的 `discover` 与 `src/store/*`。让一个纯函数模块
 * 依赖 worker，是把整条 discovery 链路拽进规则求值的依赖图里。
 *
 * `src/worker/fetch-policy.ts` 原样 re-export 这里的三个名字，所以既有的
 * import 路径一个字都不用改；「兼容兜底是什么」的**文字论证**仍然写在
 * `fetch-policy.ts` 的文件头（那里是这条决定的出处），这里只放定义本身。
 *
 * ## 这条兜底为什么存在（一句话版，完整论证见 `src/worker/fetch-policy.ts` 文件头）
 *
 * 接线之前的行为是「时间窗内全拉」。照 spec §4.6 的字面接上去，规则集为空 = 兜底
 * skip = 一场都不拉，而一个刚部署完、还没来得及配规则的环境就是这个状态——
 * 归档链路会静默停摆。裁定是：**开关就是规则集本身**，库里一条启用的拉取规则都没有
 * 就顶上一条合成的「全拉」，行为与接线前逐字相同。
 *
 * ## 预览为什么必须认得出它（T16）
 *
 * 管理员建**第一条**拉取规则时，「当前规则集」是空的。预览若按 spec 字面把空规则集
 * 算成 skip，就会得出：这条规则「新放行了 N 场」——**而那 N 场现在就在被拉**。
 * 方向偏乐观。更要紧的是反面：**没被这条规则命中的会议会从「在拉」变成「不拉」**，
 * 而按 skip 算的预览一个字都不会提。管理员以为自己在新增一条放行规则，
 * 实际是在给整条拉取链路装闸门。
 */

import type { StackRule } from './stacks'

/**
 * 合成兜底规则的 id。**它不在库里**，取 0 是因为 `policy_rules.id` 是
 * AUTO_INCREMENT，真规则的 id 从 1 起；影响预览给草稿规则发的是负 id
 * （`rules.ts` 的 `DRAFT_RULE_ID`）。0 因此两头都撞不上，
 * 可以当成「这次判定是兼容兜底做的」的判据。
 */
export const FETCH_COMPAT_RULE_ID = 0

/**
 * 规则集为空时顶上的那条合成规则。
 *
 * 界面上**不许**把它显示成「由规则 #0 决定」——那正是计划 E-c 骂过的那件事
 * （把一个缺口伪装成一次判定）。要显示的话用 `FETCH_STACK_UNCONFIGURED_REASON`
 * 或 `FETCH_COMPAT_DECIDER_LABEL`。
 */
export const FETCH_COMPAT_RULE: StackRule = {
  id: FETCH_COMPAT_RULE_ID,
  kind: 'fetch',
  priority: 0,
  enabled: true,
  join: 'and',
  conds: [],
  effect: 'all',
  assetTypes: ['*'],
  subjectType: null,
  subjectValue: null,
  note: '兼容兜底（不是库里的规则）：库里一条启用的拉取规则都没有，沿用接线前的「时间窗内全拉」',
}

/**
 * 拉取栈是不是「还没配」——**这一个谓词是「兼容兜底什么时候生效」的唯一定义**。
 *
 * 吃得下两种入参，因为三个读者手里的规则集形状不同，而结论必须是同一个：
 *
 *  - worker / 控制台传的是「fetch 栈当前**启用**的规则」（`listEnabledStackRules('fetch')`）；
 *  - 影响预览传的是**三栈混在一起、含 disabled** 的整份规则集（`listAllRules()`）。
 *
 * 所以这里自己筛 `kind === 'fetch' && enabled`，不靠调用方筛干净。
 * 对前者是恒等的（筛完还是它自己），对后者才是正确的。
 */
export function fetchStackUnconfigured(rules: readonly StackRule[]): boolean {
  return !rules.some((r) => r.kind === 'fetch' && Boolean(r.enabled))
}

/**
 * 这一刻**真正参与 fetch 判定**的规则集。库里有启用的拉取规则就用库里的，
 * 一条都没有才顶上兼容兜底。
 *
 * **worker、控制台的 `why.fetch`、影响预览三处都调它**，这是三处结论一致的唯一保证。
 * 少一处调用就会出现「界面说这场会被规则拦下了，而 worker 其实拉了它」，
 * 或者 T16 修的那件事——预览把「本来就在拉」报成「新放行」。
 */
export function fetchRulesInEffect(configured: readonly StackRule[]): readonly StackRule[] {
  return fetchStackUnconfigured(configured) ? [...configured, FETCH_COMPAT_RULE] : configured
}

/** 这次判定是不是兼容兜底做出来的。判据见 `FETCH_COMPAT_RULE_ID` 的注释 */
export function decidedByFetchCompat(decision: { kind: string; ruleId: number | null }): boolean {
  return decision.kind === 'fetch' && decision.ruleId === FETCH_COMPAT_RULE_ID
}

/**
 * 兼容兜底在「是谁做的这次判定」那一栏里的说法。
 *
 * 不说「拉取规则 #0」：库里没有 #0，管理员会去规则页找一条不存在的规则。
 */
export const FETCH_COMPAT_DECIDER_LABEL =
  '兼容兜底（库里还没有启用的拉取规则，沿用接线前的「时间窗内全拉」；它不是库里的规则）'

/**
 * 「拉取规则栈还没配」这件事的唯一一句解释。控制台的 `why.fetch` 直接用它，
 * worker 的每轮告警在它前后再加上运维要做的动作。
 *
 * 两处共用一份，是因为这句话要回答的是同一个问题："这场会议为什么被拉了？"
 * ——而答案是"还没有规则可管它"，不是"某条规则放行了它"。
 */
export const FETCH_STACK_UNCONFIGURED_REASON =
  '库里一条启用的拉取规则都没有。这种情况下 worker 沿用接线前的行为：' +
  '按时间窗发现到的录制全部拉取（见 src/worker/fetch-policy.ts 的兼容模式）。' +
  '所以这场会议不是「被某条规则放行的」，而是「还没有规则可管它」。' +
  '⚠️ 建下第一条拉取规则的那一刻兜底就翻面——spec §4.6 的拉取兜底是 skip，' +
  '届时没有被任何一条拉取规则命中的会议将不再被拉取。'
