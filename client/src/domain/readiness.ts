export interface ReadinessInput {
  present: boolean
  state?: number
  allowDownload?: boolean
  now: number
  deadlineAt: number
}
/**
 * 资产就绪判定（spec §9）。判定顺序关键：
 * ① allow_download=false 优先（平台明示不可得，即使 state=3 也 skip，不空等）
 * ② state=3 → ready
 * ③ 其余（state=1/2 或不在清单）未就绪：超 deadline → skip_timeout，否则 wait
 */
export function judgeReadiness(i: ReadinessInput): 'ready' | 'wait' | 'skip_disallowed' | 'skip_timeout' {
  if (i.present && i.allowDownload === false) return 'skip_disallowed'
  if (i.present && i.state === 3) return 'ready'
  if (i.now >= i.deadlineAt) return 'skip_timeout'
  return 'wait'
}
