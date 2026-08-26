import { Skeleton } from '@/ui/Skeleton'
import type { PreviewChange, PreviewResult, PreviewStack } from '@/api/admin/rules'
import { STACK_META } from './order'
import styles from './RuleEditor.module.css'

/**
 * 影响预览（spec §4.7 / §5.5）。**钉在编辑器底部，不跟正文滚动。**
 *
 * ## 这里一个数都不算
 *
 * 全部数字来自 `POST /api/v1/admin/rules/preview`。spec §5.5 写死了计算范围：
 *
 * > 只在 `命中(旧规则) ∪ 命中(新规则)` 这个集合上算，**不是全部会议**。
 * > 把所有会议都列成「受影响」是虚假的规模感。
 *
 * 前端照着这句话再算一遍，得到的是第二份真相；而两份不一致的地方恰好是判定
 * 边界——最需要准确的那一处。所以这个组件只做一件事：把后端给的数摆出来。
 *
 * ## 屏幕上是三个数，响应里是十个
 *
 * spec §4.7 要的三个是 `hits`（场命中）/ `opened`（场新放行）/ `tightened`（场新收紧）。
 * 其余七个不是装饰，各自回答一个「为什么这个数不是我以为的那个数」：
 *
 * - `scanned` / `total`：这次只够得着 N 场，库里一共 M 场；
 * - `deciderOnly`：判定没变，只是换了另一条规则说了算；
 * - `shielded`：本来会变，被人工改写挡住了（改写优先于所有规则，spec §5.4）；
 * - `invalid`：这几场是被**写坏的规则**决定的——先去修规则，那不是你想要的收紧；
 * - `moved` / `mixed`：归档目录换了地方 / 资产类型有增有减，既不是放开也不是收紧。
 *
 * 少显示哪一个，都会让三个主数字看起来在说谎。
 */
export interface ImpactPreviewProps {
  /** kind 认不出时（库里的一条坏行）也照样渲染，只是找不到本栈的那一段。 */
  kind: string
  result: PreviewResult | null
  error: Error | null
  pending: boolean
}

export function ImpactPreview({ kind, result, error, pending }: ImpactPreviewProps) {
  const stack = result?.stacks.find((s) => s.kind === kind) ?? null

  return (
    <div className={styles.previewDock} role="group" aria-label="影响预览">
      <p className={styles.previewTitle}>
        影响预览
        {pending && <span className={styles.previewPending}> 计算中…</span>}
      </p>

      {error !== null && (
        <p className={styles.warnLine} role="alert">
          影响预览算不出来：{error.message}
          <br />
          <b>算不出来不等于没有影响</b>——这次改动会不会动到谁，现在是不知道的。
        </p>
      )}

      {error === null && result === null && (
        <div className={styles.previewSkeleton}>
          <Skeleton width="7em" />
          <Skeleton width="14em" size="sm" />
        </div>
      )}

      {error === null && result !== null && (
        <>
          {stack === null ? (
            <p className={styles.previewNeutral}>
              这次改动没有让{stackName(kind)}这一栈发生变化，没有任何判定会改变。
            </p>
          ) : (
            <StackNumbers stack={stack} />
          )}

          <p className={styles.previewScope}>
            考察范围：{result.scope.meetings} 场
            {result.scope.truncated && <>（库里一共 {result.scope.meetingsTotal} 场，只看了这一批）</>}
            {!result.scope.truncated && result.scope.meetingsTotal !== result.scope.meetings && (
              <>（库里一共 {result.scope.meetingsTotal} 场）</>
            )}
            {result.scope.programs.length > 0 && <> · 够得着的采集程序：{result.scope.programs.join('、')}</>}
          </p>

          {result.warnings.map((w) => (
            <div key={w.code} className={styles.amber} role="alert">
              <p>{w.text}</p>
              {w.meetings.length > 0 && (
                <p className={styles.amberList}>
                  {w.meetings.slice(0, 8).map((m) => m.title === '' ? `（标题为空）${m.id}` : m.title).join('、')}
                  {w.meetings.length > 8 && ` 等 ${w.meetings.length} 场`}
                </p>
              )}
            </div>
          ))}

          {result.candidateIssues
            .filter((c) => c.issues.length > 0)
            .map((c) => (
              <div key={c.id} className={styles.warnBox} role="alert">
                <p>这条规则本身有问题（预览按它现在的样子算的）：</p>
                <ul>
                  {c.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            ))}
        </>
      )}
    </div>
  )
}

function stackName(kind: string): string {
  return kind === 'fetch' || kind === 'archive' || kind === 'allow'
    ? STACK_META[kind].name
    : `kind「${kind}」`
}

function StackNumbers({ stack }: { stack: PreviewStack }) {
  const c = stack.counts
  return (
    <>
      <div className={styles.numbers}>
        <Number n={c.hits} label="场命中" />
        <Number n={c.opened} label="场新放行" tone={c.opened > 0 ? 'brand' : undefined} />
        <Number n={c.tightened} label="场新收紧" tone={c.tightened > 0 ? 'warn' : undefined} />
      </div>

      <p className={styles.previewSummary}>{stack.summary === '' ? '摘要缺失' : stack.summary}</p>

      <ul className={styles.previewAside}>
        <li>
          够得着 {c.scanned} 个考察对象（共 {c.total} 个）
        </li>
        {c.moved > 0 && <li>{c.moved} 场换了归档目录（既不是放开也不是收紧）</li>}
        {c.mixed > 0 && <li>{c.mixed} 场的资产类型有增有减</li>}
        {c.deciderOnly > 0 && <li>{c.deciderOnly} 场判定不变，只是换了规则说了算</li>}
        {c.shielded > 0 && (
          <li>{c.shielded} 场被人工改写挡住——改写优先于所有规则，这几场的结果不会变</li>
        )}
        {c.invalid > 0 && (
          <li className={styles.invalidNote}>
            其中 {c.invalid} 场是被<b>写坏的规则</b>决定的，先去修规则
          </li>
        )}
      </ul>

      {stack.changed.length > 0 && (
        <details className={styles.details}>
          <summary>看看是哪几场（{stack.changed.length} 条明细{stack.sampled.changed && '，已截断'}）</summary>
          <ul className={styles.changes}>
            {stack.changed.map((ch) => (
              <ChangeRow key={ch.key} change={ch} />
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

function Number({ n, label, tone }: { n: number; label: string; tone?: 'brand' | 'warn' }) {
  return (
    <span className={styles.number} data-tone={tone}>
      <b>{n}</b>
      <span>{label}</span>
    </span>
  )
}

/**
 * 一场会议的判定变化。理由一律来自后端；**空串显示成「理由缺失」而不是留白**
 * ——留白看起来像"这次判定本来就没有理由"，而实际是我们没拿到。
 */
function ChangeRow({ change }: { change: PreviewChange }) {
  return (
    <li className={styles.change} data-direction={change.direction}>
      <p className={styles.changeTitle}>
        {change.title === '' ? <em>（标题为空）</em> : change.title}
        {change.programId !== null && <span className={styles.changeProgram}> → {change.programId}</span>}
        {change.invalidRule && <span className={styles.changeFlag}>规则写坏了</span>}
        {change.overridden && <span className={styles.changeFlag}>人工改写挡住</span>}
      </p>
      <p className={styles.changeSummary}>{change.summary === '' ? '摘要缺失' : change.summary}</p>
      <p className={styles.changeReason}>
        改动前：<span>{reasonOf(change.before.reason)}</span>
        <br />
        改动后：<span>{reasonOf(change.after.reason)}</span>
      </p>
    </li>
  )
}

function reasonOf(reason: string): string {
  return reason === '' ? '理由缺失' : reason
}
