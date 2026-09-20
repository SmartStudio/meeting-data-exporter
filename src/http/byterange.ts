/**
 * 从本机盘上按 HTTP Range 发文件的两条公共判据：路径防穿越与 Range 头解析。
 *
 * 最早写在 `handlers/console/media.ts`（管理端播放 NAS 上的录像）；2026-09-20 起
 * `GET /api/v1/assets/:assetId/content`（采集程序从网关本地归档下载）也要同一套
 * ——两条端点读的是同一批文件、面对的是同一类客户端（引擎下载器与浏览器播放器
 * 都靠 206 + Content-Range 续传），判据分成两份的后果是某一份修了 416 的边界另一份没修。
 */
import { resolve, sep } from 'node:path'

// ===========================================================================
// 路径防穿越
// ===========================================================================

/**
 * `target` 是否**严格落在** `root` 之内。
 *
 * 三条都不是可有可无的：
 * 1. 两边都先 `resolve`——`..` / 符号链接式的相对段在字符串比较前必须先被折掉。
 * 2. 前缀比较**带分隔符**：`/nas-evil` 与 `/nas` 只差一个字符，纯 `startsWith`
 *    会放它进来。
 * 3. `target === root` 判 false：根目录是目录不是文件，让它通过只会在下一步
 *    换成一个说不清来源的读目录错误。
 *
 * 与 `src/worker/archive.ts` 的 `isUnder` 是同一条判据（那边判「归档资产是不是在
 * 本会议目录内」），只是这里多做一次 `resolve`：那边比较的两个值都是同一次运算
 * 拼出来的，这里有一个来自库。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r) return false
  return t.startsWith(r.endsWith(sep) ? r : r + sep)
}

// ===========================================================================
// Range
// ===========================================================================

/**
 * 一次请求要发的字节区间。
 *
 * - `full`：无 Range、多段 Range、认不出的单位——三种都返回 200 全量（见 console/media.ts 文件头第四条）
 * - `partial`：`[start, end]` **闭区间**，与 `Content-Range` 的语义一致
 * - `unsatisfiable`：416，此时**一个字节都不发**，也不留痕
 */
export type RangeSpec =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

/** `bytes=0-1023` / `bytes=1024-` / `bytes=-500`（后缀，取最后 500 字节） */
const BYTE_RANGE = /^(\d*)-(\d*)$/

export function parseRange(header: string | null, size: number): RangeSpec {
  if (header === null || header.trim() === '') return { kind: 'full' }

  const eq = header.indexOf('=')
  // RFC 7233：认不出的 range unit **必须忽略**（当作没有这个头），不是报错。
  // 报 416 会让一个用了别的单位的中间件把整个播放打死
  if (eq < 0 || header.slice(0, eq).trim().toLowerCase() !== 'bytes') return { kind: 'full' }

  const spec = header.slice(eq + 1).trim()
  // 多段不支持。返回 200 全量比返回一个只含第一段却自称 206 的假响应好
  if (spec.includes(',')) return { kind: 'full' }

  const m = BYTE_RANGE.exec(spec)
  if (m === null) return { kind: 'unsatisfiable' }

  const head = m[1]!
  const tail = m[2]!
  // `bytes=-` 两头都空：既不是区间也不是后缀，说不出要什么
  if (head === '' && tail === '') return { kind: 'unsatisfiable' }

  if (head === '') {
    // 后缀式：取最后 N 字节。mp4 的 moov 在文件尾时播放器真的会这么发，
    // 不支持它的表现是这类文件一秒都播不了
    const n = Number(tail)
    if (!Number.isSafeInteger(n) || n <= 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - n), end: size - 1 }
  }

  const start = Number(head)
  // 起点落在文件之外就是 416：钳到末尾会给出一段调用方没要过的数据
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' }

  // 终点超界**钳到末尾**（RFC 7233 明文允许），不是 416：`bytes=0-99999` 是
  // 播放器要「从这里到能给多少给多少」的常规写法
  const rawEnd = tail === '' ? size - 1 : Number(tail)
  const end = Number.isSafeInteger(rawEnd) ? Math.min(rawEnd, size - 1) : size - 1
  if (end < start) return { kind: 'unsatisfiable' }
  return { kind: 'partial', start, end }
}
