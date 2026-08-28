import { useLocation } from 'react-router-dom'
import styles from './ShortcutBar.module.css'

/**
 * 底部快捷键条。**内容按路由决定，只印这一页真的会响应的键。**
 *
 * 在这之前它是九条硬编码提示，挂在每一个页面上，而全应用只有会议记录页
 * （`pages/Meetings/index.tsx`，经由 `lib/keys.ts`）接了键盘。于是在归档存储页
 * 上，这条栏一边显示「空格 选中」「/ 搜索」，一边这一页既没有可选中的行也没有
 * 搜索框——九组里七组是死的。一条常驻的假承诺比没有提示更糟：它教出来的肌肉
 * 记忆每一次都会落空，而用户只会以为是自己按错了。
 *
 * 两条被删掉的，都是删掉而不是搬走：
 *   - `⌘K 全局搜索`：`resolveMeetingKey` 对带修饰键的按键一律返回 null，全应用
 *     没有任何一处监听 ⌘K。顶栏那颗搜索按钮同样是个还没接线的入口（见
 *     `GlobalBar.tsx`），但它至少是一个看得见的控件，而这里是一句纯承诺。
 *   - `Esc 关闭当前浮层`：这条**是真的**（`ui/Overlay` 每层都听 Esc），但它只在
 *     浮层开着的时候成立，而浮层一开就盖在这条栏上面。把一条条件性的提示钉在
 *     页面底部常驻，等于在没有浮层的 99% 时间里印一句没有对象的话。
 *
 * 为什么留常驻条、没有收进 `?` 浮层：`?` 浮层要先让人知道有 `?`，而这些键位在
 * 会议表格里没有任何别的露出——那条栏本身就是它们唯一的发现入口。收进浮层等于
 * 把唯一的入口藏到另一个同样需要被发现的键后面。至于那 28px 的代价，按路由取
 * 内容之后它只在会议记录页发生，而告状的那一页（归档存储，四颗按钮里两颗是
 * 破坏性操作）现在整条不渲染，`AppShell` 也不再为它保留底部留白。
 *
 * `aria-hidden`：纯提示，键位本身在页面上都有对应的控件，不需要重复进读屏。
 */
export interface ShortcutKey {
  /** 印在屏幕上的键名（中文键用中文写：「空格」不是「Space」）。 */
  shown: string
  /**
   * 对应的 `KeyboardEvent.key`。它不是给渲染用的，是给测试用的：拿它逐个去问
   * `resolveMeetingKey`，就能钉住「印在屏幕上的每一个键都真的有人接」——这正是
   * 原来那份硬编码列表烂掉的方式（键位表改了，提示条没跟着改，没人看得出来）。
   */
  key: string
}

export interface ShortcutHint {
  keys: ShortcutKey[]
  label: string
}

/** 会议记录页的七组。逐条对应 `lib/keys.ts` 的 `resolveMeetingKey`。 */
const MEETINGS: ShortcutHint[] = [
  { keys: [{ shown: 'j', key: 'j' }, { shown: 'k', key: 'k' }], label: '上下移动' },
  { keys: [{ shown: '空格', key: ' ' }], label: '选中' },
  { keys: [{ shown: '回车', key: 'Enter' }], label: '打开详情' },
  {
    keys: [
      { shown: '1', key: '1' },
      { shown: '2', key: '2' },
      { shown: '3', key: '3' },
    ],
    label: '拉取 / 归档 / 授权',
  },
  { keys: [{ shown: 'e', key: 'e' }], label: '延长保留' },
  { keys: [{ shown: 'p', key: 'p' }], label: '预览内容' },
  { keys: [{ shown: '/', key: '/' }], label: '搜索' },
]

/**
 * 这条路由印哪些键。**没有条目的路由返回空数组，调用方据此整条不渲染**——
 * 不要退化成一条空栏占着 28px。
 *
 * 纯函数、单独导出：`AppShell` 要用它决定内容区底部留不留白，测试也能直接对着
 * 一张路由表逐条断言，不用先搭一棵 DOM（跟 `lib/keys.ts` 把 `resolveMeetingKey`
 * 从 `useMeetingKeys` 里分出来是同一个理由）。
 *
 * 新增一页要上快捷键，改这里之前先改那一页——这张表描述的是既成事实，
 * 不是待办清单。
 */
export function shortcutsFor(pathname: string): ShortcutHint[] {
  // 末尾斜杠归一化：`/meetings/` 和 `/meetings` 是同一页
  const path = pathname.replace(/\/+$/, '') || '/'
  return path === '/meetings' ? MEETINGS : []
}

export default function ShortcutBar() {
  const { pathname } = useLocation()
  const hints = shortcutsFor(pathname)
  if (hints.length === 0) return null

  return (
    <div className={styles.bar} aria-hidden="true">
      {hints.map((item) => (
        <span key={item.label} className={styles.item}>
          {item.keys.map((k) => (
            <kbd key={k.key} className={styles.kbd}>
              {k.shown}
            </kbd>
          ))}
          {item.label}
        </span>
      ))}
    </div>
  )
}
