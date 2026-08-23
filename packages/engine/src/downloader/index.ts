import type { Storage } from '../storage/types'
import type { GatewayClient } from '../gateway/client'

export interface DownloadTask { assetId: string; relPath: string; bytesExpected: number | null; isText: boolean }
export type DownloadResult = { status: 'completed'; contentHash: string | null } | { status: 'failed'; error: string }
export interface DownloadDeps { storage: Storage; gw: Pick<GatewayClient, 'getDownloadUrl'>; onProgress?: (bytes: number) => void }

const PROGRESS_INTERVAL = 8 * 1024 * 1024

export async function downloadAsset(deps: DownloadDeps, task: DownloadTask, _now: () => number): Promise<DownloadResult> {
  try {
    let link = await deps.gw.getDownloadUrl(task.assetId)
    for (let attempt = 0; attempt < 6; attempt++) {
      let size = await deps.storage.writtenSize(task.relPath)
      const res = await fetchFrom(link.url, size)

      if (res.status === 416) { await deps.storage.discardPart(task.relPath); size = 0; link = await deps.gw.getDownloadUrl(task.assetId); continue }
      if (res.status === 403 || res.status === 410) { link = await deps.gw.getDownloadUrl(task.assetId); continue }  // 链接过期换新，size 保留续传
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
      // 完成校验
      if (task.bytesExpected != null && written !== task.bytesExpected) return { status: 'failed', error: `size mismatch: ${written} != ${task.bytesExpected}` }
      const hash = task.isText ? await hashFile(deps.storage, task.relPath) : null
      await deps.storage.finalize(task.relPath)
      return { status: 'completed', contentHash: hash }
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
