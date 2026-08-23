import type { Consumer, Meeting } from '@/api/types'
import { daysLeft, fmtDateTime, fmtDay } from '@/lib/format'
import { Pill } from '@/ui/Pill'
import { ProgressBar } from '@/ui/ProgressBar'
import { StatusDot } from '@/ui/StatusDot'
import styles from './MeetingRow.module.css'

/** 八类资产的"已拿到 / 应有"合计。某个键不出现＝该类不适用，不参与计数。 */
export function assetTotals(m: Meeting): { got: number; total: number } {
  let got = 0
  let total = 0
  for (const v of Object.values(m.assets)) {
    got += v.got
    total += v.total
  }
  return { got, total }
}

/**
 * "已授权给"这一栏该画成什么。
 *
 * **生命周期原因优先于权限原因**（spec.md §6.1）：本地文件已经清理、还没归档、
 * 压根没有录制——这三种情况下没有任何规则参与判断，不能画成"规则禁止采集"。
 *
 * 原型的 `grantCell()` 是先看 `m.allow === 'deny'` 再看别的，于是"董事会闭门会"
 * （未拉取，`why.allow.by === 'wait'`）和"销售晨会"（无录制，`by === 'na'`）
 * 都被画成了琥珀色的"规则禁止采集"——而这两场会议根本没有哪条规则拒绝过它们。
 * 状态与理由必须自洽，这里按 `why.allow.by` 判，不按 `allow` 判。
 */
export type GrantCellKind =
  | { kind: 'expired' }
  | { kind: 'na' }
  | { kind: 'wait' }
  | { kind: 'denied' }
  | { kind: 'grantable' }

export function grantCellKind(m: Meeting): GrantCellKind {
  const by = m.why.allow.by
  if (by === 'expired' || m.keep.filesGone) return { kind: 'expired' }
  if (by === 'na') return { kind: 'na' }
  if (by === 'wait' || m.archive !== 'done') return { kind: 'wait' }
  if (by === 'deny') return { kind: 'denied' }
  return { kind: 'grantable' }
}

export interface MeetingRowProps {
  meeting: Meeting
  consumers: Consumer[]
  now: Date
  selected: boolean
  cursor: boolean
  onSelect: (id: string, next: boolean) => void
  onOpenTitle: (id: string) => void
  onOpenDetail: (id: string) => void
  onToggleStage: (id: string, stage: 'fetch' | 'archive') => void
  onExtend: (id: string) => void
  onOpenGrant: (id: string) => void
  onRevoke: (id: string, consumerId: string) => void
}

export function MeetingRow(props: MeetingRowProps) {
  const {
    meeting: m,
    consumers,
    now,
    selected,
    cursor,
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
          aria-label={`选择 ${m.title}`}
        />
      </td>

      <td>
        {/* 标题是按钮，点进内容预览——不是纯文本（spec.md §4.2）。 */}
        <button type="button" className={styles.title} onClick={() => onOpenTitle(m.id)}>
          {m.title}
        </button>
        <div className={styles.meta}>
          <span className={styles.code}>{m.code}</span>
          <span aria-hidden="true"> · </span>
          {/* fmtDateTime 的月/日不补零（与原型一致），"9-1" 比 "12-31" 少两个字符。
              等宽数字解决不了字符数不同，所以这里额外给一个 ch 下限撑住列宽。 */}
          <span className={styles.when}>{fmtDateTime(m.startAt, now)}</span>
        </div>
      </td>

      <td className={styles.host}>{m.host}</td>

      <td
        className={styles.assets}
        data-state={total === 0 ? 'na' : got < total ? 'partial' : 'full'}
      >
        {total === 0 ? '—' : got < total ? `${got}/${total}` : String(total)}
      </td>

      <td className={styles.stage}>
        <div className={styles.stageRow}>
          <StatusDot
            state={m.fetch}
            label="拉取"
            overridden={m.hand.includes('fetch')}
            onClick={() => onToggleStage(m.id, 'fetch')}
          />
          {/* 两阶段之间的连线：拉取完成才是实线，否则虚线——顺序关系是这一栏
              要传达的第二件事（"归档要等拉取"）。 */}
          <span className={styles.link} data-done={m.fetch === 'done'} aria-hidden="true" />
          <StatusDot
            state={m.archive}
            label="归档到 NAS"
            overridden={m.hand.includes('archive')}
            onClick={() => onToggleStage(m.id, 'archive')}
            disabled={m.fetch !== 'done'}
          />
        </div>
      </td>

      <td className={styles.keep} data-testid={`keep-${m.id}`}>
        <KeepCell m={m} now={now} onExtend={onExtend} />
      </td>

      <td className={styles.grant} data-testid={`grant-${m.id}`}>
        <GrantCell m={m} consumers={consumers} onOpenGrant={onOpenGrant} onRevoke={onRevoke} />
      </td>

      <td className={styles.act}>
        <button
          type="button"
          className={styles.detailBtn}
          onClick={() => onOpenDetail(m.id)}
          aria-label={`${m.title} 的详情`}
        >
          <span aria-hidden="true">›</span>
        </button>
      </td>
    </tr>
  )
}

function KeepCell({ m, now, onExtend }: { m: Meeting; now: Date; onExtend: (id: string) => void }) {
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
    return (
      <span className={styles.keepNone}>
        {m.archive === 'failed' ? '归档失败，未开始计时' : '未归档'}
      </span>
    )
  }

  const left = daysLeft(m.keep.expiresAt, now)
  const soon = left <= 7
  const windowSec = m.keep.expiresAt - m.keep.archivedAt
  const usedSec = Math.floor(now.getTime() / 1000) - m.keep.archivedAt
  const usedPct = windowSec > 0 ? (usedSec / windowSec) * 100 : 0

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
        aria-label={`把「${m.title}」的本地保留期延长 30 天`}
      >
        ＋30 天
      </button>
    </div>
  )
}

function GrantCell({
  m,
  consumers,
  onOpenGrant,
  onRevoke,
}: {
  m: Meeting
  consumers: Consumer[]
  onOpenGrant: (id: string) => void
  onRevoke: (id: string, consumerId: string) => void
}) {
  const cell = grantCellKind(m)

  if (cell.kind === 'expired') {
    return <span className={styles.grantNone}>授权已失效</span>
  }
  if (cell.kind === 'na') {
    return <span className={styles.grantNone}>无资产</span>
  }
  if (cell.kind === 'wait') {
    return <span className={styles.grantNone}>未归档</span>
  }
  if (cell.kind === 'denied') {
    return (
      <Pill tone="warn">规则禁止采集</Pill>
    )
  }

  if (m.grants.length === 0) {
    return (
      <button type="button" className={styles.grantAdd} onClick={() => onOpenGrant(m.id)}>
        ＋ 授权给…
      </button>
    )
  }

  return (
    <div className={styles.grantRow}>
      {m.grants.map((id) => (
        <Pill
          key={id}
          tone="brand"
          onRemove={() => onRevoke(m.id, id)}
          removeLabel={`收回 ${consumerName(consumers, id)} 对「${m.title}」的授权`}
        >
          {consumerName(consumers, id)}
        </Pill>
      ))}
      <button
        type="button"
        className={styles.grantAdd}
        onClick={() => onOpenGrant(m.id)}
        aria-label={`再给「${m.title}」授权一个采集程序`}
      >
        ＋
      </button>
    </div>
  )
}

/** `grants` 存的是 `Consumer.id`，显示名要现查——查不到就退回 id，不显示空白。 */
export function consumerName(consumers: Consumer[], id: string): string {
  return consumers.find((c) => c.id === id)?.name ?? id
}
