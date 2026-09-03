import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  FAILURES_SEEN_KEY,
  clearFailuresSeen,
  hasUnseenFailures,
  markFailuresSeen,
  readSeenAt,
  useMarkFailuresSeen,
  useUnseenFailures,
} from '../src/app/failuresSeen'

/**
 * 左栏「定时任务」旁那颗红点的「看过了」记号（`app/failuresSeen.ts`）。
 * 壳层那一侧（红点亮不亮、换栏目重读）在 `shell.test.tsx`；这里只盯记号本身：
 * 按时间比、只往前走、清零就忘、以及左栏能订阅到页面写下的那一笔。
 */

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('hasUnseenFailures() —— 有没有比看过的更新的失败', () => {
  test('没有失败项恒为 false；没记号时有失败就算没看过；有记号只认更新的', () => {
    expect(hasUnseenFailures(null, null)).toBe(false)
    expect(hasUnseenFailures(null, 100)).toBe(false)
    expect(hasUnseenFailures(100, null)).toBe(true)
    expect(hasUnseenFailures(100, 100)).toBe(false)
    expect(hasUnseenFailures(101, 100)).toBe(true)
    expect(hasUnseenFailures(99, 100)).toBe(false)
  })
})

describe('记号的读写', () => {
  test('只往前走：记着 200 之后再记 150 还是 200，记 250 才动', () => {
    markFailuresSeen(200)
    markFailuresSeen(150)
    expect(readSeenAt()).toBe(200)
    expect(localStorage.getItem(FAILURES_SEEN_KEY)).toBe('200')
    markFailuresSeen(250)
    expect(readSeenAt()).toBe(250)
  })

  test('清零就忘掉；存了个坏值当没有', () => {
    markFailuresSeen(200)
    clearFailuresSeen()
    expect(readSeenAt()).toBeNull()
    expect(localStorage.getItem(FAILURES_SEEN_KEY)).toBeNull()
    localStorage.setItem(FAILURES_SEEN_KEY, 'abc')
    expect(readSeenAt()).toBeNull()
  })
})

describe('两个不相邻的组件之间', () => {
  test('左栏订阅：页面一记「看过」，读它的 hook 当场翻成 false；清零又翻回来', () => {
    const { result } = renderHook(() => useUnseenFailures(300))
    expect(result.current).toBe(true)
    act(() => markFailuresSeen(300))
    expect(result.current).toBe(false)
    act(() => clearFailuresSeen())
    expect(result.current).toBe(true)
  })

  test('useMarkFailuresSeen：undefined 不动、数字记下、null 清掉', () => {
    const { rerender } = renderHook((p: { v: number | null | undefined }) => useMarkFailuresSeen(p.v), {
      initialProps: { v: undefined as number | null | undefined },
    })
    expect(readSeenAt()).toBeNull()
    rerender({ v: 400 })
    expect(readSeenAt()).toBe(400)
    rerender({ v: undefined })
    expect(readSeenAt()).toBe(400)
    rerender({ v: null })
    expect(readSeenAt()).toBeNull()
  })

  test('另一个标签页看过了（storage 事件）：这边的红点也灭', () => {
    const { result } = renderHook(() => useUnseenFailures(300))
    expect(result.current).toBe(true)
    act(() => {
      localStorage.setItem(FAILURES_SEEN_KEY, '300')
      window.dispatchEvent(new StorageEvent('storage', { key: FAILURES_SEEN_KEY, newValue: '300' }))
    })
    expect(result.current).toBe(false)
  })
})
