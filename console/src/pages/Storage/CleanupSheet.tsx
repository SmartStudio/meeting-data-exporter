import { useId } from 'react'
import { Button } from '@/ui/Button'
import { Sheet } from '@/ui/Sheet'
import { Skeleton } from '@/ui/Skeleton'
import { fmtBytes } from '@/lib/format'
import type { CleanupExecuted, CleanupItem, CleanupPreview } from '@/api/admin/storage'
import styles from './Storage.module.css'

/**
 * 清理这件事的四个阶段。**预览是一次真实的 dry-run 请求**（后端同一条端点、
 * 不带 `confirm`），不是前端按 `expiredMeetings` 那个计数编出来的清单——
 * 编出来的清单会在"到期公式"这一处与后端各说各话，而那正是最难解释的不一致。
 */
export type CleanupPhase =
  | { kind: 'loading' }
  | { kind: 'preview'; preview: CleanupPreview; running: boolean }
  | { kind: 'done'; result: CleanupExecuted }
  | { kind: 'error'; message: string }

export interface CleanupSheetProps {
  open: boolean
  onClose: () => void
  phase: CleanupPhase
  onConfirm: () => void
}

/**
 * 「立即清理已到期文件」的二次确认。
 *
 * 这是本系统唯一不可逆的动作，所以确认框里两件事一件都不能少：
 * **删的是什么**（下列这些会议的本地文件）与**留下的是什么**（数据库记录、
 * 标题、时间、主持人、内容哈希、NAS 目录）。少了后半句，管理员会以为
 * 这是在删会议本身。
 */
export function CleanupSheet({ open, onClose, phase, onConfirm }: CleanupSheetProps) {
  const blockedId = useId()
  const blocked = blockedReason(phase)
  const running = phase.kind === 'preview' && phase.running

  return (
    <Sheet open={open} onClose={onClose} title="立即清理已到期文件">
      {phase.kind === 'loading' && (
        <>
          <p className={styles.lede}>正在算这一轮会删掉哪些文件……</p>
          <Skeleton width="70%" />
        </>
      )}

      {phase.kind === 'error' && (
        <p className={styles.alert} role="alert">
          {phase.message}
        </p>
      )}

      {phase.kind === 'preview' && <PreviewBody preview={phase.preview} />}

      {phase.kind === 'done' && <ResultBody result={phase.result} />}

      {blocked !== null && (
        <p className={styles.note} id={blockedId} data-testid="cleanup-blocked">
          {blocked}
        </p>
      )}

      <div className={styles.formActions}>
        {phase.kind === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            知道了
          </Button>
        ) : (
          <>
            <Button
              variant="danger"
              onClick={onConfirm}
              disabled={blocked !== null || running}
              aria-busy={running}
              aria-describedby={blocked === null ? undefined : blockedId}
            >
              删除本地文件
            </Button>
            <Button variant="quiet" onClick={onClose} disabled={running}>
              取消
            </Button>
          </>
        )}
      </div>
    </Sheet>
  )
}

/** 那颗红按钮点不动时，**原因必须写在界面上**——点不动而不说为什么最难排查。 */
function blockedReason(phase: CleanupPhase): string | null {
  if (phase.kind === 'loading') return '正在取这一轮的候选清单，取回来才知道会删什么。'
  if (phase.kind === 'error') return '这一轮的候选清单没取到，在弄清楚之前不执行删除。'
  if (phase.kind === 'done') return null
  if (phase.preview.cleanupPaused) {
    return '到期清理已暂停：这时候点下去后端一个文件都不会删。要真的清理，先在上面「恢复到期清理」。'
  }
  if (phase.preview.items.length === 0) {
    return '当前没有已到期、还没清理的本地文件。清理任务本来就会自动跑，通常轮不到手动来点。'
  }
  return null
}

function PreviewBody({ preview }: { preview: CleanupPreview }) {
  return (
    <>
      <p className={styles.lede} data-testid="cleanup-deletes">
        下列 <b>{preview.items.length}</b> 场会议的<b>本地文件</b>将被删除，合计{' '}
        <b>{fmtBytes(preview.totalBytes)}</b>。这一步不可逆。
      </p>
      <p className={styles.keeps} data-testid="cleanup-keeps">
        保留下来的是：数据库记录、会议标题、时间、主持人、内容哈希，以及归档到 NAS
        的具体目录。这些会议之后仍然搜得到，只是要按给出的路径去 NAS 取。
      </p>
      {preview.items.length > 0 && <ItemList items={preview.items} />}
    </>
  )
}

function ItemList({ items }: { items: CleanupItem[] }) {
  return (
    <ul className={styles.itemList}>
      {items.map((it) => (
        <li className={styles.item} key={`${it.meetingId}|${it.subMeetingId}`}>
          {/* 这条端点只给会议 id，不给标题——不去拼一个标题出来，
              拼错的标题会让人以为删的是另一场会议。 */}
          <span className={styles.itemId}>
            {it.meetingId}
            {it.subMeetingId !== '' && ` · 场次 ${it.subMeetingId}`}
          </span>
          <span className={styles.itemSize}>
            {it.assetCount} 个资产 · {fmtBytes(it.localBytes)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ResultBody({ result }: { result: CleanupExecuted }) {
  const purgedBytes = result.purged.reduce((n, it) => n + it.localBytes, 0)
  return (
    <div data-testid="cleanup-result">
      <p className={styles.lede}>
        已删除 <b>{result.purged.length}</b> 场会议的本地文件（{fmtBytes(purgedBytes)}）。
        记录与 NAS 路径保留。
      </p>
      {result.paused && (
        <p className={styles.resultFail}>
          本轮被「暂停到期清理」中止
          {result.purged.length > 0 && '——暂停生效之前已经删掉的那些不会收回'}。
        </p>
      )}
      {result.verificationFailed.length > 0 && (
        <>
          <p className={styles.resultFail}>
            拒删 {result.verificationFailed.length} 场：重新校验时对不上，本轮没有删，需要人工介入。
          </p>
          <FailureList items={result.verificationFailed} />
        </>
      )}
      {result.failed.length > 0 && (
        <>
          <p className={styles.resultFail}>
            出错 {result.failed.length} 场：处理过程本身没跑完（与上面那种"校验不通过"不是一回事）。
          </p>
          <FailureList items={result.failed} />
        </>
      )}
      <p className={styles.note}>每一场的删除与拒删都已经记进操作审计，按会议号查得到。</p>
    </div>
  )
}

function FailureList({ items }: { items: Array<{ meetingId: string; subMeetingId: string; reason: string }> }) {
  return (
    <ul className={styles.itemList}>
      {items.map((f) => (
        <li className={styles.item} key={`${f.meetingId}|${f.subMeetingId}`}>
          <span className={styles.itemId}>
            {f.meetingId}
            {f.subMeetingId !== '' && ` · 场次 ${f.subMeetingId}`}
          </span>
          {/* 原因是后端给的原文，前端不概括成"失败" */}
          <span className={styles.itemSize}>{f.reason}</span>
        </li>
      ))}
    </ul>
  )
}
