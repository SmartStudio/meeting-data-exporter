import { useId, useState } from 'react'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import { ApiError } from '@/api/client'
import { setRuleEnabled, type Rule, type StackKind } from '@/api/admin/rules'
import { readonlyTitle, useReadonly } from '@/app/session'
import { fmtDay } from '@/lib/format'
import { describeCondition, describeEffect } from './fields'
import {
  blockedByUnconditional,
  neverMatchesForLackOfDataSource,
  type StackMeta,
} from './order'
import styles from './Rules.module.css'

/**
 * 一栈规则（spec §4.6 的一组）。
 *
 * 三组**必须分开展示**，而且每组的兜底要写出来：第三组的兜底是 `deny`、
 * 前两组是 `skip`——spec 给的理由（"因为第三组是数据出境闸门，默认必须是关的"）
 * 与那个取值同样重要，所以两者一起显示。
 */
export interface RuleStackProps {
  kind: StackKind
  meta: StackMeta
  /** 已按判定顺序排好（`groupByStack` 的产物）。 */
  rules: Rule[]
  hitCounts: ReadonlyMap<number, number>
  busyRuleId: number | null
  onCreate: (kind: StackKind) => void
  onEdit: (rule: Rule) => void
  onShowMatches: (rule: Rule) => void
  onBusy: (id: number | null) => void
  onDone: (text: string) => void
}

export function RuleStack(props: RuleStackProps) {
  const { kind, meta, rules } = props
  const titleId = useId()
  const blocked = blockedByUnconditional(rules)
  const enabledCount = rules.filter((r) => r.enabled).length
  const readonly = useReadonly()

  return (
    <section className={styles.group} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.groupTitle}>
        {meta.index}、{meta.name}
        <Pill tone={kind === 'allow' ? 'brand' : 'neutral'}>{meta.decides}</Pill>
      </h2>
      <p className={styles.lede}>{meta.lede}</p>
      <p className={styles.fallback}>
        兜底：{meta.fallbackText}（<code>{meta.fallback}</code>）
      </p>

      {kind === 'fetch' && enabledCount === 0 && <FetchCompatNotice hasRules={rules.length > 0} />}

      {rules.length === 0 ? (
        <p className={styles.emptyStack}>{emptyText(kind)}</p>
      ) : (
        <ul className={styles.rules}>
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              stackName={meta.name}
              blockedBy={blocked.get(rule.id) ?? null}
              hits={props.hitCounts.get(rule.id)}
              busy={props.busyRuleId === rule.id}
              onEdit={props.onEdit}
              onShowMatches={props.onShowMatches}
              onBusy={props.onBusy}
              onDone={props.onDone}
            />
          ))}
        </ul>
      )}

      <Button size="sm" onClick={() => props.onCreate(kind)} disabled={readonly} title={readonlyTitle(readonly)}>
        {/* 加号只是装饰：留在可访问名里会让读屏念出「加号新建采集权限规则」 */}
        <span aria-hidden="true">+ </span>新建{meta.name}
      </Button>
    </section>
  )
}

/**
 * 空栈说的是"于是现在会发生什么"，不是一句"暂无数据"。
 * spec §8：用同一句话把三种空态糊在一起，人就不知道下一步该做什么。
 */
function emptyText(kind: StackKind): string {
  if (kind === 'allow') {
    return '这一栈还没有规则。兜底是拒绝，所以现在任何外部程序都取不到任何会议——这正是数据出境闸门该有的初始状态。'
  }
  if (kind === 'archive') {
    return '这一栈还没有规则。兜底是不归档，所以现在没有任何会议会被写进 NAS，本地文件到期后就彻底没有了。'
  }
  return '这一栈还没有规则。'
}

/**
 * 拉取栈**一条启用的规则都没有**时，实际发生的不是 spec §4.6 字面上的 skip。
 *
 * 后端有一条兼容兜底（`src/policy/fetch-compat.ts`）：库里没有启用的拉取规则时，
 * worker 沿用接线前的行为「时间窗内全拉」。这一页要是照 spec 字面写"兜底：不拉取"，
 * 就是在对着一个正在全量拉取的系统说它什么都没拉。
 *
 * 这句话是**镜像**自后端的 `FETCH_STACK_UNCONFIGURED_REASON`（没有端点下发它，
 * 记在任务报告的缺口里）。判据本身不是求值：数一数有没有启用的 fetch 规则而已。
 */
function FetchCompatNotice({ hasRules }: { hasRules: boolean }) {
  return (
    <p className={styles.compat}>
      <b>现在走的是兼容兜底，不是「不拉取」。</b>
      库里{hasRules ? '这一栈的规则全部处于停用状态' : '一条启用的拉取规则都没有'}，
      worker 沿用接线前的行为：按时间窗发现到的录制<b>全部拉取</b>。
      所以现在被拉的会议不是「被某条规则放行的」，而是「还没有规则可管它」。
      ⚠️ 建下第一条拉取规则的那一刻兜底就翻面成 spec §4.6 的 skip，
      届时没有被任何一条拉取规则命中的会议将不再被拉取——
      想先把现状显式化，第一条请建一条无条件的「全拉」，再用影响预览逐步收紧。
    </p>
  )
}

interface RuleRowProps {
  rule: Rule
  stackName: string
  blockedBy: number | null
  hits: number | undefined
  busy: boolean
  onEdit: (rule: Rule) => void
  onShowMatches: (rule: Rule) => void
  onBusy: (id: number | null) => void
  onDone: (text: string) => void
}

function RuleRow(props: RuleRowProps) {
  const { rule } = props
  const readonly = useReadonly()
  const [toggleError, setToggleError] = useState<string | null>(null)
  const joinWord = rule.join === 'or' ? '或' : '且'
  const neverMatches = neverMatchesForLackOfDataSource(rule)

  async function toggle() {
    props.onBusy(rule.id)
    setToggleError(null)
    try {
      await setRuleEnabled(rule.id, !rule.enabled)
      props.onDone(`${rule.enabled ? '停用' : '启用'}了规则 #${rule.id}`)
    } catch (e) {
      setToggleError(e instanceof ApiError ? e.message : String(e))
    } finally {
      props.onBusy(null)
    }
  }

  return (
    <li
      className={styles.rule}
      data-off={rule.enabled ? undefined : 'true'}
      aria-label={`${props.stackName} #${rule.id}`}
    >
      <div className={styles.priority} title="优先级（降序求值）">
        {Number.isFinite(rule.priority) ? rule.priority : '—'}
      </div>

      <div className={styles.ruleBody}>
        <p className={styles.cond}>
          {rule.condsMalformed ? (
            <span className={styles.condBad}>条件写坏了（conds 不是数组）</span>
          ) : rule.conds.length === 0 ? (
            <span className={styles.condAll}>所有会议（无条件）</span>
          ) : (
            rule.conds.map((c, i) => (
              <span key={i}>
                {i > 0 && <span className={styles.join}> {joinWord} </span>}
                <span className={c === null ? styles.condBad : undefined}>
                  {describeCondition(c)}
                </span>
              </span>
            ))
          )}
          <span className={styles.arrow}> → </span>
          <b>{describeEffect(rule.kind, rule.effect, rule.assetTypes)}</b>
        </p>

        <p className={styles.meta}>
          {rule.note !== null && rule.note !== '' && <span>{rule.note} · </span>}
          {rule.enabled ? null : <span className={styles.off}>已停用 · </span>}
          <span>
            {rule.createdBy ?? '建立人不详'} 于 {fmtDay(rule.createdAt)} 创建
          </span>
          {rule.subjectValue !== null && rule.subjectValue !== '' && (
            <span> · 采集程序 {rule.subjectValue}</span>
          )}
        </p>

        {/* 后端的静态检查结果，逐条原样显示。不挑一条当摘要——
            校验刻意不短路就是为了一次把能说的都说完 */}
        {rule.issues.length > 0 && (
          <ul className={styles.issues}>
            {rule.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        )}

        {neverMatches && (
          <p className={styles.warnLine}>
            这条规则<b>永远不会命中</b>：它每一个条件用的字段当前都没有数据源。
          </p>
        )}

        {props.blockedBy !== null && rule.enabled && (
          <p className={styles.warnLine}>
            上面的规则 #{props.blockedBy} 是无条件的（匹配一切），
            求值到那一条就停了——这条<b>够不着</b>。
          </p>
        )}

        {toggleError !== null && (
          <p className={styles.rowError} role="alert">
            {toggleError}
          </p>
        )}
      </div>

      <button
        type="button"
        className={styles.hits}
        onClick={() => props.onShowMatches(rule)}
        aria-label={
          props.hits === undefined
            ? `查看命中的会议（规则 #${rule.id}）`
            : `命中 ${props.hits} 场，查看是哪几场（规则 #${rule.id}）`
        }
      >
        {/* 没问过后端就没有这个数。摆一个 0 或者一个占位数字，
            都是在替一次没发生的求值下结论 */}
        <b>{props.hits === undefined ? '?' : props.hits}</b>
        <span>{props.hits === undefined ? '查看命中' : '场命中'}</span>
      </button>

      <div className={styles.ruleActions}>
        {/* 「编辑」对只读账号也禁用：编辑器一打开就要发 `POST /rules/preview`
            算影响预览，而那条在后端是写端点（A8 的 18 条之一），只读账号会
            当场吃一个 403。规则本身的条件在上面这一行已经逐条写出来了，
            要看命中哪几场还有「查看命中」（GET），两条读路径都留着。 */}
        <Button
          size="sm"
          variant="quiet"
          onClick={() => props.onEdit(rule)}
          disabled={readonly}
          title={readonlyTitle(readonly)}
        >
          编辑
        </Button>
        <Button
          size="sm"
          variant="quiet"
          onClick={toggle}
          disabled={props.busy || readonly}
          title={readonlyTitle(readonly)}
        >
          {props.busy ? '…' : rule.enabled ? '停用' : '启用'}
        </Button>
      </div>
    </li>
  )
}
