import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { fetchAdminIdentity } from '@/api/admin'
import { setUnauthorizedHandler } from '@/api/client'
import { useResource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { Skeleton } from '@/ui/Skeleton'
import GlobalBar, { TopBarSlotProvider } from './GlobalBar'
import Rail from './Rail'
import { SessionProvider, type LoginNavState } from './session'
import ShortcutBar, { shortcutsFor } from './ShortcutBar'
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
 *   - ready 且 `signedIn: false`（未登录，`fetchAdminIdentity` 把 401 转成了
 *     这个值）：整体导航到 `/login`，带上原本想去的路径（登录成功后 Login 页
 *     用它跳回来）**以及这次是不是「登录被判失效」**——后者要在登录页上说出来，
 *     否则一个以为自己登着的人被静静地弹到空表单前，只会认为系统坏了
 *   - ready 且拿到身份：正常渲染外壳 + `<Outlet />`
 *   - error（401 以外的网络错误）：复用 `Meetings` 页对 `load-failed` 的
 *     呈现方式（标题 + 说明 + 重试按钮），不是空白页——`AppShell` 目前没有
 *     自己的错误态，这是新加的
 */
export default function AppShell() {
  const location = useLocation()
  const probe = useResource(() => fetchAdminIdentity(), [])

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
    // 这一支的信息是确凿的：刚才还在用，某条请求回了 401。带上 expired，
    // 登录页才说得出「你为什么突然站在这儿」。
    const state: LoginNavState = { from: location.pathname, expired: true }
    return <Navigate to="/login" state={state} replace />
  }

  if (probe.state === 'loading') {
    return (
      <div className={styles.authGate} data-testid="admin-auth-loading">
        <Skeleton width="70%" />
        <Skeleton width="45%" size="sm" />
      </div>
    )
  }

  if (probe.state === 'error') {
    return (
      <div className={styles.authGate} data-testid="admin-auth-error">
        <h2 className={styles.authGateTitle}>登录状态读取失败</h2>
        <p className={styles.authGateText}>{probe.error.message}</p>
        <Button variant="primary" onClick={probe.retry}>
          重试
        </Button>
      </div>
    )
  }

  if (!probe.data.signedIn) {
    // `rejected` 区分「从来没登录过」与「带着一张令牌被服务端拒了」。
    // 两者落在同一张空表单前，只有后者需要一句解释（见 LoginNavState.expired）。
    const state: LoginNavState = { from: location.pathname, expired: probe.data.rejected }
    return <Navigate to="/login" state={state} replace />
  }

  // `SystemHealthProvider` 在登录态确认**之后**才挂：它要发两条真实的 admin
  // 请求，没有会话时发出去只会拿到 401，然后触发上面那个全局出口——
  // 一次本来不需要发生的跳转。
  // `SessionProvider` 包在最外层：角色决定了下面每一个写入口画成什么样
  // （`app/session.tsx` 说明了为什么"没有 Provider"必须落到只读一侧）。

  // 底部留白只在真的有快捷键条的那一页给。它是 `position: fixed`，不给留白就
  // 会盖住内容区最后一行——归档存储页首屏被盖掉的正是「立即清理已到期文件」
  // 与「暂停到期清理」两颗破坏性按钮的下半截。反过来，在不渲染它的五个页面上
  // 继续留 72px，就是为一条不存在的东西空出一屏的底部。
  const hasShortcuts = shortcutsFor(location.pathname).length > 0

  return (
    <SessionProvider identity={probe.data.identity}>
      <SystemHealthProvider>
        <div className={styles.shell}>
          <Rail />
          <div className={styles.main}>
            {/* 顶栏插槽（页面标题旁边的一句话计数 + 主操作）：`GlobalBar`
                在这一层读，`<Outlet />` 底下的页面组件用 `useTopBarSlot()`
                在这一层写，两者是兄弟，所以 Provider 包在两者共同的父节点上
                （见 `GlobalBar.tsx` 顶部关于两层 Context 的说明）。 */}
            <TopBarSlotProvider>
              <GlobalBar />
              <SystemStatus />
              {/* 唯一的 <main>：一页只能有一个，所以它在外壳这一层，
                  页面自己用 PageShell 的 <section aria-labelledby> */}
              <main className={hasShortcuts ? `${styles.view} ${styles.viewWithBar}` : styles.view}>
                <Outlet />
              </main>
            </TopBarSlotProvider>
          </div>
          <ShortcutBar />
        </div>
      </SystemHealthProvider>
    </SessionProvider>
  )
}
