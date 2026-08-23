import type { Meeting } from '../types'

/** `load-failed` 用的错误，带上下文细节，不是裸 `new Error('failed')`。 */
export function loadFailedError(): Error {
  return new Error('网关请求失败：GET /api/meetings 返回 503 Service Unavailable，请稍后重试。')
}

/**
 * NAS 断连时的数据变形（spec.md §7.2）。**这是数据层的责任，不是横幅**：
 * - 归档失败数从 1 变 5——挑 4 场原本 `archive:'done'` 的会议判定为归档失败
 * - 它们的保留窗口清零：`archivedAt`/`expiresAt` 归 null（本来就不该开始计时）
 * - 它们的授权撤下：`grants` 清空（没归档成功的东西不该对外可见）
 *
 * 不改变已经是 `failed` / `blocked` / `off` 的会议——它们的状态跟 NAS 无关。
 */
export function applyNasDown(meetings: Meeting[]): Meeting[] {
  const alreadyFailed = meetings.filter((m) => m.archive === 'failed').length
  let toBreak = Math.max(0, 5 - alreadyFailed)

  return meetings.map((m) => {
    if (toBreak > 0 && m.archive === 'done') {
      toBreak -= 1
      return {
        ...m,
        archive: 'failed',
        keep: { archivedAt: null, expiresAt: null, extended: 0, filesGone: false },
        grants: [],
      }
    }
    return m
  })
}
