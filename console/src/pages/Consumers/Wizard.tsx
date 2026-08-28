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
import { SecretRow } from './SecretRow'
import styles from './Wizard.module.css'

const STEPS = ['基本信息', '生成凭据', '可取清单', '接入方式'] as const

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
 * 所以第三步的内容换成**这个新程序此刻的实测清单**：它一定是 0 场，而
 * "为什么是 0、接下来该去哪一页"正是这一步该说的话——`ReachBlock` 自己会说。
 *
 * 这一步原来还叫「可取资产」，下面挂一段「『能取到什么』不在这里勾选」的说明。
 * 那段说明是在替一个**名字取错了的步骤**道歉：叫「可取资产」就会让人等着一组
 * 勾选框。名字改成「可取清单」之后，那段话不用写了。
 *
 * ## 凭据只出现一次这件事由界面兜住
 *
 * 明文只在 201 响应里出现，库里只存 argon2id 哈希。所以第二步不勾「我已保存」
 * 就走不掉、也**关不掉**——Sheet 的关闭按钮与 Esc 都被拦下来先提醒一次。
 * 这不是刁难：关掉之后这串明文在世界上就不存在了。
 *
 * 丢了不是死路：卡片上的「轮换凭据」（`ProgramActions.tsx` 调
 * `POST /programs/:id/rotate-secret`）能换一串新的。但那是**有代价的**恢复——
 * 旧凭据当场失效，对接方的定时任务会开始收到 401 直到那边换上新串，
 * 所以这句提醒要把「换得回来」和「换要付什么」一起说，而不是只说其中一半。
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
      setCloseWarn(
        'Secret 关掉之后不能再取回：服务端只存哈希，没有「再看一次」。' +
          '真丢了就到这个程序的卡片上点「轮换凭据」换一串新的——旧的当场失效，对接方要同时改配置。' +
          '勾上「我已经把 Secret 保存好了」再关。',
      )
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
    <Sheet size="lg" open={open} onClose={requestClose} title="接入新的采集程序">
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
            <strong className={styles.strong}>Secret 明文只出现这一次</strong>，关掉就找不回来。
          </p>
          {/* 后端下发的那一句原样上屏。建号与轮换现在共用同一句话（A8），
              前端不改写它——改写就会变成两句不一样的、迟早会漂的话。 */}
          {created.secretNote !== '' && (
            <p className={styles.note} data-testid="secret-note">
              {created.secretNote}
            </p>
          )}
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
          <p className={styles.lede}>把下面这段给对方。</p>
          <pre className={styles.snippet}>{accessSnippet(window.location.origin, created.id)}</pre>
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
      <ReachBlock programId={created.id} standing={standing} res={res} />
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
