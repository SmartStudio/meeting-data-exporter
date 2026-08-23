import styles from './StatusDot.module.css'

/** fetch/archive 两个阶段共用的状态取值（并集）。 */
export type StatusDotState = 'done' | 'running' | 'failed' | 'blocked' | 'off' | 'none'

/** 中文状态文案，逐字对应原型的 STAGE_LABEL——不要另造一套叫法。 */
export const STATUS_DOT_LABEL: Record<StatusDotState, string> = {
  done: '已完成',
  running: '进行中',
  failed: '失败',
  blocked: '规则不执行',
  off: '未执行',
  none: '无录制',
}

export interface StatusDotProps {
  state: StatusDotState
  /** 阶段名，如"拉取"/"归档到 NAS"，与状态文案拼成完整可读文本。 */
  label: string
  /** 该阶段是否被人工改写过。琥珀环只表示这一件事——"有人手动改写了规则"，
   *  不要因为好看就在别的地方也套一圈琥珀。 */
  overridden?: boolean
  /** 提供则渲染成可点的切换按钮（拉取/归档两个阶段的圆点本身就是"点一下重跑该阶段"
   *  的开关）；不提供则是纯展示的状态点。 */
  onClick?: () => void
  disabled?: boolean
  className?: string
}

/**
 * 状态点基元。颜色不是唯一信息载体——六个状态各有可读文本，通过 aria-label 与
 * 原生 title（悬浮提示）双重暴露，色觉障碍用户也能读出状态，不需要浮层基座
 *（tooltip 用原生 title 属性，不占用 Task 4 的 Popover）。
 */
export function StatusDot({
  state,
  label,
  overridden = false,
  onClick,
  disabled = false,
  className,
}: StatusDotProps) {
  const text = `${label}：${STATUS_DOT_LABEL[state]}${overridden ? ' · 人工改写' : ''}`
  const classes = [styles.dot, className].filter(Boolean).join(' ')

  const icon = (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <Glyph state={state} />
      {overridden ? <circle cx={9} cy={9} r={8} className={styles.overrideRing} /> : null}
    </svg>
  )

  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        onClick={onClick}
        disabled={disabled}
        aria-label={text}
        title={text}
      >
        {icon}
      </button>
    )
  }

  return (
    <span className={classes} role="img" aria-label={text} title={text}>
      {icon}
    </span>
  )
}

function Glyph({ state }: { state: StatusDotState }) {
  switch (state) {
    case 'done':
      return <circle cx={9} cy={9} r={5} className={styles.glyphDone} />
    case 'failed':
      return (
        <>
          <circle cx={9} cy={9} r={5} className={styles.glyphFailed} />
          <path d="M6.9 6.9 11.1 11.1 M11.1 6.9 6.9 11.1" className={styles.glyphFailedMark} />
        </>
      )
    case 'running':
      return (
        <>
          <circle cx={9} cy={9} r={4.8} className={styles.glyphRunningRing} />
          <circle cx={9} cy={9} r={2.4} className={styles.glyphRunningPulse} />
        </>
      )
    case 'blocked':
      return <circle cx={9} cy={9} r={4.8} className={styles.glyphBlocked} />
    case 'off':
      return <circle cx={9} cy={9} r={4.8} className={styles.glyphOff} />
    case 'none':
      return <circle cx={9} cy={9} r={1.7} className={styles.glyphNone} />
  }
}
