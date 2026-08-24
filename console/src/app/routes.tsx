import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom'
import LoginPage from '@/pages/Login'
import MeetingsPage from '@/pages/Meetings'
import Placeholder from '@/pages/_Placeholder'
import AppShell from './AppShell'

/**
 * 八条路由。`AppShell` 是除 `/login` 之外七条路由共同的父路由元素（左栏/顶栏/
 * 系统状态/快捷键条都在它里面，`Outlet` 是唯一变化的部分）。`/login` 刻意
 * 是 `/` 的兄弟节点、不挂在 `AppShell` 底下——登录页没有左栏/顶栏，且它必须
 * 在“判断有没有登录”这件事本身完成之前就能渲染，不能反过来依赖 `AppShell`
 * 的登录态检查（`AppShell` 未登录时会整个 `<Navigate>` 到这里，见其内部实现）。
 *
 * 导出 `routes`（数据）而不只是导出建好的 router 实例，是因为测试要用
 * `createMemoryRouter(routes, {...})` 重新装一个内存路由——`shell.test.tsx`
 * 用得到。
 */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/meetings" replace /> },
      { path: 'meetings', element: <MeetingsPage /> },
      { path: 'consumers', element: <Placeholder title="采集授权" phase="F4" /> },
      { path: 'rules', element: <Placeholder title="自动规则" phase="F3" /> },
      { path: 'jobs', element: <Placeholder title="定时任务" phase="F5" /> },
      { path: 'storage', element: <Placeholder title="归档存储" phase="F5" /> },
      { path: 'audit', element: <Placeholder title="操作审计" phase="F5" /> },
      { path: 'preview/:id', element: <Placeholder title="内容预览" phase="F6" /> },
    ],
  },
]

export const router = createBrowserRouter(routes)
