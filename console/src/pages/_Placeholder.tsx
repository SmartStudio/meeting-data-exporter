import styles from './_Placeholder.module.css'

export interface PlaceholderProps {
  title: string
  /** 这页真正实现落在哪个阶段（见 dev-plan.md 的 F 阶段划分）。 */
  phase: string
  note?: string
}

/**
 * 六个非会议记录页面共用的占位组件。不留空白页——演示时空白页看起来像
 * 坏了，所以每页都至少说清楚「这是什么、什么时候实现」。
 *
 * brief 原文让占位文案统一写「F2–F5 实现」，但 dev-plan.md §「批次」表
 * 里逐页的真实阶段并不落在这个区间：采集授权是 F4、自动规则是 F3、
 * 定时任务/归档存储/操作审计是 F5、内容预览是 F6（不是 F2–F5 覆盖的
 * 范围）。以事实为准，改成按页面传入准确的阶段号。
 */
export default function Placeholder({ title, phase, note }: PlaceholderProps) {
  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.note}>{note ?? `完整页面尚未实现，计划在 ${phase} 阶段接入真实交互与数据。`}</p>
    </div>
  )
}
