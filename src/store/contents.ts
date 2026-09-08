import { createHash } from 'node:crypto'
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import type { RowDataPacket } from 'mysql2'
import {
  ALL_ASSET_KEYS,
  ASSET_KEY_TO_GATEWAY_TYPE,
  isTextAssetType,
  normalizeExtension,
  withFsTimeout,
} from '@yaowu/mde-engine'
import type { Pool } from './db'

/**
 * `asset_contents` 的读写（阶段 4 · T4，A6 的写侧）。表的语义、主键为什么是五段、
 * 三个 status 各自什么意思，全部写在 `migrations/007_asset_contents.sql` 的表头,
 * 那里是唯一的权威说明，本文件不复述。
 *
 * 这张表与 `archived_assets` 的关系：**本文件只 SELECT archived_assets，一列都不写**
 * （与 `ArchivesStore` 对 `meeting_assets` 的态度相同）。`listPending` 需要它是因为
 * 「哪些资产已经在 NAS 上、却还没入过正文」这个问题的答案只存在于两张表的差集里。
 */

/**
 * MEDIUMTEXT 能装的最大字节数（2^24 - 1）。
 *
 * 超过就**明确拒绝并留痕**，不截断——截断过的纪要在预览页上看起来是完整的，
 * 读的人不会知道后半截没了。计划 §3 T4 验收判据 3。
 */
export const MEDIUMTEXT_MAX_BYTES = 16 * 1024 * 1024 - 1

/** 读一份 NAS 上的文本资产的超时。文本类资产都很小，这个值是「挂载挂住了」的探测器，
 *  与 `src/worker/archive.ts` 的 NAS_WRITE_TIMEOUT_MS 同一种用途、但小得多——
 *  那个值要覆盖几个 GB 的录像整份复制，这里最大也就 16MB。 */
const NAS_READ_TIMEOUT_MS = 60_000

/**
 * 会入库的 `asset_type` 取值——四类正文（逐字稿两种 + 纪要 + 时间轴）。
 *
 * **从引擎的 `ALL_ASSET_KEYS` 派生，不在这里抄一份短名**：资产键的权威定义在
 * `packages/engine/src/domain/types.ts`，抄一份的下场是新增纪要引擎时两处不同步,
 * 而不同步的表现是「新纪要类型的正文悄悄不入库」——预览页查无此物，没有任何报错。
 *
 * 存进库的是**网关的 asset_type**（`meeting_assets.asset_type` 那一列的原值），
 * 不是客户端的 `AssetKey`：两者只有 transcript / ai_transcript 两项不同名，
 * 而这种部分重合恰好是引擎那份注释记着的一次真实故障。
 */
export const TEXT_GATEWAY_ASSET_TYPES: readonly string[] = ALL_ASSET_KEYS
  .map((k) => ASSET_KEY_TO_GATEWAY_TYPE[k])
  .filter((t) => isTextAssetType(t))

/** 能被当纯文本入库的扩展名。docx / pdf 不是纯文本，装解析器是另一件事（计划 §3 T4 的「坑」） */
const PARSABLE_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'md', 'json'])

export type AssetContentStatus = 'parsed' | 'unsupported_format' | 'too_large'

/** 与 `archived_assets` 逐列对齐的五段自然键（为什么是五段：见 007 的表头） */
export interface AssetContentKey {
  meetingId: string
  subMeetingId: string
  assetType: string
  remoteId: string
  fileType: string
}

export interface AssetContentRecord extends AssetContentKey {
  status: AssetContentStatus
  /** 正文，`status !== 'parsed'` 时恒为 null */
  content: string | null
  /** 正文源字节的 sha256，与 `archived_assets.nas_hash` 逐字相同；未解析时 null */
  contentHash: string | null
  /** NAS 副本的字节数 */
  bytes: number
  /** 未解析的原因，一句人话（会出现在预览页）；parsed 时 null */
  reason: string | null
  parsedAt: number
}

/** `listPending` 返回的一行：已归档到 NAS、但 `asset_contents` 里还没有的文本类资产 */
export interface PendingContentRow extends AssetContentKey {
  nasPath: string
  nasHash: string
}

export interface ContentsStore {
  /**
   * 写一行。**upsert**，不是普通 INSERT。
   *
   * 两个理由：一是归档流水线与回填脚本可能同时碰到同一个资产（归档刚写完、
   * 回填正好扫到），撞主键报错没有任何意义——两边算出来的是同一份哈希校验过的正文；
   * 二是将来接上 docx 解析器时，一行 `unsupported_format` 要能被同一个键覆盖成
   * `parsed`，不必为此另开一次迁移。
   */
  put(record: AssetContentRecord): Promise<void>
  get(key: AssetContentKey): Promise<AssetContentRecord | null>
  /**
   * 回填脚本的枚举源：已归档 + 属于文本类 + 本表里还没有的资产，按自然键升序，
   * 最多 `limit` 行。
   *
   * 「本表里还没有」是可重复跑的全部机制所在：跑过的行（**包括未解析的那种**）
   * 下一次不会再出现，所以脚本可以一批一批推进、断了从头再来。
   */
  listPending(limit: number): Promise<PendingContentRow[]>
}

interface ContentSqlRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  status: AssetContentStatus
  content: string | null
  content_hash: string | null
  bytes: number
  reason: string | null
  parsed_at: number
}

interface PendingSqlRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  nas_path: string
  nas_hash: string
}

function mapContentRow(r: ContentSqlRow): AssetContentRecord {
  return {
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    assetType: r.asset_type,
    remoteId: r.remote_id,
    fileType: r.file_type,
    status: r.status,
    content: r.content,
    contentHash: r.content_hash,
    // BIGINT 显式 Number 化，理由同 archives.ts：这个值会被 A6 的响应体带给前端，
    // 一个字符串 "1234" 会让「大于 1MB 就折叠」这类判断悄悄按字典序比
    bytes: Number(r.bytes),
    reason: r.reason,
    parsedAt: Number(r.parsed_at),
  }
}

export function createContentsStore(pool: Pool): ContentsStore {
  return {
    async put(record) {
      // pool.query（不是 execute）+ `AS new` 别名：与 archives.ts 的两处 upsert 同一写法。
      // MEDIUMTEXT 走这条路径时是客户端转义的普通语句，16MB 的正文可能撞上服务端的
      // max_allowed_packet（不少部署仍是 16M 甚至 4M）——那会抛出来，由调用方按
      // 「入库失败」处理：不写行、留日志、下次回填重试。这正是我们要的行为，
      // 所以这里不吞异常，也不预先按 packet 大小自作主张地截断。
      await pool.query(
        `INSERT INTO asset_contents
           (meeting_id, sub_meeting_id, asset_type, remote_id, file_type,
            status, content, content_hash, bytes, reason, parsed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE
           status = new.status, content = new.content, content_hash = new.content_hash,
           bytes = new.bytes, reason = new.reason, parsed_at = new.parsed_at`,
        [
          record.meetingId, record.subMeetingId, record.assetType, record.remoteId, record.fileType,
          record.status, record.content, record.contentHash, record.bytes, record.reason, record.parsedAt,
        ],
      )
    },

    async get(key) {
      const [rows] = await pool.execute<ContentSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id, asset_type, remote_id, file_type,
                status, content, content_hash, bytes, reason, parsed_at
           FROM asset_contents
          WHERE meeting_id = ? AND sub_meeting_id = ? AND asset_type = ? AND remote_id = ? AND file_type = ?`,
        [key.meetingId, key.subMeetingId, key.assetType, key.remoteId, key.fileType],
      )
      const r = rows[0]
      return r ? mapContentRow(r) : null
    },

    async listPending(limit) {
      // LIMIT 的值直接拼进 SQL，不走占位符：mysql2 的 execute 走服务端预处理语句，
      // 而 MySQL 的 LIMIT 只接受整型字面量或用户变量，`LIMIT ?` 在部分版本上会以
      // 一句语法错误告终。所以在这里就地校验成一个正整数再拼——校验放在拼接之前，
      // 不是"反正调用方会传对"。
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`listPending: limit 必须是正整数，收到 ${limit}`)
      }
      const types = TEXT_GATEWAY_ASSET_TYPES.map(() => '?').join(', ')
      const [rows] = await pool.execute<PendingSqlRow[]>(
        `SELECT a.meeting_id, a.sub_meeting_id, a.asset_type, a.remote_id, a.file_type,
                a.nas_path, a.nas_hash
           FROM archived_assets a
           LEFT JOIN asset_contents c
             ON c.meeting_id = a.meeting_id AND c.sub_meeting_id = a.sub_meeting_id
            AND c.asset_type = a.asset_type AND c.remote_id = a.remote_id
            AND c.file_type = a.file_type
          WHERE c.meeting_id IS NULL AND a.asset_type IN (${types})
          ORDER BY a.meeting_id, a.sub_meeting_id, a.asset_type, a.remote_id, a.file_type
          LIMIT ${limit}`,
        [...TEXT_GATEWAY_ASSET_TYPES],
      )
      return rows.map((r) => ({
        meetingId: r.meeting_id,
        subMeetingId: r.sub_meeting_id,
        assetType: r.asset_type,
        remoteId: r.remote_id,
        fileType: r.file_type,
        nasPath: r.nas_path,
        nasHash: r.nas_hash,
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// 从 NAS 上那份副本产出一行 asset_contents
//
// 这一段不是 SQL，按理不该住在 store 里。放这儿是因为**两个调用方都需要它**——
// 归档流水线（src/worker/archive.ts）与回填脚本（scripts/backfill-contents.ts），
// 而 T4 的文件边界里能放共享代码的只有本文件。让 worker 去 import 脚本、或者让脚本
// 去 import worker，两种都比这个更糟：前者是依赖方向反了，后者会把 worker 的
// 一整套依赖拖进一次性脚本。
//
// 判断顺序是有讲究的，见 buildAssetContent 内的逐条说明。
// ---------------------------------------------------------------------------

export interface BuildContentInput {
  key: AssetContentKey
  /** NAS 上那份副本的绝对路径（`archived_assets.nas_path` 的原值） */
  nasPath: string
  /** `archived_assets.nas_hash`。**正文必须和它对得上**，对不上就不入库 */
  nasHash: string
  now: number
}

export interface BuildContentOptions {
  /** 默认 MEDIUMTEXT_MAX_BYTES。可注入是为了让「装不下」这条分支不必真造一个 16MB 的文件 */
  maxBytes?: number
  /** 默认 NAS_READ_TIMEOUT_MS */
  timeoutMs?: number
  /** 默认 node:fs/promises 的 readFile / stat。注入用于造「NAS 挂住/读不出来」 */
  readFile?: (path: string) => Promise<Buffer>
  statSize?: (path: string) => Promise<number>
}

export type BuildContentResult =
  /** 产出一行，直接交给 `ContentsStore.put` */
  | { kind: 'record'; record: AssetContentRecord }
  /**
   * **不产出行**，只报一句理由。读文件失败、正文与 `nas_hash` 对不上都走这里。
   *
   * 为什么不落一行 `status='failed'`：这两类是暂时性的或异常的，下一次跑回填脚本
   * 还应该重试，而写了行就等于宣布「这一条处理过了」，回填脚本（只处理本表里没有的
   * 行）再也不会回头看它。与 `archiveOneAsset` 对哈希校验失败的处理同一口径:
   * 不留记录 = 下一轮重来。调用方负责把这句理由喊出来。
   */
  | { kind: 'failed'; reason: string }
  /** 不是文本类资产（录像/音频/未知类型）——入库范围之外，不产出行也不算失败 */
  | { kind: 'not_text' }

function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function buildAssetContent(
  input: BuildContentInput,
  options: BuildContentOptions = {},
): Promise<BuildContentResult> {
  const { key, nasPath, nasHash, now } = input
  const maxBytes = options.maxBytes ?? MEDIUMTEXT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? NAS_READ_TIMEOUT_MS
  const readFile = options.readFile ?? ((p: string) => fsReadFile(p))
  const statSize = options.statSize ?? (async (p: string) => (await fsStat(p)).size)

  // ① 入库范围。调用方本来就该先筛过（归档流水线筛一次、listPending 在 SQL 里筛一次），
  //    这里再挡一道是因为**误用的后果是把一段 2GB 的录像整读进内存**，而那不会
  //    以一条清楚的错误结束，会以进程 OOM 结束。未知 asset_type 一律按二进制处理,
  //    这是引擎 isTextAssetType 的安全默认值，跟着它走。
  if (!isTextAssetType(key.assetType)) return { kind: 'not_text' }

  const record = (over: Partial<AssetContentRecord> & Pick<AssetContentRecord, 'status' | 'bytes'>): BuildContentResult => ({
    kind: 'record',
    record: { ...key, content: null, contentHash: null, reason: null, parsedAt: now, ...over },
  })

  let size: number
  try {
    // ② 先问大小再决定读不读。顺序不能反：一个 100MB 的「txt」整读进内存只是为了
    //    随后判它超限，等于让一条防御措施自己成为故障源。
    size = await withFsTimeout(statSize(nasPath), `stat(${nasPath})`, timeoutMs)
  } catch (err) {
    return { kind: 'failed', reason: `读不到 NAS 上的副本 ${nasPath}：${err}` }
  }

  // ③ 格式判断排在大小之前：一个 20MB 的 docx，真正的原因是「不解析 docx」而不是
  //    「太大」。报后者会让人以为换台大内存的机器就能解决。
  const ext = normalizeExtension(key.fileType)
  if (!PARSABLE_EXTENSIONS.has(ext)) {
    return record({
      status: 'unsupported_format',
      bytes: size,
      reason: `file_type=${key.fileType || '(空)'} 不是纯文本，本版本只解析 ${[...PARSABLE_EXTENSIONS].join(' / ')}——docx / pdf 需要单独的解析器，不在控制台阶段 4 的范围内`,
    })
  }

  if (size > maxBytes) {
    return record({
      status: 'too_large',
      bytes: size,
      reason: `正文 ${size} 字节，超过 MEDIUMTEXT 上限 ${maxBytes} 字节——明确拒绝而不是截断（截断过的纪要在预览页上看起来是完整的）`,
    })
  }

  let buf: Buffer
  try {
    buf = await withFsTimeout(readFile(nasPath), `read(${nasPath})`, timeoutMs)
  } catch (err) {
    return { kind: 'failed', reason: `读不到 NAS 上的副本 ${nasPath}：${err}` }
  }

  // ④ stat 与 read 之间文件可能变了（也可能调用方根本没让 stat 生效）。这一条不是
  //    冗余：真正决定能不能存进 MEDIUMTEXT 的是手里这段字节，不是刚才问到的大小。
  if (buf.length > maxBytes) {
    return record({
      status: 'too_large',
      bytes: buf.length,
      reason: `正文 ${buf.length} 字节，超过 MEDIUMTEXT 上限 ${maxBytes} 字节——明确拒绝而不是截断（截断过的纪要在预览页上看起来是完整的）`,
    })
  }

  // ⑤ 哈希对齐。**入了一份和 NAS 上不一致的正文，比没入更糟**——预览页会显示一份
  //    查不出出处的内容，而没人能从界面上看出它已经不是归档下来的那一份了。
  //    算的是刚读到手的这段字节本身，不是"再 stat 一次文件"：要保证的是
  //    「存进库的这段文本」与 nas_hash 对应，不是「那个路径上的文件」。
  const hash = sha256Bytes(buf)
  if (hash !== nasHash) {
    return {
      kind: 'failed',
      reason:
        `NAS 副本 ${nasPath} 的哈希与 archived_assets.nas_hash 对不上` +
        `（读到 ${hash}，记录是 ${nasHash}）——不入库，等下一次回填重试`,
    }
  }

  // ⑥ 解码要**无损**。非法 UTF-8（例如平台给了一份 GBK 的 txt）按 UTF-8 解码会被
  //    替换成 U+FFFD，那份正文与 nas_hash 就对不上了——而它偏偏已经通过了上面那关,
  //    因为哈希算的是原始字节。所以再回编一次比对：不一致就当成「格式不支持」,
  //    留一行说清楚，而不是存一份走了样的正文。
  const text = buf.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    return record({
      status: 'unsupported_format',
      bytes: buf.length,
      reason: '文件不是合法的 UTF-8 文本（按 UTF-8 解码后与源字节不一致，可能是 GBK 等其它编码），不入一份解码走样的正文',
    })
  }

  return record({ status: 'parsed', bytes: buf.length, content: text, contentHash: hash })
}
