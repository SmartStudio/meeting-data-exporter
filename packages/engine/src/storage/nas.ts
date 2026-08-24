import type { Storage } from './types'
import { join, dirname } from 'node:path'
import { mkdir, rename, rm, stat, open } from 'node:fs/promises'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
import { withFsTimeout } from './fs-timeout'
const statfsAsync = promisify(statfs)

/** NAS 挂载点的 fs 调用超时。5s 对本地盘/健康 NAS 都宽到离谱，只在真挂住时触发。 */
const NAS_TIMEOUT_MS = 5_000

export function createNasStorage(root: string, timeoutMs: number = NAS_TIMEOUT_MS): Storage {
  const abs = (rel: string) => join(root, rel)
  const part = (rel: string) => abs(rel) + '.part'
  const wrap = <T>(p: Promise<T>, what: string) => withFsTimeout(p, what, timeoutMs)
  return {
    async writtenSize(rel) {
      try { return (await wrap(stat(part(rel)), `stat(${part(rel)})`)).size }
      catch (err) {
        if (err instanceof Error && err.name === 'FsTimeoutError') throw err
        return 0
      }
    },
    async readPart(rel) { return wrap(Bun.file(part(rel)).arrayBuffer(), `readPart(${part(rel)})`) },
    async appendChunk(rel, offset, chunk) {
      await wrap(mkdir(dirname(part(rel)), { recursive: true }), `mkdir(${dirname(part(rel))})`)
      const fh = await wrap(open(part(rel), offset === 0 ? 'w' : 'r+'), `open(${part(rel)})`)
      try { await wrap(fh.write(chunk, 0, chunk.byteLength, offset), `write(${part(rel)})`) }
      finally { await fh.close() }
      return (await wrap(stat(part(rel)), `stat(${part(rel)})`)).size
    },
    async finalize(rel) {
      await wrap(mkdir(dirname(abs(rel)), { recursive: true }), `mkdir(${dirname(abs(rel))})`)
      await wrap(rename(part(rel), abs(rel)), `rename(${part(rel)})`)
    },
    async discardPart(rel) { await wrap(rm(part(rel), { force: true }), `rm(${part(rel)})`) },
    async writeMeta(rel, data) {
      await wrap(mkdir(dirname(abs(rel)), { recursive: true }), `mkdir(${dirname(abs(rel))})`)
      await wrap(Bun.write(abs(rel), JSON.stringify(data, null, 2)), `write(${abs(rel)})`)
    },
    async ensureFreeSpace(bytes) {
      try {
        const s = await wrap(statfsAsync(root), `statfs(${root})`)
        return s.bavail * s.bsize >= bytes
      } catch (err) {
        if (err instanceof Error && err.name === 'FsTimeoutError') throw err
        return true // 取不到时不阻断，与 local.ts 一致
      }
    },
  }
}
