import type { RowDataPacket } from 'mysql2'
import type { Pool } from './db'

/**
 * 「归档存储」页（spec.md §4.9）要的四个聚合数，**只读**。
 *
 * 为什么另开一个文件而不是往 `ArchivesStore` 上加方法：`src/store/archives.ts`
 * 是阶段 2 交付并已验证的归档流水线写侧，本任务不改它；而这四个数全是整表聚合
 * （COUNT / SUM），与那边"按会议逐场问"的读法不是一族。放一起会让归档流水线
 * 每次改动都要重新审视一批与它无关的报表查询。
 *
 * 为什么不在 handler 里循环调 `listCompletedAssets` / `listArchivedAssetsForMeeting`
 * 逐场累加：那是 N+1（几百场会议 × 2 次往返），而这一页会被反复刷新。
 *
 * **口径说明（与 retention.ts 的 localBytesOf 有意不同，不是笔误）**：
 * 那边算"本轮清理能腾出多少空间"用的是 `meeting_assets.bytes_written`，
 * 而 `archives.ts` 已经写明 `bytes_written` 是下载器每 8MB 一次的**进度检查点**
 * ——对小文件恒为 0、对大文件停在最后一个 8MB 边界上。用它去显示"本地占用 X GB"
 * 会让页面长期显示成 0，那是个假数字。所以这里取
 * `COALESCE(bytes_expected, bytes_written)`：优先用平台声明的字节数
 * （写 NAS sidecar 的 `bytes` 用的也是它，见 domain/manifest.ts），
 * 平台没给才回退到进度检查点。
 */
export interface StorageAggregates {
  /** `meeting_archives` 的行数 —— 已完整归档到 NAS 的会议场次。
   *  **包含本地已清理的**：文件被清理掉之后 NAS 副本与数据库记录都还在
   *  （spec §4.9「到期只删本地文件，数据库记录永久保留」），它仍然是一场已归档会议。 */
  archivedMeetings: number
  /** 本系统写在 NAS 上的字节数，用来把 statfs 报出来的"已用"拆成「本系统 / 其他」。 */
  nasBytes: number
  /** 本地文件还在（`local_purged_at IS NULL`）的归档会议占用的本地字节数。 */
  localBytes: number
  /** 上述"保留期内"的会议里，至少有一个未撤销授权的场次数（§4.9「其中已授权」）。
   *  一场会议授权给三个程序仍然只算一场。 */
  grantedLiveMeetings: number
}

export interface ConsoleStorageStore {
  aggregates(): Promise<StorageAggregates>
}

interface AggregatesRow extends RowDataPacket {
  archived_meetings: number | string
  nas_bytes: number | string
  local_bytes: number | string
  granted_live_meetings: number | string
}

/**
 * SUM() 在 MySQL 里回的是 DECIMAL，mysql2 默认把 DECIMAL 映射成**字符串**
 * （避免大数丢精度）；COUNT() 回 BIGINT，同样可能是字符串。两者都必须显式
 * Number 化——否则 `usedByOthersBytes = total - available - nasBytes` 会变成
 * 字符串拼接，页面上出现一个长得离谱的"容量"。
 */
function num(v: number | string | null): number {
  return v === null ? 0 : Number(v)
}

export function createConsoleStorageStore(pool: Pool): ConsoleStorageStore {
  return {
    async aggregates() {
      // 四个数一次往返问清。写成四条独立查询也对，但这一页每次打开都要全要，
      // 合成一条标量子查询省掉三次往返，且四个数来自同一个读视图——
      // 分四条时，中间恰好跑完一轮清理会让"已归档"与"本地占用"对不上账。
      const [rows] = await pool.query<AggregatesRow[]>(
        `SELECT
           (SELECT COUNT(*) FROM meeting_archives) AS archived_meetings,

           -- NAS 占用：归档过的每个资产各算一次。join 的五段正是 archived_assets
           -- 与 meeting_assets 共用的自然键（uk_asset），走得上唯一索引。
           -- 这里**不加** status 过滤：能进 archived_assets 就说明它当时是
           -- completed，而 NAS 上那份不会因为本地资产行后来变成别的状态而消失。
           (SELECT COALESCE(SUM(COALESCE(ma.bytes_expected, ma.bytes_written)), 0)
              FROM archived_assets aa
              JOIN meeting_assets ma
                ON ma.meeting_id = aa.meeting_id AND ma.sub_meeting_id = aa.sub_meeting_id
               AND ma.asset_type = aa.asset_type AND ma.remote_id = aa.remote_id
               AND ma.file_type = aa.file_type) AS nas_bytes,

           -- 本地占用：口径与 retention.ts 的 localBytesOf 对齐——只数**真的会被
           -- 删的那些**，即既在 archived_assets 里有记录、又在 meeting_assets 里
           -- 找得到对应 completed 行的资产，且这场会议还没被清理过。
           (SELECT COALESCE(SUM(COALESCE(ma.bytes_expected, ma.bytes_written)), 0)
              FROM meeting_archives mr
              JOIN archived_assets aa
                ON aa.meeting_id = mr.meeting_id AND aa.sub_meeting_id = mr.sub_meeting_id
              JOIN meeting_assets ma
                ON ma.meeting_id = aa.meeting_id AND ma.sub_meeting_id = aa.sub_meeting_id
               AND ma.asset_type = aa.asset_type AND ma.remote_id = aa.remote_id
               AND ma.file_type = aa.file_type AND ma.status = 'completed'
             WHERE mr.local_purged_at IS NULL) AS local_bytes,

           -- 其中已授权：EXISTS 而不是 JOIN + DISTINCT——一场会议可以授权给多个
           -- 程序，JOIN 会把它数成多场。revoked_at = 0 是"未撤销"（见 005 的表头，
           -- 该列 NOT NULL DEFAULT 0，不是 NULLABLE）。
           (SELECT COUNT(*) FROM meeting_archives mr
             WHERE mr.local_purged_at IS NULL
               AND EXISTS (SELECT 1 FROM meeting_grants g
                            WHERE g.meeting_id = mr.meeting_id
                              AND g.sub_meeting_id = mr.sub_meeting_id
                              AND g.revoked_at = 0)) AS granted_live_meetings`,
      )
      const r = rows[0]
      return {
        archivedMeetings: num(r?.archived_meetings ?? 0),
        nasBytes: num(r?.nas_bytes ?? 0),
        localBytes: num(r?.local_bytes ?? 0),
        grantedLiveMeetings: num(r?.granted_live_meetings ?? 0),
      }
    },
  }
}
