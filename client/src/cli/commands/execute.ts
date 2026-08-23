import { loadConfig } from '../../config'
import { openDb, createStore, createLocalStorage, downloadAsset, runExecutor, runProbes } from '@yaowu/mde-engine'
import { createGatewayClient } from '../../gateway/client'
import type { ParsedCommand } from '../index'

export async function cmdExecute(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  const cfg = loadConfig(env, {}, { out: cmd.out, concurrency: cmd.concurrency })
  const now = () => Math.floor(Date.now() / 1000)
  const db = openDb(cfg.dbPath); const store = createStore(db)
  const gw = createGatewayClient(cfg, { fetch, now })
  const storage = createLocalStorage(cfg.storageRoot)
  const meetingsById = loadMeetings(db)
  const deps = { store, gw, storage, meetingsById,
    download: (task: any, onProgress: any) => downloadAsset({ storage, gw, onProgress }, task, now) }
  await runProbes(deps as any, now)                                 // 先补探测（延迟资产就绪则入队）
  const r = await runExecutor(deps as any, { concurrency: cfg.concurrency, leaseSec: 900 }, now)
  console.log(`completed=${r.completed} failed=${r.failed} skipped=${r.skipped}`)
  return r.failed > 0 ? 1 : 0
}
function loadMeetings(db: any) {
  const rows = db.query('SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time FROM meetings').all()
  return new Map(rows.map((r: any) => [r.meeting_id, { subject: r.subject, meetingCode: r.meeting_code, startTime: r.start_time, endTime: r.end_time, subMeetingId: r.sub_meeting_id }]))
}
