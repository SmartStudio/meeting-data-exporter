import { expect, test } from 'bun:test'
import { cleanDirName, cleanSubjectSegment, meetingDirPath } from '../../src/domain/filename'

test('目录名 = 日期_时分_会议号，不含主题', () => {
  expect(cleanDirName('2026-07-15', '1430', '88123456')).toBe('2026-07-15_1430_88123456')
})
test('会议号里的非法字符替换为 -', () => {
  expect(cleanDirName('2026-07-15', '1430', 'a/b:c')).toBe('2026-07-15_1430_a-b-c')
})
test('会议号为空时兜底 untitled', () => {
  expect(cleanDirName('2026-07-15', '1430', '')).toBe('2026-07-15_1430_untitled')
})
test('meetingDirPath：UTC 年月 + 日期_时分_会议号，会议号缺失顶 fallbackCode', () => {
  const m = { subject: '季度产品/评审：Q3', startTime: Date.UTC(2026, 6, 15, 14, 30) / 1000, meetingCode: null }
  expect(meetingDirPath(m, 'mid-1')).toBe('2026/07/2026-07-15_1430_mid-1')
  expect(meetingDirPath({ ...m, meetingCode: '881-123-40' }, 'mid-1')).toBe('2026/07/2026-07-15_1430_881-123-40')
})

// ── cleanSubjectSegment：从 cleanDirName 里提出来的那段清洗 ─────────────────
//
// 提取的动机是**归档目录模板的 `{标题}` 必须过同一套清洗**（控制台阶段 3 · T9）：
// NAS 上的目录名与本地归档区的目录名一旦用两份清洗逻辑，迟早分叉，分叉的后果是
// 同一场会议在两处叫不同的名字。上面三条 cleanDirName 的用例**一字未改**，
// 就是「提取没有改变对外行为」的证据；下面三条钉的是提出来的那个函数本身。

test('cleanSubjectSegment：非法字符替换为 -，连续空白折叠成一个空格', () => {
  expect(cleanSubjectSegment('季度产品/评审：Q3')).toBe('季度产品-评审-Q3')
  expect(cleanSubjectSegment('  a   b  ')).toBe('a b')
})
test('cleanSubjectSegment：按字素簇截断 60，不切断代理对', () => {
  const s = cleanSubjectSegment('🎉'.repeat(80))
  expect([...s].length).toBe(60)
  expect(s.endsWith('�')).toBe(false)
})
test('cleanSubjectSegment：空主题（含全空白）兜底为 untitled', () => {
  expect(cleanSubjectSegment('')).toBe('untitled')
  expect(cleanSubjectSegment('   ')).toBe('untitled')
  // 全是非法字符不是「空」：它们被替换成 -，结果是一个能用的目录名，不该兜底
  expect(cleanSubjectSegment('///')).toBe('---')
})

// ── dirOrdinal：同一分钟的第二条录制记录 ────────────────────────────────────
//
// 序号由 assignDirOrdinals 算（domain/dir-ordinal.ts），这里只钉「拿到序号之后
// 目录名长什么样」。上面那条 meetingDirPath 用例一字未改，就是「省略参数时行为
// 逐字不变」的证据——存量目录不会因为这次改动改名。

test('meetingDirPath：dirOrdinal>1 时最后一段追加 _<n>，年月两段不动', () => {
  const m = { subject: null, startTime: Date.UTC(2026, 6, 15, 14, 30) / 1000, meetingCode: '881-123-40' }
  expect(meetingDirPath(m, 'mid-1', 2)).toBe('2026/07/2026-07-15_1430_881-123-40_2')
  expect(meetingDirPath(m, 'mid-1', 3)).toBe('2026/07/2026-07-15_1430_881-123-40_3')
})
test('meetingDirPath：dirOrdinal=1 与省略参数逐字相同', () => {
  const m = { subject: null, startTime: Date.UTC(2026, 6, 15, 14, 30) / 1000, meetingCode: null }
  expect(meetingDirPath(m, 'mid-1', 1)).toBe(meetingDirPath(m, 'mid-1'))
  expect(meetingDirPath(m, 'mid-1', 1)).toBe('2026/07/2026-07-15_1430_mid-1')
})
