import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { SystemState } from '@/api/types'
import { isProtoMode } from './proto'
import { NAV_ITEMS } from './Rail'
import { SYSTEM_STATE_OPTIONS, useSystemState } from './SystemStatus'
import UserMenu from './UserMenu'
import styles from './GlobalBar.module.css'

/* ══════════════════════════════════════════════════════════════════
   顶栏插槽：页面把「一句话计数」与「主操作」递给顶栏
   ══════════════════════════════════════════════════════════════════

   顶栏自己不知道「9 场」「12 条 · 3 条有问题」这些数字，也不知道每一页的主
   操作长什么样——这些都是页面内容自己的事（六个页面各自拉自己的列表）。
   所以这里开一个插槽：页面用 `useTopBarSlot()` 把这两样东西交上来，
   `GlobalBar` 只管照单渲染。地基这一侧只提供机制，接线是每一页自己的活。

   拆成两层 Context 而不是一层 `{ slot, setSlot }`，是为了不让"写插槽"的那一页
   也订阅到"插槽内容变了"：如果两者合在一个 Context 对象里，`useMemo` 每次
   `slot` 变化都会造一个新的 context value，写入方自己也是这个 Context 的
   订阅者（`useContext` 拿 `setSlot` 时顺带订阅了），于是它自己也会因为自己
   刚写的那次更新而重渲染，`useEffect` 的依赖里又带着这个新 value，再写一遍——
   死循环。`setSlot`（`useState` 的 dispatch）本身天生跨渲染稳定，单独一层
   Context 传它，写入方永远不会因为"插槽内容变了"这件事被拉着重渲染。 */

export interface TopBarSlot {
  /** 标题下面那句一句话计数，例如「9 场」「12 条 · 3 条有问题」。
   *  页面答不出真实数字就别调这个 hook 的这个字段——顶栏没有就不显示，
   *  不编一个数字出来。 */
  subtitle?: ReactNode
  /** 页面主操作（按钮 / 按钮组），画在顶栏头像左边。 */
  actions?: ReactNode
}

const EMPTY_SLOT: TopBarSlot = {}

const TopBarSlotValueContext = createContext<TopBarSlot>(EMPTY_SLOT)
const TopBarSlotSetterContext = createContext<(slot: TopBarSlot) => void>(() => {})

/**
 * 包住「顶栏 + 路由出口」的那一段（`AppShell.tsx`）。页面组件在 `<Outlet />`
 * 里，顶栏在它旁边——两者是兄弟，都在这一层 Provider 底下。
 */
export function TopBarSlotProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<TopBarSlot>(EMPTY_SLOT)
  return (
    <TopBarSlotSetterContext.Provider value={setSlot}>
      <TopBarSlotValueContext.Provider value={slot}>{children}</TopBarSlotValueContext.Provider>
    </TopBarSlotSetterContext.Provider>
  )
}

/**
 * 页面组件调用它，把自己的「一句话计数」「主操作」交给顶栏。
 *
 * 用法（例如会议记录页）：
 *
 * ```tsx
 * useTopBarSlot({
 *   subtitle: `${total} 场`,
 *   actions: (
 *     <>
 *       <Button variant="quiet">导出清单</Button>
 *       <Button variant="primary">批量授权</Button>
 *     </>
 *   ),
 * })
 * ```
 *
 * 挂载时写入，卸载时清空——离开这一页之后顶栏不会留着上一页的按钮。
 * 依赖数组精确到 `subtitle`/`actions` 本身，路由没变但内容变了（比如列表数字
 * 刷新）也会跟着更新，不用页面自己再包一层 `useMemo`。
 */
export function useTopBarSlot(slot: TopBarSlot): void {
  const setSlot = useContext(TopBarSlotSetterContext)
  const { subtitle, actions } = slot
  useEffect(() => {
    setSlot({ subtitle, actions })
    return () => setSlot(EMPTY_SLOT)
  }, [setSlot, subtitle, actions])
}

function useTopBarSlotValue(): TopBarSlot {
  return useContext(TopBarSlotValueContext)
}

/* ══════════════════════════════════════════════════════════════════
   顶栏标题：从路由派生，和左栏导航同一份文案
   ══════════════════════════════════════════════════════════════════ */

/**
 * 不占左栏导航、但仍在 `AppShell` 底下的那几条路由（spec.md §3：内容预览从
 * 会议记录页点标题进入，不是第七个导航项）。标题各写各的，不会跟 `NAV_ITEMS`
 * 冲突——那六个字符串的"唯一一份"守的是导航项与顶栏标题之间不要各写一遍，
 * 不覆盖这类压根不在导航里的路由。
 */
const EXTRA_TITLES: Array<{ prefix: string; label: string }> = [{ prefix: '/preview', label: '内容预览' }]

function titleForPath(pathname: string): string {
  const nav = NAV_ITEMS.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))
  if (nav) return nav.label
  const extra = EXTRA_TITLES.find((item) => pathname.startsWith(item.prefix))
  return extra?.label ?? ''
}

/**
 * 原型脚手架（「原型 · 全部数字为示例」标记与系统状态下拉）默认不出现在界面里：
 * 它们演示的是五种系统形态，是开发与截图工具，不是给运维人员用的产品功能。
 *
 * 藏起来而不是删掉，是因为这个下拉仍是两件事的唯一入口：`scripts/a11y-check.ts`
 * 靠它驱动 NAS 断连 / 腾讯不可达 / 加载失败 / 加载中 / 空态这五个无障碍检查场景；
 * 它也是唯一能把这些形态调出来看一眼的办法（真实后端很难按需坏给你看）。
 *
 * 判断本身在 `app/proto.ts`：F0 之后它有三个消费者（顶栏、系统状态条、
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
 * 顶栏。三块：
 *
 * - 左：当前页面标题 + 页面给的一句话计数（`useTopBarSlot` 的 `subtitle`）。
 *   标题从路由派生，字面对应 `Rail.tsx` 的 `NAV_ITEMS`，不另抄一份。
 * - 右：页面主操作（`subtitle` 旁边的 `actions`）+ 用户菜单（账号、主题三选、
 *   改密码、退出登录都收在里面，见 `UserMenu.tsx`）。
 * - 只在 `?proto=1` 下多出的原型工具（见 `useProtoControls`），紧挨着用户菜单，
 *   不再单独占顶栏最左——那个位置现在是页面标题的。
 *
 * 这里曾经把「浅色 / 深色 / 跟随系统」三选放在顶栏最贵的右上角，一个一年点
 * 一次的设置占着页面标题和主操作都没有的位置。现在挪进了 `UserMenu`。
 */
export default function GlobalBar() {
  const { state, setState } = useSystemState()
  const proto = useProtoControls()
  const { pathname } = useLocation()
  const { subtitle, actions } = useTopBarSlotValue()
  const title = titleForPath(pathname)

  return (
    <header className={styles.gbar}>
      <div className={styles.heading}>
        {title !== '' && (
          <p className={styles.title} data-testid="topbar-title">
            {title}
          </p>
        )}
        {subtitle !== undefined && (
          <p className={styles.subtitle} data-testid="topbar-subtitle">
            {subtitle}
          </p>
        )}
      </div>

      <span className={styles.spacer} />

      {/* 这里曾经有一颗「搜会议 / 规则 / 程序」按钮，带 ⌘K 徽标，`onClick` 是空的
          ——注释写着「F1 只放入口，不实现真正的全局搜索」。它同时说了两句假话：
          按钮看起来能按，徽标声称有一个全应用没人监听的键位（`lib/keys.ts` 对带
          修饰键的按键一律返回 null）。同一句谎已经从 ShortcutBar 里删掉了。

          删按钮而不是留着当占位：`tests/meetings.test.tsx` 的「不许放一个名字对、
          动作不对的按钮」是这个仓库既有的判据。缺口本身没有丢——登记在
          docs/console/spec.md §11 第 6 行，那份文档自己点名批评过「缺口只活在
          一行代码注释里」。功能做出来的时候把按钮加回来，连同键位绑定。 */}

      {proto && (
        <div className={styles.protoGroup}>
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
        </div>
      )}

      {actions !== undefined && <div className={styles.actions}>{actions}</div>}

      <span className={styles.sep} />

      {/* 账号名、角色、主题三选、改密码、退出登录都在这里（spec §11 缺口 1 / 5）。
          F1 那个写死「陈运维」的占位按钮已经换掉了——写死的名字在一个
          多人共用的运维面板上，是一句每次都在骗人的话。 */}
      <UserMenu />
    </header>
  )
}
