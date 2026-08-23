import styles from './ShortcutBar.module.css'

/**
 * spec.md §9 的九行键盘操作，逐字照抄。F1 只画这条常驻提示条——真正的键位
 * 绑定跟着 T6 的会议记录页一起做（`lib/keys.ts`），这里不接任何事件。
 * `aria-hidden`：跟原型一致，纯提示，不需要进读屏。
 */
const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['j', 'k'], label: '上下移动' },
  { keys: ['空格'], label: '选中' },
  { keys: ['回车'], label: '打开详情' },
  { keys: ['1', '2', '3'], label: '拉取 / 归档 / 授权' },
  { keys: ['e'], label: '延长保留' },
  { keys: ['p'], label: '预览内容' },
  { keys: ['/'], label: '搜索' },
  { keys: ['⌘K'], label: '全局搜索（会议 / 规则 / 程序）' },
  { keys: ['Esc'], label: '关闭当前浮层' },
]

export default function ShortcutBar() {
  return (
    <div className={styles.bar} aria-hidden="true">
      {SHORTCUTS.map((item) => (
        <span key={item.label} className={styles.item}>
          {item.keys.map((k) => (
            <kbd key={k} className={styles.kbd}>
              {k}
            </kbd>
          ))}
          {item.label}
        </span>
      ))}
    </div>
  )
}
