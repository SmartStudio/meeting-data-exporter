import { useCallback, useState } from 'react'
import { useResource } from '@/lib/useResource'
import type { Resource } from '@/lib/useResource'
import { fetchStorage } from '@/api/admin/storage'
import type { StorageInfo } from '@/api/admin/storage'

export interface StorageView {
  /** 首屏三态。加载中给骨架、失败给错误框，都不许折成"暂无数据"（spec §8） */
  res: Resource<StorageInfo>
  /** 拿得到的数据：首屏的，或者最近一次重取回来的 */
  data: StorageInfo | null
  /** 正在重取（写操作之后）。界面据此把按钮设成 pending，而不是打回骨架 */
  refreshing: boolean
  /** 写操作之后重新取一遍。**这是"不做乐观更新"的另一半**（计划 G-c） */
  refresh: () => Promise<void>
  /** 首屏失败之后重来一次 */
  retry: () => void
}

/**
 * 归档存储页的取数。
 *
 * 为什么不直接用 `useResource().retry()` 当重取：`retry()` 会先把状态打回
 * `loading`，于是每按一次「暂停到期清理」，整页闪一下骨架屏。这一页的数字
 * 是运维在盯着的东西，闪回骨架比慢 200ms 更糟。
 *
 * 所以重取走一条单独的路径：请求回来之前**继续显示旧数据**，只把发起动作的
 * 那颗按钮设成 pending。这不是乐观更新——界面上的数字自始至终来自后端，
 * 只是"旧的那一份"还是"新的那一份"的区别，前端一个数都没有自己推。
 */
export function useStorage(): StorageView {
  const res = useResource(fetchStorage, [])
  const [fresh, setFresh] = useState<StorageInfo | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      setFresh(await fetchStorage())
    } finally {
      setRefreshing(false)
    }
  }, [])

  const retry = useCallback(() => {
    // 重来一次之前先把上一次重取的结果丢掉，否则首屏失败之后按重试，
    // 界面上可能同时存在"错误框"与一份过期数据。
    setFresh(null)
    res.retry()
  }, [res])

  const data = fresh ?? (res.state === 'ready' ? res.data : null)
  return { res, data, refreshing, refresh, retry }
}
