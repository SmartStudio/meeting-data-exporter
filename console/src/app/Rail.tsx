import type { ReactElement } from 'react'
import { NavLink } from 'react-router-dom'
import { fetchStreakText } from '@/api/admin/health'
import { Pill } from '@/ui/Pill'
import { useSystemStatusView } from './SystemStatus'
import styles from './Rail.module.css'

/**
 * 左栏七项——不对，是六项。`spec.md` §3 明确写着「内容预览」不占导航，
 * 从会议记录点标题进入。左栏真正可点的是这六项，逐字对应 §3 的页面名。
 *
 * **导出而不是只在本文件用**：`GlobalBar.tsx` 的顶栏标题要和这里同一份文案
 * （不要两份），从路由派生标题时直接读这张表的 `to`/`label`，不再另抄一遍
 * 六个字符串。
 */
export const NAV_ITEMS: Array<{ to: string; label: string; icon: ReactElement }> = [
  {
    to: '/meetings',
    label: '会议记录',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M1.5 6h13" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  {
    to: '/consumers',
    label: '采集授权',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.5 2.5 4v4c0 3 2.3 5.4 5.5 6.5 3.2-1.1 5.5-3.5 5.5-6.5V4L8 1.5Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: '/rules',
    label: '自动规则',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/jobs',
    label: '定时任务',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/storage',
    label: '归档存储',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.8" y="3" width="12.4" height="4" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
        <rect x="1.8" y="9" width="12.4" height="4" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  {
    to: '/audit',
    label: '操作审计',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M3.5 2.5h6l3 3v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M5.5 9h5M5.5 11.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
]

/**
 * 左栏底部的系统状态摘要（原型的 `.rail-foot`）。
 *
 * 数据与顶栏那条告警条同源（`useSystemStatusView()`，`SystemHealthProvider`
 * 里只取一次），不再从会议列表里数归档失败的行——那是 mock 时代的替代品，
 * 它数的是"会议数据里有几行 archive === 'failed'"，与"有几件事需要人处理"
 * 不是一回事。
 *
 * 「一切正常」这四个字只在**真的读到了状态而且没问题**时出现：读不到就说
 * 读不到，推不出来就说未知——默认成正常的那一刻，这块摘要就再也不值得看了。
 */
function RailStatus() {
  const { alert, openFailures } = useSystemStatusView()

  let severity: 'ok' | 'warn' | 'fail' = 'ok'
  let title = '一切正常'
  let subtitle = '依赖都通 · 任务运行中'

  if (alert.kind === 'checking') {
    title = '正在检测…'
    subtitle = '读取系统状态中'
  } else if (alert.kind === 'unreadable') {
    severity = 'warn'
    title = '系统状态读不到'
    subtitle = '不影响已归档的文件'
  } else if (alert.kind === 'nas-down') {
    severity = 'fail'
    title = '1 个依赖异常'
    subtitle = 'NAS 归档存储'
  } else if (alert.kind === 'fetch-stalled') {
    severity = 'warn'
    title = '拉取可能不通'
    subtitle = fetchStreakText(alert.streak)
  } else if (alert.kind === 'fetch-unknown') {
    severity = 'warn'
    title = '拉取状态未知'
    subtitle = '任务清单里没有这一项'
  } else if (openFailures !== null && openFailures > 0) {
    severity = 'warn'
    title = `${openFailures} 项需要处理`
    subtitle = '依赖都通 · 有失败项待处理'
  }

  return (
    <div className={styles.railFoot}>
      <span className={styles.statDot} data-s={severity} aria-hidden="true" />
      <span className={styles.statText}>
        <span className={styles.statTitle}>{title}</span>
        <span className={styles.statSub}>{subtitle}</span>
      </span>
    </div>
  )
}

/**
 * 「定时任务」导航项右侧的红色计数徽标。
 *
 * 会议数 / 程序数 / 规则数（简报点名的另外三个）**没有加**：左栏是全局挂载的
 * 壳组件，能读到的只有 `useSystemStatusView()`（NAS/任务健康）与会话身份——
 * 没有一条共享的「当前有几场会议 / 几个程序 / 几条规则」数据源，六个页面各自
 * 拉自己的列表，壳层拿不到。拿不到就不显示，不编一个数字出来（简报原话）。
 *
 * 这一项能加，是因为 `openFailures` 恰好是共享数据：`fetchSystemHealth()`
 * 读的是 `GET /admin/jobs` 的顶层 `failuresTotal`——逐字对应「定时任务」这一页
 * 要管的东西，不是东拼西凑出来的近似值。颜色用 `--fail` 实底 + `--on-fail`
 * 字（`ui/Pill` 的 `solid` 变体），不是把 `--fail` 直接当文字色压在 `--nav`
 * 上——那样浅色主题下只有 2.98:1，过不了图形最低的 3:1，文字口径的 4.5:1
 * 更够不着。
 *
 * `aria-hidden`：数字本身不单独读出来，读屏使用者已经从下面 `RailStatus`
 * 的「N 项需要处理」那句里听到了同一个事实，这里再读一遍是重复。
 */
function JobsBadge() {
  const { openFailures } = useSystemStatusView()
  if (openFailures === null || openFailures <= 0) return null
  return (
    <span className={styles.navBadge} aria-hidden="true">
      <Pill tone="fail" solid>
        {openFailures}
      </Pill>
    </span>
  )
}

export default function Rail() {
  return (
    <aside className={styles.rail}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          Y
        </span>
        <div>
          <p className={styles.brandName}>YAO-DATA</p>
          <p className={styles.brandSub}>会议数据管理</p>
        </div>
      </div>

      <nav className={styles.nav} aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => (isActive ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem)}
          >
            <span className={styles.navIco}>{item.icon}</span>
            <span className={styles.navLabel}>{item.label}</span>
            {item.to === '/jobs' && <JobsBadge />}
          </NavLink>
        ))}
      </nav>

      <RailStatus />
    </aside>
  )
}
