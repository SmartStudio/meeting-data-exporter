import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { fetchAdminIdentity } from '@/api/admin'
import { setUnauthorizedHandler } from '@/api/client'
import { useResource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { Skeleton } from '@/ui/Skeleton'
import GlobalBar from './GlobalBar'
import Rail from './Rail'
import ShortcutBar from './ShortcutBar'
import SystemStatus, { SystemHealthProvider } from './SystemStatus'
import styles from './AppShell.module.css'

/**
 * 布局外壳：左栏 + 顶栏 + 系统状态告警条 + 路由出口 + 底部快捷键条。
 * 系统状态本身不在这里管理——由外层的 `SystemStateProvider`（`App.tsx`）
 * 下发，`AppShell` 及其子组件只是消费者。
 *
 * 挂载时先探一次管理员登录态（Task 6，US-3.4）。`AppShell` 是除 `/login`
 * 外七条路由共同的父元素，守卫放在这一处，就不用在每个页面组件里各自重复。
 * 三态照抄 `useResource` 已有的 loading/error/ready 模式，不另造一套：
 *   - loading：骨架屏（`ui/Skeleton`），不是空白，也不是新发明的 spinner
 *   - ready 且 `data === null`（未登录，`fetchAdminIdentity` 把 401 转成了
 *     这个值）：整体导航到 `/login`，带上原本想去的路径，登录成功后
 *     Login 页用它跳回来
 *   - ready 且拿到身份：正常渲染外壳 + `<Outlet />`
 *   - error（401 以外的网络错误）：复用 `Meetings` 页对 `load-failed` 的
 *     呈现方式（标题 + 说明 + 重试按钮），不是空白页——`AppShell` 目前没有
 *     自己的错误态，这是新加的
 */
export default function AppShell() {
  const location = useLocation()
  const identity = useResource(() => fetchAdminIdentity(), [])

  /**
   * **全局的 401 出口**（计划 §3.1）。33 条 admin 端点里任何一条返回 401，
   * `api/client.ts` 都会抛 `UnauthorizedError` 并回调这里——页面自己不处理它，
   * 也就不用在七个页面里各写一遍跳转。
   *
   * 卸载时注销不是礼貌：不注销的话，组件已经不在了还会有人来改它的 state。
   *
   * `fetchAdminIdentity()` 刻意不走那一层（`api/admin.ts` 的文件头写着理由），
   * 所以"探测登录态"这件事本身不会触发这个出口——否则登录页会把自己重定向到
   * 登录页，死循环。
   */
  const [sessionExpired, setSessionExpired] = useState(false)
  useEffect(() => {
    setUnauthorizedHandler(() => setSessionExpired(true))
    return () => setUnauthorizedHandler(null)
  }, [])

  if (sessionExpired) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  if (identity.state === 'loading') {
    return (
      <div className={styles.authGate} data-testid="admin-auth-loading">
        <Skeleton width="70%" />
        <Skeleton width="45%" size="sm" />
      </div>
    )
  }

  if (identity.state === 'error') {
    return (
      <div className={styles.authGate} data-testid="admin-auth-error">
        <h2 className={styles.authGateTitle}>登录状态读取失败</h2>
        <p className={styles.authGateText}>{identity.error.message}</p>
        <Button variant="primary" onClick={identity.retry}>
          重试
        </Button>
      </div>
    )
  }

  if (identity.data === null) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  // `SystemHealthProvider` 在登录态确认**之后**才挂：它要发两条真实的 admin
  // 请求，没有会话时发出去只会拿到 401，然后触发上面那个全局出口——
  // 一次本来不需要发生的跳转。
  return (
    <SystemHealthProvider>
      <div className={styles.shell}>
        <Rail />
        <div className={styles.main}>
          <GlobalBar />
          <SystemStatus />
          {/* 唯一的 <main>：一页只能有一个，所以它在外壳这一层，
              页面自己用 PageShell 的 <section aria-labelledby> */}
          <main className={styles.view}>
            <Outlet />
          </main>
        </div>
        <ShortcutBar />
      </div>
    </SystemHealthProvider>
  )
}
