import type { ActorIdentity, AssetType, Meeting } from '../domain/types'
import type { PolicyRule, PolicyStore } from '../store/policy'
import { matchExpr } from './expr'

export interface PolicyInput {
  actor: ActorIdentity
  meeting: Meeting
  assetType: AssetType
}

export interface PolicyDecision {
  effect: 'allow' | 'deny'
  matchedRuleId: number | null
}

export interface PolicyEngine {
  decide(input: PolicyInput): Promise<PolicyDecision>
}

function subjectMatches(rule: PolicyRule, actor: ActorIdentity): boolean {
  // 当前仅支持按 user 匹配；department / role 需组织架构数据，属后续能力
  if (rule.subjectType === 'user') return rule.subjectValue === actor.tmUserId
  return false
}

function assetMatches(rule: PolicyRule, assetType: AssetType): boolean {
  return rule.assetTypes.includes('*') || rule.assetTypes.includes(assetType)
}

/**
 * 默认 deny：无任何匹配规则时拒绝。归档工具面对全公司会议录音，
 * 安全默认值优于可用默认值。
 */
export function createPolicyEngine(store: PolicyStore): PolicyEngine {
  return {
    async decide({ actor, meeting, assetType }) {
      const rules = await store.listEnabledRules()
      const applicable = rules.filter(
        (r) => subjectMatches(r, actor) && assetMatches(r, assetType) && matchExpr(r.resourceExpr, meeting),
      )
      if (applicable.length === 0) return { effect: 'deny', matchedRuleId: null }

      // 按 priority 升序取第一条；同优先级下 deny 优先
      applicable.sort((a, b) =>
        a.priority !== b.priority
          ? a.priority - b.priority
          : a.effect === b.effect ? 0 : a.effect === 'deny' ? -1 : 1,
      )
      const winner = applicable[0]!
      return { effect: winner.effect, matchedRuleId: winner.id }
    },
  }
}
