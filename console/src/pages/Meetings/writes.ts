import { useCallback, useRef, useState } from 'react'
import { ApiError, UnauthorizedError } from '@/api/client'

/**
 * 写操作的跑腿层：**发请求 + 重取**，不做乐观更新（裁定 G-c）。
 *
 * F1 时代所有写操作都走 `write.ts` 的 `applyWrite`，在前端推导「改了 `fetch`
 * 就要连带改 `why` / `hand` / `keep`」。接真 API 之后那套推导在后端也有一份
 * （而且带测试），留着两份就是两份真相，而它们不一致的地方恰好是判定边界。
 * 所以这里只做四件事：**标 pending、发请求、成功后重取、失败给一个看得见的出口**。
 *
 * 代价是每次操作要等一个往返，补偿是 pending 必须做出来——**点了没反应比慢一点更糟**。
 * 管理操作不是高频输入，这个取舍站得住。
 *
 * ## 401 不在这里处理
 *
 * `AppShell` 注册了全局出口（`setUnauthorizedHandler`），会话过期一律跳登录。
 * 这一层碰到 `UnauthorizedError` **不弹错误条**：那会在跳转的同一帧里闪一句
 * 「操作失败」，而真正发生的事是「你被登出了」。
 */

/** 一次失败的写操作。`detail` 里带着端点名与后端的错误码（`ApiError.message`）。 */
export interface WriteFailure {
  /** 「延长保留期没有成功」——说的是哪个动作，不是「出错了」 */
  title: string
  detail: string
  /** 后端错误码（`ApiError.body.error`），认得出的给一句人话 */
  hint: string | null
}

/**
 * 后端错误码 → 一句能照着做的话。名单只收**这一页发得出的请求**会遇到的码。
 * 认不出的不编：`detail` 里已经带着端点名和原始错误码。
 */
const HINTS: Record<string, string> = {
  already_purged: '本地文件已被到期清理，延长不回来。历史数据请到 NAS 路径取。',
  archive_not_found: '这场会议还没有归档记录，保留窗口尚未开始计时。',
  invalid_days: '延长天数必须是 1..365 的整数。',
  program_not_found: '这个采集程序不存在，可能刚被删掉。刷新一次再试。',
  missing_asset_types: '请求缺了 assetTypes 这个键——这是前端的 bug，请连同这条错误一起反馈。',
  missing_reason: '人工改写必须写清理由，它会进判定理由与审计。',
  meeting_not_found: '这场会议在库里查不到了，可能刚被清理。刷新一次列表。',
}

function codeOf(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null
  const body = e.body
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const code = (body as { error: unknown }).error
    if (typeof code === 'string') return code
  }
  return null
}

export function failureOf(what: string, e: unknown): WriteFailure {
  const code = codeOf(e)
  return {
    title: `${what}没有成功`,
    detail: e instanceof Error ? e.message : String(e),
    hint: code === null ? null : (HINTS[code] ?? null),
  }
}

export interface Writes {
  /** 这个键上有没有正在跑的请求。键由调用方定（`${id}:extend`），细到按钮 */
  isPending: (key: string) => boolean
  /** 有没有任何写操作在跑——批量条整条禁用时用它 */
  busy: boolean
  failure: WriteFailure | null
  dismissFailure: () => void
  /**
   * 跑一次写操作。`what` 是动作名（进成功/失败的话），`fn` 返回成功时要说的那句话。
   * 成功之后调用 `onDone()` 重取——**重取是这一层的义务**，不是调用方的。
   */
  run: (key: string, what: string, fn: () => Promise<string>) => Promise<void>
}

export function useWrites(onDone: () => void, notify: (text: string) => void): Writes {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [failure, setFailure] = useState<WriteFailure | null>(null)
  // 同一个键上重复点击要被挡住，而 `pending` 这个 state 在同一帧里还没更新——
  // 双击「延长 30 天」会发出两次请求、加两次天数，而界面上只有一次点击的痕迹。
  const inFlight = useRef<Set<string>>(new Set())

  const run = useCallback(
    async (key: string, what: string, fn: () => Promise<string>) => {
      if (inFlight.current.has(key)) return
      inFlight.current.add(key)
      setPending((prev) => new Set(prev).add(key))
      setFailure(null)
      try {
        const message = await fn()
        onDone()
        notify(message)
      } catch (e) {
        // 会话过期由全局出口接管（跳登录），这里不再叠一条「操作失败」
        if (!(e instanceof UnauthorizedError)) setFailure(failureOf(what, e))
      } finally {
        inFlight.current.delete(key)
        setPending((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [onDone, notify],
  )

  const isPending = useCallback((key: string) => pending.has(key), [pending])
  const dismissFailure = useCallback(() => setFailure(null), [])

  return { isPending, busy: pending.size > 0, failure, dismissFailure, run }
}

/**
 * pending 的键。细到「哪一行的哪一个动作」——整页共用一个布尔的话，
 * 延长 A 场会把 B 场的按钮也变灰，看起来像整页卡住了。
 */
export function wkey(id: string, op: string): string {
  return `${id}:${op}`
}

/**
 * 批量结果的一句话。**成功几场、失败几场分开说**——只说「已对 N 场执行」
 * 会把静默失败的那几场藏起来，而这一页的批量动作里有一个是授权。
 */
export function batchSummary(what: string, ok: number, failed: number): string {
  if (failed === 0) return `已对 ${ok} 场会议${what}`
  if (ok === 0) return `${failed} 场都没能${what}，请展开错误看原因`
  return `${ok} 场${what}成功，${failed} 场失败`
}

/** `Promise.allSettled` 的结果数一数。第一条被拒的原因原样带出来，供错误条显示。 */
export function tally(results: PromiseSettledResult<unknown>[]): {
  ok: number
  failed: number
  firstError: unknown
} {
  let ok = 0
  let failed = 0
  let firstError: unknown = null
  for (const r of results) {
    if (r.status === 'fulfilled') ok += 1
    else {
      failed += 1
      if (firstError === null) firstError = r.reason
    }
  }
  return { ok, failed, firstError }
}
