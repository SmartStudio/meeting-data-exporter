import { RouterProvider } from 'react-router-dom'
import { SystemStateProvider } from './app/SystemStatus'
import { router } from './app/routes'

/**
 * `SystemStateProvider` 包在路由外面：系统状态是跨页面的，七条路由的每一页
 * 都要能读到它（`useSystemState()` / `useMeetings()`），不是某一页私有的。
 */
export default function App() {
  return (
    <SystemStateProvider>
      <RouterProvider router={router} />
    </SystemStateProvider>
  )
}
