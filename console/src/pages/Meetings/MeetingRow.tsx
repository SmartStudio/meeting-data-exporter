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
  hostView,
  meetingTitle,
  programName,
  STAGE_NAME,
  STAGE_SHORT,
  stateLabel,
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

      {/* data-label 是窄屏卡片形态下的列名（`ui/Table` 的 cards 开关）。
          宽屏下它不显示——列名在 thead 里。漏一个的表现是窄屏上那一格
          只剩一个没人看得懂的值。 */}
      <td className={styles.host} data-label="主持人">
        <HostCell m={m} />
      </td>

      <td
        data-label="资产"
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

      {/* 两个阶段各占一行，**每一行都带文字**。此前这一栏是「● —— ●」——
          实心/空心/连线/转圈四种记号，屏幕上没有任何地方说它们是什么意思，
          页面底下那块图例离得太远而且窄屏根本不在同一屏。文字标签让这一格
          自己说清楚，图例因此被删掉了（见 `pages/Meetings/index.tsx`）。 */}
      <td className={styles.stage} data-label="拉取 · 归档">
        {/* 竖排容器是必需的，不是多一层 div：窄屏卡片形态下 `td[data-label]`
            自己是一个横向 flex（列名 ｜ 值），两个阶段直接放进去会被并排摆，
            在 375px 上挤成两根竖柱。 */}
        <div className={styles.stageStack}>
          <StageLine m={m} stage="fetch" isPending={isPending} onToggle={onToggleStage} />
          <StageLine m={m} stage="archive" isPending={isPending} onToggle={onToggleStage} />
        </div>
      </td>

      <td className={styles.keep} data-label="本地保留" data-testid={`keep-${m.id}`}>
        <KeepCell m={m} now={now} isPending={isPending} onExtend={onExtend} />
      </td>

      <td className={styles.grant} data-label="可取走的程序" data-testid={`grant-${m.id}`}>
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
 * 主持人一格。
 *
 * 此前这里是 `{m.missing.includes('host') ? '—' : m.host}`，渲染出来每一行都是
 * 一串 32 位机器 id。判定逻辑与它的全部推理在 `display.ts` 的 `hostView`——
 * 这里只负责把三段排出来：主文本、尾巴、以及挂在 title 上的全量 id。
 *
 * 尾巴用等宽字体、比主文本淡一档：它不是名字的一部分，它是「用来区分两行」
 * 的那截编号，两者长得一样会重新变成"一串 id 冒充人名"。
 */
function HostCell({ m }: { m: AdminMeeting }) {
  const v = hostView(m)
  return (
    <span
      className={styles.hostText}
      data-resolved={v.resolved}
      title={v.title ?? undefined}
      data-testid={`host-${m.id}`}
    >
      {v.text}
      {v.tail !== null && (
        <>
          <span aria-hidden="true"> · </span>
          <span className={styles.hostId}>{v.tail}</span>
        </>
      )}
    </span>
  )
}

/**
 * 一个阶段的一行：圆点 + 阶段名 + 状态文字，整行是那个"点一下重跑该阶段"的开关。
 *
 * **文字不是给圆点配的说明，文字才是主体**。圆点单独存在时这一栏需要一份图例
 * 才读得懂，而图例在窄屏卡片形态下根本不在同一屏——一个需要去别处查表才能读的
 * 状态列，等于没有状态列。现在圆点退化成冗余编码（颜色/形状 + 文字），
 * 色觉障碍与"没见过这套记号"的人读到的是同一件事。
 *
 * **认不出的状态不画圆点**：六种圆点各自有确定的含义，随便挑一个画等于替后端
 * 下了一个我们没有的结论。改画一个「未知」标签，并把原始取值放进 title 里
 * ——那是排查这件事唯一的线索。
 *
 * 圆点被 `aria-hidden` 包着：它自己带 `aria-label`，不裹起来的话读屏会把
 * 「拉取：已完成」念两遍。可读文本由外层按钮的 `aria-label` 一次给全。
 */
function StageLine({
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
  const overridden = m.hand.includes(stage)

  if (state === 'unknown') {
    return (
      <span className={styles.stageLine}>
        <Pill tone="warn" className={styles.unknownDot}>
          <span title={`${STAGE_NAME[stage]}：后端下发了认不出的取值「${raw}」`}>
            {STAGE_SHORT[stage]}未知
          </span>
        </Pill>
      </span>
    )
  }

  const pending = isPending(wkey(m.id, stage))
  const disabled = pending || readonly
  const roWhy = readonlyTitle(readonly)
  // 可读文本与 StatusDot 自己拼的那句逐字同形——它是这一栏的既有口径，
  // 换一个写法等于给同一件事造第二套叫法。
  const text =
    `${STAGE_SHORT[stage]}：${stateLabel(state)}` +
    (overridden ? ' · 人工改写' : '') +
    (disabled && roWhy !== undefined ? `（${roWhy}）` : '')

  return (
    <button
      type="button"
      className={styles.stageLine}
      data-state={state}
      onClick={() => onToggle(m.id, stage)}
      disabled={disabled}
      aria-label={text}
      title={text}
    >
      <span className={styles.stageIcon} aria-hidden="true">
        <StatusDot state={state} label={STAGE_SHORT[stage]} overridden={overridden} />
      </span>
      <span className={styles.stageName}>{STAGE_SHORT[stage]}</span>
      <span className={styles.stageState}>{stateLabel(state)}</span>
      {/* 琥珀圈的含义也要有文字。它在 design-system §2.2 里只有一个意思：
          有人手动改写了规则——那正是"需要你看一眼"的那一类 */}
      {overridden && <span className={styles.handMark}>人工</span>}
    </button>
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
  // **量的是「还剩多少」，不是「已经用掉多少」**。旁边那行字写的是「剩 30 天」，
  // 而画成"已用"的条在刚归档那一刻几乎是空的——一整列浅得快看不见的条子，
  // 读出来是"快没了"，事实是"才刚开始"。59 场已归档的会议里绝大多数都在这个
  // 位置上，也就是说这一列此前对绝大多数行说的是反话。
  //
  // 现在：满＝时间还长，见底＝快到期；到期前七天转琥珀，一条快见底的琥珀条
  // 与「剩 3 天」说的是同一件事。
  const leftPct = windowSec > 0 ? Math.max(0, Math.min(100, ((windowSec - usedSec) / windowSec) * 100)) : 0
  const totalDays = Math.max(1, Math.round(windowSec / 86400))
  const pending = isPending(wkey(m.id, 'extend'))

  return (
    <div className={styles.keepRow}>
      <ProgressBar
        className={styles.keepBar}
        value={leftPct}
        tone={soon ? 'warn' : 'brand'}
        size="sm"
        label={`本地文件还剩 ${left} 天，保留期共 ${totalDays} 天`}
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
    // 人工设为禁止是琥珀 pill：有人绕过了规则，这正是 design-system §2.2 里
    // 琥珀唯一的含义——"这需要你看一眼"。它很少见，配得上一块强调。
    if (cell.hand) return <Pill tone="warn">已人工禁止</Pill>
    // 规则禁止是**最常见的默认态**（真实数据里连着占了 8 行），此前它是一枚
    // pill——版面上最强的视觉重量给了"什么都没发生"。改成一行极淡的灰字：
    // pill 那种强调留给真的有授权的行，一屏扫下来才看得出哪几场数据真在外面。
    return <span className={styles.grantNone}>规则禁止</span>
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
