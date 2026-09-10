import { expect, test } from 'bun:test'
import { judgeReadiness } from '../../src/domain/readiness'
import { isSiblingAbsent } from '../../src/domain/sibling'

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

// ---------------------------------------------------------------------------
// 同源产物（domain/sibling.ts）：audio 与 video 由同一次转码一起发布，所以
// 「video 已就绪而 audio 缺席」不是「还没出来」，是「不会出来」。
// ---------------------------------------------------------------------------
const video = (state?: number | null) => ({ assetType: 'video', state })

test('video 就绪而 audio 缺席 → audio 永远不会出现', () => {
  expect(isSiblingAbsent('audio', [video(3)])).toBe(true)
  expect(isSiblingAbsent('audio', [video(null)])).toBe(true)       // 网关不发 state = 列出来的即可取
  expect(isSiblingAbsent('audio', [{ assetType: 'video' }])).toBe(true)
})
test('video 也不在清单 → 两个都还在等，照旧探测', () => {
  expect(isSiblingAbsent('audio', [])).toBe(false)
  expect(isSiblingAbsent('audio', [{ assetType: 'meeting_summary', state: 3 }])).toBe(false)
})
test('video 还在转码（state 1/2）→ audio 可能随它一起来，不判死', () => {
  expect(isSiblingAbsent('audio', [video(1)])).toBe(false)
  expect(isSiblingAbsent('audio', [video(2)])).toBe(false)
})
test('audio 本来就在清单里 → 不适用', () => {
  expect(isSiblingAbsent('audio', [video(3), { assetType: 'audio', state: 3 }])).toBe(false)
})
test('规则只管 audio：智能产物生成时机独立，不受 video 牵连', () => {
  for (const t of ['video', 'chapters', 'ai_minutes', 'meeting_summary']) {
    expect(isSiblingAbsent(t, [video(3)])).toBe(false)
  }
})
