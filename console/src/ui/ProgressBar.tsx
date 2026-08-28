import styles from './ProgressBar.module.css'

export type ProgressTone = 'brand' | 'warn' | 'fail' | 'neutral'

// noUncheckedIndexedAccess：CSS Modules 的索引签名让每一项天然是 string | undefined。
const TONE_CLASS: Record<ProgressTone, string | undefined> = {
  brand: styles.brand,
  warn: styles.warn,
  fail: styles.fail,
  neutral: styles.neutral,
}

/** 多段条里的一段。见 `ProgressBarProps.segments`。 */
export interface ProgressSegment {
  /** `data-seg` 与 React key。段的稳定标识，不上屏 */
  id: string
  /** 这一段的量，与其它段共用同一个 `max` */
  value: number
  tone: ProgressTone
}

interface ProgressBarBaseProps {
  /** 默认 100。多段模式下这是"整条代表多少"（如 NAS 总容量的字节数）。 */
  max?: number
  /** 必填：这条进度条量的是什么，读屏用户没有视觉宽度可看，只有这段文本。 */
  label: string
  size?: 'sm' | 'md'
  className?: string
}

export type ProgressBarProps = ProgressBarBaseProps &
  (
    | {
        value: number
        /** brand=常规进度，warn=保留期将至，fail=失败（如归档失败后的重试进度）。 */
        tone?: ProgressTone
        segments?: undefined
      }
    | {
        value?: undefined
        tone?: undefined
        /**
         * 多段模式：一条轨道上并排几段，剩下的部分露出轨道底色。
         *
         * 用于容量条这类"总量被几方分掉"的量，**不是进度**——所以这一支渲染成
         * `role="img"` 而不是 `role="progressbar"`：一条被三方分掉的容量条没有
         * 单一的 valuenow，硬塞一个就是给读屏用户一个假读数。整条的意思全部由
         * `label` 念出来（三个数都要念到），颜色不是唯一的信息载体。
         *
         * 各段按传入顺序从左排到右，宽度是 `value / max`；非零的段有一个最小
         * 渲染宽度（`--s-1`），否则 0.5% 这样的段在 375px 下不足 2px，
         * 等于一条"最重要的那一份看不见"的容量条。真实数值由图例逐段给出。
         */
        segments: readonly ProgressSegment[]
      }
  )

/**
 * 进度/容量条基元。条状元素用 --r-pill（语义是"半高"，不是某个像素值）。
 *
 * 两种用法：
 * - `value`（+ 可选 `tone`）：单段进度条，`role="progressbar"`。value 会被夹到
 *   [0, max] 区间内，aria-valuenow 与视觉宽度百分比始终一致（同一次计算得出，
 *   不会有一个更新了另一个没跟上）。
 * - `segments`：多段容量条，`role="img"`。见 `segments` 上的注释。
 */
export function ProgressBar(props: ProgressBarProps) {
  const { max = 100, label, size = 'md', className } = props
  const trackClass = [
    styles.track,
    size === 'sm' ? styles.sm : undefined,
    props.segments !== undefined ? styles.segmented : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const pctOf = (n: number): number => {
    const clamped = Math.max(0, Math.min(max, n))
    return max > 0 ? (clamped / max) * 100 : 0
  }

  /* `data-bar` 是给 `scripts/a11y-page.js` 的 `scanBars()` 用的稳定标记。
     它原来按 `role="progressbar"` 找轨道，于是单值进度条的调用点被改版删光之后，
     那项检查扫到 0 个元素——一项扫 0 个元素的检查等于没在检查，而报告里它照样
     显示「通过」。分段容量条的几何陷阱（轨道高度、圆角、裁剪、每段宽度对不对得上
     取值）与单值条一模一样，该一起扫。 */
  if (props.segments !== undefined) {
    return (
      <div className={trackClass} role="img" aria-label={label} data-bar="track" data-bar-kind="segments">
        {props.segments.map((s) => {
          const pct = pctOf(s.value)
          return (
            <div
              key={s.id}
              className={[styles.seg, TONE_CLASS[s.tone], pct > 0 ? styles.segMin : undefined]
                .filter(Boolean)
                .join(' ')}
              style={{ width: `${pct}%` }}
              data-seg={s.id}
              data-pct={pct}
            />
          )
        })}
      </div>
    )
  }

  const clamped = Math.max(0, Math.min(max, props.value))
  const pct = pctOf(props.value)

  return (
    <div
      className={trackClass}
      data-bar="track"
      data-bar-kind="value"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      {/* 用 transform: scaleX 而不是 width 做取值——只动 transform/opacity，
          不动布局属性做动画（design-system.md §6）。fill 元素本身恒定 100% 宽，
          靠缩放表达进度，视觉宽度与 aria-valuenow 出自同一次 pct 计算，不会错位。 */}
      <div
        className={[styles.fill, TONE_CLASS[props.tone ?? 'brand']].filter(Boolean).join(' ')}
        style={{ transform: `scaleX(${pct / 100})` }}
        data-pct={pct}
      />
    </div>
  )
}
