import type { MeetingPathRow, Store, AssetRow } from '../store'
import type { DownloadResult, DownloadTask } from '../downloader'
import type { Storage } from '../storage/types'
import type { AssetSource } from '../source/types'
import { GATEWAY_TYPE_TO_ASSET_KEY, assetKeyToFilename, isTextAssetType, ASSET_WAIT_CAP_SEC, meetingPathKey } from '../domain/types'
import { meetingDirPath } from '../domain/filename'
import { judgeReadiness } from '../domain/readiness'
import { isSiblingAbsent } from '../domain/sibling'

export interface ExecutorDeps {
  store: Store
  download: (task: DownloadTask, onProgress: (b: number) => void) => Promise<DownloadResult>
  storage: Pick<Storage, 'ensureFreeSpace' | 'writeMeta'>
  gw: Pick<AssetSource, 'listAssets'>
  /**
   * `Store.meetingsForPaths()` 的返回值，键是 `meetingPathKey(meeting_id, sub_meeting_id)`。
   * 字段名不叫 meetingsById 了——键不再是 meeting_id，叫那个名字会让下一个读代码的人
   * 按 `get(row.meeting_id)` 写，而那句在周期会议上永远查不到、静默把资产判成
   * meeting_meta_missing。
   */
  meetingsByPathKey: Map<string, MeetingPathRow>
}
const MAX_ATTEMPTS = 5

export async function runExecutor(deps: ExecutorDeps, opts: { concurrency: number; leaseSec: number }, now: () => number) {
  // `lost`：写回时发现租约已经不在自己手里的次数（行被别人重新领走了，见
  // Store 的 `claimedAttempts`）。它既不是 completed 也不是 failed——这一轮对这条
  // 资产什么都没写成，结论由重新领走它的那一次给出。稳态下应当恒为 0，不为 0 就是
  // 有执行体卡过一次租约。
  const result = { completed: 0, failed: 0, skipped: 0, lost: 0 }
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

async function handleOne(deps: ExecutorDeps, row: AssetRow, leaseSec: number, now: () => number, result: { completed: number; failed: number; skipped: number; lost: number }) {
  // 每一次写回都带上这次领取的 attempts 当栅栏令牌，返回 false = 租约已经不在自己
  // 手里（过期后被别人重领），这一行现在归别人管，我们连计数都不该计（见下面的 lost）。
  const claimed = row.attempts
  /** 写回落空：留一条认得出的日志（谁、第几次领取），并计入 result.lost */
  const lost = (what: string) => {
    console.warn(`lease lost: asset id=${row.id} attempts=${claimed} 的 ${what} 写回落空——该行已被重新领取，本次不再改动它`)
    result.lost++
  }
  const relPath = await buildRelPath(deps, row)
  if (relPath === null) {
    if (!(await deps.store.markSkipped(row.id, 'meeting_meta_missing', now(), claimed))) return lost('meeting_meta_missing')
    result.skipped++; return
  }
  if (row.bytes_expected != null && !(await deps.storage.ensureFreeSpace(row.bytes_expected))) {
    if (!(await deps.store.markSkipped(row.id, 'disk_full', now(), claimed))) return lost('disk_full')
    result.skipped++; return
  }
  await deps.store.setTargetPath(row.id, relPath, row.file_type, now())

  const isText = isTextAssetType(row.asset_type)
  // 进度回写是尽力而为：写库失败不中断下载，但必须留下痕迹（不能用静默的 .catch(() => {})）。
  // 返回 false（租约已被别人领走）时**不续租**也不吵闹：它本来就是尽力而为的一次
  // 检查点，真正的结论由下载结束后那次写回给出，那里会把它记成 lost。
  const res = await deps.download({ assetId: row.asset_id ?? assetId(row), relPath, bytesExpected: row.bytes_expected, isText }, (b) => {
    deps.store.touchProgress(row.id, b, now(), leaseSec, claimed).catch((e) => console.warn(`progress write failed: ${e}`))
  })
  // markCompleted 顺手把 downloader 报回的真实字节数落库：平台常常不给 bytes_expected，
  // 那时这就是「这个文件多大」唯一的事实来源（见 domain/manifest.ts 的 bytes 字段注释）
  if (res.status === 'completed') {
    if (!(await deps.store.markCompleted(row.id, res.contentHash, res.bytesWritten, now(), claimed))) return lost('completed')
    result.completed++; return
  }
  // 平台确认没有这个文件（下载器换过一条新链仍 404）：重试是在等一个不会到来的
  // 修复，而五次之后那条 dead 行会永远挂在「失败项 · 需要处理」上。skipped 是
  // 「确认取不到」，清单里说得出为什么，也不计入归档判定。
  if (res.permanent === true) {
    if (!(await deps.store.markSkipped(row.id, 'upstream_missing', now(), claimed))) return lost('upstream_missing')
    result.skipped++; return
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    if (!(await deps.store.markDead(row.id, res.error, now(), claimed))) return lost('dead')
    result.failed++; return
  }
  // `row.attempts` 是**这一次**领取之后的值（claimNext 领的时候就 +1 了），所以
  // 第一次失败传进 downloadBackoff 的是 1，等 5 分钟。退避时间由这里算、store 只写，
  // 理由见 Store.markFailed。
  const at = now()
  if (!(await deps.store.markFailed(row.id, res.error, at, at + downloadBackoff(row.attempts), claimed))) return lost('failed')
  result.failed++
}

/**
 * 相对路径：<year>/<month>/<清洗目录>/<资产文件名>
 *
 * 目录那一段走 `meetingDirPath`，与同目录下的 meeting.json / _manifest.json
 * （manifest/index.ts）共用同一份计算——这两处一旦各算一遍，sidecar 就会落到
 * 一个没有资产的目录里去。
 */
async function buildRelPath(deps: ExecutorDeps, row: AssetRow): Promise<string | null> {
  // 按两段键查：周期会议各场次共享 meeting_id，只按它查会拿到别的场次的 start_time，
  // 于是这一场的文件落进另一场的目录
  const m = deps.meetingsByPathKey.get(meetingPathKey(row.meeting_id, row.sub_meeting_id))
  if (!m) return null
  const key = GATEWAY_TYPE_TO_ASSET_KEY[row.asset_type] ?? (row.asset_type as any)
  const { ordinal } = await deps.store.siblingRank(row)
  const fname = assetKeyToFilename(key, row.remote_id, row.file_type, ordinal)  // 归一化与空值回落都在 assetKeyToFilename 里
  // 第三个参数是目录序号：同一分钟的第二条录制记录目录名带 _2，否则两场会议的
  // transcript.txt 互相覆盖（见 domain/dir-ordinal.ts）。序号在 meetingsForPaths
  // 里算好随行带来，这里不重算。
  return `${meetingDirPath(m, row.meeting_id, m.dirOrdinal)}/${fname}`
}
function assetId(row: AssetRow): string { return `${row.meeting_id}:${row.remote_id}:${row.asset_type}:0` }

/** 探测循环：重查到期 probing 资产，就绪则补建任务、超时则 abandon */
export async function runProbes(deps: ExecutorDeps & { store: Store }, now: () => number) {
  const out = { resolved: 0, abandoned: 0, newTasks: 0 }
  for (const p of await deps.store.dueProbes(now())) {
    // 探测行本来就是按 (meeting_id, sub_meeting_id, asset_type) 存的，反查时把场次
    // 一起带上——不带的话一条探测行会被同 meeting_id 别的场次的资产判成「就绪」
    const assets = await deps.gw.listAssets(p.meeting_id, p.sub_meeting_id)
    const a = assets.find((x) => x.assetType === p.asset_type)
    const verdict = judgeReadiness({ present: !!a, state: a?.state, allowDownload: a?.allowDownload, now: now(), deadlineAt: p.deadline_at })
    // p 来自 dueProbes()，形状为 ProbeRow（snake_case: meeting_id/sub_meeting_id/asset_type），
    // 而 resolveProbe/abandonProbe/bumpProbe 接受的是 ProbeKey（camelCase）——显式建 key 适配，避免形状不一致
    const key = { meetingId: p.meeting_id, subMeetingId: p.sub_meeting_id, assetType: p.asset_type }
    // 同源产物：video 已就绪而 audio 缺席 → 音频根本没生成，再探到 deadline 也只会
    // 换来一个假的 upstream_timeout（见 domain/sibling.ts）。存量探测行由这里收口——
    // discovery 只在它下一次扫到这场会议时才走同一条规则，而老的探测行等不到那一次。
    if (isSiblingAbsent(p.asset_type, assets)) { await deps.store.abandonProbe(key, 'not_generated'); out.abandoned++; continue }
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
