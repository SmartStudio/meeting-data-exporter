/**
 * 「最近 N 轮拉取连续失败」那条横幅的关闭状态。
 *
 * 横幅本身是**从数据推出来的**（`fetchStall()`）：故障一直在，它就一直在。
 * 这是对的——它不是一条通知，是一个当前状态。但一个关不掉的状态条会把它下面
 * 那四张卡片一直往下挤，而知道了这件事的人在等修复期间还要继续用这一页。
 *
 * ## 为什么按「最新那次失败运行的 id」记，而不是按时间、也不是「关过就不再显示」
 *
 * - **不能"关过就永远不显示"**。那等于把一个还会再来的告警一次性禁用掉：
 *   这次故障修好了，下个月拉取又连着挂三轮，屏幕上什么都不会说。
 * - **不按时间戳记**（"关掉后 24 小时内不显示"）。24 小时是个凭空定的数：
 *   故障 25 小时还没好，横幅自己跳回来；故障两小时就修好了、下午又坏一次，
 *   那次真该说的反而被压着。时间和"是不是同一段故障"没有关系。
 * - **按 `latestFailedRunId` 记**，因为它就是"这一段故障"的身份：又失败一轮
 *   就是一次新的、你还没看过的失败，id 随之变大，`hidden` 自然变回 false，
 *   横幅重新出现。你关掉的始终只是**你已经看过的那一条**。
 *
 * ## 为什么连续失败一结束就把键删掉
 *
 * `stall` 变成 null = 拉取又跑成了一次，这一段故障结束了。留着那个 id 没有任何
 * 用处（下一段故障的 id 一定更大，比不上），却留着一个会误伤的可能：id 是数据库
 * 自增值，换一套数据（导入、重建、换环境）之后新的运行 id 完全可能撞上这个旧值，
 * 那时下一段故障的第一眼提醒会被悄悄吞掉。故障结束就清干净，下一段从头提醒。
 *
 * 存储用 localStorage，读写都包 try/catch（同 `theme/useTheme.ts`）：私密窗口、
 * 禁用站点数据的浏览器会直接抛。存不下就只在本次会话里生效——关掉这一下当场
 * 必须有反应，这比"关闭状态能跨刷新记住"要紧得多。
 */

import { useCallback, useEffect, useState } from 'react'
import type { FetchStall } from './view'

const KEY = 'mde.jobs.fetch-stall.dismissed'

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function write(value: string): void {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* 存不了就只在本次会话生效 */
  }
}

function clear(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 同上：删不掉也不能让它炸掉整个页面 */
  }
}

export interface DismissedStall {
  /** 这一段故障已经被关过了——横幅不显示 */
  hidden: boolean
  /** 关掉眼前这一段。`stall` 为 null 时是空操作 */
  dismiss: () => void
}

export function useDismissedStall(stall: FetchStall | null): DismissedStall {
  const [dismissedId, setDismissedId] = useState<string | null>(read)

  // 依赖是那个 id 而不是 `stall` 本身：`fetchStall()` 每次渲染都返回一个新对象，
  // 拿它当依赖等于每渲染一次就跑一遍这个 effect。
  const latestFailedRunId = stall === null ? null : stall.latestFailedRunId

  useEffect(() => {
    if (latestFailedRunId !== null) return
    // 连续失败结束了：把这一段的身份忘掉（理由见文件头）
    clear()
    setDismissedId(null)
  }, [latestFailedRunId])

  const dismiss = useCallback(() => {
    if (latestFailedRunId === null) return
    const id = String(latestFailedRunId)
    write(id)
    // 先写存储再落 state，但两者不绑在一起：写失败（私密窗口）时横幅照样关掉，
    // 只是下次刷新还会回来。
    setDismissedId(id)
  }, [latestFailedRunId])

  const hidden = latestFailedRunId !== null && dismissedId === String(latestFailedRunId)

  return { hidden, dismiss }
}
