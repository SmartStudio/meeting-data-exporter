import { useState } from 'react'
import type { ServiceProgram } from '@/api/admin/grants'
import { programStanding, STANDING_LABEL } from '@/api/admin/programs'
import { fmtDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import { BlockedAside, ReachBlock, useInventory } from './ReachBlock'
import { InventorySheet } from './InventorySheet'
import { ProgramActions } from './ProgramActions'
import styles from './Consumers.module.css'

/**
 * 一个外部程序一张卡片（spec §4.5）。
 *
 * 「停用 / 启用」与「轮换凭据」在 `ProgramActions` 里（spec §11 缺口 4）——
 * A8 把两条端点补上之后才放这两个按钮。在那之前这里一个按钮都没有，
 * 因为「点了没反应的按钮」会让人以为自己已经停用了一个还在取数的程序。
 */
export function ProgramCard({
  program,
  now,
  onChanged,
}: {
  program: ServiceProgram
  now: Date
  /** 停用 / 启用 / 轮换成功之后重取整个列表（不做乐观更新，裁定 G-c）。 */
  onChanged: () => void
}) {
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

      <ProgramActions program={program} onChanged={onChanged} />

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
