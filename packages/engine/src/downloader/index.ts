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
export interface DownloadDeps {
  storage: Storage; gw: Pick<AssetSource, 'getDownloadUrl'>; onProgress?: (bytes: number) => void
  /** 一次连接的**空闲**超时，默认 `IDLE_TIMEOUT_MS`。语义与取值理由见 `idleGuard` */
  idleTimeoutMs?: number
}

const PROGRESS_INTERVAL = 8 * 1024 * 1024
/**
 * 空闲超时 60 秒：正常下载每秒都有字节到，连续 60 秒一个字节都不来只可能是连接
 * 已经死了。再短会误杀慢速 CDN（首包前的排队、几十 KB/s 的链路都是合法的）。
 */
const IDLE_TIMEOUT_MS = 60_000

export async function downloadAsset(deps: DownloadDeps, task: DownloadTask, _now: () => number): Promise<DownloadResult> {
  const idleMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  try {
    let link = await deps.gw.getDownloadUrl(task.assetId)
    let renewedFor404 = false
    for (let attempt = 0; attempt < 6; attempt++) {
      let size = await deps.storage.writtenSize(task.relPath)
      // 连接/首包也在空闲表内：挂在这里等一个永远不来的响应头，和挂在 read() 上
      // 是同一件事。拿到响应头就停表，下面几条状态分支不读数据，进读循环前再起。
      const guard = idleGuard(idleMs)
      let res: Response
      try { res = await fetchFrom(link.url, size, guard.signal) }
      catch (err) { if (guard.stalled) return stalledResult(idleMs); throw err }
      finally { guard.stop() }

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
      guard.reset()                       // 重新起表：从这一刻起 idleMs 内必须来第一个 chunk
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          guard.reset()                   // 有字节进来 = 连接活着
          await deps.storage.appendChunk(task.relPath, written, value)
          written += value.byteLength; sinceProgress += value.byteLength
          if (sinceProgress >= PROGRESS_INTERVAL) { deps.onProgress?.(written); sinceProgress = 0 }
        }
      } catch (err) {
        // abort 之后 read() 会 reject。认出是空闲超时就走这条可辨认的 failed，
        // 别掉到外层 catch 变成一句含糊的 "The operation was aborted"。
        // 已经落盘的字节留在 .part 里，下一轮按 Range 续传。
        if (guard.stalled) return stalledResult(idleMs)
        throw err
      } finally { guard.stop() }
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

async function fetchFrom(url: string, size: number, signal: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {}
  if (size > 0) headers.range = `bytes=${size}-`
  return fetch(url, { headers, signal })
}

/**
 * 一次连接的**空闲**看门狗：起表后 idleMs 内没有任何字节进来就 `abort()` 这次请求。
 *
 * 为什么是空闲而不是整次下载的总时长：一个几 GB 的录像合法地要下几十分钟，掐总时长
 * 等于把大文件腰斩。而 2026-09-10 本机实测的故障是另一回事——经代理的 TCP 连接静默
 * 挂住 40 分钟，`.part` 不再增长、连接仍 ESTABLISHED、`reader.read()` 永不返回；
 * 租约（900 秒）过期后同一行被另一个并发槽重新领走，两个槽同时写同一个 `.part`。
 * 卡死的那一侧自己不会醒，只能由这块表把它打断。
 *
 * `stalled` 是给调用方分辨用的：abort 之后 fetch / read() 抛出的错误文案含糊
 * （"The operation was aborted"），据此才能返回一条一眼认得出的 failed。
 */
function idleGuard(idleMs: number) {
  const ctl = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => { timer = setTimeout(() => { stalled = true; ctl.abort() }, idleMs) }
  arm()
  return {
    signal: ctl.signal,
    get stalled() { return stalled },
    /** 重新开始计时（收到字节，或进入下一段等待） */
    reset() { if (timer !== undefined) clearTimeout(timer); arm() },
    /** 停表：不停的话这条 setTimeout 会把进程多吊住一个 idleMs */
    stop() { if (timer !== undefined) clearTimeout(timer); timer = undefined },
  }
}
/** 空闲超时统一的返回值；`.part` 保留，下次按 Range 续传 */
function stalledResult(idleMs: number): DownloadResult {
  return { status: 'failed', error: `stalled: no data for ${idleMs / 1000}s` }
}
async function hashFile(storage: Storage, relPath: string): Promise<string> {
  // 文本类小文件：读 .part 全量算 sha256（视频/音频 isText=false，不走这里）
  const buf = await storage.readPart(relPath)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
