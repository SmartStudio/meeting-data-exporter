import type { CSSProperties, KeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ChaptersView, ContentIndex } from '@/api/admin/content'
import { CUES_LIMIT, fetchChapters, fetchContentIndex, fetchMeetingGrantIds } from '@/api/admin/content'
import { useResource, type Resource } from '@/lib/useResource'
import { fmtDateTime, fmtDuration } from '@/lib/format'
import { PageShell } from '@/ui/PageShell'
import { Pill } from '@/ui/Pill'
import { Skeleton } from '@/ui/Skeleton'
import AssetPanel, { AskNote } from './AssetPanel'
import MinutesTab from './MinutesTab'
import Player from './Player'
import TimelineTab from './TimelineTab'
import TranscriptTab from './TranscriptTab'
import { Emphasis, initialPosition } from './text'
import styles from './Preview.module.css'

/**
 * 内容预览页（spec.md §4.4 · §2）。从会议记录页点标题进来，不占左栏导航（§3）。
 *
 * > 腾讯会议那张页面是给参会者读的；这一页是给管数据的人看的。左边一样，右边不一样。
 *
 * ## 这一页的三条硬约束
 *
 * 1. **章节这一轮拿不到**（T16）。时间轴 tab 的形态是「按转写时间戳切分」而不是
 *    「按章节」，界面上说清这一点——见 `TimelineTab` 的文件头。
 * 2. **管理员查看会议内容会留痕**（§2）。两条端点后端都在记，所以前端**不缓存
 *    内容**：省一次请求换来的是审计流里少一条记录，而被规则禁止采集的那些会议
 *    尤其要有这条记录。
 * 3. **右下角不是 AI 问答框**，是「这场会议的资产与去向」——见 `AssetPanel`。
 *
 * ## 首屏三条请求，各自失败各自说
 *
 * 索引（`/content`）、转写分段（`/content/chapters`）、已授权给谁
 * （`/meetings/:id` 的一列）三条并行，**互不拖垮**：分段取不到时页面照样能看纪要,
 * 那一块自己说"取失败了"；授权取不到时显示"取失败"，**不显示成"没有授权"**——
 * 后者是一个我们没有依据的结论。
 */
export default function PreviewPage() {
  const { id = '' } = useParams()

  const index = useResource(() => fetchContentIndex(id), [id])
  // 转写分段是**跨三个 tab**的：播放位置区的标记与字幕、时间轴、转写高亮都吃它。
  // 所以它属于页面，不属于某一个 tab；一次打开取一次。
  const chapters = useResource(() => fetchChapters(id, { limit: CUES_LIMIT }), [id])
  const grants = useResource(() => fetchMeetingGrantIds(id), [id])

  return (
    <PageShell
      title="内容预览"
      description="这场会议里到底讲了什么，以及它现在在哪、谁取得走。管理员查看会议内容会留痕（spec §2）。"
      actions={
        <Link to="/meetings" className={styles.back}>
          返回会议列表
        </Link>
      }
    >
      {index.state === 'loading' && (
        <div className={styles.skel} role="status" aria-label="正在读取这场会议的内容">
          <Skeleton width="38%" />
          <Skeleton width="60%" size="sm" />
          <Skeleton />
          <Skeleton width="82%" />
          <Skeleton width="70%" />
        </div>
      )}

      {index.state === 'error' && (
        <div className={styles.pageErr}>
          <p className={styles.errTitle}>这场会议的内容读不出来</p>
          <p className={styles.err}>{index.error.message}</p>
          <button type="button" className={styles.retry} onClick={index.retry}>
            重试
          </button>
        </div>
      )}

      {index.state === 'ready' && (
        <Body index={index.data} chapters={chapters} grants={grants} />
      )}
    </PageShell>
  )
}

/* ── 主体 ─────────────────────────────────────────────────────────── */

const TABS = [
  { id: 'minutes', name: '纪要' },
  { id: 'timeline', name: '时间轴' },
  { id: 'transcript', name: '转写文字' },
] as const

type TabId = (typeof TABS)[number]['id']

/** 走时的心跳。250 毫秒是原型的取值：再慢字幕就跟不上，再快只是白费渲染。 */
const TICK_MS = 250

interface BodyProps {
  index: ContentIndex
  chapters: Resource<ChaptersView> & { retry: () => void }
  grants: Resource<string[]> & { retry: () => void }
}

function Body({ index, chapters, grants }: BodyProps) {
  const { meeting, access } = index
  const [tab, setTab] = useState<TabId>('minutes')
  /** spec §4.4 写死的：打开时落在会议中段，不是 0:00 */
  const [position, setPosition] = useState(() => initialPosition(meeting.durationSec))
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [cc, setCc] = useState(true)
  const [split, setSplit] = useState(58)
  const tabsRef = useRef<HTMLDivElement>(null)

  const cues = chapters.state === 'ready' ? chapters.data : null
  const duration = Math.max(1, meeting.durationSec)

  // 走时。**不是播放**：控制台拿不到可播放的媒体源（见 Player 的文件头），
  // 走的是时间轴上的位置，三处联动挂在它上面。
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setPosition((p) => Math.min(duration, p + (TICK_MS / 1000) * rate))
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [playing, rate, duration])

  // 走到头就停。放在 effect 里而不是塞进上面那个 updater：在状态更新函数里改
  // 另一个状态是一次隐藏的副作用，React 严格模式下会跑两次。
  useEffect(() => {
    if (position >= duration && playing) setPlaying(false)
  }, [position, duration, playing])

  function seek(sec: number): void {
    setPosition(Math.max(0, Math.min(duration, Math.round(sec))))
  }

  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const at = TABS.findIndex((t) => t.id === tab)
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? TABS[(at + 1) % TABS.length]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? TABS[(at - 1 + TABS.length) % TABS.length]
          : e.key === 'Home'
            ? TABS[0]
            : e.key === 'End'
              ? TABS[TABS.length - 1]
              : undefined
    if (next === undefined) return
    e.preventDefault()
    setTab(next.id)
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus()
  }

  function onSplitKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (dir === 0) return
    e.preventDefault()
    setSplit((s) => Math.max(30, Math.min(80, s + dir * 2)))
  }

  const count =
    tab === 'timeline' || tab === 'transcript' ? (cues?.cues.length ?? null) : null

  return (
    <>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>{meeting.title}</h2>
          <p className={styles.meta}>
            {fmtDateTime(meeting.startAt)} · {meeting.code} · 时长 {fmtDuration(meeting.durationSec)} ·
            主持 {meeting.host}
          </p>
        </div>
        <Pill tone={access.allow === 'allow' ? 'brand' : 'warn'}>
          {access.allow === 'allow' ? '准许采集' : '规则禁止采集'}
        </Pill>
      </header>

      <p className={styles.audit}>
        本次查看已记进操作审计，动作 <code className={styles.mono}>{access.audit.action}</code>
        ——这是「管理员仍然能看」的对价，不是可选项（spec §2）。
      </p>

      {meeting.missing.length > 0 && (
        <p className={styles.warnLine}>
          这场会议的元数据缺了 {meeting.missing.join('、')}：上面对应位置的空白是「没拉回来」,
          不是「本来就是空的」。
        </p>
      )}

      {access.banner !== null && (
        <div role="note" className={styles.warn}>
          <Emphasis text={access.banner} />
        </div>
      )}

      <div className={styles.work} style={{ '--pv-split': `${split}%` } as CSSProperties}>
        <div className={styles.docCol}>
          <div ref={tabsRef} role="tablist" aria-label="内容视图" className={styles.tabs} onKeyDown={onTabKeyDown}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                data-tab={t.id}
                id={`pv-tab-${t.id}`}
                aria-selected={t.id === tab}
                aria-controls="pv-panel"
                tabIndex={t.id === tab ? 0 : -1}
                className={styles.tab}
                onClick={() => setTab(t.id)}
              >
                {t.name}
                {t.id === tab && count !== null && <span className={styles.tabNum}>{count}</span>}
              </button>
            ))}
          </div>

          <div id="pv-panel" role="tabpanel" aria-labelledby={`pv-tab-${tab}`} className={styles.panel}>
            {tab === 'minutes' && (
              <MinutesTab
                meetingId={meeting.id}
                assets={index.assets}
                archivedAt={index.local.archivedAt}
              />
            )}
            {tab === 'timeline' && (
              <TimelineTab
                data={cues}
                loading={chapters.state === 'loading'}
                error={chapters.state === 'error' ? chapters.error : null}
                position={position}
                onSeek={seek}
                onRetry={chapters.retry}
              />
            )}
            {tab === 'transcript' && (
              <TranscriptTab
                meetingId={meeting.id}
                cues={cues}
                cuesLoading={chapters.state === 'loading'}
                cuesError={chapters.state === 'error' ? chapters.error : null}
                position={position}
                onSeek={seek}
              />
            )}
          </div>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整左右宽度"
          aria-valuemin={30}
          aria-valuemax={80}
          aria-valuenow={split}
          tabIndex={0}
          className={styles.handle}
          onKeyDown={onSplitKeyDown}
        />

        <div className={styles.mediaCol}>
          <Player
            meeting={meeting}
            media={index.media}
            cues={cues?.cues ?? []}
            cuesLoading={chapters.state === 'loading'}
            cuesError={chapters.state === 'error' ? chapters.error : null}
            position={position}
            playing={playing}
            rate={rate}
            cc={cc}
            onSeek={seek}
            onTogglePlay={() => setPlaying((p) => !p)}
            onRate={setRate}
            onToggleCc={() => setCc((v) => !v)}
          />
          <AssetPanel index={index} grants={grants} onRetryGrants={grants.retry} />
          <AskNote />
        </div>
      </div>
    </>
  )
}
