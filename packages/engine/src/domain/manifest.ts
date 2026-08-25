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
   * 文件字节数；取的是 `bytes_expected`（平台声明的大小）而**不是**
   * `bytes_written`。
   *
   * 这不是随手选的：`bytes_written` 是**进度检查点**，不是文件大小——
   * downloader 每 8MB 才回调一次进度且结束时不补最后一次，所以它对小文件恒为 0、
   * 对大文件停在最后一个 8MB 边界上。把它写进清单等于写一个假的大小。
   * 而 `bytes_expected` 在 downloader 里是**被校验过的**：完成前有一条
   * `written !== bytesExpected → failed` 的硬判定，所以一个 completed 的资产的
   * `bytes_expected` 就是磁盘上的真实字节数。平台没给期望大小时该判定不成立，
   * 那就如实写 null（不知道），不拿检查点凑数。
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
 * `_manifest.json` 里的一项：**确认取不到**的资产及原因。
 *
 * 「确认缺失」与「不知有无」是两种不同的状态，归档系统里前者才无歧义
 * （网关 spec §A.4 / US-6.2 第三条验收标准）。所以只有终态才进这里：
 * `skipped`（明确放弃，如平台不允许下载、等到 deadline 也没产出）与
 * `dead`（重试用尽）。`pending` / `running` / `failed` 还在流程里，属于
 * 「不知有无」，一概不写——写了就等于对着还会变的状态下结论。
 */
export interface ManifestMissingEntry {
  assetType: string
  assetKey: string
  remoteId: string | null
  status: 'skipped' | 'dead'
  /** 放弃的原因（`download_not_allowed` / `upstream_timeout` / 最后一次错误…） */
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
