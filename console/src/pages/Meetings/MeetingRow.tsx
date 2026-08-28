import type { ServiceProgram } from '@/api/admin/grants'
import type { AdminMeeting } from '@/api/admin/meetings'
import { readonlyTitle, useReadonly } from '@/app/session'
import { daysLeft, fmtDateTime, fmtDay } from '@/lib/format'
import {
  assetTotals,
  dotState,
  grantCellKind,
  hostView,
  meetingTitle,
  programAbbr,
  programName,
  rowFlag,
  STAGE_NAME,
  STAGE_SHORT,
  stageNote,
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

/**
 * 一场会议一行。**目标是单行（≈46px），正常态一个字都不写**（阶段 7）。
 *
 * 此前一行 62–87px：「拉取 · 归档」两个阶段各占一整行文字，而那两行在 59 场
 * 里有 50 多场读出来是同一句「已完成 / 已完成」。一屏只看得到 8 行，也就是说
 * 想知道"哪几场需要我现在管"必须滚三屏。
 *
 * 现在：两个并排的小方块，颜色即状态；**只有异常才补一句文字**（`stageNote`）。
 * 异常行在行首挂一道色条（`data-flag`），不整行变红。
 *
 * ## 方块不是可读内容
 *
 * 压成方块之后，"这一行处在什么状态"必须用另一种方式说给读屏软件听。每个方块
 * 都裹在一个带 `aria-label` 的元素里，两个合起来就是完整的一句「拉取：已完成」
 * 「归档：失败」——与压缩之前那两行文字逐字同形。可见的异常注记因此是
 * `aria-hidden`：它是给眼睛的冗余编码，读屏已经从方块的 label 里拿到同一件事，
 * 念两遍只会更慢。
 */
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
  const flag = rowFlag(m, now)
  const note = stageNote(m)

  return (
    <tr
      className={styles.row}
      data-id={m.id}
      data-testid={`row-${m.id}`}
      data-dim={dim}
      data-selected={selected}
      data-cursor={cursor}
      // 异常行的左侧色条。整行变红在一屏 20 行的密度下会失效——三行红之后
      // 红就只是"这几行长得不一样"，不再是"最严重"。
      data-flag={flag ?? undefined}
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

      <td className={styles.main}>
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

      <td className={styles.stage} data-label="拉取 · 归档" data-testid={`stage-${m.id}`}>
        <span className={styles.stageRow}>
          <StageMark m={m} stage="fetch" isPending={isPending} onToggle={onToggleStage} />
          <StageMark m={m} stage="archive" isPending={isPending} onToggle={onToggleStage} />
          {/* 异常注记。`aria-hidden`：同一件事已经在两个方块的 aria-label 里
              说过了，这一句是给眼睛的冗余编码。 */}
          {note !== null && (
            <span className={styles.note} data-tone={note.tone} aria-hidden="true">
              {note.text}
            </span>
          )}
        </span>
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
 * 一串 32 位机器 id。判定逻辑与它的全部推理在 `lib/host.ts` 的 `hostView`——
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
 * 一个阶段 = 一个小方块。**颜色即状态**：
 * 已完成＝`--ink-2` 实心、进行中＝描边空心、失败＝`--fail` 实心、
 * 无 / 不执行＝`--line` 实心。
 *
 * 方块本身 `aria-hidden`，可读文本挂在外层的 `aria-label` 上，并且与压缩之前
 * 那两行文字逐字同形（`拉取：已完成 · 人工改写`）——换一个写法等于给同一件事
 * 造第二套叫法，而这一栏的口径在详情抽屉、人工改写面板里还要再用一次。
 *
 * 整块可点＝「改写这一阶段」的开关（没有改写就打开写理由的面板，有改写就撤销）。
 * 命中区比方块大得多：9px 的方块在触屏上点不准，按钮自己撑到行高。
 *
 * **认不出的状态不画方块**：四种方块各自有确定的含义，随便挑一种画等于替后端
 * 下了一个我们没有的结论。它改画一个空心问号格，原始取值进 title——那是排查
 * 这件事唯一的线索——并且不再是按钮（读不懂状态时不提供改写入口）。
 */
function StageMark({
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
    const text = `${STAGE_NAME[stage]}：后端下发了认不出的取值「${raw}」`
    return (
      <span className={styles.sqSlot} role="img" aria-label={text} title={text}>
        <span className={styles.sq} data-state="unknown" aria-hidden="true" />
      </span>
    )
  }

  const pending = isPending(wkey(m.id, stage))
  const disabled = pending || readonly
  const roWhy = readonlyTitle(readonly)
  // 可读文本与 StatusDot 自己拼的那句逐字同形——它是这一栏的既有口径。
  const text =
    `${STAGE_SHORT[stage]}：${stateLabel(state)}` +
    (overridden ? ' · 人工改写' : '') +
    (disabled && roWhy !== undefined ? `（${roWhy}）` : '')

  return (
    <button
      type="button"
      className={styles.sqSlot}
      onClick={() => onToggle(m.id, stage)}
      disabled={disabled}
      aria-label={text}
      title={text}
    >
      <span className={styles.sq} data-state={state} data-hand={overridden || undefined} aria-hidden="true" />
    </button>
  )
}

/**
 * 本地保留 = 一个右对齐的等宽天数。
 *
 * 此前是一根进度条 + 「剩 28 天」。条被删掉了，理由有两条：一是它与旁边那行字
 * 说的是同一件事（一列 50 根条，每根都在复述右边那个数）；二是任何贴在数字
 * 下面的横条都会被读成下划线——实测过，眼睛先把它当成"这个数被标了重点"。
 *
 * 剩下的就是数：右对齐、等宽、快到期转琥珀。到期日与天数的完整说法进 title。
 */
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
      <span
        className={styles.keepOff}
        title={
          m.keep.expiresAt === null
            ? '本地文件已按保留期清理，记录与 NAS 路径仍在'
            : `本地文件已于 ${fmtDay(m.keep.expiresAt)}到期清理，记录与 NAS 路径仍在`
        }
      >
        仅存 NAS
      </span>
    )
  }

  if (m.keep.archivedAt === null || m.keep.expiresAt === null) {
    // 保留期自**归档成功**起算。没归档成功就没有"还剩几天"这回事。
    //
    // 「是哪一种没归档」不在这一格里说了——它已经在「拉取 · 归档」那一栏的
    // 异常注记里（`stageNote`），归档失败在那儿是红的、还带一道行首色条。
    // 同一件事在一行里说两遍、红两次，红就不再是最严重的意思。
    const failed = m.archive === 'failed'
    return (
      <span
        className={styles.keepOff}
        title={failed ? '归档失败，本地保留期尚未开始计时' : '尚未归档成功，本地保留期尚未开始计时'}
      >
        未计时
      </span>
    )
  }

  const left = daysLeft(m.keep.expiresAt, now)
  const soon = left <= 7
  const pending = isPending(wkey(m.id, 'extend'))

  return (
    <div className={styles.keepRow}>
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
      <span
        className={styles.keepLeft}
        data-soon={soon}
        title={`本地文件还剩 ${left} 天，${fmtDay(m.keep.expiresAt)}到期`}
      >
        {left}
        <span className={styles.keepUnit}> 天</span>
      </span>
    </div>
  )
}

/**
 * 「可取走的程序」。
 *
 * 此前一格里有三种形态在表达同一件事：蓝色 chip（已授权）、`＋`（再加一个）、
 * 虚线「＋ 授权给…」（一个都没有）。三种宽度、三种颜色，一列扫下来看不出
 * 哪几行真的把数据放到了企业外面。
 *
 * 现在：每个已授权程序 = 一枚 24×20 的两字母等宽标记（缩写从程序 `key` 派生，
 * 见 `display.programAbbr`；派生不出来就退回完整程序名，不瞎缩），末尾一个
 * 虚线 `＋`。不能授权的那几种状态仍然是一行极淡的灰字——它们是最常见的默认态，
 * 不许占最强的视觉重量。
 */
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
    // 读不懂 `allow` 就不画那个 `＋`。授权是数据出企业边界的闸门，
    // 闸门在读不懂状态时必须是关着的，而且要说出来自己关着。
    return (
      <span
        className={styles.grantNone}
        data-tone="warn"
        title={`后端下发了认不出的采集权限取值「${m.allow}」`}
      >
        权限未知
      </span>
    )
  }
  if (cell.kind === 'denied') {
    // 人工设为禁止：有人绕过了规则，这正是 design-system §2.2 里琥珀唯一的
    // 含义——"这需要你看一眼"。规则禁止则是**最常见的默认态**（真实数据里
    // 连着占了 8 行），一行极淡的灰字，把强调让给真的有授权的行。
    return (
      <span className={styles.grantNone} data-tone={cell.hand ? 'warn' : undefined}>
        {cell.hand ? '已人工禁止' : '规则禁止'}
      </span>
    )
  }

  const title = meetingTitle(m)
  return (
    <div className={styles.progRow}>
      {m.grants.map((id) => (
        <ProgMark
          key={id}
          name={programName(programs, id)}
          programId={id}
          meetingTitle={title}
          pending={isPending(wkey(m.id, `revoke:${id}`))}
          readonly={readonly}
          roTitle={roTitle}
          onRevoke={() => onRevoke(m.id, id)}
        />
      ))}
      <button
        type="button"
        className={styles.progAdd}
        onClick={() => onOpenGrant(m.id)}
        disabled={readonly}
        title={roTitle ?? '把这场会议授权给一个采集程序'}
        aria-label={
          m.grants.length === 0
            ? `给「${title}」授权一个采集程序`
            : `再给「${title}」授权一个采集程序`
        }
      >
        <span aria-hidden="true">＋</span>
      </button>
    </div>
  )
}

/**
 * 一枚采集程序标记。
 *
 * 缩写**必须可回溯**：它从程序的 `key`（`kb-indexer` / `daily-digest` /
 * `dw-sync`）派生，不是前端存的一张中文名对照表——那种表在运维新建一个程序的
 * 当天就过期，而且没有人会想到要回来改它。派生不出来（纯中文 id、单字符 id）
 * 就退回显示完整程序名：一枚认不出的两字母标记比一个长名字更糟。
 *
 * 点它 = 收回这条授权，与此前 pill 上那个 ✕ 是同一个动作、同样一次点击；
 * 全名与"点了会发生什么"都在原生 title 上。
 */
function ProgMark({
  name,
  programId,
  meetingTitle: title,
  pending,
  readonly,
  roTitle,
  onRevoke,
}: {
  name: string
  programId: string
  meetingTitle: string
  pending: boolean
  readonly: boolean
  roTitle: string | undefined
  onRevoke: () => void
}) {
  const abbr = programAbbr(programId)
  const why = roTitle !== undefined ? `（${roTitle}）` : ' · 点击收回这场会议的授权'
  return (
    <button
      type="button"
      className={styles.prog}
      // 退回全名的那一支不再是 24×20 的方标记，按内容宽度走
      data-full={abbr === null || undefined}
      onClick={onRevoke}
      disabled={readonly || pending}
      title={`${name}${pending ? '（收回中…）' : ''}${why}`}
      aria-label={`收回 ${name} 对「${title}」的授权`}
    >
      {abbr ?? name}
    </button>
  )
}
