import { loadConfig } from '../../config'
import { openDb, createStore, createLocalStorage, downloadAsset, runExecutor, runProbes, writeMeetingManifests } from '@yaowu/mde-engine'
import { createGatewayClient } from '../../gateway/client'
import type { ParsedCommand } from '../index'
import type { DownloadTask } from '@yaowu/mde-engine'

export async function cmdExecute(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  const cfg = loadConfig(env, {}, { out: cmd.out, concurrency: cmd.concurrency })
  const now = () => Math.floor(Date.now() / 1000)
  const db = openDb(cfg.dbPath); const store = createStore(db)
  const gw = createGatewayClient(cfg, { fetch, now })
  const storage = createLocalStorage(cfg.storageRoot)
  const meetingsById = await store.meetingsForPaths()
  const deps = { store, gw, storage, meetingsById,
    download: (task: DownloadTask, onProgress: (b: number) => void) => downloadAsset({ storage, gw, onProgress }, task, now) }
  await runProbes(deps, now)                                 // 先补探测（延迟资产就绪则入队）
  const r = await runExecutor(deps, { concurrency: cfg.concurrency, leaseSec: cfg.leaseSec }, now)
  console.log(`completed=${r.completed} failed=${r.failed} skipped=${r.skipped}`)
  // execute 与 run 一样是完整的一轮（补探测 + 排空队列），收尾同样要写 sidecar：
  // 大量的实际用法是先 discover 再反复 execute，只在 run 里接会让那条路径永远没有清单。
  const man = await writeMeetingManifests({ store, storage, generatedBy: 'mde-engine' }, meetingsById, now)
  console.log(`manifests written=${man.written} skipped=${man.skipped} failed=${man.failed}`)
  return r.failed > 0 ? 1 : 0
}
