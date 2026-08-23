import { loadConfig } from '../../config'
import { openDb, createStore, createLocalStorage, downloadAsset, discover, runExecutor, runProbes } from '@yaowu/mde-engine'
import { createGatewayClient } from '../../gateway/client'
import type { ParsedCommand } from '../index'
import type { MeetingSelector, DownloadTask } from '@yaowu/mde-engine'

/** get = 按会议号/ID 建选择器（优先 --code/--meeting-id，否则用位置参数按纯数字启发式判定），再 discover + execute */
export async function cmdGet(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  const cfg = loadConfig(env, {}, { out: cmd.out, concurrency: cmd.concurrency })
  const now = () => Math.floor(Date.now() / 1000)
  const db = openDb(cfg.dbPath); const store = createStore(db)
  const gw = createGatewayClient(cfg, { fetch, now })
  const storage = createLocalStorage(cfg.storageRoot)

  const sel = buildSelector(cmd)
  const d = await discover({ gw, store }, sel, cmd.assets, now())
  console.log(`discovered meetings=${d.meetings} tasks=${d.tasks}`)

  const meetingsById = await store.meetingsForPaths()
  const deps = { store, gw, storage, meetingsById,
    download: (task: DownloadTask, onProgress: (b: number) => void) => downloadAsset({ storage, gw, onProgress }, task, now) }
  await runProbes(deps, now)
  const r = await runExecutor(deps, { concurrency: cfg.concurrency, leaseSec: 900 }, now)
  console.log(`completed=${r.completed} failed=${r.failed} skipped=${r.skipped}`)
  return r.failed > 0 ? 1 : 0
}

function buildSelector(cmd: ParsedCommand): MeetingSelector {
  if (cmd.code) return { kind: 'code', meetingCode: cmd.code, from: cmd.from, to: cmd.to }
  if (cmd.meetingId) return { kind: 'id', meetingId: cmd.meetingId, from: cmd.from, to: cmd.to }
  if (cmd.target) {
    // 纯数字视为会议号，否则视为会议 ID
    return /^\d+$/.test(cmd.target)
      ? { kind: 'code', meetingCode: cmd.target, from: cmd.from, to: cmd.to }
      : { kind: 'id', meetingId: cmd.target, from: cmd.from, to: cmd.to }
  }
  throw new Error('get requires --code, --meeting-id, or a positional meeting code/id')
}
