import { useRef } from 'react'
import type { ChaptersView } from '@/api/admin/content'
import { assetLabel } from '@/api/admin/content'
import { fmtClock } from '@/lib/format'
import { Skeleton } from '@/ui/Skeleton'
import { Emphasis, currentCueIndex, useFollowCurrent } from './text'
import styles from './Preview.module.css'

/**
 * 时间轴 tab：上半是腾讯智能录制的**章节**（`data.chapters`，2026-09-08 起有真来源：
 * chapters.json），下半是按逐字稿时间戳切出的**转写分段**（`data.cues`）。
 * 两者都能点击跳转。没开智能录制的会议章节为空，`data.text` 说明原因，
 * 转写分段照常显示——不拿分段冒充章节。
 */

export interface TimelineTabProps {
  data: ChaptersView | null
  loading: boolean
  error: Error | null
  position: number
  onSeek: (sec: number) => void
  onRetry: () => void
}

/**
 * 后端认出的转写时间戳格式。**不落回原值**：`speaker` / `bracket` 这种枚举名混在
 * 一句中文里，读的人只会以为界面出了错。认不出的格式（后端将来新增的）仍然落回
 * 原值——那时屏幕上出现一个陌生的英文词，正是「这里该加一条」的信号。
 */
const FORMAT_LABEL: Record<string, string> = {
  srt: '认出的是字幕格式（带起止时刻）',
  bracket: '认出的是行首时间戳',
  speaker: '认出的是「发言人(时间戳)」',
}

function formatLabel(format: string): string {
  return FORMAT_LABEL[format] ?? `认出的格式是 ${format}`
}

export function TimelineTab({ data, loading, error, position, onSeek, onRetry }: TimelineTabProps) {
  // hooks 必须在任何提前 return 之前调用完
  const listRef = useRef<HTMLUListElement>(null)
  useFollowCurrent(listRef, position)

  if (loading) {
    return (
      <div className={styles.skel} role="status" aria-label="正在读取转写分段">
        <Skeleton width="60%" />
        <Skeleton />
        <Skeleton width="80%" />
      </div>
    )
  }

  if (error !== null) {
    return (
      <div className={styles.tabBody}>
        <p className={styles.err}>转写分段取失败：{error.message}</p>
        <button type="button" className={styles.retry} onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }

  if (data === null) return null

  const cur = currentCueIndex(data.cues, position)
  const from = data.cuesFrom

  /**
   * 「分段来自 …」这一句说的是**转写分段**从哪份正文切出来的。
   *
   * 它以前挂在章节列表下面，于是被读成章节的出处——章节来自腾讯的智能录制，与这份
   * 转写不是一回事，两者连录制文件都未必是同一段。所以它现在只出现在两个地方，
   * 两处互斥：切得出分段时紧贴「转写分段」这个标题，切不出时在那个空态框里。
   */
  const provenance =
    from === null ? null : (
      <p className={styles.hint}>
        分段来自 {assetLabel(from.assetKey, from.assetType)} · {from.fileType} ·
        {from.format === 'none' ? ' 认不出时间戳格式' : ` ${formatLabel(from.format)}`} ·
        共 {from.total} 段
      </p>
    )

  return (
    <div className={styles.tabBody}>
      <p className={styles.backendText}>
        <Emphasis text={data.text} />
      </p>

      {data.chapters.length > 0 && (
        <section aria-label="章节">
          <h3 className={styles.sectionTitle}>章节</h3>
          <ul className={styles.cueList}>
            {data.chapters.map((c) => (
              <li key={c.id}>
                <button type="button" className={styles.cue} onClick={() => onSeek(c.at)}>
                  <time className={styles.cueTime}>{fmtClock(c.at)}</time>
                  <span className={styles.cueText}>{c.name === '' ? '（未命名章节）' : c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.cues.length === 0 && (
        <div className={styles.emptyBox}>
          <p className={styles.emptyTitle}>
            {from === null
              ? '这场会议没有可解析的转写正文，所以一段都切不出来。'
              : '认不出这份转写的时间戳格式，所以切不出分段。'}
          </p>
          {provenance}
          {data.sample !== null && data.sample.length > 0 && (
            <>
              <p className={styles.hint}>后端把正文的前几行原样带回来了，好当场看出是什么格式：</p>
              <ul className={styles.sample}>
                {data.sample.map((line, i) => (
                  <li key={i}>
                    <code className={styles.mono}>{line}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {data.cues.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>转写分段</h3>

          {provenance}

          {from !== null && from.truncated && (
            <p className={styles.warnLine}>
              这一份转写共 {from.total} 段，本次只显示了前 {from.returned} 段（受一次
              下发上限限制）。后半截不是没有，是这一次没取回来。
            </p>
          )}

          <ul ref={listRef} className={styles.cueList} aria-label="转写分段（按逐字稿时间戳切分）">
            {data.cues.map((c, i) => (
              <li key={`${c.at}/${i}`}>
                <button
                  type="button"
                  className={styles.cue}
                  aria-current={i === cur ? 'true' : undefined}
                  onClick={() => onSeek(c.at)}
                >
                  <time className={styles.cueTime}>{fmtClock(c.at)}</time>
                  <span className={styles.cueWho}>{c.speaker ?? '未认出发言人'}</span>
                  <span className={styles.cueText}>{c.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default TimelineTab
