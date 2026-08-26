import type { ReactNode } from 'react'
import styles from './Pill.module.css'

export type PillTone = 'neutral' | 'brand' | 'warn' | 'fail'

// noUncheckedIndexedAccess：CSS Modules 的索引签名让每一项天然是 string | undefined。
const TONE_CLASS: Record<PillTone, string | undefined> = {
  neutral: styles.neutral,
  brand: styles.brand,
  warn: styles.warn,
  fail: styles.fail,
}

interface PillBaseProps {
  tone?: PillTone
  /** 实底样式（用 --on-brand / --on-fail 配对令牌撑白字），用于计数徽标一类场景
   *  （如导航栏的「归档失败 N」）。tokens.css 只给 brand / fail 定义了 on- 配对，
   *  用在 warn / neutral 上会退回软底样式。 */
  solid?: boolean
  children: ReactNode
  className?: string
}

type PillProps =
  | (PillBaseProps & {
      onRemove?: undefined
      removeLabel?: undefined
      removeDisabled?: undefined
      removeTitle?: undefined
    })
  | (PillBaseProps & {
      onRemove: () => void
      removeLabel: string
      /** 移除角标禁用（只读角色、或这一条正在提交中）。禁用而不是不渲染——
       *  角标消失会让人以为这条授权本来就收不回来。 */
      removeDisabled?: boolean
      /** 禁用的原因，挂在原生 title 上。禁用了却不说为什么，就是一个坏掉的按钮。 */
      removeTitle?: string
    })

/**
 * 徽标基元：软底文字标签（默认）或实底计数徽标（solid）。
 * 三个语义色只能按 design-system.md §2.2 的含义使用：
 *   brand=数据可被取走/主交互，warn=人工改写规则/保留期将至，fail=失败。
 * 带 onRemove 时渲染一个可点的移除角标，removeLabel 是它的 aria-label
 *（如"收回 kb-indexer"）——不能只留一个裸的 ✕ 没有文本。
 */
export function Pill({
  tone = 'neutral',
  solid = false,
  onRemove,
  removeLabel,
  removeDisabled = false,
  removeTitle,
  children,
  className,
}: PillProps) {
  const classes = [styles.pill, TONE_CLASS[tone], solid ? styles.solid : undefined, className]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={classes}>
      <span>{children}</span>
      {onRemove ? (
        <button
          type="button"
          className={styles.remove}
          onClick={onRemove}
          disabled={removeDisabled}
          title={removeTitle}
          aria-label={removeLabel}
        >
          ✕
        </button>
      ) : null}
    </span>
  )
}
