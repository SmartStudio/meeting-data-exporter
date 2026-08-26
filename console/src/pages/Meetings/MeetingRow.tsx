import type { ServiceProgram } from '@/api/admin/grants'
import type { AdminMeeting } from '@/api/admin/meetings'
import { readonlyTitle, useReadonly } from '@/app/session'
import { daysLeft, fmtDateTime, fmtDay } from '@/lib/format'
import { Pill } from '@/ui/Pill'
import { ProgressBar } from '@/ui/ProgressBar'
import { StatusDot } from '@/ui/StatusDot'
import {
  assetTotals,
  dotState,
  grantCellKind,
  meetingTitle,
  programName,
  STAGE_NAME,
  type Stage,
} from './display'
import { wkey } from './writes'
import styles from './MeetingRow.module.css'

export interface MeetingRowProps {
  meeting: AdminMeeting
  programs: readonly ServiceProgram[]
  now: Date
  selected: boolean
  cursor: boolean
  /** 这一行上有没有正在跑的写操作。键由 `wkey(id, op)` 拼 */
  isPending: (key: string) => boolean
  onSelect: (id: string, next: boolean) => void
  onOpenTitle: (id: string) => void
  onOpenDetail: (id: string) => void
  onToggleStage: (id: string, stage: Stage) => void
  onExtend: (id: string) => void
  onOpenGrant: (id: string) => void
  onRevoke: (id: string, programId: string) => void
}

export function MeetingRow(props: MeetingRowProps) {
  const {
    meeting: m,
    programs,
    now,
    selected,
    cursor,
    isPending,
    onSelect,
    onOpenTitle,
    onOpenDetail,
    onToggleStage,
    onExtend,
    onOpenGrant,
    onRevoke,
  } = props

  const { got, total } = assetTotals(m)
  const dim = m.keep.filesGone
  const title = meetingTitle(m)

  return (
    <tr
      data-id={m.id}
      data-testid={`row-${m.id}`}
      data-dim={dim}
      data-selected={selected}
      data-cursor={cursor}
    >
      <td className={styles.check}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={selected}
          onChange={(e) => onSelect(m.id, e.target.checked)}
          aria-label={`选择 ${title}`}
        />
      </td>

      <td>
        {/* 标题是按钮，点进内容预览——不是纯文本（spec.md §4.2）。 */}
        <button type="button" className={styles.title} onClick={() => onOpenTitle(m.id)}>
          {title}
        </button>
        <div className={styles.meta}>
          <span className={styles.code}>{m.missing.includes('code') ? '会议号未取到' : m.code}</span>
          <span aria-hidden="true"> · </span>
          {/* fmtDateTime 的月/日不补零（与原型一致），"9-1" 比 "12-31" 少两个字符。
              等宽数字解决不了字符数不同，所以这里额外给一个 ch 下限撑住列宽。 */}
          <span className={styles.when}>
            {m.missing.includes('startAt') ? '时间未取到' : fmtDateTime(m.startAt, now)}
          </span>
        </div>
      </td>

      <td className={styles.host}>{m.missing.includes('host') ? '—' : m.host}</td>

      <td
        className={styles.assets}
        data-state={total === 0 ? 'na' : got < total ? 'partial' : 'full'}
        title={
          m.unknownAssetTypes.length > 0
            ? `另有认不出的资产类型：${m.unknownAssetTypes.join('、')}`
            : undefined
        }
      >
        {total === 0 ? '—' : got < total ? `${got}/${total}` : String(total)}
        {m.unknownAssetTypes.length > 0 && <sup aria-hidden="true">?</sup>}
      </td>

      <td className={styles.stage}>
        <div className={styles.stageRow}>
          <StageDot m={m} stage="fetch" isPending={isPending} onToggle={onToggleStage} />
          {/* 两阶段之间的连线：拉取完成才是实线，否则虚线——顺序关系是这一栏
              要传达的第二件事（"归档要等拉取"）。 */}
          <span className={styles.link} data-done={m.fetch === 'done'} aria-hidden="true" />
          <StageDot m={m} stage="archive" isPending={isPending} onToggle={onToggleStage} />
        </div>
      </td>

      <td className={styles.keep} data-testid={`keep-${m.id}`}>
        <KeepCell m={m} now={now} isPending={isPending} onExtend={onExtend} />
      </td>

      <td className={styles.grant} data-testid={`grant-${m.id}`}>
        <GrantCell m={m} programs={programs} isPending={isPending} onOpenGrant={onOpenGrant} onRevoke={onRevoke} />
      </td>

      <td className={styles.act}>
        <button
          type="button"
          className={styles.detailBtn}
          onClick={() => onOpenDetail(m.id)}
          aria-label={`${title} 的详情`}
        >
          <span aria-hidden="true">›</span>
        </button>
      </td>
    </tr>
  )
}

/**
 * 一个阶段的圆点。
 *
 * **认不出的状态不画圆点**：六种圆点各自有确定的含义，随便挑一个画等于替后端
 * 下了一个我们没有的结论。改画一个「未知」标签，并把原始取值放进 title 里
 * ——那是排查这件事唯一的线索。
 */
function StageDot({
  m,
  stage,
  isPending,
  onToggle,
}: {
  m: AdminMeeting
  stage: Stage
  isPending: (key: string) => boolean
  onToggle: (id: string, stage: Stage) => void
}) {
  const readonly = useReadonly()
  const raw = stage === 'fetch' ? m.fetch : m.archive
  const state = dotState(stage, raw)
  if (state === 'unknown') {
    return (
      <Pill tone="warn" className={styles.unknownDot}>
        <span title={`${STAGE_NAME[stage]}：后端下发了认不出的取值「${raw}」`}>
          {STAGE_NAME[stage]}未知
        </span>
      </Pill>
    )
  }
  const pending = isPending(wkey(m.id, stage))
  return (
    <StatusDot
      state={state}
      label={STAGE_NAME[stage]}
      overridden={m.hand.includes(stage)}
      onClick={() => onToggle(m.id, stage)}
      disabled={pending || readonly}
      disabledReason={readonlyTitle(readonly)}
    />
  )
}

function KeepCell({
  m,
  now,
  isPending,
  onExtend,
}: {
  m: AdminMeeting
  now: Date
  isPending: (key: string) => boolean
  onExtend: (id: string) => void
}) {
  // 钩子必须在任何提前 return 之前调用——这个组件下面有三处 return。
  const readonly = useReadonly()

  if (m.keep.filesGone) {
    return (
      <div className={styles.keepRow}>
        <Pill>仅存 NAS</Pill>
        {m.keep.expiresAt !== null && (
          <span className={styles.keepGone}>{fmtDay(m.keep.expiresAt)}到期</span>
        )}
      </div>
    )
  }

  if (m.keep.archivedAt === null || m.keep.expiresAt === null) {
    // 保留期自**归档成功**起算。没归档成功就没有"还剩几天"这回事——
    // 这里说清楚是哪一种没归档，而不是含糊地画一根空进度条。
    //
    // 「归档失败」和「未归档」不是同一件事，不能同一个灰：红＝失败＝一个月后
    // 永久丢失，是本系统最严重的状态（design-system.md §2.2）。
    const failed = m.archive === 'failed'
    return (
      <span className={styles.keepNone} data-fail={failed}>
        {failed ? '归档失败，未开始计时' : '未归档'}
      </span>
    )
  }

  const left = daysLeft(m.keep.expiresAt, now)
  const soon = left <= 7
  const windowSec = m.keep.expiresAt - m.keep.archivedAt
  const usedSec = Math.floor(now.getTime() / 1000) - m.keep.archivedAt
  const usedPct = windowSec > 0 ? (usedSec / windowSec) * 100 : 0
  const pending = isPending(wkey(m.id, 'extend'))

  return (
    <div className={styles.keepRow}>
      <ProgressBar
        className={styles.keepBar}
        value={usedPct}
        tone={soon ? 'warn' : 'brand'}
        size="sm"
        label={`本地保留期已用 ${Math.round(usedPct)}%，还剩 ${left} 天`}
      />
      <span className={styles.keepLeft} data-soon={soon}>
        剩 {left} 天
      </span>
      {/* hover / 键盘光标停在这一行时才浮出来——常驻会让整列变成一片按钮。
          它始终在 DOM 里（不是条件渲染），所以键盘 `e` 和读屏都拿得到。 */}
      <button
        type="button"
        className={styles.extendBtn}
        onClick={() => onExtend(m.id)}
        disabled={pending || readonly}
        title={readonlyTitle(readonly)}
        aria-label={`把「${meetingTitle(m)}」的本地保留期延长 30 天`}
      >
        {pending ? '延长中…' : '＋30 天'}
      </button>
    </div>
  )
}

function GrantCell({
  m,
  programs,
  isPending,
  onOpenGrant,
  onRevoke,
}: {
  m: AdminMeeting
  programs: readonly ServiceProgram[]
  isPending: (key: string) => boolean
  onOpenGrant: (id: string) => void
  onRevoke: (id: string, programId: string) => void
}) {
  // 同上：这个组件有六处提前 return，钩子只能在最前面。
  const readonly = useReadonly()
  const roTitle = readonlyTitle(readonly)
  const cell = grantCellKind(m)

  if (cell.kind === 'expired') return <span className={styles.grantNone}>授权已失效</span>
  if (cell.kind === 'na') return <span className={styles.grantNone}>无资产</span>
  if (cell.kind === 'wait') return <span className={styles.grantNone}>未归档</span>
  if (cell.kind === 'unknown') {
    // 读不懂 `allow` 就不画「＋ 授权给…」。授权是数据出企业边界的闸门，
    // 闸门在读不懂状态时必须是关着的，而且要说出来自己关着。
    return (
      <Pill tone="warn">
        <span title={`后端下发了认不出的采集权限取值「${m.allow}」`}>权限未知</span>
      </Pill>
    )
  }
  if (cell.kind === 'denied') {
    // 中性，不是琥珀——琥珀的唯一含义是"这需要你看一眼"，而一条 deny 规则
    // 命中是规则系统在正确地干活，绝大多数被拒的会议是故意且永久被拒的。
    return <Pill>{cell.hand ? '已人工设为禁止' : '规则禁止采集'}</Pill>
  }

  if (m.grants.length === 0) {
    return (
      <button
        type="button"
        className={styles.grantAdd}
        onClick={() => onOpenGrant(m.id)}
        disabled={readonly}
        title={roTitle}
      >
        ＋ 授权给…
      </button>
    )
  }

  const title = meetingTitle(m)
  return (
    <div className={styles.grantRow}>
      {m.grants.map((id) => {
        const pending = isPending(wkey(m.id, `revoke:${id}`))
        return (
          <Pill
            key={id}
            tone="brand"
            onRemove={pending ? () => undefined : () => onRevoke(m.id, id)}
            removeDisabled={readonly}
            removeTitle={roTitle}
            removeLabel={`收回 ${programName(programs, id)} 对「${title}」的授权`}
          >
            {programName(programs, id)}
            {pending && <span className={styles.pendingMark}>（收回中…）</span>}
          </Pill>
        )
      })}
      <button
        type="button"
        className={styles.grantAdd}
        onClick={() => onOpenGrant(m.id)}
        disabled={readonly}
        title={roTitle}
        aria-label={`再给「${title}」授权一个采集程序`}
      >
        ＋
      </button>
    </div>
  )
}
