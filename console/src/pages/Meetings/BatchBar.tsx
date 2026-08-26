import { Button } from '@/ui/Button'
import { EXTEND_DEFAULT_DAYS } from '@/api/admin/meetings'
import { readonlyTitle, useReadonly } from '@/app/session'
import styles from './BatchBar.module.css'

/**
 * 批量动作。
 *
 * **F1 的「重跑拉取」「重跑归档」两个按钮删掉了**：后端没有「重跑某一场的
 * 某一个阶段」这条端点——只有 `POST /api/v1/admin/jobs/:name/run`，那是把
 * 整个定时任务跑一遍，不是这几场。留着按钮就得给它接一个语义不对的动作，
 * 而 G-g 已经定过同一类事情的处置：「留着一个点了弹『还没做』的按钮，
 * 比没有这个按钮更差」。这条缺口记在任务报告里。
 */
export type BatchAction = 'extend' | 'revoke'

export interface BatchBarProps {
  count: number
  /** 选中的行里有几场不在当前这一页。不说的话，按下去会改到看不见的行 */
  offPage: number
  /** 有写操作在跑：整条禁用，并把这件事说出来 */
  busy: boolean
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
export function BatchBar({ count, offPage, busy, onAction, onGrant, onCancel }: BatchBarProps) {
  const show = count > 0
  // 选行本身不是写操作，所以只读账号照样能选、能看见"选了几场"；
  // 三个真的会改状态的按钮禁用，「取消」留着（它只是清空选择）。
  const readonly = useReadonly()
  const roTitle = readonlyTitle(readonly)
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
        {offPage > 0 && <span className={styles.scope}>（其中 {offPage} 场不在本页）</span>}
      </span>
      <span className={styles.sep} aria-hidden="true" />
      <Button
        size="sm"
        className={styles.btn}
        disabled={busy || readonly}
        title={roTitle}
        onClick={() => onAction('extend')}
      >
        延长 {EXTEND_DEFAULT_DAYS} 天
      </Button>
      <Button size="sm" variant="primary" disabled={busy || readonly} title={roTitle} onClick={onGrant}>
        授权给…
      </Button>
      <span className={styles.sep} aria-hidden="true" />
      <Button
        size="sm"
        className={styles.btn}
        disabled={busy || readonly}
        title={roTitle}
        onClick={() => onAction('revoke')}
      >
        收回授权
      </Button>
      <Button size="sm" variant="quiet" className={styles.quiet} onClick={onCancel}>
        取消
      </Button>
      {busy && (
        <span className={styles.busy} role="status">
          正在提交…
        </span>
      )}
    </div>
  )
}
