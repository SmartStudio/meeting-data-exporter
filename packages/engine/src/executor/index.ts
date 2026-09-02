import type { Store, AssetRow } from '../store'
import type { DownloadResult, DownloadTask } from '../downloader'
import type { Storage } from '../storage/types'
import type { AssetSource } from '../source/types'
import { GATEWAY_TYPE_TO_ASSET_KEY, assetKeyToFilename, isTextAssetType, ASSET_WAIT_CAP_SEC } from '../domain/types'
import { meetingDirPath } from '../domain/filename'
import { judgeReadiness } from '../domain/readiness'

export interface ExecutorDeps {
  store: Store
  download: (task: DownloadTask, onProgress: (b: number) => void) => Promise<DownloadResult>
  storage: Pick<Storage, 'ensureFreeSpace' | 'writeMeta'>
  gw: Pick<AssetSource, 'listAssets'>
  meetingsById: Map<string, { subject: string | null; startTime: number | null; meetingCode: string | null; endTime: number | null; subMeetingId: string }>
}
const MAX_ATTEMPTS = 5

export async function runExecutor(deps: ExecutorDeps, opts: { concurrency: number; leaseSec: number }, now: () => number) {
  const result = { completed: 0, failed: 0, skipped: 0 }
  const worker = async () => {
    for (;;) {
      const row = await deps.store.claimNext(now(), opts.leaseSec)
      if (!row) return
      await handleOne(deps, row, opts.leaseSec, now, result)
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, worker))
  return result
}

async function handleOne(deps: ExecutorDeps, row: AssetRow, leaseSec: number, now: () => number, result: { completed: number; failed: number; skipped: number }) {
  const relPath = await buildRelPath(deps, row)
  if (relPath === null) { await deps.store.markSkipped(row.id, 'meeting_meta_missing', now()); result.skipped++; return }
  if (row.bytes_expected != null && !(await deps.storage.ensureFreeSpace(row.bytes_expected))) { await deps.store.markSkipped(row.id, 'disk_full', now()); result.skipped++; return }
  await deps.store.setTargetPath(row.id, relPath, row.file_type, now())

  const isText = isTextAssetType(row.asset_type)
  // 进度回写是尽力而为：写库失败不中断下载，但必须留下痕迹（不能用静默的 .catch(() => {})）
  const res = await deps.download({ assetId: row.asset_id ?? assetId(row), relPath, bytesExpected: row.bytes_expected, isText }, (b) => {
    deps.store.touchProgress(row.id, b, now(), leaseSec).catch((e) => console.warn(`progress write failed: ${e}`))
  })
  // markCompleted 顺手把 downloader 报回的真实字节数落库：平台常常不给 bytes_expected，
  // 那时这就是「这个文件多大」唯一的事实来源（见 domain/manifest.ts 的 bytes 字段注释）
  if (res.status === 'completed') { await deps.store.markCompleted(row.id, res.contentHash, res.bytesWritten, now()); result.completed++; return }
  if (row.attempts >= MAX_ATTEMPTS) { await deps.store.markDead(row.id, res.error, now()); result.failed++; return }
  // `row.attempts` 是**这一次**领取之后的值（claimNext 领的时候就 +1 了），所以
  // 第一次失败传进 downloadBackoff 的是 1，等 5 分钟。退避时间由这里算、store 只写，
  // 理由见 Store.markFailed。
  const at = now()
  await deps.store.markFailed(row.id, res.error, at, at + downloadBackoff(row.attempts)); result.failed++
}

/**
 * 相对路径：<year>/<month>/<清洗目录>/<资产文件名>
 *
 * 目录那一段走 `meetingDirPath`，与同目录下的 meeting.json / _manifest.json
 * （manifest/index.ts）共用同一份计算——这两处一旦各算一遍，sidecar 就会落到
 * 一个没有资产的目录里去。
 */
async function buildRelPath(deps: ExecutorDeps, row: AssetRow): Promise<string | null> {
  const m = deps.meetingsById.get(row.meeting_id)
  if (!m) return null
  const key = GATEWAY_TYPE_TO_ASSET_KEY[row.asset_type] ?? (row.asset_type as any)
  const { ordinal } = await deps.store.siblingRank(row)
  const fname = assetKeyToFilename(key, row.remote_id, row.file_type, ordinal)  // 归一化与空值回落都在 assetKeyToFilename 里
  return `${meetingDirPath(m, row.meeting_id)}/${fname}`
}
function assetId(row: AssetRow): string { return `${row.meeting_id}:${row.remote_id}:${row.asset_type}:0` }

/** 探测循环：重查到期 probing 资产，就绪则补建任务、超时则 abandon */
export async function runProbes(deps: ExecutorDeps & { store: Store }, now: () => number) {
  const out = { resolved: 0, abandoned: 0, newTasks: 0 }
  for (const p of await deps.store.dueProbes(now())) {
    const meetingKey = p.meeting_id
    const assets = await deps.gw.listAssets(meetingKey)
    const a = assets.find((x) => x.assetType === p.asset_type)
    const verdict = judgeReadiness({ present: !!a, state: a?.state, allowDownload: a?.allowDownload, now: now(), deadlineAt: p.deadline_at })
    // p 来自 dueProbes()，形状为 ProbeRow（snake_case: meeting_id/sub_meeting_id/asset_type），
    // 而 resolveProbe/abandonProbe/bumpProbe 接受的是 ProbeKey（camelCase）——显式建 key 适配，避免形状不一致
    const key = { meetingId: p.meeting_id, subMeetingId: p.sub_meeting_id, assetType: p.asset_type }
    if (verdict === 'ready') { await deps.store.upsertAsset({ meetingId: p.meeting_id, subMeetingId: p.sub_meeting_id, assetType: p.asset_type, remoteId: a!.remoteId, assetId: a!.assetId, bytesExpected: a!.bytesExpected, fileType: a!.fileType }, now()); await deps.store.resolveProbe(key); out.resolved++; out.newTasks++ }
    else if (verdict === 'skip_disallowed') { await deps.store.abandonProbe(key, 'download_not_allowed'); out.abandoned++ }
    else if (verdict === 'skip_timeout') { await deps.store.abandonProbe(key, 'upstream_timeout'); out.abandoned++ }
    else await deps.store.bumpProbe(key, now() + probeBackoff(p.attempts))   // 继续等，退避
  }
  return out
}
function probeBackoff(attempts: number): number { return Math.min(3600, 300 * 2 ** Math.min(attempts, 4)) }  // 5min→…→上限 1h

/**
 * 下载失败后的退避（秒）：第 n 次失败等 `300 · 2^(n-1)`，上限 1 小时。
 *
 *   第 1 次失败 → 5 分钟   第 2 次 → 10 分钟   第 3 次 → 20 分钟   第 4 次 → 40 分钟
 *   第 5 次失败 → 不再等，转 dead（MAX_ATTEMPTS）
 *
 * 也就是说一条资产从第一次失败到被放弃，前后跨 **75 分钟**、试满 5 次。这个总时长
 * 是照着"要扛过什么"挑的：网络抖动、上游一次限流、一次 CDN 502——都在分钟级别，
 * 而不是"腾讯会议那边这个文件坏了"（那种情况多等一小时也没用，早点转 dead 让人看见
 * 反而对）。1 小时那个上限在 MAX_ATTEMPTS=5 下永远用不上（第 5 次失败不再退避、
 * 直接转 dead），它是给将来调大 MAX_ATTEMPTS 的人兜底的：没有它，第 8 次失败
 * 就要等 10 小时。
 *
 * **和上面的 `probeBackoff` 走同一条 `300·2^k` 曲线，但刻意不共用一个函数**，这是有意的。两者回答的是
 * 不同的问题：probe 是「资产还没生成好，什么时候再去问一次」——上游在慢慢干活，
 * 等多久取决于纪要多久能出来；这里是「下载出错了，多久再试一次」——错误可能是
 * 我们这边的网络，也可能是对方限流。今天两条曲线数值撞在一起是巧合，把它们并成
 * 一个函数就等于宣布"以后也一起调"，而实际要调的时候一定是分别调的。
 */
export function downloadBackoff(attempts: number): number { return Math.min(3600, 300 * 2 ** (attempts - 1)) }
