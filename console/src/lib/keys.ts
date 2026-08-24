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
 * `<input>` 里**不吃字符输入**的那些 type。它们是控件不是输入框：勾选框、单选钮、
 * 三种按钮型 input，敲 `j` 在它们身上什么也不会发生。
 *
 * 单独列出来是因为漏掉这一条的后果是静默的：鼠标点一下某行的勾选框，焦点就留在
 * 它上面，此后 `j`/`k`/`1`/`e` 全部不响应——键盘用户看不到任何反馈，也猜不到
 * 是"页面以为你在打字"。
 *
 * `range`/`color`/`file`/`date` 这些**故意不在表里**：方向键、空格、回车都是它们
 * 自己的键，页面接管过来会砸掉控件本身的操作。
 */
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image'])

/**
 * 焦点是否落在会吞掉字母键的控件里。**在搜索框里打 `j` 必须是打字，不是跳行**
 * ——漏掉这一条，页面上唯一的搜索框就没法用了。
 *
 * `contentEditable` 也算：富文本区域同样在吃字符输入。
 *
 * 但**不是所有 `<input>` 都在打字**（见 `NON_TEXT_INPUT_TYPES`）：按 tagName 一刀切
 * 会把勾选框也算成输入框，于是点过勾选框之后整页键位静默失效。这些控件改走
 * `ownsKey`，只让它们真正拥有的键（空格 / 方向键）留在自己手里。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)
  return tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 焦点是否落在「Enter / 空格本来就会激活它」的原生控件上。
 *
 * 这一条和 `isTypingTarget` 是两回事，漏掉它的后果比漏掉输入框还大：浏览器里
 * **Enter 激活按钮走的正是 keydown 的默认动作**，空格则是 keydown 被取消后
 * keyup 不再激活。页面级监听挂在 `document` 上，一旦无条件 `preventDefault`，
 * 这一页挂载期间**整个应用外壳**的按钮和链接都按不动了——包括加载失败态里
 * 那颗「重试」，也就是键盘用户在错误态里唯一的出路。
 *
 * jsdom 不给按钮合成 click，测不出「按 Enter 会不会激活按钮」，所以守卫写在
 * 这里（纯函数）并由 `defaultPrevented` 反向断言。
 */
const ACTIVATION_SELECTOR =
  'button, a[href], [role="button"], summary,' +
  'input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]'

export function isActivationTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest(ACTIVATION_SELECTOR) !== null
}

/**
 * 焦点控件**自己拥有**哪一批键——页面对这些键一律不接管。
 *
 * 拥有的键因控件而异，一刀切会错在两个方向上：
 * - 按钮 / 链接 / `[role=button]` / `summary` / 按钮型 input：Enter 与空格是激活键。
 * - 勾选框：**只有空格**。原生 checkbox 不响应 Enter，把 Enter 也闸掉，
 *   就成了"按下去什么都不发生"的死键。
 * - 单选钮：空格，外加四个方向键——方向键在同一组里换选项，抢走它等于
 *   让单选组没法用键盘选。
 *
 * 其余的键（`j`/`k`/`1`/`2`/`3`/`e`/`p`/`/`）不是任何原生控件的键，
 * 焦点落在哪儿都照旧由页面接管。
 */
export function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false
  if (isActivationTarget(target)) return key === 'Enter' || key === ' '
  if (target.closest('input[type="checkbox"]')) return key === ' '
  if (target.closest('input[type="radio"]')) return key === ' ' || key.startsWith('Arrow')
  return false
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
 * 3. **焦点在原生控件上时不接管它自己的那批键**——按钮/链接的 Enter 与空格、
 *    勾选框的空格、单选钮的空格与方向键（见 `ownsKey`）。抢走等于让整页的
 *    按钮都按不动。`j`/`k`/`1`/`2`/`3`/`e`/`p`/`/` 不是任何原生控件的键，照旧接管
 *    ——包括焦点停在某行勾选框上的时候。
 */
export function resolveMeetingKey(e: MeetingKeyEvent): MeetingKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null

  // Esc 不受"正在打字"限制：输入框里按 Esc 也该关掉当前浮层。
  if (e.key === 'Escape') return { type: 'close-overlay' }

  if (isTypingTarget(e.target ?? null)) return null

  if (ownsKey(e.target ?? null, e.key)) return null

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
