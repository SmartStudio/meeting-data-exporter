#!/usr/bin/env bun
import { parseArgs } from '../src/cli'
import { cmdRun } from '../src/cli/commands/run'
import { cmdDiscover } from '../src/cli/commands/discover'
import { cmdList } from '../src/cli/commands/list'
import { cmdGet } from '../src/cli/commands/get'
import { cmdExecute } from '../src/cli/commands/execute'
import { cmdStatus } from '../src/cli/commands/status'
import { cmdRetry } from '../src/cli/commands/retry'
const argv = process.argv.slice(2)
try {
  const cmd = parseArgs(argv)
  const env = process.env
  const dispatch: Record<string, (c: any, e: any) => Promise<number>> = {
    execute: cmdExecute, status: cmdStatus, run: cmdRun, discover: cmdDiscover, list: cmdList, get: cmdGet, retry: cmdRetry,
    help: async () => { console.log('mde <run|discover|list|get|execute|status|retry> [flags]'); return 0 },
  }
  const fn = dispatch[cmd.command] ?? dispatch.help!
  process.exit(await fn(cmd, env))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
