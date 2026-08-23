import { forwardRef } from 'react'
import type { InputHTMLAttributes } from 'react'
import styles from './Input.module.css'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 校验失败态：红边框 + 红底，同时应配合可见的错误文案（不能只靠颜色）。 */
  invalid?: boolean
}

/**
 * 输入框基元。触控目标恒定 ≥44px（design-system.md §5「输入类触控目标 ≥44px」），
 * 不是仅在窄屏媒体查询下才达标——原型里这条只在窄屏断点生效，这里收紧成任何宽度下都成立。
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className, ...rest },
  ref,
) {
  const classes = [styles.input, invalid ? styles.invalid : undefined, className]
    .filter(Boolean)
    .join(' ')

  return <input ref={ref} className={classes} aria-invalid={invalid || undefined} {...rest} />
})
