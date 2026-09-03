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
  /**
   * **这一行是 completed，所以这一列是落盘的真实字节数**（`markCompleted` 用
   * downloader 完成那一刻累加出来的值写的），不是进度检查点——检查点那个说法只对
   * 非终态的行成立。NAS sidecar 的 `bytes` 在平台没声明大小时回落到它。
   * 0 是唯一说不清的值（空文件？还是这条回落上线之前完成的旧行？），按不知道处理。
   * 完整推理见 `packages/engine/src/domain/manifest.ts` 里 `bytes` 字段的注释。
   */
  bytesWritten: number
  /** 平台声明的字节数。写进 NAS sidecar 的 `bytes` 优先取它——它被 downloader
   *  的尺寸校验钉过。但真实环境里平台常常一个都不给，那时才回落到 `bytesWritten`。 */
  bytesExpected: number | null
  /** 下载器在**本地**算出的整文件 sha256；视频/音频恒为 null（不整读，会吃爆内存）。
   *  与归档记下的 `nas_hash` 是两个值、两种含义，见 domain/manifest.ts。 */
  contentHash: string | null
}

/**
 * meeting_assets 里一行**没拿到**的资产。
 *
 * 三种状态进这里：`skipped`（明确放弃）、`dead`（重试用尽）这两个终态，加上
 * `failed`（这一轮没成，下一轮还会重试）。`pending` / `running` 不进——它们连
 * 「试过一次」都还没有，写进清单等于对着一个什么都还没发生的状态下结论。
 *
 * **`failed` 进来是有代价的取舍**：它不是终态，清单因此会说一件还会变的事。但
 * 它带着 `last_error`，而 `status` 这一列本身就把「还会重试」说清楚了——读清单的人
 * 看见 `failed` 知道这是一张快照，看不见它则会以为这个资产从来不存在。**沉默比
 * 一个会变的事实更糟**，这是同一条判断在本仓库里的第 N 次应用。
 *
 * 分类规则与 `packages/engine/src/manifest/` **逐字一致**：两个宿主各写一份清单
 * （本地那份每轮重写、NAS 那份长期留着），同一个资产在两份清单里不能一份说缺、
 * 一份说没有。改这里必须同时改那里。
 *
 * 顺带一提：NAS 那份 sidecar 实际上很难看到 `failed`——`archiveMeeting` 只在
 * 「没有资产还在路上」（含 failed）时才写它。写得出 sidecar 时 failed 恒为 0，
 * 除非两条查询之间正好有一行转成 failed。留着这一支是为了上面那条「两处逐字一致」，
 * 以及那个窄窗口里如实写、不静默丢。
 */
export interface MissingAssetRow {
  meetingId: string
  subMeetingId: string
  assetType: string
  remoteId: string
  fileType: string
  status: 'skipped' | 'dead' | 'failed'
  /** 放弃/失败的原因（meeting_assets.last_error），没记下时为 null */
  lastError: string | null
}

/**
 * 一场会议归档进度的三个数（`countArchiveProgress` 的返回）。
 *
 * 三个一起取回不是图省事，是因为**只看前两个会得出错误结论**：`completed === archived`
 * 只说明「已经下载完的都搬走了」，不说明「这场会议归档完了」。一场会议 8 个资产、
 * 视频还在下载时，前 7 个搬完就有 `7 === 7`——于是 `meeting_archives` 建行、
 * NAS sidecar 写出一份只列 7 个资产的清单（视频既不在 `assets` 也不在 `missing`）、
 * 30 天保留窗口开始计时，而那盘录像还没落地。`inFlight` 就是补上的那半个事实。
 */
export interface ArchiveProgress {
  /** meeting_assets 里 status='completed' 的行数 */
  completed: number
  /** archived_assets 里已经搬上 NAS 的行数 */
  archived: number
  /**
   * 还在路上的资产数：`pending` / `running` / `failed`。
   *
   * `failed` 算在路上，因为它会被自动重试（`meeting_assets.attempts` 用尽才转
   * `dead`）——它是「还没有结论」，不是「确认没有」。终态只有 `completed` /
   * `skipped` / `dead` 三个，这个数归零就意味着这场会议再也不会多出新东西可搬。
   */
  inFlight: number
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
  /** 同一场会议里**没拿到**的资产（status='skipped' / 'dead' / 'failed'），供 NAS sidecar 的
   *  `missing[]` 用——US-6.2 第三条验收标准要的就是这一段。按 id 升序，理由同上。
   *  三个状态各自的取舍见 `MissingAssetRow` 的注释。
   *
   *  它读的仍然是 meeting_assets（三张表边界内那张只读的），不越界去碰第四张表。 */
  listMissingAssets(meetingId: string, subMeetingId: string): Promise<MissingAssetRow[]>
  /** 该资产是否已经在 archived_assets 里有记录（用于跳过已归档过的资产，支持重跑） */
  isAssetArchived(row: Pick<CompletedAssetRow, 'meetingId' | 'subMeetingId' | 'assetType' | 'remoteId' | 'fileType'>): Promise<boolean>
  recordArchivedAsset(input: ArchivedAssetRecord): Promise<void>
  /** "这场会议是不是归档完了"要的三个数，**一次往返**取回：completed / archived / inFlight。
   *
   *  取代此前的 countCompletedAssets + countArchivedAssets 两个方法：那两个数只答得了
   *  「下载完的都搬完了没有」，答不了「还有没有东西没下完」，而后者才是
   *  `meeting_archives` 建行、sidecar 落盘、保留窗口起算的前提（见 `ArchiveProgress`）。
   *  两个数变三个数不该变成三次查询——`archivePendingMeetings` 每轮对每场待办会议
   *  都要问一次，所以这里是三个标量子查询拼成的一条语句。 */
  countArchiveProgress(meetingId: string, subMeetingId: string): Promise<ArchiveProgress>

  /** worker 主循环用：枚举**还需要跑一次 archiveMeeting** 的 (meeting_id, sub_meeting_id)
   *  精确对。两种会议要返回，缺一种都会有会议永远卡住：
   *
   *  1. **还有 completed 资产没搬**（completed 数量严格大于 archived 数量）——有活要干；
   *  2. **`meeting_archives` 里还没有行**（哪怕 completed 已经全搬完了）——会议级记录
   *     还没落。第二条不是冗余：一场会议的最后一个在路上的资产转 `dead` 之后，
   *     没有任何新东西可搬（completed === archived），只按第一条枚举的话它再也不会被
   *     `archiveMeeting` 访问，于是永远拿不到归档记录、保留窗口永远不开始计时、
   *     本地文件永远不会被清理——而这一切没有任何地方会报错。
   *
   *  第二条的代价是「已经归档完但一直写不出 meeting_archives」的会议每轮都被捞回来，
   *  这正是想要的：那种会议本来就有事没办完。归档完且有行的会议仍然一轮都不会进来。
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
   *  同时也是"没有待办事项就不必再查"的早退：**归档完了、而且已经有 meeting_archives
   *  那一行**的会议不会出现在结果里，不会每轮都被重新 archiveMeeting 一遍；压根没有
   *  completed 资产的会议也不会（枚举源是 completed 那一侧的聚合）。 */
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
  /** 「本地文件还在」的**全量**枚举源：`local_purged_at IS NULL` 的归档行 ∪
   *  有 `status='completed'` 资产的会议，去重，**一条 SQL**。
   *
   *  与 `listMeetingArchives` / `listMeetingsWithCompletedAssets` 的分工：那两个是
   *  「给我这批会议的情况」（调用方已经有一份会议清单，比如某程序的授权行）；
   *  这一个是「哪些会议的文件还在」——自动授权轮（方案 2）没有现成的清单可问，
   *  它的候选源就是这个集合本身。
   *
   *  两个来源缺一不可，与 spec §1.3 第二个「与」的判据逐字一致（见 worker/visibility.ts
   *  的文件头第二节）：还没归档过、但本地已经有下载完成资产的会议，文件确实在，
   *  外部程序此刻真取得到；只按归档行枚举会把它们整批漏掉，而那正是「每天新进来的
   *  会议」最常见的形态——它们恰恰是自动授权要覆盖的那一批。
   *
   *  `UNION` 而不是 `UNION ALL`：同一场会议两边都有是常态（归档过、本地也还有资产），
   *  不去重的话调用方会对同一场会议判两遍、审计里出现两条一模一样的自动授权记录。
   *
   *  已清理的会议（`local_purged_at` 非空）**不在其中**——除非它同时还有 completed
   *  资产，那说明清理之后又下过新东西，文件确实又在了。 */
  listMeetingKeysWithLocalFiles(): Promise<{ meetingId: string; subMeetingId: string }[]>
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
  status: 'skipped' | 'dead' | 'failed'
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

interface ArchiveProgressSqlRow extends RowDataPacket {
  completed: number
  archived: number
  in_flight: number
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
          WHERE meeting_id = ? AND sub_meeting_id = ? AND status IN ('skipped', 'dead', 'failed')
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

    async countArchiveProgress(meetingId, subMeetingId) {
      // 三个标量子查询拼成一条语句：三个数属于同一个判断（见 ArchiveProgress），
      // 拆成三次往返只会让每场会议每轮多两次查询，还让三个数取自三个时刻。
      // 每个子查询都以 (meeting_id, sub_meeting_id) 打头，走的是各自表上那条索引
      // 的最左前缀。
      const [rows] = await pool.execute<ArchiveProgressSqlRow[]>(
        `SELECT
           (SELECT COUNT(*) FROM meeting_assets
             WHERE meeting_id = ? AND sub_meeting_id = ? AND status = 'completed') AS completed,
           (SELECT COUNT(*) FROM archived_assets
             WHERE meeting_id = ? AND sub_meeting_id = ?) AS archived,
           (SELECT COUNT(*) FROM meeting_assets
             WHERE meeting_id = ? AND sub_meeting_id = ?
               AND status IN ('pending', 'running', 'failed')) AS in_flight`,
        [meetingId, subMeetingId, meetingId, subMeetingId, meetingId, subMeetingId],
      )
      const r = rows[0]
      return {
        completed: Number(r?.completed ?? 0),
        archived: Number(r?.archived ?? 0),
        inFlight: Number(r?.in_flight ?? 0),
      }
    },

    async listMeetingsNeedingArchive() {
      // 两边各自按 (meeting_id, sub_meeting_id) 聚合成一行 completed_count /
      // archived_count 再 LEFT JOIN 比较，而不是逐会议跑 countArchiveProgress——
      // 那样对 N 场会议要发 N 条查询；这里恒定一条。
      //
      // WHERE 的两支各自刻画一种"还要跑一次 archiveMeeting"：
      //
      //   c.completed_count > COALESCE(a.archived_count, 0)
      //     还有 completed 资产没进 archived_assets：从没归档过、归档到一半、
      //     某个资产哈希校验失败等下一轮重试——有活要干。
      //
      //   ar.meeting_id IS NULL
      //     **一个字节都不用搬，但会议级那一行还没写**。这一支是必需的：一场会议的
      //     最后一个在路上的资产转 dead 之后，completed === archived 恒成立，
      //     只有第一支的话它再也不会被 archiveMeeting 访问，于是永远没有
      //     meeting_archives 行、保留窗口永远不开始、本地文件永远不会被清理，
      //     而且不会有任何报错。
      //
      // 归档完且已有那一行的会议两支都不命中——"没有待办事项就不必再查"的早退还在。
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
           LEFT JOIN meeting_archives ar
             ON ar.meeting_id = c.meeting_id AND ar.sub_meeting_id = c.sub_meeting_id
          WHERE c.completed_count > COALESCE(a.archived_count, 0) OR ar.meeting_id IS NULL
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

    async listMeetingKeysWithLocalFiles() {
      // 一条 SQL 而不是两条再在内存里合：两条查询之间有一个窗口，归档轮正好在那一刻
      // 把某场会议的资产搬完并写上 local_purged_at 的话，它会同时从两边漏掉
      const [rows] = await pool.execute<MeetingKeyRow[]>(
        `SELECT meeting_id, sub_meeting_id FROM meeting_archives WHERE local_purged_at IS NULL
          UNION
         SELECT meeting_id, sub_meeting_id FROM meeting_assets WHERE status = 'completed'
          ORDER BY meeting_id, sub_meeting_id`,
      )
      // 顺序稳定：自动授权轮按它逐场写授权行与审计，顺序跟着执行计划变的话，
      // 同一批会议在两次运行里的审计顺序会不一样，对不上账
      return rows.map((r) => ({ meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id }))
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
