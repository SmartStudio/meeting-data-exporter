import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  SystemStatusContext,
  useSystemStatusView,
  type SystemAlert,
  type SystemStatusView,
} from './systemAlert'
import { Link } from 'react-router-dom'
import type { SystemState } from '@/api/types'
import {
  TENCENT_DOWN_STREAK,
  fetchStreakText,
  fetchSystemHealth,
  type SystemHealth,
} from '@/api/admin/health'
import { useResource } from '@/lib/useResource'
import { isProtoMode } from './proto'
import styles from './SystemStatus.module.css'

/**
 * 六种取值的显示名。「正常」是基线，不算故障态；另外五种是 spec.md §7、§8
 * 说的「五种系统状态」。
 *
 * **写成 `Record<SystemState, string>` 是刻意的**：少一种、多一种都编译不过。
 * 顶栏下拉声称"六种全在这里"，测试也拿它当 `SystemState` 的全枚举来源
 * （不变量测试要对每一种系统状态取一遍种子数据）。手抄一张名单迟早会漏掉
 * 新加的取值，而漏掉的那一种恰恰是没人测过的那一种。
 */
const SYSTEM_STATE_LABEL: Record<SystemState, string> = {
  ok: '正常',
  loading: '加载中',
  'load-failed': '加载失败',
  empty: '一场会议都没有',
  'nas-down': 'NAS 断连',
  'tencent-down': '腾讯会议不可达',
}

/** `SystemState` 的全枚举，顺序就是对象字面量的书写顺序（也是下拉的顺序）。 */
export const SYSTEM_STATES = Object.keys(SYSTEM_STATE_LABEL) as SystemState[]

export const SYSTEM_STATE_OPTIONS: Array<{ value: SystemState; label: string }> =
  SYSTEM_STATES.map((value) => ({ value, label: SYSTEM_STATE_LABEL[value] }))

interface SystemStateContextValue {
  state: SystemState
  setState: (state: SystemState) => void
}

const SystemStateContext = createContext<SystemStateContextValue | null>(null)

/**
 * **手动切系统状态，只在 `?proto=1` 下有意义**（计划 G-d）。
 *
 * 它是演示与截图工具：spec §7/§8 的五种形态本来就要能一键复现，
 * `scripts/a11y-check.ts` 也靠顶栏那个下拉驱动五个无障碍检查场景。
 * 默认路径下这个值没人读——真实状态从 `useSystemStatusView()` 来。
 *
 * 它同时还是 mock 数据层的开关（`mockApi(state)`，会议记录页在用），
 * 所以 Provider 仍然包在整棵树外面（`App.tsx`）。
 */
export function SystemStateProvider({
  children,
  initialState = 'ok',
}: {
  children: ReactNode
  initialState?: SystemState
}) {
  const [state, setState] = useState<SystemState>(initialState)
  const value = useMemo<SystemStateContextValue>(() => ({ state, setState }), [state])
  return <SystemStateContext.Provider value={value}>{children}</SystemStateContext.Provider>
}

export function useSystemState(): SystemStateContextValue {
  const ctx = useContext(SystemStateContext)
  if (!ctx) throw new Error('useSystemState 必须在 SystemStateProvider 内使用')
  return ctx
}

/* ══════════════════════════════════════════════════════════════════
   真实的系统健康状态
   ══════════════════════════════════════════════════════════════════ */


function protoAlert(state: SystemState): SystemAlert {
  switch (state) {
    case 'nas-down':
      return { kind: 'nas-down', error: null, pendingMeetings: null }
    case 'tencent-down':
      return { kind: 'fetch-stalled', streak: TENCENT_DOWN_STREAK, label: '拉取新录制' }
    default:
      // ok / loading / load-failed / empty 是**数据**三态，出口在页面内容区
      // （spec.md §8），不占用这条全局横幅。
      return { kind: 'none' }
  }
}

function liveAlert(health: SystemHealth): SystemAlert {
  if (!health.nas.reachable) {
    return {
      kind: 'nas-down',
      error: health.nas.error,
      pendingMeetings: health.nas.pendingMeetings,
    }
  }
  if (health.fetchJob === null) return { kind: 'fetch-unknown' }
  if (health.fetchJob.consecutiveFailures >= TENCENT_DOWN_STREAK) {
    return {
      kind: 'fetch-stalled',
      streak: health.fetchJob.consecutiveFailures,
      label: health.fetchJob.label,
    }
  }
  return { kind: 'none' }
}

/**
 * 真实系统状态的唯一取数点。挂在 `AppShell` 里（登录态确认之后），
 * 状态条与左栏摘要共用同一份，不各发一遍请求。
 *
 * **原型模式下一次请求都不发**：那时的状态来自顶栏那个下拉。这是"默认路径
 * 一步都不许碰 mock、原型路径一步都不许碰真实后端"的那条分界线。
 */
export function SystemHealthProvider({ children }: { children: ReactNode }) {
  // 冻结在挂载那一刻：原型模式中途不会切换，而每次渲染都重读 sessionStorage
  // 会让 `useResource` 的 deps 抖动。
  const [proto] = useState(() => isProtoMode())
  const { state } = useSystemState()

  const res = useResource<SystemHealth | null>(
    () => (proto ? Promise.resolve(null) : fetchSystemHealth()),
    [proto],
  )

  // `useResource` 每次渲染都返回一个新对象（`{...res, retry}`），直接放进 deps
  // 等于没有 memo。拆成三个稳定值再依赖它们。
  const phase = res.state
  const error = res.state === 'error' ? res.error : null
  const health = res.state === 'ready' ? res.data : null
  const { retry } = res

  const value = useMemo<SystemStatusView>(() => {
    if (proto) return { alert: protoAlert(state), openFailures: null, retry }
    if (phase === 'error' && error !== null) {
      return { alert: { kind: 'unreadable', detail: error.message }, openFailures: null, retry }
    }
    // `health === null` 有两种来源：还在 loading，或者原型模式那个 resolve(null)。
    // 后者在上面已经返回了，所以这里只剩"还没探完"。
    if (health === null) return { alert: { kind: 'checking' }, openFailures: null, retry }
    return { alert: liveAlert(health), openFailures: health.openFailures, retry }
  }, [proto, state, phase, error, health, retry])

  return <SystemStatusContext.Provider value={value}>{children}</SystemStatusContext.Provider>
}

/**
 * 类型与读取口转出去，给原本就从本文件取的调用方（`Rail`、测试）用。
 *
 * **页面不要走这条转出**——那等于又把 `SystemStatus.module.css` 拖进模块图，
 * 而那正是 `systemAlert.ts` 存在的理由（见那个文件的头注释）。页面直接
 * `import ... from '@/app/systemAlert'`。
 */
export { useSystemStatusView, useSystemAlertKind } from './systemAlert'
export type { SystemAlert, SystemStatusView } from './systemAlert'

/* ══════════════════════════════════════════════════════════════════
   顶栏下方的告警条
   ══════════════════════════════════════════════════════════════════ */

function WarnIcon() {
  return (
    <svg
      className={styles.icon}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 2.4 14.4 13.2H1.6L8 2.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 6.6v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r=".8" fill="currentColor" />
    </svg>
  )
}

/**
 * 顶栏下方的告警条（原型的 `.sysbar`）。
 *
 * 三件事在 F0 变了：
 *
 * 1. **状态来自真实端点**（`nas.reachable` 与 `fetch_recordings` 的最近运行），
 *    不再是顶栏那个手动下拉——它退回 `?proto=1` 下的演示工具。
 * 2. **「腾讯会议不可达」这句话没有了**。我们没有探测腾讯会议的端点，
 *    有的只是"拉取任务最近几轮都失败了"这个观察。文案照观察写
 *    （`fetchStreakText()`），不替一个不存在的探测下结论。
 * 3. **「暂停到期清理」不再是一个点了只改本地 state 的按钮**。这个动作有真实
 *    端点（`POST /api/v1/admin/storage/cleanup-pause`），但它归归档存储页
 *    （F5b 独占 `api/admin/storage.ts`），地基不越界去写。所以这里给的是
 *    一个真的能走到那个动作的链接，而不是一个假按钮——
 *    "点了没反应"比"多点一次"糟得多。
 */
export default function SystemStatus() {
  const { alert, retry } = useSystemStatusView()

  if (alert.kind === 'none' || alert.kind === 'checking') return null

  if (alert.kind === 'unreadable') {
    return (
      <div className={styles.bar} data-sev="warn" role="status" data-alert="unreadable">
        <WarnIcon />
        <p className={styles.text}>
          <b>系统状态读取失败</b>，下面显示的一切都可能不是现在的实际情况。
          <br />
          <span className={styles.sub}>{alert.detail}</span>
        </p>
        <div className={styles.acts}>
          <button type="button" className={styles.btn} onClick={retry}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (alert.kind === 'fetch-unknown') {
    return (
      <div className={styles.bar} data-sev="warn" role="status" data-alert="fetch-unknown">
        <WarnIcon />
        <p className={styles.text}>
          <b>拉取任务的状态未知</b>：后端的任务清单里没有「拉取新录制」这一项，
          判断不了新录制还拉不拉得到。
          <br />
          <span className={styles.sub}>已经拉下来的会议、归档与对外采集不受影响。</span>
        </p>
        <div className={styles.acts}>
          <Link className={styles.btn} to="/jobs">
            查看定时任务
          </Link>
        </div>
      </div>
    )
  }

  if (alert.kind === 'fetch-stalled') {
    return (
      <div className={styles.bar} data-sev="warn" role="status" data-alert="fetch-stalled">
        <WarnIcon />
        <p className={styles.text}>
          <b>{fetchStreakText(alert.streak)}</b>
          ——「{alert.label}」这个任务连着没跑成，新的录制多半正在积压。
          <br />
          <span className={styles.sub}>
            这是从任务运行记录推出来的判断，不是对腾讯会议接口的直接探测；
            已经拉下来的会议、归档与对外采集不受影响。
          </span>
        </p>
        <div className={styles.acts}>
          <Link className={styles.btn} to="/jobs">
            查看失败原因
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.bar} data-sev="fail" role="status" data-alert="nas-down">
      <WarnIcon />
      <p className={styles.text}>
        <b>NAS 无法写入</b>，归档任务全部失败。归档不成功的会议，本地保留期一到就彻底没有了
        ——现在有 <b>{alert.pendingMeetings ?? '…'}</b> 场还没归档完成。
        <br />
        <span className={styles.sub}>
          {alert.error ?? '建议先暂停到期清理，避免今晚 03:00 的清理任务删掉还没归档的文件。'}
        </span>
      </p>
      <div className={styles.acts}>
        <Link className={styles.btn} to="/storage">
          暂停到期清理
        </Link>
      </div>
    </div>
  )
}
