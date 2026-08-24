/**
 * NAS 连通性与容量的**运行期、可重复调用**探测，供控制台"归档存储"页展示连通
 * 状态与容量占比（spec.md §4.9）。
 *
 * 与同目录 `index.ts` 里的 `assertArchiveRootUsable` 是两个语义不同的函数，
 * 不要混用：那个是 worker **启动期**的硬校验，失败即抛异常、拒绝整个进程启动。
 * 这里探测失败时**返回**一个描述原因的结果对象——调用它的 HTTP handler 不能
 * 因为一次 NAS 探测失败就让整个请求跟着报 500，控制台要展示的恰恰是"探测到了
 * NAS 不可达"这件事本身，而不是把这件事变成一个异常再兜底成别的错误页。
 */
import { stat, writeFile, rm } from 'node:fs/promises'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { withFsTimeout, FsTimeoutError } from '@yaowu/mde-engine'

const statfsAsync = promisify(statfs)

/** 5s 对本地盘/健康 NAS 都宽到离谱，只在真挂住时触发——与 nas.ts 的 NAS_TIMEOUT_MS 同口径。 */
const PROBE_TIMEOUT_MS = 5_000

export interface NasProbeResult {
  reachable: boolean
  checkedAt: number
  /** 探测耗时（ms）。超时/失败时为触发失败前实际耗费的时间，非 null。 */
  latencyMs: number
  totalBytes: number | null
  availableBytes: number | null
  /** reachable=false 时的人类可读原因；reachable=true 时为 null */
  error: string | null
}

/**
 * now 取函数是为了让测试能控制 checkedAt，不是为了别的——探测本身不依赖时钟推进
 * （latencyMs 的计时用的是真实的 Date.now()，与注入的 now() 无关）。
 */
export async function probeNas(
  root: string,
  now: () => number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<NasProbeResult> {
  const startedAt = Date.now()
  const fail = (error: string): NasProbeResult => ({
    reachable: false,
    checkedAt: now(),
    latencyMs: Date.now() - startedAt,
    totalBytes: null,
    availableBytes: null,
    error,
  })

  try {
    // stat 也要包超时：挂死的网络挂载上它和 writeFile 一样会挂住。
    const st = await withFsTimeout(stat(root), `stat(${root})`, timeoutMs)
    if (!st.isDirectory()) return fail(`not a directory: ${root}`)

    // 探针文件名带 pid，避免多实例互踩；只探连通性，不留垃圾。
    const probePath = join(root, `.mde-nas-probe-${process.pid}`)
    try {
      await withFsTimeout(writeFile(probePath, ''), `write probe in ${root}`, timeoutMs)
    } finally {
      // 清理是尽力而为：它自己也可能在挂死的挂载上超时，而一个从 finally 里抛出的
      // 次生错误会盖掉上面写探针那一步的真正根因（与 assertArchiveRootUsable 同一取舍）。
      await withFsTimeout(rm(probePath, { force: true }), `cleanup probe in ${root}`, timeoutMs).catch(() => {})
    }

    const space = await withFsTimeout(statfsAsync(root), `statfs(${root})`, timeoutMs)
    return {
      reachable: true,
      checkedAt: now(),
      latencyMs: Date.now() - startedAt,
      totalBytes: space.blocks * space.bsize,
      availableBytes: space.bavail * space.bsize,
      error: null,
    }
  } catch (err) {
    // 超时与其他 fs 错误都归一到同一个"探测失败"结果里——调用方（控制台"归档存储"页）
    // 只关心"能不能连上"，不需要在 UI 上分叉处理这两类原因；但错误文案本身仍然
    // 分开来源（FsTimeoutError 的消息已经自带"timed out after Nms"字样），
    // 值班的人从 error 字段就能看出是挂住了还是权限/路径错了。
    if (err instanceof FsTimeoutError) return fail(err.message)
    return fail(err instanceof Error ? err.message : String(err))
  }
}
