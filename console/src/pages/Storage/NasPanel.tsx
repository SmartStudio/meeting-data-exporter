import { Pill } from '@/ui/Pill'
import { fmtBytes, fmtDateTime } from '@/lib/format'
import type { NasArchive } from '@/api/admin/storage'
import { Stat } from './Stat'
import styles from './Storage.module.css'

/**
 * 「这个挂载点是什么协议」。
 *
 * **后端没有下发协议**——`GET /admin/storage` 只有 `nas.root` 一个路径串。
 * 原型里那句写死的「SMB 协议」在真实数据上是一句猜测，而这一页的每一句话
 * 都会被当成对系统现状的陈述。所以这里只说观察得到的形式，并标明是推断：
 *
 * - `//host/share` 或 `\\host\share` 是 UNC 写法，那种形式只有 SMB/CIFS 用；
 * - 其余（`/mnt/nas` 这类）是一个已经挂好的本地路径，**从这一侧看不出**
 *   它底下挂的是 NFS、SMB 还是一块本地盘。看不出就说看不出。
 */
export function protocolOf(root: string | null): string {
  if (root === null) return '协议未知 —— 挂载点还没配'
  if (root.startsWith('//') || root.startsWith('\\\\')) {
    return 'SMB / CIFS（按挂载点写法推断，后端没有下发协议）'
  }
  return '协议未知 —— 后端只下发挂载点，从这一侧看不出它挂的是什么'
}

export interface NasPanelProps {
  nas: NasArchive
}

/**
 * NAS 归档（spec §4.9 的第一块）：挂载点、协议、连通状态、最近检测时间、
 * 容量三分、归档三态。
 *
 * **不可达不是错误态**：`nas.reachable === false` 时后端仍返回 200，这一块
 * 照常渲染，只是连通那一格变红、容量那几个数变成"暂不可得"。把它折成一句
 * "读取失败"会把管理员最需要的信息（还有几场没归档、清理停没停）一起藏掉。
 */
export function NasPanel({ nas }: NasPanelProps) {
  const hasCapacity = nas.totalBytes !== null && nas.availableBytes !== null

  return (
    <section className={styles.panel} aria-labelledby="storage-nas-title">
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <h2 id="storage-nas-title" className={styles.panelTitle}>
            NAS 归档
          </h2>
          <p className={styles.path}>{nas.root ?? '未配置挂载点（MDE_NAS_ROOT 没设）'}</p>
        </div>
        <Pill tone={nas.reachable ? 'brand' : 'fail'}>{nas.reachable ? '连通正常' : '无法连通'}</Pill>
      </div>

      <p className={styles.meta}>
        <span data-testid="nas-protocol">{protocolOf(nas.root)}</span>
        <span className={styles.metaSep} aria-hidden="true">
          ·
        </span>
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
              <span className={styles.capRest}>
                总容量 {fmtBytes(nas.totalBytes)} · 剩余 {fmtBytes(nas.availableBytes)}
              </span>
            </div>
            <p className={styles.statNote}>
              「本系统归档」是我们自己的记账（已归档资产声明的字节数之和），与 NAS
              上的真实占用可能对不齐；「已用 / 剩余」两个数照 statfs 原样透出。
            </p>
          </>
        ) : (
          <p className={styles.note}>
            容量暂不可得：{nas.reachable ? '这一轮探测没有拿到 statfs 的读数。' : 'NAS 不可达时探测拿不到容量。'}
            本系统自己记账的归档量是 {fmtBytes(nas.usedByUsBytes)}，但它不能回答"NAS 还剩多少"。
          </p>
        )}
      </div>

      <div className={styles.stats}>
        <Stat id="archived" label="已归档会议" value={nas.archivedMeetings} />
        <Stat
          id="pending"
          label="尚未归档完成"
          value={nas.pendingMeetings}
          note="含还没轮到的和一直归档不成功的两种——库里现在分不出来，所以这一格不是纯粹的「排队中」。"
        />
        <Stat
          id="archive-failed"
          label="归档失败"
          value={nas.failedMeetings}
          // 0 不该是红的——那是"确实没有失败"，是好消息
          tone={nas.failedMeetings !== null && nas.failedMeetings > 0 ? 'fail' : 'plain'}
          missingText="暂不可得"
          note={
            nas.failedMeetings === null
              ? (nas.failedMeetingsNote ??
                '后端没有给出这个数，也没说为什么。在它给出之前，这里不编一个数。')
              : undefined
          }
        />
      </div>
    </section>
  )
}

/**
 * 容量条。三段：本系统 / 其他 / 剩余（剩余就是轨道底色）。
 *
 * `role="img"` + 一句把三个数都念出来的 `aria-label`：颜色不能是唯一的信息
 * 载体，读屏用户没有视觉宽度可看。宽度用百分比，不写死像素。
 */
function CapacityBar({ nas, total, available }: { nas: NasArchive; total: number; available: number }) {
  const pct = (n: number): number => (total > 0 ? Math.max(0, Math.min(100, (n / total) * 100)) : 0)
  const usPct = pct(nas.usedByUsBytes)
  const othersPct = pct(nas.usedByOthersBytes ?? 0)

  return (
    <div
      className={styles.cap}
      role="img"
      aria-label={
        `容量占用：本系统归档 ${fmtBytes(nas.usedByUsBytes)}，` +
        `其他占用 ${fmtBytes(nas.usedByOthersBytes)}，` +
        `剩余 ${fmtBytes(available)}，总容量 ${fmtBytes(total)}`
      }
    >
      <i className={styles.capUs} style={{ width: `${usPct}%` }} />
      <i className={styles.capOthers} style={{ width: `${othersPct}%` }} />
    </div>
  )
}
