import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { adminLogin, AdminAuthError } from '@/api/admin'
import { Button } from '@/ui/Button'
import { Input } from '@/ui/Input'
import styles from './Login.module.css'

/**
 * 控制台登录页。spec.md §4.1：账号 + 密码 + 「记住此设备 30 天」，仅限内部
 * 管理员，无自助注册、无找回密码。不经过 `AppShell`——没有左栏/顶栏。
 *
 * ## 这一页只有一件事要做，所以上面只剩这一件事
 *
 * 删掉的三样，逐条：
 *
 * 1. **蓝底圆角方块里一个「Y」**。它不是标志，是一个占位标志的形状；72px 见方
 *    摆在首屏正中，是这一页视觉上最重的东西，而它什么也不说明。产品名本来就在
 *    它下面写着，字比方块认得快。（左栏那个 32px 的同款保留：那里它是应用图标，
 *    尺寸和职责都对得上。）
 *
 * 2. **底部那行 `• 拉取 • 归档 NAS • 保留 30 天 • 授权采集`**。这是给内部运维
 *    工具的登录页加的营销 chip：11px、低对比、不接任何状态、也点不动。按"删掉
 *    它用户会不会做错事"这条判据——不会，能走到这一页的人都知道这套系统是干
 *    什么的。而其中「保留 30 天」还**是一句会撒谎的话**：真实的保留天数来自
 *    `system_settings`（`GET /admin/storage` 的 `retention.defaultDays`，当前
 *    `defaultDaysSource: "fallback"`，即没配过），管理员改成 60 天的那一刻这行
 *    字就开始骗人。登录页没有会话，拿不到也不该拿这个设置——所以是删掉这个数，
 *    不是想办法去取它。
 *
 * 3. **「仅限公司内部管理员使用」**。同一条判据：删掉它没有人会做错事。没有
 *    注册入口这件事，界面上没有注册按钮本身已经说清楚了。
 *
 * 留下的那半句「忘记密码请联系系统管理员」是有职责的：这一页**没有**找回密码
 * 的控件，也不会有（spec.md §4.1）。一个被锁在外面的人如果没有这句话，就只能
 * 在页面上找一个不存在的「忘记密码？」链接。这是"控件的缺席"本身需要一句话来
 * 交代的情况，不是可以靠改控件解决的文案。原文尾巴上那个「开通」删了——它把
 * 句子挤到第二行，且"联系管理员开通"说的是开户，不是找回密码，两件事。
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
      <div className={styles.card}>
        {/* 产品名在卡片里、表单上方：登录页只有这一个物件，标题浮在它外面
            会让"上面那块"和"下面这块"看起来是两件事。 */}
        <header className={styles.head}>
          <h1 className={styles.title}>YAO-DATA</h1>
          <p className={styles.sub}>会议数据管理控制台</p>
        </header>

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
              避免出错时表单因为多出/少了一行而跳动（spec.md §4.1 明确要求）。
              它**排在「登录」之后**：原来夹在勾选框和按钮中间，空着也占一行，
              两侧各再吃一份 16px 的 gap，于是勾选框到按钮之间空出 55px——比
              字段间距宽两倍多，看起来像这里漏掉了一个控件。挪到最后一个控件
              之后，那段常驻空白就和卡片底部内边距连成一片，表单内部每一个
              间隔回到统一的 16px。它同时也更合流程：报错是刚才那一次点击的
              回答，出现在手刚点过的地方，不用回头往上找。 */}
          <div className={styles.submitGroup}>
            <Button type="submit" variant="primary" className={styles.submit} disabled={submitting}>
              {submitting ? '登录中…' : '登录'}
            </Button>
            <div className={styles.errorSlot} role="alert">
              {error}
            </div>
          </div>
        </form>
      </div>

      {/* 卡片之外：卡片里放的是"要操作的东西"，这句不是。 */}
      <p className={styles.hint}>忘记密码请联系系统管理员</p>
    </div>
  )
}
