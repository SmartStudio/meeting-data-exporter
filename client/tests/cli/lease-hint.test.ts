import { expect, test, spyOn } from 'bun:test'
import { warnIfLeaseLocked } from '../../src/cli/lease-hint'
import type { AssetStatus } from '@yaowu/mde-engine'

const counts = (over: Partial<Record<AssetStatus, number>>) =>
  ({
    async counts() {
      return { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, dead: 0, ...over }
    },
  })

const ZERO = { completed: 0, failed: 0, skipped: 0 }

async function capture(fn: () => Promise<void>): Promise<string> {
  const spy = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await fn()
    return spy.mock.calls.map((c) => String(c[0])).join('\n')
  } finally {
    spy.mockRestore()
  }
}

/**
 * 这几条钉的是 M3.5 §4.3 实测暴露的那个体验缺陷：Ctrl-C 之后立刻重跑，
 * 十五分钟内什么都不会发生而且没有任何解释。机制是对的，沉默是错的。
 */
test('颗粒无收且有 running 任务时，说清楚是被租约锁着', async () => {
  const out = await capture(() => warnIfLeaseLocked(counts({ running: 3 }), ZERO, 900))
  expect(out).toContain('3 个任务停在 running')
  expect(out).toContain('900 秒')
  expect(out).toContain('约 15 分钟')
  // 必须说明这不是故障，否则提示本身会变成新的误导
  expect(out).toContain('不是故障')
})

test('这一轮真干了活就不提示——并发下别人持着租约是常态', async () => {
  const out = await capture(() =>
    warnIfLeaseLocked(counts({ running: 3 }), { completed: 1, failed: 0, skipped: 0 }, 900))
  expect(out).toBe('')
})

test('failed / skipped 也算干了活', async () => {
  const a = await capture(() =>
    warnIfLeaseLocked(counts({ running: 2 }), { completed: 0, failed: 1, skipped: 0 }, 900))
  const b = await capture(() =>
    warnIfLeaseLocked(counts({ running: 2 }), { completed: 0, failed: 0, skipped: 1 }, 900))
  expect(a).toBe('')
  expect(b).toBe('')
})

test('没有 running 任务时不提示——那是真的没活可干，不是被锁住', async () => {
  const out = await capture(() => warnIfLeaseLocked(counts({ running: 0 }), ZERO, 900))
  expect(out).toBe('')
})

test('租约时长按实际配置报，不是写死的 15 分钟', async () => {
  const out = await capture(() => warnIfLeaseLocked(counts({ running: 1 }), ZERO, 10))
  expect(out).toContain('10 秒')
  expect(out).not.toContain('15 分钟')
})
