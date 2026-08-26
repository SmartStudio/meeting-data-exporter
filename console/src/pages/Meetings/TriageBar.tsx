import type { Triage } from '@/api/types'
import type { TriageBucket } from '@/api/admin/meetings'
import { Skeleton } from '@/ui/Skeleton'
import styles from './TriageBar.module.css'

/** 界面上这一格的 id。与后端的 `triage` 取值一一对应，映射就在下面这张表里。 */
export type TriageId = 'archfail' | 'soon' | 'ungranted' | 'running' | 'nasonly'

/** 大数字的色。三个语义色各自只有一个含义，这里是它们唯一被允许出现的取值。 */
export type TriageTone = 'fail' | 'warn' | 'brand' | 'neutral'

export interface TriageDef {
  id: TriageId
  /** `GET /meetings?triage=` 的取值，也是 `GET /meetings/triage` 响应里的键 */
  bucket: TriageBucket
  label: string
  hint: string
  tone: TriageTone
}

/**
 * 分诊条五格（spec.md §4.2），把"现在有什么需要处理"压成一行。
 * 顺序就是紧急程度，最紧急的是"到期会永久丢失"。
 *
 * 颜色不是装饰：红＝失败（归档失败意味着一个月后永久丢失，是本系统最严重的
 * 状态）、琥珀＝保留期快到了、蓝＝数据可被取走。后两格是中性的——"处理中"和
 * "仅存 NAS"都不需要人做什么，给它们上色会稀释前三格的告警。
 *
 * **五格的判据不在前端**。F1 时代每一格带一个 `test(m, now)` 谓词，在内存里
 * 数当前那批会议；接真 API 之后计数与筛选都在服务端（`console-meetings.ts`
 * 的 `TriageBucket`），前端再写一份谓词就是第二份真相，而两份数出来的数字
 * 不一样时，屏幕上是两个互相打架的整数。
 */
export const TRIAGE_DEFS: TriageDef[] = [
  { id: 'archfail', bucket: 'archiveFailed', label: '归档失败', hint: '到期会永久丢失', tone: 'fail' },
  { id: 'soon', bucket: 'expiringIn7d', label: '7 天内到期', hint: '过期后须去 NAS 取', tone: 'warn' },
  { id: 'ungranted', bucket: 'awaitingGrant', label: '待授权', hint: '准许采集但没给程序', tone: 'brand' },
  { id: 'running', bucket: 'inProgress', label: '处理中', hint: '拉取或归档进行中', tone: 'neutral' },
  { id: 'nasonly', bucket: 'nasOnly', label: '仅存 NAS', hint: '本地已清理', tone: 'neutral' },
]

export function defOf(id: TriageId): TriageDef {
  // 五格是写死的常量表，找不到只可能是打错了 id——那是开发期错误
  const def = TRIAGE_DEFS.find((d) => d.id === id)
  if (!def) throw new Error(`未知的分诊格 id：${id}`)
  return def
}

export interface TriageBarProps {
  /** 五格计数。**来自 `GET /meetings/triage`**，不是当页数据现算的 */
  counts: Triage | null
  /** 当前生效的那一格。后端一次只收一个 `triage`，所以这里是单选不是多选 */
  active: TriageId | null
  onToggle: (id: TriageId) => void
  loading?: boolean
  /** 计数读不到（端点挂了）。**不许显示 0**——"不知道有几场归档失败"是另一件事 */
  unreadable?: boolean
}

/**
 * 这五个数字数的是**全部会议**，不是表格里当前那几行。
 *
 * 副标常驻、不随状态改写：一句只在打架那一刻才冒出来的解释，自己就成了
 * 第二个会说谎的东西；而且加载中那一支也要占住同样的高度，否则数据一到整页往下跳。
 */
const SCOPE_NOTE = '这五个数字统计全部会议，不受下面的搜索、筛选与分页影响。一次只能筛一格。'

/**
 * 加载中用**骨架卡**而不是把整排收起来（spec.md §8）：这一排占着 100 多像素高，
 * 数据一到再冒出来，整页会往下跳一大段。骨架的职责就是占住真实的位置。
 */
export function TriageBar({ counts, active, onToggle, loading = false, unreadable = false }: TriageBarProps) {
  const skeleton = loading || (counts === null && !unreadable)
  return (
    <div className={styles.bar} data-testid="triage-bar" data-loading={skeleton ? 'true' : undefined}>
      {skeleton
        ? TRIAGE_DEFS.map((def) => (
            <div key={def.id} className={styles.card} data-skeleton="true">
              <Skeleton width="2em" />
              <Skeleton width="58%" size="sm" />
              <Skeleton width="78%" size="sm" />
            </div>
          ))
        : TRIAGE_DEFS.map((def) => {
            const n = counts === null ? null : counts[def.bucket]
            const on = active === def.id
            return (
              <button
                key={def.id}
                type="button"
                className={styles.card}
                // 计数为 0 时不上语义色——0 场归档失败不该还画着红字。
                // 读不到时同样不上色：那个"？"不是一次告警，是一次未知。
                data-tone={n === null || n === 0 ? 'zero' : def.tone}
                aria-pressed={on}
                // 读不到计数时这一格点了也没意义（筛出来的数对不上任何数字），
                // 但**不隐藏**：藏起来等于说"没有归档失败这回事"。
                disabled={n === null}
                data-testid={`triage-${def.id}`}
                title={
                  n === null
                    ? `${def.label} 的计数读不到——不是 0，是不知道`
                    : `全部会议里有 ${n} 场${def.label}`
                }
                onClick={() => onToggle(def.id)}
              >
                <span className={styles.count} data-testid={`triage-count-${def.id}`}>
                  {n === null ? '？' : n}
                </span>
                <span className={styles.label}>{def.label}</span>
                <span className={styles.hint}>{def.hint}</span>
              </button>
            )
          })}
      <p className={styles.scope} data-testid="triage-scope">
        {unreadable ? '五格计数读不到，显示的是"？"而不是 0——0 会被读成"没有需要处理的"。' : SCOPE_NOTE}
      </p>
    </div>
  )
}
