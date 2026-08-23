import { parseAssetKeys, DEFAULT_ASSET_KEYS, type AssetKey } from '@yaowu/mde-engine'

export interface ParsedCommand {
  command: 'run' | 'discover' | 'list' | 'get' | 'execute' | 'status' | 'retry' | 'help'
  from?: number; to?: number; out?: string; concurrency?: number
  code?: string; meetingId?: string; target?: string; assets: AssetKey[]; failed?: boolean
}

function parseDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) { const n = Number(s); if (Number.isFinite(n)) return n; throw new Error(`bad date: ${s}`) }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000
}

export function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) return { command: 'help', assets: DEFAULT_ASSET_KEYS }
  const [command, ...rest] = argv
  const c: ParsedCommand = { command: command as ParsedCommand['command'], assets: DEFAULT_ASSET_KEYS }
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--from') c.from = parseDate(rest[++i]!)
    else if (a === '--to') c.to = parseDate(rest[++i]!)
    else if (a === '--out') c.out = rest[++i]!
    else if (a === '--concurrency') c.concurrency = Number(rest[++i]!)
    else if (a === '--code') c.code = rest[++i]!
    else if (a === '--meeting-id') c.meetingId = rest[++i]!
    else if (a === '--assets') c.assets = parseAssetKeys(rest[++i]!)
    else if (a === '--failed') c.failed = true
    else if (!a.startsWith('--')) positional.push(a)
    else throw new Error(`unknown flag: ${a}`)
  }
  if (positional[0]) c.target = positional[0]
  if (!['run', 'discover', 'list', 'get', 'execute', 'status', 'retry', 'help'].includes(c.command)) c.command = 'help'
  return c
}
