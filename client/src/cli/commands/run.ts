import { loadConfig } from '../../config'
import { openDb } from '../../store/db'
import { createStore } from '../../store'
import { createGatewayClient } from '../../gateway/client'
import { createLocalStorage } from '../../storage/local'
import { downloadAsset } from '../../downloader'
import { discover } from '../../discovery'
import { runExecutor, runProbes } from '../../executor'
import type { ParsedCommand } from '../index'
import type { MeetingSelector } from '../../domain/types'

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
  const meetingsById = loadMeetings(db)
  const deps = { store, gw, storage, meetingsById,
    download: (task: any, onProgress: any) => downloadAsset({ storage, gw, onProgress }, task, now) }
  await runProbes(deps as any, now)
  const r = await runExecutor(deps as any, { concurrency: cfg.concurrency, leaseSec: 900 }, now)
  console.log(`completed=${r.completed} failed=${r.failed} skipped=${r.skipped}`)
  return r.failed > 0 ? 1 : 0
}
function loadMeetings(db: any) {
  const rows = db.query('SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time FROM meetings').all()
  return new Map(rows.map((r: any) => [r.meeting_id, { subject: r.subject, meetingCode: r.meeting_code, startTime: r.start_time, endTime: r.end_time, subMeetingId: r.sub_meeting_id }]))
}
