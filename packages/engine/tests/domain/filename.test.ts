import { expect, test } from 'bun:test'
import { cleanDirName } from '../../src/domain/filename'

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
