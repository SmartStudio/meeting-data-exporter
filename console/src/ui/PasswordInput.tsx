import { forwardRef, useState } from 'react'
import { Input } from './Input'
import type { InputProps } from './Input'
import styles from './PasswordInput.module.css'

export type PasswordInputProps = Omit<InputProps, 'type'>

/**
 * 密码输入框。就是 `ui/Input`，外加一颗「显示 / 隐藏」的眼睛。
 *
 * 状态**不外提**：明文与否是这一个框自己的临时显示状态，不是表单数据。
 * 提到调用方去只会让每个用密码框的地方都多一个 useState，然后各自决定
 * 要不要在提交后复位——那种「每处各自决定」正是不一致的来源。
 *
 * 无障碍上用的是**变名字**而不是 `aria-pressed`：按钮的名字直接说下一次
 * 按下去会发生什么（「显示密码」/「隐藏密码」）。两个一起用会变成双重否定
 * ——读屏念出「隐藏密码，已按下」，听的人还得自己推一遍现在到底是明是暗。
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, disabled, ...rest }, ref) {
    const [shown, setShown] = useState(false)
    const inputClass = [styles.input, shown ? styles.shown : undefined, className].filter(Boolean).join(' ')
    const toggleClass = [styles.toggle, shown ? styles.on : undefined].filter(Boolean).join(' ')

    return (
      <span className={styles.wrap}>
        <Input
          ref={ref}
          type={shown ? 'text' : 'password'}
          className={inputClass}
          disabled={disabled}
          {...rest}
        />
        <button
          type="button"
          className={toggleClass}
          onClick={() => setShown((v) => !v)}
          disabled={disabled}
          aria-label={shown ? '隐藏密码' : '显示密码'}
          /* 这颗按钮不进 Tab 之后的表单语义：它不提交、不改值，只改显示方式。
             但它必须**留在** Tab 序列里——键盘用户和读屏用户同样看不见自己
             输的是什么，把它做成只有鼠标够得着，等于只给一部分人这条出路。 */
        >
          {shown ? <EyeOff /> : <Eye />}
        </button>
      </span>
    )
  },
)

function Eye(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function EyeOff(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4 6.5-4c1 0 1.9.24 2.7.62M14.5 8s-2.4 4-6.5 4c-1 0-1.9-.24-2.7-.62"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
