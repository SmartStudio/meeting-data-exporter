import type { KeyboardEvent } from 'react'
import { useRef } from 'react'
import styles from './Preview.module.css'

/**
 * 一排单选（纪要模板 / 文件格式）。
 *
 * 用 `role="radiogroup"` + 一组 `role="radio"` 的按钮，**方向键在组内移动、
 * Tab 键整组只停一次**（roving tabindex）——这是 ARIA 的单选组模式，也是
 * spec §9「键盘操作」对这一页的要求。用一串各自可 Tab 的按钮凑出来，
 * 读屏念不出"四选一"，键盘用户要按四次 Tab 才能走过一个选择。
 */
export interface RadioOption {
  value: string
  label: string
}

export interface RadioRowProps {
  label: string
  options: readonly RadioOption[]
  value: string
  onChange: (value: string) => void
}

export function RadioRow({ label, options, value, onChange }: RadioRowProps) {
  const ref = useRef<HTMLDivElement>(null)

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (dir === 0) return
    e.preventDefault()
    const at = options.findIndex((o) => o.value === value)
    const next = options[(at + dir + options.length) % options.length]!
    onChange(next.value)
    // 选中即聚焦：单选组里"焦点在 A、选中的是 B"是一个说不清的状态
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus()
  }

  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={styles.pick} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={styles.pickBtn}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export default RadioRow
