import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Meeting, SystemState } from '@/api/types'
import { mockApi } from '@/api/mock'
import { useResource, type Resource } from '@/lib/useResource'
import styles from './SystemStatus.module.css'

/**
 * 六种取值，对应顶栏下拉的六个选项。「正常」是基线，不算故障态；
 * 另外五种是 spec.md §7、§8 说的「五种系统状态」。
 */
export const SYSTEM_STATE_OPTIONS: Array<{ value: SystemState; label: string }> = [
  { value: 'ok', label: '正常' },
  { value: 'loading', label: '加载中' },
  { value: 'load-failed', label: '加载失败' },
  { value: 'empty', label: '一场会议都没有' },
  { value: 'nas-down', label: 'NAS 断连' },
  { value: 'tencent-down', label: '腾讯会议不可达' },
]

interface SystemStateContextValue {
  state: SystemState
  setState: (state: SystemState) => void
}

const SystemStateContext = createContext<SystemStateContextValue | null>(null)

/**
 * 五种系统状态是规格的一部分（spec.md §7、§8），不是彩蛋——通过 Context
 * 下发给页面，页面据此各自响应（告警等级、给出的操作都不一样）。
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

/**
 * 会议数据，随当前系统状态联动。T2 的 `mockApi(state)` 已经把 nas-down 的
 * 变换（保留窗口清零、授权撤下）实现好了——这里只是把 Context 里的 `state`
 * 接进去，不重新发明一遍。
 *
 * 所有需要会议列表的页面（含 T6 的会议记录页）都应该用这个 hook 取数据，
 * 而不是自己再拼一次 `mockApi(state)`——不然切系统状态时数据不会跟着变，
 * 「故障必须在数据里可见」这条就成了一句空话。
 */
export function useMeetings(): Resource<Meeting[]> & { retry: () => void } {
  const { state } = useSystemState()
  return useResource(() => mockApi(state).listMeetings(), [state])
}

function archiveFailed(meetings: Meeting[]): Meeting[] {
  return meetings.filter((m) => m.archive === 'failed')
}

/**
 * 顶栏下方的告警条（原型的 `.sysbar`）。只在 nas-down / tencent-down 时出现——
 * loading / load-failed / empty 是数据三态，出口在页面内容区（spec.md §8），
 * 不占用这条全局横幅。
 *
 * nas-down 的「暂停到期清理」是唯一能阻止不可逆损失的动作，必须长在横幅本身
 * 上。F1 只画按钮 + 一个内联确认，不接后端，也不借用 T4 的浮层组件。
 */
export default function SystemStatus() {
  const { state } = useSystemState()
  const meetings = useMeetings()
  const [purgePaused, setPurgePaused] = useState(false)
  const [confirming, setConfirming] = useState(false)

  if (state !== 'nas-down' && state !== 'tencent-down') return null

  const isNas = state === 'nas-down'
  const failedCount = meetings.state === 'ready' ? archiveFailed(meetings.data).length : null

  return (
    <div className={styles.bar} data-sev={isNas ? 'fail' : 'warn'} role="status">
      <svg className={styles.icon} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2.4 14.4 13.2H1.6L8 2.4Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M8 6.6v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="8" cy="11.4" r=".8" fill="currentColor" />
      </svg>

      <p className={styles.text}>
        {isNas ? (
          <>
            <b>NAS 无法写入</b>，归档任务全部失败。归档不成功的会议，本地保留期一到就彻底没有了
            ——现在有 <b>{failedCount ?? '…'}</b> 场正等着归档。
            <br />
            <span className={styles.sub}>
              {purgePaused
                ? '到期清理已暂停，NAS 恢复前不会再删除任何本地文件。'
                : '建议先暂停到期清理，避免今晚 03:00 的清理任务删掉还没归档的文件。'}
            </span>
          </>
        ) : (
          <>
            <b>腾讯会议接口不可达</b>，拉取任务已暂停（重试中）。已经拉下来的会议不受影响，
            归档和对外采集照常。
          </>
        )}
      </p>

      {isNas && (
        <div className={styles.acts}>
          {purgePaused ? (
            <span className={styles.pausedTag}>已暂停到期清理</span>
          ) : confirming ? (
            <span className={styles.confirm} role="alertdialog" aria-label="确认暂停到期清理">
              <span className={styles.confirmText}>确认暂停？NAS 恢复前不会再删除任何本地文件。</span>
              <button
                type="button"
                className={styles.btn}
                autoFocus
                onClick={() => {
                  setPurgePaused(true)
                  setConfirming(false)
                }}
              >
                确认暂停
              </button>
              <button type="button" className={styles.btnQuiet} onClick={() => setConfirming(false)}>
                取消
              </button>
            </span>
          ) : (
            <button type="button" className={styles.btn} onClick={() => setConfirming(true)}>
              暂停到期清理
            </button>
          )}
        </div>
      )}
    </div>
  )
}
