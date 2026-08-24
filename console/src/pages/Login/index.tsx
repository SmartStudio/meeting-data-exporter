import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { adminLogin, AdminAuthError } from '@/api/admin'
import { Button } from '@/ui/Button'
import { Input } from '@/ui/Input'
import styles from './Login.module.css'

/**
 * 控制台登录页。spec.md §4.1：账号 + 密码 + 「记住此设备 30 天」，仅限内部
 * 管理员，无自助注册、无找回密码（文案明说找回请联系系统管理员）。不经过
 * `AppShell`——没有左栏/顶栏。
 */
export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await adminLogin(username, password, remember)
      const from = (location.state as { from?: string } | null)?.from ?? '/meetings'
      navigate(from, { replace: true })
    } catch (err) {
      // 表单级报错，故意不说是账号还是密码错——spec.md §4.1
      setError(err instanceof AdminAuthError ? err.message : '登录失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          Y
        </span>
        <div>
          <h1 className={styles.brandName}>YAO-DATA</h1>
          <p className={styles.brandSub}>会议数据管理</p>
        </div>
      </div>

      <div className={styles.card}>
        <form className={styles.form} onSubmit={onSubmit}>
          <label className={styles.field}>
            账号
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              disabled={submitting}
            />
          </label>
          <label className={styles.field}>
            密码
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={submitting}
            />
          </label>
          <label className={styles.remember}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={submitting}
            />
            记住此设备 30 天
          </label>

          {/* 报错行常驻占位——用固定高度的容器包 error，不用条件渲染整行，
              避免出错时表单因为多出/少了一行而跳动（spec.md §4.1 明确要求）。 */}
          <div className={styles.errorSlot} role="alert">
            {error}
          </div>

          <Button type="submit" variant="primary" className={styles.submit} disabled={submitting}>
            {submitting ? '登录中…' : '登录'}
          </Button>

          <p className={styles.hint}>仅限公司内部管理员使用，忘记密码请联系系统管理员开通</p>
        </form>
      </div>

      {/* 四阶段点线：产品模型的可视化，不是进度条——纯展示，不接任何状态 */}
      <ol className={styles.stages}>
        <li>拉取</li>
        <li>归档NAS</li>
        <li>保留30天</li>
        <li>授权采集</li>
      </ol>
    </div>
  )
}
