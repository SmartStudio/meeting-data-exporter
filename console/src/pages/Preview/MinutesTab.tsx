import type { RefObject } from 'react'
import type { SelectedContent } from '@/api/admin/content'
import { assetLabel, availabilityLabel, fetchContentSelection } from '@/api/admin/content'
import type { AssetKey } from '@/api/types'
import { useResource } from '@/lib/useResource'
import { fmtBytes, fmtDay } from '@/lib/format'
import { Skeleton } from '@/ui/Skeleton'
import { Emphasis, useHeightFloor } from './text'
import styles from './Preview.module.css'

/**
 * 纪要 tab。**只有一类**：`ai_minutes`，来自腾讯智能纪要接口的默认模板——腾讯录制页
 * 的「纪要文本」下载给的就是当前模板这一份，控制台与它对齐（spec 2.3，2026-09-08）。
 * 此前的四个模板对应的是 51180 接口的四个文件字段，那套分法已经删掉。
 *
 * 正文是 markdown 源文，用 <pre> 直出；富文本渲染不在本次范围。
 */

export interface MinutesTabProps {
  meetingId: string
  archivedAt: number | null
  /**
   * 正文槽上一次量到的高度。**由页面持有，不是本组件的 state**——切到别的 tab
   * 时本组件会被卸载，记在里面的高度跟着没了，切回来就又是那次 78px 的塌陷。
   * 理由与实测数字在 `text.tsx` 的 `useHeightFloor` 头上。
   */
  heightMemo: RefObject<number | null>
}

/** 纪要只有这一类。腾讯录制页「纪要文本」下载给的就是它。 */
const MINUTES_ASSET_KEY: AssetKey = 'ai_minutes'

export function MinutesTab({ meetingId, archivedAt, heightMemo }: MinutesTabProps) {
  const res = useResource(
    () => fetchContentSelection(meetingId, { type: MINUTES_ASSET_KEY }),
    [meetingId],
  )
  // 重取时正文槽的高度冻在上一次量到的高度上——理由（含实测数字）
  // 在 text.tsx 的 useHeightFloor 头上。
  const floor = useHeightFloor(res.state === 'loading', heightMemo)

  return (
    <div className={styles.tabBody}>
      <div ref={floor.ref} style={floor.style} className={styles.docSlot}>
        {res.state === 'loading' && (
          <div className={styles.skel} role="status" aria-label="正在读取纪要">
            <Skeleton width="40%" />
            <Skeleton />
            <Skeleton width="88%" />
            <Skeleton width="72%" />
          </div>
        )}

        {res.state === 'error' && <p className={styles.err}>取失败：{res.error.message}</p>}

        {res.state === 'ready' && res.data.selected === null && (
          <p className={styles.err}>
            后端没有返回 selected —— 这次请求带了 type，响应里却没有对应的正文块。
          </p>
        )}

        {res.state === 'ready' && res.data.selected !== null && (
          <SelectedBody selected={res.data.selected} archivedAt={archivedAt} />
        )}
      </div>
    </div>
  )
}

function SelectedBody({
  selected,
  archivedAt,
}: {
  selected: SelectedContent
  archivedAt: number | null
}) {
  // 一段正文都没有时，后端那句话是**空态**，不是正文。上一版把它排成和正文
  // 同样的一行字，于是一个「这场会议没有纪要」的面板看起来像一篇很短的纪要。
  // 文案一个字都不改（它是「说得出为什么的空态」），改的是它长什么样。
  const empty = selected.segments.length === 0

  return (
    <>
      {empty ? (
        <div className={styles.emptyDoc}>
          <p className={styles.emptyDocText} data-state={selected.state}>
            <Emphasis text={selected.text} />
          </p>
        </div>
      ) : (
        <p className={styles.stateText} data-state={selected.state}>
          <Emphasis text={selected.text} />
        </p>
      )}

      {selected.segments.map((seg) => (
        <article key={`${seg.remoteId}/${seg.fileType}/${seg.ordinal}`} className={styles.seg}>
          <header className={styles.segHead}>
            <span className={styles.segOrd}>第 {seg.ordinal} 段</span>
            <span className={styles.mono}>{seg.fileType}</span>
            <span className={styles.mono}>{fmtBytes(seg.bytes)}</span>
            {seg.chars !== null && <span className={styles.mono}>{seg.chars} 字</span>}
            <span className={styles.segState}>{availabilityLabel(seg.availability)}</span>
          </header>
          {seg.reason !== null && (
            <p className={styles.reason}>
              <Emphasis text={seg.reason} />
            </p>
          )}
          {seg.content !== null && <pre className={styles.doc}>{seg.content}</pre>}
          {seg.nasPath !== null && <code className={styles.path}>{seg.nasPath}</code>}
        </article>
      ))}

      <p className={styles.foot}>
        由腾讯会议生成 · {assetLabel(selected.assetKey, selected.type)} ·{' '}
        {archivedAt === null ? '尚未归档到 NAS' : `归档于 ${fmtDay(archivedAt)}`}
      </p>
    </>
  )
}

export default MinutesTab
