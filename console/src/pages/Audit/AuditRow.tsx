import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AuditRow as Row } from '@/api/admin/audit'
import { fmtDateTimeSec, fmtTimeSec } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import styles from './Audit.module.css'

/**
 * 审计表的一行 + 它展开之后的那一块。
 *
 * ## 这一页不许「聪明」
 *
 * 审计是这个系统的可回溯性底座。**不折叠、不去重、不合并**——两条看起来
 * 一样的记录就是发生过两次，把它们并成「×2」会让"同一个程序在一分钟内取了
 * 两次"变成"取了一次"，而那正是事后要查的东西。
 *
 * ### 会议详情抽屉从 2026-08-31 起**折**，这一页仍然不折
 *
 * 抽屉底部那段历史会把连续且逐字相同的行折成一行（`Meetings/display.ts` 的
 * `groupHistory`）。**那不是这条规矩的例外**：上面禁的是「把两次显示成一次」,
 * 而那边把 `×N` 和时间区间都摆在行上，次数与跨度一个没丢。
 *
 * 两页仍然分开处理，理由是它们的读法不同：
 *
 * - 抽屉是**一场会议的摘要**，回答「谁动过它」，一屏之内读完，没有逐行展开;
 * - 这一页是**总账**，一行行读，每一行都能展开看自己的 `detail`、自己的规则
 *   快照。折叠之后「展开的是哪一行的 detail」当场就答不上来——折叠会毁掉这一页
 *   真正的能力，而抽屉根本没有那个能力可毁。
 *
 * 想把两边改成一样之前，先回答这个问题。
 *
 * ## 一行一条、一眼一行
 *
 * 行上只放**读一遍就够**的东西：时刻、谁、做了什么、对哪场会、结果、一句明细。
 * 能对回库里那一行的原值（`actor_type`、动作代码、资产 ID、规则号、发起端）
 * 全在展开区——它们是查证时才要的，摆在行上只会把每行撑成三行，一屏看不到
 * 十条。**一个字都没丢**，只是换了地方。
 *
 * ## 缺的字段显示成缺，不填默认值
 *
 * `detail` 为 NULL（迁移 008 之前的历史记录）显示「无细节」而不是留空——
 * 空白让人以为是渲染坏了。`title` 补不齐时说「标题缺失」而不是拿 ID 顶上——
 * 一个看着像标题的 ID 会让管理员以为这场会议就叫这个名字。
 */

/** 色块 → 那一个字 + 一句人话。`unknown` 单独一档，**不折进前三种任何一种**。 */
const ACTOR_KINDS: Readonly<Record<string, { letter: string; label: string }>> = {
  prog: { letter: '程', label: '程序' },
  person: { letter: '人', label: '人' },
  sys: { letter: '系', label: '系统' },
  unknown: { letter: '?', label: '未知身份' },
}

/** 认不出的色块也要有个说法：把原值显示出来，而不是套一个已知色块。 */
function actorKindOf(kind: string): { letter: string; label: string; known: boolean } {
  const k = ACTOR_KINDS[kind]
  if (k === undefined) return { letter: '?', label: `未知身份（${kind}）`, known: false }
  return { ...k, known: kind !== 'unknown' }
}

/** `audit_log.meeting_id` 这一列的两种语义（后端 `AuditObjectRef.idKind`）。 */
const ID_KINDS: Readonly<Record<string, string>> = {
  meeting: '会议维度 ID',
  meeting_record: '录制维度 ID',
  unknown: '维度不明（会议库里查不到）',
}

interface ResultView {
  label: string
  note: string | null
}

/**
 * 结果怎么呈现。三档一一对应后端的 `result.kind`：
 *
 * - `allow` → 准许。这是**默认值**，14 行里通常 11 行是它——不该占视觉：
 *   一段 `--ink-3` 的普通文字，无框无底。
 * - `deny` → 红（spec §4.10：「被拒绝的记录是红的，且写明拒绝原因」）。
 *   原因**一律来自后端**（`detail` 的第一行 → 命中规则 → null），
 *   前端一个字都不加工；两处都没有就说「未记录原因」，不编一句兜底理由。
 *   拒绝与存疑都在行左侧加一道色条（`data-flag`）——一屏几十行时，只有
 *   一格变色扫不出来，一道贯穿整行的色条才扫得出来。
 * - `unknown` → 库里那一列出现了既不是 allow 也不是 deny 的脏值。后端刻意
 *   不归一化，这里也不能二选一：标成「存疑」并把原值带出来。
 */
function resultView(result: Row['result']): ResultView {
  if (result.kind === 'allow') return { label: '准许', note: null }
  if (result.kind === 'deny') {
    return { label: '拒绝', note: result.reason ?? '未记录原因' }
  }
  return {
    label: '存疑',
    note: result.reason ?? `库里的结果值是「${result.decision}」，既不是 allow 也不是 deny`,
  }
}

/** 明细里给人看的那句话：**第一行**。其余是紧凑 JSON 附文，展开才看。 */
function firstLine(detail: string): string {
  return detail.split('\n')[0]?.trim() ?? ''
}

export interface AuditRowProps {
  row: Row
  /** 判断"是不是同一年"的基准，跟着这次查询的时间锚点走。 */
  now: Date
  expanded: boolean
  onToggle: (id: number) => void
  onFilterActor: (id: string) => void
  onFilterAction: (action: string) => void
  /** 展开行要横跨的列数。 */
  colSpan: number
}

export function AuditRow({ row, now, expanded, onToggle, onFilterActor, onFilterAction, colSpan }: AuditRowProps) {
  const kind = actorKindOf(row.actor.kind)
  const res = resultView(row.result)
  const detailLine = row.detail === null ? null : firstLine(row.detail)
  const actorShown = row.actor.name ?? row.actor.id
  const panelId = `audit-expanded-${row.id}`

  /**
   * 整行可点开。点在链接 / 按钮上的不算（那是它们自己的事），正在选中文字
   * 的也不算——拖着选一段明细文字松手时，行不该突然展开。
   */
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('a, button, select, input')) return
    if ((window.getSelection?.()?.toString() ?? '') !== '') return
    onToggle(row.id)
  }

  return (
    <>
      <tr
        className={styles.row}
        data-testid={`audit-row-${row.id}`}
        // 拒绝/存疑才标——准许是默认值，行左侧的色条只留给需要先被看到的两种
        data-flag={row.result.kind !== 'allow' ? row.result.kind : undefined}
        data-expanded={expanded ? 'true' : undefined}
        onClick={onRowClick}
      >
        {/* data-label 是窄屏卡片形态下的列名（`ui/Table` 的 cards 开关）*/}
        <td className={styles.timeCell} data-label="时间">
          {/* 日期在上面的分组行里；这里只报当天的时刻，到秒——同一分钟里的两次
              取用靠秒才分得开。完整日期时间挂在 title 上，悬停可见。 */}
          <time dateTime={new Date(row.at * 1000).toISOString()} title={fmtDateTimeSec(row.at, now)}>
            {fmtTimeSec(row.at)}
          </time>
        </td>

        <td className={styles.actorCell} data-label="操作者">
          <span className={styles.actor} data-testid={`audit-actor-${row.id}`} data-kind={row.actor.kind}>
            {/* 色块里那一个字是装饰，读屏念的是旁边那段隐藏文本「程序」——
                颜色不是唯一的信息载体。 */}
            <span className={styles.actorBadge} data-kind={row.actor.kind} aria-hidden="true">
              {kind.letter}
            </span>
            {kind.known && <span className={styles.srOnly}>{kind.label}</span>}
            {/* 有人名就显示人名，uuid 退到 `title`。**解析不出时仍然显示 id**——
                它是仅有的线索，拿它冒充人名才是不许的那件事，留空不是更诚实而是更糟。
                `actor_type` 原值在展开区。 */}
            <span className={styles.actorName} title={`${kind.label} · ${row.actor.type} · ${row.actor.id}`}>
              {actorShown}
            </span>
            {/* 认不出的身份要在行上就看得见：折进任何一种已知色块都是说谎。 */}
            {!kind.known && (
              <span className={styles.tag} data-tone="warn">
                {kind.label} · {row.actor.type}
              </span>
            )}
          </span>
        </td>

        <td className={styles.actionCell} data-label="动作">
          {row.actionLabel !== null ? (
            <span className={styles.actionText} title={row.action}>
              {row.actionLabel}
            </span>
          ) : (
            /* `actionLabel` 是 null = **后端没给这个动作登记中文名**。显示原值，但
               必须说清那是原值——一行裸的 snake_case 读起来与一个真的叫这个名字
               的动作一模一样，于是漏登记永远不会被人发现（后端那张表停在 3 行的
               原因就是这个）。措辞与 `/history` 那句 `<原值>（未登记标签）` 一致。 */
            <span className={styles.actionRaw}>
              <code className={styles.code}>{row.action}</code>
              <span className={styles.tag} data-tone="warn" data-testid={`audit-unlabeled-${row.id}`}>
                未登记标签
              </span>
            </span>
          )}
        </td>

        <td className={styles.objectCell} data-label="对象">
          <ObjectCell object={row.object} />
        </td>

        <td
          className={styles.resultCell}
          data-label="结果"
          data-testid={`audit-result-${row.id}`}
          data-kind={row.result.kind}
        >
          {row.result.kind === 'allow' ? (
            <span className={styles.allow}>{res.label}</span>
          ) : (
            <span className={styles.resultLine}>
              <Pill tone={row.result.kind === 'deny' ? 'fail' : 'warn'}>{res.label}</Pill>
              {res.note !== null && (
                <span className={row.result.kind === 'deny' ? styles.denyNote : styles.warnNote}>{res.note}</span>
              )}
            </span>
          )}
        </td>

        <td className={styles.detailCell} data-label="细节">
          {detailLine === null || detailLine === '' ? (
            <span className={styles.missing} data-testid={`audit-detail-${row.id}`} title="这条记录没有留下操作明细">
              无细节
            </span>
          ) : (
            <span className={styles.detail} data-testid={`audit-detail-${row.id}`} title={detailLine}>
              {detailLine}
            </span>
          )}
        </td>

        <td className={styles.toggleCell}>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label="完整记录"
            title={expanded ? '收起' : '完整记录'}
            onClick={() => onToggle(row.id)}
          >
            <Chevron />
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className={styles.expandRow}>
          <td colSpan={colSpan} className={styles.expandCell}>
            <div className={styles.expanded} id={panelId} data-testid={panelId}>
              <dl className={styles.facts}>
                <Fact term="记录编号">#{row.id}</Fact>
                <Fact term="时间">{fmtDateTimeSec(row.at, now)}</Fact>
                <Fact term="操作者">
                  {actorShown}
                  {' · '}
                  {kind.label}
                  {' · '}
                  <span className={styles.code}>{row.actor.type}</span>
                  {' · '}
                  <span className={styles.code}>{row.actor.id}</span>
                </Fact>
                <Fact term="动作代码">
                  <span className={styles.code}>{row.action}</span>
                </Fact>
                <Fact term="资产">
                  {row.asset === null ? (
                    <span className={styles.missing}>这次操作不针对某一份资产</span>
                  ) : (
                    <>
                      <span className={styles.code}>{row.asset.id}</span>
                      {' · '}
                      {row.asset.type ?? <span className={styles.missing}>类型缺失</span>}
                    </>
                  )}
                </Fact>
                <Fact term="命中规则">
                  {row.matchedRuleId === null ? (
                    <span className={styles.missing}>没有命中规则</span>
                  ) : (
                    `#${row.matchedRuleId}`
                  )}
                </Fact>
                <Fact term="发起端">{row.clientKind ?? <span className={styles.missing}>未记录</span>}</Fact>
                <Fact term="对象 ID">
                  {row.object === null ? (
                    <span className={styles.missing}>不针对某一场会议</span>
                  ) : (
                    <>
                      <span className={styles.code}>{row.object.id}</span>
                      {' · '}
                      {ID_KINDS[row.object.idKind] ?? `维度原值 ${row.object.idKind}`}
                    </>
                  )}
                </Fact>
              </dl>

              {/* 从这一条出发缩小范围——不用抄 ID，也不用知道动作代码怎么拼。 */}
              <div className={styles.expandActs}>
                <Button size="sm" onClick={() => onFilterActor(row.actor.id)}>
                  只看这个操作者
                </Button>
                <Button size="sm" onClick={() => onFilterAction(row.action)}>
                  只看这个动作
                </Button>
              </div>

              <div className={styles.detailFull}>
                <h4 className={styles.factTerm}>操作明细全文</h4>
                {row.detail === null ? (
                  <p className={styles.missing}>
                    无细节。这条记录写下时库里还没有 `detail` 列（迁移 008 之前），
                    后端也没有可回退的旧明细。
                  </p>
                ) : (
                  // 附文是紧凑 JSON，原样展示。拆开重排会把"当时那条规则长什么样"
                  // 变成"我们现在认为它长什么样"。
                  <pre className={styles.pre}>{row.detail}</pre>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factTerm}>{term}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  )
}

function ObjectCell({ object }: { object: Row['object'] }) {
  if (object === null) {
    // 登录、跑定时任务这类操作本来就没有对象。一个短词，不是一句话——
    // 这一格在一屏里会出现几十次。
    return (
      <span className={styles.missing} title="这次操作不针对某一场会议">
        无关联会议
      </span>
    )
  }

  return (
    <span className={styles.object}>
      {object.title === null ? (
        // 拿 ID 冒充标题是这一格最容易犯的错：一个看着像标题的 ID 会被读成会议名。
        <span className={styles.missing} title="会议库里查不到这个 ID">
          标题缺失
        </span>
      ) : object.meetingId === null ? (
        <span className={styles.objectTitle}>{object.title}</span>
      ) : (
        // 跳的是**归一化到会议维度**的那个 ID：`issue_download_url` 存的是
        // record 维度的 ID，拿它去查会议只会得到一个空抽屉。
        <Link className={styles.link} to={`/preview/${encodeURIComponent(object.meetingId)}`} title={object.title}>
          {object.title}
        </Link>
      )}
      {object.code === null ? (
        <span className={styles.missing}>会议号缺失</span>
      ) : (
        <span className={styles.code}>{object.code}</span>
      )}
    </span>
  )
}
