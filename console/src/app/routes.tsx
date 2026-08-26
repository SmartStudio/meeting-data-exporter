import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom'
import LoginPage from '@/pages/Login'
import MeetingsPage from '@/pages/Meetings'
import ConsumersPage from '@/pages/Consumers'
import RulesPage from '@/pages/Rules'
import JobsPage from '@/pages/Jobs'
import StoragePage from '@/pages/Storage'
import AuditPage from '@/pages/Audit'
import PreviewPage from '@/pages/Preview'
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
 *
 * **这张表在地基阶段（F0）一次性指到真实页面组件，此后不再改。** 原来的
 * `_Placeholder` 已经删掉：七个页面任务并行开工，如果它们各自回来改这一行，
 * 这个文件就是必然的冲突点（阶段 4 在 `src/http/router.ts` 上已经栽过一次，
 * 手工合并两次吃掉花括号）。现在每个任务只碰 `pages/<自己>/`。
 */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/meetings" replace /> },
      { path: 'meetings', element: <MeetingsPage /> },
      { path: 'consumers', element: <ConsumersPage /> },
      { path: 'rules', element: <RulesPage /> },
      { path: 'jobs', element: <JobsPage /> },
      { path: 'storage', element: <StoragePage /> },
      { path: 'audit', element: <AuditPage /> },
      // 内容预览不占左栏导航（spec.md §3），入口是会议记录页上的会议标题
      { path: 'preview/:id', element: <PreviewPage /> },
    ],
  },
]

export const router = createBrowserRouter(routes)
