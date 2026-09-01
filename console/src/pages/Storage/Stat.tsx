import type { ReactNode } from 'react'
import styles from './Storage.module.css'

export interface HintProps {
  /** 这颗按钮自己的名字。读屏该念的是「这颗按钮是干什么的」，不是整句说明——
   *  说明现在是页面上真实存在的一段文字，展开之后它自己会被念到。 */
  label: string
  /** 它管着的那段说明的 id（`aria-controls`）。那段说明由**调用方**渲染：
   *  它必须落在挂载点那一行的外面，`.path` 本身是个 `<p>`，`<p>` 里塞不下
   *  另一个 `<p>`。 */
  controls: string
  open: boolean
  onToggle: () => void
}

/**
 * 口径说明的 ⓘ。一颗按钮，点开的是就在下面一行的说明。
 *
 * **为什么定义不写成常驻正文**：这一页原先有 13 处说明性散文，占全页可见文字
 * 的 48%——数字和按钮被自己的解释淹了。判据是"删掉它，用户会不会做错事"：
 * 一格统计的口径（"等待归档数的是哪些会议"）不知道也不会点错任何按钮，
 * 但需要的时候得查得到。所以它降级成"点一下才看得到"，而不是被删掉。
 * （能压进一句短小字的那几处已经搬成常驻可见文本了，见 `Stat` 的 `note`
 * 和 `describeDefaultDays` 的 `sourceNote`；剩下这一处的整句有四十来字，
 * 常驻在挂载点下面就是三行"系统不知道某件事"顶在管理员想看的信息前面。）
 *
 * **为什么不再是 `title` 悬停**：`title` 的气泡只在鼠标悬停时出现，而**触屏
 * 没有 hover**——这段文字在手机上等于不存在，可它讲的是"协议这一栏的值是
 * 推断出来的，不是后端给的"，一条关于数据可信度的说明。原先那个 span 的
 * 热区还只有 12×12px，远低于 44×44 的触控下限：够不着的东西，说明写得再对
 * 也没用。换成 button + 点击展开，这两件事一起解决，键盘也不必再靠
 * `tabIndex={0}` 让一个 span 假装可聚焦。
 *
 * **role 跟着换**：从前 `role="note"` + `aria-label`＝整句，那是在给一个不可
 * 操作的字形补一个可读名。现在它是按钮就老实当按钮（`aria-expanded` /
 * `aria-controls` 说明它管着下面那段），`role="note"` 让给真正是"说明"的
 * 那段文字。
 */
export function Hint({ label, controls, open, onToggle }: HintProps) {
  return (
    <button
      type="button"
      className={styles.hint}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      onClick={onToggle}
    >
      ⓘ
    </button>
  )
}

export interface StatProps {
  /** 落在 `data-testid="stat-<id>"` 上，也是这一格的稳定标识 */
  id: string
  label: string
  /**
   * 取值。**`null` 的意思是"这个数现在拿不到"**，渲染成 `missingText`
   * 而不是 0——0 是一次判定（"确实没有"），拿不到是一次缺口，
   * 把后者显示成前者就是替一个我们没有的答案下结论。
   */
  value: ReactNode | null
  /** `value === null` 时显示什么。默认"暂不可得" */
  missingText?: string
  /** 有值时的语气。fail / warn 用于本身就是坏消息的计数，其余保持中性 */
  tone?: 'plain' | 'fail' | 'warn'
  /**
   * 这一格的口径，**一句可见的小字**，挂在数字下面（D-jobs-storage brief：
   * 7 个 ⓘ 砍到 2 个以内，能写进标签/正文的就写进去，不必都挂悬停）。
   * 每一格的解剖因此是「标签 / 数字 / 一句注」三行，同一个形状，
   * 不再需要先悬停才看得到口径。
   */
  note?: ReactNode
}

/** 统计格。两块面板共用，样式与"拿不到"的处置都收在这里，不各写一遍。
 *  不再是带边框的盒子——一排靠基线对齐的数字组，列与列之间的分隔线由
 *  外层 `.stats` 容器画（`border-right` + `--line-soft`），这里只管内容。 */
export function Stat({ id, label, value, missingText = '暂不可得', tone = 'plain', note }: StatProps) {
  const missing = value === null || value === undefined
  const valueClass = missing
    ? styles.statVMissing
    : tone === 'fail'
      ? styles.statVFail
      : tone === 'warn'
        ? styles.statVWarn
        : styles.statV

  return (
    <div className={styles.stat} data-testid={`stat-${id}`}>
      <div className={styles.statK}>{label}</div>
      <div className={valueClass}>{missing ? missingText : value}</div>
      {note !== undefined && <div className={styles.statNote}>{note}</div>}
    </div>
  )
}
