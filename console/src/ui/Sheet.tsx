import { useId } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Overlay } from './Overlay'
import styles from './Sheet.module.css'

export interface SheetProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** 可见标题。给了它就渲染带关闭按钮的头部，并自动挂 aria-labelledby。 */
  title?: string
  /** 没有可见标题时用它做 aria-label——两者至少给一个。 */
  label?: string
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
}

/**
 * 底部面板——从视口底部升起的浮层（窄屏筛选面板、批量操作确认等）。
 * 交互契约与 Drawer 完全共用（同一个 Overlay），只有定位和进场方向不同：
 * Drawer 是横向滑入的两端固定面板，Sheet 是纵向升起的底部固定面板。
 *
 * 同样始终挂载，用 `open` 切换 `data-state`，不要用条件渲染包一层。
 */
export function Sheet(props: SheetProps) {
  const { open, onClose, children, title, label, initialFocusRef, className } = props
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
      className={[styles.panel, className].filter(Boolean).join(' ')}
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
