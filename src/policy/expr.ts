import type { Meeting } from '../domain/types'

/**
 * 仅支持等值、集合包含、时间区间——策略需被管理员读懂并审计，可编程性不是目标。
 *
 * 故意不提供 end_time：平台 /v1/records 不返回会议结束时间，Meeting.endTime
 * 目前是 startTime 的镜像（见 tencent/records.ts、domain/types.ts 上的注释）。
 * 如果在这里把 end_time 映射到 m.endTime，管理员写出的「按结束时间管控」规则
 * 会静默地按开始时间比对——一个授权中枢里查不出来的错误。宁可让 end_time
 * 被下面的未知字段兜底逻辑直接拒绝，管理员写规则时就能立刻发现它不是合法字段。
 */
const FIELD_ACCESSORS: Record<string, (m: Meeting) => string | number> = {
  host_userid: (m) => m.hostUserId,
  meeting_code: (m) => m.meetingCode,
  meeting_id: (m) => m.meetingId,
  subject: (m) => m.subject,
  start_time: (m) => m.startTime,
}

function matchOne(condition: unknown, actual: string | number): boolean {
  if (Array.isArray(condition)) return condition.includes(actual)
  if (condition !== null && typeof condition === 'object') {
    const c = condition as { not_in?: unknown; gte?: unknown; lte?: unknown }
    if (c.not_in !== undefined) {
      // not_in 必须是数组；管理员漏写中括号会把它误配置成字符串/数字/对象。
      // policy_rules.resource_expr 是无 schema 校验的 JSON 列，这种误配置真能落库，
      // Array.isArray 为 false 时绝不能落到本函数末尾的 return true 被当成「通过」。
      if (!Array.isArray(c.not_in)) return false
      if (c.not_in.includes(actual)) return false
    }
    // gte/lte 只对数值有意义。actual 或界值任一非数值时 Number() 得 NaN，
    // 涉及 NaN 的比较全为 false——但「比较为 false」绝不能落到末尾的 return true
    // 被当成「通过」。显式判定：一旦不是有限数值就视为不匹配（return false）。
    if (c.gte !== undefined) {
      const a = Number(actual)
      const bound = Number(c.gte)
      if (!Number.isFinite(a) || !Number.isFinite(bound) || a < bound) return false
    }
    if (c.lte !== undefined) {
      const a = Number(actual)
      const bound = Number(c.lte)
      if (!Number.isFinite(a) || !Number.isFinite(bound) || a > bound) return false
    }
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
