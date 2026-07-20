import { expect, test } from 'bun:test'
import { createPolicyEngine } from '../../src/policy/engine'
import type { PolicyRule, PolicyStore } from '../../src/store/policy'
import type { ActorIdentity, Meeting } from '../../src/domain/types'

const meeting: Meeting = {
  meetingId: 'm1', subMeetingId: '', meetingRecordId: 'r1', meetingCode: '881',
  subject: 'S', hostUserId: 'tm-alice', startTime: 100, endTime: 200, state: 'completed',
}
const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-a', tmUserId: 'tm-alice' }

function stubStore(rules: PolicyRule[]): PolicyStore {
  return { listEnabledRules: async () => rules }
}

const rule = (o: Partial<PolicyRule>): PolicyRule => ({
  id: 1, priority: 10, subjectType: 'user', subjectValue: 'tm-alice',
  resourceExpr: {}, assetTypes: ['*'], effect: 'allow', ...o,
})

test('无规则时默认拒绝', async () => {
  const e = createPolicyEngine(stubStore([]))
  expect(await e.decide({ actor: alice, meeting, assetType: 'video' }))
    .toEqual({ effect: 'deny', matchedRuleId: null })
})

test('匹配的 allow 规则放行', async () => {
  const e = createPolicyEngine(stubStore([rule({})]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('allow')
})

test('主体不匹配时不适用该规则', async () => {
  const e = createPolicyEngine(stubStore([rule({ subjectValue: 'tm-bob' })]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('deny')
})

test('资产类型不在规则范围内时不适用', async () => {
  const e = createPolicyEngine(stubStore([rule({ assetTypes: ['ai_minutes'] })]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('deny')
})

test('低 priority 值优先', async () => {
  const e = createPolicyEngine(stubStore([
    rule({ id: 2, priority: 20, effect: 'allow' }),
    rule({ id: 1, priority: 10, effect: 'deny' }),
  ]))
  const d = await e.decide({ actor: alice, meeting, assetType: 'video' })
  expect(d).toEqual({ effect: 'deny', matchedRuleId: 1 })
})

test('同优先级下 deny 优先于 allow', async () => {
  const e = createPolicyEngine(stubStore([
    rule({ id: 1, priority: 10, effect: 'allow' }),
    rule({ id: 2, priority: 10, effect: 'deny' }),
  ]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('deny')
})

test('resourceExpr 参与匹配', async () => {
  const e = createPolicyEngine(stubStore([
    rule({ resourceExpr: { host_userid: 'tm-bob' } }),
  ]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('deny')
})

test('服务账号同样受策略约束', async () => {
  const svc: ActorIdentity = { kind: 'service_account', wecomUserId: null, tmUserId: 'tm-svc' }
  const e = createPolicyEngine(stubStore([rule({})]))
  expect((await e.decide({ actor: svc, meeting, assetType: 'video' })).effect).toBe('deny')
})
