import { createContext, useContext } from 'react'

/**
 * 系统健康状态的 **context 与读取口**，与渲染它的那条告警条分开放。
 *
 * ## 为什么要单独一个文件
 *
 * 读这个 context 的除了外壳（`app/SystemStatus.tsx`、`app/Rail.tsx`），随时可能是某个
 * **页面**；而 `app/SystemStatus.tsx` 里同时装着那条告警条组件和它的
 * `SystemStatus.module.css`。页面为了读一个 context，就得连那份 CSS 一起拖进模块图
 * ——而 **CSS Module 在打包产物里的先后顺序就是模块图的遍历顺序**，于是「某个页面
 * 多 import 了一个 hook」会改变全站样式的注入次序。
 *
 * 这不是假想：定时任务页曾为了判断「顶栏是不是已经在说拉取连续失败」import 过这里的
 * 一个 hook（那条判断后来随全局横幅上的这一句一起去掉了，见 `SystemStatus.tsx`），
 * 它一度写成从 `app/SystemStatus` 取，**会议记录页**的对比度检查当场变红（`ui/Table`
 * 那四层渐变背景与卡片形态下的底色调了个个儿，门槛判不出底色）。两次干净复现、
 * 切掉那一行就恢复。改动的文件里没有一个属于会议记录页。
 *
 * 所以这个文件**不许 import 任何 `.css`**，也不该长出组件。它只放类型、context
 * 和读它的 hook——页面要读系统状态就从这里取，样式顺序不会因此变动。
 */

/**
 * 状态条与左栏摘要要显示的那一件事。
 *
 * 拆成一个显式的联合而不是几个布尔，是为了让"读不到"有自己的取值：
 * `unreadable` 与 `none` 必须分得开——**拿不到状态时显示"未知"，
 * 不许默认成"正常"**（计划 §1 全局约束第 2 条）。
 */
export type SystemAlert =
  /** 一切正常，或者数据三态（loading/load-failed/empty，出口在页面内容区） */
  | { kind: 'none' }
  /** 首次探测还没回来 */
  | { kind: 'checking' }
  /** 系统状态本身读不到（后端不可达 / 响应形状不对）。**不是"正常"** */
  | { kind: 'unreadable'; detail: string }
  /** `GET /api/v1/admin/storage` 的 `nas.reachable === false` */
  | { kind: 'nas-down'; error: string | null; pendingMeetings: number | null }
  /** 从 `fetch_recordings` 的最近运行**推断**出来的"拉不通"。措辞见 SystemStatus.tsx */
  | { kind: 'fetch-stalled'; streak: number; label: string }
  /** 任务清单里没有 `fetch_recordings`——推不出来，也不许当成正常 */
  | { kind: 'fetch-unknown' }

export interface SystemStatusView {
  alert: SystemAlert
  /** 需要人处理的失败项总数；读不到时是 `null`——`0` 是"没有失败"，不是同一件事 */
  openFailures: number | null
  /** 失败项里最近一次失败的时间；读不到或没有失败项都是 `null`。左栏红点拿它和「看过」的记号比（`failuresSeen.ts`） */
  newestFailedAt: number | null
  retry: () => void
}

export const SystemStatusContext = createContext<SystemStatusView | null>(null)

/**
 * 状态条与左栏摘要都读它。**只有 `AppShell` 之下才有**——七条路由的每一页
 * 都在它底下，登录页刻意不在（那时还没有会话，发请求只会拿到 401）。
 */
export function useSystemStatusView(): SystemStatusView {
  const ctx = useContext(SystemStatusContext)
  if (!ctx) throw new Error('useSystemStatusView 必须在 SystemHealthProvider 内使用')
  return ctx
}
