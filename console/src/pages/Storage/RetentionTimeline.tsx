import { listMeetings } from '@/api/admin/meetings'
import type { AdminMeeting } from '@/api/admin/meetings'
import { useResource } from '@/lib/useResource'
import { daysLeft } from '@/lib/format'
import styles from './Storage.module.css'

/**
 * 「本地保留窗口」时间轴（D-jobs-storage brief）。
 *
 * 这一页下半屏原来是空的。空出来的地方拿来回答「7 天内到期」这个数字
 * 第一次没答过的问题：**是哪一场、还剩几天、离清理线多远**。
 *
 * ## 数据从哪来——不加新端点
 *
 * `listMeetings({ inRetention: true })` 是既有端点；`AdminMeeting.keep.expiresAt`
 * 是后端算好下发的到期时刻。**排序是呈现，不是判定**：这里只按 `expiresAt`
 * 把行排个先后，不重新计算任何"这场会议还会不会被清理"的结论——那件事
 * 完全是后端的活（`filesGone` / 到期清理任务自己的判据），前端不复算一遍。
 *
 * `expiresAt` 为 `null`（保留窗口还没起算，即还没归档成功）的会议**不进时间
 * 轴**：一条不知道终点在哪的时间轴上的点，画出来就是编的。
 */
const FETCH_LIMIT = 60
const WINDOW_DAYS = 30
/** 视觉上标成「快到期」的门槛。跟这一页「7 天内到期」那一格用的是同一个
 *  7 天，两处对得上；这里只是选一个颜色，不是又一次判定"会不会被清理"。 */
const WARN_WITHIN_DAYS = 7

export interface TimelineRow {
  id: string
  title: string
  daysLeft: number
  /** 0–100，按 `daysLeft / WINDOW_DAYS` 换算并夹到区间内。超过 30 天的
   *  会议（自定义保留期更长）夹在最右端——真实天数仍然显示在 `daysLeft` 上，
   *  只有这个位置饱和，不是把数字本身也夹没了。 */
  pct: number
  warn: boolean
}

/**
 * 会议列表 → 时间轴的行。纯函数，方便直接单测（见
 * `tests/pages/Storage.test.tsx`）。**按 `expiresAt` 升序**——最快到期的排
 * 最前面，这是这一屏最想让人先看到的顺序。
 */
export function buildTimelineRows(
  meetings: readonly Pick<AdminMeeting, 'id' | 'title' | 'keep'>[],
  now: Date = new Date(),
): TimelineRow[] {
  return meetings
    .filter((m) => m.keep.expiresAt !== null)
    .map((m) => {
      const dl = daysLeft(m.keep.expiresAt as number, now)
      return {
        id: m.id,
        title: m.title,
        daysLeft: dl,
        pct: Math.max(0, Math.min(100, (dl / WINDOW_DAYS) * 100)),
        warn: dl <= WARN_WITHIN_DAYS,
      }
    })
    .sort((a, b) => a.daysLeft - b.daysLeft)
}

export function RetentionTimeline() {
  const res = useResource(() => listMeetings({ inRetention: true, limit: FETCH_LIMIT }), [])

  return (
    <div className={styles.tl} data-testid="retention-timeline">
      <div className={styles.tlHead}>
        <h3 className={styles.tlTitle}>保留窗口时间轴</h3>
        <span className={styles.tlHeadNote}>0–30 天，按剩余天数排序</span>
      </div>

      {res.state === 'loading' && (
        <p className={styles.tlStatus} data-testid="retention-timeline-loading">
          正在读取保留期内的会议……
        </p>
      )}

      {res.state === 'error' && (
        <p className={styles.tlStatus} data-testid="retention-timeline-error">
          时间轴暂时读不到（{res.error.message}），上面的统计数字不受影响。
        </p>
      )}

      {res.state === 'ready' && <TimelineBody rows={buildTimelineRows(res.data.rows)} />}
    </div>
  )
}

function TimelineBody({ rows }: { rows: TimelineRow[] }) {
  if (rows.length === 0) {
    return (
      <p className={styles.tlStatus} data-testid="retention-timeline-empty">
        保留窗口内没有能定位到期日的会议。
      </p>
    )
  }

  return (
    <>
      <ul className={styles.tlList}>
        {rows.map((row) => (
          <li key={row.id} className={styles.tlRow} data-testid="retention-timeline-row" data-warn={row.warn}>
            <span className={styles.tlName}>{row.title}</span>
            <span className={styles.tlTrack}>
              <span className={styles.tlPip} data-warn={row.warn} style={{ left: `${row.pct}%` }} />
            </span>
            <span className={styles.tlRem} data-warn={row.warn}>
              {row.daysLeft} 天
            </span>
          </li>
        ))}
      </ul>
      {/* 刻度两套：宽屏 10 / 20，窄屏只留 15。390 下这条轨道量出来只有 100px，
          而四个刻度的宽度之和恰好也是 100px——挤到一点空隙都不剩，于是每个
          标签都在词中间断行，屏幕上读成「今 10 20 30」「天 天 天 天」两行汉字
          方阵。两套都渲染出来、由 CSS 媒体查询挑一套（见 Storage.module.css
          末尾的 56em 块），不去 JS 里读视口宽：那要么首帧读不到，要么得挂一个
          resize 监听，而这件事只是选几个标签。整条轴本来就 aria-hidden，
          多出来的那个 span 不进无障碍树，读屏不会听到两遍。 */}
      <div className={styles.tlAxis} aria-hidden="true">
        <span />
        <span className={styles.tlAxisTrack}>
          <span>今天</span>
          <span className={styles.tlTickWide}>10 天</span>
          <span className={styles.tlTickNarrow}>15 天</span>
          <span className={styles.tlTickWide}>20 天</span>
          <span>30 天</span>
        </span>
        <span />
      </div>
    </>
  )
}

export default RetentionTimeline
