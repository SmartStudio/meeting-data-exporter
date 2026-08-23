import { useEffect } from 'react'

/**
 * 会议记录页的键位表（spec.md §9，与底部常驻的快捷键条逐条对应）。
 *
 * 键位解析（`resolveMeetingKey`）与副作用（`useMeetingKeys` 挂监听）分开：
 * 前者是纯函数，能直接对着一张键位表逐条断言，不用先搭一棵 DOM。
 */
export type MeetingKeyAction =
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'toggle-select' }
  | { type: 'open-detail' }
  | { type: 'stage'; stage: 'fetch' | 'archive' }
  | { type: 'open-grant' }
  | { type: 'extend' }
  | { type: 'preview' }
  | { type: 'focus-search' }
  | { type: 'close-overlay' }

/**
 * 焦点是否落在会吞掉字母键的控件里。**在搜索框里打 `j` 必须是打字，不是跳行**
 * ——漏掉这一条，页面上唯一的搜索框就没法用了。
 *
 * `contentEditable` 也算：富文本区域同样在吃字符输入。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** `resolveMeetingKey` 只需要键盘事件的这几个字段——测试可以直接喂一个字面量。 */
export interface MeetingKeyEvent {
  key: string
  target?: EventTarget | null
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/**
 * 把一次按键翻译成动作，翻译不出来就返回 `null`（调用方不要 preventDefault）。
 *
 * 两条规矩写在这里而不是散在调用点：
 * 1. **带修饰键（⌘ / Ctrl / Alt）的一律不接管**——`⌘K` 是全局搜索，
 *    `⌘F` 是浏览器查找，把它们抢过来会砸掉用户既有的肌肉记忆。
 * 2. **焦点在输入类控件里时只放行 `Esc`**——其余全部还给输入框。
 */
export function resolveMeetingKey(e: MeetingKeyEvent): MeetingKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null

  // Esc 不受"正在打字"限制：输入框里按 Esc 也该关掉当前浮层。
  if (e.key === 'Escape') return { type: 'close-overlay' }

  if (isTypingTarget(e.target ?? null)) return null

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      return { type: 'move', delta: 1 }
    case 'k':
    case 'ArrowUp':
      return { type: 'move', delta: -1 }
    case ' ':
      return { type: 'toggle-select' }
    case 'Enter':
      return { type: 'open-detail' }
    case '1':
      return { type: 'stage', stage: 'fetch' }
    case '2':
      return { type: 'stage', stage: 'archive' }
    case '3':
      return { type: 'open-grant' }
    case 'e':
      return { type: 'extend' }
    case 'p':
      return { type: 'preview' }
    case '/':
      return { type: 'focus-search' }
    default:
      return null
  }
}

export interface MeetingKeysOptions {
  /**
   * 浮层打开时置 false：j/k/空格 这些行操作不该穿透到底层表格去。
   * `Esc` 不受它影响，始终放行——不然浮层打开时反而关不掉。
   */
  enabled?: boolean
}

/**
 * 把键位表接到 `document` 上。
 *
 * `Esc` 特意**不** `preventDefault`：浮层基座（`ui/Overlay`）自己也听 Esc，
 * 由它决定"就近关最上面那层"。这里返回 `close-overlay` 只是让页面能一并收起
 * 那些不是浮层的临时 UI，两边对同一个 state 置 false 是幂等的。
 */
export function useMeetingKeys(
  handler: (action: MeetingKeyAction) => void,
  { enabled = true }: MeetingKeysOptions = {},
): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = resolveMeetingKey(e)
      if (!action) return
      if (action.type === 'close-overlay') {
        handler(action)
        return
      }
      if (!enabled) return
      e.preventDefault()
      handler(action)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [handler, enabled])
}
