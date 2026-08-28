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
  /**
   * 宽屏下对话框的宽度档。窄屏（≤ 56em）回到底部升起，这个值不起作用。
   *   sm  确认类——一句话加两个按钮
   *   md  表单类（默认）
   *   lg  多步或长列表
   */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

/**
 * 模态对话框。**宽屏居中，窄屏才从底部升起**（定位见 Sheet.module.css 文件头）。
 *
 * 名字仍叫 Sheet 是历史：它最初只有底部形态。九处编辑/确认都走它，于是桌面上
 * 每一次改密码、改保留天数、确认停用都是从屏幕底边升起一整条——那是移动端的
 * 模式，搬上桌面就是离鼠标最远、中间一千多像素全空。
 *
 * 交互契约与 Drawer 完全共用（同一个 Overlay），只有定位和进场方向不同。
 * 同样始终挂载，用 `open` 切换 `data-state`，不要用条件渲染包一层。
 */
export function Sheet(props: SheetProps) {
  const { open, onClose, children, title, label, initialFocusRef, size = 'md', className } = props
  const titleId = useId()
  const sizeClass = size === 'md' ? undefined : styles[size]

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
      className={[styles.panel, sizeClass, className].filter(Boolean).join(' ')}
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
