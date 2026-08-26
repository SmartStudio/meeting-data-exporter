import { useState } from 'react'
import type { SystemState } from '@/api/types'
import { useTheme, type Theme } from '@/theme/useTheme'
import { isProtoMode } from './proto'
import { SYSTEM_STATE_OPTIONS, useSystemState } from './SystemStatus'
import UserMenu from './UserMenu'
import styles from './GlobalBar.module.css'

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/**
 * 原型脚手架（「原型 · 全部数字为示例」标记与系统状态下拉）默认不出现在界面里：
 * 它们演示的是五种系统形态，是开发与截图工具，不是给运维人员用的产品功能。
 *
 * 藏起来而不是删掉，是因为这个下拉仍是两件事的唯一入口：`scripts/a11y-check.ts`
 * 靠它驱动 NAS 断连 / 腾讯不可达 / 加载失败 / 加载中 / 空态这五个无障碍检查场景；
 * 它也是唯一能把这些形态调出来看一眼的办法（真实后端很难按需坏给你看）。
 *
 * 判断本身搬去了 `app/proto.ts`：F0 之后它有三个消费者（顶栏、系统状态条、
 * 左栏摘要），因为**只有原型模式才读这个下拉，默认路径读真实端点**——
 * 这条分界线散在三个文件里各写一遍，迟早有一处漏掉。
 *
 * 在自己这层冻结取值（`useState` 的初始化函数只跑一次）：中途不会切换。
 */
function useProtoControls(): boolean {
  const [on] = useState(() => isProtoMode())
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

      {/* 账号名、角色、改密码、退出登录都在这里（spec §11 缺口 1 / 5）。
          F1 那个写死「陈运维」的占位按钮已经换掉了——写死的名字在一个
          多人共用的运维面板上，是一句每次都在骗人的话。 */}
      <UserMenu />
    </header>
  )
}
