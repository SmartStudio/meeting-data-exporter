import { useState } from 'react'
import type { ServiceProgram } from '@/api/admin/grants'
import { programStanding, STANDING_LABEL } from '@/api/admin/programs'
import { fmtDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import { BlockedCell, ReachCell, useInventory } from './ReachBlock'
import { InventorySheet } from './InventorySheet'
import { ProgramActions } from './ProgramActions'
import styles from './Consumers.module.css'

/**
 * 一个外部程序一行（spec §4.5）。
 *
 * 三个采集程序是同构对象——同一组字段，只有值不一样——卡片给不了对比
 * （哪个能取的最多、哪个凭据最老），表格才给得了：每一行是同一套列，
 * 眼睛可以直接竖着比。第四个程序接进来只是多一行，不会把版式撑坏
 * （原来三张等高卡在只有两三个程序时会被 `align-items: stretch` 拉出
 * 200px 空洞，这个问题随着卡片消失一起消失）。
 *
 * 「停用 / 启用」与「轮换凭据」在 `ProgramActions` 里（spec §11 缺口 4）。
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
    <tr>
      <td data-label="程序">
        <div className={styles.identWrap}>
          <h2 className={styles.name}>{program.name}</h2>
          {/* 「正常」不必挂个徽标说出来；只有停用与过期才是需要先被看到的事 */}
          {standing !== 'active' && (
            <Pill tone={standing === 'disabled' ? 'neutral' : 'warn'}>{STANDING_LABEL[standing]}</Pill>
          )}
          {/* 自动授权开着 = 会有一个任务替人往这一行上加授权。品牌蓝按设计系统
              §2.2 的含义就是"数据可被取走"，这里正是那件事。关着的时候不挂徽标：
              那是默认状态，说出来只会把真正需要先看到的两个徽标挤掉。 */}
          {program.autoGrant && <Pill tone="brand">自动授权</Pill>}
        </div>
        <code className={styles.id}>{program.id}</code>
      </td>

      <ReachCell programId={program.id} standing={standing} autoGrant={program.autoGrant} res={res} />
      <BlockedCell res={res} />

      <td data-label="操作者身份">
        <code className={styles.operatorId}>{program.tmUserId}</code>
      </td>

      <td data-label="接入时间">
        <div className={styles.timeStack}>
          <span className={styles.timeMain}>{fmtDateTime(program.createdAt, now)}</span>
          {program.expiresAt !== null && (
            <span className={styles.timeSub}>凭据 {fmtDateTime(program.expiresAt, now)} 到期</span>
          )}
        </div>
      </td>

      <td data-label="操作">
        <div className={styles.actionsCell}>
          {/* 清单拉不到时不给这个按钮：没有清单可看 */}
          {res.state === 'ready' && (
            <Button size="sm" variant="quiet" onClick={() => setListOpen(true)}>
              查看清单
            </Button>
          )}
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
        </div>
      </td>
    </tr>
  )
}
