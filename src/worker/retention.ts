import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFsTimeout } from '@yaowu/mde-engine'
import type { ArchivesStore, ArchivedAssetRecord, MeetingArchiveRecord } from '../store/archives'

/**
 * 本文件是全系统唯一执行不可逆删除的代码（dev-plan.md §6 点名的最高风险项）。
 * 三条硬要求逐字生效，改这个文件之前先读一遍：
 *
 *   1. 删之前**当场重新校验** NAS 上那份文件的哈希——重新读一遍、重新算一遍，
 *      不是查 archived_assets.nas_hash 那个归档当时记下的值就算数
 *   2. "暂停到期清理"开关持久化在 system_settings，**不能**是内存标志：NAS 断连
 *      通常伴随重启或切换，内存标志会在最需要它的时候消失
 *   3. 默认 dry-run，真删必须显式二次确认
 */

const NAS_READ_TIMEOUT_MS = 5_000

async function sha256File(path: string): Promise<string> {
  // 流式读取，理由同 src/worker/archive.ts：录像资产可以有几个 GB，
  // 一次性读进内存会把 worker 打爆。
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export interface RetentionDeps {
  archives: ArchivesStore
  localRoot: string
}

export interface CleanupItem {
  meetingId: string
  subMeetingId: string
  /** 该会议本地占用的字节数（供预览页展示"删了能腾出多少空间"），
   *  来自 meeting_assets.bytes_written 之和——口径见 localBytesOf */
  localBytes: number
  assetCount: number
}

export interface CleanupPreview {
  dryRun: true
  items: CleanupItem[]
  totalBytes: number
}

export interface CleanupExecuted {
  dryRun: false
  paused: boolean
  /** paused=true 时 items 为空，说明本轮因暂停开关直接跳过 */
  purged: CleanupItem[]
  /** 哈希重新校验不一致、本轮拒绝删除的会议——需要人工介入，不是静默跳过 */
  verificationFailed: Array<{ meetingId: string; subMeetingId: string; reason: string }>
}

function expiresAt(rec: MeetingArchiveRecord): number {
  return rec.archivedAt + (rec.retentionDays + rec.extendedDays) * 86400
}

async function isPaused(archives: ArchivesStore): Promise<boolean> {
  // 每一轮都重新读库，不缓存：开关的全部意义是"NAS 出事的当下能立刻按下去"，
  // 一个缓存值会让按下去与生效之间隔着一段没人说得清多长的时间。
  return (await archives.getSetting('cleanup_paused')) === '1'
}

/**
 * 本轮真正到期的会议。SQL 侧已经按 local_purged_at IS NULL + archived_at <= now
 * 粗筛过（见 ArchivesStore.listExpiredUnpurged 的注释：三列算术组合用不上索引，
 * 所以精确的到期公式放在这里算）。
 *
 * 边界取"严格过期"：now 必须严格大于到期时刻，正好走到到期那一秒还不删，下一轮
 * 才删。对不可逆删除来说，边界上偏晚一秒是对的那一侧。
 */
async function expiredCandidates(deps: RetentionDeps, now: number): Promise<MeetingArchiveRecord[]> {
  return (await deps.archives.listExpiredUnpurged(now)).filter((r) => expiresAt(r) < now)
}

/**
 * 该会议本地占用的字节数，取 meeting_assets.bytes_written 之和——落库的下载事实，
 * 不是去 stat 本地文件：executeCleanup 里这个数要在文件已经删掉之后仍然报得出来，
 * 那时没有东西可 stat 了。
 *
 * 口径上有一处已知的不精确，记在这里而不是留给下一个人查：求和按 completed 资产，
 * 删除按 archived_assets 逐个删。正常情况下两者是同一批（Task 7 只在"全部 completed
 * 资产都归档完"时才写 meeting_archives），只有"归档之后又有新资产下载完、但还没归档
 * 成功"这种中间态下，这个数会略微高估本轮真能腾出来的空间。它只喂预览页的容量估算，
 * 不参与任何删除判断，为此引入一次跨表逐键匹配不划算。
 */
async function localBytesOf(deps: RetentionDeps, meetingId: string, subMeetingId: string): Promise<number> {
  const completed = await deps.archives.listCompletedAssets(meetingId, subMeetingId)
  return completed.reduce((sum, a) => sum + a.bytesWritten, 0)
}

/**
 * 硬要求 1：删之前把 NAS 上每个文件重新读一遍、重新算一遍哈希，与 archived_assets
 * 里记的值比对。不信任那个记录值本身——Task 7 归档时确实校验过一次，但从归档到到期
 * 之间隔着几十天，这期间 NAS 上的文件可能被外部因素改动过或干脆不见了，
 * "上次校验过"不等于"现在还一致"。
 *
 * 返回 null 表示全部一致；返回字符串表示本轮拒绝删除的原因。任何一个资产校验不过，
 * 整场会议本轮都不删——不做"部分删"，否则库里的 local_purged_at 语义会变得含糊
 * （到底是"全删了"还是"删了一半"）。
 *
 * 原因里带上具体的 nas_path：这条信息的用途是"需要人工介入"，只说"有文件对不上"
 * 的话，人工得自己把整场会议的资产挨个重算一遍才知道从哪查起。
 */
async function verifyNasCopies(assets: ArchivedAssetRecord[]): Promise<string | null> {
  for (const asset of assets) {
    let currentHash: string
    try {
      // 触达 NAS 的 fs 调用一律包超时：网络挂载可能挂住而不是报错，
      // 不包的话清理任务会静静地卡在某个 read 上，看起来像"今天没有到期文件"。
      currentHash = await withFsTimeout(sha256File(asset.nasPath), `hash ${asset.nasPath}`, NAS_READ_TIMEOUT_MS)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return `NAS 上的归档文件读取失败：${asset.nasPath}（${detail}）——已跳过，不删除该会议任何本地文件`
    }
    if (currentHash !== asset.nasHash) {
      return `NAS 上的归档文件哈希与归档记录不一致：${asset.nasPath}——已跳过，不删除该会议任何本地文件`
    }
  }
  return null
}

/**
 * 预览：只读，永远安全，不需要检查暂停开关（暂停开关管的是"删不删"，
 * 预览不删任何东西）。
 */
export async function previewCleanup(deps: RetentionDeps, now: number): Promise<CleanupPreview> {
  const candidates = await expiredCandidates(deps, now)
  const items: CleanupItem[] = []
  let totalBytes = 0
  for (const rec of candidates) {
    const assets = await deps.archives.listArchivedAssetsForMeeting(rec.meetingId, rec.subMeetingId)
    // 预览阶段不读文件、不算哈希——那是"真删"才需要付出的代价（可能触达几十个
    // NAS 文件），预览只需要知道"有哪些、大概多大"，字节数来自已经落库的记录。
    const localBytes = await localBytesOf(deps, rec.meetingId, rec.subMeetingId)
    items.push({ meetingId: rec.meetingId, subMeetingId: rec.subMeetingId, assetCount: assets.length, localBytes })
    totalBytes += localBytes
  }
  return { dryRun: true, items, totalBytes }
}

/**
 * 真删。confirm 必须显式为 true——调用方（未来 A3 的 API）不给默认值，
 * 逼着每一次调用点都写明白"这次是真删"，不能靠参数省略意外触发。
 */
export async function executeCleanup(deps: RetentionDeps, now: number, confirm: true): Promise<CleanupExecuted> {
  if (await isPaused(deps.archives)) {
    // 在枚举候选之前就返回：暂停期间连"哪些会议到期了"都不必去问，
    // 更不会有任何一次 fs 调用落到 NAS 或本地文件上。
    return { dryRun: false, paused: true, purged: [], verificationFailed: [] }
  }

  const candidates = await expiredCandidates(deps, now)
  const purged: CleanupItem[] = []
  const verificationFailed: CleanupExecuted['verificationFailed'] = []

  for (const rec of candidates) {
    const assets = await deps.archives.listArchivedAssetsForMeeting(rec.meetingId, rec.subMeetingId)

    const failure = await verifyNasCopies(assets)
    if (failure !== null) {
      verificationFailed.push({ meetingId: rec.meetingId, subMeetingId: rec.subMeetingId, reason: failure })
      continue
    }

    // 校验全部通过——只删本地文件，NAS 副本与数据库记录永久保留（spec.md §4.9）。
    // asset.localPath 是 Task 7 归档时复制进 archived_assets 的本地相对路径副本，
    // 不需要跨表回查 meeting_assets。
    const localBytes = await localBytesOf(deps, rec.meetingId, rec.subMeetingId)

    // force: true 让"文件已经不在了"不算错误，这一条顺带保证了重跑安全：万一删到
    // 一半抛出（本地盘 EACCES 之类），markLocalPurged 不会执行，下一轮重新走一遍
    // 校验与删除时，已经删掉的那些不会再报错。库里因此不会出现"半删"状态——
    // local_purged_at 只在整场会议全部删完之后才写。
    for (const asset of assets) {
      await rm(join(deps.localRoot, asset.localPath), { force: true })
    }
    await deps.archives.markLocalPurged(rec.meetingId, rec.subMeetingId, now)

    // 【阶段 3 R3 才接得上的调用点，不是遗漏】spec §7.2 描述的到期动作里还有一条
    // "撤下授权"：本地文件删掉之后，这场会议此前发给采集程序的授权应当同步失效，
    // 再来取要走 NAS（对应审计里那句"拒绝 · 本地已到期，请去 NAS 取"）。它依赖
    // meeting_grants 这张表——阶段 3 的 R3 才建，本阶段没有可调用的东西。位置就在
    // 这里，紧跟 markLocalPurged：
    //     await deps.grants.revokeForMeeting(rec.meetingId, rec.subMeetingId, now)
    // 现在提前把这个 dep 开进 RetentionDeps，只会造出一个没人实现的接口和一个空实现。

    purged.push({
      meetingId: rec.meetingId,
      subMeetingId: rec.subMeetingId,
      assetCount: assets.length,
      localBytes,
    })
  }

  return { dryRun: false, paused: false, purged, verificationFailed }
}
