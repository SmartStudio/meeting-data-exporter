import { useId, useState } from 'react'
import { createProgram, type CreatedProgram } from '@/api/admin/grants'
import {
  accessSnippet,
  createErrorText,
  draftToInput,
  EMPTY_DRAFT,
  programStanding,
  validateDraft,
  type Draft,
  type DraftField,
  type FieldError,
} from '@/api/admin/programs'
import { Button } from '@/ui/Button'
import { Input } from '@/ui/Input'
import { Sheet } from '@/ui/Sheet'
import { ReachBlock, useInventory } from './ReachBlock'
import styles from './Wizard.module.css'

const STEPS = ['基本信息', '生成凭据', '可取资产', '接入方式'] as const

/**
 * 接入新程序 = 四步向导（spec §4.5）。
 *
 * ## 四步的内容按真实端点重排过
 *
 * 原型（`gate-console.html` 的 `WIZ_STEPS`）第三步是一组「可取资产」勾选框，
 * 声称在设定这个程序的资产上限。**后端没有这个字段**：`POST /admin/programs`
 * 收的是 `{id, name, tmUserId, expiresAt?}`，一个字段都不是资产范围；真正决定
 * 能取到什么的是「逐会议授权 ∩ 保留期 ∩ 采集权限规则」三者求交。
 * 照抄那组勾选框就是一个点了没反应的控件——它会让人以为自己已经把录像挡在
 * 外面了，而实际上什么都没设。
 *
 * 所以第三步保留了名字（「可取资产」），内容换成**这个新程序此刻的实测清单**：
 * 它一定是 0 场，而"为什么是 0、接下来该去哪一页"正是这一步该说的话。
 *
 * ## 凭据只出现一次这件事由界面兜住
 *
 * 明文只在 201 响应里出现，库里只存 argon2id 哈希。所以第二步不勾「我已保存」
 * 就走不掉、也**关不掉**——Sheet 的关闭按钮与 Esc 都被拦下来先提醒一次。
 * 这不是刁难：关掉之后这串明文在世界上就不存在了，而轮换端点这一轮还没有。
 */
export function Wizard({ open, onDone }: { open: boolean; onDone: (created: boolean) => void }) {
  const uid = useId()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [pending, setPending] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedProgram | null>(null)
  const [savedAck, setSavedAck] = useState(false)
  const [closeWarn, setCloseWarn] = useState<string | null>(null)

  const errorOf = (field: DraftField): string | undefined => errors.find((e) => e.field === field)?.message

  function reset(): void {
    setStep(0)
    setDraft(EMPTY_DRAFT)
    setErrors([])
    setPending(false)
    setCreateError(null)
    setCreated(null)
    setSavedAck(false)
    setCloseWarn(null)
  }

  function finish(): void {
    const didCreate = created !== null
    reset()
    onDone(didCreate)
  }

  /** 关闭意图（× / Esc / 完成）都走这里。凭据没被确认保存之前拦一次。 */
  function requestClose(): void {
    if (created !== null && !savedAck) {
      setCloseWarn('Secret 关掉之后不能再取回，只能轮换（轮换端点这一轮还没有）。勾上「我已经把 Secret 保存好了」再关。')
      return
    }
    finish()
  }

  async function submitBasics(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000)
    const found = validateDraft(draft, nowSec)
    setErrors(found)
    setCreateError(null)
    if (found.length > 0) return

    setPending(true)
    try {
      const res = await createProgram(draftToInput(draft))
      setCreated(res)
      setStep(1)
    } catch (e) {
      setCreateError(createErrorText(e))
    } finally {
      setPending(false)
    }
  }

  function onNext(): void {
    if (step === 0) {
      void submitBasics()
      return
    }
    if (step === STEPS.length - 1) {
      finish()
      return
    }
    setCloseWarn(null)
    setStep(step + 1)
  }

  const nextLabel = step === 0 ? '创建并生成凭据' : step === STEPS.length - 1 ? '完成接入' : '下一步'
  const nextDisabled = pending || (step === 1 && !savedAck)
  const alertText = createError ?? closeWarn

  return (
    <Sheet open={open} onClose={requestClose} title="接入新的采集程序">
      <ol className={styles.steps}>
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={styles.step}
            data-state={i < step ? 'done' : i === step ? 'now' : 'todo'}
            aria-current={i === step ? 'step' : undefined}
          >
            <span className={styles.stepN} aria-hidden="true">
              {i < step ? '✓' : i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>

      {alertText !== null && (
        <p className={styles.alert} role="alert">
          {alertText}
        </p>
      )}

      {step === 0 && (
        <div className={styles.body}>
          <p className={styles.lede}>
            先给它一个 id 和一个人能看懂的名字。id 同时是采集权限规则里的主体名与 URL 的一段，
            名字会出现在授权列表和操作审计里——三个月后有人问「dw-sync 是谁在用」，靠的就是这一行。
          </p>
          <Field
            id={`${uid}-id`}
            label="程序 id"
            hint="首字符是字母或数字，其余可用字母、数字与 . _ -，总长不超过 64。建好之后不能改。"
            value={draft.id}
            error={errorOf('id')}
            onChange={(v) => setDraft({ ...draft, id: v })}
          />
          <Field
            id={`${uid}-name`}
            label="程序名称"
            hint="给人看的名字，不超过 128 个字符。"
            value={draft.name}
            error={errorOf('name')}
            onChange={(v) => setDraft({ ...draft, name: v })}
          />
          <Field
            id={`${uid}-tm`}
            label="操作者身份（tmUserId）"
            hint="这个程序调腾讯 API、留痕时用的身份。不知道填什么就问对接人，别自己编一个。"
            value={draft.tmUserId}
            error={errorOf('tmUserId')}
            onChange={(v) => setDraft({ ...draft, tmUserId: v })}
          />
          <Field
            id={`${uid}-exp`}
            label="凭据到期日（可选）"
            hint="留空 = 永不过期。填了就是那一天结束时失效。"
            type="date"
            value={draft.expiresAt}
            error={errorOf('expiresAt')}
            onChange={(v) => setDraft({ ...draft, expiresAt: v })}
          />
        </div>
      )}

      {step === 1 && created !== null && (
        <div className={styles.body}>
          <p className={styles.lede}>
            凭据已生成。<strong className={styles.strong}>Secret 明文只出现这一次</strong>
            ，库里只存 argon2id 哈希，丢了找不回来。请立刻存进你的密钥管理。
          </p>
          <SecretRow label="CLIENT ID" value={created.id} />
          <SecretRow label="SECRET" value={created.secret} />
          <label className={styles.ack} htmlFor={`${uid}-ack`}>
            <input
              id={`${uid}-ack`}
              type="checkbox"
              className={styles.checkbox}
              checked={savedAck}
              onChange={(e) => {
                setSavedAck(e.target.checked)
                if (e.target.checked) setCloseWarn(null)
              }}
            />
            <span>我已经把 Secret 保存好了</span>
          </label>
        </div>
      )}

      {step === 2 && created !== null && <AssetsStep created={created} />}

      {step === 3 && created !== null && (
        <div className={styles.body}>
          <p className={styles.lede}>把下面这段给对方。凭据换到的令牌有效期看响应里的 expires_in。</p>
          <pre className={styles.snippet}>{accessSnippet(window.location.origin, created.id)}</pre>
          <p className={styles.note}>
            接入只是给了它身份。它现在能取走多少，取决于「自动规则」里的采集权限规则栈与逐场授权——
            这两件事在别的页面上。
          </p>
        </div>
      )}

      <div className={styles.foot}>
        {step === 0 && (
          <Button variant="quiet" onClick={requestClose}>
            取消
          </Button>
        )}
        <span className={styles.spacer} />
        {/* 建好之后回不到第一步：再填一遍表单就是再建一个程序，而不是改这一个 */}
        <Button onClick={() => setStep(Math.max(1, step - 1))} disabled={step <= 1}>
          上一步
        </Button>
        <Button variant="primary" onClick={onNext} disabled={nextDisabled} aria-busy={pending || undefined}>
          {nextLabel}
        </Button>
      </div>
    </Sheet>
  )
}

/** 第三步：不是一组勾选框，是这个新程序此刻的实测清单。见文件头。 */
function AssetsStep({ created }: { created: CreatedProgram }) {
  const res = useInventory(created.id)
  const standing = programStanding(created, Math.floor(Date.now() / 1000))
  return (
    <div className={styles.body}>
      <p className={styles.lede}>
        「能取到什么」不在这里勾选——它是 有授权 ∩ 在保留期内 ∩ 规则允许采集 求交出来的结果，
        三件事分别在「会议记录」「归档存储」「自动规则」三页上维护。下面是它此刻的实测清单：
      </p>
      <ReachBlock programId={created.id} standing={standing} res={res} />
    </div>
  )
}

function SecretRow({ label, value }: { label: string; value: string }) {
  const [said, setSaid] = useState<string | null>(null)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setSaid('已复制')
    } catch {
      // 剪贴板在非安全上下文里不可用。说出来，别让按钮点了没反应。
      setSaid('复制不了，请手动选中')
    }
  }

  return (
    <div className={styles.secretRow}>
      <span className={styles.secretK}>{label}</span>
      <code className={styles.secretV}>{value}</code>
      <Button size="sm" variant="quiet" onClick={() => void copy()} aria-label={`复制 ${label}`}>
        复制
      </Button>
      {said !== null && (
        <span className={styles.copied} role="status">
          {said}
        </span>
      )}
    </div>
  )
}

function Field({
  id,
  label,
  hint,
  value,
  error,
  onChange,
  type = 'text',
}: {
  id: string
  label: string
  hint: string
  value: string
  error?: string | undefined
  onChange: (v: string) => void
  type?: string
}) {
  const hintId = `${id}-hint`
  const errId = `${id}-err`
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        invalid={error !== undefined}
        aria-describedby={error !== undefined ? `${errId} ${hintId}` : hintId}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={hintId} className={styles.hint}>
        {hint}
      </p>
      {error !== undefined && (
        <p id={errId} className={styles.fieldError}>
          {error}
        </p>
      )}
    </div>
  )
}
