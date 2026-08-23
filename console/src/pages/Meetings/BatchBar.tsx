import { Button } from '@/ui/Button'
import styles from './BatchBar.module.css'

export type BatchAction = 'fetch' | 'archive' | 'extend' | 'revoke'

export interface BatchBarProps {
  count: number
  /** 选中的是否已经扩到"符合筛选的全部"——扩过之后要在条上一直说着。 */
  allMatching: boolean
  onAction: (action: BatchAction) => void
  onGrant: () => void
  onCancel: () => void
}

/**
 * 批量条。**始终挂载，用 `data-show` 切**——条件渲染会让它退场时直接消失，
 * 升起/落下的动画来不及播。
 *
 * 它是反相表面（深底浅字），所以里面的强调色必须用 `--accent-invert`，
 * 不能直接用 `--brand`（那是给浅底准备的，压在近黑底上对比度不够）。
 */
export function BatchBar({ count, allMatching, onAction, onGrant, onCancel }: BatchBarProps) {
  const show = count > 0
  return (
    <div
      className={styles.bar}
      data-show={show}
      // 关掉时整块退出 Tab 序列与无障碍树：看不见的按钮不该还能被 Tab 到。
      inert={!show}
      role="region"
      aria-label="批量操作"
      data-testid="batch-bar"
    >
      <span className={styles.count}>
        <b data-testid="batch-count">{count}</b> 场已选
        {allMatching && <span className={styles.scope}>（含未显示的页）</span>}
      </span>
      <span className={styles.sep} aria-hidden="true" />
      <Button size="sm" className={styles.btn} onClick={() => onAction('fetch')}>
        重跑拉取
      </Button>
      <Button size="sm" className={styles.btn} onClick={() => onAction('archive')}>
        重跑归档
      </Button>
      <Button size="sm" className={styles.btn} onClick={() => onAction('extend')}>
        延长 30 天
      </Button>
      <Button size="sm" variant="primary" onClick={onGrant}>
        授权给…
      </Button>
      <span className={styles.sep} aria-hidden="true" />
      <Button size="sm" className={styles.btn} onClick={() => onAction('revoke')}>
        收回授权
      </Button>
      <Button size="sm" variant="quiet" className={styles.quiet} onClick={onCancel}>
        取消
      </Button>
    </div>
  )
}
