import { loadConfig } from '../../config'
import { warnIfLeaseLocked } from '../lease-hint'
import { openDb, createStore, createLocalStorage, downloadAsset, discover, runExecutor, runProbes, writeMeetingManifests } from '@yaowu/mde-engine'
import { createGatewayClient } from '../../gateway/client'
import type { ParsedCommand } from '../index'
import type { MeetingSelector, DownloadTask } from '@yaowu/mde-engine'

/** run = discover（按 --from/--to 时间范围）+ execute（紧接着排空队列） */
export async function cmdRun(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  if (cmd.from === undefined || cmd.to === undefined) throw new Error('run requires --from and --to')
  const cfg = loadConfig(env, {}, { out: cmd.out, concurrency: cmd.concurrency })
  const now = () => Math.floor(Date.now() / 1000)
  const db = openDb(cfg.dbPath); const store = createStore(db)
  const gw = createGatewayClient(cfg, { fetch, now })
  const storage = createLocalStorage(cfg.storageRoot)

  const sel: MeetingSelector = { kind: 'range', from: cmd.from, to: cmd.to }
  const d = await discover({ gw, store }, sel, cmd.assets, now())
  console.log(`discovered meetings=${d.meetings} tasks=${d.tasks}`)

  // 发现之后才能建 meetingsById（拿到刚写入的会议元数据用于拼路径）
  const meetingsById = await store.meetingsForPaths()
  const deps = { store, gw, storage, meetingsById,
    download: (task: DownloadTask, onProgress: (b: number) => void) => downloadAsset({ storage, gw, onProgress }, task, now) }
  await runProbes(deps, now)
  const r = await runExecutor(deps, { concurrency: cfg.concurrency, leaseSec: cfg.leaseSec }, now)
  console.log(`completed=${r.completed} failed=${r.failed} skipped=${r.skipped}`)
  await warnIfLeaseLocked(store, r, cfg.leaseSec)
  // 一轮的收尾：给每场会议写 meeting.json / _manifest.json（US-6.2）。写失败只 warn 不改
  // 退出码——文件已经在盘上了，一份没写出来的清单不该把一轮成功的下载判成失败。
  const man = await writeMeetingManifests({ store, storage, generatedBy: 'mde-engine' }, meetingsById, now)
  console.log(`manifests written=${man.written} skipped=${man.skipped} failed=${man.failed}`)
  return r.failed > 0 ? 1 : 0
}
