import { useEffect, useState } from 'react'
import type { Consumer, Meeting } from '@/api/types'
import { daysLeft, fmtDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import { Sheet } from '@/ui/Sheet'
import { assetTotals } from './MeetingRow'
import { grantCellKind } from './write'
import styles from './GrantPicker.module.css'

export interface GrantPickerProps {
  open: boolean
  onClose: () => void
  /** 单场授权就是一场；批量授权是选中的那一批。 */
  meetings: Meeting[]
  consumers: Consumer[]
  now: Date
  /** 确认后要把这批会议的授权改成 / 加上这些程序。 */
  onConfirm: (consumerIds: string[]) => void
}

/** 这场会议这次会不会被真的改到？不会的话，为什么。 */
function skipReason(m: Meeting): string | null {
  const kind = grantCellKind(m).kind
  if (kind === 'denied') return '规则禁止，将跳过'
  if (kind === 'expired') return '已到期，将跳过'
  if (kind === 'na') return '无资产，将跳过'
  if (kind === 'wait') return '未归档，将跳过'
  return null
}

/**
 * 采集程序选择浮层。单场用它，批量也用它——**批量时逐条列出会议并标出哪些会被
 * 跳过**，不给"一键全授权"：授权是数据出企业边界的闸门，闸门不该有一键。
 *
 * 用 `Sheet`（底部面板）而不是 `Popover`：`ui/Table` 的外框是
 * `overflow: hidden`，绝对定位的 Popover 贴在行里会被裁掉（详见 task-6 报告
 * 对 T4 的反馈）。Sheet 是固定定位的，不受表格裁剪影响，窄屏下也更好按。
 */
export function GrantPicker({
  open,
  onClose,
  meetings,
  consumers,
  now,
  onConfirm,
}: GrantPickerProps) {
  const single = meetings.length === 1 ? meetings[0] : undefined
  const [checked, setChecked] = useState<string[]>([])

  // 每次打开都按当前数据重置：单场沿用它已有的授权（改的是"这场给谁"），
  // 批量从空开始（加的是"再给谁"），不要把上一次的勾选带过来。
  useEffect(() => {
    if (!open) return
    setChecked(single ? [...single.grants] : [])
  }, [open, single])

  const eligible = meetings.filter((m) => skipReason(m) === null)
  const title = single ? '授权给采集程序' : `批量授权 ${meetings.length} 场会议`

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className={styles.lead}>
        授权后，下列会议在各自的<b>保留期内</b>可被该程序自主取走，不再逐次确认。
        保留期结束后授权自动失效。请逐条核对。
      </p>

      <ul className={styles.meetings} data-testid="grant-picker-meetings">
        {meetings.map((m) => {
          const skip = skipReason(m)
          const left = m.keep.expiresAt !== null ? daysLeft(m.keep.expiresAt, now) : null
          const { got } = assetTotals(m)
          return (
            <li key={m.id} className={styles.meeting} data-skip={skip !== null}>
              <div className={styles.meetingMain}>
                <div className={styles.meetingTitle}>{m.title}</div>
                <div className={styles.meetingMeta}>
                  {m.host} · {fmtDateTime(m.startAt, now)} · {got} 项资产
                </div>
              </div>
              {skip ? (
                <Pill tone="warn">{skip}</Pill>
              ) : (
                <Pill tone="brand">保留期剩 {left ?? 0} 天</Pill>
              )}
            </li>
          )
        })}
        {meetings.length === 0 && <li className={styles.meeting}>未选择任何会议</li>}
      </ul>

      <fieldset className={styles.consumers}>
        <legend className={styles.legend}>选择采集程序</legend>
        {consumers.map((c) => (
          <label key={c.id} className={styles.option}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={checked.includes(c.id)}
              onChange={(e) =>
                setChecked((prev) =>
                  e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id),
                )
              }
            />
            <span>
              <span className={styles.optionName}>{c.name}</span>
              {/* 这里原来还跟着一个 `c.scope`（'AI 纪要 + 完整转写' 一类）。
                  那是个配置串，不是这个程序实际能取到的东西，阶段 5 · F4 连同
                  `Consumer.scope` 一起删了——要看实际结果去采集授权页，那一页
                  的每个数字都来自 `GET /admin/programs/:id/inventory`。 */}
              <span className={styles.optionMeta}>{c.id}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className={styles.note}>
        {eligible.length === meetings.length
          ? '保留期结束后授权自动失效。'
          : `${meetings.length - eligible.length} 场会议不满足条件，本次会跳过。`}
      </p>

      <div className={styles.actions}>
        <Button variant="quiet" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" disabled={eligible.length === 0} onClick={() => onConfirm(checked)}>
          {single ? '保存授权' : `确认授权 ${eligible.length} 场`}
        </Button>
      </div>
    </Sheet>
  )
}
