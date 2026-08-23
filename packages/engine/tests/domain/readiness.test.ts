import { expect, test } from 'bun:test'
import { judgeReadiness } from '../../src/domain/readiness'

const base = { now: 1000, deadlineAt: 9999 }
test('存在且 state=3 → ready', () => {
  expect(judgeReadiness({ ...base, present: true, state: 3, allowDownload: true })).toBe('ready')
})
test('存在但 state=1/2 → wait', () => {
  expect(judgeReadiness({ ...base, present: true, state: 1 })).toBe('wait')
  expect(judgeReadiness({ ...base, present: true, state: 2 })).toBe('wait')
})
test('allow_download=false → skip_disallowed（优先于 state）', () => {
  expect(judgeReadiness({ ...base, present: true, state: 3, allowDownload: false })).toBe('skip_disallowed')
})
test('完全不在清单 → wait（乐观等待）', () => {
  expect(judgeReadiness({ ...base, present: false })).toBe('wait')
})
test('超 deadline 且未就绪 → skip_timeout', () => {
  expect(judgeReadiness({ now: 10000, deadlineAt: 9999, present: false })).toBe('skip_timeout')
  expect(judgeReadiness({ now: 10000, deadlineAt: 9999, present: true, state: 1 })).toBe('skip_timeout')
})
test('网关不发 state（列出来的即可取）→ ready', () => {
  expect(judgeReadiness({ ...base, present: true, allowDownload: true })).toBe('ready')
  expect(judgeReadiness({ ...base, present: true })).toBe('ready')
  expect(judgeReadiness({ ...base, present: true, state: null, allowDownload: true })).toBe('ready')
})
test('缺 state 时 allow_download=false 仍优先 skip', () => {
  expect(judgeReadiness({ ...base, present: true, allowDownload: false })).toBe('skip_disallowed')
})
