import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'default' | 'quiet' | 'danger' | 'warn'
export type ButtonSize = 'md' | 'sm'

// CSS Modules 的类型来自索引签名，noUncheckedIndexedAccess 下每一项都是
// `string | undefined`（哪怕键是编译期已知的字面量）——不强行断言成 string，
// 拼 className 时统一走 filter(Boolean)，缺一个类名不会崩，只是不生效。
const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  default: styles.default,
  quiet: styles.quiet,
  danger: styles.danger,
  warn: styles.warn,
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体。primary=蓝·主交互，danger=红·失败相关操作，warn=琥珀·改写规则相关操作。 */
  variant?: ButtonVariant
  size?: ButtonSize
}

/**
 * 按钮基元。三档语义变体（primary / danger / warn）分别对应设计系统的三个语义色，
 * 不要为了好看换用途——danger 只用于失败/摧毁性操作，warn 只用于人工改写规则相关操作。
 *
 * disabled 走原生 `disabled` 属性：浏览器保证不可点击、不进 Tab 序列，不需要额外处理。
 * 按下反馈是 translateY(1px) 且不经过渡（按下必须是即时的），只在颜色/边框上做过渡。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  const classes = [
    styles.btn,
    VARIANT_CLASS[variant],
    size === 'sm' ? styles.sm : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return <button ref={ref} type={type} className={classes} {...rest} />
})
