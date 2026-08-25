export interface AppConfig {
  gatewayUrl: string
  clientId: string
  clientSecret: string
  storageRoot: string
  concurrency: number
  /**
   * 租约时长（秒）。默认 900，与 worker 的 `LEASE_SEC` 一致。
   *
   * 租约的意义是「这个任务还有人在干」：`claimNext` / `touchProgress` 写进
   * `lease_expires_at` 的是 `now() + leaseSec`，过期的任务会被别的执行体重新领走。
   *
   * **调小它是危险的。** 一轮下载跑得比 leaseSec 久（几个 GB 的录制很正常），
   * 别的实例一看租约过期就把还在下载中的任务抢走，两个进程同时写同一个 `.part`。
   * 900 秒这个默认值是按「最大的资产在健康链路上下完」留的余量。
   *
   * 之所以做成可配，是因为「崩溃恢复」这条机制**只能靠等租约过期来验**——
   * 硬编码 900 意味着每验一次要干等 15 分钟，而这正是它至今没被真实验证过的
   * 原因之一（见 docs/m3.5-stage8-9-plan.md §4.4）。核验时设成 10 秒，
   * 平时不要设。
   */
  leaseSec: number
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

  // 上限 86400：写错一个数量级（900000）会让过期的任务在十天里都不被重领，
  // 表现为「归档静默停滞」，而那正是租约要防的那个现象本身
  const leaseSec = Number(env.MDE_LEASE_SEC ?? 900)
  if (!Number.isInteger(leaseSec) || leaseSec < 1 || leaseSec > 86400) {
    throw new Error('MDE_LEASE_SEC must be an integer between 1 and 86400')
  }

  const storageRoot = flags.out ?? fileCfg.storageRoot
  if (!storageRoot) throw new Error('missing storageRoot: pass --out or set storageRoot in config file')

  const dbPath = fileCfg.dbPath ?? `${storageRoot}/.mde/queue.sqlite`
  return { gatewayUrl, clientId, clientSecret, storageRoot, concurrency, leaseSec, dbPath }
}
