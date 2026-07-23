export interface AppConfig {
  gatewayUrl: string
  clientId: string
  clientSecret: string
  storageRoot: string
  concurrency: number
  dbPath: string
}
export interface FileConfig { storageRoot?: string; concurrency?: number; dbPath?: string }
export interface CliOverrides { out?: string; concurrency?: number }

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key]
  if (v === undefined || v === '') throw new Error(`missing required env: ${key}`)
  return v
}

export function loadConfig(
  env: Record<string, string | undefined>,
  fileCfg: Partial<FileConfig>,
  flags: Partial<CliOverrides>,
): AppConfig {
  const gatewayUrl = required(env, 'MDE_GATEWAY_URL')
  const clientId = required(env, 'MDE_CLIENT_ID')
  const clientSecret = required(env, 'MDE_CLIENT_SECRET')

  const concurrency = flags.concurrency ?? fileCfg.concurrency ?? 3
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer')
  }

  const storageRoot = flags.out ?? fileCfg.storageRoot
  if (!storageRoot) throw new Error('missing storageRoot: pass --out or set storageRoot in config file')

  const dbPath = fileCfg.dbPath ?? `${storageRoot}/.mde/queue.sqlite`
  return { gatewayUrl, clientId, clientSecret, storageRoot, concurrency, dbPath }
}
