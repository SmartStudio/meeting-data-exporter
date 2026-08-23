import type { ReactElement } from 'react'
import { NavLink } from 'react-router-dom'
import { useMeetings, useSystemState } from './SystemStatus'
import styles from './Rail.module.css'

/**
 * 左栏七项——不对，是六项。`spec.md` §3 明确写着「内容预览」不占导航，
 * 从会议记录点标题进入。左栏真正可点的是这六项，逐字对应 §3 的页面名。
 */
const NAV_ITEMS: Array<{ to: string; label: string; icon: ReactElement }> = [
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

/** 左栏底部的系统状态摘要（原型的 `.rail-foot`）。点开是详情，F1 暂不接——
 * 数字来自当前系统状态下真实读到的会议数据，不是写死的。 */
function RailStatus() {
  const { state } = useSystemState()
  const meetings = useMeetings()

  let severity: 'ok' | 'warn' | 'fail' = 'ok'
  let title = '一切正常'
  let subtitle = '三个依赖都通 · 任务运行中'

  if (state === 'nas-down') {
    severity = 'fail'
    title = '1 个依赖异常'
    subtitle = 'NAS 归档存储'
  } else if (state === 'tencent-down') {
    severity = 'warn'
    title = '1 个依赖异常'
    subtitle = '腾讯会议接口'
  } else if (state === 'loading') {
    title = '正在检测…'
    subtitle = '读取会议数据中'
  } else if (state === 'load-failed') {
    title = '会议数据读取失败'
    subtitle = '不影响已归档的文件'
  } else if (meetings.state === 'ready') {
    const fails = meetings.data.filter((m) => m.archive === 'failed').length
    if (fails > 0) {
      severity = 'warn'
      title = `${fails} 项需要处理`
      subtitle = 'NAS 连通 · 任务运行中'
    }
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
            {item.label}
          </NavLink>
        ))}
      </nav>

      <RailStatus />
    </aside>
  )
}
