import type { ReactNode } from 'react'
import { ProgressBar } from '@/ui/ProgressBar'
import { fmtBytes, fmtDateTime } from '@/lib/format'
import type { NasArchive } from '@/api/admin/storage'
import { Hint, Stat } from './Stat'
import styles from './Storage.module.css'

/**
 * 状态点 + 一句话。这一轮全站收敛的口径（D-jobs-storage brief）：正常态不进
 * 一个彩色框——「连通正常」原来是一个蓝描边 Pill，蓝色留给按钮这类主交互，
 * 这里视觉上并入中性；出问题（NAS 不可达）才给 `--fail`。
 */
function StatusLine({ tone, children }: { tone: 'neutral' | 'fail'; children: ReactNode }) {
  return (
    <span className={styles.statusLine} data-tone={tone}>
      <span className={styles.statusDot} aria-hidden="true" />
      {children}
    </span>
  )
}

/**
 * 「这个挂载点是什么协议」。
 *
 * **后端没有下发协议**——`GET /admin/storage` 只有 `nas.root` 一个路径串。
 * 原型里那句写死的「SMB 协议」在真实数据上是一句猜测，而这一页的每一句话
 * 都会被当成对系统现状的陈述。所以这里只说观察得到的形式，并标明是推断：
 *
 * - `//host/share` 或 `\\host\share` 是 UNC 写法，那种形式只有 SMB/CIFS 用；
 * - 其余（`/mnt/nas` 这类）是一个已经挂好的本地路径，**从这一侧看不出**
 *   它底下挂的是 NFS、SMB 还是一块本地盘。
 *
 * **`text === null` 的那一支不再当主文案**：一句"协议未知 —— 后端只下发挂载点"
 * 占的是管理员本来想看信息的位置，讲的却是"系统不知道某件事"。它降级成挂载点
 * 旁边的一个 ⓘ：想查的人查得到，不想查的人不必先读完它才看到别的。
 */
export function protocolOf(root: string | null): { text: string | null; hint: string } {
  if (root === null) {
    return { text: null, hint: '协议未知：挂载点还没配，无从判断。' }
  }
  if (root.startsWith('//') || root.startsWith('\\\\')) {
    return {
      text: 'SMB / CIFS',
      hint: '按挂载点的 UNC 写法推断——后端只下发挂载点，没有下发协议。',
    }
  }
  return {
    text: null,
    hint: '协议未知：后端只下发挂载点，从这一侧看不出它挂的是 NFS、SMB 还是一块本地盘。',
  }
}

export interface NasPanelProps {
  nas: NasArchive
}

/**
 * NAS 归档（spec §4.9 的第一块）：挂载点、连通状态、最近检测时间、
 * 容量三分、归档三态。
 *
 * **不可达不是错误态**：`nas.reachable === false` 时后端仍返回 200，这一块
 * 照常渲染，只是连通那一格变红、容量那几个数变成"暂不可得"。把它折成一句
 * "读取失败"会把管理员最需要的信息（还有几场没归档、清理停没停）一起藏掉。
 */
export function NasPanel({ nas }: NasPanelProps) {
  const hasCapacity = nas.totalBytes !== null && nas.availableBytes !== null
  const proto = protocolOf(nas.root)

  return (
    <section className={styles.panel} aria-labelledby="storage-nas-title">
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <h2 id="storage-nas-title" className={styles.panelTitle}>
            NAS 归档
          </h2>
          <p className={styles.path}>
            <span>{nas.root ?? '未配置挂载点'}</span>
            <span className={styles.protocol} data-testid="nas-protocol">
              {proto.text !== null && <span className={styles.protocolText}>{proto.text}</span>}
              <Hint text={proto.hint} />
            </span>
          </p>
        </div>
        <StatusLine tone={nas.reachable ? 'neutral' : 'fail'}>
          {nas.reachable ? '连通正常' : '无法连通'}
        </StatusLine>
      </div>

      <p className={styles.meta}>
        最近检测 {fmtDateTime(nas.checkedAt)}
        {nas.latencyMs !== null && `（耗时 ${nas.latencyMs} ms）`}
      </p>

      {!nas.reachable && (
        <p className={styles.failNote} data-testid="nas-error">
          {/* 原因由后端下发，前端不自己编一句"网络故障" */}
          {nas.error ?? '后端没有给出不可达的原因。'}
        </p>
      )}

      <div data-testid="nas-capacity">
        {hasCapacity ? (
          <>
            <CapacityBar nas={nas} total={nas.totalBytes!} available={nas.availableBytes!} />
            <div className={styles.capKey}>
              <span className={styles.capKeyItem}>
                <i className={`${styles.swatch} ${styles.swatchUs}`} aria-hidden="true" />
                本系统归档 {fmtBytes(nas.usedByUsBytes)}
              </span>
              <span className={styles.capKeyItem}>
                <i className={`${styles.swatch} ${styles.swatchOthers}`} aria-hidden="true" />
                其他占用 {fmtBytes(nas.usedByOthersBytes)}
              </span>
              <span className={styles.capKeyItem}>
                <i className={`${styles.swatch} ${styles.swatchFree}`} aria-hidden="true" />
                剩余 {fmtBytes(nas.availableBytes)}
              </span>
              <span className={styles.capRest}>总容量 {fmtBytes(nas.totalBytes)}</span>
            </div>
            {/* 从前这句口径挂在图例的 ⓘ 上（悬停才看得到，还带着 statfs 这个
                syscall 名）。D-jobs-storage brief 把 7 个 ⓘ 砍到 2 个以内——这句
                够短，写成一行可见的小字就够了，不必再靠悬停。 */}
            <p className={styles.capNote}>
              本系统的记账可能与 NAS 上的真实占用对不齐；已用与剩余以挂载点读数为准。
            </p>
          </>
        ) : (
          <p className={styles.note}>
            容量暂不可得
            {nas.reachable ? '：这一轮探测没有拿到读数。' : '：NAS 不可达时探测拿不到容量。'}
            本系统记账的归档量是 {fmtBytes(nas.usedByUsBytes)}。
          </p>
        )}
      </div>

      <div className={styles.stats}>
        <Stat id="archived" label="已归档会议" value={nas.archivedMeetings} note="NAS 上有副本" />
        {/* 「等待归档」与「归档报错」的名字是有来历的，见文件末尾那段注释。
            口径以前挂在 ⓘ 上，现在是一句可见的小字（D-jobs-storage brief）。 */}
        <Stat
          id="pending"
          label="等待归档"
          value={nas.pendingMeetings}
          note="含还没轮到的和一直归不上去的"
        />
        <Stat
          id="archive-failed"
          label="归档报错"
          value={nas.failedMeetings}
          // 0 不该是红的——那是"确实没有报错"，是好消息
          tone={nas.failedMeetings !== null && nas.failedMeetings > 0 ? 'fail' : 'plain'}
          missingText="暂不可得"
          note={
            nas.failedMeetings === null
              ? (nas.failedMeetingsNote ?? '后端没有给出这个数，也没说为什么。')
              // 不用「归档失败」这四个字：那个词这一页已经让给会议记录页
              // 分诊条上的同名计数，两处口径不同，不该在正文里撞见同一个词。
              : '与会议记录页的计数是两个口径，不要求相等'
          }
        />
      </div>
    </section>
  )
}

/**
 * 容量条。三段：本系统 / 其他 / 剩余（剩余就是轨道底色）。
 *
 * **为什么还是一条条**：真实数据上本系统只占 0.53%（4.93 GB / 926 GB），
 * 条形确实表达不了这个量级——但这条条回答的主要问题不是"我们占了多少"，
 * 而是"这块卷还剩多少空间"（39% 剩余），那是一个不折不扣的比例问题，条形是
 * 对的载体。本系统那一份留在条上是因为它回答第二个问题："卷要满了的时候，
 * 是不是我们撑的"——答案在这里是一眼可见的"不是"。它的真实字节数由图例给出，
 * 不靠宽度读。
 *
 * `role="img"` + 一句把三个数都念出来的 `aria-label`（由 ProgressBar 渲染）：
 * 颜色不能是唯一的信息载体，读屏用户没有视觉宽度可看。
 */
function CapacityBar({ nas, total, available }: { nas: NasArchive; total: number; available: number }) {
  return (
    <ProgressBar
      className={styles.cap}
      max={total}
      segments={[
        { id: 'us', value: nas.usedByUsBytes, tone: 'brand' },
        { id: 'others', value: nas.usedByOthersBytes ?? 0, tone: 'neutral' },
      ]}
      label={
        `容量占用：本系统归档 ${fmtBytes(nas.usedByUsBytes)}，` +
        `其他占用 ${fmtBytes(nas.usedByOthersBytes)}，` +
        `剩余 ${fmtBytes(available)}，总容量 ${fmtBytes(total)}`
      }
    />
  )
}

/* ── 「等待归档」/「归档报错」这两个名字 ─────────────────────────────
 *
 * 这两格从前叫「尚未归档完成」和「归档失败」，各配一段正文解释它们为什么
 * 对不上。改名而不是改文案，理由有两条：
 *
 * 1. **「归档失败」这个词在两个页面上是两个数**。会议记录页分诊条的「归档失败」
 *    数的是 `console-meetings.ts` 那条时间判据——最后一个资产下载完 6 小时后
 *    仍然没进 `meeting_archives`；这一页数的是归档任务记下来、还没恢复的报错行。
 *    真实数据上前者是 1、后者是 0：那一场会议压根没轮到归档轮跑，所以没人替它
 *    记过错。**两个口径都对，是同一个词不该同时指两件事**。这一页让出这个词。
 * 2. 从前那段"与右边的「归档失败」有意重叠"的正文，是作者知道两个数会打架、
 *    却选择写一段话而不是改设计。名字互斥之后那段话就没有必要了。
 *
 * 后端的两个口径**不是 bug，也不要去"对齐"**——`src/store/console-meetings.ts`
 * 的 `ARCHIVE_GRACE_SEC` 注释里逐条写了为什么两条判据都得留着：`job_failures`
 * 里没有行不等于归档没出事（还没轮到、或者进程在记账之前就断了）。
 */
