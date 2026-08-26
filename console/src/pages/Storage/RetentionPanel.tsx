import { readonlyTitle, useReadonly } from '@/app/session'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import type { PillTone } from '@/ui/Pill'
import { fmtBytes } from '@/lib/format'
import type { RetentionWindow } from '@/api/admin/storage'
import { Stat } from './Stat'
import styles from './Storage.module.css'

/**
 * 默认保留天数这一行怎么说，取决于 `defaultDaysSource`——**三个取值在界面上
 * 必须分得开**，尤其 `invalid`。
 *
 * `invalid` 的意思是：有人往 `default_retention_days` 里写了一个不是 1–365
 * 整数的值。这时**不能显示一个 30 顶上**：归档流水线那边是
 * `retentionSetting ? Number(retentionSetting) : 30`，一个 'abc' 会让它拿到
 * NaN，而不是回落到 30。页面上显示 30 等于替一个坏掉的配置打掩护，
 * 而这件事的后果落在保留窗口上——那是本系统唯一不可逆的一侧。
 */
export function describeDefaultDays(r: RetentionWindow): { tone: PillTone; pill: string; text: string } {
  switch (r.defaultDaysSource) {
    case 'setting':
      return {
        tone: 'neutral',
        pill: `默认 ${r.defaultDays} 天`,
        text: `默认保留天数 ${r.defaultDays} 天，库里配的就是这个值。此后新归档的会议按它计时。`,
      }
    case 'fallback':
      return {
        tone: 'neutral',
        pill: `默认 ${r.defaultDays} 天`,
        text:
          `默认保留天数 ${r.defaultDays} 天 —— 没有配过 default_retention_days，` +
          '用的是归档流水线内置的默认值。改一次就会写进配置。',
      }
    case 'invalid':
      return {
        tone: 'fail',
        pill: '默认保留天数非法',
        text:
          `默认保留天数的配置值非法：库里写的是「${r.defaultDaysRaw ?? ''}」，不是 1–365 之间的整数。` +
          '系统不会替它回落到内置默认值——归档流水线直接把这个值当数字用，' +
          '于是此后新归档的会议会拿到一个算不出到期日的保留期。请立刻改成合法值。',
      }
    default:
      return {
        tone: 'warn',
        pill: '默认保留天数来源未知',
        text:
          `默认保留天数的来源未知：后端下发的是「${r.defaultDaysSource}」，前端没见过这个取值。` +
          `旁边这个天数（${r.defaultDays ?? '空'}）可不可信，得先去后端确认。`,
      }
  }
}

export type StorageBusy = 'pause' | 'days' | 'export' | 'cleanup'

export interface RetentionPanelProps {
  retention: RetentionWindow
  /** 正在进行中的动作。按钮据此变 pending，且不允许并发发第二次 */
  busy: StorageBusy | null
  onTogglePause: () => void
  onEditDays: () => void
  onExport: () => void
  onCleanup: () => void
}

/**
 * 本地保留窗口（spec §4.9 的第二块）：四个数 + 三个动作，外加
 * 「暂停 / 恢复到期清理」——系统状态横幅上的那个动作链到的就是这里
 * （F0 报告 §2.2），所以它必须在这一页上真的做得成。
 */
export function RetentionPanel(props: RetentionPanelProps) {
  const { retention: r, busy, onTogglePause, onEditDays, onExport, onCleanup } = props
  const d = describeDefaultDays(r)
  const anyBusy = busy !== null
  // 「导出可采集清单」不在其中：它是一条 GET，只读账号本来就该能导。
  const readonly = useReadonly()
  const roTitle = readonlyTitle(readonly)

  return (
    <section className={styles.panel} aria-labelledby="storage-retention-title">
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <h2 id="storage-retention-title" className={styles.panelTitle}>
            本地保留窗口
          </h2>
          <p className={styles.path}>采集程序只能从这个窗口里取数据，取不到就得去 NAS。</p>
        </div>
        <Pill tone={d.tone}>{d.pill}</Pill>
      </div>

      <p
        className={r.defaultDaysSource === 'setting' || r.defaultDaysSource === 'fallback' ? styles.note : styles.warnNote}
        data-testid="retention-default"
      >
        {d.text}
      </p>

      <div className={styles.stats}>
        <Stat id="live" label="保留期内" value={r.liveMeetings} note="本地文件还在，采集程序取得到。" />
        <Stat id="granted" label="其中已授权" value={r.grantedMeetings} />
        <Stat id="expiring" label="7 天内到期" value={r.expiringIn7dMeetings} />
        <Stat id="local-bytes" label="本地占用" value={fmtBytes(r.localBytes)} />
        <Stat
          id="expired"
          label="已到期待清理"
          value={r.expiredMeetings}
          note="到期时刻已过、但本地文件还没被删掉的。「立即清理」动的就是这些。"
        />
      </div>

      <p
        className={r.cleanupPaused ? styles.cleanupPaused : styles.cleanupState}
        data-testid="cleanup-state"
      >
        <span className={styles.cleanupStateLabel}>
          {r.cleanupPaused ? '到期清理已暂停' : '到期清理正常运行'}
        </span>
        <span>
          {r.cleanupPaused
            ? '恢复之前不会再删除任何本地文件——包括那些已经到期的。'
            : '到期的本地文件会被清理任务自动删掉（记录与 NAS 路径保留）。'}
        </span>
      </p>

      <div className={styles.actions}>
        <Button onClick={onEditDays} disabled={anyBusy || readonly} title={roTitle}>
          修改默认保留天数
        </Button>
        <Button variant="quiet" onClick={onExport} disabled={anyBusy} aria-busy={busy === 'export'}>
          导出可采集清单
        </Button>
        <Button
          variant="quiet"
          onClick={onCleanup}
          disabled={anyBusy || readonly}
          title={roTitle}
          aria-busy={busy === 'cleanup'}
        >
          立即清理已到期文件
        </Button>
        {/* 暂停开关与它的状态摆在一起。文案随状态换，但按钮名字本身就是它要做的事，
            不在 pending 时改名——改名会让点下去之后按钮在原地变成另一个动作。 */}
        <Button
          variant={r.cleanupPaused ? 'primary' : 'warn'}
          onClick={onTogglePause}
          disabled={anyBusy || readonly}
          title={roTitle}
          aria-busy={busy === 'pause'}
        >
          {r.cleanupPaused ? '恢复到期清理' : '暂停到期清理'}
        </Button>
      </div>

      {/* spec §4.9 逐字给出的那段话。它是产品模型的复述：数据库记录永久保留，
          删的只是本地那份取用副本。删掉它，这一页就变成了一个删除工具。 */}
      <p className={styles.note} data-testid="retention-model-note">
        到期只删本地文件，<b>数据库记录永久保留</b>
        ——会议标题、时间、主持人、内容哈希、以及归档到 NAS
        的具体目录。所以历史会议在这里依然搜得到，只是要按给出的路径去 NAS 取。
      </p>
    </section>
  )
}
