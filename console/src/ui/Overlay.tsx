import { useEffect, useId, useRef } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import styles from './Overlay.module.css'

/**
 * 浮层基座。Drawer / Popover / Sheet / Toast 都套这一层，三件事必须一起做对
 * （design-system.md §5.1）：
 *
 * 1. **inert，不是 hidden。** `opacity:0` 和 `transform:translateX(100%)` 都
 *    **不会**把元素移出 Tab 序列或无障碍树——原型修复前，页面 200 个可聚焦
 *    元素里有 44 个是看不见的，其中包括登录之后仍能 Tab 到、仍会被读屏念出来
 *    的「账号 / 密码 / 登录」。`inert` 只切交互与无障碍树、不影响绘制，所以
 *    退场动画能照常播完。
 *
 *    React 19 支持把 `inert` 当布尔 prop 渲染，这里直接算成 `!open` 即可。
 *    **不要**照搬原型里那个盯 `data-show` 的 `MutationObserver`——那是给静态
 *    HTML 打的补丁；React 里浮层的开关本来就是 state，属性直接从 state 派生。
 *
 * 2. **焦点要还回去。** 打开时记住 `document.activeElement`，关闭时还原。
 *    不还的话，关掉抽屉后焦点掉到 body，再按 Tab 会从页首重新开始。
 *
 * 3. **Esc 关闭要就近。** 多层浮层时只关最上面那层，用一个模块级栈判断
 *    「我是不是当前最上面那个」。
 *
 * Overlay 本身不做视觉造型（唯一例外是可选的遮罩 `scrim`）——定位、进场方向
 * 由 Drawer / Popover / Sheet / Toast 各自的 CSS 通过 `className` 叠加，四者
 * 共用的只是这份交互契约。
 */

export type OverlayRole =
  | 'dialog'
  | 'alertdialog'
  | 'status'
  | 'region'
  // 菜单/列表这类弹出层用 APG 更精确的角色，不是所有 Popover 都该是 dialog——
  // 加在这里而不是让调用方直接写字符串，两个都留在受控的枚举里。
  | 'menu'
  | 'listbox'

export interface OverlayProps {
  /** 浮层是否处于打开态。false 时整块 inert，但仍然挂载，好让退场动画播完。 */
  open: boolean
  /** 关闭意图上报（Esc / 点遮罩 / 内部按钮）。浮层自己不持有 open 状态。 */
  onClose: () => void
  children: ReactNode
  /** 无障碍角色，默认 'dialog'。Toast 用 'status'（不打断，礼貌播报）。 */
  role?: OverlayRole
  /** 没有可见标题时用它做 aria-label。 */
  label?: string
  /** 有可见标题时优先用它（指向标题元素的 id）。 */
  labelledBy?: string
  /** 是否是严格意义的模态（aria-modal）。Toast/Popover 常传 false。 */
  modal?: boolean
  /** 打开时是否把焦点移进浮层。Toast 传 false——它不抢焦点。 */
  autoFocus?: boolean
  /** 关闭时是否把焦点还给触发元素。 */
  restoreFocus?: boolean
  /** 是否在浮层内循环 Tab，不让焦点跑到底层页面。 */
  trapFocus?: boolean
  /** 是否监听 Esc 并请求关闭。 */
  closeOnEsc?: boolean
  /** 是否渲染一层遮罩（Drawer/Sheet 用，Popover/Toast 不用）。 */
  scrim?: boolean
  /** 点遮罩时的关闭意图；不传则退回 onClose。 */
  onScrimClick?: () => void
  /**
   * 无论 open 为何都强制 inert——用于「可见但不该被 Tab 到」的场景，
   * 目前只有 Toast 没有动作按钮时会用（design-system.md「Toast 例外」）。
   */
  forceInert?: boolean
  /** 打开时的初始聚焦目标；不传则聚焦面板内第一个可聚焦元素，再退到面板本身。 */
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
  style?: CSSProperties
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 面板内当前「够格被 Tab 到」的元素。特意不用 `offsetParent`/`offsetWidth`
 * 判断可见性——jsdom 不跑布局，这类属性恒为假值，会把测试环境下的一切都
 * 判成不可见。可见性由 inert/hidden/aria-hidden 这些语义属性负责，不是
 * 这里该管的事。
 *
 * 排除 `[hidden]` 祖先和 `input[type="hidden"]`——本任务当前的用例都不会
 * 触发（浮层内容不会自己再嵌一层 `[hidden]`），但既然 `[inert]`/
 * `aria-hidden` 都排了，留这两个漏洞没有理由，加固成本也是一行。
 */
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.closest('[inert]') &&
      !el.closest('[hidden]') &&
      el.getAttribute('aria-hidden') !== 'true',
  )
}

/**
 * 当前打开的浮层栈，模块级、跨实例共享——Esc 只关最上面那层。
 *
 * 「最上面」按 DOM 嵌套判定，**不是按 push 顺序**：React 的 passive effect
 * 是子先于父触发的（子组件先挂载完成）。两个浮层若在同一次渲染里同时以
 * open=true 挂载（比如一段初始就展开的抽屉套着一段初始就展开的弹出层），
 * 内层的注册 effect 会先于外层跑，push 顺序反而是「先内后外」——如果拿
 * push 顺序当「谁在最上面」，会把外层错判成最上面那层。已经用一个专门的
 * 探针测试验证过这个触发顺序（bottom-up），不是猜测。
 *
 * 判定规则：候选里「不包含任何其他候选」的就是最内层；多个互不嵌套的候选
 * （并列的独立浮层）时，退回「最后打开的那个」。
 */
let stack: Array<{ id: string; node: HTMLElement }> = []

function topmostId(): string | undefined {
  const inner = stack.filter((a) => !stack.some((b) => b !== a && a.node.contains(b.node)))
  return inner[inner.length - 1]?.id
}

export function Overlay(props: OverlayProps) {
  const {
    open,
    onClose,
    children,
    role = 'dialog',
    label,
    labelledBy,
    modal = true,
    autoFocus = true,
    restoreFocus = true,
    trapFocus = true,
    closeOnEsc = true,
    scrim = false,
    onScrimClick,
    forceInert = false,
    initialFocusRef,
    className,
    style,
  } = props

  const id = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // 最新的 onClose，给下面两个 effect 用，避免把 onClose 放进 deps——
  // 调用方传的多半是每次渲染都新建的箭头函数，放进 deps 会导致 Esc 监听器
  // 和栈频繁重挂。
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // 打开时把焦点移进浮层、记住触发元素；关闭（或卸载）时把焦点还回去。
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    if (autoFocus) {
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      const target = initialFocusRef?.current ?? getFocusable(panel)[0] ?? panel
      target.focus()
    }
    return () => {
      if (restoreFocus) {
        previouslyFocusedRef.current?.focus()
      }
    }
    // autoFocus/restoreFocus/initialFocusRef 是调用方给定的静态配置，
    // 特意不放进 deps——这个 effect 只该在「打开态」翻转时重跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Esc 关闭：就近，只关最上面那层（判定见 topmostId 上的注释）。
  useEffect(() => {
    if (!open || !closeOnEsc) return
    const panel = panelRef.current
    if (!panel) return
    stack.push({ id, node: panel })
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (topmostId() !== id) return
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      stack = stack.filter((x) => x.id !== id)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, closeOnEsc, id])

  // Tab 在浮层内循环，不让焦点跑到底层页面。只处理「从最后一个绕回第一个」
  // 和「从第一个反绕到最后一个」这两条边界——中间的 Tab 移动交给浏览器原生
  // 顺序，不需要介入。
  useEffect(() => {
    if (!open || !trapFocus) return
    const panel = panelRef.current
    if (!panel) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusables = getFocusable(panel)
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    panel.addEventListener('keydown', onKeyDown)
    return () => panel.removeEventListener('keydown', onKeyDown)
  }, [open, trapFocus])

  const isDialogLike = role === 'dialog' || role === 'alertdialog'

  return (
    <>
      {scrim && (
        <div
          className={styles.scrim}
          data-state={open ? 'open' : 'closed'}
          aria-hidden="true"
          onClick={() => (onScrimClick ?? onClose)()}
        />
      )}
      <div
        ref={panelRef}
        role={role}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-modal={modal && isDialogLike ? true : undefined}
        tabIndex={-1}
        data-state={open ? 'open' : 'closed'}
        // Toast 没有动作按钮时整块都不该被 Tab 到，即使它可见——forceInert
        // 独立于 open 生效，不能只看「是否可见」。
        inert={forceInert || !open}
        className={[styles.root, className].filter(Boolean).join(' ')}
        style={style}
      >
        {children}
      </div>
    </>
  )
}
