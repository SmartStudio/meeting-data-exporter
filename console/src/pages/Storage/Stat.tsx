import type { ReactNode } from 'react'
import styles from './Storage.module.css'

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
  /** 有值时的语气。fail 用于"归档失败"这类本身就是坏消息的计数 */
  tone?: 'plain' | 'fail'
  /** 这一格底下那行小字：口径、或者拿不到的原因 */
  note?: ReactNode
}

/** 统计格。两块面板共用，样式与"拿不到"的处置都收在这里，不各写一遍。 */
export function Stat({ id, label, value, missingText = '暂不可得', tone = 'plain', note }: StatProps) {
  const missing = value === null || value === undefined
  const valueClass = missing
    ? styles.statVMissing
    : tone === 'fail'
      ? styles.statVFail
      : styles.statV

  return (
    <div className={styles.stat} data-testid={`stat-${id}`}>
      <div className={styles.statK}>{label}</div>
      <div className={valueClass}>{missing ? missingText : value}</div>
      {note !== undefined && <div className={styles.statNote}>{note}</div>}
    </div>
  )
}
