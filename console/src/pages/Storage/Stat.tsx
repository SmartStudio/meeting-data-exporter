import type { ReactNode } from 'react'
import styles from './Storage.module.css'

export interface HintProps {
  /** 悬停/聚焦时读到的整句定义。它同时是 `title` 与 `aria-label` */
  text: string
}

/**
 * 口径说明的 ⓘ。
 *
 * **为什么定义不写成正文**：这一页原先有 13 处说明性散文，占全页可见文字的
 * 48%——数字和按钮被自己的解释淹了。判据是"删掉它，用户会不会做错事"：
 * 一格统计的口径（"等待归档数的是哪些会议"）不知道也不会点错任何按钮，
 * 但需要的时候得查得到。所以它降级成悬停，而不是被删掉。
 *
 * `tabIndex={0}` 是为了键盘也够得着这个 title——只能鼠标悬停的说明对键盘
 * 用户等于不存在。`role="note"` + `aria-label` 让读屏念出整句，而不是念一个
 * 孤零零的 ⓘ 字符。**不要改成 `role="img"`**：容量条本身就是一个 role=img，
 * 图例里的 ⓘ 再占一个，读屏用户在同一块区域里会听到两个"图像"。
 */
export function Hint({ text }: HintProps) {
  return (
    <span className={styles.hint} tabIndex={0} role="note" aria-label={text} title={text}>
      ⓘ
    </span>
  )
}

export interface StatProps {
  /** 落在 `data-testid="stat-<id>"` 上，也是这一格的稳定标识 */
  id: string
  label: string
  /**
   * 取值。**`null` 的意思是"这个数现在拿不到"**，渲染成 `missingText`
   * 而不是 0——0 是一次判定（"确实没有"），拿不到是一次缺口，
   * 把后者显示成前者就是替一个我们没有的答案下结论。
   */
  value: ReactNode | null
  /** `value === null` 时显示什么。默认"暂不可得" */
  missingText?: string
  /** 有值时的语气。fail / warn 用于本身就是坏消息的计数，其余保持中性 */
  tone?: 'plain' | 'fail' | 'warn'
  /**
   * 这一格的口径，**一句可见的小字**，挂在数字下面（D-jobs-storage brief：
   * 7 个 ⓘ 砍到 2 个以内，能写进标签/正文的就写进去，不必都挂悬停）。
   * 每一格的解剖因此是「标签 / 数字 / 一句注」三行，同一个形状，
   * 不再需要先悬停才看得到口径。
   */
  note?: ReactNode
}

/** 统计格。两块面板共用，样式与"拿不到"的处置都收在这里，不各写一遍。
 *  不再是带边框的盒子——一排靠基线对齐的数字组，列与列之间的分隔线由
 *  外层 `.stats` 容器画（`border-right` + `--line-soft`），这里只管内容。 */
export function Stat({ id, label, value, missingText = '暂不可得', tone = 'plain', note }: StatProps) {
  const missing = value === null || value === undefined
  const valueClass = missing
    ? styles.statVMissing
    : tone === 'fail'
      ? styles.statVFail
      : tone === 'warn'
        ? styles.statVWarn
        : styles.statV

  return (
    <div className={styles.stat} data-testid={`stat-${id}`}>
      <div className={styles.statK}>{label}</div>
      <div className={valueClass}>{missing ? missingText : value}</div>
      {note !== undefined && <div className={styles.statNote}>{note}</div>}
    </div>
  )
}
