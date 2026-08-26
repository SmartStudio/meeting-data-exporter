import { useCallback, useEffect } from 'react'
import { Drawer } from '@/ui/Drawer'
import { Button } from '@/ui/Button'
import { Skeleton } from '@/ui/Skeleton'
import { useResource } from '@/lib/useResource'
import {
  ruleMatches,
  type Rule,
  type RuleMatchesResult,
  type RulesSchema,
} from '@/api/admin/rules'
import { fmtDateTime } from '@/lib/format'
import { describeEffect, missingFactLabel, titleDisplay } from './fields'
import styles from './Rules.module.css'

/**
 * 「这条规则现在命中哪几场」（spec §4.7：规则行右侧的命中数可点）。
 *
 * ## 命中的口径与预览一致，两处必须是同一件事
 *
 * 「命中」= **这条规则自身的条件匹配**（后端的 `matchesRule`），不是整栈求值的
 * 结果：主体不符、被更高优先级顶掉的规则照样算命中。影响预览的「场命中」用的是
 * 同一个口径，所以这里的场次数与那个数字对得上。停用的规则也算得出来——
 * 管理员要先看得见「把它开回来会命中什么」。
 *
 * ## 「标题缺失」与「标题为空」在这里必须分得开（阶段 4 · T13）
 *
 * 后端为此在每一条命中里下发了 `missing`。两者都渲染成一个空格子的话，
 * 管理员就再也看不出哪几场是元数据没拉回来的——而那正是 T13 修的那个洞
 * （NULL 标题折成空串，`title 含 X → deny` 落到宽松的一侧）在界面上的复发形态。
 */
export interface MatchesPanelProps {
  /** null = 关着。 */
  rule: Rule | null
  /** 只用来把 effect 读成人话。**读不出来时照直显示原值**，不猜。 */
  schema: RulesSchema | null
  onClose: () => void
  /** 拿到场次数之后回传，好让规则行显示那个数——**问过之后才显示**。 */
  onCount: (ruleId: number, n: number) => void
}

export function MatchesPanel({ rule, schema, onClose, onCount }: MatchesPanelProps) {
  return (
    <Drawer
      open={rule !== null}
      onClose={onClose}
      title={rule === null ? '命中的会议' : `命中的会议 · 规则 #${rule.id}`}
    >
      {rule !== null && (
        <MatchesBody key={rule.id} rule={rule} schema={schema} onCount={onCount} />
      )}
    </Drawer>
  )
}

function MatchesBody({
  rule,
  schema,
  onCount,
}: {
  rule: Rule
  schema: RulesSchema | null
  onCount: (id: number, n: number) => void
}) {
  const res = useResource<RuleMatchesResult>(
    useCallback(() => ruleMatches(rule.id), [rule.id]),
    [rule.id],
  )
  const ready = res.state === 'ready' ? res.data : null

  useEffect(() => {
    if (ready !== null) onCount(rule.id, ready.matches.length)
  }, [ready, rule.id, onCount])

  return (
    <div className={styles.matches}>
      <p className={styles.matchesLede}>
        这里列的是<b>这条规则自身的条件命中的会议</b>，不是整栈求值的结果——
        主体不符、被更高优先级顶掉的规则照样算命中。
        {rule.enabled ? null : '这条规则当前是停用的，下面是把它开回来会命中的场次。'}
      </p>
      <p className={styles.matchesRule}>
        {rule.priority} · {describeEffect(schema, rule.kind, rule.effect, rule.assetTypes)}
      </p>

      {res.state === 'loading' && (
        <div aria-busy="true" aria-label="命中列表载入中">
          <Skeleton width="60%" />
          <Skeleton width="45%" size="sm" />
          <Skeleton width="70%" />
        </div>
      )}

      {res.state === 'error' && (
        <div role="alert" className={styles.error}>
          <p className={styles.errorDetail}>{res.error.message}</p>
          <Button onClick={res.retry}>重试</Button>
        </div>
      )}

      {ready !== null && (
        <>
          <p className={styles.matchesScope}>
            考察了 {ready.scope.meetings} 场
            {ready.scope.truncated && <>（库里一共 {ready.scope.meetingsTotal} 场，只看了这一批）</>}
            ，其中 <b>{ready.matches.length}</b> 场命中。
          </p>

          {ready.matches.length === 0 ? (
            <p className={styles.emptyStack}>
              这一批里一场都没命中。
              {ready.scope.truncated && '注意只看了这一批，不是全库。'}
            </p>
          ) : (
            <ul className={styles.matchList}>
              {ready.matches.map((m) => {
                const t = titleDisplay(m.title, m.missing)
                const otherMissing = m.missing.filter((k) => k !== 'title')
                return (
                  <li key={m.id} className={styles.match}>
                    <p className={styles.matchTitle} data-kind={t.kind}>
                      {t.text}
                    </p>
                    <p className={styles.matchMeta}>
                      {m.meetingId}
                      {m.subMeetingId !== '' && ` · 场次 ${m.subMeetingId}`}
                      {' · '}
                      {fmtDateTime(m.startAt)}
                    </p>
                    {t.hint !== null && <p className={styles.matchHint}>{t.hint}</p>}
                    {otherMissing.length > 0 && (
                      <p className={styles.matchHint}>
                        这场会议还缺这几项事实：{otherMissing.map(missingFactLabel).join('、')}
                        （库里那几列是 NULL，用到它们的条件判不出来）
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
