/**
 * 网关侧的采集权限判定（阶段 3 · T4）。
 *
 * 这一层做的事只有三件，每件都能悄悄改变判定结果，所以每件都得钉住：
 * ① 谁是主体（`ActorIdentity.programId`，不再是 `tmUserId`）；
 * ② `Meeting` → `MeetingFacts` 的换算（结束时间缺失要识别得出来）；
 * ③ 网关的 `asset_type` 词汇 ↔ 引擎的 `AssetKey` 词汇（`meeting_summary` 与
 *    `transcript` 是同一类资产的两个名字，认错等于放行/拒绝错一整类）。
 */
import { expect, test } from 'bun:test'
import { allowsAsset, createAccessGate, meetingFacts } from '../../src/policy/access'
import type { StackRule } from '../../src/policy/stacks'
import type { PolicyStore } from '../../src/store/policy'
import type { ActorIdentity, Meeting } from '../../src/domain/types'

const NOW = 1_700_007_200

const meeting: Meeting = {
  meetingId: 'm1',
  subMeetingId: '',
  meetingRecordId: 'rec1',
  meetingCode: '881',
  subject: '季度评审',
  hostUserId: 'tm-alice',
  startTime: 1_700_000_000,
  endTime: 1_700_003_600,
  state: 'completed',
}

const program: ActorIdentity = {
  kind: 'service_account',
  wecomUserId: null,
  tmUserId: 'tm-svc',
  programId: 'prog-a',
}
const person: ActorIdentity = {
  kind: 'wecom_user',
  wecomUserId: 'ww-alice',
  tmUserId: 'tm-alice',
  programId: null,
}

const rule = (o: Partial<StackRule>): StackRule => ({
  id: 1,
  kind: 'allow',
  priority: 10,
  enabled: true,
  effect: 'allow',
  assetTypes: ['*'],
  subjectType: 'program',
  subjectValue: 'prog-a',
  note: null,
  conds: [],
  ...o,
})

function stubStore(rules: StackRule[]): Pick<PolicyStore, 'listEnabledStackRules'> {
  return { listEnabledStackRules: async (kind) => rules.filter((r) => r.kind === kind) }
}

const gateOf = (rules: StackRule[]) => createAccessGate({ store: stubStore(rules) })

test('没有任何规则时兜底拒绝', async () => {
  const d = await gateOf([]).decide({ actor: program, meeting, archived: false, now: NOW })
  expect(d.effect).toBe('deny')
  expect(d.ruleId).toBeNull()
  expect(d.source).toBe('default')
})

test('主体是采集程序（service_accounts.id），不是人', async () => {
  const d = await gateOf([rule({})]).decide({ actor: program, meeting, archived: false, now: NOW })
  expect(d.effect).toBe('allow')
  expect(d.ruleId).toBe(1)
})

test('别的采集程序的规则不适用', async () => {
  const d = await gateOf([rule({ subjectValue: 'prog-b' })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(d.effect).toBe('deny')
})

/**
 * 旧库里的规则主体是腾讯会议 userid（`subject_type='user'`）。换语义后它对
 * 任何采集程序都不生效——这是迁移时**不自动转换语义**的直接后果，必须钉住，
 * 否则某天有人「顺手」让 'user' 也匹配上，等于把旧授权悄悄复活。
 */
test('旧的 subject_type=user 规则对采集程序不生效', async () => {
  const d = await gateOf([rule({ subjectType: 'user', subjectValue: 'tm-svc' })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(d.effect).toBe('deny')
  expect(d.trace[0]?.outcome).toBe('subject_mismatch')
})

/**
 * 企微用户不是采集程序。**理由要说出这件事本身**，而不是落进
 * 「没有任何规则匹配」那句兜底话——后者会让管理员以为「再加一条规则就能放行」，
 * 于是去建一条永远不生效的规则。
 */
test('企微用户不是采集程序：显式拒绝，且理由说得出为什么', async () => {
  const d = await gateOf([rule({ subjectValue: 'prog-a' })]).decide({
    actor: person, meeting, archived: false, now: NOW,
  })
  expect(d.effect).toBe('deny')
  expect(d.ruleId).toBeNull()
  expect(d.reason).toContain('采集程序')
  expect(d.reason).not.toContain('没有任何采集权限规则匹配')
})

test('企微用户被拒时不去读规则表（判定与规则集无关）', async () => {
  let reads = 0
  const gate = createAccessGate({
    store: {
      listEnabledStackRules: async () => {
        reads += 1
        return []
      },
    },
  })
  await gate.decide({ actor: person, meeting, archived: false, now: NOW })
  expect(reads).toBe(0)
})

test('conds 参与匹配：主持人不符时不命中', async () => {
  const d = await gateOf([rule({ conds: [{ f: 'host', op: 'is', v: 'tm-bob' }] })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(d.effect).toBe('deny')
})

test('arch 条件读的是调用方给的归档状态，不是猜的', async () => {
  const archRule = rule({ conds: [{ f: 'arch', op: 'isarch' }] })
  const yes = await gateOf([archRule]).decide({ actor: program, meeting, archived: true, now: NOW })
  expect(yes.effect).toBe('allow')
  const no = await gateOf([archRule]).decide({ actor: program, meeting, archived: false, now: NOW })
  expect(no.effect).toBe('deny')
})

// ── Meeting → MeetingFacts ───────────────────────────────────────

test('meetingFacts：标题取 subject，部门当前无数据源', () => {
  const f = meetingFacts(meeting, false)
  expect(f.title).toBe('季度评审')
  expect(f.hostUserId).toBe('tm-alice')
  expect(f.dept).toBeNull()
})

test('meetingFacts：endTime 等于 startTime 时视为没有结束时间数据（不是时长 0 分钟）', async () => {
  const noEnd: Meeting = { ...meeting, endTime: meeting.startTime }
  const f = meetingFacts(noEnd, false)
  expect(f.recordEndTime).toBe(0)

  // dur lt 30 不能把这类会议静默命中——那是 expr.ts 当年拒绝 end_time 的原因
  const d = await gateOf([rule({ conds: [{ f: 'dur', op: 'lt', v: 30 }] })]).decide({
    actor: program, meeting: noEnd, archived: false, now: NOW,
  })
  expect(d.effect).toBe('deny')
})

test('meetingFacts：有真实结束时间时 dur / age 都算得出来', async () => {
  const f = meetingFacts(meeting, false)
  expect(f.recordEndTime).toBe(meeting.endTime)

  const dur = await gateOf([rule({ conds: [{ f: 'dur', op: 'gt', v: 30 }] })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(dur.effect).toBe('allow') // 60 分钟 > 30

  const age = await gateOf([rule({ conds: [{ f: 'age', op: 'within', v: 1 }] })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(age.effect).toBe('allow') // 录制结束 1 小时前
})

// ── 资产类型：网关词汇 ↔ AssetKey ─────────────────────────────

test('allowsAsset 把网关的 asset_type 换算成 AssetKey：meeting_summary 就是 transcript', async () => {
  const d = await gateOf([rule({ assetTypes: ['transcript'] })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(allowsAsset(d, 'meeting_summary').allowed).toBe(true)
  expect(allowsAsset(d, 'video').allowed).toBe(false)
})

test('allowsAsset：ai_meeting_transcripts 对应 ai_transcript', async () => {
  const d = await gateOf([rule({ assetTypes: ['ai_transcript'] })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(allowsAsset(d, 'ai_meeting_transcripts').allowed).toBe(true)
})

test('allowsAsset：["*"] 展开成全部八类', async () => {
  const d = await gateOf([rule({ assetTypes: ['*'] })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  for (const t of [
    'video', 'audio', 'meeting_summary', 'ai_meeting_transcripts',
    'ai_minutes', 'ai_topic_minutes', 'ai_speaker_minutes', 'ai_ds_minutes',
  ] as const) {
    expect(allowsAsset(d, t).allowed).toBe(true)
  }
})

/**
 * 计划 §3.4.1 D-e：asset_types 是**命中规则的载荷**，不是筛选条件。
 * 「命中了 allow 规则但这一类不在它的 asset_types 里」与「一条规则都没命中走兜底」
 * 是两种不同的拒绝，判定理由必须能区分——前者要说出是哪条规则放行了这场会议、
 * 以及它只放行哪几类。
 */
test('D-e：命中 allow 但资产类型不在载荷里，拒绝的理由与兜底 deny 不同', async () => {
  const d = await gateOf([rule({ id: 7, note: '只放行转写', assetTypes: ['transcript'] })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(d.effect).toBe('allow')

  const video = allowsAsset(d, 'video')
  expect(video.allowed).toBe(false)
  expect(video.reason).toContain('#7')
  expect(video.reason).toContain('只放行转写')

  const fallback = await gateOf([]).decide({ actor: program, meeting, archived: false, now: NOW })
  expect(allowsAsset(fallback, 'video').reason).not.toContain('#7')
})

/**
 * D-e 的另一半：筛选式语义会让一条高优先级的「只放行转写」被低优先级的
 * 「放行全部」在视频上顶掉。载荷式语义下，高优先级那条说了算，视频取不到。
 */
test('D-e：高优先级的「只放行转写」不会被低优先级的「放行全部」在视频上顶掉', async () => {
  const d = await gateOf([
    rule({ id: 1, priority: 100, assetTypes: ['transcript'], note: '只放行转写' }),
    rule({ id: 2, priority: 10, assetTypes: ['*'], note: '放行全部' }),
  ]).decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.ruleId).toBe(1)
  expect(allowsAsset(d, 'video').allowed).toBe(false)
  expect(allowsAsset(d, 'meeting_summary').allowed).toBe(true)
})

test('effect 是脏数据时落到拒绝一侧，并说得出是哪条规则写坏了', async () => {
  const d = await gateOf([rule({ id: 9, effect: 'allwo' })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  expect(d.effect).toBe('deny')
  expect(d.source).toBe('rule_invalid')
  expect(d.ruleId).toBe(9)
})
