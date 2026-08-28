import { useId, useState } from 'react'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import { ApiError } from '@/api/client'
import { setRuleEnabled, type Rule, type RulesSchema, type StackKind } from '@/api/admin/rules'
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
  /** 条件字段与动作的取值域。**null = `GET /rules/schema` 读不出来**。 */
  schema: RulesSchema | null
  /** schema 用不了时的一句话（读取中 / 读取失败），要能上按钮的 title。 */
  schemaBlocked: string | null
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
  /** 见 `FetchCompatNotice`：这一栈没有启用的规则时，兜底不是 skip。 */
  const fetchCompat = kind === 'fetch' && enabledCount === 0

  return (
    <section className={styles.group} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.groupTitle}>
        {meta.index}、{meta.name}
        <Pill tone={kind === 'allow' ? 'brand' : 'neutral'}>{meta.decides}</Pill>
      </h2>
      <p className={styles.lede}>{meta.lede}</p>
      {/* effect 的原值（skip / deny）不再跟在后面：那是库里那一列的取值，
          屏幕上的中文已经说完了同一件事 */}
      {fetchCompat ? (
        <p className={styles.fallback} data-compat="true">
          现在：<b>没有一条启用的拉取规则管得着，发现到的录制全部拉取</b>
        </p>
      ) : (
        <p className={styles.fallback}>兜底：{meta.fallbackText}</p>
      )}

      {rules.length === 0 ? (
        <p className={styles.emptyStack}>{emptyText(kind)}</p>
      ) : (
        <ul className={styles.rules}>
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              schema={props.schema}
              schemaBlocked={props.schemaBlocked}
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

      {/* 翻面这件事只在**要建第一条规则的那一刻**才有用，所以它贴着那个按钮，
          不再是列表上方一整段告示 */}
      {fetchCompat && <FetchCompatNotice />}

      {/* schema 读不出来时也禁：编辑器里每一份取值域都来自它，开一个填着
          旧快照的表单比开不了更糟。为什么开不了在页面顶上那条横幅里说 */}
      <Button
        size="sm"
        onClick={() => props.onCreate(kind)}
        disabled={readonly || props.schemaBlocked !== null}
        title={readonly ? readonlyTitle(readonly) : (props.schemaBlocked ?? undefined)}
      >
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
  // 「兜底是 X」上面那一行刚说过，这里只说"于是现在会发生什么"
  if (kind === 'allow') return '还没有规则。现在任何外部程序都取不到任何会议。'
  if (kind === 'archive') return '还没有规则。现在没有任何会议会被归档。'
  return '还没有规则。'
}

/**
 * 拉取栈**一条启用的规则都没有**时，实际发生的不是 spec §4.6 字面上的 skip。
 *
 * 后端有一条兼容兜底（`src/policy/fetch-compat.ts`）：库里没有启用的拉取规则时，
 * worker 沿用接线前的行为「时间窗内全拉」。
 *
 * ## 这件事以前是一段"更正"，现在是兜底那一行本身
 *
 * 原来的写法是：兜底那一行照 spec 字面写「一条都不匹配时不拉取」，下面再挂一段
 * 一百多字的告示说「其实不是，现在全拉」。**那是让一个标签先说假话、再用一段
 * 散文去改口。** 现在假话不说了——没有启用规则时兜底那一行直接写「发现到的录制
 * 全部拉取」，于是这段告示里只剩下那句标签自己说不出来的话：**建第一条会翻面。**
 *
 * 它贴在「新建拉取规则」按钮上方而不是列表顶上：翻面是按下那个按钮之后才发生的事。
 */
function FetchCompatNotice() {
  return (
    <p className={styles.compat}>
      建下第一条拉取规则的那一刻，这一栈就翻面成「一条都不匹配时不拉取」——
      届时没有被任何一条拉取规则命中的会议将<b>不再被拉取</b>。
    </p>
  )
}

interface RuleRowProps {
  rule: Rule
  schema: RulesSchema | null
  schemaBlocked: string | null
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
  const neverMatches = neverMatchesForLackOfDataSource(props.schema, rule)

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
      {/* 「优先级」三个字写在数字下面，不再是一个 title——
          鼠标停上去才看得见的标签，对读不懂这个数的人等于不存在 */}
      <div className={styles.priority}>
        <b>{Number.isFinite(rule.priority) ? rule.priority : '—'}</b>
        <span>优先级</span>
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
                  {describeCondition(props.schema, c)}
                </span>
              </span>
            ))
          )}
          <span className={styles.arrow}> → </span>
          <b>{describeEffect(props.schema, rule.kind, rule.effect, rule.assetTypes)}</b>
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
            <b>永远不会命中</b>：条件用的字段当前都没有数据源。
          </p>
        )}

        {props.blockedBy !== null && rule.enabled && (
          <p className={styles.warnLine}>
            <b>够不着</b>：上面的 #{props.blockedBy} 是无条件规则（匹配一切），求值到那里就停了。
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
          disabled={readonly || props.schemaBlocked !== null}
          title={readonly ? readonlyTitle(readonly) : (props.schemaBlocked ?? undefined)}
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
