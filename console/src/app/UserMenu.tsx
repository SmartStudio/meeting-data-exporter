import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminLogout, changePassword, PasswordError } from '@/api/admin'
import { Button } from '@/ui/Button'
import { PasswordInput } from '@/ui/PasswordInput'
import { Popover } from '@/ui/Popover'
import { Sheet } from '@/ui/Sheet'
import { useTheme, type Theme } from '@/theme/useTheme'
import { ROLE_LINE, useSession } from './session'
import styles from './UserMenu.module.css'

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/**
 * 主题三选（浅色 / 深色 / 跟随系统）。原来钉在顶栏最贵的右上角——一个一年
 * 点一次的设置占着页面标题和主操作都没有的位置。它跟"你是谁""改密码""退出
 * 登录"是同一类事：都是关于这个账号在这台机器上怎么用这个界面，所以搬进
 * 这个菜单，跟那几件事放在一起，不再单独占顶栏一块。
 */
function ThemeGroup() {
  const { theme, setTheme } = useTheme()
  return (
    <div className={styles.themeSection}>
      <span className={styles.sectionLabel}>主题</span>
      <div className={styles.themeGroup} role="group" aria-label="主题切换">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={theme === opt.value ? `${styles.themeBtn} ${styles.themeBtnActive}` : styles.themeBtn}
            aria-pressed={theme === opt.value}
            onClick={() => setTheme(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 用户菜单（spec §11 缺口 5：「账号设置 / 修改密码」的入口原来是空的）。
 *
 * 菜单里四样东西：
 *
 * 1. **当前账号是谁** —— 从 `GET /auth/me` 来，不是写死的「陈运维」。
 * 2. **当前是什么角色** —— spec §2 点名了这一行：原型里写死「数据管理员 ·
 *    可改规则与授权」，而系统里当时只有这一个角色。现在它随 `role` 变
 *    （`ROLE_LINE`），因为一个只读账号看到「可改规则与授权」就是在骗人。
 * 3. **主题三选**（`ThemeGroup`，从顶栏搬来的）。
 * 4. **改密码 / 退出登录**。
 *
 * 会话读不到时（没有 `SessionProvider`）整块不渲染：这时连"你是谁"都答不出，
 * 摆一个空菜单不如没有。主题三选不受这条限制——它跟账号是谁无关——但挂在
 * 这个触发按钮下面，账号读不到时触发按钮本身也不在了，一并不渲染是这个
 * 组件早已有的行为，不是新引入的限制。
 */
export default function UserMenu() {
  const identity = useSession()
  const [open, setOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const navigate = useNavigate()

  if (identity === null) return null

  const initial = [...identity.username][0] ?? '·'

  async function logout(): Promise<void> {
    setOpen(false)
    await adminLogout()
    navigate('/login', { replace: true })
  }

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.user}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initial}
        </span>
        {identity.username}
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        label="账号菜单"
        role="menu"
        placement="bottom-end"
        className={styles.menu}
      >
        <div className={styles.who}>
          <b className={styles.whoName}>{identity.username}</b>
          {/* spec §11 缺口 1 点名的那一行。随角色变，不是写死的。 */}
          <span className={styles.whoRole} data-testid="user-role-line" data-role={identity.role}>
            {ROLE_LINE[identity.role]}
          </span>
        </div>
        <ThemeGroup />
        <div className={styles.acts}>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              setOpen(false)
              setPwOpen(true)
            }}
          >
            修改密码
          </button>
          <button type="button" className={styles.item} onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </Popover>

      <PasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  )
}

/**
 * 修改密码（`POST /api/v1/admin/auth/password`，A8 新增）。
 *
 * 三件必须做对的事：
 *
 * 1. **要填当前密码**。后端会校验它——只凭浏览器里那张会话 cookie 就能改密码，
 *    等于一次 XSS 就能永久接管账号。所以这一栏不是形式，界面上也照实说。
 * 2. **改完之后这个账号的其它会话会被吊销，当前这一条留着**。这是一个后果，
 *    不说清楚会让人以为改密码只影响下一次登录。成功之后把后端回的
 *    `revokedOtherSessions` 说出来（0 也要说：「没有别的设备在登录」）。
 * 3. **只读账号也能改自己的密码**（A8 白名单三条之一），所以这里没有角色降级。
 */
function PasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const uid = useId()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function reset(): void {
    setCurrent('')
    setNext('')
    setAgain('')
    setError(null)
    setDone(null)
    setSubmitting(false)
  }

  function close(): void {
    reset()
    onClose()
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    // 两次不一致在前端就拦下来：后端没有这个概念（它只收一个 newPassword），
    // 发过去改成的会是一个用户以为自己没打错的密码。
    if (next !== again) {
      setError('两次输入的新密码不一样。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await changePassword(current, next)
      setDone(res.revokedOtherSessions)
      setCurrent('')
      setNext('')
      setAgain('')
    } catch (err) {
      setError(err instanceof PasswordError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onClose={close} title="修改密码">
      {done !== null ? (
        <div className={styles.body} data-testid="password-done">
          <p className={styles.lead}>密码已改。下次登录用新的那一个。</p>
          <p className={styles.note}>
            {done === 0
              ? '当前这条会话保留着，你不用重新登录；其它设备上没有还在登录的会话。'
              : `当前这条会话保留着，你不用重新登录；另外 ${done} 个会话已经被踢下线，那些设备要用新密码重新登录。`}
          </p>
          <div className={styles.foot}>
            <Button variant="primary" onClick={close}>
              知道了
            </Button>
          </div>
        </div>
      ) : (
        <form className={styles.body} onSubmit={(e) => void submit(e)}>
          <p className={styles.note}>
            改完之后<b>这个账号在其它设备上的会话会被吊销</b>，当前这一条保留——你不会被自己踢下线。
          </p>
          {/* label 与 input 是兄弟节点（htmlFor 绑定），不把 input 套进 label 里：
              套进去的话说明文字会一起变成这个输入框的可访问名，读屏念一长串。
              说明文字走 aria-describedby，与接入向导的 Field 同一种写法。 */}
          <PwField
            id={`${uid}-cur`}
            label="当前密码"
            value={current}
            disabled={submitting}
            autoComplete="current-password"
            hint="必须填对。只凭浏览器里那张会话 cookie 就能改密码，等于一次 XSS 就能永久接管账号。"
            onChange={setCurrent}
          />
          <PwField
            id={`${uid}-new`}
            label="新密码"
            value={next}
            disabled={submitting}
            autoComplete="new-password"
            // 长度门槛由后端下发（与建号那条路径同一份校验），前端不抄一个数
            hint="长度门槛与建号那条路径共用同一份校验，不够长时后端会说要几位。"
            onChange={setNext}
          />
          <PwField
            id={`${uid}-again`}
            label="再输一遍新密码"
            value={again}
            disabled={submitting}
            autoComplete="new-password"
            hint="两次不一致时前端就会拦下来——不然改成的会是一个你以为自己没打错的密码。"
            onChange={setAgain}
          />

          {/* 报错行常驻占位，出错时表单不跳动（与登录页同一处理） */}
          <div className={styles.errorSlot} role="alert">
            {error}
          </div>

          <div className={styles.foot}>
            <Button variant="quiet" onClick={close} disabled={submitting}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || current === '' || next === '' || again === ''}
            >
              {submitting ? '提交中…' : '改密码'}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  )
}

function PwField({
  id,
  label,
  hint,
  value,
  disabled,
  autoComplete,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  disabled: boolean
  autoComplete: string
  onChange: (v: string) => void
}) {
  const hintId = `${id}-hint`
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <PasswordInput
        id={id}
        autoComplete={autoComplete}
        value={value}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={hintId} className={styles.hint}>
        {hint}
      </p>
    </div>
  )
}
