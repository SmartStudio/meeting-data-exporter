import { useCallback, useState } from 'react'
import { PageShell } from '@/ui/PageShell'
import { Button } from '@/ui/Button'
import { Skeleton } from '@/ui/Skeleton'
import { Toast } from '@/ui/Toast'
import { useResource } from '@/lib/useResource'
import { listRules, type Rule, type StackKind } from '@/api/admin/rules'
import { readonlyTitle, useReadonly } from '@/app/session'
import { STACK_META, groupByStack } from './order'
import { RuleStack } from './RuleStack'
import { RuleEditor } from './RuleEditor'
import { MatchesPanel } from './MatchesPanel'
import styles from './Rules.module.css'

/**
 * 自动规则页（spec §4.6）+ 规则编辑器（§4.7）。
 *
 * ## 这一页不实现求值语义
 *
 * spec §5 那一节自己写着「需要逐字实现，不能凭直觉」——而**逐字实现的那一份在
 * 后端**（`src/policy/stacks.ts` / `conds.ts` / `preview.ts`）。这一页里：
 *
 * | 屏幕上的东西 | 从哪来 |
 * | --- | --- |
 * | 规则的先后顺序 | `order.ts` 的 `sortForDisplay`，**只决定屏幕顺序** |
 * | 「这条永远不会命中」 | 结构可判（条件全用没有数据源的字段），不碰会议数据 |
 * | 「被上面那条挡住」 | 结构可判（上面有一条启用的无条件规则），其余情况不说 |
 * | 规则自身的问题 | 后端下发的 `Rule.issues`，逐条原样显示 |
 * | 影响预览的三个数 | `POST /rules/preview`，前端一个都不算 |
 * | 命中了哪几场 | `GET /rules/:id/matches` |
 * | 每一次判定的理由 | 预览响应里的 `before.reason` / `after.reason` |
 *
 * 前端另算一遍就是第二份真相，而两份不一致的地方恰好是判定边界——最需要准确的
 * 那一处。
 *
 * ## 写操作不做乐观更新（计划 G-c）
 *
 * 建 / 改 / 删 / 停用一律「发请求 → 重取列表」。规则之间会互相遮挡，改一条的
 * 后果不止那一行——前端推一遍"改完之后列表长什么样"，就是把后端那份求值语义
 * 又抄了一遍。代价是每次操作等一个往返，所以每个按钮都要有 pending 态。
 */
export default function RulesPage() {
  const rules = useResource<Rule[]>(useCallback(() => listRules(), []), [])
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [matchesFor, setMatchesFor] = useState<Rule | null>(null)
  /** 已经问过的命中数。**没问过就不显示数字**——没问过我们说不出来。 */
  const [hitCounts, setHitCounts] = useState<ReadonlyMap<number, number>>(new Map())
  const [toast, setToast] = useState<string | null>(null)
  const [busyRuleId, setBusyRuleId] = useState<number | null>(null)

  const reload = rules.retry

  const announce = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(null), 4200)
  }, [])

  const noteHits = useCallback((ruleId: number, n: number) => {
    setHitCounts((prev) => new Map(prev).set(ruleId, n))
  }, [])

  return (
    <PageShell
      title="自动规则"
      description={
        <>
          三栈各自独立求值：按优先级从高到低，<b>第一条命中的说了算</b>，不做合并、不做叠加。
          同优先级按建立先后（id 升序）。单场会议的人工改写优先于所有规则。
          <b> 改之前先看影响预览。</b>
        </>
      }
    >
      {rules.state === 'loading' && <LoadingStacks />}

      {rules.state === 'error' && (
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>规则读取失败</p>
          {/* 端点名与后端错误码已经在 message 里，原样显示——
              「操作失败」那种话让人无从下手 */}
          <p className={styles.errorDetail}>{rules.error.message}</p>
          <Button onClick={reload}>重试</Button>
        </div>
      )}

      {rules.state === 'ready' && (
        <RuleStacks
          rules={rules.data}
          hitCounts={hitCounts}
          busyRuleId={busyRuleId}
          onCreate={(kind) => setEditor({ mode: 'create', kind })}
          onEdit={(rule) => setEditor({ mode: 'edit', rule })}
          onShowMatches={setMatchesFor}
          onBusy={setBusyRuleId}
          onDone={(text) => {
            announce(text)
            reload()
          }}
        />
      )}

      <RuleEditor
        state={editor}
        allRules={rules.state === 'ready' ? rules.data : []}
        onClose={() => setEditor(null)}
        onSaved={(text) => {
          setEditor(null)
          announce(text)
          reload()
        }}
      />

      <MatchesPanel
        rule={matchesFor}
        onClose={() => setMatchesFor(null)}
        onCount={noteHits}
      />

      <Toast open={toast !== null} onClose={() => setToast(null)} message={toast ?? ''} />
    </PageShell>
  )
}

export type EditorState =
  | { mode: 'create'; kind: StackKind }
  | { mode: 'edit'; rule: Rule }

interface StacksProps {
  rules: Rule[]
  hitCounts: ReadonlyMap<number, number>
  busyRuleId: number | null
  onCreate: (kind: StackKind) => void
  onEdit: (rule: Rule) => void
  onShowMatches: (rule: Rule) => void
  onBusy: (id: number | null) => void
  onDone: (text: string) => void
}

function RuleStacks(props: StacksProps) {
  const groups = groupByStack(props.rules)
  return (
    <div className={styles.stacks}>
      {(['fetch', 'archive', 'allow'] as const).map((kind) => (
        <RuleStack
          key={kind}
          kind={kind}
          meta={STACK_META[kind]}
          rules={groups[kind]}
          hitCounts={props.hitCounts}
          busyRuleId={props.busyRuleId}
          onCreate={props.onCreate}
          onEdit={props.onEdit}
          onShowMatches={props.onShowMatches}
          onBusy={props.onBusy}
          onDone={props.onDone}
        />
      ))}

      {groups.unknown.length > 0 && (
        <UnknownStack rules={groups.unknown} onEdit={props.onEdit} />
      )}
    </div>
  )
}

/**
 * `kind` 认不出的规则。**不许悄悄丢掉**——它在 `policy_rules` 里是真的存在的一行，
 * 引擎对它的处置是"不参与任何判定"（`describeStackRuleIssues` 会这么说），
 * 而界面上如果一个字都不提，管理员会以为自己建的那条规则丢了。
 */
function UnknownStack({ rules, onEdit }: { rules: Rule[]; onEdit: (r: Rule) => void }) {
  const readonly = useReadonly()
  return (
    <section className={styles.group} aria-labelledby="stack-unknown">
      <h2 id="stack-unknown" className={styles.groupTitle}>
        认不出的规则
      </h2>
      <p className={styles.lede}>
        下面这几条的 kind 不是三栈之一（fetch / archive / allow），
        引擎不会让它们参与任何判定。它们仍然在库里，改掉 kind 才会生效。
      </p>
      <ul className={styles.rules}>
        {rules.map((r) => (
          <li key={r.id} className={styles.unknownRow} aria-label={`认不出的规则 #${r.id}`}>
            <span className={styles.unknownKind}>kind「{r.kind}」</span>
            <span className={styles.unknownNote}>{r.note ?? '（没有说明）'}</span>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => onEdit(r)}
              disabled={readonly}
              title={readonlyTitle(readonly)}
            >
              编辑
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 加载中的骨架：按真实的三组几何画，宽度不齐（spec §8）。
 * 隐藏内容会让布局在数据到达时整块跳一次。
 */
function LoadingStacks() {
  return (
    <div className={styles.stacks} aria-busy="true" aria-label="规则载入中">
      {['一', '二', '三'].map((n, i) => (
        <section key={n} className={styles.group}>
          <Skeleton width="9em" />
          <Skeleton width="24em" size="sm" />
          <ul className={styles.rules}>
            {Array.from({ length: i === 2 ? 2 : 3 }, (_, j) => (
              <li key={j} className={styles.skeletonRow}>
                <Skeleton width="3em" size="sm" />
                <Skeleton width={j % 2 === 0 ? '70%' : '52%'} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
