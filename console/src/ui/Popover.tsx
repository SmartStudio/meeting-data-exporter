import type { ReactNode, RefObject } from 'react'
import { Overlay } from './Overlay'
import styles from './Popover.module.css'

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export interface PopoverProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** 弹出层没有可见标题，必须给一个 aria-label 让读屏知道这是什么。 */
  label: string
  /** 相对触发元素的定位角，默认 'bottom-start'。 */
  placement?: PopoverPlacement
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
}

/**
 * 轻量弹出层（筛选面板、下拉菜单一类）。纯 CSS 定位，不做锚点测量——
 * 调用方需要把触发按钮和 `<Popover>` 一起包在 `position: relative` 的容器
 * 里，`placement` 只决定它贴哪个角。这里不引入定位库，YAGNI：F1 阶段的用法
 * 都是「贴着触发它的按钮」，不需要视口边界避让那一套。
 *
 * 没有遮罩、不天然支持点击外部关闭——关闭途径是 Esc、内部的操作按钮，或者
 * 触发按钮自己的 onClick 把 `open` 切回 false。
 *
 * inert / Esc / 焦点管理与 Drawer / Sheet 完全共用同一个 Overlay。
 */
export function Popover(props: PopoverProps) {
  const { open, onClose, children, label, placement = 'bottom-start', initialFocusRef, className } = props

  return (
    <Overlay
      open={open}
      onClose={onClose}
      role="dialog"
      modal={false}
      label={label}
      initialFocusRef={initialFocusRef}
      className={[styles.panel, styles[placement], className].filter(Boolean).join(' ')}
    >
      {children}
    </Overlay>
  )
}
