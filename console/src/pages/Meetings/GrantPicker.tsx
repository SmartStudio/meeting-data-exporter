import { useEffect, useState } from 'react'
import type { ServiceProgram } from '@/api/admin/grants'
import type { AdminMeeting } from '@/api/admin/meetings'
import { daysLeft, fmtDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import { Sheet } from '@/ui/Sheet'
import { assetTotals, grantSkipReason, hostLabel, meetingTitle } from './display'
import styles from './GrantPicker.module.css'

export interface GrantPickerProps {
  open: boolean
  onClose: () => void
  /** 单场授权就是一场；批量授权是选中的那一批。 */
  meetings: readonly AdminMeeting[]
  programs: readonly ServiceProgram[]
  now: Date
  /** 有写操作在跑——确认按钮要禁用并说出自己在忙 */
  busy: boolean
  /** 确认后要把这批会议的授权改成 / 加上这些程序。 */
  onConfirm: (programIds: string[]) => void
}

/**
 * 采集程序选择浮层。单场用它，批量也用它——**批量时逐条列出会议并标出哪些会被
 * 跳过**，不给"一键全授权"：授权是数据出企业边界的闸门，闸门不该有一键。
 *
 * 用 `Sheet`（底部面板）而不是 `Popover`：`ui/Table` 的外框是
 * `overflow: hidden`，绝对定位的 Popover 贴在行里会被裁掉。Sheet 是固定定位的，
 * 不受表格裁剪影响，窄屏下也更好按。
 *
 * ## 「这个程序能取到什么」这一句为什么不在这里
 *
 * F1 的 mock 给每个程序挂了一个 `scope` 串（「AI 纪要 + 完整转写」）。真实的
 * `GET /api/v1/admin/programs` **不下发这个字段**（阶段 4 · T7 裁定）：那句话
 * 必须是「规则栈 ∩ 授权范围 ∩ 实际存在的资产」三者求交之后的**实际结果**，
 * 而求交要逐程序打一次 `GET /programs/:id/inventory`。把一个未经求交的配置串
 * 摆在这里，等于把它伪装成一次实际结果。所以这里只显示程序**身份**
 * （id 与操作者），能取到什么去采集授权页看。
 */
export function GrantPicker({
  open,
  onClose,
  meetings,
  programs,
  now,
  busy,
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

  const eligible = meetings.filter((m) => grantSkipReason(m) === null)
  const title = single ? '授权给采集程序' : `批量授权 ${meetings.length} 场会议`

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className={styles.lead}>
        授权后，下列会议在各自的<b>保留期内</b>可被该程序自主取走，不再逐次确认。
        保留期结束后授权自动失效。请逐条核对。
      </p>

      <ul className={styles.meetings} data-testid="grant-picker-meetings">
        {meetings.map((m) => {
          const skip = grantSkipReason(m)
          const left = m.keep.expiresAt !== null ? daysLeft(m.keep.expiresAt, now) : null
          const { got } = assetTotals(m)
          return (
            <li key={m.id} className={styles.meeting} data-skip={skip !== null}>
              <div className={styles.meetingMain}>
                <div className={styles.meetingTitle}>{meetingTitle(m)}</div>
                <div className={styles.meetingMeta}>
                  {hostLabel(m)} · {fmtDateTime(m.startAt, now)} · {got} 项资产
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
        {programs.length === 0 && (
          <p className={styles.empty}>
            还没有接入任何采集程序。去<b>采集授权</b>页接入一个之后，这里才有可选项。
          </p>
        )}
        {programs.map((p) => (
          <label key={p.id} className={styles.option} data-off={!p.enabled}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={checked.includes(p.id)}
              disabled={busy}
              onChange={(e) =>
                setChecked((prev) =>
                  e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id),
                )
              }
            />
            <span>
              <span className={styles.optionName}>
                {p.name}
                {!p.enabled && <Pill tone="warn">已停用</Pill>}
              </span>
              <span className={styles.optionMeta}>
                {p.id} · 操作者 {p.tmUserId}
              </span>
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
        <Button
          variant="primary"
          disabled={eligible.length === 0 || busy}
          onClick={() => onConfirm(checked)}
        >
          {busy ? '提交中…' : single ? '保存授权' : `确认授权 ${eligible.length} 场`}
        </Button>
      </div>
    </Sheet>
  )
}
