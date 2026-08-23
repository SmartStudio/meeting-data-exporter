import type { CSSProperties } from 'react'
import styles from './Skeleton.module.css'

export interface SkeletonProps {
  /** 单条骨架条的宽度（如 '60%' / '8em'）。留空则占满容器——真实行的宽度不齐
   *  才像一张表，交给调用方按行传，不要在基元里编一套"随机宽度"。 */
  width?: string
  /** md=主要行（如标题），sm=次要行（如元信息），矮一档、透明度略低。 */
  size?: 'md' | 'sm'
  className?: string
}

/**
 * 骨架屏基元。高光扫过用 ::after + transform 位移，不动 background-position——
 * 后者是非合成属性，每帧触发 paint，骨架屏满屏铺开时会一直占着主线程。
 * reduced-motion 下整条高光直接关闭（不是让它变慢），因为 --ease-in-out 收尾
 * 本来就落在"消失在视野外"的状态，强制到那个终态反而更安静。
 */
export function Skeleton({ width, size = 'md', className }: SkeletonProps) {
  const style: CSSProperties | undefined = width ? { width } : undefined
  const classes = [styles.skel, size === 'sm' ? styles.sm : undefined, className].filter(Boolean).join(' ')
  return <span className={classes} style={style} aria-hidden="true" />
}
