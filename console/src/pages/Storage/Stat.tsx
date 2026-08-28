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
  /** 有值时的语气。fail 用于本身就是坏消息的计数 */
  tone?: 'plain' | 'fail'
  /**
   * 这一格的口径，挂在标签旁边的 ⓘ 上。**不上正文**——见 `Hint` 的注释。
   * 每一格的解剖因此是同一个形状：标签（+ⓘ）+ 一个数，没有第三种长相。
   */
  hint?: string
}

/** 统计格。两块面板共用，样式与"拿不到"的处置都收在这里，不各写一遍。 */
export function Stat({ id, label, value, missingText = '暂不可得', tone = 'plain', hint }: StatProps) {
  const missing = value === null || value === undefined
  const valueClass = missing
    ? styles.statVMissing
    : tone === 'fail'
      ? styles.statVFail
      : styles.statV

  return (
    <div className={styles.stat} data-testid={`stat-${id}`}>
      <div className={styles.statK}>
        {label}
        {hint !== undefined && <Hint text={hint} />}
      </div>
      <div className={valueClass}>{missing ? missingText : value}</div>
    </div>
  )
}
