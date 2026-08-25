import { useState } from 'react'
import type { SystemState } from '@/api/types'
import { useTheme, type Theme } from '@/theme/useTheme'
import { SYSTEM_STATE_OPTIONS, useSystemState } from './SystemStatus'
import styles from './GlobalBar.module.css'

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/** `?proto=1` 记在这个键下。导出是为了让测试跟着常量走，不各写一份字面量。 */
export const PROTO_STORAGE_KEY = 'mde.proto'

/**
 * 原型脚手架（「原型 · 全部数字为示例」标记与系统状态下拉）默认不出现在界面里：
 * 它们演示的是五种系统形态，是 F1 阶段的开发工具，不是给运维人员用的产品功能。
 *
 * 藏起来而不是删掉，是因为这个下拉目前仍是两件事的唯一入口：`scripts/a11y-check.ts`
 * 靠它驱动 NAS 断连 / 腾讯不可达 / 加载失败 / 加载中 / 空态这五个无障碍检查场景；
 * 在阶段 4 接上真实数据之前，它也是唯一能把这些形态调出来看一眼的办法。删了这两样
 * 都会跟着没。等 A2 让真实数据能驱动这些形态之后，这段连同 SystemStatus 一起可以撤。
 *
 * 认了 `?proto=1` 之后记进 sessionStorage：否则点一下左栏换个页面参数就掉了，
 * 控件跟着消失，看起来像 bug 而不是设计。
 */
function useProtoControls(): boolean {
  const [on] = useState(() => {
    const inUrl = new URLSearchParams(window.location.search).get('proto') === '1'
    try {
      if (inUrl) sessionStorage.setItem(PROTO_STORAGE_KEY, '1')
      return inUrl || sessionStorage.getItem(PROTO_STORAGE_KEY) === '1'
    } catch {
      // 隐私模式 / 禁用站点数据时 sessionStorage 会抛，退回只认当前 URL
      return inUrl
    }
  })
  return on
}

/**
 * 顶栏。产品名放在左栏顶部（见 `Rail.tsx`，跟原型截图一致），这里是原型
 * `.gbar` 剩下的那部分：全局搜索入口、主题切换、用户菜单，以及默认隐藏的
 * 原型脚手架（见 `useProtoControls`）。
 */
export default function GlobalBar() {
  const { state, setState } = useSystemState()
  const { theme, setTheme } = useTheme()
  const proto = useProtoControls()

  return (
    <header className={styles.gbar}>
      {proto && (
        <>
          <span className={styles.protoTag}>原型 · 全部数字为示例</span>

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
        </>
      )}

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
