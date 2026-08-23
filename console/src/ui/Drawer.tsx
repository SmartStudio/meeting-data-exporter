import { useId } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Overlay } from './Overlay'
import styles from './Drawer.module.css'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** 可见标题。给了它就渲染带关闭按钮的头部，并自动挂 aria-labelledby。 */
  title?: string
  /** 没有可见标题时用它做 aria-label——两者至少给一个，否则读屏念不出这是什么。 */
  label?: string
  /** 滑入方向，默认从右侧。 */
  side?: 'left' | 'right'
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
}

/**
 * 侧边抽屉。定位与滑入方向是它唯一的「私货」——inert / Esc / 焦点管理全部
 * 来自 Overlay，这里不重复实现。
 *
 * 始终挂载，用 `open` 切换 `data-state`：这样退场时 inert 能在同一帧生效，
 * 而滑出动画（transform + opacity）照常播完（design-system.md §5.1）。
 * 调用方不要用 `{open && <Drawer/>}` 包一层条件渲染——那会让它在关闭瞬间
 * 直接从 DOM 消失，动画根本来不及播。
 */
export function Drawer(props: DrawerProps) {
  const { open, onClose, children, title, label, side = 'right', initialFocusRef, className } = props
  const titleId = useId()

  return (
    <Overlay
      open={open}
      onClose={onClose}
      role="dialog"
      modal
      scrim
      label={title ? undefined : label}
      labelledBy={title ? titleId : undefined}
      initialFocusRef={initialFocusRef}
      className={[styles.panel, side === 'left' ? styles.left : styles.right, className]
        .filter(Boolean)
        .join(' ')}
    >
      {title && (
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button type="button" className={styles.closeBtn} aria-label="关闭" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      <div className={styles.body}>{children}</div>
    </Overlay>
  )
}
