import { Outlet } from 'react-router-dom'
import GlobalBar from './GlobalBar'
import Rail from './Rail'
import ShortcutBar from './ShortcutBar'
import SystemStatus from './SystemStatus'
import styles from './AppShell.module.css'

/**
 * 布局外壳：左栏 + 顶栏 + 系统状态告警条 + 路由出口 + 底部快捷键条。
 * 系统状态本身不在这里管理——由外层的 `SystemStateProvider`（`App.tsx`）
 * 下发，`AppShell` 及其子组件只是消费者。
 */
export default function AppShell() {
  return (
    <div className={styles.shell}>
      <Rail />
      <div className={styles.main}>
        <GlobalBar />
        <SystemStatus />
        <div className={styles.view}>
          <Outlet />
        </div>
      </div>
      <ShortcutBar />
    </div>
  )
}
