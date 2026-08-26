import type { TableHTMLAttributes } from 'react'
import styles from './Table.module.css'

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** 表格内容自身的最小宽度（px 数字，由调用方按列数配置，如密集型会议表 1020）。
   *  低于这个宽度时横向滚动发生在表格自己的容器里，不会带着页面 body 一起滚。 */
  minWidth?: number
  /**
   * 窄屏（≤56em）改成一行一张卡片，而不是横向滚动（spec §11 缺口 2）。
   *
   * **开了它就必须给每个 `<td>` 一个 `data-label`**：卡片形态下 `<thead>` 不再
   * 渲染，列名改由每个格子自己带（`td::before { content: attr(data-label) }`）。
   * 漏一个的表现是那一格只剩一个孤零零的值，没人知道它是什么——所以这是一个
   * 显式的开关，不是默认行为：默认行为会让没准备好的表在窄屏悄悄丢掉列名。
   *
   * 代价说清楚：`display: block` 会让浏览器丢掉这张表的 table 角色，读屏不再
   * 念「第 3 列，主持人」。这正是 `data-label` 要补回来的东西——它是可见文本，
   * 读屏照常念得到。宽屏（>56em）下什么都不变，表还是表。
   */
  cards?: boolean
}

/**
 * 表格基元：只提供"横向溢出被裹在自己容器里"这一条无障碍/布局硬要求，加上
 * 与 design-system 一致的表头/行基础样式。列宽、排序、选中、键盘光标这些
 * 业务行为留给消费方（T6）组装——这里只管结构，不管交互。
 *
 * 行状态用 data 属性驱动，与原型的约定一致，调用方在 <tr> 上打
 * data-selected="true" / data-cursor="true" / data-dim="true" 即可拿到样式。
 */
export function Table({ children, minWidth, cards = false, className, style, ...rest }: TableProps) {
  return (
    <div className={[styles.wrap, cards ? styles.cards : undefined].filter(Boolean).join(' ')}>
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
