/**
 * 网关侧的采集权限判定（阶段 3 · T4）。
 *
 * 这一层做的事只有三件，每件都能悄悄改变判定结果，所以每件都得钉住：
 * ① 谁是主体（`ActorIdentity.programId`，不再是 `tmUserId`）；
 * ② `Meeting` → `MeetingFacts` 的换算（结束时间缺失要识别得出来）；
 * ③ 网关的 `asset_type` 词汇 ↔ 引擎的 `AssetKey` 词汇（`meeting_summary` 与
 *    `transcript` 是同一类资产的两个名字，认错等于放行/拒绝错一整类）。
 *
 * 阶段 6 之后它还判 spec §1.3 三个「与」里的**第一个**（逐会议授权），
 * 见文件末尾那一族用例——此前网关只判第三个，一条 allow 规则就足以让任何
 * 没被授权过的程序把数据取走。
 */
import { expect, test } from 'bun:test'
import {
  allowsAsset,
  createAccessGate,
  isVisible,
  meetingFacts,
  type AccessGateDeps,
} from '../../src/policy/access'
import type { GrantLike } from '../../src/policy/grant'
import type { MeetingOverride } from '../../src/policy/override'
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

/** 没有人工改写的假 store。有改写的用例各自造自己的 */
function stubOverrides(overrides: MeetingOverride[] = []): AccessGateDeps['overrides'] {
  return {
    async findActiveOverride(meetingId, subMeetingId, kind) {
      return overrides.find(
        (o) => o.meetingId === meetingId && o.subMeetingId === subMeetingId && o.kind === kind,
      ) ?? null
    },
    async listActiveOverridesForMeetings(keys) {
      return overrides.filter((o) =>
        keys.some((k) => k.meetingId === o.meetingId && k.subMeetingId === o.subMeetingId),
      )
    },
  }
}

/** 一条「不限制资产范围」的授权行。三个「与」里的第一个，默认就是它 */
const grantOf = (o: Partial<GrantLike> = {}): GrantLike => ({
  meetingId: 'm1',
  subMeetingId: '',
  assetTypes: null,
  ...o,
})

/** 逐会议授权的假 store（阶段 6）。`programId` 参与筛选：授权是按程序记的 */
function stubGrants(grants: readonly (GrantLike & { programId?: string })[]): AccessGateDeps['grants'] {
  const forProgram = (programId: string): GrantLike[] =>
    grants.filter((g) => (g.programId ?? 'prog-a') === programId)
  return {
    async findActiveGrant(meetingId, subMeetingId, programId) {
      return forProgram(programId).find(
        (g) => g.meetingId === meetingId && g.subMeetingId === subMeetingId,
      ) ?? null
    },
    async listActiveGrantsForProgram(programId) {
      return forProgram(programId)
    },
  }
}

/**
 * 采集程序启用状态的假件（阶段 5 · A8）。**默认全部启用**：本文件绝大多数用例
 * 问的是规则怎么判，程序当然是开着的。停用那一族用例显式传 `disabled`。
 */
function stubPrograms(disabled: readonly string[] = []): AccessGateDeps['programs'] {
  return { isProgramEnabled: async (id) => !disabled.includes(id) }
}

/**
 * 造一个网关判定。
 *
 * **`grants` 的默认值是「这两场测试会议对 prog-a 各有一条不限制范围的授权」，
 * 不是空。** 阶段 6 之前判定压根不查授权行，本文件既有的十几条用例因此全都在
 * 「没有任何授权」的前提下断言 allow；把默认改成空，它们会集体变红成
 * `not_granted`——而那些用例问的是**规则**怎么判，不是授权怎么判，逐条给它们补一条
 * 授权行只是把同一句噪音抄十几遍。
 *
 * 选「默认有授权」而不是「默认不限制」还有第二个理由：授权这一层必须能被**关掉**
 * 才测得出来。默认放一条真实的授权行，下面那一族用例显式传 `[]` 就是「没有授权」，
 * 两种形态用的是同一条代码路径。
 *
 * `m2` 也在默认里：`decideMany` 那几条用例造的第二场会议就是它。
 */
const gateOf = (
  rules: StackRule[],
  overrides: MeetingOverride[] = [],
  disabled: string[] = [],
  grants: readonly (GrantLike & { programId?: string })[] = [
    grantOf(),
    grantOf({ meetingId: 'm2' }),
  ],
) =>
  createAccessGate({
    store: stubStore(rules),
    overrides: stubOverrides(overrides),
    grants: stubGrants(grants),
    programs: stubPrograms(disabled),
  })

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
    overrides: stubOverrides(),
    grants: stubGrants([grantOf()]),
    programs: stubPrograms(),
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

test('allowsAsset：["*"] 展开成全部六类', async () => {
  const d = await gateOf([rule({ assetTypes: ['*'] })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })
  for (const t of [
    'video', 'audio', 'meeting_summary', 'ai_meeting_transcripts',
    'ai_minutes', 'chapters',
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

// ── 人工改写要到达真正的安全边界（spec §5.4 × §1.4）─────────────────────────
//
// 这一组的存在理由：T4 落地时 T7 的覆盖层还不存在，网关的 allow 判定曾经**完全
// 绕过改写**——管理员在界面上按下的「这场不许取」拦不住 downloadUrl。
// 「改写优先于所有规则」如果只在采集清单那一层成立，它就不是一条安全规则，
// 只是一个展示效果。

const overrideOf = (o: Partial<MeetingOverride> = {}): MeetingOverride => ({
  meetingId: 'm1',
  subMeetingId: '',
  kind: 'allow',
  effect: 'deny',
  assetTypes: null,
  reason: '法务要求这场不外发',
  createdAt: NOW - 100,
  ...o,
})

test('改写：deny 改写压过放行的规则', async () => {
  const gate = gateOf([rule({})], [overrideOf()])
  const d = await gate.decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('deny')
  expect(d.source).toBe('override')
  // 规则本来会放行——详情抽屉要能说出这件事，否则管理员看不到是人工关掉的
  expect(d.overriddenFrom?.effect).toBe('allow')
  expect(d.note).toBe('法务要求这场不外发')
})

test('改写：allow 改写压过兜底 deny，但没指定范围时一类都取不到', async () => {
  const gate = gateOf([], [overrideOf({ effect: 'allow' })])
  const d = await gate.decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('allow')
  // D-r：assetTypes 为 null 沿用被改写掉的那个判定的范围，而兜底 deny 是空数组。
  // 于是「放行了但一类都取不到」——故意的安全侧，必须带 issue 说清楚
  expect(d.assetTypes).toEqual([])
  expect(d.issues.length).toBeGreaterThan(0)
  // 也因此不该被列出来：没有任何可取内容却泄露标题与主持人
  expect(isVisible(d)).toBe(false)
})

test('改写：只对该场会议生效，别的会议照规则判', async () => {
  const gate = gateOf([rule({})], [overrideOf({ meetingId: 'm-other' })])
  const d = await gate.decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('allow')
  expect(d.source).toBe('rule')
  expect(d.overriddenFrom).toBeNull()
})

test('改写：decideMany 与逐场 decide 给出同一个答案', async () => {
  const other: Meeting = { ...meeting, meetingId: 'm2' }
  const gate = gateOf([rule({})], [overrideOf()])

  const batch = await gate.decideMany([
    { actor: program, meeting, archived: false, now: NOW },
    { actor: program, meeting: other, archived: false, now: NOW },
  ])
  const one = await gate.decide({ actor: program, meeting, archived: false, now: NOW })
  const two = await gate.decide({ actor: program, meeting: other, archived: false, now: NOW })

  expect(batch[0]!.effect).toBe(one.effect)
  expect(batch[0]!.source).toBe(one.source)
  expect(batch[1]!.effect).toBe(two.effect)
  // 被改写的那场是 deny，另一场按规则 allow——批量路径没有把改写套错会议
  expect(batch[0]!.effect).toBe('deny')
  expect(batch[1]!.effect).toBe('allow')
})

test('改写：企微用户仍然被拒，改写不改变「谁算采集程序」', async () => {
  // 给他挂一条 allow 改写。改写改的是「规则对这场会议会怎么判」，
  // 不是「谁有资格参与判定」——后者是另一条出境路径（spec §1.4）
  const gate = gateOf([rule({})], [overrideOf({ effect: 'allow' })])
  const d = await gate.decide({ actor: person, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('deny')
  expect(d.source).not.toBe('override')
  expect(d.overriddenFrom).toBeNull()
})

test('改写：kind 不是 allow 的改写不影响采集权限判定', async () => {
  // 一条 archive 改写（effect 是目录模板）绝不能被 allow 栈当成放行
  const gate = gateOf([], [overrideOf({ kind: 'archive', effect: 'meetings/{年}/' })])
  const d = await gate.decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('deny')
})

// ── 采集程序被停用（阶段 5 · A8，spec §11 缺口 4）────────────────────────
//
// 停用之后**已经签发、还没过期的访问令牌**走的就是这条路。只在
// auth/service.ts（拿凭据换令牌）挡住，等于「停用」这个按钮在最长一个令牌
// 生命周期内什么都没做——管理员看到卡片灰了，数据还在往外走。

test('停用的程序：一条放行规则也救不回来', async () => {
  const gate = gateOf([rule({})], [], ['prog-a'])
  const d = await gate.decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('deny')
  expect(d.ruleId).toBeNull()
})

test('停用的程序：理由要说出「已停用」，不能含糊成「没有规则匹配」', async () => {
  // 说错了的代价是管理员去**再建一条规则**，而那条规则永远不会生效——
  // 与企微用户那条短路同一个道理，判定理由是产品功能（spec §4.2/§4.3）
  const d = await gateOf([rule({})], [], ['prog-a']).decide({
    actor: program, meeting, archived: false, now: NOW,
  })

  expect(d.reason).toContain('停用')
  expect(d.reason).not.toContain('没有任何采集权限规则匹配')
  // 顺带把「授权还在」这件事说清楚：停用是可逆的，不连带删授权
  expect(d.reason).toContain('授权')
})

test('停用的程序：一条 allow 人工改写也翻不过来（停用压过改写）', async () => {
  // 改写是「规则对这场会议会怎么判」的覆盖，不是「这个程序还算不算数」。
  // 顺序写反的表现是：管理员停用了一个程序，而它靠一条旧改写继续取数据
  const gate = gateOf([], [overrideOf({ effect: 'allow' })], ['prog-a'])
  const d = await gate.decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('deny')
  expect(d.source).not.toBe('override')
  expect(d.overriddenFrom).toBeNull()
})

test('停用的程序：不去读规则表（判定与规则集无关）', async () => {
  let reads = 0
  const gate = createAccessGate({
    overrides: stubOverrides(),
    grants: stubGrants([grantOf()]),
    programs: stubPrograms(['prog-a']),
    store: {
      listEnabledStackRules: async () => {
        reads += 1
        return []
      },
    },
  })
  await gate.decide({ actor: program, meeting, archived: false, now: NOW })
  expect(reads).toBe(0)
})

test('查不到这个程序（已被删）与停用同等对待——都落在拒绝一侧', async () => {
  const gate = createAccessGate({
    store: stubStore([rule({})]),
    overrides: stubOverrides(),
    grants: stubGrants([grantOf()]),
    // 装配处（src/index.ts）就是这么实现的：find 返回 null → false
    programs: { isProgramEnabled: async () => false },
  })
  const d = await gate.decide({ actor: program, meeting, archived: false, now: NOW })
  expect(d.effect).toBe('deny')
})

test('decideMany 与 decide 对停用程序判得一模一样', async () => {
  // 两条路径分叉的表现是：列表里这场会议显示得出来，点进去详情说取不到
  const gate = gateOf([rule({})], [], ['prog-a'])
  const [batch] = await gate.decideMany([{ actor: program, meeting, archived: false, now: NOW }])
  const one = await gate.decide({ actor: program, meeting, archived: false, now: NOW })

  expect(batch!.effect).toBe(one.effect)
  expect(batch!.reason).toBe(one.reason)
  expect(batch!.effect).toBe('deny')
})

test('decideMany 只为每个 programId 问一次启用状态（一页两百场不是两百次往返）', async () => {
  let calls = 0
  const gate = createAccessGate({
    store: stubStore([rule({})]),
    overrides: stubOverrides(),
    grants: stubGrants([grantOf()]),
    programs: {
      isProgramEnabled: async () => {
        calls += 1
        return true
      },
    },
  })
  const inputs = Array.from({ length: 5 }, () => ({
    actor: program, meeting, archived: false, now: NOW,
  }))
  await gate.decideMany(inputs)
  expect(calls).toBe(1)
})

test('启用着的程序照旧走规则栈（这道判断不改变正常路径的结果）', async () => {
  const d = await gateOf([rule({})]).decide({ actor: program, meeting, archived: false, now: NOW })
  expect(d.effect).toBe('allow')
  expect(d.ruleId).toBe(1)
})

// ── 三个「与」的第一个：逐会议授权（阶段 6，2026-09-03）──────────────────
//
// 这一族的存在理由与上面「人工改写要到达真正的安全边界」那一族逐字同源：
// spec §1.3 的三个「与」此前只有第三个（规则）在网关生效，第一个（授权行）只活在
// 控制台的采集清单里。于是**只要库里有一条 allow 规则**，任何启用中的采集程序
// 不需要任何授权就能列出会议、拿到下载地址，而采集授权页照样显示「0 场对它开放」。
// 「有授权」如果只在清单那一层成立，它就不是一条安全规则，只是一个展示效果。

/** 没有任何授权行的网关。传空数组而不是省略，说的是「这个程序一场都没被授权」 */
const gateWithoutGrants = (rules: StackRule[], overrides: MeetingOverride[] = []) =>
  gateOf(rules, overrides, [], [])

test('授权：规则放行但这场会议没授权给它 → 拒绝，且说得出是授权没给', async () => {
  const d = await gateWithoutGrants([rule({ id: 7, note: '放行本部门' })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })

  expect(d.effect).toBe('deny')
  expect(d.source).toBe('not_granted')
  // matched_rule 记的仍是放行的那条规则：审计里配上这句理由，事后看得出
  // 「规则放行了、是授权没给」——这两句话去的是两个不同的页面
  expect(d.ruleId).toBe(7)
  expect(d.note).toBe('放行本部门')
  expect(d.reason).toContain('没有授权给采集程序')
  expect(d.reason).toContain('prog-a')
  // 规则那半句也要留着，否则管理员补完授权才发现规则那边本来放行的只有一类
  expect(d.reason).toContain('准许采集')
  expect(d.assetTypes).toEqual([])
  expect(isVisible(d)).toBe(false)
})

test('授权：assetTypes 为 null 的授权行「不额外限制」，判定与没有这一层时完全相同', async () => {
  const d = await gateOf([rule({})]).decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('allow')
  expect(d.source).toBe('rule')
  expect(d.ruleId).toBe(1)
  expect(d.assetTypes).toHaveLength(6) // ['*'] 展开后的全部六类，一类都没被收窄
  // 连理由都不加一句：每条判定后面都挂着「授权没有额外限制」，真正有限制的那几条反而淹了
  expect(d.reason).not.toContain('授权行')
})

test('授权：白名单收窄规则放行的范围，且把收窄这件事写进理由', async () => {
  const d = await gateOf(
    [rule({ assetTypes: ['*'] })], [], [],
    [grantOf({ assetTypes: ['transcript'] })],
  ).decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('allow')
  expect(d.assetTypes).toEqual(['transcript'])
  expect(d.reason).toContain('授权行只授权了')
  expect(d.reason).toContain('transcript')
  expect(allowsAsset(d, 'meeting_summary').allowed).toBe(true)
  expect(allowsAsset(d, 'video').allowed).toBe(false)
})

test('授权：空数组是「什么都不授权」，绝不等于「不限制」', async () => {
  const d = await gateOf(
    [rule({ assetTypes: ['*'] })], [], [],
    [grantOf({ assetTypes: [] })],
  ).decide({ actor: program, meeting, archived: false, now: NOW })

  // effect 仍是 allow：规则确实放行了，是授权一类都没给——与「没有授权」是两句不同的话，
  // 由 isVisible / allowsAsset 判成实际取不到（与 visibility.ts 的 grant_scope_empty 同源）
  expect(d.effect).toBe('allow')
  expect(d.assetTypes).toEqual([])
  expect(isVisible(d)).toBe(false)
  const video = allowsAsset(d, 'video')
  expect(video.allowed).toBe(false)
  expect(video.reason).toContain('授权行只授权了')
  expect(video.reason).toContain('一类都没有')
})

test('授权：规则本来就拒绝时不提授权，理由仍是规则那一句', async () => {
  // 说反了的代价：管理员跑一趟采集授权页把会议授权出去，回来发现规则那边照样拦着
  const d = await gateOf([rule({ effect: 'deny' })]).decide({
    actor: program, meeting, archived: false, now: NOW,
  })

  expect(d.effect).toBe('deny')
  expect(d.source).toBe('rule')
  expect(d.reason).toContain('禁止采集')
  expect(d.reason).not.toContain('授权')
})

test('授权：一条 allow 人工改写不替代授权（改写没有程序这一维）', async () => {
  // `meeting_overrides` 没有 program_id，一条 allow 改写在网关等于对**所有**启用中的
  // 程序放行。授权行就是那个按程序过滤的环节——顺序写反的表现是：管理员给一场会议
  // 加了 allow 改写，从没被授权过的程序也把它取走了
  const d = await gateWithoutGrants(
    [], [overrideOf({ effect: 'allow', assetTypes: ['transcript'] })],
  ).decide({ actor: program, meeting, archived: false, now: NOW })

  expect(d.effect).toBe('deny')
  expect(d.source).toBe('not_granted')
  expect(d.reason).toContain('没有授权给采集程序')
  // 改写本身没被吞掉：overriddenFrom 还在，详情抽屉说得出「改写确实生效了，卡在授权上」
  expect(d.overriddenFrom?.effect).toBe('deny')
})

test('授权：程序停用压过授权行（判定顺序不因为多了这一层而乱）', async () => {
  const d = await gateOf([rule({})], [], ['prog-a']).decide({
    actor: program, meeting, archived: false, now: NOW,
  })

  expect(d.effect).toBe('deny')
  expect(d.source).toBe('default')
  expect(d.reason).toContain('停用')
  expect(d.reason).not.toContain('没有授权给采集程序')
})

test('授权：decideMany 与逐场 decide 逐字相同，且每个程序只问一次授权行', async () => {
  const other: Meeting = { ...meeting, meetingId: 'm2' }
  // 只授权了 m1，且只授权 transcript；m2 一条授权都没有
  const rows = [grantOf({ assetTypes: ['transcript'] })]
  let listCalls = 0
  let findCalls = 0
  const gate = createAccessGate({
    store: stubStore([rule({ assetTypes: ['*'] })]),
    overrides: stubOverrides(),
    programs: stubPrograms(),
    grants: {
      findActiveGrant: async (meetingId, subMeetingId, programId) => {
        findCalls += 1
        if (programId !== 'prog-a') return null
        return rows.find((g) => g.meetingId === meetingId && g.subMeetingId === subMeetingId) ?? null
      },
      listActiveGrantsForProgram: async (programId) => {
        listCalls += 1
        return programId === 'prog-a' ? rows : []
      },
    },
  })

  const batch = await gate.decideMany([
    { actor: program, meeting, archived: false, now: NOW },
    { actor: program, meeting: other, archived: false, now: NOW },
  ])
  // 一页两百场不是两百次往返——与启用状态那个缓存同一个做法
  expect(listCalls).toBe(1)
  expect(findCalls).toBe(0) // 批量路径一次逐场查询都不发

  const one = await gate.decide({ actor: program, meeting, archived: false, now: NOW })
  const two = await gate.decide({ actor: program, meeting: other, archived: false, now: NOW })
  // 两条路径分叉的表现是：列表里这场会议显示得出来，点进去详情说取不到。
  // 逐字比而不是只比 effect：理由也是产品功能（spec §4.2/§4.3）
  expect(batch[0]).toEqual(one)
  expect(batch[1]).toEqual(two)
  // m1 有授权（收窄到 transcript），m2 没有授权（not_granted）——批量路径没有把
  // 一条授权套错会议，也没有把「有授权」当成整个程序的属性
  expect(batch[0]!.assetTypes).toEqual(['transcript'])
  expect(batch[1]!.source).toBe('not_granted')
})
