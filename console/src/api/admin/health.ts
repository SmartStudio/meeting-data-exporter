/**
 * 全局系统状态条要的那一小块数据。
 *
 * ## 为什么是一个单独的文件，而不是 `storage.ts` / `jobs.ts`
 *
 * 系统状态条（`app/SystemStatus.tsx`）和左栏底部的状态摘要（`app/Rail.tsx`）
 * 是**全局**的，每一页都挂着它们；而归档存储页（F5b）与定时任务页（F5a）
 * 是两个各自独立的页面任务，`api/admin/storage.ts` / `api/admin/jobs.ts`
 * 归它们独占（计划 §2 的任务表）。地基（F0）如果先把那两个文件建出来，
 * 就正好在两个并行任务的独占区里落了笔——F0 存在的意义恰恰是不这么干。
 *
 * 所以这里只做一件很窄的事：**从那两条端点里读出状态条要的三个事实**，
 * 别的字段一个都不碰。F5a / F5b 建自己的域文件时不需要动这个文件，
 * 也不要把这里的类型当成那两条端点的完整建模——它不是。
 *
 * ## 五态系统状态的真实来源（计划 G-d）
 *
 * | 状态 | 来源 |
 * | --- | --- |
 * | `loading` / `load-failed` | `useResource` 的三态，本来就是真的 |
 * | `nas-down` | `GET /api/v1/admin/storage` 的 `nas.reachable`（false 时仍是 200） |
 * | `tencent-down` | **没有专门端点**，从 `GET /api/v1/admin/jobs` 里
 *                    `fetch_recordings` 的 `recentRuns` 推 |
 *
 * 最后一条是**推断不是直报**：它必须在界面上说成"最近 N 轮拉取连续失败"，
 * 不能说成"腾讯会议不可达"——那是在替一个我们没有的探测下结论。
 * 措辞收在 `fetchStreakText()` 里，定时任务页（F5a）要用同一个函数，
 * 两处不一致就等于给了两个不同的事实。
 */

import { apiGet } from '../client'
import { reader } from '../validate'

const BASE = '/api/v1/admin'

/** 连续失败几轮才当作"拉不通"。一次失败就报警等于天天报警，而天天报警等于没有报警。 */
export const TENCENT_DOWN_STREAK = 3

/** 拉取任务的名字。四个内置任务之一（`JOB_CATALOG`，`src/store/jobs.ts`）。 */
export const FETCH_JOB_NAME = 'fetch_recordings'

export interface NasStatus {
  /**
   * NAS 挂载点。**可空**——网关的 `nasRoot` 在没配 `MDE_NAS_ROOT` 时就是 null
   * （`src/index.ts`）。这里曾经按必填读，于是那种部署上每一页顶上都会挂一条
   * "系统状态读取失败"，而真正的原因（没配挂载点）一个字都不会出现。
   *
   * 状态条本身不用它——它只关心通得通、几场没归档。留着这个字段是因为
   * 「挂载点是什么」迟早要在横幅上说，届时按可空渲染即可。
   */
  root: string | null
  /** false 时后端仍返回 200——不可达本身是要展示的内容，不是一次错误 */
  reachable: boolean
  /** unix 秒 */
  checkedAt: number
  error: string | null
  /**
   * 还有资产没进 `archived_assets` 的场次数。
   *
   * 它同时包含"还没轮到"和"一直归档不成功"两种会议——两者在库里现在长得
   * 一模一样（`nas.failedMeetings` 恒为 null，要等 A8 接上 `job_failures`）。
   * 所以界面上只能说"还没归档完成"，不能说"归档失败"。
   */
  pendingMeetings: number
}

export interface FetchJobStatus {
  name: string
  /** 后端下发的中文名（"拉取新录制"）。不要在前端另起一个叫法 */
  label: string
  /** 从最近一次往回数，连着几轮 `failed` */
  consecutiveFailures: number
  /** never_ran / running / overdue / ok。原样透出，不收窄 */
  health: string
  /** 最近一次真的开跑过的运行的开始时间；没有则 null */
  lastStartedAt: number | null
}

export interface SystemHealth {
  nas: NasStatus
  /** 任务清单里没有 `fetch_recordings` 时为 null——**不当成"正常"**，界面上要说未知 */
  fetchJob: FetchJobStatus | null
  /** `failuresTotal`：需要人处理的失败项总数（不受列表 100 条上限截断） */
  openFailures: number
}

/**
 * 从 `recentRuns`（最近一次在第 0 个）往回数连续失败的轮数。
 *
 * - `queued` / `running` / `skipped` 是**还没出结果**的行，跨过去：既不计数
 *   也不打断。在一台已经拉不通的机器上按一下「立即运行」，最新一行就是
 *   `queued`——拿它当"最近一次运行"会让界面从"连续失败"翻回正常。
 * - `succeeded` 打断计数（拉通过一次，之前的失败不再是"连续"）。
 * - `interrupted` 也打断：进程被杀是本机的事，不是腾讯会议不可达的证据。
 *   把它算成失败会让一次重启看起来像一次外部故障。
 */
export function countConsecutiveFailures(statuses: readonly string[]): number {
  let n = 0
  for (const s of statuses) {
    if (s === 'queued' || s === 'running' || s === 'skipped') continue
    if (s === 'failed') {
      n += 1
      continue
    }
    break
  }
  return n
}

/**
 * 推断的措辞。**只说观察到的事实**（"最近 N 轮拉取连续失败"），
 * 不说结论（"腾讯会议不可达"）——我们没有一个探测腾讯会议的端点。
 *
 * 定时任务页（F5a）显示同一件事时 import 这个函数，不要另写一句。
 */
export function fetchStreakText(streak: number): string {
  return `最近 ${streak} 轮拉取连续失败`
}

/** 两条端点各取一次。任一条读不到，整体就是"读不到"——半个正常比不知道更糟。 */
export async function fetchSystemHealth(): Promise<SystemHealth> {
  const [storageRaw, jobsRaw] = await Promise.all([
    apiGet<unknown>(`${BASE}/storage`),
    apiGet<unknown>(`${BASE}/jobs`),
  ])

  const sr = reader(`GET ${BASE}/storage`)
  const storage = sr.object(storageRaw, '')
  const nasRaw = sr.object(storage.nas, 'nas')
  const nas: NasStatus = {
    root: sr.strOrNull(nasRaw, 'root', 'nas'),
    reachable: sr.bool(nasRaw, 'reachable', 'nas'),
    checkedAt: sr.num(nasRaw, 'checkedAt', 'nas'),
    error: sr.strOrNull(nasRaw, 'error', 'nas'),
    pendingMeetings: sr.num(nasRaw, 'pendingMeetings', 'nas'),
  }

  const jr = reader(`GET ${BASE}/jobs`)
  const jobs = jr.object(jobsRaw, '')
  const list = jr.objList(jobs, 'jobs', '')
  const openFailures = jr.num(jobs, 'failuresTotal', '')

  const idx = list.findIndex((j) => j.name === FETCH_JOB_NAME)
  let fetchJob: FetchJobStatus | null = null
  if (idx >= 0) {
    const where = `jobs[${idx}]`
    const job = list[idx]!
    const runs = jr.objList(job, 'recentRuns', where)
    const statuses = runs.map((r, i) => jr.str(r, 'status', `${where}.recentRuns[${i}]`))
    const started = runs.find((r) => r.startedAt !== null && r.startedAt !== undefined)
    fetchJob = {
      name: jr.str(job, 'name', where),
      label: jr.str(job, 'label', where),
      consecutiveFailures: countConsecutiveFailures(statuses),
      health: jr.str(job, 'health', where),
      lastStartedAt: started === undefined ? null : jr.numOrNull(started, 'startedAt', where),
    }
  }

  return { nas, fetchJob, openFailures }
}
