import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  installProtoApi,
  resetProtoWorld,
  setProtoSystemState,
  setProtoWorldVariant,
} from '../src/api/mock/install'
import { countConsecutiveFailures, TENCENT_DOWN_STREAK } from '../src/api/admin/health'
import {
  createRule,
  deleteRule,
  listRules,
  previewRules,
  ruleMatches,
  setRuleEnabled,
} from '../src/api/admin/rules'
import { fetchJobs, runJob } from '../src/api/admin/jobs'
import {
  fetchFetchableMeetings,
  fetchStorage,
  previewCleanup,
  runCleanup,
  setCleanupPaused,
  setRetentionDays,
} from '../src/api/admin/storage'
import { listAudit } from '../src/api/admin/audit'
import { fetchChapters, fetchContentIndex, fetchContentSelection } from '../src/api/admin/content'
import { listPrograms, programInventory, setProgramAutoGrant } from '../src/api/admin/grants'

/**
 * 原型模式的假后端 —— 六个新页面那一半（F8）。
 *
 * `tests/mock.test.ts` 测的是会议记录页那四条端点；这个文件测的是 F8 补上的
 * 其余读端点。两件事在这里被同时验着：
 *
 * 1. **形状过得了真实域文件的运行时校验**——每一条都经由 `api/admin/*` 的读函数
 *    进来，少一个字段那边就抛 `ApiShapeError`，不会有"看起来像数据"的 200。
 * 2. **假数据真的撑得起各页的形态分支**。这是 F8 存在的理由：a11y 门槛扫的是
 *    原型模式下的页面，如果假数据只有一份"什么都正常"的样本，门槛就只扫过正常态，
 *    而明暗主题下最容易写错对比度的恰恰是失败 / 停用 / 不可达那几种。
 *    下面每一条分支断言，对应的都是 `scripts/a11y-check.ts` 里的一个场景。
 */

let restore: () => void = () => undefined

beforeEach(() => {
  restore = installProtoApi()
  resetProtoWorld()
})

afterEach(() => {
  restore()
})

/* ══════════════════════════════════════════════════════════════════
   自动规则页
   ══════════════════════════════════════════════════════════════════ */

describe('自动规则', () => {
  test('三栈都有规则，形状过得了 rules.ts 的校验', async () => {
    const rules = await listRules()
    expect(rules.length).toBeGreaterThan(5)
    for (const kind of ['fetch', 'archive', 'allow']) {
      expect(rules.some((r) => r.kind === kind), `${kind} 栈是空的`).toBe(true)
    }
  })

  test('带 kind 只回那一栈', async () => {
    const allow = await listRules('allow')
    expect(allow.length).toBeGreaterThan(0)
    expect(allow.every((r) => r.kind === 'allow')).toBe(true)
  })

  test('形态分支：写坏的 conds / 停用 / 有 issues / 无条件', async () => {
    const rules = await listRules()
    expect(rules.some((r) => r.condsMalformed), '没有一条 conds 写坏的规则').toBe(true)
    expect(rules.some((r) => !r.enabled), '没有一条停用的规则').toBe(true)
    expect(rules.some((r) => r.issues.length > 0), '没有一条带 issues 的规则').toBe(true)
    // 坏掉的条件项占位成 null，不静默少一行
    expect(rules.some((r) => r.conds.includes(null)), '没有一条带坏条件项的规则').toBe(true)
    expect(
      rules.some((r) => !r.condsMalformed && r.conds.length === 0),
      '没有一条无条件规则',
    ).toBe(true)
  })

  test('命中就是这条规则自己的条件匹配：「标题含周会」只命中周会', async () => {
    const rules = await listRules('allow')
    const weekly = rules.find((r) => (r.note ?? '').includes('周会'))
    expect(weekly).toBeDefined()
    const res = await ruleMatches(weekly!.id)
    expect(res.rule.id).toBe(weekly!.id)
    expect(res.matches.length).toBeGreaterThan(0)
    expect(res.matches.every((m) => m.title.includes('周会'))).toBe(true)
    expect(res.scope.meetingsTotal).toBeGreaterThanOrEqual(res.scope.meetings)
  })

  test('用到「所属部门」的规则一场都命中不了 —— 与它的 issues 说的是同一件事', async () => {
    const rules = await listRules()
    const dept = rules.find((r) => r.issues.some((i) => i.includes('部门')))
    expect(dept).toBeDefined()
    const res = await ruleMatches(dept!.id)
    expect(res.matches).toEqual([])
  })

  test('影响预览：三个数与真的命中对得上，被人工改写的进 shielded', async () => {
    const res = await previewRules({
      rule: {
        id: -1,
        kind: 'allow',
        priority: 950,
        join: 'and',
        conds: [{ f: 'title', op: 'has', v: '会' }],
        subjectType: 'program',
        subjectValue: 'kb-indexer',
        assetTypes: ['*'],
        effect: 'allow',
        note: null,
        enabled: true,
      },
      kind: 'allow',
    })
    const stack = res.stacks.find((s) => s.kind === 'allow')
    expect(stack).toBeDefined()
    expect(stack!.counts.hits).toBeGreaterThan(0)
    expect(stack!.counts.scanned).toBeLessThanOrEqual(stack!.counts.total)
    expect(stack!.summary).not.toBe('')
    expect(stack!.changed.length).toBeGreaterThan(0)
    expect(stack!.shielded.length).toBeGreaterThan(0)
    expect(stack!.shielded.every((c) => c.overridden)).toBe(true)
    expect(res.scope.meetingsTotal).toBeGreaterThan(0)
  })

  test('影响预览：放行一条从没对外开放过的会议要出琥珀警告', async () => {
    const res = await previewRules({
      rule: {
        id: -1,
        kind: 'allow',
        priority: 950,
        join: 'and',
        conds: [],
        subjectType: 'program',
        subjectValue: 'kb-indexer',
        assetTypes: ['*'],
        effect: 'allow',
        note: null,
        enabled: true,
      },
      kind: 'allow',
    })
    expect(res.warnings.some((w) => w.code === 'newly_opened')).toBe(true)
    expect(res.warnings.every((w) => w.text !== '')).toBe(true)
  })

  test('影响预览：候选规则自己有问题时进 candidateIssues', async () => {
    const res = await previewRules({
      rule: {
        id: -1,
        kind: 'fetch',
        priority: 950,
        join: 'and',
        conds: [{ f: 'dept', op: 'in', v: ['人事部'] }],
        subjectType: null,
        subjectValue: null,
        assetTypes: ['*'],
        effect: 'all',
        note: null,
        enabled: true,
      },
      kind: 'fetch',
    })
    expect(res.candidateIssues.length).toBeGreaterThan(0)
    expect(res.candidateIssues[0]!.issues.length).toBeGreaterThan(0)
  })

  test('写操作真的改得动：停用、新建、删除', async () => {
    const before = await listRules('allow')
    const target = before.find((r) => r.enabled)!
    const off = await setRuleEnabled(target.id, false)
    expect(off.enabled).toBe(false)
    expect((await listRules('allow')).find((r) => r.id === target.id)!.enabled).toBe(false)

    const created = await createRule({
      kind: 'fetch',
      priority: 10,
      join: 'and',
      conds: [{ f: 'title', op: 'has', v: '演示' }],
      subjectType: null,
      subjectValue: null,
      assetTypes: ['*'],
      effect: 'all',
      note: '演示新建',
    })
    expect(created.id).toBeGreaterThan(0)
    expect((await listRules()).some((r) => r.id === created.id)).toBe(true)

    await deleteRule(created.id)
    expect((await listRules()).some((r) => r.id === created.id)).toBe(false)
  })
})

/* ══════════════════════════════════════════════════════════════════
   定时任务页
   ══════════════════════════════════════════════════════════════════ */

describe('定时任务', () => {
  test('五个内置任务都在，形状过得了 jobs.ts 的校验', async () => {
    const o = await fetchJobs()
    expect(o.jobs.map((j) => j.name).sort()).toEqual(
      ['archive_nas', 'auto_grant', 'cleanup_expired', 'fetch_recordings', 'refresh_inventory'].sort(),
    )
    expect(o.now).toBeGreaterThan(0)
  })

  test('自动授权那一条的四句文案逐字照后端的 JOB_CATALOG，不是原型自己的说法', async () => {
    const o = await fetchJobs()
    const auto = o.jobs.find((j) => j.name === 'auto_grant')
    expect(auto).toBeDefined()
    expect(auto!.label).toBe('自动授权')
    expect(auto!.what).toBe('把规则放行的会议授权给开了自动授权的程序')
    expect(auto!.schedule).toBe('每 5 分钟')
    expect(auto!.impact).toBe('新会议不会自动授权，程序取不到')
    expect(auto!.maxAttempts).toBe(5)
  })

  test('自动授权的运行摘要按契约的形状给：逐程序一行，外加三个合计', async () => {
    const o = await fetchJobs()
    const auto = o.jobs.find((j) => j.name === 'auto_grant')!
    const sum = auto.lastRun?.summary as Record<string, unknown>
    expect(Array.isArray(sum.programs)).toBe(true)
    const first = (sum.programs as Array<Record<string, unknown>>)[0]!
    expect(Object.keys(first)).toEqual(['programId', 'name', 'candidates', 'granted', 'skippedRevoked'])
    expect(typeof sum.granted).toBe('number')
    // 人工撤销过的那一场跳过了：人的决定压过开关，不会被自动补回来
    expect(sum.skippedRevoked).toBeGreaterThan(0)
    expect(typeof sum.failedPrograms).toBe('number')
  })

  test('形态分支：落后的任务 / 从没跑过 / 正在跑 / 失败的那一轮', async () => {
    const o = await fetchJobs()
    expect(o.jobs.some((j) => j.health === 'overdue'), '没有 overdue 的任务').toBe(true)
    const never = o.jobs.find((j) => j.health === 'never_ran')
    expect(never, '没有从没跑过的任务').toBeDefined()
    expect(never!.lastRun).toBeNull()
    expect(never!.recentRuns).toEqual([])
    expect(o.jobs.some((j) => j.health === 'running')).toBe(true)
    expect(
      o.jobs.some((j) => j.recentRuns.some((r) => r.status === 'failed' && r.error !== null)),
    ).toBe(true)
    // 还没跑完的那一轮：耗时是 null，不许拿"到现在为止"凑一个数
    expect(o.jobs.some((j) => j.recentRuns.some((r) => r.durationSec === null))).toBe(true)
  })

  test('失败项：有需要人工介入的一条，总数不受列表上限影响', async () => {
    const o = await fetchJobs()
    expect(o.failures.length).toBeGreaterThan(0)
    expect(o.failures.some((f) => f.escalated)).toBe(true)
    expect(o.failuresTotal).toBeGreaterThanOrEqual(o.failures.length)
    // 失败项指得回世界里真实存在的会议
    expect(o.failures.some((f) => f.meetingId !== null && f.targetLabel !== '')).toBe(true)
  })

  test('腾讯会议不可达：拉取任务最近连着失败，够得上「连续失败」的阈值', async () => {
    setProtoSystemState('tencent-down')
    const o = await fetchJobs()
    const fetchJob = o.jobs.find((j) => j.name === 'fetch_recordings')!
    const streak = countConsecutiveFailures(fetchJob.recentRuns.map((r) => r.status))
    expect(streak).toBeGreaterThanOrEqual(TENCENT_DOWN_STREAK)
  })

  test('正常态下拉取任务没有连续失败 —— 否则顶栏说正常、任务页说失败', async () => {
    const o = await fetchJobs()
    const fetchJob = o.jobs.find((j) => j.name === 'fetch_recordings')!
    expect(countConsecutiveFailures(fetchJob.recentRuns.map((r) => r.status))).toBeLessThan(
      TENCENT_DOWN_STREAK,
    )
  })

  test('手动触发只排队，不执行 —— 队里那一行随后看得见', async () => {
    const res = await runJob('archive_nas')
    expect(res.status).toBe('queued')
    expect(res.message).not.toBe('')
    const o = await fetchJobs()
    const job = o.jobs.find((j) => j.name === 'archive_nas')!
    expect(job.recentRuns[0]!.status).toBe('queued')
    expect(job.recentRuns[0]!.trigger).toBe('manual')
    expect(job.recentRuns[0]!.startedAt).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════════
   归档存储页
   ══════════════════════════════════════════════════════════════════ */

describe('归档存储', () => {
  test('正常态：NAS 连得上，保留天数来自配置', async () => {
    const s = await fetchStorage()
    expect(s.nas.reachable).toBe(true)
    expect(s.nas.error).toBeNull()
    expect(typeof s.nas.root).toBe('string')
    expect(s.nas.totalBytes).not.toBeNull()
    expect(s.nas.failedMeetings).not.toBeNull()
    expect(s.retention.defaultDaysSource).toBe('setting')
    expect(s.retention.defaultDays).toBe(30)
    expect(s.retention.cleanupPaused).toBe(false)
  })

  test('数字对得上会议世界：归档成功的场次、保留期内的场次', async () => {
    const s = await fetchStorage()
    expect(s.nas.archivedMeetings).toBeGreaterThan(0)
    expect(s.retention.liveMeetings).toBeGreaterThan(0)
    expect(s.retention.grantedMeetings).toBeLessThanOrEqual(s.retention.liveMeetings)
    expect(s.nas.failedMeetings).toBeGreaterThan(0) // 世界里 m3 归档失败
  })

  test('NAS 断连仍然是 200：容量探不到就是 null，不是 0', async () => {
    setProtoSystemState('nas-down')
    const s = await fetchStorage()
    expect(s.nas.reachable).toBe(false)
    expect(s.nas.error).not.toBeNull()
    expect(s.nas.totalBytes).toBeNull()
    expect(s.nas.availableBytes).toBeNull()
    expect(s.nas.usedByOthersBytes).toBeNull()
  })

  test('degraded 部署：保留天数配置非法、失败数查不出来、清理被暂停', async () => {
    setProtoWorldVariant('degraded')
    const s = await fetchStorage()
    expect(s.retention.defaultDaysSource).toBe('invalid')
    expect(s.retention.defaultDays).toBeNull()
    expect(s.retention.defaultDaysRaw).not.toBeNull()
    expect(s.retention.defaultDaysRaw).not.toBe('')
    expect(s.retention.cleanupPaused).toBe(true)
    expect(s.nas.failedMeetings).toBeNull()
    expect(s.nas.failedMeetingsNote).not.toBeNull()
  })

  test('写操作：改天数、暂停清理，回的都是库里此刻的真值', async () => {
    const changed = await setRetentionDays(45)
    expect(changed.defaultDays).toBe(45)
    expect(changed.previousDefaultDays).toBe(30)
    expect((await fetchStorage()).retention.defaultDays).toBe(45)

    expect(await setCleanupPaused(true)).toBe(true)
    expect((await fetchStorage()).retention.cleanupPaused).toBe(true)
    expect(await setCleanupPaused(false)).toBe(false)
  })

  test('天数越界回 400 并带上区间，与真后端一致', async () => {
    await expect(setRetentionDays(0)).rejects.toThrow(/invalid_days/)
  })

  test('立即清理：不带 confirm 是预览，带 confirm 才真删', async () => {
    const dry = await previewCleanup()
    expect(dry.dryRun).toBe(true)
    expect(Array.isArray(dry.items)).toBe(true)
    const done = await runCleanup()
    expect(done.dryRun).toBe(false)
    expect(Array.isArray(done.purged)).toBe(true)
  })

  test('导出可采集清单：只留判定为可采集的行', async () => {
    const list = await fetchFetchableMeetings()
    expect(list.rows.length).toBeGreaterThan(0)
    expect(list.truncated).toBe(false)
    expect(list.rows.every((r) => r.allowWhy !== '')).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════
   操作审计页
   ══════════════════════════════════════════════════════════════════ */

const week = (): { from: number; to: number; limit: number; offset: number } => {
  const now = Math.floor(Date.now() / 1000)
  return { from: now - 7 * 86400, to: now + 1, limit: 50, offset: 0 }
}

describe('操作审计', () => {
  test('默认那一屏（近 7 天）真的有记录，形状过得了 audit.ts 的校验', async () => {
    const page = await listAudit(week())
    expect(page.rows.length).toBeGreaterThan(3)
    expect(page.total).toBeGreaterThanOrEqual(page.rows.length)
    expect(page.limit).toBe(50)
    expect(page.window.from).toBeGreaterThan(0)
  })

  test('形态分支：存疑的结果 / 认不出的操作者 / 不针对会议 / 没有明细', async () => {
    const page = await listAudit(week())
    expect(page.rows.some((r) => r.result.kind === 'unknown'), '没有存疑的结果').toBe(true)
    expect(page.rows.some((r) => r.result.kind === 'deny'), '没有被拒绝的记录').toBe(true)
    expect(page.rows.some((r) => r.actor.kind === 'unknown'), '没有认不出的操作者').toBe(true)
    expect(page.rows.some((r) => r.object === null), '没有不针对会议的记录').toBe(true)
    expect(
      page.rows.some((r) => r.object !== null && r.object.title === null),
      '没有标题补不齐的记录',
    ).toBe(true)
    expect(page.rows.some((r) => r.detail === null), '没有缺明细的老记录').toBe(true)
    expect(page.rows.some((r) => r.actionLabel === null), '没有认不出的动作').toBe(true)
    // 那条 `actionLabel: null` 的记录必须同时出现在顶层的汇总里——
    // 否则 `?proto=1` 下「这一页有 N 种动作后端还没登记名字」那句提示不会出现，
    // a11y 门槛的 audit 场景也就扫不到它
    expect(page.unlabeledActions.length, '没有汇总出没登记标签的动作').toBeGreaterThan(0)
    expect(page.unlabeledActions[0]!.count).toBeGreaterThan(0)
    expect(page.unlabeledActions[0]!.hint).toContain('AUDIT_ACTION_LABELS')
  })

  test('时间是秒不是毫秒，且落在窗口里', async () => {
    const q = week()
    const page = await listAudit(q)
    for (const r of page.rows) {
      expect(r.at).toBeGreaterThanOrEqual(q.from)
      expect(r.at).toBeLessThan(q.to)
    }
  })

  test('筛选在服务端：只看被拒绝 / 按操作者色块 / 按动作原值', async () => {
    const all = await listAudit(week())
    const deny = await listAudit({ ...week(), decision: 'deny' })
    expect(deny.rows.every((r) => r.result.decision === 'deny')).toBe(true)
    expect(deny.total).toBeLessThan(all.total)

    const prog = await listAudit({ ...week(), actorKind: ['prog'] })
    expect(prog.rows.length).toBeGreaterThan(0)
    expect(prog.rows.every((r) => r.actor.kind === 'prog')).toBe(true)

    const action = all.rows[0]!.action
    const byAction = await listAudit({ ...week(), action: [action] })
    expect(byAction.rows.every((r) => r.action === action)).toBe(true)
  })

  test('分页真的切页，total 不随分页变', async () => {
    const p1 = await listAudit({ ...week(), limit: 3, offset: 0 })
    const p2 = await listAudit({ ...week(), limit: 3, offset: 3 })
    expect(p1.rows).toHaveLength(3)
    expect(p1.rows[0]!.id).not.toBe(p2.rows[0]!.id)
    expect(p1.total).toBe(p2.total)
  })

  test('行的顺序是时间倒序，不折叠不去重', async () => {
    const page = await listAudit(week())
    const at = page.rows.map((r) => r.at)
    expect([...at].sort((a, b) => b - a)).toEqual(at)
  })
})

/* ══════════════════════════════════════════════════════════════════
   内容预览页
   ══════════════════════════════════════════════════════════════════ */

describe('内容预览', () => {
  test('索引：八类资产的可得性不止一种，selected 恒为 null', async () => {
    const idx = await fetchContentIndex('m1')
    expect(idx.meeting.id).toBe('m1')
    expect(idx.assets.length).toBeGreaterThan(4)
    expect(new Set(idx.assets.map((a) => a.availability)).size).toBeGreaterThan(2)
    expect(idx.assets.some((a) => a.availability === 'parsed')).toBe(true)
    expect(idx.assets.some((a) => a.availability !== 'parsed' && a.reason !== null)).toBe(true)
    expect(idx.selected).toBeNull()
    expect(idx.media.proxied).toBe(false)
    // `media.text` 在保留期内是**空串**（2026-08-31）：「不入库，只给去向」写在录像
    // 那一组的行尾，每个文件自己列着 NAS 路径，左边还有一个正在播的播放器——再写一段
    // 说明是同一件事的第四遍。只有本地清理之后才有一句「去哪儿取」。
    expect(idx.media.text).toBe('')
  })

  test('选中一类正文：有正文的给正文，没解析的如实说没解析', async () => {
    const ok = await fetchContentSelection('m1', { type: 'ai_minutes' })
    expect(ok.selected).not.toBeNull()
    expect(ok.selected!.state).toBe('ok')
    expect(ok.selected!.segments.length).toBeGreaterThan(0)
    expect(ok.selected!.segments[0]!.content).not.toBeNull()

    const bad = await fetchContentSelection('m1', { type: 'ai_topic_minutes' })
    expect(bad.selected!.state).not.toBe('ok')
    expect(bad.selected!.text).not.toBe('')
    expect(bad.selected!.segments.every((s) => s.content === null)).toBe(true)
  })

  test('按格式筛：只回那一种格式的段', async () => {
    const txt = await fetchContentSelection('m1', { type: 'transcript', format: 'txt' })
    expect(txt.selected!.segments.length).toBeGreaterThan(0)
    expect(txt.selected!.segments.every((s) => s.fileType === 'txt')).toBe(true)
  })

  test('章节与转写分段各自成列 —— 两样东西，不是同一份数据的两个名字', async () => {
    const ch = await fetchChapters('m1', { limit: 5000 })
    expect(ch.source).toBe('tencent')
    expect(ch.chapters.length).toBeGreaterThan(0)
    expect(ch.chapters.every((c) => c.id !== '' && c.name !== '')).toBe(true)
    // 章节按起点升序
    expect(ch.chapters.map((c) => c.at)).toEqual([...ch.chapters.map((c) => c.at)].sort((a, b) => a - b))
    expect(ch.text).not.toBe('')
    expect(ch.cues.length).toBeGreaterThan(0)
    expect(ch.cuesFrom).not.toBeNull()
    expect(ch.cues.every((c) => c.text !== '')).toBe(true)
  })

  test('被规则拒绝的会议：管理员看得到，但要挂警示条并留痕', async () => {
    const idx = await fetchContentIndex('m6')
    expect(idx.access.allow).toBe('deny')
    expect(idx.access.restricted).toBe(true)
    expect(idx.access.banner).not.toBeNull()
    expect(idx.access.audit.logged).toBe(true)
    expect(idx.access.audit.action).toBe('view_restricted_content')
  })

  test('认不出时间戳格式的转写：切不出分段，给前几行原文', async () => {
    const ch = await fetchChapters('m6', { limit: 5000 })
    expect(ch.cues).toEqual([])
    expect(ch.cuesFrom).not.toBeNull()
    expect(ch.cuesFrom!.format).toBe('none')
    expect(ch.sample).not.toBeNull()
    expect(ch.sample!.length).toBeGreaterThan(0)
  })

  test('本地文件已清理的会议：去向说得出来', async () => {
    const idx = await fetchContentIndex('m8')
    expect(idx.local.filesGone).toBe(true)
    expect(idx.local.archived).toBe(true)
    expect(idx.local.purgedAt).not.toBeNull()
    expect(idx.local.nasDir).not.toBeNull()
    expect(idx.media.assets.some((a) => a.localGone)).toBe(true)
  })

  test('还没归档的会议：保留窗口还没开始计时', async () => {
    const idx = await fetchContentIndex('m3')
    expect(idx.local.archived).toBe(false)
    expect(idx.local.expiresAt).toBeNull()
    expect(idx.local.nasDir).toBeNull()
  })

  test('不存在的会议回 404，与真后端一致', async () => {
    await expect(fetchContentIndex('nope')).rejects.toThrow(/meeting_not_found/)
  })
})

/* ══════════════════════════════════════════════════════════════════
   采集授权页
   ══════════════════════════════════════════════════════════════════ */

describe('采集清单', () => {
  test('能取走什么：可取的与被挡下的都给得出，形状过得了 grants.ts 的校验', async () => {
    const inv = await programInventory('kb-indexer')
    expect(inv.programId).toBe('kb-indexer')
    expect(inv.fetchableCount).toBe(inv.fetchable.length)
    expect(inv.blockedCount).toBe(inv.blocked.length)
    expect(inv.fetchable.length).toBeGreaterThan(0)
    expect(inv.assetTypes.length).toBeGreaterThan(0)
    expect(inv.expiringSoonDays).toBeGreaterThan(0)
  })

  test('被挡下的每一条都说得出原因与去哪儿修', async () => {
    const inv = await programInventory('dw-sync')
    expect(inv.blocked.length).toBeGreaterThan(0)
    for (const item of inv.blocked) {
      expect(item.blockers.length).toBeGreaterThan(0)
      for (const b of item.blockers) {
        expect(b.code).not.toBe('')
        expect(b.remedy).not.toBe('')
        expect(b.reason).not.toBe('')
      }
    }
    // 这个世界里"已授权但取不到"的那一场，卡在本地文件已被到期清理上
    expect(inv.blocked.some((i) => i.blockers.some((b) => b.code === 'local_purged'))).toBe(true)
  })

  test('清单与会议世界是同一份事实：可取的都真的授权过', async () => {
    const inv = await programInventory('daily-digest')
    expect(inv.fetchable.every((i) => i.decision !== null)).toBe(true)
    expect(inv.fetchable.every((i) => i.expiresAt !== null)).toBe(true)
  })

  test('程序不存在回 404，与「一场都没授权」的空清单分得开', async () => {
    await expect(programInventory('nobody')).rejects.toThrow(/program_not_found/)
  })
})

describe('自动授权开关（PATCH /programs/:id）', () => {
  test('种子里一开一关：两侧的界面在原型模式下都画得出来', async () => {
    const list = await listPrograms()
    expect(list.some((p) => p.autoGrant)).toBe(true)
    expect(list.some((p) => !p.autoGrant)).toBe(true)
    // 开着的那个还限了范围：`null`（不限制）与白名单两种取值各有一份
    expect(list.find((p) => p.autoGrant)?.autoGrantAssetTypes).not.toBeNull()
  })

  test('开一个关着的：回的是写后重读的那一行', async () => {
    const got = await setProgramAutoGrant('daily-digest', {
      autoGrant: true,
      autoGrantAssetTypes: ['ai_minutes', 'transcript'],
    })
    expect(got.autoGrant).toBe(true)
    expect(got.autoGrantAssetTypes).toEqual(['ai_minutes', 'transcript'])
    const list = await listPrograms()
    expect(list.find((p) => p.id === 'daily-digest')?.autoGrant).toBe(true)
  })

  test('不限制就是 null，不是八类全给', async () => {
    const got = await setProgramAutoGrant('daily-digest', { autoGrant: true, autoGrantAssetTypes: null })
    expect(got.autoGrantAssetTypes).toBeNull()
  })

  test('空数组回 400——那是一个什么都不授权的自动授权', async () => {
    await expect(
      setProgramAutoGrant('daily-digest', { autoGrant: true, autoGrantAssetTypes: [] }),
    ).rejects.toThrow(/invalid_auto_grant_asset_types/)
  })

  test('认不出的资产键逐条点名进 issues，不是只说一句"范围不合法"', async () => {
    const res = await fetch('/api/v1/admin/programs/daily-digest', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoGrant: true, autoGrantAssetTypes: ['ai_minutes', 'summary'] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: string[] }
    expect(body.error).toBe('invalid_auto_grant_asset_types')
    expect(body.issues?.join('')).toContain('summary')
  })

  test('两族请求体同时出现是 400 invalid_patch', async () => {
    const res = await fetch('/api/v1/admin/programs/daily-digest', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, autoGrant: true }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_patch')
  })

  test('程序不存在回 404', async () => {
    await expect(
      setProgramAutoGrant('nobody', { autoGrant: true, autoGrantAssetTypes: null }),
    ).rejects.toThrow(/program_not_found/)
  })
})

/* ══════════════════════════════════════════════════════════════════
   没实现的端点
   ══════════════════════════════════════════════════════════════════ */

test('没实现的端点仍然回 501 并说清是原型模式少了一条', async () => {
  const res = await fetch('/api/v1/admin/meetings/m1/download-url', { method: 'POST' })
  expect(res.status).toBe(501)
  const body = (await res.json()) as { error: string; detail: string }
  expect(body.error).toBe('proto_not_implemented')
  expect(body.detail).toContain('api/mock/install.ts')
})
