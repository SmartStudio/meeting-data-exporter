import type { Meeting } from '../domain/types'

/** 仅支持等值、集合包含、时间区间——策略需被管理员读懂并审计，可编程性不是目标 */
const FIELD_ACCESSORS: Record<string, (m: Meeting) => string | number> = {
  host_userid: (m) => m.hostUserId,
  meeting_code: (m) => m.meetingCode,
  meeting_id: (m) => m.meetingId,
  subject: (m) => m.subject,
  start_time: (m) => m.startTime,
  end_time: (m) => m.endTime,
}

function matchOne(condition: unknown, actual: string | number): boolean {
  if (Array.isArray(condition)) return condition.includes(actual)
  if (condition !== null && typeof condition === 'object') {
    const c = condition as { not_in?: unknown[]; gte?: number; lte?: number }
    if (c.not_in !== undefined && c.not_in.includes(actual)) return false
    if (c.gte !== undefined && Number(actual) < c.gte) return false
    if (c.lte !== undefined && Number(actual) > c.lte) return false
    return true
  }
  return condition === actual
}

export function matchExpr(expr: Record<string, unknown>, meeting: Meeting): boolean {
  for (const [field, condition] of Object.entries(expr)) {
    const accessor = FIELD_ACCESSORS[field]
    if (!accessor) return false // 未知字段一律不匹配，避免拼写错误意外放行
    if (!matchOne(condition, accessor(meeting))) return false
  }
  return true
}
