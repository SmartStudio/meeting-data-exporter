import { useState } from 'react'
import type { ServiceProgram } from '@/api/admin/grants'
import { programStanding, STANDING_LABEL } from '@/api/admin/programs'
import { fmtDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import { BlockedAside, ReachBlock, useInventory } from './ReachBlock'
import { InventorySheet } from './InventorySheet'
import styles from './Consumers.module.css'

/**
 * 一个外部程序一张卡片（spec §4.5）。
 *
 * 卡片上**没有「停用」与「轮换凭据」**：这两个动作的后端端点还不存在
 * （spec §11 缺口 4，裁定 G-e / G-h：数据层的 `enabled` / `secret_hash` 两列已经
 * 在了，缺的是两个 handler，由 A8 补、F7 接）。留一个点了没反应的按钮比没有这个
 * 按钮更差——它会让人以为自己已经停用了一个程序，而那个程序还在取数。
 */
export function ProgramCard({ program, now }: { program: ServiceProgram; now: Date }) {
  const [listOpen, setListOpen] = useState(false)
  const res = useInventory(program.id)
  const standing = programStanding(program, Math.floor(now.getTime() / 1000))

  return (
    <li className={styles.card}>
      <div className={styles.cardTop}>
        <div className={styles.ident}>
          <h2 className={styles.name}>{program.name}</h2>
          <code className={styles.id}>{program.id}</code>
        </div>
        {/* 「正常」不必挂个徽标说出来；只有停用与过期才是需要先被看到的事 */}
        {standing !== 'active' && (
          <Pill tone={standing === 'disabled' ? 'neutral' : 'warn'}>{STANDING_LABEL[standing]}</Pill>
        )}
      </div>

      <ReachBlock programId={program.id} standing={standing} res={res} />
      {res.state === 'ready' && <BlockedAside inv={res.data} />}

      <div className={styles.cardFoot}>
        <span className={styles.meta}>
          操作者身份 {program.tmUserId} · 接入于 {fmtDateTime(program.createdAt, now)}
          {program.expiresAt !== null && ` · 凭据 ${fmtDateTime(program.expiresAt, now)} 到期`}
        </span>
        {/* 清单拉不到时不给这个按钮：没有清单可看 */}
        {res.state === 'ready' && (
          <Button size="sm" variant="quiet" onClick={() => setListOpen(true)}>
            查看清单
          </Button>
        )}
      </div>

      {res.state === 'ready' && (
        <InventorySheet
          open={listOpen}
          onClose={() => setListOpen(false)}
          programName={program.name}
          inv={res.data}
          now={now}
        />
      )}
    </li>
  )
}
