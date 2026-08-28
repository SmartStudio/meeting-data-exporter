import { useId, useState } from 'react'
import { Button } from '@/ui/Button'
import { ApiError } from '@/api/client'
import { setRuleEnabled, type Rule, type RulesSchema, type StackKind } from '@/api/admin/rules'
import { readonlyTitle, useReadonly } from '@/app/session'
import { fmtDay } from '@/lib/format'
import { describeCondition, describeEffect } from './fields'
import {
  blockedByUnconditional,
  matchStatsOf,
  ruleMark,
  scannedOf,
  type StackMeta,
} from './order'
import styles from './Rules.module.css'

/**
 * 一栈规则（spec §4.6 的一组）。
 *
 * ## 这一栈是一把梯子，不是一摞卡片
 *
 * 规则的本质是**按优先级降序的一把梯子**：从上往下走，第一条命中的说了算。
 * 原来一条规则是一张 98px 的白卡（边框 + 圆角 + 三行内文），十二条竖着排掉
 * 1764px——卡片把「谁在谁上面」这层结构抹平了，每一条看起来都一样重。
 *
 * 现在一条规则是一行（约 34px）：左边优先级刻度、中间「条件 → 结果」、右边命中数。
 * 列标题在栈头下面**只出现一次**，不是每条都写一遍自己的字段名。
 *
 * ## 三组必须分开，每组的兜底要写出来
 *
 * 第三组的兜底是 `deny`、前两组是 `skip`——spec 给的理由（"因为第三组是数据出境
 * 闸门，默认必须是关的"）与那个取值同样重要，所以两者一起显示。
 *
 * ## 「编辑 · 停用」不常驻
 *
 * 十二行常驻两颗按钮是纯噪声：管理员来这一页九成是**读**，改是少数动作。
 * 它们只在该行 hover 或 `:focus-within` 时浮出来——但按钮本身一直在 DOM 里、
 * 一直在 Tab 序列里，键盘走过去就看得见（`Rules.module.css` 的 `.act`）。
 * 触屏没有 hover，所以窄屏那一档里它们常驻并补足 `--tap-min`。
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
  /** 命中数是在多少场会议里数出来的。读不到就整句不出现。 */
  const scanned = scannedOf(rules)

  return (
    <section className={styles.group} aria-labelledby={titleId}>
      {/* 栈头一行：栈名 · 这一组管什么 · 右侧兜底。
          「这一组决定什么」以前是一颗徽标，那是把一句说明塞进一个状态色块里——
          它既不是状态也不会变，只是这一栈的定义 */}
      <div className={styles.stackHd}>
        <h2 id={titleId} className={styles.groupTitle}>
          {meta.index}、{meta.name}
        </h2>
        <p className={styles.what}>
          {meta.decides}
          <span className={styles.sep}> · </span>
          {meta.lede}
        </p>
        <span className={styles.spacer} />
        {/* 统计范围贴着栈头。「N 场命中」读起来像一个绝对数，但它是在一批会议里
            数出来的——那一批有多大，看得见才回溯得了。读不到就整句不出现 */}
        {scanned !== null && (
          <p
            className={styles.scanned}
            title="口径是「这条规则自身的条件匹配」，与点开的命中列表、影响预览里的「场命中」是同一件事。"
          >
            命中按最近 {scanned} 场统计
          </p>
        )}
        {/* effect 的原值（skip / deny）不上屏：那是库里那一列的取值，
            屏幕上的中文已经说完了同一件事 */}
        {fetchCompat ? (
          <p className={styles.fall} data-compat="true">
            现在 <b>没有一条启用的拉取规则管得着，发现到的录制全部拉取</b>
          </p>
        ) : (
          <p className={styles.fall}>
            兜底 <b>{meta.fallbackText}</b>
          </p>
        )}
      </div>

      {rules.length === 0 ? (
        <p className={styles.emptyStack}>{emptyText(kind)}</p>
      ) : (
        <>
          {/* 列标题给一次。每条规则都写一遍「优先级」「命中」，那三个字就成了
              十二行里最显眼的东西，而它们一个都不是这一页的内容 */}
          <div className={styles.colHd}>
            <span>优先级</span>
            <span>条件 → 结果</span>
            <span>命中</span>
            <span />
          </div>
          <ul className={styles.rules}>
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                schema={props.schema}
                schemaBlocked={props.schemaBlocked}
                stackName={meta.name}
                blockedBy={blocked.get(rule.id) ?? null}
                busy={props.busyRuleId === rule.id}
                onEdit={props.onEdit}
                onShowMatches={props.onShowMatches}
                onBusy={props.onBusy}
                onDone={props.onDone}
              />
            ))}
          </ul>
        </>
      )}

      {/* 翻面这件事只在**要建第一条规则的那一刻**才有用，所以它贴着那个按钮，
          不再是列表上方一整段告示 */}
      {fetchCompat && <FetchCompatNotice />}

      {/* schema 读不出来时也禁：编辑器里每一份取值域都来自它，开一个填着
          旧快照的表单比开不了更糟。为什么开不了在页面顶上那条横幅里说 */}
      <p className={styles.newRow}>
        <Button
          size="sm"
          variant="quiet"
          onClick={() => props.onCreate(kind)}
          disabled={readonly || props.schemaBlocked !== null}
          title={readonly ? readonlyTitle(readonly) : (props.schemaBlocked ?? undefined)}
        >
          {/* 加号只是装饰：留在可访问名里会让读屏念出「加号新建采集权限规则」 */}
          <span aria-hidden="true">+ </span>新建{meta.name}
        </Button>
      </p>
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
  busy: boolean
  onEdit: (rule: Rule) => void
  onShowMatches: (rule: Rule) => void
  onBusy: (id: number | null) => void
  onDone: (text: string) => void
}

/**
 * 一条规则 = 一行。四格：优先级 · 条件 → 结果 · 命中 · 动作。
 *
 * 坏规则**不在行里加两行橙字**，而是整行挂色条 + 换底色（`--fail` / `--warn`），
 * 说明句子跟在这一行下面一行。理由：一行里的橙字要读完整行才发现，而色条在
 * 十二行的边上是一眼扫得出来的——「这一页有几条坏的、在哪几行」是打开这一页
 * 最先要回答的问题。三类挂号的含义、以及同一类挂号为什么在不同栈里档位不同，
 * 见 `order.ts` 的 `RuleFlag` 与 `unconditionalMark`。
 */
function RuleRow(props: RuleRowProps) {
  const { rule } = props
  const readonly = useReadonly()
  const [toggleError, setToggleError] = useState<string | null>(null)
  const joinWord = rule.join === 'or' ? '或' : '且'
  const mark = ruleMark(props.schema, rule, props.blockedBy)
  const hits = matchStatsOf(rule).count

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
      data-flag={mark.flag ?? undefined}
      data-tone={mark.tone ?? undefined}
      aria-label={`${props.stackName} #${rule.id}`}
    >
      {/* 「优先级」三个字在列标题里给过一次。这里留一份读屏用的——
          列标题对着屏幕成立，读屏是逐行念的，光念一个 900 说不出它是什么 */}
      <span className={styles.pri}>
        <span className={styles.srOnly}>优先级 </span>
        {Number.isFinite(rule.priority) ? rule.priority : '—'}
      </span>

      <span className={styles.sent}>
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

        {/* 出处跟在同一行的末尾，字号退一档：它答的是「这条是谁建的、什么时候」，
            那是查起来才要的东西，不该和判定并排 */}
        <span className={styles.prov}>
          {rule.note !== null && rule.note !== '' && <> · {rule.note}</>}
          {rule.subjectValue !== null && rule.subjectValue !== '' && (
            <> · 采集程序 {rule.subjectValue}</>
          )}
          {' · '}
          {rule.createdBy ?? '建立人不详'} 建于 {fmtDay(rule.createdAt)}
        </span>
        {!rule.enabled && <span className={styles.off}> · 已停用</span>}
      </span>

      {/* 命中数直接显示，不再是一颗要点一下才知道的 `?`。数字仍然可点——
          点开还是那张命中列表。**读不到就显示 `—`**：前端自己数一遍会得到
          第二份真相，而两份不一致的地方恰好是判定边界 */}
      <button
        type="button"
        className={styles.hits}
        data-zero={hits === 0 ? 'true' : undefined}
        onClick={() => props.onShowMatches(rule)}
        aria-label={
          hits === null
            ? `命中数暂时读不到，查看命中的会议（规则 #${rule.id}）`
            : `${hits} 场命中，查看是哪几场（规则 #${rule.id}）`
        }
      >
        {hits === null ? '—' : hits}
        {hits !== null && <span className={styles.hitsUnit}> 场命中</span>}
      </button>

      {/* 常驻的两颗按钮是十二行里最重的噪声。它们只在这一行 hover /
          focus-within 时浮出来，但一直在 Tab 序列里——见 `.act` */}
      <span className={styles.act}>
        {/* 「编辑」对只读账号也禁用：编辑器一打开就要发 `POST /rules/preview`
            算影响预览，而那条在后端是写端点（A8 的 18 条之一），只读账号会
            当场吃一个 403。规则本身的条件在这一行已经逐条写出来了，
            要看命中哪几场还有命中数那颗按钮（GET），两条读路径都留着。 */}
        <button
          type="button"
          className={styles.actBtn}
          onClick={() => props.onEdit(rule)}
          disabled={readonly || props.schemaBlocked !== null}
          title={readonly ? readonlyTitle(readonly) : (props.schemaBlocked ?? undefined)}
        >
          编辑
        </button>
        <span className={styles.actSep} aria-hidden="true">
          ·
        </span>
        <button
          type="button"
          className={styles.actBtn}
          onClick={toggle}
          disabled={props.busy || readonly}
          title={readonlyTitle(readonly)}
        >
          {props.busy ? '…' : rule.enabled ? '停用' : '启用'}
        </button>
      </span>

      {/* 挂在这一行下面的说明。后端的 issues 也走这里，逐条原样显示——
          不挑一条当摘要，校验刻意不短路就是为了一次把能说的都说完 */}
      {mark.reasons.map((text, i) => (
        <span key={i} className={styles.why}>
          {text}
        </span>
      ))}

      {toggleError !== null && (
        <span className={`${styles.why} ${styles.rowError}`} role="alert">
          {toggleError}
        </span>
      )}
    </li>
  )
}
