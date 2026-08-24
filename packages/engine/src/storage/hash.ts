import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

/**
 * 文件内容的 sha256（十六进制）。
 *
 * 流式读取，不用 arrayBuffer() 一次性载入内存——录像资产可以有几个 GB，
 * 一次性读入会把归档 / 清理 worker 的内存打爆。
 *
 * 为什么放在 packages/engine/src/storage/ 而不是各 worker 里各写一份：
 * 这个函数的两个调用点（src/worker/archive.ts 归档时算、src/worker/retention.ts
 * 删除前重算）是本系统那条归档安全性质的两端——"归档时写下的哈希，必须与到期删除
 * 前重新算出的哈希一致"。两份"逐字相同"的实现意味着只改其中一份就能让这条性质
 * 悄悄失效（比如某天有人把一边换成别的摘要算法或改了读取方式），而且不会有任何
 * 测试报警：两边各自的用例都会照旧通过。所以它只能有一份，和 withFsTimeout
 * 一样放在两边都已经依赖的 engine 包里。
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
