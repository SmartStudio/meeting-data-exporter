import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import styles from './Chip.module.css'

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** 是否被选中（分诊/筛选场景下用 aria-pressed 表达，不引入独立的自定义属性）。 */
  active?: boolean
}

/**
 * 筛选用的切换 Chip。选中态统一用品牌蓝——蓝色在这个系统里只表示
 * 「数据可被取走/主交互」，选中态属于主交互的一种，不要按 Chip 自身语义
 * （比如"归档失败"筛选）去给它上红/琥珀色，那两个颜色留给 Pill/StatusDot
 * 表达数据本身的状态。
 */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { active = false, className, ...rest },
  ref,
) {
  const classes = [styles.chip, className].filter(Boolean).join(' ')
  return <button ref={ref} type="button" className={classes} aria-pressed={active} {...rest} />
})
