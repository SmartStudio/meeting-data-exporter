import type { Triage } from '@/api/types'
import type { TriageBucket } from '@/api/admin/meetings'
import { Skeleton } from '@/ui/Skeleton'
import styles from './TriageBar.module.css'

/** 界面上这一段的 id。与后端的 `triage` 取值一一对应，映射就在下面这张表里。 */
export type TriageId = 'archfail' | 'soon' | 'ungranted' | 'running' | 'nasonly'

/** 数字的色。两个语义色各自只有一个含义，这里是它们唯一被允许出现的取值。 */
export type TriageTone = 'fail' | 'warn' | 'neutral'

export interface TriageDef {
  id: TriageId
  /** `GET /meetings?triage=` 的取值，也是 `GET /meetings/triage` 响应里的键 */
  bucket: TriageBucket
  label: string
  hint: string
  tone: TriageTone
}

/**
 * 分诊条五段（spec.md §4.2），把"现在有什么需要处理"压成一行。
 * 顺序就是紧急程度，最紧急的是"到期会永久丢失"。
 *
 * 颜色不是装饰，而且**只有两个**：红＝归档失败（一个月后永久丢失，是本系统
 * 最严重的状态）、琥珀＝保留期快到了。其余三段中性——"待授权"/"处理中"/
 * "仅存 NAS" 都不是告警，给它们上色会稀释前两段。
 *
 * 「待授权」此前是品牌蓝。蓝在这一页有另一个含义（数据可被取走 / 主交互），
 * 拿它当第三种告警色用，一屏就有三种彩色数字在争第一落点——而三个第一落点
 * 等于没有落点。
 *
 * **五段的判据不在前端**。F1 时代每一段带一个 `test(m, now)` 谓词，在内存里
 * 数当前那批会议；接真 API 之后计数与筛选都在服务端（`console-meetings.ts`
 * 的 `TriageBucket`），前端再写一份谓词就是第二份真相，而两份数出来的数字
 * 不一样时，屏幕上是两个互相打架的整数。
 */
export const TRIAGE_DEFS: TriageDef[] = [
  { id: 'archfail', bucket: 'archiveFailed', label: '归档失败', hint: '到期会永久丢失', tone: 'fail' },
  { id: 'soon', bucket: 'expiringIn7d', label: '7 天内到期', hint: '过期后须去 NAS 取', tone: 'warn' },
  { id: 'ungranted', bucket: 'awaitingGrant', label: '待授权', hint: '准许采集但没给程序', tone: 'neutral' },
  { id: 'running', bucket: 'inProgress', label: '处理中', hint: '拉取或归档进行中', tone: 'neutral' },
  { id: 'nasonly', bucket: 'nasOnly', label: '仅存 NAS', hint: '本地已清理', tone: 'neutral' },
]

export function defOf(id: TriageId): TriageDef {
  // 五段是写死的常量表，找不到只可能是打错了 id——那是开发期错误
  const def = TRIAGE_DEFS.find((d) => d.id === id)
  if (!def) throw new Error(`未知的分诊格 id：${id}`)
  return def
}

export interface TriageBarProps {
  /** 五段计数。**来自 `GET /meetings/triage`**，不是当页数据现算的 */
  counts: Triage | null
  /** 当前生效的那一段。后端一次只收一个 `triage`，所以这里是单选不是多选 */
  active: TriageId | null
  onToggle: (id: TriageId) => void
  loading?: boolean
  /** 计数读不到（端点挂了）。**不许显示 0**——"不知道有几场归档失败"是另一件事 */
  unreadable?: boolean
}

/**
 * 这五个数字数的是**全部会议**，不是表格里当前那几行。
 *
 * 这句话此前是分诊条下面常驻的一行正文。它是一句**口径说明**，不是这一页的
 * 内容：读者一天看它一次就够了，而它天天占着首屏最上面的一整行。阶段 7 把它
 * 收进两个地方——每一段自己的原生 `title`（鼠标停上去就有），以及一段视觉隐藏
 * 的文字（读屏用 `aria-describedby` 念得到）。屏幕上因此少一行散文，信息一个
 * 字没丢。
 *
 * **计数读不到那一句不隐藏**：那不是口径说明，那是一次故障，必须看得见。
 */
const SCOPE_NOTE = '这五个数字统计全部会议，不受下面的搜索、筛选与分页影响。'

const UNREADABLE_NOTE = '五格计数读不到，显示的是"？"而不是 0——0 会被读成"没有需要处理的"。'

const SCOPE_ID = 'triage-scope-note'

/**
 * 五张统计卡 → 一条分段筛选条（阶段 7）。
 *
 * ## 为什么不再是卡片
 *
 * 它们**看起来像卡片、行为却是筛选器**：白底 + 1px 边 + 8px 圆角，与这一页
 * 其余所有东西同一种材质，占掉首屏 109px 高，而里面装的是五个个位数。更糟的是
 * 每张卡里还有一个单选圆圈——一个长得像展示卡、却带着表单控件的东西。
 *
 * 现在它是一条分段条：42px 高，紧贴内容顶部，选中态是**底部一道 2px 色条**
 * 而不是填充块。分段条是"同一批东西的不同切片"这个语义的标准形状，人不需要
 * 被教就知道它一次只能选一个——这也是那句「一次只能筛一格」当初被删掉时想让
 * 控件自己说的话。
 *
 * ## 计数为 0 的段照旧占一格（与阶段 6 的处置相反，前提变了）
 *
 * 阶段 6 把 0 折叠成一行细字，理由是「0 不配占一整张卡」。**卡片没有了，那条
 * 理由跟着没有了**：一段 0 在这条 42px 的横条上只占约 80px 宽，而折叠会让分段
 * 的数量随数据变化——同一个筛选器每次进来位置都不一样，比一个 0 贵得多。
 * 0 仍然不许占强调色：它走 `data-tone="zero"`，与非零的红/琥珀分得开。
 *
 * **读不到计数（`n === null`）的段显示「？」**：不知道是不是 0，写 0 等于
 * 替后端说了「没有」——而这一排里最贵的那段是「归档失败」。
 */
export function TriageBar({ counts, active, onToggle, loading = false, unreadable = false }: TriageBarProps) {
  const skeleton = loading || (counts === null && !unreadable)
  const countOf = (def: TriageDef): number | null => (counts === null ? null : counts[def.bucket])

  return (
    // `role="group"` 把五段绑成一组，读屏念得出它们是同一套筛选，
    // 而不是五个各不相干的按钮；口径说明挂在 aria-describedby 上。
    <div
      className={styles.bar}
      data-testid="triage-bar"
      role="group"
      aria-label="按处理状态筛选会议"
      aria-describedby={SCOPE_ID}
      data-loading={skeleton ? 'true' : undefined}
    >
      {TRIAGE_DEFS.map((def) => {
        if (skeleton) {
          return (
            <div key={def.id} className={styles.seg} data-skeleton="true">
              <Skeleton width="2ch" />
              <Skeleton width="5ch" size="sm" />
            </div>
          )
        }
        const n = countOf(def)
        const on = active === def.id
        return (
          <button
            key={def.id}
            type="button"
            className={styles.seg}
            // 读不到时不上语义色：那个"？"不是一次告警，是一次未知。
            // 0 同理——它是"没有需要处理的"，不该染红。
            data-tone={n === null || n === 0 ? 'zero' : def.tone}
            aria-pressed={on}
            // 读不到计数时这一段点了也没意义（筛出来的数对不上任何数字），
            // 但**不隐藏**：藏起来等于说"没有归档失败这回事"。
            disabled={n === null}
            data-testid={`triage-${def.id}`}
            // 提示与口径都收进原生 title——这一段自己解释自己，不占版面
            title={
              n === null
                ? `${def.label} 的计数读不到——不是 0，是不知道`
                : `全部会议里有 ${n} 场${def.label}（${def.hint}）。${SCOPE_NOTE}`
            }
            onClick={() => onToggle(def.id)}
          >
            <span className={styles.count} data-testid={`triage-count-${def.id}`}>
              {n === null ? '？' : n}
            </span>
            <span className={styles.label}>{def.label}</span>
          </button>
        )
      })}

      {/* 口径说明。正常时视觉隐藏（读屏与 title 仍然拿得到），
          计数读不到时露出来——那不是口径，是故障。 */}
      <p
        id={SCOPE_ID}
        className={styles.scope}
        data-visible={unreadable ? 'true' : undefined}
        data-testid="triage-scope"
      >
        {unreadable ? UNREADABLE_NOTE : SCOPE_NOTE}
      </p>
    </div>
  )
}
