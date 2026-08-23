import type { Meeting } from '@/api/types'
import { daysLeft } from '@/lib/format'
import { Skeleton } from '@/ui/Skeleton'
import styles from './TriageBar.module.css'

export type TriageId = 'archfail' | 'soon' | 'ungranted' | 'running' | 'nasonly'

/** 大数字的色。三个语义色各自只有一个含义，这里是它们唯一被允许出现的取值。 */
export type TriageTone = 'fail' | 'warn' | 'brand' | 'neutral'

export interface TriageDef {
  id: TriageId
  label: string
  hint: string
  tone: TriageTone
  test: (m: Meeting, now: Date) => boolean
}

/**
 * 分诊条五格（spec.md §4.2），把"现在有什么需要处理"压成一行。
 * 顺序就是紧急程度，最紧急的是"到期会永久丢失"。
 *
 * 颜色不是装饰：红＝失败（归档失败意味着一个月后永久丢失，是本系统最严重的
 * 状态）、琥珀＝保留期快到了、蓝＝数据可被取走。后两格是中性的——"处理中"和
 * "仅存 NAS"都不需要人做什么，给它们上色会稀释前三格的告警。
 */
export const TRIAGE_DEFS: TriageDef[] = [
  {
    id: 'archfail',
    label: '归档失败',
    hint: '到期会永久丢失',
    tone: 'fail',
    test: (m) => m.archive === 'failed',
  },
  {
    id: 'soon',
    label: '7 天内到期',
    hint: '过期后须去 NAS 取',
    tone: 'warn',
    test: (m, now) =>
      m.keep.expiresAt !== null && !m.keep.filesGone && daysLeft(m.keep.expiresAt, now) <= 7,
  },
  {
    id: 'ungranted',
    label: '待授权',
    hint: '准许采集但没给程序',
    tone: 'brand',
    test: (m) =>
      m.allow === 'allow' && m.archive === 'done' && m.grants.length === 0 && !m.keep.filesGone,
  },
  {
    id: 'running',
    label: '处理中',
    hint: '拉取或归档进行中',
    tone: 'neutral',
    test: (m) => m.fetch === 'running' || m.archive === 'running',
  },
  {
    id: 'nasonly',
    label: '仅存 NAS',
    hint: '本地已清理',
    tone: 'neutral',
    test: (m) => m.keep.filesGone,
  },
]

export function triageCount(meetings: Meeting[], def: TriageDef, now: Date): number {
  return meetings.filter((m) => def.test(m, now)).length
}

export interface TriageBarProps {
  meetings: Meeting[]
  now: Date
  /** 当前生效的分诊筛选。同时点两格是"与"，跟原型一致。 */
  active: ReadonlySet<TriageId>
  onToggle: (id: TriageId) => void
  loading?: boolean
}

/**
 * 加载中用**骨架卡**而不是把整排收起来（spec.md §8）：这一排占着 100 多像素高，
 * 数据一到再冒出来，整页会往下跳一大段。骨架的职责就是占住真实的位置。
 */
export function TriageBar({ meetings, now, active, onToggle, loading = false }: TriageBarProps) {
  if (loading) {
    return (
      <div className={styles.bar} data-testid="triage-bar" data-loading="true">
        {TRIAGE_DEFS.map((def) => (
          <div key={def.id} className={styles.card} data-skeleton="true">
            <Skeleton width="2em" />
            <Skeleton width="58%" size="sm" />
            <Skeleton width="78%" size="sm" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={styles.bar} data-testid="triage-bar">
      {TRIAGE_DEFS.map((def) => {
        const n = triageCount(meetings, def, now)
        const on = active.has(def.id)
        return (
          <button
            key={def.id}
            type="button"
            className={styles.card}
            // 计数为 0 时不上语义色——0 场归档失败不该还画着红字。
            data-tone={n === 0 ? 'zero' : def.tone}
            aria-pressed={on}
            data-testid={`triage-${def.id}`}
            onClick={() => onToggle(def.id)}
          >
            <span className={styles.count} data-testid={`triage-count-${def.id}`}>
              {n}
            </span>
            <span className={styles.label}>{def.label}</span>
            <span className={styles.hint}>{def.hint}</span>
          </button>
        )
      })}
    </div>
  )
}
