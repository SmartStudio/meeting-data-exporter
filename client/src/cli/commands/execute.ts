import { loadConfig } from '../../config'
import { openDb, createStore, createLocalStorage, downloadAsset, runExecutor, runProbes } from '@yaowu/mde-engine'
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
  const r = await runExecutor(deps, { concurrency: cfg.concurrency, leaseSec: 900 }, now)
  console.log(`completed=${r.completed} failed=${r.failed} skipped=${r.skipped}`)
  return r.failed > 0 ? 1 : 0
}
