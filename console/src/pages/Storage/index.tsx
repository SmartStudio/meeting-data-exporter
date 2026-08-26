import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/ui/Button'
import { PageShell } from '@/ui/PageShell'
import { Skeleton } from '@/ui/Skeleton'
import { Toast } from '@/ui/Toast'
import { ApiError } from '@/api/client'
import {
  fetchFetchableMeetings,
  previewCleanup,
  runCleanup,
  setCleanupPaused,
  setRetentionDays,
} from '@/api/admin/storage'
import { CleanupSheet, type CleanupPhase } from './CleanupSheet'
import { NasPanel } from './NasPanel'
import { RetentionDaysSheet } from './RetentionDaysSheet'
import { RetentionPanel, type StorageBusy } from './RetentionPanel'
import { buildInventoryCsv, downloadText, inventoryFileName } from './inventory'
import { useStorage } from './useStorage'
import styles from './Storage.module.css'

/**
 * 归档存储页（spec.md §4.9）。
 *
 * 两块内容（NAS 归档 / 本地保留窗口）、三个动作（改默认保留天数 / 导出可采集
 * 清单 / 立即清理已到期文件），外加**「暂停到期清理」**——系统状态横幅上
 * NAS 断连时给的那个动作链到的就是这一页（F0 报告 §2.2）。spec §7.2 说它是
 * "唯一能阻止不可逆损失的动作"，所以横幅上有一个入口、这一页上有真正的开关。
 *
 * ## 这一页的三条纪律
 *
 * 1. **写完重取，不做乐观更新**（计划 G-c）。每个动作都是"发请求 → 拿后端
 *    的回显 → 重新 `fetchStorage()`"。尤其暂停开关：后端是写后重读，
 *    回显的是库里此刻的真值，跟请求体不一定一样（别人可能同时改过）。
 * 2. **拿不到的数不显示成 0**。`failedMeetings` 现在恒为 null（A8 才接上
 *    `job_failures`），显示"暂不可得"并附上后端给的原因。
 * 3. **NAS 不可达不是错误态**。后端仍返回 200，这一页照常渲染——把它折成
 *    "读取失败"会把最该被看到的东西（还有几场没归档、清理停没停）藏起来。
 */
export default function StoragePage() {
  const { res, data, refresh, retry } = useStorage()

  const [busy, setBusy] = useState<StorageBusy | null>(null)
  const [toast, setToast] = useState<{ n: number; text: string } | null>(null)
  const [daysOpen, setDaysOpen] = useState(false)
  const [daysError, setDaysError] = useState<string | null>(null)
  const [cleanup, setCleanup] = useState<CleanupPhase | null>(null)

  const toastSeq = useState(() => ({ n: 0 }))[0]
  const notify = useCallback(
    (text: string) => {
      toastSeq.n += 1
      setToast({ n: toastSeq.n, text })
    },
    [toastSeq],
  )

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  /* ── 暂停 / 恢复到期清理 ──────────────────────────────────── */

  const togglePause = useCallback(async () => {
    if (!data) return
    const want = !data.retention.cleanupPaused
    setBusy('pause')
    try {
      const effective = await setCleanupPaused(want)
      await refresh()
      if (effective === want) {
        notify(want ? '到期清理已暂停，恢复之前不会再删除任何本地文件。' : '到期清理已恢复。')
      } else {
        // 写后重读回来的值与请求不一致：可能有人同时改过，也可能写没生效。
        // 这时**照库里的真值说话**，不能报一句"已暂停"了事。
        notify(
          want
            ? '暂停没有生效：库里此刻仍然是「清理正常运行」。请刷新确认，必要时再点一次。'
            : '恢复没有生效：库里此刻仍然是「清理已暂停」。',
        )
      }
    } catch (e) {
      notify(`改不动到期清理开关：${msgOf(e)}`)
    } finally {
      setBusy(null)
    }
  }, [data, refresh, notify])

  /* ── 修改默认保留天数 ─────────────────────────────────────── */

  const submitDays = useCallback(
    async (days: number) => {
      setBusy('days')
      setDaysError(null)
      try {
        const r = await setRetentionDays(days)
        await refresh()
        setDaysOpen(false)
        notify(
          `默认保留天数已改为 ${r.defaultDays} 天` +
            `（原先是 ${r.previousDefaultDays === null ? '一个非法值' : `${r.previousDefaultDays} 天`}）。` +
            '只影响此后新归档的会议。',
        )
      } catch (e) {
        // 表单不关：关掉的话，刚填的那个数和被拒绝的原因一起消失了。
        setDaysError(describeDaysError(e))
      } finally {
        setBusy(null)
      }
    },
    [refresh, notify],
  )

  /* ── 导出可采集清单 ───────────────────────────────────────── */

  const exportInventory = useCallback(async () => {
    setBusy('export')
    try {
      const list = await fetchFetchableMeetings()
      const now = new Date()
      downloadText(inventoryFileName(list, now), buildInventoryCsv(list.rows, now))
      notify(
        `已导出可采集清单 · ${list.rows.length} 场会议（含会议号、到期日、已授权程序、NAS 路径）。` +
          (list.truncated
            ? `注意：清单没扫全——保留期内共 ${list.total} 场，只扫了 ${list.scanned} 场，` +
              '导出的不是完整清单（文件名里标了「部分」）。'
            : ''),
      )
    } catch (e) {
      // 取数失败时**不生成文件**：一个空的或半截的"可采集清单"会被当成
      // "这些就是全部"，而清单上没有与不可采集在使用它的人那里是同一个意思。
      notify(`清单没导出来：${msgOf(e)}`)
    } finally {
      setBusy(null)
    }
  }, [notify])

  /* ── 立即清理已到期文件 ───────────────────────────────────── */

  const openCleanup = useCallback(async () => {
    setBusy('cleanup')
    setCleanup({ kind: 'loading' })
    try {
      const preview = await previewCleanup()
      setCleanup({ kind: 'preview', preview, running: false })
    } catch (e) {
      setCleanup({ kind: 'error', message: describeCleanupError(e) })
    } finally {
      setBusy(null)
    }
  }, [])

  const confirmCleanup = useCallback(async () => {
    setCleanup((p) => (p?.kind === 'preview' ? { ...p, running: true } : p))
    try {
      const result = await runCleanup()
      setCleanup({ kind: 'done', result })
      await refresh()
    } catch (e) {
      setCleanup({ kind: 'error', message: describeCleanupError(e) })
    }
  }, [refresh])

  /* ── 渲染 ─────────────────────────────────────────────────── */

  const description =
    'NAS 是长期唯一存放地；本地只是一个到期就会清空的取用窗口。这一页回答：归档到哪儿去了、' +
    '还剩多少空间、哪些会议还取得到、什么时候会被删。'

  return (
    <PageShell title="归档存储" description={description}>
      {data === null && res.state === 'loading' && (
        <div className={styles.skeletons} data-testid="storage-loading">
          <Skeleton width="40%" />
          <Skeleton width="80%" size="sm" />
          <Skeleton width="60%" size="sm" />
        </div>
      )}

      {data === null && res.state === 'error' && (
        <div className={styles.errorBox} data-testid="storage-error">
          <p>读不到归档存储的状态，所以这一页一个数都不敢显示——显示旧数字比不显示更糟。</p>
          <p>{res.error.message}</p>
          <div className={styles.errorActions}>
            <Button variant="primary" onClick={retry}>
              重试
            </Button>
          </div>
        </div>
      )}

      {data !== null && (
        <div className={styles.panels}>
          <NasPanel nas={data.nas} />
          <RetentionPanel
            retention={data.retention}
            busy={busy}
            onTogglePause={() => void togglePause()}
            onEditDays={() => {
              setDaysError(null)
              setDaysOpen(true)
            }}
            onExport={() => void exportInventory()}
            onCleanup={() => void openCleanup()}
          />
        </div>
      )}

      <RetentionDaysSheet
        open={daysOpen}
        onClose={() => setDaysOpen(false)}
        current={data?.retention.defaultDays ?? null}
        submitting={busy === 'days'}
        error={daysError}
        onSubmit={(days) => void submitDays(days)}
      />

      <CleanupSheet
        open={cleanup !== null}
        onClose={() => setCleanup(null)}
        phase={cleanup ?? { kind: 'loading' }}
        onConfirm={() => void confirmCleanup()}
      />

      <Toast
        open={toast !== null}
        onClose={() => setToast(null)}
        message={<span data-testid="storage-toast">{toast?.text ?? ''}</span>}
      />
    </PageShell>
  )
}

/** 错误落到界面上时说清是哪条端点、后端说了什么——`ApiError.message` 里两样都有。 */
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 保留天数被拒绝时的说法。**区间照后端给的 min/max 说**，不在前端另写一份：
 * 两处各存一份，改一处就会有一处开始说谎，而这个数管的是删文件的时刻。
 */
function describeDaysError(e: unknown): string {
  if (e instanceof ApiError && e.status === 400) {
    const body = e.body
    if (body !== null && typeof body === 'object' && 'error' in body) {
      const b = body as { error: unknown; min?: unknown; max?: unknown }
      if (b.error === 'invalid_days' && typeof b.min === 'number' && typeof b.max === 'number') {
        return `后端拒绝了这个天数：合法区间是 ${b.min}–${b.max} 天。`
      }
    }
  }
  return msgOf(e)
}

/** 503 时把后端那句话原样摆出来——它说的是"没挂载本地归档区"，不是"没有可清理的"。 */
function describeCleanupError(e: unknown): string {
  if (e instanceof ApiError && e.status === 503) {
    const body = e.body
    if (body !== null && typeof body === 'object' && 'message' in body) {
      const m = (body as { message: unknown }).message
      if (typeof m === 'string') return m
    }
  }
  return msgOf(e)
}
