import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AuditRow as Row } from '@/api/admin/audit'
import { fmtDateTime } from '@/lib/format'
import { Pill, type PillTone } from '@/ui/Pill'
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
function actorKindOf(kind: string): { letter: string; label: string } {
  return ACTOR_KINDS[kind] ?? { letter: '?', label: `未知身份（${kind}）` }
}

/** `audit_log.meeting_id` 这一列的两种语义（后端 `AuditObjectRef.idKind`）。 */
const ID_KINDS: Readonly<Record<string, string>> = {
  meeting: '会议维度 ID',
  meeting_record: '录制维度 ID',
  unknown: '维度不明（会议库里查不到）',
}

interface ResultView {
  tone: PillTone
  label: string
  note: string | null
}

/**
 * 结果怎么呈现。三档一一对应后端的 `result.kind`：
 *
 * - `allow` → 准许，中性。
 * - `deny` → 红（spec §4.10：「被拒绝的记录是红的，且写明拒绝原因」）。
 *   原因**一律来自后端**（`detail` 的第一行 → 命中规则 → null），
 *   前端一个字都不加工；两处都没有就说「未记录原因」，不编一句兜底理由。
 * - `unknown` → 库里那一列出现了既不是 allow 也不是 deny 的脏值。后端刻意
 *   不归一化，这里也不能二选一：标成「存疑」并把原值带出来。
 */
function resultView(result: Row['result']): ResultView {
  if (result.kind === 'allow') return { tone: 'neutral', label: '准许', note: null }
  if (result.kind === 'deny') {
    return { tone: 'fail', label: '拒绝', note: result.reason ?? '未记录原因' }
  }
  return {
    tone: 'warn',
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
  /** 展开行要横跨的列数。 */
  colSpan: number
}

export function AuditRow({ row, now, expanded, onToggle, colSpan }: AuditRowProps) {
  const kind = actorKindOf(row.actor.kind)
  const res = resultView(row.result)
  const detailLine = row.detail === null ? null : firstLine(row.detail)

  return (
    <>
      <tr data-testid={`audit-row-${row.id}`} data-deny={row.result.kind === 'deny' || undefined}>
        <td className={styles.timeCell}>{fmtDateTime(row.at, now)}</td>

        <td>
          <span className={styles.actor} data-testid={`audit-actor-${row.id}`} data-kind={row.actor.kind}>
            <span className={styles.actorBadge} data-kind={row.actor.kind} aria-hidden="true">
              {kind.letter}
            </span>
            <span className={styles.stack}>
              <span className={styles.main}>{row.actor.id}</span>
              {/* 色块是概括，`actor_type` 原值才是能对回库里那一行的东西 */}
              <span className={styles.sub}>
                {kind.label} · {row.actor.type}
              </span>
            </span>
          </span>
        </td>

        <td>
          <span className={styles.stack}>
            <span className={styles.main}>{row.actionLabel ?? row.action}</span>
            {/* 后端认不出的动作 `actionLabel` 是 null，此时主行显示的就是原值，
                不再重复一遍——重复只会让人以为这是两个不同的东西。 */}
            {row.actionLabel !== null && <span className={styles.mono}>{row.action}</span>}
          </span>
        </td>

        <td>
          <ObjectCell object={row.object} />
        </td>

        <td data-testid={`audit-result-${row.id}`} data-kind={row.result.kind}>
          <span className={styles.stack}>
            <Pill tone={res.tone}>{res.label}</Pill>
            {res.note !== null && (
              <span className={row.result.kind === 'deny' ? styles.denyNote : styles.sub}>{res.note}</span>
            )}
          </span>
        </td>

        <td>
          <span className={styles.stack}>
            <span className={styles.detail} data-testid={`audit-detail-${row.id}`}>
              {detailLine === null || detailLine === '' ? (
                <span className={styles.missing} title="这条记录没有留下操作明细">
                  无细节
                </span>
              ) : (
                detailLine
              )}
            </span>
            <button
              type="button"
              className={styles.expandBtn}
              aria-expanded={expanded}
              aria-controls={`audit-expanded-${row.id}`}
              onClick={() => onToggle(row.id)}
            >
              完整记录
            </button>
          </span>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={colSpan} className={styles.expandCell}>
            <div className={styles.expanded} id={`audit-expanded-${row.id}`} data-testid={`audit-expanded-${row.id}`}>
              <dl className={styles.facts}>
                <Fact term="记录编号">#{row.id}</Fact>
                <Fact term="资产">
                  {row.asset === null ? (
                    <span className={styles.missing}>这次操作不针对某一份资产</span>
                  ) : (
                    <>
                      <span className={styles.mono}>{row.asset.id}</span>
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
                <Fact term="发起端">
                  {row.clientKind ?? <span className={styles.missing}>未记录</span>}
                </Fact>
                <Fact term="对象 ID">
                  {row.object === null ? (
                    <span className={styles.missing}>不针对某一场会议</span>
                  ) : (
                    <>
                      <span className={styles.mono}>{row.object.id}</span>
                      {' · '}
                      {ID_KINDS[row.object.idKind] ?? `维度原值 ${row.object.idKind}`}
                    </>
                  )}
                </Fact>
              </dl>

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
    return (
      <span className={styles.stack}>
        <span className={styles.missing}>这次操作不针对某一场会议</span>
      </span>
    )
  }

  const title =
    object.title ??
    // 拿 ID 冒充标题是这一格最容易犯的错：一个看着像标题的 ID 会被读成会议名。
    '标题缺失（会议库里查不到这个 ID）'

  return (
    <span className={styles.stack}>
      {object.meetingId === null ? (
        <span className={object.title === null ? styles.missing : styles.main}>{title}</span>
      ) : (
        // 跳的是**归一化到会议维度**的那个 ID：`issue_download_url` 存的是
        // record 维度的 ID，拿它去查会议只会得到一个空抽屉。
        <Link className={styles.link} to={`/preview/${encodeURIComponent(object.meetingId)}`}>
          {title}
        </Link>
      )}
      {object.code === null ? (
        <span className={styles.missing}>会议号缺失</span>
      ) : (
        <span className={styles.mono}>{object.code}</span>
      )}
    </span>
  )
}
