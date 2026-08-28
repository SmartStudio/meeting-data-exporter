import type { InventoryItem, ProgramInventory } from '@/api/admin/grants'
import { assetsOrDash, remedyHint } from '@/api/admin/programs'
import { daysLeft, fmtDateTime } from '@/lib/format'
import { Pill } from '@/ui/Pill'
import { Sheet } from '@/ui/Sheet'
import styles from './InventorySheet.module.css'

/**
 * 「查看清单」——把卡片上那一个数字摊开成逐场。
 *
 * 面板顶部曾经逐字复述三个「与」（有授权 且 在保留期内 且 规则允许采集）。
 * **这段话已经删掉**：下半张表逐场写着「被哪一条判定挡下、去哪儿改」
 * （`blockers[].reason` 加 `remedyHint`），那是同一件知识落在具体那一行上的样子。
 * 一段总论加一份逐行清单，读的人只会用逐行那一份。
 *
 * **只有会议 id，没有标题**：`GET /programs/:id/inventory` 的条目里不下发会议
 * 元数据（`meetingId` / `subMeetingId` / `assetTypes` / 判定，没有 `title`）。
 * 与其在这里替它编一个"未知会议"，不如把 id 原样摆出来。
 */
export function InventorySheet({
  open,
  onClose,
  programName,
  inv,
  now,
}: {
  open: boolean
  onClose: () => void
  programName: string
  inv: ProgramInventory
  now: Date
}) {
  const granted = inv.fetchableCount + inv.blockedCount

  return (
    <Sheet size="lg" open={open} onClose={onClose} title={`${programName} 现在能取走什么`}>
      <p className={styles.note}>
        已授权 {granted} 场，其中现在能取到 <b>{inv.fetchableCount}</b> 场。
      </p>

      {inv.fetchable.length === 0 ? (
        <p className={styles.empty}>当前没有任何会议对它开放。</p>
      ) : (
        <ul className={styles.list}>
          {inv.fetchable.map((item) => (
            <li key={keyOf(item)} className={styles.row}>
              <div className={styles.main}>
                <MeetingRef item={item} />
                <div className={styles.assets}>{assetsOrDash(item.assetTypes)}</div>
                {item.decision !== null && (
                  <div className={styles.reason}>
                    {item.decision.reason}
                    {item.overridden && <span className={styles.hand}> · 人工改写</span>}
                  </div>
                )}
              </div>
              <ExpiryPill item={item} now={now} />
            </li>
          ))}
        </ul>
      )}

      {inv.blocked.length > 0 && (
        <>
          <p className={styles.sectionLabel}>已授权、但现在取不到的 {inv.blocked.length} 场</p>
          <ul className={styles.list}>
            {inv.blocked.map((item) => (
              <li key={keyOf(item)} className={styles.row} data-blocked="true">
                <div className={styles.main}>
                  <MeetingRef item={item} />
                  {item.blockers.map((b, i) => {
                    const hint = remedyHint(b.remedy)
                    return (
                      <div key={`${b.code}-${i}`} className={styles.reason}>
                        {b.reason}
                        {hint !== null && <span className={styles.hint}> · {hint}</span>}
                      </div>
                    )
                  })}
                  {item.blockers.length === 0 && (
                    <div className={styles.reason}>后端没有给出理由——这本身是个 bug，请把这一行报给维护者。</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 清单里只有会议 id。这一句留着是因为界面此刻**给不出**标题，而人看到
          一串 id 会以为标题丢了；「取用记录会写进操作审计」那半句删了——
          它是背景知识，删掉没人会因此做错事。 */}
      <p className={styles.foot}>只有会议 id：要看是哪一场，到「会议记录」页按 id 搜。</p>
    </Sheet>
  )
}

function keyOf(item: InventoryItem): string {
  return `${item.meetingId}::${item.subMeetingId}`
}

function MeetingRef({ item }: { item: InventoryItem }) {
  return (
    <div className={styles.ref}>
      <code className={styles.code}>{item.meetingId}</code>
      {item.subMeetingId !== '' && (
        <>
          {' '}
          场次 <code className={styles.code}>{item.subMeetingId}</code>
        </>
      )}
    </div>
  )
}

/**
 * 保留期还剩几天。`expiresAt === null` 是"保留窗口还没起算"（没归档成功），
 * 不是"永不过期"——两者显示成同一句话会让人以为文件安全。
 */
function ExpiryPill({ item, now }: { item: InventoryItem; now: Date }) {
  if (item.expiresAt === null) return <Pill tone="neutral">保留期未起算</Pill>
  const left = daysLeft(item.expiresAt, now)
  return (
    <Pill tone={item.expiringSoon ? 'warn' : 'brand'} className={styles.pill}>
      剩 {left} 天 · {fmtDateTime(item.expiresAt, now)}
    </Pill>
  )
}
