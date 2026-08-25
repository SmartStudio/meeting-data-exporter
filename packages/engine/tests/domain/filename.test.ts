import { expect, test } from 'bun:test'
import { cleanDirName, cleanSubjectSegment } from '../../src/domain/filename'

test('非法字符替换为 -，追加会议号', () => {
  const n = cleanDirName('2026-07-15', '1430', '季度产品/评审：Q3', '88123456')
  expect(n).toBe('2026-07-15_1430_季度产品-评审-Q3_88123456')
})
test('按字素簇截断 60 字符，不切断 emoji', () => {
  const subject = '🎉'.repeat(80)
  const n = cleanDirName('2026-07-15', '1430', subject, '88')
  const mid = n.slice('2026-07-15_1430_'.length, -('_88'.length))
  expect([...mid].length).toBeLessThanOrEqual(60)
  expect(mid.endsWith('�')).toBe(false) // 未切断代理对
})
test('空主题兜底为 untitled', () => {
  expect(cleanDirName('2026-07-15', '1430', '', '88')).toBe('2026-07-15_1430_untitled_88')
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
