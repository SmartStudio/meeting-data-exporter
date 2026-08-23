import { loadConfig } from '../../config'
import { openDb, createStore } from '@yaowu/mde-engine'
import type { ParsedCommand } from '../index'

/** retry = store.resetFailed(now()) 把 failed/dead 重置回 pending 以便下次 execute 拾取；只报重置数，不在此处顺带排空 */
export async function cmdRetry(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  const cfg = loadConfig(env, {}, { out: cmd.out })
  const now = () => Math.floor(Date.now() / 1000)
  const store = createStore(openDb(cfg.dbPath))
  const n = store.resetFailed(now())
  console.log(`reset=${n}`)
  return 0
}
