import { useState } from 'react'
import { Button } from '@/ui/Button'
import styles from './SecretRow.module.css'

/**
 * 一次性凭据的那一行：标签 + 明文 + 复制按钮。
 *
 * **建号（接入向导第二步）与轮换凭据共用它**，所以它从 `Wizard.tsx` 里搬了出来。
 * 两处显示同一种东西——一段只会出现这一次的明文——却各画一份的话，迟早有一处
 * 忘了那句「只显示这一次」，或者忘了复制按钮在非安全上下文里会失败。
 */
export function SecretRow({ label, value }: { label: string; value: string }) {
  const [said, setSaid] = useState<string | null>(null)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setSaid('已复制')
    } catch {
      // 剪贴板在非安全上下文（http 的内网地址）里不可用。说出来，
      // 别让按钮点了没反应——这一屏关掉之后这段明文就再也拿不到了。
      setSaid('复制不了，请手动选中')
    }
  }

  return (
    <div className={styles.row}>
      <span className={styles.k}>{label}</span>
      <code className={styles.v}>{value}</code>
      <Button size="sm" variant="quiet" onClick={() => void copy()} aria-label={`复制 ${label}`}>
        复制
      </Button>
      {said !== null && (
        <span className={styles.said} role="status">
          {said}
        </span>
      )}
    </div>
  )
}
