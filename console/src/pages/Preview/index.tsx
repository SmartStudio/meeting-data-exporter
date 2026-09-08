import type { CSSProperties, KeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ChaptersView, ContentIndex } from '@/api/admin/content'
import {
  CUES_LIMIT,
  fetchChapters,
  fetchContentIndex,
  fetchMeetingGrantIds,
  mediaUrl,
  pickPlayableMedia,
} from '@/api/admin/content'
import { useResource, type Resource } from '@/lib/useResource'
import { fmtDateTime, fmtDuration } from '@/lib/format'
import { hostLabel, hostView } from '@/lib/host'
import { PageShell } from '@/ui/PageShell'
import { Pill } from '@/ui/Pill'
import { Skeleton } from '@/ui/Skeleton'
import AssetPanel from './AssetPanel'
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
 * ## 同一件事只说一遍
 *
 * 「本次查看已记进操作审计」曾经在同一屏出现三次：`PageShell` 的 `description`、
 * 抬头下面一整段散文、以及后端下发的琥珀 banner。留痕是硬约束，说三遍不会让它
 * 更硬——只会让人一条都不读。现在页名由顶栏按路由渲染，抬头右侧只挂一个
 * 「已记审计」标记（记的是哪个动作走 `title`），后端那条 banner 一个字不改。
 *
 * ## 走时条在左栏，不在右栏
 *
 * 三处联动（点时间轴跳转、点转写跳转、走时高亮跟随）读的和改的都是左栏那份正文，
 * 而控制它的那条曾经在右栏、半屏之外。现在它 sticky 在 tab 与正文之间——
 * 转写工具（Descript / otter.ai）都是这个形态，理由就是这个。
 * 右栏因此只剩「这场会议的资产与去向」，录像的去向（`media`）并进那张清单，
 * 分栏默认值从 58% 改成 64%。
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
    /* 返回链接**不走 `PageShell` 的 `actions`**。这一页自己就有一条抬头
       （下面 `Body` 里的 `.head`：会议标题 + 时间/会议号/主持人 + 判定标记），
       页头再来一条，就是两条抬头上下摞着——而上面那条里只有一个右对齐的链接，
       左边九成宽是空的（1440 实测：顶栏底下 70px，其中 34px 归这个空壳）。
       它现在是内容区的第一行，左对齐，跟内容一条边——返回链接本来就该在那里。
       放在三个状态分支**之前**而不是里面：读不出来（error）时最想做的事就是
       回列表，而那时 `Body` 整个不渲染。 */
    <PageShell title="内容预览">
      <p className={styles.backLine}>
        <Link to="/meetings" className={styles.back}>
          返回会议列表
        </Link>
      </p>

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
  /** 左栏占比。右栏删掉舞台与那两段说明之后只剩资产面板，不需要 42% */
  const [split, setSplit] = useState(64)
  const tabsRef = useRef<HTMLDivElement>(null)
  /**
   * 纪要正文槽上一次量到的高度。**记在这里，不在 `MinutesTab` 里**：切到时间轴
   * 再切回来，那个组件是重新挂载的，组件内的记忆早没了——而那正是「点纪要页面塌
   * 一下又弹回来」的最后一段。`Body` 跨 tab 切换活着，换会议时才随 `index` 一起
   * 卸掉，所以也不会拿上一场会议的高度来冻这一场。
   */
  const minutesH = useRef<number | null>(null)

  const cues = chapters.state === 'ready' ? chapters.data : null
  const duration = Math.max(1, meeting.durationSec)

  /**
   * 能播的那一份（2026-08-30 起）。挑法与「为什么必须已归档」见
   * `api/admin/content.ts` 的 `pickPlayableMedia`。
   */
  const playable = pickPlayableMedia(index.media.assets)
  const src = playable === null ? null : mediaUrl(meeting.id, playable)

  // 走时。**只在没有可播放源时才走**：有视频的时候位置的来源是视频自己的
  // `timeupdate`，两个时钟同时推同一个位置会互相打架——定时器把位置推快半拍,
  // 视频再把它拽回来，画面和字幕就一直在抖。
  useEffect(() => {
    if (!playing || src !== null) return
    const timer = setInterval(() => {
      setPosition((p) => Math.min(duration, p + (TICK_MS / 1000) * rate))
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [playing, rate, duration, src])

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
            {/* 主持人这一段曾经是 `主持 {meeting.host}`——一串 32 位 userid 原样上屏。
                判定与全部推理在 lib/host.ts；抬头不分两段排版，用 hostLabel。
                `{' '}` 是必须的：JSX 把标签之间的换行连同缩进一起吃掉，
                少了它渲染出来是「时长 0:53 ·主持」。 */}
            {fmtDateTime(meeting.startAt)} · {meeting.code} · 时长 {fmtDuration(meeting.durationSec)} ·{' '}
            主持 <span title={hostView(meeting).title ?? undefined}>{hostLabel(meeting)}</span>
          </p>
        </div>
        {/* 抬头右侧是一组**标记**，不是说明文字。
            「本次查看已记进操作审计」上一版在同一屏说了三遍：PageShell 的
            description、这里的一段散文、以及后端下发的琥珀 banner。留痕是
            spec §2 的硬约束，它必须仍然读得到——但它是一条事实，一个标记就够。
            具体记的是哪个动作（view_content / view_restricted_content）是机器名,
            走 title，与主持人那串 userid 同一个处置（见 lib/host.ts）。
            这个标记在准许与禁止两种判定下都在：只在受限时才挂，等于把
            「没被禁的这次查看没留痕」暗示出去，而那不是真的。 */}
        <div className={styles.marks}>
          <Pill tone={access.allow === 'allow' ? 'brand' : 'warn'}>
            {access.allow === 'allow' ? '准许采集' : '规则禁止采集'}
          </Pill>
          <span className={styles.auditMark} title={`动作 ${access.audit.action}`}>
            已记审计
          </span>
        </div>
      </header>

      {meeting.missing.length > 0 && (
        <p className={styles.warnLine}>
          元数据缺了 {meeting.missing.join('、')}——对应位置的空白是「没拉回来」，不是「本来就是空的」。
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

          {/* 走时条在 tab 与正文**之间**，并且是 sticky 的。
              它不属于右栏：三处联动（点时间轴跳转、点转写跳转、走时高亮跟随）
              读的和改的都是左栏这份正文，控制它的那条却在半屏之外，眼睛得来回
              横跳。转写工具（Descript / otter.ai）一律把它压在正文顶上，
              理由就是这个。 */}
          <Player
            meeting={meeting}
            src={src}
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

          <div id="pv-panel" role="tabpanel" aria-labelledby={`pv-tab-${tab}`} className={styles.panel}>
            {tab === 'minutes' && (
              <MinutesTab
                meetingId={meeting.id}
                archivedAt={index.local.archivedAt}
                heightMemo={minutesH}
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
          <AssetPanel index={index} grants={grants} onRetryGrants={grants.retry} />
        </div>
      </div>
    </>
  )
}
