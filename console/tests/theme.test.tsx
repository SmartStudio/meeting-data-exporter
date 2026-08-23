import { describe, expect, test, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTheme } from '../src/theme/useTheme'

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme')
  localStorage.clear()
})

describe('useTheme', () => {
  test('默认是「跟随系统」——根元素上不打任何标记', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('system')
    // 「跟随系统」必须是**没有属性**，不是 data-theme="system"：
    // tokens.css 的暗色块选择器是 :root:not([data-theme="light"])，
    // 打上任何标记都会改变匹配。
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  test('切到深色写 data-theme="dark"，切回系统清掉属性', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setTheme('dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    act(() => result.current.setTheme('system'))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  test('选择被记住，重新挂载后仍在', () => {
    const { result, unmount } = renderHook(() => useTheme())
    act(() => result.current.setTheme('light'))
    unmount()
    const again = renderHook(() => useTheme())
    expect(again.result.current.theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  test('localStorage 不可用时不崩，退回跟随系统', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    try {
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('system')
    } finally {
      Storage.prototype.getItem = orig
    }
  })
})
