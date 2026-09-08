import { useEffect, useState } from 'react'
import type { OverrideKind } from '@/api/admin/grants'
import type { AdminMeeting } from '@/api/admin/meetings'
import { Button } from '@/ui/Button'
import { Sheet } from '@/ui/Sheet'
import { meetingTitle } from './display'
import styles from './OverrideSheet.module.css'

/** 一个 kind 上能选的 effect，以及它在界面上叫什么。 */
interface EffectChoice {
  effect: string
  label: string
  hint: string
}

/**
 * 三栈各自的 effect 取值（`policy/stacks.ts`）：
 * fetch 是 `all` / `skip`，allow 是 `allow` / `deny`，archive 是 `'skip'` **或一个
 * 目录模板串**。
 *
 * 归档这一栈只放出 `skip`：另一个取值是「归到这个目录去」，那是一条目录模板
 * （`/nas/meetings-finance/{年}/`），属于归档规则的表达力，不是"一场会议的开关"。
 * 在这里摆一个自由输入的目录框，等于让人在单场会议上手写一条规则——写错了
 * 没有任何东西会拦，而后果是文件被搬去一个没人找得到的地方。
 */
const CHOICES: Record<OverrideKind, EffectChoice[]> = {
  fetch: [
    { effect: 'skip', label: '不拉取这场会议', hint: '已经拉下来的资产不会被删，只是此后不再拉' },
    { effect: 'all', label: '拉取全部六类资产', hint: '即使拉取规则判定跳过，这一场也照拉' },
  ],
  archive: [
    { effect: 'skip', label: '不归档这场会议', hint: '已经写进 NAS 的副本不会被删' },
  ],
  allow: [
    { effect: 'allow', label: '准许采集', hint: '即使权限规则判定禁止，也放行' },
    { effect: 'deny', label: '禁止采集', hint: '已归档进 NAS，但任何程序都取不到' },
  ],
}

const KIND_NAME: Record<OverrideKind, string> = {
  fetch: '拉取',
  archive: '归档到 NAS',
  allow: '采集授权',
}

export interface OverrideSheetProps {
  open: boolean
  onClose: () => void
  meeting: AdminMeeting | null
  kind: OverrideKind
  busy: boolean
  onConfirm: (input: { effect: string; reason: string }) => void
}

/**
 * 人工改写的表单。
 *
 * spec.md §5.4 逐字：**「单场会议的人工改写优先于所有规则。」** 所以这个面板
 * 是这一页最有权力的一个控件，它的两条设计都从这句话来：
 *
 * 1. **理由必填**。后端 `PUT /override` 缺 `reason` 直接 400，而这不是一条
 *    技术限制——理由会进判定理由与审计，是三个月后有人问「这场为什么被关掉」
 *    时唯一的答案。不预填任何默认理由：预填的理由等于没有理由。
 * 2. **改写的是什么写在标题里**，不是靠一个图标暗示。
 */
export function OverrideSheet({ open, onClose, meeting, kind, busy, onConfirm }: OverrideSheetProps) {
  const choices = CHOICES[kind]
  const [effect, setEffect] = useState<string>(choices[0]?.effect ?? 'skip')
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!open) return
    setEffect(CHOICES[kind][0]?.effect ?? 'skip')
    setReason('')
  }, [open, kind])

  const ready = reason.trim() !== ''

  return (
    <Sheet open={open} onClose={onClose} title={`人工改写：${KIND_NAME[kind]}`}>
      <p className={styles.lead} data-testid="override-lead">
        {meeting === null ? '' : `「${meetingTitle(meeting)}」 · `}
        <b>单场会议的人工改写优先于所有规则。</b>
        改写之后这个阶段会被标记为「人工改写」，判定理由换成你写在下面的这句话。
      </p>

      <fieldset className={styles.choices}>
        <legend className={styles.legend}>改成</legend>
        {choices.map((c) => (
          <label key={c.effect} className={styles.choice}>
            <input
              type="radio"
              name="override-effect"
              value={c.effect}
              checked={effect === c.effect}
              disabled={busy}
              onChange={() => setEffect(c.effect)}
            />
            <span>
              <span className={styles.choiceName}>{c.label}</span>
              <span className={styles.choiceHint}>{c.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className={styles.reasonWrap}>
        <span className={styles.legend}>理由（必填）</span>
        <textarea
          className={styles.reason}
          value={reason}
          disabled={busy}
          rows={3}
          placeholder="例如：涉密会议，单独关闭采集"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <p className={styles.note}>
        这句话会显示在这一阶段的判定理由里，并进审计记录。三个月后有人问
        「这场为什么被关掉」，看到的就是它。
      </p>

      <div className={styles.actions}>
        <Button variant="quiet" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={!ready || busy || meeting === null}
          onClick={() => onConfirm({ effect, reason: reason.trim() })}
        >
          {busy ? '提交中…' : '保存改写'}
        </Button>
      </div>
    </Sheet>
  )
}
