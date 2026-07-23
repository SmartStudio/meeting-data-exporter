import { loadConfig } from '../../config'
import { openDb } from '../../store/db'
import { createStore } from '../../store'
import { createGatewayClient } from '../../gateway/client'
import { discover } from '../../discovery'
import type { ParsedCommand } from '../index'
import type { MeetingSelector } from '../../domain/types'

/** discover = 只发现并把资产写入队列（pending/probing），不下载；打印发现摘要 */
export async function cmdDiscover(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  if (cmd.from === undefined || cmd.to === undefined) throw new Error('discover requires --from and --to')
  const cfg = loadConfig(env, {}, { out: cmd.out, concurrency: cmd.concurrency })
  const now = () => Math.floor(Date.now() / 1000)
  const store = createStore(openDb(cfg.dbPath))
  const gw = createGatewayClient(cfg, { fetch, now })

  const sel: MeetingSelector = { kind: 'range', from: cmd.from, to: cmd.to }
  const d = await discover({ gw, store }, sel, cmd.assets, now())
  console.log(`discovered meetings=${d.meetings} tasks=${d.tasks}`)
  return 0
}
