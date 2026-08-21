import type { Store, AssetRow } from '../store'
import type { DownloadResult, DownloadTask } from '../downloader'
import type { Storage } from '../storage/types'
import type { GatewayClient } from '../gateway/client'
import { GATEWAY_TYPE_TO_ASSET_KEY, assetKeyToFilename, isTextAssetType, ASSET_WAIT_CAP_SEC } from '../domain/types'
import { cleanDirName } from '../domain/filename'
import { judgeReadiness } from '../domain/readiness'

export interface ExecutorDeps {
  store: Store
  download: (task: DownloadTask, onProgress: (b: number) => void) => Promise<DownloadResult>
  storage: Pick<Storage, 'ensureFreeSpace' | 'writeMeta'>
  gw: Pick<GatewayClient, 'listAssets'>
  meetingsById: Map<string, { subject: string | null; startTime: number | null; meetingCode: string | null; endTime: number | null; subMeetingId: string }>
}
const MAX_ATTEMPTS = 5

export async function runExecutor(deps: ExecutorDeps, opts: { concurrency: number; leaseSec: number }, now: () => number) {
  const result = { completed: 0, failed: 0, skipped: 0 }
  const worker = async () => {
    for (;;) {
      const row = deps.store.claimNext(now(), opts.leaseSec)
      if (!row) return
      await handleOne(deps, row, opts.leaseSec, now, result)
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, worker))
  return result
}

async function handleOne(deps: ExecutorDeps, row: AssetRow, leaseSec: number, now: () => number, result: { completed: number; failed: number; skipped: number }) {
  const relPath = buildRelPath(deps, row)
  if (relPath === null) { deps.store.markSkipped(row.id, 'meeting_meta_missing', now()); result.skipped++; return }
  if (row.bytes_expected != null && !(await deps.storage.ensureFreeSpace(row.bytes_expected))) { deps.store.markSkipped(row.id, 'disk_full', now()); result.skipped++; return }
  deps.store.setTargetPath(row.id, relPath, row.file_type, now())

  const isText = isTextAssetType(row.asset_type)
  const res = await deps.download({ assetId: row.asset_id ?? assetId(row), relPath, bytesExpected: row.bytes_expected, isText }, (b) => deps.store.touchProgress(row.id, b, now(), leaseSec))
  if (res.status === 'completed') { deps.store.markCompleted(row.id, res.contentHash, now()); result.completed++; return }
  if (row.attempts >= MAX_ATTEMPTS) { deps.store.markDead(row.id, res.error, now()); result.failed++; return }
  deps.store.markFailed(row.id, res.error, now()); result.failed++
}

/** 相对路径：<year>/<month>/<清洗目录>/<资产文件名> */
function buildRelPath(deps: ExecutorDeps, row: AssetRow): string | null {
  const m = deps.meetingsById.get(row.meeting_id)
  if (!m) return null
  const d = new Date((m.startTime ?? 0) * 1000)
  const yyyy = String(d.getUTCFullYear()), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0')
  const hhmm = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0')
  const dir = cleanDirName(`${yyyy}-${mm}-${dd}`, hhmm, m.subject ?? '', m.meetingCode ?? row.meeting_id)
  const key = GATEWAY_TYPE_TO_ASSET_KEY[row.asset_type] ?? (row.asset_type as any)
  const { ordinal } = deps.store.siblingRank(row)
  const fname = assetKeyToFilename(key, row.remote_id, row.file_type ?? 'bin', ordinal)
  return `${yyyy}/${mm}/${dir}/${fname}`
}
function assetId(row: AssetRow): string { return `${row.meeting_id}:${row.remote_id}:${row.asset_type}:0` }

/** 探测循环：重查到期 probing 资产，就绪则补建任务、超时则 abandon */
export async function runProbes(deps: ExecutorDeps & { store: Store }, now: () => number) {
  const out = { resolved: 0, abandoned: 0, newTasks: 0 }
  for (const p of deps.store.dueProbes(now())) {
    const meetingKey = p.meeting_id
    const assets = await deps.gw.listAssets(meetingKey)
    const a = assets.find((x) => x.assetType === p.asset_type)
    const verdict = judgeReadiness({ present: !!a, state: a?.state, allowDownload: a?.allowDownload, now: now(), deadlineAt: p.deadline_at })
    // p 来自 dueProbes()，形状为 ProbeRow（snake_case: meeting_id/sub_meeting_id/asset_type），
    // 而 resolveProbe/abandonProbe/bumpProbe 接受的是 ProbeKey（camelCase）——显式建 key 适配，避免形状不一致
    const key = { meetingId: p.meeting_id, subMeetingId: p.sub_meeting_id, assetType: p.asset_type }
    if (verdict === 'ready') { deps.store.upsertAsset({ meetingId: p.meeting_id, subMeetingId: p.sub_meeting_id, assetType: p.asset_type, remoteId: a!.remoteId, assetId: a!.assetId, bytesExpected: a!.bytesExpected, fileType: a!.fileType }, now()); deps.store.resolveProbe(key); out.resolved++; out.newTasks++ }
    else if (verdict === 'skip_disallowed') { deps.store.abandonProbe(key, 'download_not_allowed'); out.abandoned++ }
    else if (verdict === 'skip_timeout') { deps.store.abandonProbe(key, 'upstream_timeout'); out.abandoned++ }
    else deps.store.bumpProbe(key, now() + probeBackoff(p.attempts))   // 继续等，退避
  }
  return out
}
function probeBackoff(attempts: number): number { return Math.min(3600, 300 * 2 ** Math.min(attempts, 4)) }  // 5min→…→上限 1h
