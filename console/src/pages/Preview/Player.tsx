import type { KeyboardEvent, MouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ContentMeeting, TranscriptCue } from '@/api/admin/content'
import { fmtClock } from '@/lib/format'
import { currentCueIndex } from './text'
import styles from './Player.module.css'

/**
 * 贯穿三个 tab 的联动区（spec §4.4 的「播放器」）——一条**走时条**。
 *
 * ## 它现在真的会播（2026-08-30）
 *
 * 此前这里**只有一条走时游标、没有画面**：`media.proxied` 恒为 false，而唯一能
 * 签直链的 `POST /api/v1/assets/:assetId/download-url` 走采集程序的 JWT,
 * 管理员会话签不出来。用户报「画面看不到、声音听不到」之后翻了这条案——
 * 新开的 `GET .../media/:assetType/:remoteId/:fileType` 读的是**已经归档在 NAS 上
 * 的那份文件**，不是从腾讯 CDN 转发（两件事的区别见后端 `console/media.ts` 文件头）。
 *
 * ## 为什么不用原生 `<video controls>`
 *
 * 原生控件放不下**转写分段标记**——进度条上那些竖线是这一页的重点之一，它让人
 * 一眼看出「这场会议在哪几个时刻有人说话」。所以 `<video>` 不带 `controls`,
 * 由下面这条既有的走时条驱动它：播放/暂停、拖动、倍速、字幕全部沿用，
 * 只是位置的**来源**从一个 `setInterval` 换成了视频自己的 `timeupdate`。
 *
 * 拿不到可播放源时（没归档、或格式认不出）**回到原来那条走时条**，一个画面都不画:
 * 摆一个点了没反应的播放器，比老实说「这一类在控制台里放不了」更糟。
 *
 * 画中画与全屏**仍然没有做**：留到有人真的要的时候再说，现在加等于凭空多两个
 * 要维护的状态。
 *
 * ## 为什么从「舞台」收成一条横条
 *
 * 上一版把这块画成了一个 16:9 的深色舞台，里面装的却全是文字（录像的去向、
 * 一段说明、一个「当前发言人」浮标）。一块占了 300px 高的假画面，摆的是三行
 * 本来就该在资产清单里的信息，而**真正每一秒都在变的那一条进度**被挤在底下。
 *
 * 所以这一版：
 *
 * - `media.assets` / `media.text`（录像的去向）交给 `AssetPanel`——那一块的题目
 *   本来就是「这场会议的资产与**去向**」，录像是它的一行，不是另一块面板；
 * - 剩下的收成一条 transport bar，**搬到左栏正文上方并 sticky**：转写工具
 *   （Descript / otter.ai）都是这个形态，因为三处联动全靠走时条一直在视野里；
 * - 底色改回常规令牌。`--video-*` 那一组是「内容本身的底」（刻意不跟随主题），
 *   而这条已经不是内容的底了，它是界面的一条控件带。
 *
 * ## 进度条上的标记是转写分段，不是章节
 *
 * 原型那句注释写的是「章节标记」。本系统没有章节数据（T16 裁定），所以这里的
 * 标记来自转写时间戳，`aria-label` 与轨道的 `title` 都照这个说。
 */

/** 方向键一次走多少秒。与原型一致。 */
const STEP_SEC = 15
/** PageUp / PageDown 的粗调 */
const PAGE_SEC = 60

/** 竖线是什么。上一版这句话是条下面的一段散文，而它只在人盯着竖线时才有用。 */
const TRACK_HINT = '竖线是转写分段的起点，不是章节——本系统没有章节数据的来源'

export const RATES: readonly number[] = [0.5, 1, 1.25, 1.5, 2]

export interface PlayerProps {
  meeting: ContentMeeting
  /**
   * 可播放的媒体地址。`null` = 这场会议没有能在浏览器里放的东西（没归档、或格式
   * 认不出），此时整块退回成一条纯走时条。
   */
  src: string | null
  cues: readonly TranscriptCue[]
  /** 转写分段那一条请求的状态。取失败要说出来，不能显示成"这场会议没有转写" */
  cuesError: Error | null
  cuesLoading: boolean
  position: number
  playing: boolean
  rate: number
  cc: boolean
  onSeek: (sec: number) => void
  onTogglePlay: () => void
  onRate: (rate: number) => void
  onToggleCc: () => void
}

/**
 * 位置回灌的死区。`timeupdate` 每秒来三四次，每次都把 `currentTime` 写回去会和
 * 视频自己的走时打架（写回 → 触发 seeking → 再来一次 timeupdate），画面一顿一顿。
 * 只有当外面的 `position` 与视频真实位置差出一秒以上时才认为「这是一次真的跳转」。
 */
const SEEK_EPSILON_SEC = 1

export function Player(props: PlayerProps) {
  const { meeting, src, cues, position, playing, rate, cc } = props
  const duration = Math.max(1, meeting.durationSec)
  const trackRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  /** 媒体自己报的错（404 / 编码放不动）。不吞掉——吞掉就是一块永远黑着的画面 */
  const [mediaErr, setMediaErr] = useState(false)
  const cur = currentCueIndex(cues, position)
  const current = cur < 0 ? null : cues[cur]!

  const clamp = (sec: number): number => Math.max(0, Math.min(duration, Math.round(sec)))

  // 播放/暂停：状态在外面（三个 tab 共用），元素在这里。`play()` 返回 Promise,
  // 被浏览器的自动播放策略拒绝时会 reject——那时把状态推回「暂停」，
  // 而不是让按钮显示成正在播、画面却不动。
  useEffect(() => {
    const el = videoRef.current
    if (el === null) return
    if (playing) void el.play().catch(() => props.onTogglePlay())
    else el.pause()
  }, [playing])

  // 外面改了位置（点时间轴 / 点转写 / 键盘）→ 视频跟过去。带死区，见上面。
  useEffect(() => {
    const el = videoRef.current
    if (el === null) return
    if (Math.abs(el.currentTime - position) > SEEK_EPSILON_SEC) el.currentTime = position
  }, [position])

  useEffect(() => {
    const el = videoRef.current
    if (el !== null) el.playbackRate = rate
  }, [rate])

  // 换了一场会议 / 换了源，错误状态要跟着清掉，否则上一场的黑屏会留在这一场
  useEffect(() => setMediaErr(false), [src])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const map: Record<string, number> = {
      ArrowRight: position + STEP_SEC,
      ArrowUp: position + STEP_SEC,
      ArrowLeft: position - STEP_SEC,
      ArrowDown: position - STEP_SEC,
      PageUp: position + PAGE_SEC,
      PageDown: position - PAGE_SEC,
      Home: 0,
      End: duration,
    }
    const next = map[e.key]
    if (next === undefined) return
    e.preventDefault()
    props.onSeek(clamp(next))
  }

  function onTrackClick(e: MouseEvent<HTMLDivElement>): void {
    const box = trackRef.current?.getBoundingClientRect()
    // jsdom 里宽度恒为 0；真实浏览器里也可能在布局完成前被点到。
    // 除以 0 会得到 NaN，然后 aria-valuenow 变成 "NaN" —— 宁可这一次点击不生效。
    if (box === undefined || box.width === 0) return
    props.onSeek(clamp(((e.clientX - box.left) / box.width) * duration))
  }

  const pct = `${((position / duration) * 100).toFixed(2)}%`

  return (
    <section className={styles.player} aria-label="播放位置与联动">
      {src !== null && !mediaErr && (
        <video
          ref={videoRef}
          className={styles.video}
          src={src}
          // 不给 controls：原生控件放不下进度条上的转写分段标记，见文件头
          playsInline
          preload="metadata"
          aria-label={`${meeting.title} 的录像`}
          // 视频是位置的**来源**，不是它的镜子——所以这里回灌，上面那个 effect 带死区
          onTimeUpdate={(e) => props.onSeek(e.currentTarget.currentTime)}
          onEnded={() => playing && props.onTogglePlay()}
          onError={() => setMediaErr(true)}
        />
      )}

      {src !== null && mediaErr && (
        <p className={styles.mediaErr}>
          录像取不回来。文件已经归档到 NAS，但这次读不到它——可能是 NAS 没挂上，
          也可能是那份副本被删了。去向仍然在右边的资产清单里。
        </p>
      )}

      {/* 只有这条控制带 sticky，视频**不**跟着钉住：一块 400 多像素高的画面钉在
          视口顶上，正文就没地方看了。三处联动靠的是位置，位置在这条带上。 */}
      <div className={styles.strip}>
      <div className={styles.ctl}>
        <div
          ref={trackRef}
          className={styles.track}
          role="slider"
          tabIndex={0}
          aria-label="播放位置"
          title={TRACK_HINT}
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`${fmtClock(position)} / ${fmtClock(duration)}`}
          onKeyDown={onKeyDown}
          onClick={onTrackClick}
        >
          <i className={styles.fill} style={{ width: pct }} />
          <b className={styles.knob} style={{ left: pct }} />
          {cues.map((c) => (
            <i
              key={c.at}
              className={styles.mark}
              style={{ left: `${((c.at / duration) * 100).toFixed(2)}%` }}
              aria-hidden="true"
            />
          ))}
        </div>

        <button
          type="button"
          className={`${styles.btn} ${styles.play}`}
          aria-label={src === null ? (playing ? '暂停走时' : '开始走时') : playing ? '暂停' : '播放'}
          onClick={props.onTogglePlay}
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6.5" y="5" width="4" height="14" rx="1" />
              <rect x="13.5" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5.5 19 12 8 18.5V5.5Z" />
            </svg>
          )}
        </button>

        <span className={styles.time}>
          {fmtClock(position)} / {fmtClock(duration)}
        </span>

        <span className={styles.spacer} />

        <button
          type="button"
          className={styles.btn}
          aria-pressed={cc}
          aria-label="字幕"
          onClick={props.onToggleCc}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="5.5" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M9.5 10.5a2.5 2.5 0 1 0 0 3M16.5 10.5a2.5 2.5 0 1 0 0 3"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <select
          className={styles.rate}
          aria-label={src === null ? '走时倍速' : '倍速'}
          value={rate}
          onChange={(e) => props.onRate(Number(e.target.value))}
        >
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
      </div>

      {/* 条下面一行：此刻走到哪、谁在说、说的是什么。
          上一版这是舞台右上角的一个浮标 + 一条居中字幕带，浮标压着标题，靠
          `.stageTitle { padding-right: 30% }` 躲开——那是补丁不是布局。
          三样东西本来就是同一句话，排成一行就不用互相躲。 */}
      <p className={styles.now}>
        <time className={styles.nowTime}>{fmtClock(position)}</time>
        <span className={styles.sep}>·</span>
        <span className={styles.who} data-none={current === null ? 'true' : undefined}>
          {current === null ? '还没走到第一段' : (current.speaker ?? '这一段没认出发言人')}
        </span>
        {cc && current !== null && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.nowText}>{current.text}</span>
          </>
        )}
      </p>

      {props.cuesLoading && <p className={styles.state}>转写分段读取中……</p>}
      {props.cuesError !== null && (
        <p className={styles.err}>转写分段取失败：{props.cuesError.message}</p>
      )}
      {!props.cuesLoading && props.cuesError === null && cues.length === 0 && (
        <p className={styles.state}>没有转写分段，条上没有标记，也没有字幕——详情见时间轴 tab。</p>
      )}
      </div>
    </section>
  )
}

export default Player
