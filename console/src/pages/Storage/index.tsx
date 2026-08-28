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
 * 2. **拿不到的数不显示成 0**。`failedMeetings` 在老网关上是 null，显示
 *    "暂不可得"并把后端给的原因挂在那一格的 ⓘ 上——0 的意思是"确实没有"。
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

  /**
   * 写完之后的重取。**重取失败与写失败是两件事**：写已经生效了，只是界面上
   * 这一份数字可能是旧的。把它报成"操作失败"会让人再点一次（对不可逆的动作
   * 尤其危险），咽下去又会让人对着旧数字下判断。所以单独返回一句附言，
   * 拼在动作自己的提示后面。
   */
  const refreshOrWarn = useCallback(async (): Promise<string> => {
    try {
      await refresh()
      return ''
    } catch (e) {
      return `（改动已经发出去了，但重新取数失败：${msgOf(e)}——上面的数字可能还是旧的，刷新页面再看一眼。）`
    }
  }, [refresh])

  /* ── 暂停 / 恢复到期清理 ──────────────────────────────────── */

  const togglePause = useCallback(async () => {
    if (!data) return
    const want = !data.retention.cleanupPaused
    setBusy('pause')
    try {
      const effective = await setCleanupPaused(want)
      const stale = await refreshOrWarn()
      if (effective === want) {
        notify(
          (want ? '到期清理已暂停，恢复之前不会再删除任何本地文件。' : '到期清理已恢复。') + stale,
        )
      } else {
        // 写后重读回来的值与请求不一致：可能有人同时改过，也可能写没生效。
        // 这时**照库里的真值说话**，不能报一句"已暂停"了事。
        notify(
          (want
            ? '暂停没有生效：库里此刻仍然是「清理正常运行」。请刷新确认，必要时再点一次。'
            : '恢复没有生效：库里此刻仍然是「清理已暂停」。') + stale,
        )
      }
    } catch (e) {
      notify(`改不动到期清理开关：${msgOf(e)}`)
    } finally {
      setBusy(null)
    }
  }, [data, refreshOrWarn, notify])

  /* ── 修改默认保留天数 ─────────────────────────────────────── */

  const submitDays = useCallback(
    async (days: number) => {
      setBusy('days')
      setDaysError(null)
      try {
        const r = await setRetentionDays(days)
        const stale = await refreshOrWarn()
        setDaysOpen(false)
        notify(
          `默认保留天数已改为 ${r.defaultDays} 天` +
            `（原先是 ${r.previousDefaultDays === null ? '一个非法值' : `${r.previousDefaultDays} 天`}）。` +
            '只影响此后新归档的会议。' +
            stale,
        )
      } catch (e) {
        // 表单不关：关掉的话，刚填的那个数和被拒绝的原因一起消失了。
        setDaysError(describeDaysError(e))
      } finally {
        setBusy(null)
      }
    },
    [refreshOrWarn, notify],
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
      // 结果已经摆在浮层里了，重取只是为了让下面那几个数跟上；它失败不该
      // 把"删完了"这件事报成一次失败。
      const stale = await refreshOrWarn()
      if (stale !== '') notify(stale)
    } catch (e) {
      setCleanup({ kind: 'error', message: describeCleanupError(e) })
    }
  }, [refreshOrWarn, notify])

  /* ── 渲染 ─────────────────────────────────────────────────── */

  // 页头不给导语。原先那两行（"NAS 是长期唯一存放地……这一页回答：……"）
  // 是一段目录——下面两块面板的标题「NAS 归档」「本地保留窗口」已经把它逐条
  // 说完了，而"到期就会清空"这件事在底下那段产品模型里讲得比它准。判据是
  // "删掉它，用户会不会做错事"：不会，所以删。PageShell 的 description 是选填的。
  return (
    <PageShell title="归档存储">
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

/**
 * 错误落到界面上的说法。
 *
 * **后端给了整句话的时候用它那句**（`body.message`），后面缀上端点与状态码。
 * 这一族错误里最该被原样读到的两条都带 message：503「本进程没挂载本地归档区」
 * 和 A8 之后的 403「这个账号是只读角色」——把它们压成一句
 * "返回 403：readonly_role"，读的人还得去查那个码是什么意思。
 * 没有 message 时退回 `ApiError.message`，里面已经带着端点名与后端错误码。
 */
function msgOf(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body
    if (body !== null && typeof body === 'object' && 'message' in body) {
      const m = (body as { message: unknown }).message
      if (typeof m === 'string' && m !== '') return `${m}（${e.endpoint} 返回 ${e.status}）`
    }
  }
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

/**
 * 清理这条路径上的错误。503 那句"本进程没挂载本地归档区（MDE_ARCHIVE_ROOT
 * 未配置）"必须原样读到——它与"没有可清理的文件"是完全不同的两件事，
 * 而后者会让人以为清理跑过了。`msgOf` 已经优先用 `body.message`，这里只是
 * 给这条路径一个有名字的出口，免得下一个人把它简化成 `String(e)`。
 */
function describeCleanupError(e: unknown): string {
  return msgOf(e)
}
