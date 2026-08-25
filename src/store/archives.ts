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
  /**
   * 平台声明的字节数。写进 NAS sidecar 的 `bytes` 取的是它，**不是** `bytesWritten`
   * ——后者是 downloader 每 8MB 一次的**进度检查点**，对小文件恒为 0、对大文件停在
   * 最后一个 8MB 边界上，把它当文件大小写进清单等于写假数据。完整推理见
   * `packages/engine/src/domain/manifest.ts` 里 `bytes` 字段的注释。
   */
  bytesExpected: number | null
  /** 下载器在**本地**算出的整文件 sha256；视频/音频恒为 null（不整读，会吃爆内存）。
   *  与归档记下的 `nas_hash` 是两个值、两种含义，见 domain/manifest.ts。 */
  contentHash: string | null
}

/**
 * meeting_assets 里一行**确认取不到**的资产。
 *
 * 只有终态才算「确认缺失」：`skipped`（明确放弃）与 `dead`（重试用尽）。
 * `pending` / `running` / `failed` 还在流程里，属于「不知有无」，不在这里返回——
 * 「确认缺失」与「不知有无」是两种状态，这条区分是 US-6.2 的第三条验收标准本身，
 * 不是实现细节。分类规则与 `packages/engine/src/manifest/` 逐字一致。
 */
export interface MissingAssetRow {
  meetingId: string
  subMeetingId: string
  assetType: string
  remoteId: string
  fileType: string
  status: 'skipped' | 'dead'
  /** 放弃的原因（meeting_assets.last_error），没记下时为 null */
  lastError: string | null
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

/**
 * `listArchivedMeetingKeys` 返回集合里的键。用 `\u0000` 分隔而不是 `:`——
 * meeting_id / sub_meeting_id 都是平台给的字符串，用可打印字符分隔会让
 * `("a:b", "")` 与 `("a", "b")` 撞成同一个键。
 */
export function archiveStateKey(meetingId: string, subMeetingId: string): string {
  return `${meetingId}\u0000${subMeetingId}`
}

export interface ArchivesStore {
  /** WHERE status='completed'，供归档流水线挑出"下载完成但还没进 archived_assets"的资产。
   *  按 id 升序（= 入库顺序）：归档顺序与 NAS sidecar 的 `assets[]` 顺序都由它决定，
   *  重跑要产出同样的内容就不能让顺序跟着优化器走。与引擎那份清单同一种排序。 */
  listCompletedAssets(meetingId: string, subMeetingId: string): Promise<CompletedAssetRow[]>
  /** 同一场会议里**确认取不到**的资产（status='skipped' / 'dead'），供 NAS sidecar 的
   *  `missing[]` 用——US-6.2 第三条验收标准要的就是这一段。按 id 升序，理由同上。
   *
   *  它读的仍然是 meeting_assets（三张表边界内那张只读的），不越界去碰第四张表。 */
  listMissingAssets(meetingId: string, subMeetingId: string): Promise<MissingAssetRow[]>
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
  /** 这批会议里哪些**已经写进了 NAS**（meeting_archives 里有行）。
   *
   *  规则引擎的 `arch` 条件（`isarch` / `notarch`）要用它——网关列一次会议要判
   *  几十上百场，逐场 findMeetingArchive 就是几十上百次往返。**不能因为查着麻烦
   *  就在调用点填个 false**：那会让一条 `arch notarch → allow` 的规则把已归档的
   *  会议也放行，是查不出来的静默放行。
   *
   *  返回的集合用 `archiveStateKey()` 编码。传空数组时不查库，直接返回空集。 */
  listArchivedMeetingKeys(
    keys: readonly { meetingId: string; subMeetingId: string }[],
  ): Promise<ReadonlySet<string>>
  /** 这批会议的归档行**整行**（阶段 3 · T8 的采集清单重算用）。
   *
   *  与上一个方法的分工：`listArchivedMeetingKeys` 回答的是规则引擎那个 `arch`
   *  条件要的布尔——归档过没有。采集清单要的是另外三列：`local_purged_at`
   *  （spec §1.3 的第二个「与」判的是**本地文件还在没有**，不是窗口算出来到没到期）、
   *  `nas_dir`（本地已清理时要说得出"去 NAS 的哪个目录取"，见 §4.10）、
   *  以及 `retention_days + extended_days`（§4.5 的"其中 N 场 7 天内到期"）。
   *  只回一个布尔就都答不了，所以整行取回来，而不是让调用方逐场再补一次
   *  `findMeetingArchive`——那正是这一族批量读法要防的 N+1。
   *
   *  同一条行构造器 IN，命中主键 (meeting_id, sub_meeting_id)，一次往返问清整批。
   *  传空数组时不查库，直接返回空数组。 */
  listMeetingArchives(
    keys: readonly { meetingId: string; subMeetingId: string }[],
  ): Promise<MeetingArchiveRecord[]>
  /** 这批会议里哪些**本地还有下载完成的资产**（meeting_assets 里有 status='completed' 的行）。
   *
   *  采集清单里"还没归档过"的会议靠它判「文件在不在」：`meeting_archives` 里没有行
   *  只说明保留窗口还没开始计时，不说明本地是空的——归档循环还没轮到、或者归档一直失败的
   *  会议，本地文件明明还在，外部程序此刻真取得到。反过来，一场只是被拉取列表带出来、
   *  一个资产都没下载完的会议，把它算进"现在可取走 N 场"就是虚报。
   *
   *  仍然只 SELECT `meeting_assets`（002 那张从下载完成起只读的表），不写它的任何一列。
   *  返回的集合用 `archiveStateKey()` 编码。传空数组时不查库，直接返回空集。 */
  listMeetingsWithCompletedAssets(
    keys: readonly { meetingId: string; subMeetingId: string }[],
  ): Promise<ReadonlySet<string>>
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
  bytes_expected: number | null
  content_hash: string | null
}

interface MissingAssetSqlRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  status: 'skipped' | 'dead'
  last_error: string | null
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
    // BIGINT 列显式 Number 化（与 store-mysql.ts 的 getMeeting 同一理由）：
    // 这个值会被写进 NAS 上的 JSON 清单，一个字符串 "1234" 会让数年后读清单的
    // 脚本拿到另一种类型。
    bytesExpected: r.bytes_expected === null ? null : Number(r.bytes_expected),
    contentHash: r.content_hash,
  }
}

function mapMissingAssetRow(r: MissingAssetSqlRow): MissingAssetRow {
  return {
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    assetType: r.asset_type,
    remoteId: r.remote_id,
    fileType: r.file_type,
    status: r.status,
    lastError: r.last_error,
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
        `SELECT meeting_id, sub_meeting_id, asset_type, remote_id, file_type, target_path,
                bytes_written, bytes_expected, content_hash
           FROM meeting_assets
          WHERE meeting_id = ? AND sub_meeting_id = ? AND status = 'completed'
          ORDER BY id`,
        [meetingId, subMeetingId],
      )
      return rows.map(mapCompletedAssetRow)
    },

    async listMissingAssets(meetingId, subMeetingId) {
      const [rows] = await pool.execute<MissingAssetSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, last_error
           FROM meeting_assets
          WHERE meeting_id = ? AND sub_meeting_id = ? AND status IN ('skipped', 'dead')
          ORDER BY id`,
        [meetingId, subMeetingId],
      )
      return rows.map(mapMissingAssetRow)
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

    async listArchivedMeetingKeys(keys) {
      if (keys.length === 0) return new Set<string>()
      // 行构造器的 IN：(meeting_id, sub_meeting_id) 是主键，命中主键前缀，
      // 一次往返问清整批。逐场查是 N 次往返，列一次会议就是几十上百次。
      const placeholders = keys.map(() => '(?, ?)').join(', ')
      const params = keys.flatMap((k) => [k.meetingId, k.subMeetingId])
      const [rows] = await pool.execute<MeetingArchiveSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id
           FROM meeting_archives
          WHERE (meeting_id, sub_meeting_id) IN (${placeholders})`,
        params,
      )
      return new Set(rows.map((r) => archiveStateKey(r.meeting_id, r.sub_meeting_id)))
    },

    async listMeetingArchives(keys) {
      if (keys.length === 0) return []
      // 同上那条行构造器 IN，只是取整行——采集清单要 local_purged_at / nas_dir /
      // retention_days + extended_days 三件事，一个布尔答不了。
      const placeholders = keys.map(() => '(?, ?)').join(', ')
      const params = keys.flatMap((k) => [k.meetingId, k.subMeetingId])
      const [rows] = await pool.execute<MeetingArchiveSqlRow[]>(
        `SELECT meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, extended_days, local_purged_at
           FROM meeting_archives
          WHERE (meeting_id, sub_meeting_id) IN (${placeholders})`,
        params,
      )
      return rows.map(mapMeetingArchiveRow)
    },

    async listMeetingsWithCompletedAssets(keys) {
      if (keys.length === 0) return new Set<string>()
      // DISTINCT 而不是把行全捞回来：这里只回答"有没有"，一场会议可以有几十行资产。
      // (meeting_id, sub_meeting_id) 是 uk_asset 的最左前缀，行构造器 IN 走得上。
      const placeholders = keys.map(() => '(?, ?)').join(', ')
      const params = keys.flatMap((k) => [k.meetingId, k.subMeetingId])
      const [rows] = await pool.execute<MeetingKeyRow[]>(
        `SELECT DISTINCT meeting_id, sub_meeting_id
           FROM meeting_assets
          WHERE status = 'completed' AND (meeting_id, sub_meeting_id) IN (${placeholders})`,
        params,
      )
      return new Set(rows.map((r) => archiveStateKey(r.meeting_id, r.sub_meeting_id)))
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
          WHERE meeting_id = ? AND sub_meeting_id = ?
          ORDER BY asset_type, remote_id, file_type`,
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
