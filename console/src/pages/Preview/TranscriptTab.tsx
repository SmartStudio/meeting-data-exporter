import { useRef, useState } from 'react'
import type { ChaptersView } from '@/api/admin/content'
import { TRANSCRIPT_ASSET_KEY, availabilityLabel, fetchContentSelection } from '@/api/admin/content'
import { useResource } from '@/lib/useResource'
import { fmtBytes, fmtClock } from '@/lib/format'
import { Input } from '@/ui/Input'
import { Skeleton } from '@/ui/Skeleton'
import { Highlight, currentCueIndex, useFollowCurrent } from './text'
import styles from './Preview.module.css'

/**
 * 转写文字 tab（spec §4.4「带搜索与命中高亮」）。
 *
 * ## 为什么这一个 tab 要两份数据
 *
 * - **分段**（`cues`，来自 chapters 那条端点）：带时间戳与发言人，是「点任意
 *   一段跳到对应位置」和「走时自动高亮跟随」这两处联动的载体。
 * - **原文**（`?type=transcript` 的 `segments[].content`）：**完整的转写正文**。
 *
 * 两者不能互相顶替：分段是解析出来的，解析会丢东西——SRT 的序号行、`bracket`
 * 格式里第一条时间戳之前的抬头，都不会进 `cues`；而且分段还受一次下发上限限制。
 * 只显示分段，少掉的那部分**用户不会知道自己少看了**。所以原文照样整份摆出来,
 * 一个字都不裁。
 *
 * 搜索只作用在分段上（那是可点的那一列），并且把「共几段」和「命中几段」一起
 * 报出来——只报命中数的话，被筛掉的那些看起来就像不存在。
 */

export interface TranscriptTabProps {
  meetingId: string
  cues: ChaptersView | null
  cuesLoading: boolean
  cuesError: Error | null
  position: number
  onSeek: (sec: number) => void
}

export function TranscriptTab({
  meetingId,
  cues,
  cuesLoading,
  cuesError,
  position,
  onSeek,
}: TranscriptTabProps) {
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLUListElement>(null)
  useFollowCurrent(listRef, position)
  const raw = useResource(
    () => fetchContentSelection(meetingId, { type: TRANSCRIPT_ASSET_KEY }),
    [meetingId],
  )

  const list = cues?.cues ?? []
  const q = query.trim()
  const hits = q === '' ? list : list.filter((c) => `${c.speaker ?? ''}${c.text}`.includes(q))
  const cur = currentCueIndex(list, position)

  return (
    <div className={styles.tabBody}>
      <div className={styles.toolbar}>
        <Input
          type="search"
          aria-label="在转写里搜"
          placeholder="在转写里搜"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.search}
        />
        <span className={styles.count}>
          共 {list.length} 段
          {q === '' ? '' : hits.length > 0 ? `，命中 ${hits.length} 段` : `，没有命中「${q}」`}
        </span>
        <span className={styles.spacer} />
        <span className={styles.hint}>点任意一段，把播放位置对到那一刻</span>
      </div>

      {cuesLoading && (
        <div className={styles.skel} role="status" aria-label="正在读取转写分段">
          <Skeleton width="70%" />
          <Skeleton />
        </div>
      )}
      {cuesError !== null && <p className={styles.err}>转写分段取失败：{cuesError.message}</p>}

      {!cuesLoading && cuesError === null && list.length === 0 && (
        <p className={styles.notice}>
          没有可点的分段（转写正文里认不出时间戳，或者这场会议还没有转写）。
          下面的原文仍然照常显示，理由见时间轴 tab。
        </p>
      )}

      {hits.length > 0 && (
        <ul ref={listRef} className={styles.turns} aria-label="转写分段">
          {hits.map((c) => {
            const i = list.indexOf(c)
            return (
              <li key={`${c.at}/${i}`}>
                <button
                  type="button"
                  className={styles.turn}
                  aria-current={i === cur ? 'true' : undefined}
                  onClick={() => onSeek(c.at)}
                >
                  <time className={styles.cueTime}>{fmtClock(c.at)}</time>
                  <span className={styles.cueWho}>
                    <Highlight text={c.speaker ?? '未认出发言人'} query={q} />
                  </span>
                  <span className={styles.cueText}>
                    <Highlight text={c.text} query={q} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <section className={styles.rawBox} aria-label="转写原文">
        <h4 className={styles.rawHead}>转写原文（完整，未裁剪）</h4>
        <p className={styles.hint}>
          上面那一列是按时间戳切出来的分段，可点可跳；这里是这份转写的原文本身——
          解析会丢掉没有时间戳的行，所以原文一个字都不裁地摆在这里。
        </p>

        {raw.state === 'loading' && (
          <div className={styles.skel} role="status" aria-label="正在读取转写原文">
            <Skeleton />
            <Skeleton width="90%" />
          </div>
        )}
        {raw.state === 'error' && <p className={styles.err}>取失败：{raw.error.message}</p>}
        {raw.state === 'ready' && raw.data.selected !== null && (
          <>
            <p className={styles.stateText}>{raw.data.selected.text}</p>
            {raw.data.selected.segments.map((seg) => (
              <article key={`${seg.remoteId}/${seg.fileType}/${seg.ordinal}`} className={styles.seg}>
                <header className={styles.segHead}>
                  <span className={styles.segOrd}>第 {seg.ordinal} 段</span>
                  <span className={styles.mono}>{seg.fileType}</span>
                  <span className={styles.mono}>{fmtBytes(seg.bytes)}</span>
                  <span className={styles.segState}>{availabilityLabel(seg.availability)}</span>
                </header>
                {seg.reason !== null && <p className={styles.reason}>{seg.reason}</p>}
                {seg.content !== null && <pre className={styles.doc}>{seg.content}</pre>}
              </article>
            ))}
          </>
        )}
      </section>
    </div>
  )
}

export default TranscriptTab
