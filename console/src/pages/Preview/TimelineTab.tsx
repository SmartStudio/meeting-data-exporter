import { useRef } from 'react'
import type { ChaptersView } from '@/api/admin/content'
import { assetLabel } from '@/api/admin/content'
import { fmtClock } from '@/lib/format'
import { Skeleton } from '@/ui/Skeleton'
import { Emphasis, currentCueIndex, useFollowCurrent } from './text'
import styles from './Preview.module.css'

/**
 * 时间轴 tab。
 *
 * ## 这一页最容易做错的一件事就在这里
 *
 * spec §4.4 写的是「章节 + 摘要，点击跳转」。而阶段 4 · T16 的裁定是：
 * `GET .../content/chapters` 的 `chapters` **恒为空数组**、`source: 'none'`——
 * 本系统一次都没拉取过腾讯的章节数据，`src/tencent/records.ts` 里没有任何一个
 * 取章节的调用点，库里也没有任何一列装它。
 *
 * 响应里真正有内容的是 `cues`：**转写分段**，时间戳来自转写正文本身的解析。
 * 拿它当章节渲染（给每段编个号、配上"摘要"）就是**给一个我们没有的数据源伪造
 * 一次输出**——用户会以为这场会议真的有章节结构，而那是解析出来的分句。
 *
 * 所以这里：
 * - 列表的名字叫「转写分段」，不叫章节；
 * - 顶部说清本系统没有章节来源，并把后端那段解释原样摆出来；
 * - 交代分段是从哪一份转写、认出的哪种格式解析来的；
 * - **被 limit 截断时明说**——后半截在时间轴上凭空消失、界面上一切正常，
 *   是这一页最糟的一种静默。
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

  return (
    <div className={styles.tabBody}>
      <p className={styles.notice}>
        本系统<b>没有「章节」这一类数据</b>：一次都没有从腾讯会议拉取过它，库里也没有
        任何一列装它。所以下面这一列是<b>按转写时间戳切分</b>的转写分段，不是章节——
        它们的时间是真的，点一下就能把位置对过去。
      </p>
      <p className={styles.backendText}>
        <Emphasis text={data.text} />
      </p>

      {from !== null && (
        <p className={styles.hint}>
          分段来自 {assetLabel(from.assetKey, from.assetType)} · {from.fileType} ·
          {from.format === 'none' ? ' 认不出时间戳格式' : ` ${formatLabel(from.format)}`} ·
          共 {from.total} 段
        </p>
      )}

      {from !== null && from.truncated && (
        <p className={styles.warnLine}>
          这一份转写共 {from.total} 段，本次只显示了前 {from.returned} 段（受一次
          下发上限限制）。后半截不是没有，是这一次没取回来。
        </p>
      )}

      {data.cues.length === 0 && (
        <div className={styles.emptyBox}>
          <p className={styles.emptyTitle}>
            {from === null
              ? '这场会议没有可解析的转写正文，所以一段都切不出来。'
              : '认不出这份转写的时间戳格式，所以切不出分段。'}
          </p>
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
        <ul ref={listRef} className={styles.cueList} aria-label="转写分段（按转写时间戳切分，不是章节）">
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
      )}
    </div>
  )
}

export default TimelineTab
