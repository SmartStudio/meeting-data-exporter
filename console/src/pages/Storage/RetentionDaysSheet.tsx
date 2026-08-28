import { useEffect, useId, useState } from 'react'
import { Button } from '@/ui/Button'
import { Input } from '@/ui/Input'
import { Sheet } from '@/ui/Sheet'
import styles from './Storage.module.css'

export interface RetentionDaysSheetProps {
  open: boolean
  onClose: () => void
  /** 当前的默认天数。配置值非法时是 null——那时输入框留空，不预填一个假的 30 */
  current: number | null
  submitting: boolean
  /** 后端拒绝的原因（或本地的"这不是一个整数"）。为 null 时不渲染 */
  error: string | null
  onSubmit: (days: number) => void
}

/**
 * 「修改默认保留天数」。
 *
 * **合法区间不在前端写死。** 后端 400 时回的是 `{ error, min, max }`，界面照
 * 它说话；前端只拦"这压根不是一个整数"这一种（那连一次请求都不值得发）。
 * 两处各存一份区间，改一处就会有一处开始说谎——而这个数管的是删文件的时刻。
 */
export function RetentionDaysSheet(props: RetentionDaysSheetProps) {
  const { open, onClose, current, submitting, error, onSubmit } = props
  const inputId = useId()
  const [value, setValue] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  // Sheet 是常挂载的（关闭态 inert），所以每次打开要重置成当前值，
  // 否则上一次输入的那个数还留在框里。
  useEffect(() => {
    if (open) {
      setValue(current === null ? '' : String(current))
      setLocalError(null)
    }
  }, [open, current])

  const submit = (): void => {
    const n = Number(value.trim())
    if (value.trim() === '' || !Number.isInteger(n)) {
      setLocalError('请填一个整数天数。')
      return
    }
    setLocalError(null)
    onSubmit(n)
  }

  const shown = localError ?? error

  return (
    <Sheet open={open} onClose={onClose} title="修改默认保留天数">
      <div className={styles.formRow}>
        <label className={styles.formLabel} htmlFor={inputId}>
          默认保留天数
        </label>
        <Input
          id={inputId}
          className={styles.daysInput}
          type="number"
          min={1}
          max={365}
          inputMode="numeric"
          value={value}
          invalid={shown !== null}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>

      <p className={styles.note}>
        只影响<b>此后新归档</b>的会议。已经归档的会议按它归档那一刻记下的天数继续计时，
        改这里不会追溯——要给某一场续命，用会议记录页那一行上的「＋30 天」。
      </p>
      <p className={styles.note}>
        改小意味着一批会议会提前到期，下一轮清理就会删掉它们的本地文件（NAS 上的副本与
        数据库记录不受影响）。
      </p>

      {shown !== null && (
        <p className={styles.alert} role="alert">
          {shown}
        </p>
      )}

      <div className={styles.formActions}>
        <Button variant="primary" onClick={submit} disabled={submitting} aria-busy={submitting}>
          保存
        </Button>
        <Button variant="quiet" onClick={onClose} disabled={submitting}>
          取消
        </Button>
      </div>
    </Sheet>
  )
}
