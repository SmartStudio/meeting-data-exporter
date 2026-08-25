import { expect, test } from 'bun:test'
import { resolveArchiveDir, type ArchiveDirMeeting } from '../../src/policy/archive-dir'
import type { ArchiveDecision } from '../../src/policy/stacks'

/**
 * 归档目录模板的求值。**这一层的全部风险在「渲染出来的路径不是管理员想的那个」**
 * ——模板是自由文本，占位符可以拼错、可以带 `..`、可以是绝对路径。所以坏模板的
 * 每一种各钉一条：它们必须一律落到「不归档 + 说得出为什么」，绝不能尽力而为地
 * 拼一个差不多的路径出来（把一场会议的录像写到管理员没想到的地方，比不写更糟）。
 */

const NAS = '/nas'
/** 2026-07-15T14:30:00Z——七月的会议，故意与「八月归档」错开一个月 */
const JULY = Date.UTC(2026, 6, 15, 14, 30) / 1000

/** 一条「命中了某条规则、effect 是这个模板」的判定 */
function hit(effect: string): ArchiveDecision {
  return {
    kind: 'archive',
    effect,
    ruleId: 7,
    note: '财务部',
    source: 'rule',
    reason: `归档规则 #7「财务部」决定：归档到 ${effect}`,
    assetTypes: [],
    issues: [],
    trace: [],
  }
}

/** 兜底：一条规则都没匹配 */
function fallback(): ArchiveDecision {
  return {
    kind: 'archive',
    effect: 'skip',
    ruleId: null,
    note: null,
    source: 'default',
    reason: '没有任何归档规则匹配这场会议，按兜底处理：默认不归档',
    assetTypes: [],
    issues: [],
    trace: [],
  }
}

const MEETING: ArchiveDirMeeting = {
  subject: '季度产品/评审：Q3',
  startTime: JULY,
  meetingCode: '88123456',
}

function run(effect: string, meeting: ArchiveDirMeeting = MEETING, fallbackCode = 'm-1') {
  return resolveArchiveDir(hit(effect), { nasRoot: NAS, meeting, fallbackCode })
}

// ── 四个占位符 ──────────────────────────────────────────────────

test('{年}/{月} 取的是**会议 startTime**，不是归档时刻', () => {
  const r = run('meetings/{年}/{月}')
  expect(r.archive).toBe(true)
  // 七月的会议，无论什么时候归档，都落在 2026/07
  expect(r.archive && r.nasDir).toBe('/nas/meetings/2026/07')
})

test('{会议号} 渲染会议号；会议号缺失时顶上 fallbackCode（与本地归档区同一口径）', () => {
  expect(run('{年}/{会议号}').archive && run('{年}/{会议号}').nasDir).toBe('/nas/2026/88123456')
  const noCode = run('{年}/{会议号}', { ...MEETING, meetingCode: null })
  expect(noCode.archive && noCode.nasDir).toBe('/nas/2026/m-1')
})

test('{标题} 过 cleanSubjectSegment：非法字符被替换', () => {
  const r = run('{标题}')
  expect(r.archive && r.nasDir).toBe('/nas/季度产品-评审-Q3')
})

test('{标题} 过 cleanSubjectSegment：超 60 字素被截断', () => {
  const r = run('{标题}', { ...MEETING, subject: '🎉'.repeat(80) })
  expect(r.archive).toBe(true)
  const seg = r.archive ? r.nasDir.slice('/nas/'.length) : ''
  expect([...seg].length).toBe(60)
  expect(seg.endsWith('�')).toBe(false)
})

test('{标题} 过 cleanSubjectSegment：空主题兜底 untitled', () => {
  const r = run('{标题}', { ...MEETING, subject: null })
  expect(r.archive && r.nasDir).toBe('/nas/untitled')
})

test('四个占位符可以出现在同一段里，模板自带的分隔符原样保留', () => {
  const r = run('meetings/{年}/{月}/{会议号}-{标题}/')
  expect(r.archive && r.nasDir).toBe('/nas/meetings/2026/07/88123456-季度产品-评审-Q3')
})

test('startTime 缺失（null / 0）与 meetingDirPath 一致：落进 1970/01，不另发明一种行为', () => {
  const nullStart = run('{年}/{月}', { ...MEETING, startTime: null })
  expect(nullStart.archive && nullStart.nasDir).toBe('/nas/1970/01')
  const zeroStart = run('{年}/{月}', { ...MEETING, startTime: 0 })
  expect(zeroStart.archive && zeroStart.nasDir).toBe('/nas/1970/01')
})

// ── skip：不归档，而且说得出为什么 ────────────────────────────────

test('effect 是 skip：不归档，理由原样用判定理由', () => {
  const r = resolveArchiveDir(
    { ...hit('skip'), reason: '归档规则 #7「财务部」决定：不归档' },
    { nasRoot: NAS, meeting: MEETING, fallbackCode: 'm-1' },
  )
  expect(r.archive).toBe(false)
  expect(r.reason).toBe('归档规则 #7「财务部」决定：不归档')
})

test('兜底（一条规则都没匹配）：不归档，理由说清是兜底', () => {
  const r = resolveArchiveDir(fallback(), { nasRoot: NAS, meeting: MEETING, fallbackCode: 'm-1' })
  expect(r.archive).toBe(false)
  expect(r.reason).toContain('兜底')
  expect(r.reason).toContain('不归档')
})

// ── 坏模板：一律不归档 + 明确理由（D-s） ──────────────────────────

test('未知占位符：判失败，理由点名是哪一个', () => {
  const r = run('meetings/{年份}/{月}')
  expect(r.archive).toBe(false)
  expect(r.reason).toContain('{年份}')
  // 理由要能自助修复：把合法的占位符列出来
  expect(r.reason).toContain('{年}')
  expect(r.reason).toContain('{标题}')
})

test('路径穿越：判失败', () => {
  const r = run('meetings/../../etc/{年}')
  expect(r.archive).toBe(false)
  expect(r.reason).toContain('..')
})

test('绝对路径：判失败，理由告诉管理员模板是相对 NAS 根目录的', () => {
  const r = run('/etc/meetings/{年}')
  expect(r.archive).toBe(false)
  expect(r.reason).toContain('绝对路径')
  expect(r.reason).toContain('NAS')
})

test('渲染后是空串：判失败', () => {
  const r = run('{会议号}', { ...MEETING, meetingCode: null }, '')
  expect(r.archive).toBe(false)
  expect(r.reason).toContain('空')
})

test('渲染后指向 NAS 根本身（只剩 . 或分隔符）：判失败', () => {
  // `.` / `./` 不是穿越、不是绝对路径、也不是空串，但它把所有会议堆在挂载点上
  const dot = run('.')
  expect(dot.archive).toBe(false)
  expect(dot.reason).toContain('没有任何目录层级')
  expect(run('./').archive).toBe(false)
  // `///` 在 posix 上算绝对路径，落在上一条分支——两条路都判失败，这里钉住这一点
  expect(run('///').archive).toBe(false)
})

test('全空白模板：判失败', () => {
  const r = run('   ')
  expect(r.archive).toBe(false)
})

test('坏模板的理由里带着是哪条规则判的——不然管理员不知道去改哪一条', () => {
  const r = run('meetings/{年份}')
  expect(r.reason).toContain('#7')
  expect(r.reason).toContain('财务部')
})

// ── 归档时 nasDir 一定在 NAS 根之下 ──────────────────────────────

test('渲染结果永远在 nasRoot 之下（末尾斜杠、重复斜杠、. 段都不改变这一点）', () => {
  const r = run('meetings//{年}/./{月}/')
  expect(r.archive && r.nasDir).toBe('/nas/meetings/2026/07')
})
