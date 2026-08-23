import { describe, expect, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useResource } from '../src/lib/useResource'

describe('useResource', () => {
  test('初始是 loading', () => {
    const fetcher = () => new Promise<string>(() => {}) // 永不 resolve
    const { result } = renderHook(() => useResource(fetcher, []))
    expect(result.current.state).toBe('loading')
  })

  test('成功后变 ready 且带 data', async () => {
    const fetcher = () => Promise.resolve('ok')
    const { result } = renderHook(() => useResource(fetcher, []))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(result.current.state === 'ready' && result.current.data).toBe('ok')
  })

  test('抛错后变 error 且带 error，不是静默空数组', async () => {
    const fetcher = () => Promise.reject(new Error('boom'))
    const { result } = renderHook(() => useResource(fetcher, []))
    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.state === 'error' && result.current.error.message).toBe('boom')
    // 这才是「不是静默空数组」的关键：状态是 error，不是伪装成一个空的 ready。
    expect(result.current.state).not.toBe('ready')
  })

  test('retry 会重新发起，且期间回到 loading', async () => {
    const resolvers: Array<(v: string) => void> = []
    const fetcher = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)))

    const { result } = renderHook(() => useResource(fetcher, []))
    expect(fetcher).toHaveBeenCalledTimes(1)

    await act(async () => resolvers[0]!('first'))
    expect(result.current.state === 'ready' && result.current.data).toBe('first')

    await act(async () => {
      result.current.retry()
    })
    // resolvers[1] 还没被调用——此刻应当已经回到 loading，而不是仍停在上一次的 data。
    expect(result.current.state).toBe('loading')
    expect(fetcher).toHaveBeenCalledTimes(2)

    await act(async () => resolvers[1]!('second'))
    expect(result.current.state === 'ready' && result.current.data).toBe('second')
  })

  test('组件卸载后迟到的响应不会再触发渲染、不报错', async () => {
    // 注：在 React 18+ 里，即便完全不判断，对一个已经 unmount 的组件调用
    // setState 本来就是安全的空操作（React 自己会挡掉，也不再打印警告）——
    // 这条测的是这个已知安全的外部行为契约本身，而不是用来单独证明"卸载"
    // 分支的判断逻辑有没有生效。真正会因为少了这层判断而观测到脏数据的，
    // 是下面「deps 切换」那条——组件全程没卸载，纯靠判断逻辑本身兜底。
    let renderCount = 0
    let resolveFn!: (v: string) => void
    const fetcher = () => new Promise<string>((resolve) => { resolveFn = resolve })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result, unmount } = renderHook(() => {
      renderCount++
      return useResource(fetcher, [])
    })
    expect(result.current.state).toBe('loading')
    const countAtUnmount = renderCount

    unmount()
    await act(async () => {
      resolveFn('late')
      await Promise.resolve()
    })

    expect(renderCount).toBe(countAtUnmount)
    expect(errorSpy).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  test('deps 变化会重新发起请求', async () => {
    const fetcher = vi.fn((id: number) => Promise.resolve(`data-${id}`))
    const { result, rerender } = renderHook(({ id }) => useResource(() => fetcher(id), [id]), {
      initialProps: { id: 1 },
    })
    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(result.current.state === 'ready' && result.current.data).toBe('data-1')

    rerender({ id: 2 })
    await waitFor(() => expect(result.current.state === 'ready' && result.current.data).toBe('data-2'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('deps 切换后，前一次过期的响应不能覆盖新数据（页面切换频繁时闪回旧数据的那个坑）', async () => {
    // 场景：详情抽屉里连续切到下一场会议——上一场的慢请求这时候才姗姗来迟。
    // 组件全程没有卸载，只是 deps（会议 id）变了，所以这条不测「卸载」，
    // 测的是同一个 hook 实例跨 deps 变化时的过期响应处理。
    let resolveStale!: (v: string) => void
    const staleFetcher = () => new Promise<string>((resolve) => { resolveStale = resolve })
    const freshFetcher = () => Promise.resolve('fresh')

    const { result, rerender } = renderHook(
      ({ id }) => useResource(id === 1 ? staleFetcher : freshFetcher, [id]),
      { initialProps: { id: 1 } },
    )
    expect(result.current.state).toBe('loading')

    // 切到 id=2 之前，id=1 的请求还没 resolve
    await act(async () => {
      rerender({ id: 2 })
    })
    expect(result.current.state === 'ready' && result.current.data).toBe('fresh')

    // 现在才让 id=1 那个过期的请求 resolve——不该覆盖 id=2 已经落地的数据
    await act(async () => {
      resolveStale('stale')
    })
    expect(result.current.state === 'ready' && result.current.data).toBe('fresh')
  })
})
