import type { SystemState } from '@/api/types'
import { useTheme, type Theme } from '@/theme/useTheme'
import { SYSTEM_STATE_OPTIONS, useSystemState } from './SystemStatus'
import styles from './GlobalBar.module.css'

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/**
 * 顶栏。产品名放在左栏顶部（见 `Rail.tsx`，跟原型截图一致），这里是原型
 * `.gbar` 剩下的那部分：全局搜索入口、系统状态下拉、主题切换、用户菜单、
 * 以及必须保留的「原型 · 全部数字为示例」标记。
 */
export default function GlobalBar() {
  const { state, setState } = useSystemState()
  const { theme, setTheme } = useTheme()

  return (
    <header className={styles.gbar}>
      <span className={styles.protoTag}>原型 · 全部数字为示例</span>

      {/* 这些形态平时看不到，在这里调出来——F1 阶段唯一切换系统状态的入口 */}
      <select
        className={styles.statePick}
        aria-label="系统状态（原型专用，用于演示五种形态）"
        value={state}
        onChange={(e) => setState(e.target.value as SystemState)}
      >
        {SYSTEM_STATE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            状态：{opt.label}
          </option>
        ))}
      </select>

      <span className={styles.spacer} />

      {/* F1 只放入口，不实现真正的全局搜索 */}
      <button type="button" className={styles.search}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        搜会议 / 规则 / 程序
        <kbd className={styles.kbd}>⌘K</kbd>
      </button>

      <div className={styles.themeGroup} role="group" aria-label="主题切换">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={theme === opt.value ? `${styles.themeBtn} ${styles.themeBtnActive}` : styles.themeBtn}
            aria-pressed={theme === opt.value}
            onClick={() => setTheme(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <span className={styles.sep} />

      {/* F1 只是入口，不实现下拉菜单——那是 Popover（T4）+ Menu 组合的活 */}
      <button type="button" className={styles.user}>
        <span className={styles.avatar} aria-hidden="true">
          陈
        </span>
        陈运维
      </button>
    </header>
  )
}
