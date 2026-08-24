import type { RowDataPacket } from 'mysql2'
import type { Pool } from './db'

/**
 * 三张表的边界（详见 migrations/003_console_stage2.sql 的表头注释）：
 * `meeting_assets`（002）从资产下载完成那一刻起是只读历史事实——本文件绝不
 * UPDATE 它的任何一列，只用 SELECT 读 status='completed' 的行。NAS 侧路径与哈希
 * 只写进 `archived_assets`。整场会议的保留窗口只写进 `meeting_archives`。
 */

/** meeting_assets 里一行"已完成下载"的资产——字段照抄 002 的列，只读用途 */
export interface CompletedAssetRow {
  meetingId: string
  subMeetingId: string
  assetType: string
  remoteId: string
  fileType: string
  targetPath: string
  bytesWritten: number
}

export interface ArchivedAssetRecord {
  meetingId: string
  subMeetingId: string
  assetType: string
  remoteId: string
  fileType: string
  /** 本地相对路径的副本，值取自 meeting_assets.target_path——写入后不再更新，
   *  用途见 Task 8：到期清理要删本地文件，不必为此再跨表查 meeting_assets */
  localPath: string
  nasPath: string
  nasHash: string
  archivedAt: number
}

export interface MeetingArchiveRecord {
  meetingId: string
  subMeetingId: string
  nasDir: string
  archivedAt: number
  retentionDays: number
  extendedDays: number
  localPurgedAt: number | null
}

export interface ArchivesStore {
  /** WHERE status='completed'，供归档流水线挑出"下载完成但还没进 archived_assets"的资产 */
  listCompletedAssets(meetingId: string, subMeetingId: string): Promise<CompletedAssetRow[]>
  /** 该资产是否已经在 archived_assets 里有记录（用于跳过已归档过的资产，支持重跑） */
  isAssetArchived(row: Pick<CompletedAssetRow, 'meetingId' | 'subMeetingId' | 'assetType' | 'remoteId' | 'fileType'>): Promise<boolean>
  recordArchivedAsset(input: ArchivedAssetRecord): Promise<void>
  /** 某场会议 meeting_assets 里 completed 的资产总数，与 archived_assets 里已归档的数量做比较，
   *  用来判断"这场会议是不是全部资产都归档完了"（只有全部完成才创建/更新 meeting_archives） */
  countCompletedAssets(meetingId: string, subMeetingId: string): Promise<number>
  countArchivedAssets(meetingId: string, subMeetingId: string): Promise<number>

  /** worker 主循环用：枚举"存在未归档完成资产"的 (meeting_id, sub_meeting_id) 精确对——
   *  即 meeting_assets 里 completed 数量严格大于 archived_assets 里已归档数量的那些。
   *
   *  这是 Step 5 归档循环真正的枚举源，取代最初错误复用的 Store.meetingsForPaths()：
   *  那个方法按 meeting_id 去重（专为local 落盘路径命名设计——一次只需要一个"代表"
   *  meeting 元数据的场次），周期性会议同一 meeting_id 下的其它 sub_meeting_id 会被
   *  静默丢弃、永远不会被传给 archiveMeeting，对应场次因此永远不会归档到 NAS、
   *  永远不会出现在 meeting_archives 里，Task 8 的到期清理也永远看不到它们
   *  （tests/worker/store-mysql.test.ts:393 一条既有回归测试钉住了 meetingsForPaths
   *  这个"后一行覆盖前一行"的行为——它对自己的原始用途是对的，只是不该被当成
   *  归档流水线的枚举源复用）。
   *
   *  同时也是"没有待办事项就不必再查"的早退：completed<=archived 的会议（早就
   *  全部归档完、或者压根没有 completed 资产）不会出现在结果里，不会每轮都被
   *  重新 archiveMeeting 一遍。 */
  listMeetingsNeedingArchive(): Promise<{ meetingId: string; subMeetingId: string }[]>

  upsertMeetingArchive(input: {
    meetingId: string
    subMeetingId: string
    nasDir: string
    archivedAt: number
    retentionDays: number
    now: number
  }): Promise<void>
  findMeetingArchive(meetingId: string, subMeetingId: string): Promise<MeetingArchiveRecord | null>
  extendRetention(meetingId: string, subMeetingId: string, addDays: number, now: number): Promise<void>
  /** Task 8 用：查全部未清理的会议归档（local_purged_at IS NULL），并用 archived_at
   *  做一次廉价的 SQL 侧预过滤（archived_at <= now 是"真到期"的必要非充分条件，因为
   *  retention_days/extended_days 恒 >= 0）。这条查询与 idx_archives_expiry
   *  (local_purged_at, archived_at) 的列序精确对应，等值前缀 + range，不触发 filesort。
   *  真正的到期公式（archivedAt + (retentionDays+extendedDays)*86400 <= now）涉及
   *  三列的算术组合，SQL 端用不上索引算，交给调用方（Task 8 的 retention.ts）再筛一遍。 */
  listExpiredUnpurged(now: number): Promise<MeetingArchiveRecord[]>
  /** Task 8 用：某场会议已归档到 NAS 的全部资产（据此重新校验哈希、找本地文件删） */
  listArchivedAssetsForMeeting(meetingId: string, subMeetingId: string): Promise<ArchivedAssetRecord[]>
  markLocalPurged(meetingId: string, subMeetingId: string, now: number): Promise<void>

  /** system_settings 读写，键名固定为 'cleanup_paused' / 'default_retention_days' */
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string, now: number): Promise<void>
}

interface CompletedAssetSqlRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  // 列本身可空（002 允许 NULL），但只要一行 status='completed'，setTargetPath
  // 一定先于 markCompleted 跑过（packages/engine/src/executor/index.ts），所以
  // 实践中恒非空——mapCompletedAssetRow 显式校验这条不变量，而不是用 `!`/`as`
  // 悄悄压过去，免得一个真正的数据完整性 bug 被伪装成别处一个更难查的 join(root, null)
  target_path: string | null
  bytes_written: number
}

interface ArchivedAssetSqlRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  local_path: string
  nas_path: string
  nas_hash: string
  archived_at: number
}

interface MeetingArchiveSqlRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  nas_dir: string
  archived_at: number
  retention_days: number
  extended_days: number
  local_purged_at: number | null
}

interface CountRow extends RowDataPacket {
  cnt: number
}

interface MeetingKeyRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
}

interface SettingRow extends RowDataPacket {
  setting_value: string
}

function mapCompletedAssetRow(r: CompletedAssetSqlRow): CompletedAssetRow {
  if (r.target_path === null) {
    throw new Error(
      `meeting_assets row is status='completed' but target_path is NULL ` +
        `(${r.meeting_id}/${r.sub_meeting_id}/${r.asset_type}/${r.remote_id}/${r.file_type}) — ` +
        'setTargetPath must run before markCompleted; this indicates a data integrity bug upstream',
    )
  }
  return {
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    assetType: r.asset_type,
    remoteId: r.remote_id,
    fileType: r.file_type,
    targetPath: r.target_path,
    bytesWritten: Number(r.bytes_written),
  }
}

function mapArchivedAssetRow(r: ArchivedAssetSqlRow): ArchivedAssetRecord {
  return {
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    assetType: r.asset_type,
    remoteId: r.remote_id,
    fileType: r.file_type,
    localPath: r.local_path,
    nasPath: r.nas_path,
    nasHash: r.nas_hash,
    archivedAt: Number(r.archived_at),
  }
}

function mapMeetingArchiveRow(r: MeetingArchiveSqlRow): MeetingArchiveRecord {
  return {
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    nasDir: r.nas_dir,
    archivedAt: Number(r.archived_at),
    retentionDays: Number(r.retention_days),
    extendedDays: Number(r.extended_days),
    localPurgedAt: r.local_purged_at === null ? null : Number(r.local_purged_at),
  }
}

export function createArchivesStore(pool: Pool): ArchivesStore {
  return {
    async listCompletedAssets(meetingId, subMeetingId) {
      const [rows] = await pool.execute<CompletedAssetSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id, asset_type, remote_id, file_type, target_path, bytes_written
           FROM meeting_assets
          WHERE meeting_id = ? AND sub_meeting_id = ? AND status = 'completed'`,
        [meetingId, subMeetingId],
      )
      return rows.map(mapCompletedAssetRow)
    },

    async isAssetArchived({ meetingId, subMeetingId, assetType, remoteId, fileType }) {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT 1 FROM archived_assets
          WHERE meeting_id = ? AND sub_meeting_id = ? AND asset_type = ? AND remote_id = ? AND file_type = ?
          LIMIT 1`,
        [meetingId, subMeetingId, assetType, remoteId, fileType],
      )
      return rows.length > 0
    },

    async recordArchivedAsset(input) {
      // 普通 INSERT：自然键冲突直接抛出。archiveMeeting 的调用方在此之前已经
      // 用 isAssetArchived 挡过一轮，正常路径不会撞到这里；真撞上了（例如极端情况下
      // 并发跑了两次归档）应当被感知，不能静默覆盖已经记过的 NAS 路径/哈希。
      await pool.execute(
        `INSERT INTO archived_assets
           (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.meetingId,
          input.subMeetingId,
          input.assetType,
          input.remoteId,
          input.fileType,
          input.localPath,
          input.nasPath,
          input.nasHash,
          input.archivedAt,
        ],
      )
    },

    async countCompletedAssets(meetingId, subMeetingId) {
      const [rows] = await pool.execute<CountRow[]>(
        `SELECT COUNT(*) AS cnt FROM meeting_assets
          WHERE meeting_id = ? AND sub_meeting_id = ? AND status = 'completed'`,
        [meetingId, subMeetingId],
      )
      return Number(rows[0]?.cnt ?? 0)
    },

    async countArchivedAssets(meetingId, subMeetingId) {
      const [rows] = await pool.execute<CountRow[]>(
        `SELECT COUNT(*) AS cnt FROM archived_assets
          WHERE meeting_id = ? AND sub_meeting_id = ?`,
        [meetingId, subMeetingId],
      )
      return Number(rows[0]?.cnt ?? 0)
    },

    async listMeetingsNeedingArchive() {
      // 两边各自按 (meeting_id, sub_meeting_id) 聚合成一行 completed_count /
      // archived_count 再 LEFT JOIN 比较，而不是逐会议跑 countCompletedAssets +
      // countArchivedAssets——那样对 N 场会议要发 2N 条查询；这里恒定两条。
      // completed_count > archived_count（archived_count 缺行时按 0 算）精确刻画
      // "这场会议还有至少一个 completed 资产没有出现在 archived_assets 里"，
      // 包含三种情况：从没归档过、归档到一半、某个资产哈希校验失败等下一轮重试——
      // 全部需要重新调用 archiveMeeting；完全没有 completed 资产、或已经全部归档完的
      // 会议不会出现在结果里，天然提供"没有待办事项就不必再查"的早退。
      const [rows] = await pool.execute<MeetingKeyRow[]>(
        `SELECT c.meeting_id, c.sub_meeting_id
           FROM (
             SELECT meeting_id, sub_meeting_id, COUNT(*) AS completed_count
               FROM meeting_assets
              WHERE status = 'completed'
              GROUP BY meeting_id, sub_meeting_id
           ) c
           LEFT JOIN (
             SELECT meeting_id, sub_meeting_id, COUNT(*) AS archived_count
               FROM archived_assets
              GROUP BY meeting_id, sub_meeting_id
           ) a ON a.meeting_id = c.meeting_id AND a.sub_meeting_id = c.sub_meeting_id
          WHERE c.completed_count > COALESCE(a.archived_count, 0)
          ORDER BY c.meeting_id, c.sub_meeting_id`,
      )
      return rows.map((r) => ({ meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id }))
    },

    async upsertMeetingArchive({ meetingId, subMeetingId, nasDir, archivedAt, retentionDays, now }) {
      // ON DUPLICATE KEY UPDATE 子句只碰 nas_dir/archived_at/retention_days/updated_at
      // 这四列，绝不提 extended_days：INSERT 列表里也没有它，首次插入时它退回
      // 列定义的 DEFAULT 0（正确——刚创建的归档记录还没被任何人延长过）；重复调用
      // 撞上 UPDATE 分支时，不出现在 SET 列表里的列 MySQL 根本不会去碰，
      // 管理员此前做过的"延长 N 天"因此不会被这次意外的重复归档调用悄悄清零。
      await pool.query(
        `INSERT INTO meeting_archives
           (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE
           nas_dir = new.nas_dir, archived_at = new.archived_at,
           retention_days = new.retention_days, updated_at = new.updated_at`,
        [meetingId, subMeetingId, nasDir, archivedAt, retentionDays, now, now],
      )
    },

    async findMeetingArchive(meetingId, subMeetingId) {
      const [rows] = await pool.execute<MeetingArchiveSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, extended_days, local_purged_at
           FROM meeting_archives
          WHERE meeting_id = ? AND sub_meeting_id = ?`,
        [meetingId, subMeetingId],
      )
      const r = rows[0]
      return r ? mapMeetingArchiveRow(r) : null
    },

    async extendRetention(meetingId, subMeetingId, addDays, now) {
      // 累加，不是覆盖：多次"延长 N 天"必须叠加生效
      await pool.execute(
        `UPDATE meeting_archives
            SET extended_days = extended_days + ?, updated_at = ?
          WHERE meeting_id = ? AND sub_meeting_id = ?`,
        [addDays, now, meetingId, subMeetingId],
      )
    },

    async listExpiredUnpurged(now) {
      const [rows] = await pool.execute<MeetingArchiveSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, extended_days, local_purged_at
           FROM meeting_archives
          WHERE local_purged_at IS NULL AND archived_at <= ?
          ORDER BY archived_at ASC`,
        [now],
      )
      return rows.map(mapMeetingArchiveRow)
    },

    async listArchivedAssetsForMeeting(meetingId, subMeetingId) {
      const [rows] = await pool.execute<ArchivedAssetSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at
           FROM archived_assets
          WHERE meeting_id = ? AND sub_meeting_id = ?`,
        [meetingId, subMeetingId],
      )
      return rows.map(mapArchivedAssetRow)
    },

    async markLocalPurged(meetingId, subMeetingId, now) {
      await pool.execute(
        `UPDATE meeting_archives SET local_purged_at = ?, updated_at = ? WHERE meeting_id = ? AND sub_meeting_id = ?`,
        [now, now, meetingId, subMeetingId],
      )
    },

    async getSetting(key) {
      const [rows] = await pool.execute<SettingRow[]>(
        `SELECT setting_value FROM system_settings WHERE setting_key = ?`,
        [key],
      )
      return rows[0] ? rows[0].setting_value : null
    },

    async setSetting(key, value, now) {
      // Upsert，与 upsertMeetingArchive 一样的 VALUES(...) AS new 写法：
      // system_settings 存的是"暂停开关"/"默认保留天数"这类会被反复改写的单例配置，
      // 与 upsertMeetingArchive 不同，这里没有"某一列绝不能被覆盖"的约束——
      // 每一列都应该跟随最新一次调用。
      await pool.query(
        `INSERT INTO system_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE setting_value = new.setting_value, updated_at = new.updated_at`,
        [key, value, now],
      )
    },
  }
}
