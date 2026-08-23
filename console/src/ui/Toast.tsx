import type { ReactNode } from 'react'
import { Overlay } from './Overlay'
import styles from './Toast.module.css'

export interface ToastProps {
  open: boolean
  /** 计时器到点、或有动作按钮时用户点了别处导致的关闭意图。 */
  onClose: () => void
  message: ReactNode
  /** 动作按钮文案；不给就是纯提示条。 */
  actionLabel?: string
  onAction?: () => void
  className?: string
}

/**
 * Toast 是唯一不套 Overlay「抢焦点」那套契约的浮层——它不打断用户在干的事：
 *
 * - `autoFocus=false` / `restoreFocus=false`：出现时不抢焦点，消失时也不用还。
 * - `trapFocus=false` / `closeOnEsc=false`：不是模态，不困住 Tab，也不占 Esc。
 * - `role="status"`：礼貌播报（隐式 aria-live="polite"），不是 alertdialog。
 *
 * 但它仍然要守住 inert 这条底线：**没有动作按钮时,整块都不该被 Tab 到**，
 * 哪怕它正显示着——`forceInert` 独立于 `open` 生效，覆盖了 Overlay 默认
 * 「可见就不 inert」的逻辑。有动作按钮时,只有那颗按钮该在 Tab 序列里，
 * 外层容器本身不该是（Overlay 的 panel 恒为 tabIndex=-1）。
 *
 * 动作按钮压在反相表面上（design-system.md §2.3）：那块底跟主题反向取色，
 * 浅色模式下近黑、深色模式下近白，所以按钮文字必须用 `--accent-invert`——
 * 用 `--brand` 在浅色模式下这块底上只有 2.85:1，不达 AA。
 */
export function Toast(props: ToastProps) {
  const { open, onClose, message, actionLabel, onAction, className } = props
  const hasAction = Boolean(actionLabel && onAction)

  return (
    <Overlay
      open={open}
      onClose={onClose}
      role="status"
      modal={false}
      autoFocus={false}
      restoreFocus={false}
      trapFocus={false}
      closeOnEsc={false}
      forceInert={!hasAction}
      className={[styles.bar, className].filter(Boolean).join(' ')}
    >
      <span className={styles.message}>{message}</span>
      {hasAction && (
        <button type="button" className={styles.action} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </Overlay>
  )
}
