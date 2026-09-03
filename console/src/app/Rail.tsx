import type { ReactElement } from 'react'
import { NavLink } from 'react-router-dom'
import { fetchStreakText } from '@/api/admin/health'
import { useUnseenFailures } from './failuresSeen'
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

  /* title 无条件挂，不按断点挂。
     1120px 以下左栏收成 56px 图标带，`.statText` 被视觉隐藏（留在无障碍树里，
     读屏照念），鼠标用户那一侧就只剩一颗彩色圆点——「一个依赖异常」和「拉取
     可能不通」都是同一颗琥珀点。title 是这条信息在收起态唯一的出口。
     不用 matchMedia 按断点加：那要在壳层挂一个媒体查询监听器，只为省掉一条
     在展开态**重复可见文字**的悬停提示——重复不伤人，多一个状态源会。 */
  return (
    <div className={styles.railFoot} title={`${title} · ${subtitle}`}>
      <span className={styles.statDot} data-s={severity} aria-hidden="true" />
      <span className={styles.statText}>
        <span className={styles.statTitle}>{title}</span>
        <span className={styles.statSub}>{subtitle}</span>
      </span>
    </div>
  )
}

/** `aria-describedby` 指向的那个隐藏节点的 id（一页只有一个左栏） */
const JOBS_DOT_DESC_ID = 'nav-jobs-new-failures'

/**
 * 「定时任务」右侧那颗红点：**有你还没看过的失败项**时才亮。
 *
 * 以前这里是一枚红底白字的计数徽标（`failuresTotal`）。去掉数字有三个理由：
 * 1. 它说的是底部 `RailStatus` 已经在说的同一个数（「N 项需要处理」），一个事实印两遍；
 * 2. 那个数只在进控制台时读一次，处理完几条它还写着老数——一个不动的数字比没有更误导
 *    （现在 `SystemHealthProvider` 换栏目、回前台会重读，但即便如此，数字仍然是重复的）；
 * 3. 收起态（1120px 以下）它要叠在 15px 的图标上，为此压了一堆尺寸特例。
 * 红点只回答一个问题——「我看过之后又出事了吗」——答案来自 `app/failuresSeen.ts`：
 * 定时任务页读完列表就记下最新一条失败的时间，之后出现比它更新的失败才再亮。
 *
 * 点本身 `aria-hidden`：它没有文字，也不该进链接的可及名（名字必须还是「定时任务」，
 * 测试与读屏都按这个名字找它）。「有新的失败项」这句放在 `aria-describedby` 指向的
 * 隐藏节点里，读屏念成"定时任务，链接，有新的失败项"；鼠标那一侧由链接的 title 兜住
 * （收起态文字看不见，点是唯一的信号）。
 * 颜色是 `--nav-fail`（tokens.css）而不是 `--fail`：后者是给纸面用的红，压在暗带上
 * 浅色主题只有 2.98:1，不到图形 3:1 的线。
 */
function JobsDot() {
  return (
    <>
      <span className={styles.navDot} data-testid="jobs-dot" aria-hidden="true" />
      <span id={JOBS_DOT_DESC_ID} hidden>
        有新的失败项
      </span>
    </>
  )
}

export default function Rail() {
  const { newestFailedAt } = useSystemStatusView()
  const unseen = useUnseenFailures(newestFailedAt)

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
        {NAV_ITEMS.map((item) => {
          const dotted = item.to === '/jobs' && unseen
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem)}
              /* 收起态（1120px 以下）`.navLabel` 视觉隐藏之后，鼠标用户面对的是
                 六个没有名字的图标。可及名字仍然来自 `.navLabel` 的文本（title
                 只是可及名的兜底，有内容时不参与），所以这一条纯粹是给鼠标的。
                 理由同 RailStatus 里那段：不按断点加。 */
              title={dotted ? `${item.label} · 有新的失败项` : item.label}
              aria-describedby={dotted ? JOBS_DOT_DESC_ID : undefined}
            >
              <span className={styles.navIco}>{item.icon}</span>
              <span className={styles.navLabel}>{item.label}</span>
              {dotted && <JobsDot />}
            </NavLink>
          )
        })}
      </nav>

      <RailStatus />
    </aside>
  )
}
