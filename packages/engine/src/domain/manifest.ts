/**
 * 会议目录里两个 sidecar 文件的格式：`meeting.json`（会议元数据）与
 * `_manifest.json`（资产清单 + 校验信息）。
 *
 * 它们存在的理由只有一句话，实现时请一直对着它：**使导出结果脱离数据库自解释
 * ——归档场景下，数年后在 NAS 上翻到该目录，无需本工具即可知道内容、完整性与
 * 原始 ID**（网关 spec §A.5 / 引擎 spec §11，两处同一句话）。
 *
 * 由此推出下面几条不可动摇的取舍：
 * - 一切字段都必须能**独立看懂**，不许出现只有查库才有意义的东西（行 id、
 *   lease、attempts 之类一概不写）。
 * - 拿不到的值一律如实写 `null`，不猜、不填 0、不伪造。一份会撒谎的清单比没有
 *   清单更糟：核查的人会信它。
 * - 格式一旦发出就是**外部契约**（人和将来的脚本都会读它），所以带
 *   `schemaVersion`；改动字段含义必须 +1，而不是就地改语义。
 *
 * 服务端归档链路随后会复用这同一份类型，所以定义放在 `domain/` 而不是某个宿主里。
 */

/**
 * 两个文件共用的 schema 版本。
 *
 * v1：初版——`meeting.json` = 会议元数据；`_manifest.json` = `assets`（这个目录里
 *     确实有的文件）+ `missing`（确认取不到的资产及原因）。
 */
export const MANIFEST_SCHEMA_VERSION = 1

/** 生成方标识：CLI 宿主写 `mde-engine`，服务端归档 worker 写 `mde-worker` */
export type ManifestGenerator = 'mde-engine' | 'mde-worker'

export interface MeetingMetaFile {
  schemaVersion: number
  meeting: {
    meetingId: string
    subMeetingId: string
    meetingCode: string | null
    subject: string | null
    hostUserId: string | null
    /** unix 秒 */
    startTime: number | null
    /** unix 秒 */
    endTime: number | null
  }
  /** unix 秒 */
  generatedAt: number
  generatedBy: string
}

/** `_manifest.json` 里的一项：**这个目录里确实存在的一个文件** */
export interface ManifestAssetEntry {
  /** 网关 `asset_type` 的原值——原始 ID 一侧的事实，不做美化 */
  assetType: string
  /** 引擎的 AssetKey（由 GATEWAY_TYPE_TO_ASSET_KEY 映射所得）。
   *  同时写两个名字不是冗余：同一批资产历史上出现过三套叫法
   *  （见 domain/types.ts 与 docs/console/dev-plan.md §5 的 C7），
   *  数年后翻到这份清单的人手里未必有映射表。 */
  assetKey: string
  /** 平台侧的原始 ID（腾讯的 record_file_id 等）。DB 里该列 NOT NULL，
   *  空串是「没有」的编码方式，这里归一成 null。 */
  remoteId: string | null
  /** 平台给的格式（txt/docx/mp4…）；未知时为 null（DB 里同样以空串编码） */
  fileType: string | null
  /** 目录内的文件名，不含路径——清单描述的就是「这个目录里有什么」 */
  fileName: string
  /**
   * 文件字节数；`null` 表示**不知道**（清单从不猜大小）。
   *
   * 取值顺序：`bytes_expected` 优先，为 null 时回落到该行的 `bytes_written`。
   * 两个来源各自可信到什么程度，是这个字段唯一需要讲清楚的事：
   *
   * **`bytes_expected`（平台声明的大小）——可信，因为被校验过**：downloader 完成前
   * 有一条 `written !== bytesExpected → failed` 的硬判定，所以只要这一列非 null 且
   * 该行是 completed，它就等于磁盘上的字节数。
   * 但它**经常没有**：2026-08-26 的真实环境联调实测，腾讯对这批资产一个
   * `bytes_expected` 都不返回（docs/m3.5-stage8-9-plan.md §0.1 第 2 条），
   * 这个字段因此曾经在生产里长期恒为 null，形同虚设——所以才有下面这条回落。
   *
   * **`bytes_written`——只在 completed 行上可信，别的状态一概不可信**：
   * - `completed`：**是真实文件大小**。`markCompleted` 用 downloader 完成那一刻
   *   逐 chunk 累加出来的值覆盖了这一列（见 store 的 `markCompleted` 与
   *   downloader 的 `DownloadResult`），它不是采样、不是估算。
   * - 其余任何状态（pending / running / failed / dead / skipped）：是**进度检查点**
   *   ——每 8MB 回调一次、结束时不补最后一次，所以对小文件恒为 0、对大文件停在
   *   最后一个 8MB 边界上。当文件大小用就是写假数据。
   *   清单本来只列 completed 行（非终态属于「不知有无」，见 ManifestMissingEntry），
   *   这条边界因此与清单的取值范围正好重合——但改动这里的人要知道它是靠什么成立的。
   *
   * **completed 行上的 `0` 是唯一说不清的值，一律写 null**：它可能是「文件真的是
   * 0 字节」，也可能是「这一行在本条回落上线**之前**就完成了」——那时 `markCompleted`
   * 不写这一列，留在里边的是从没触发过的检查点默认值 0。两者在数据里分不开，
   * 而这个仓库的规矩是分不开时落到安全的一侧：写 null（不知道），
   * 不写一个「0 字节」的谎。
   *
   * 「completed 行上这一列可信」这句话不是自然成立的，它靠一条判定撑着：
   * 两个 store 的 `touchProgress` 都带 `AND status='running'`，终态行不接受进度
   * 回写。没有它的话，一次不 await 的进度回写落在 `markCompleted` 之后就会把检查点
   * 值盖回来——而这份清单会一直留在 NAS 上。动那条判定之前，先回来读这一段。
   */
  bytes: number | null
  /**
   * 整文件 sha256（小写十六进制）；**视频/音频恒为 null，这是正常情况不是缺陷**。
   *
   * downloader 只对文本类资产整读算哈希，视频/音频不算——一段 2GB 的录制全量读
   * 进内存会直接吃爆内存（见 domain/types.ts 的 BINARY_ASSET_KEYS 注释）。
   * 清单如实写 null（「没有校验值」），不伪造一个算不出来的哈希。
   */
  sha256: string | null
}

/**
 * `_manifest.json` 里的一项：**这个目录里没有的资产**及原因。
 *
 * 两个终态无歧义：`skipped`（明确放弃，如平台不允许下载、等到 deadline 也没产出）
 * 与 `dead`（重试用尽）。`failed` 也写进来，**但它不是终态**——它会被重试，
 * 状态值本身就把这一点说清楚了，配上 `reason` 里的最后一次错误，读清单的人看到的是
 * 「这个资产上次没取到，原因是 X，还在试」。清单是**快照**，本地这份每轮都会重写，
 * 让它说一件还会变的事是诚实的；把 `failed` 藏起来才是撒谎——那样一个反复失败的资产
 * 在清单里与「从来没有过这个资产」长得一模一样。
 *
 * `pending` / `running` 仍然不写：它们连"试过一次"都还没有，没有原因可写，
 * 而清单每轮重写，下一轮它们多半已经变成别的状态了。
 *
 * 分类规则与网关侧 `src/store/archives.ts` 的 `listMissingAssets` **逐字一致**：
 * 同一个资产在本地清单与 NAS 清单里不能一份说缺、一份说没有。改这里必须同时改那里。
 */
export interface ManifestMissingEntry {
  assetType: string
  assetKey: string
  remoteId: string | null
  status: 'skipped' | 'dead' | 'failed'
  /** 放弃/失败的原因（`download_not_allowed` / `upstream_timeout` / 最后一次错误…） */
  reason: string
}

export interface ManifestFile {
  schemaVersion: number
  meetingId: string
  subMeetingId: string
  /** 这个目录里确实存在的文件，按入库顺序（id 升序）——顺序稳定，重跑内容不抖 */
  assets: ManifestAssetEntry[]
  /** 确认取不到的资产及原因；没有则是空数组，不省略这个字段 */
  missing: ManifestMissingEntry[]
  /** unix 秒 */
  generatedAt: number
  generatedBy: string
}

// ---------------------------------------------------------------------------
// NAS 副本
// ---------------------------------------------------------------------------

/**
 * 下面三个类型描述的是**归档到 NAS 之后写在 NAS 目录里的那一份 sidecar**。
 *
 * 为什么需要单独一组类型，而不是把 NAS 那份写成和本地一模一样的内容：本系统的
 * 产品模型是「NAS 是主存储、本地 30 天后删」（`src/worker/retention.ts`），所以
 * **长期活下来的是 NAS 那一份**，US-6.2 那句「数年后在 NAS 上翻到该目录」说的
 * 也正是它。那份清单要能回答本地那份回答不了的问题：这些文件在 NAS 上的哪儿、
 * NAS 上那些字节的校验值是多少、什么时候归的档、本地副本按多少天保留。
 *
 * 为什么是 `extends` 而不是另抄一份字段：两份清单描述的是**同一批资产**，
 * 字段含义必须逐字相同。同一份数据在两处各有一套类型定义，是这个仓库反复吃过
 * 亏的地方（见 `docs/console/dev-plan.md` §5 的 C7）。
 *
 * **schemaVersion 仍然是 1**，不是 2：本地那份 `_manifest.json` 的字段一个都没改、
 * 含义一个都没动，NAS 那份只是在同一版格式上**多带了几个字段**。按 v1 写的读取脚本
 * 读 NAS 那份照样正确（多出来的字段会被忽略），把版本号推到 2 反而是在对本地那份
 * 撒谎——它并没有变。真正需要 +1 的是「已有字段改语义」，不是「新增字段」。
 */

/** NAS 副本 `_manifest.json` 里的一项：本地清单的全部字段 + 归档特有的两项 */
export interface ArchivedManifestAssetEntry extends ManifestAssetEntry {
  /**
   * 这个文件在 NAS 上的实际路径（`archived_assets.nas_path` 的原值）。
   *
   * 与 `fileName` 不冗余：NAS 目录下沿用了本地的相对结构（`src/worker/archive.ts`
   * 的 `archiveOneAsset`），文件不一定就躺在清单所在的这一层目录里，只有完整路径
   * 才能把「清单里的这一条」和「盘上的那个文件」对上。
   */
  nasPath: string
  /**
   * 归档时**重新读回 NAS 上那份文件**算出的 sha256（`archived_assets.nas_hash`）。
   *
   * 与上面的 `sha256` 是两个值、两种含义，不要合并：`sha256` 是下载器在本地算的
   * （视频/音频恒为 null，理由见该字段注释），`nasHash` 是「NAS 上这些字节」的
   * 校验值，**对每个已归档资产都有**——归档链路本来就要读回来校验一次，顺手记下的
   * 是真实值，不是补算出来的。所以拿着这份清单核查 NAS 目录完整性时，视频也核得了。
   */
  nasHash: string
}

/** 归档段：只有 NAS 那一份清单才有的信息，本地那份没有也不该有 */
export interface ManifestArchiveInfo {
  /** unix 秒。**同时是本地保留窗口的起点**（`meeting_archives.archived_at` 的同值副本） */
  archivedAt: number
  /** 本地副本的保留天数。**不含**管理员事后延长的天数（`extended_days` 会变，
   *  而清单是归档那一刻的快照，写一个之后会漂移的值等于写一个会过期的谎） */
  retentionDays: number
  /** 这份清单所在的 NAS 目录（`meeting_archives.nas_dir` 的同值副本） */
  nasDir: string
}

export interface ArchivedManifestFile extends Omit<ManifestFile, 'assets'> {
  assets: ArchivedManifestAssetEntry[]
  archive: ManifestArchiveInfo
}
