import { useCallback, useEffect, useState } from 'react'

export type Resource<T> =
  | { state: 'loading' }
  | { state: 'error'; error: Error }
  | { state: 'ready'; data: T }

/**
 * 三态数据 hook。spec.md §8 要求加载中 / 加载失败 / 空态各有各的出口，
 * 所以这里**不把失败折叠成空数据**——那正是「用一句『暂无数据』把三者糊在一起」。
 *
 * 刻意不引 TanStack Query：F1 阶段数据全是 mock，没有缓存、失效、重试的需求。
 * 等 F6 接真 API 时再评估——那时才知道需不需要。
 *
 * 用的是**每次 effect 各自的局部变量** `cancelled`，不是组件级共享的 `useRef`。
 * 共享 ref 只能防住"组件已经彻底卸载"这一种情况：当 deps 变化导致 effect 重新
 * 执行时，旧 effect 的清理函数会把共享 ref 置为 false，但同一次 passive effect
 * flush 里紧接着执行的新 effect 的 setup 又会把它立刻置回 true（两者之间不会
 * 插入任何异步操作）——等"过期"的那次 fetch 真正 resolve 时，共享 ref 早就是
 * true 了，旧数据照样会把新数据覆盖掉。这正是"页面切换频繁时会闪回旧数据"要防
 * 的场景（例如详情抽屉里连续切换到下一场会议，上一场的慢请求才回来），用共享
 * ref 防不住，只有让每次 effect 拿到自己独立的标记才行。
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
): Resource<T> & { retry: () => void } {
  const [res, setRes] = useState<Resource<T>>({ state: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setRes({ state: 'loading' })
    fetcher()
      .then((data) => {
        if (!cancelled) setRes({ state: 'ready', data })
      })
      .catch((e: unknown) => {
        if (!cancelled) setRes({ state: 'error', error: e instanceof Error ? e : new Error(String(e)) })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const retry = useCallback(() => setNonce((n) => n + 1), [])
  return { ...res, retry }
}
