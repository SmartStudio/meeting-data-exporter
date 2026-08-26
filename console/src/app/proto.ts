/**
 * 原型模式（`?proto=1`）。
 *
 * 它是**演示与截图工具，不是运行时功能**：顶栏那个「系统状态」下拉靠它调出来，
 * `scripts/a11y-check.ts` 也靠那个下拉驱动 NAS 断连 / 腾讯不可达 / 加载失败 /
 * 加载中 / 空态这五个无障碍检查场景。
 *
 * 从 `GlobalBar.tsx` 挪到这里，是因为它现在有三个消费者（顶栏、系统状态条、
 * 左栏状态摘要）：默认路径下这三处读真实端点，原型模式下才听那个下拉的。
 * 判断散在三个文件里，迟早会有一处漏掉，而漏掉的那一处就是"看起来能跑、
 * 其实是假数据"发生的地方。
 *
 * 认了 `?proto=1` 之后记进 sessionStorage：否则点一下左栏换个页面参数就掉了，
 * 控件跟着消失，看起来像 bug 而不是设计。
 */

/** `?proto=1` 记在这个键下。导出是为了让测试跟着常量走，不各写一份字面量。 */
export const PROTO_STORAGE_KEY = 'mde.proto'

/**
 * 现在是不是原型模式。
 *
 * **每次调用都重新读**，不做模块级缓存：缓存会让"先加载模块、再打开开关"的
 * 顺序（测试里就是这个顺序）永远读到 false。组件要冻结这个值的话，
 * 在自己那层用 `useState(() => isProtoMode())`。
 */
export function isProtoMode(): boolean {
  let inUrl = false
  try {
    inUrl = new URLSearchParams(window.location.search).get('proto') === '1'
  } catch {
    inUrl = false
  }
  try {
    if (inUrl) sessionStorage.setItem(PROTO_STORAGE_KEY, '1')
    return inUrl || sessionStorage.getItem(PROTO_STORAGE_KEY) === '1'
  } catch {
    // 隐私模式 / 禁用站点数据时 sessionStorage 会抛，退回只认当前 URL
    return inUrl
  }
}
