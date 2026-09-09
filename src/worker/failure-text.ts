/**
 * 失败项那一句话的措辞（规格 2026-09-09 §2.4）。**纯函数，不碰库、不碰网络。**
 *
 * ## 为什么原始报错不能直接当 reason
 *
 * 2026-09-09 本机实测，`job_failures.reason` 里躺着的是这种东西：
 *
 *   下载重试用尽，已放弃：video（ENOENT: no such file or directory,
 *   open '/Users/…/2026-09-01_会议主题/transcript_3.txt.part'）
 *
 * 三个毛病，每一个单独都够格重写这一句：
 *
 * 1. **说不出该找谁**。`ENOENT` 是本地盘的事，`http 404` 是腾讯那边根本没有
 *    这个文件——前者要人去看磁盘，后者一辈子都修不好。原文把这两件事写成
 *    一样长的一串英文
 * 2. **路径是改名之前的旧路径**，指向一个已经不存在的目录。一句会误导人的明细
 *    比没有明细更糟
 * 3. **它把归并打散了**。失败项表按「任务 + 原因 + 影响」归并（控制台的
 *    `groupFailures`），判据是三段文字逐字相同。原文里带着 remote_id 和路径，
 *    每条都不一样，于是一轮拉取里 23 场同一件事的会议就是 23 行
 *
 * 所以拆成两列：`reason` 一句人话（进归并键），`detail` 原文（不进归并键，
 * 界面上是一个默认收起的「技术详情」）。信息一点没少，只是各归各位。
 *
 * ## 为什么在 worker 侧而不是 domain 侧
 *
 * 它的唯一调用方是调度器任务一的 `recordDeadAssets`，输入是
 * `meeting_assets.last_error` ——一列只有 worker 会写的字段。放进 `src/domain/`
 * 会让人以为网关那一侧也该用它，而网关拿不到那一列。
 */
import { GATEWAY_TYPE_TO_ASSET_KEY } from '@yaowu/mde-engine'
import { ASSET_LABEL } from '../domain/asset-labels'

/** 一条放弃掉的资产，只带拼这两句话用得上的四个字段。`DeadAsset` 结构上满足它 */
export interface FailingAsset {
  /** 网关的 `asset_type`（video / meeting_summary / ai_minutes …），不是客户端的 AssetKey */
  assetType: string
  remoteId: string
  fileType: string | null
  lastError: string | null
}

/**
 * 把 `meeting_assets.last_error` 翻成一句人话。
 *
 * 判据是**前缀 / 包含**，不是精确匹配：错误原文里带着可变的路径、字节数、主机名。
 * 顺序即优先级，认不出的一律落到最弱的那句——**不编一个原因**。
 */
export function describeDownloadError(lastError: string | null): string {
  if (lastError === null) return '下载失败'
  if (lastError.startsWith('http 404')) return '腾讯那边没有这个文件'
  if (lastError.startsWith('http 5') || lastError.startsWith('too many link renewals')) {
    return '腾讯下载服务出错'
  }
  if (lastError.includes('ENOENT') || lastError.includes('EACCES') || lastError.includes('ENOSPC')) {
    return '本地写入失败'
  }
  if (lastError.startsWith('size mismatch')) return '下载不完整'
  return '下载失败'
}

/**
 * 网关 `asset_type` 的中文名。表在 `src/domain/asset-labels.ts`——**全项目唯一一份**，
 * 这里不另起一套叫法。认不出的类型原样带出：映成某个已知资产名是在编造，
 * 而一个英文原值在界面上是一个看得见的提醒。
 */
export function assetTypeLabel(assetType: string): string {
  const key = GATEWAY_TYPE_TO_ASSET_KEY[assetType]
  return key === undefined ? assetType : ASSET_LABEL[key]
}

/**
 * 一场会议的失败原因：`<中文资产名>：<人话>`，用「；」连接。
 *
 * 去重的键是**整句**（类型 + 人话），不是只看类型：同一场会议的三段录像同样
 * 404 时压成一句（写三遍没多说什么），但一段 404、另一段磁盘满时两句都要在
 * ——那是两件事、两种处置。
 */
export function deadAssetsReason(assets: readonly FailingAsset[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const a of assets) {
    const line = `${assetTypeLabel(a.assetType)}：${describeDownloadError(a.lastError)}`
    if (seen.has(line)) continue
    seen.add(line)
    parts.push(line)
  }
  return parts.join('；')
}

/**
 * 原始技术信息，一条资产一行：`<asset_type>/<remote_id>/<file_type>: <lastError>`。
 *
 * **不去重**：这里要的就是「到底是哪几条资产」，去重会把 remote_id 这个唯一能
 * 让人回库里找到那一行的东西弄丢。
 */
export function deadAssetsDetail(assets: readonly FailingAsset[]): string {
  return assets
    .map((a) => `${a.assetType}/${a.remoteId}/${a.fileType ?? ''}: ${a.lastError ?? '无错误信息'}`)
    .join('\n')
}
