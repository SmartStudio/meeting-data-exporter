import { useCallback } from 'react'
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
 * 这一段以前也逐字印在面板顶上。**现在改成把口径写进那句计数的措辞里**：
 * 「N 场满足这条规则的条件」。「命中」是个能被读成两种意思的词，所以要一段
 * 说明去收窄它；换成一个只有一种读法的说法，那段说明就不用写了。
 *
 * ## 这个面板不再回填规则行上的那个数
 *
 * 规则行右边的命中数现在由 `GET /rules` 每条规则自带的 `matchCount` 给出（口径同上，
 * 见 `order.ts` 的 `matchStatsOf`），页面一进来就有数，不用先点开这里问一次。
 * 这个面板只回答「是哪几场」，并且报出**它自己这一次**的考察范围——两处若因为
 * 扫描批次不同而对不上，那正是要看得见的事，不该由前端挑一个数覆盖另一个。
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
}

export function MatchesPanel({ rule, schema, onClose }: MatchesPanelProps) {
  return (
    <Drawer
      open={rule !== null}
      onClose={onClose}
      title={rule === null ? '命中的会议' : `命中的会议 · 规则 #${rule.id}`}
    >
      {rule !== null && <MatchesBody key={rule.id} rule={rule} schema={schema} />}
    </Drawer>
  )
}

function MatchesBody({ rule, schema }: { rule: Rule; schema: RulesSchema | null }) {
  const res = useResource<RuleMatchesResult>(
    useCallback(() => ruleMatches(rule.id), [rule.id]),
    [rule.id],
  )
  const ready = res.state === 'ready' ? res.data : null

  return (
    <div className={styles.matches}>
      {/* 「命中 ≠ 整栈求值的结果」这件事以前是一段说明。现在由下面那句计数里的
          **措辞**承担：说的是「满足这条规则的条件」，而不是含糊的「命中」——
          一个说不清的词加一段解释，不如一个说得清的词。 */}
      <p className={styles.matchesRule}>
        优先级 {rule.priority} · {describeEffect(schema, rule.kind, rule.effect, rule.assetTypes)}
        {rule.enabled ? null : <span className={styles.off}> · 已停用</span>}
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
            ，其中 <b>{ready.matches.length}</b> 场满足这条规则的条件。
          </p>

          {ready.matches.length === 0 ? (
            <p className={styles.emptyStack}>
              这一批里一场都没满足。
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
                        ——用到它们的条件判不出来
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
