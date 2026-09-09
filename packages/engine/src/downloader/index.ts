import type { Storage } from '../storage/types'
import type { AssetSource } from '../source/types'

export interface DownloadTask { assetId: string; relPath: string; bytesExpected: number | null; isText: boolean }
/**
 * `bytesWritten` 是**盘上那个文件的真实字节数**，不是进度检查点：它是逐 chunk 累加
 * 出来的，且刚刚通过了下面 `written !== bytesExpected → failed` 那道校验。
 *
 * 为什么非要把它带出去：真实环境里平台**不返回 `bytes_expected`**（2026-08-26 联调
 * 实测，见 docs/m3.5-stage8-9-plan.md §0.1 第 2 条），而进度回调每 8MB 才触发一次、
 * 结束时不补最后一次。也就是说「这个文件多大」这个事实，全流程只有这里知道；
 * 这里不交出去，它就随着这个函数返回而永久消失，清单里的 bytes 只能是 null。
 */
export type DownloadResult =
  | { status: 'completed'; contentHash: string | null; bytesWritten: number }
  /**
   * `permanent` = **平台确认没有这个文件**，不是「这次没成」。只有 404 走到这里
   * （换过一条新链接仍然 404）。执行器据此把资产判成 `skipped/upstream_missing`，
   * 不走退避、不进 dead——重试五次拿到的是同一个 404，而那五次之后留下的
   * 一条 dead 行会永远挂在「失败项 · 需要处理」上，等一个不存在的修复。
   */
  | { status: 'failed'; error: string; permanent?: true }
export interface DownloadDeps { storage: Storage; gw: Pick<AssetSource, 'getDownloadUrl'>; onProgress?: (bytes: number) => void }

const PROGRESS_INTERVAL = 8 * 1024 * 1024

export async function downloadAsset(deps: DownloadDeps, task: DownloadTask, _now: () => number): Promise<DownloadResult> {
  try {
    let link = await deps.gw.getDownloadUrl(task.assetId)
    let renewedFor404 = false
    for (let attempt = 0; attempt < 6; attempt++) {
      let size = await deps.storage.writtenSize(task.relPath)
      const res = await fetchFrom(link.url, size)

      if (res.status === 416) { await deps.storage.discardPart(task.relPath); size = 0; link = await deps.gw.getDownloadUrl(task.assetId); continue }
      if (res.status === 403 || res.status === 410) { link = await deps.gw.getDownloadUrl(task.assetId); continue }  // 链接过期换新，size 保留续传
      // 404 与 403/410 走同一条换链路径，但**不保留 size**：换回来的新链接可能
      // 指向另一份文件，拿旧的 .part 续传会拼出一个坏文件。只换一次——第二次
      // 仍 404 就是平台的事实，再换五次也是同一个答案。
      // （size 不必手动清零：循环顶部每一轮都重新 writtenSize。）
      if (res.status === 404) {
        if (renewedFor404) return { status: 'failed', error: 'http 404', permanent: true }
        renewedFor404 = true
        await deps.storage.discardPart(task.relPath)
        link = await deps.gw.getDownloadUrl(task.assetId)
        continue
      }
      if (res.status === 200 && size > 0) { await deps.storage.discardPart(task.relPath); size = 0 }                 // 不支持 Range，丢弃重下
      if (res.status !== 200 && res.status !== 206) { if (res.status >= 500) { link = await deps.gw.getDownloadUrl(task.assetId); continue } return { status: 'failed', error: `http ${res.status}` } }

      // 流式写入 .part，每 8MB 回调进度
      const reader = res.body!.getReader()
      let written = size, sinceProgress = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await deps.storage.appendChunk(task.relPath, written, value)
        written += value.byteLength; sinceProgress += value.byteLength
        if (sinceProgress >= PROGRESS_INTERVAL) { deps.onProgress?.(written); sinceProgress = 0 }
      }
      // 空正文（200、content-length 0）一个 chunk 都不来，.part 从未建出来；下面的
      // hashFile / finalize 都以它存在为前提，会以 ENOENT 失败、重试 5 次后 dead。
      // 平台就是给了个空文件（2026-09-09 实测「转写_」录制的逐字稿 txt），落 0 字节。
      if (written === 0) await deps.storage.appendChunk(task.relPath, 0, new Uint8Array(0))
      // 完成校验
      if (task.bytesExpected != null && written !== task.bytesExpected) return { status: 'failed', error: `size mismatch: ${written} != ${task.bytesExpected}` }
      const hash = task.isText ? await hashFile(deps.storage, task.relPath) : null
      await deps.storage.finalize(task.relPath)
      return { status: 'completed', contentHash: hash, bytesWritten: written }
    }
    return { status: 'failed', error: 'too many link renewals' }
  } catch (err) { return { status: 'failed', error: err instanceof Error ? err.message : String(err) } }
}

async function fetchFrom(url: string, size: number): Promise<Response> {
  const headers: Record<string, string> = {}
  if (size > 0) headers.range = `bytes=${size}-`
  return fetch(url, { headers })
}
async function hashFile(storage: Storage, relPath: string): Promise<string> {
  // 文本类小文件：读 .part 全量算 sha256（视频/音频 isText=false，不走这里）
  const buf = await storage.readPart(relPath)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
