import styles from './ProgressBar.module.css'

export type ProgressTone = 'brand' | 'warn' | 'fail' | 'neutral'

// noUncheckedIndexedAccess：CSS Modules 的索引签名让每一项天然是 string | undefined。
const TONE_CLASS: Record<ProgressTone, string | undefined> = {
  brand: styles.brand,
  warn: styles.warn,
  fail: styles.fail,
  neutral: styles.neutral,
}

export interface ProgressBarProps {
  value: number
  /** 默认 100。 */
  max?: number
  /** brand=常规进度，warn=保留期将至，fail=失败（如归档失败后的重试进度）。 */
  tone?: ProgressTone
  /** 必填：这条进度条量的是什么，读屏用户没有视觉宽度可看，只有这段文本。 */
  label: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 进度/容量条基元。条状元素用 --r-pill（语义是"半高"，不是某个像素值）。
 * value 会被夹到 [0, max] 区间内，aria-valuenow 与视觉宽度百分比始终一致
 *（同一次计算得出，不会有一个更新了另一个没跟上）。
 */
export function ProgressBar({ value, max = 100, tone = 'brand', label, size = 'md', className }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(max, value))
  const pct = max > 0 ? (clamped / max) * 100 : 0

  return (
    <div
      className={[styles.track, size === 'sm' ? styles.sm : undefined, className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      {/* 用 transform: scaleX 而不是 width 做取值——只动 transform/opacity，
          不动布局属性做动画（design-system.md §6）。fill 元素本身恒定 100% 宽，
          靠缩放表达进度，视觉宽度与 aria-valuenow 出自同一次 pct 计算，不会错位。 */}
      <div
        className={[styles.fill, TONE_CLASS[tone]].filter(Boolean).join(' ')}
        style={{ transform: `scaleX(${pct / 100})` }}
        data-pct={pct}
      />
    </div>
  )
}
