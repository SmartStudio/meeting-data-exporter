import type { TableHTMLAttributes } from 'react'
import styles from './Table.module.css'

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** 表格内容自身的最小宽度（px 数字，由调用方按列数配置，如密集型会议表 1020）。
   *  低于这个宽度时横向滚动发生在表格自己的容器里，不会带着页面 body 一起滚。 */
  minWidth?: number
}

/**
 * 表格基元：只提供"横向溢出被裹在自己容器里"这一条无障碍/布局硬要求，加上
 * 与 design-system 一致的表头/行基础样式。列宽、排序、选中、键盘光标这些
 * 业务行为留给消费方（T6）组装——这里只管结构，不管交互。
 *
 * 行状态用 data 属性驱动，与原型的约定一致，调用方在 <tr> 上打
 * data-selected="true" / data-cursor="true" / data-dim="true" 即可拿到样式。
 */
export function Table({ children, minWidth, className, style, ...rest }: TableProps) {
  return (
    <div className={styles.wrap}>
      <div className={styles.scroll}>
        <table
          className={[styles.table, className].filter(Boolean).join(' ')}
          style={minWidth ? { minWidth, ...style } : style}
          {...rest}
        >
          {children}
        </table>
      </div>
    </div>
  )
}
