import type { Storage } from './types'
import { join, dirname } from 'node:path'
import { mkdir, rename, rm, stat, open } from 'node:fs/promises'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
const statfsAsync = promisify(statfs)

export function createLocalStorage(root: string): Storage {
  const abs = (rel: string) => join(root, rel)
  const part = (rel: string) => abs(rel) + '.part'
  return {
    async writtenSize(rel) { try { return (await stat(part(rel))).size } catch { return 0 } },
    async readPart(rel) { return Bun.file(part(rel)).arrayBuffer() },
    async appendChunk(rel, offset, chunk) {
      await mkdir(dirname(part(rel)), { recursive: true })
      const fh = await open(part(rel), offset === 0 ? 'w' : 'r+')
      try { await fh.write(chunk, 0, chunk.byteLength, offset) } finally { await fh.close() }
      return (await stat(part(rel))).size
    },
    async finalize(rel) { await mkdir(dirname(abs(rel)), { recursive: true }); await rename(part(rel), abs(rel)) },
    async discardPart(rel) { await rm(part(rel), { force: true }) },
    async writeMeta(rel, data) { await mkdir(dirname(abs(rel)), { recursive: true }); await Bun.write(abs(rel), JSON.stringify(data, null, 2)) },
    async readMeta(rel) {
      const f = Bun.file(abs(rel))
      if (!(await f.exists())) return null            // 没有这个文件 ≠ 读不了，见 types.ts
      return JSON.parse(await f.text()) as unknown    // 坏 JSON 原样抛，不静默当成"没有"
    },
    async ensureFreeSpace(bytes) {
      try { const s = await statfsAsync(root); return s.bavail * s.bsize >= bytes } catch { return true } // 取不到时不阻断
    },
  }
}
