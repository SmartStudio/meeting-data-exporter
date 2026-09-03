/**
 * 左栏「定时任务」旁那颗红点的「看过了」记号。
 *
 * 红点说的不是「有失败项」——底部状态摘要已经在说「N 项需要处理」——而是
 * **「有你还没看过的失败」**。打开定时任务页、失败列表读完，就算看过：记住这一刻
 * 最新一条失败的时间（`api/admin/jobs.ts` 的 `newestFailedAt()`），红点灭。之后再
 * 出现比它更新的失败，红点再亮。一条旧失败自动重试又失败，`lastFailedAt` 会更新，
 * 也算新的——它确实又失败了一次；到上限之后不再重试，也就不再亮。
 *
 * ## 为什么按时间，不按条数，也不「关过就不再显示」
 *
 * 同 `pages/Jobs/dismiss.ts` 文件头那段：条数会先降后升回同一个数，看起来像什么都
 * 没发生；「关过就永远不显示」等于把一个还会再来的提醒一次性禁用。时间只往前走，
 * 「比你看过的更新」就是「新的」。失败清零时把记号删掉：下一段从头提醒。
 *
 * ## 为什么是一个模块级的小仓，不是组件 state
 *
 * 写记号的是定时任务页，读记号的是左栏——两个不相邻的组件。`useSyncExternalStore`
 * 让左栏订阅这一个值：页面一读完，红点当场灭，不用等下一次刷新。同时监听
 * `storage` 事件：另一个标签页看过了，这边也灭。
 *
 * 存储用 localStorage，读写都包 try/catch（同 `theme/useTheme.ts`）：私密窗口、
 * 禁用站点数据时会抛。存不下就退到内存里，只在本次会话里有效。
 *
 * 本文件**不许 import 任何 `.css`**（理由见 `systemAlert.ts` 文件头）。
 */

import { useEffect, useSyncExternalStore } from 'react'

export const FAILURES_SEEN_KEY = 'mde.jobs.failures-seen-at'

/** localStorage 不可用时的退路 */
let memory: number | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function parse(v: string | null): number | null {
  if (v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function readSeenAt(): number | null {
  try {
    return parse(localStorage.getItem(FAILURES_SEEN_KEY))
  } catch {
    return memory
  }
}

function writeSeenAt(t: number | null): void {
  memory = t
  try {
    if (t === null) localStorage.removeItem(FAILURES_SEEN_KEY)
    else localStorage.setItem(FAILURES_SEEN_KEY, String(t))
  } catch {
    /* 存不下就只在本次会话里有效 */
  }
  notify()
}

/** 记下「看过了」。只往前走：已经记着更新的时间就不动 */
export function markFailuresSeen(newest: number): void {
  const cur = readSeenAt()
  if (cur !== null && cur >= newest) return
  writeSeenAt(newest)
}

/** 失败清零：忘掉记号，下一段从头提醒 */
export function clearFailuresSeen(): void {
  if (readSeenAt() === null) return
  writeSeenAt(null)
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === FAILURES_SEEN_KEY) l()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(l)
    window.removeEventListener('storage', onStorage)
  }
}

/** 有没有比「看过」的记号更新的失败。`newest` 为 null（没有失败 / 读不到）时恒为 false */
export function hasUnseenFailures(newest: number | null, seenAt: number | null): boolean {
  return newest !== null && (seenAt === null || newest > seenAt)
}

/** 左栏读它：记号一变（本页看过了 / 别的标签页看过了）就重渲染 */
export function useUnseenFailures(newest: number | null): boolean {
  const seenAt = useSyncExternalStore(subscribe, readSeenAt, () => null)
  return hasUnseenFailures(newest, seenAt)
}

/**
 * 定时任务页挂它，`newest` 是本页读到的最新失败时间：
 * - `undefined`：还没读到（加载中 / 读失败），什么都不做——没看到列表不算看过
 * - `null`：读到了而且没有失败项——忘掉记号
 * - 数字：记下来
 */
export function useMarkFailuresSeen(newest: number | null | undefined): void {
  useEffect(() => {
    if (newest === undefined) return
    if (newest === null) clearFailuresSeen()
    else markFailuresSeen(newest)
  }, [newest])
}
