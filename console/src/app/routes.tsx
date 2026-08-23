import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom'
import Placeholder, { MeetingsPlaceholder } from '@/pages/_Placeholder'
import AppShell from './AppShell'

/**
 * 七条路由，`AppShell` 是唯一的父路由元素（左栏/顶栏/系统状态/快捷键条
 * 都在它里面，`Outlet` 是唯一变化的部分）。
 *
 * 导出 `routes`（数据）而不只是导出建好的 router 实例，是因为测试要用
 * `createMemoryRouter(routes, {...})` 重新装一个内存路由——`shell.test.tsx`
 * 用得到。
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/meetings" replace /> },
      { path: 'meetings', element: <MeetingsPlaceholder /> },
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
