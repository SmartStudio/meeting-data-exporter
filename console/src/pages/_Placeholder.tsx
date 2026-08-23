import { useMeetings, useSystemState } from '@/app/SystemStatus'
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

/**
 * `/meetings` 专用的占位内容——不是通用 `Placeholder`，因为它承担着证明
 * 「外壳真的把系统状态切下去、页面读到的是变换后的数据」这件事：
 * 数字全部来自 `useMeetings()`（内部用当前系统状态调 `mockApi(state)`），
 * 不是写死的。分诊条、表格、批量操作等完整实现是 T6 的事，这里刻意不做。
 */
export function MeetingsPlaceholder() {
  const { state } = useSystemState()
  const meetings = useMeetings()

  const archiveFailed = meetings.state === 'ready' ? meetings.data.filter((m) => m.archive === 'failed') : []
  const keepCleared = archiveFailed.filter((m) => m.keep.archivedAt === null && m.keep.expiresAt === null).length
  const grantsCleared = archiveFailed.filter((m) => m.grants.length === 0).length

  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>会议记录</h2>
      <p className={styles.note}>
        完整的分诊条、表格、批量操作与键盘操作由 T6 实现。这里先证明外壳把系统状态真的切了下去，
        页面读到的是变换后的数据。
      </p>

      {meetings.state === 'loading' && (
        <p className={styles.status} data-testid="meetings-status">
          正在读取…
        </p>
      )}

      {meetings.state === 'error' && (
        <div className={styles.status} data-testid="meetings-status">
          <p>{meetings.error.message}</p>
          <button type="button" className={styles.retry} onClick={meetings.retry}>
            重试
          </button>
        </div>
      )}

      {meetings.state === 'ready' && meetings.data.length === 0 && (
        <p className={styles.status} data-testid="meetings-status">
          还没有拉取过任何会议。
        </p>
      )}

      {meetings.state === 'ready' && meetings.data.length > 0 && (
        <dl className={styles.stats} data-testid="meetings-stats">
          <div className={styles.stat}>
            <dt>会议总数</dt>
            <dd data-testid="stat-total">{meetings.data.length}</dd>
          </div>
          <div className={styles.stat}>
            <dt>归档失败</dt>
            <dd data-testid="stat-failed">{archiveFailed.length}</dd>
          </div>
          <div className={styles.stat}>
            <dt>保留窗口已清零</dt>
            <dd data-testid="stat-keep-cleared">{keepCleared}</dd>
          </div>
          <div className={styles.stat}>
            <dt>对外授权已撤下</dt>
            <dd data-testid="stat-grants-cleared">{grantsCleared}</dd>
          </div>
        </dl>
      )}

      {/* 仅供测试/调试确认当前系统状态，不承担产品文案职责 */}
      <p data-testid="current-system-state" hidden>
        {state}
      </p>
    </div>
  )
}
