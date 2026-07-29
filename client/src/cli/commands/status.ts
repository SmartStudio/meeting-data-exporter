import { loadConfig } from '../../config'
import { openDb } from '../../store/db'
import { createStore } from '../../store'
import type { ParsedCommand } from '../index'

export async function cmdStatus(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  const cfg = loadConfig(env, {}, { out: cmd.out })
  const store = createStore(openDb(cfg.dbPath))
  const c = store.counts()
  console.log(`pending=${c.pending} running=${c.running} completed=${c.completed} failed=${c.failed} skipped=${c.skipped} dead=${c.dead}`)
  for (const f of store.failures()) console.log(`  [${f.status}] ${f.meeting_id} ${f.asset_type} ${f.remote_id}: ${f.last_error ?? ''}`)
  return 0
}
