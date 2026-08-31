import { useState } from 'react'
import type { ContentAsset, SelectedContent } from '@/api/admin/content'
import {
  FILE_TYPES,
  MINUTES_TEMPLATES,
  assetLabel,
  availabilityLabel,
  fetchContentSelection,
} from '@/api/admin/content'
import { useResource } from '@/lib/useResource'
import { fmtBytes, fmtDay } from '@/lib/format'
import { Skeleton } from '@/ui/Skeleton'
import RadioRow from './RadioRow'
import { Emphasis, pickDefaultTemplate, useHeightFloor } from './text'
import styles from './Preview.module.css'

/**
 * 纪要 tab（spec §4.4）。
 *
 * ## 模板切换不是装饰性下拉
 *
 * 「腾讯确实按不同模板生成多份纪要」——spec 逐字强调过这一句。所以这里的四个
 * 模板各自对应一个真实的 `asset_type`，换一个模板就是**换一条真实的请求**。
 *
 * 原型的第四项叫「待办清单」，而系统里没有任何一个资产类型装它，所以这里给的是
 * `ai_ds_minutes`（后端叫「会议摘要」）。与「章节没有来源就不编章节」同一条裁定。
 *
 * ## 每换一次就重取一次
 *
 * 不缓存上一次的结果（哪怕人在两个模板之间来回切）。后端每次调用都写一行审计,
 * 复用一次旧结果就少一条留痕——而留痕的价值恰恰在于完整（spec §2）。
 */

export interface MinutesTabProps {
  meetingId: string
  /** 索引里的资产，用来挑一个"真的有正文"的模板当默认值 */
  assets: readonly ContentAsset[]
  archivedAt: number | null
}

export function MinutesTab({ meetingId, assets, archivedAt }: MinutesTabProps) {
  const [tpl, setTpl] = useState(() => pickDefaultTemplate(assets))
  /** 空串 = 不筛格式。**不是** `?format=`——那是一次真实取值（"文件类型为空串"） */
  const [fmt, setFmt] = useState('')

  const res = useResource(
    () => fetchContentSelection(meetingId, { type: tpl, format: fmt === '' ? undefined : fmt }),
    [meetingId, tpl, fmt],
  )
  // 换模板 / 换格式时，正文槽的高度冻在上一次量到的高度上——理由（含实测数字）
  // 在 text.tsx 的 useHeightFloor 头上。工具条**不在槽里**：它高度恒定，
  // 把它一起冻住只会在它和正文之间多出一段说不清的空白。
  const floor = useHeightFloor(res.state === 'loading')

  return (
    <div className={styles.tabBody}>
      <div className={styles.toolbar}>
        <span className={styles.toolLabel}>模板</span>
        <RadioRow
          label="纪要模板"
          value={tpl}
          onChange={setTpl}
          options={MINUTES_TEMPLATES.map((t) => ({ value: t.key, label: t.label }))}
        />
        <span className={styles.spacer} />
        <span className={styles.toolLabel}>文件格式</span>
        <RadioRow
          label="文件格式"
          value={fmt}
          onChange={setFmt}
          options={[
            { value: '', label: '全部' },
            ...FILE_TYPES.map((f) => ({ value: f, label: f })),
          ]}
        />
      </div>

      <div ref={floor.ref} style={floor.style} className={styles.docSlot}>
        {res.state === 'loading' && (
          <div className={styles.skel} role="status" aria-label="正在读取这一类纪要">
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
  // 同样的一行字，于是一个「这场会议没有这一类纪要」的面板看起来像一篇很短的
  // 纪要。文案一个字都不改（它是「说得出为什么的空态」，见 text.ts 的
  // pickDefaultTemplate），改的是它长什么样。
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
