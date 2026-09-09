import type { Meeting } from '../types'
import { MOCK_NOW, MOCK_SUB_MEETING_ID } from './meetings'

/**
 * NAS 状态 + 本地保留窗口（`GET /api/v1/admin/storage`）。
 *
 * ## 数字全部从会议世界里推
 *
 * 「已归档 6 场」「保留期内 5 场」「归档失败 1 场」在真系统里都是对同一张表的
 * 不同问法。这里也照办：一个数都不手写，全部从传进来的会议快照数出来。于是
 * NAS 断连把 4 场翻成归档失败之后，这一页的三个数会跟着一起变，与会议列表、
 * 定时任务页的失败项说的是同一件事。
 *
 * ## `null` 不许折成 `0`
 *
 * 探测不到容量就是 `null`（api/admin/storage.ts 文件头第 2 条）。这里绝不拿 0
 * 顶上：0 的意思是"确实没有"，null 的意思是"没查到"，界面上是两句不同的话。
 */

/** 可写的保留窗口配置。写端点改的就是它。 */
export interface RetentionConfig {
  /** `source === 'invalid'` 时是 null */
  defaultDays: number | null
  /** setting / fallback / invalid */
  source: string
  /** 库里那个原始字符串 */
  raw: string | null
  cleanupPaused: boolean
}

/**
 * 两种部署形态的初始配置。
 *
 * `degraded` 不是"NAS 断了"——那是系统状态（`nas-down`）的事，两者正交。
 * 它演示的是**另一台机器上的另一组事实**：`default_retention_days` 被人写成了
 * 一个非法值，网关还是没接 `job_failures` 的老版本。这两件事各自独立、都真实
 * 存在过，界面上各有各的形态（红色的「默认保留天数非法」与灰色的「暂不可得」），
 * 而它们与"NAS 连不连得上"没有因果关系，所以不能塞进 `nas-down` 里一起演。
 */
export function initialRetention(variant: string): RetentionConfig {
  if (variant === 'degraded') {
    return { defaultDays: null, source: 'invalid', raw: '三十天', cleanupPaused: true }
  }
  return { defaultDays: 30, source: 'setting', raw: '30', cleanupPaused: false }
}

const TIB = 1024 ** 4

function sum(ns: readonly number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}

/** 保留期内 = 归档过、还没被清理掉本地文件。 */
export function inRetention(m: Meeting): boolean {
  return m.keep.expiresAt !== null && !m.keep.filesGone
}

/** 已到期、但还没被清理掉的。「立即清理」动的就是这些。 */
export function expiredNotPurged(m: Meeting, nowSec: number = MOCK_NOW): boolean {
  return inRetention(m) && m.keep.expiresAt! <= nowSec
}

export function buildStorage(
  meetings: readonly Meeting[],
  cfg: RetentionConfig,
  opts: { nasUp: boolean; legacyGateway: boolean; nowSec: number },
): Record<string, unknown> {
  const archived = meetings.filter((m) => m.keep.archivedAt !== null)
  const failed = meetings.filter((m) => m.archive === 'failed')
  const pending = meetings.filter(
    (m) => m.keep.archivedAt === null && Object.keys(m.assets).length > 0,
  )
  const live = meetings.filter(inRetention)
  const usedByUs = sum(archived.map((m) => m.sizeBytes ?? 0))
  const total = opts.nasUp ? 8 * TIB : null
  const available = opts.nasUp ? 2.6 * TIB : null

  return {
    nas: {
      root: '/nas/meetings',
      reachable: opts.nasUp,
      checkedAt: opts.nowSec - 12,
      // 不可达时给的是"触发失败前实际耗掉的时间"，不是 null
      latencyMs: opts.nasUp ? 14 : 5000,
      error: opts.nasUp
        ? null
        : '挂载点 /nas/meetings 在 5s 内没有响应（ETIMEDOUT）。归档任务全部失败中。',
      totalBytes: total,
      availableBytes: available,
      usedByUsBytes: usedByUs,
      usedByOthersBytes:
        total === null || available === null ? null : Math.max(0, total - available - usedByUs),
      archivedMeetings: archived.length,
      // 「还没轮到」与「一直归档不成功」在库里长得一模一样，所以这个数两种都算
      pendingMeetings: pending.length,
      failedMeetings: opts.legacyGateway ? null : failed.length,
      failedMeetingsNote: opts.legacyGateway
        ? '这台网关还没接上 job_failures（A8 之前的版本），归档失败的场次数查不出来。'
        : null,
    },
    retention: {
      defaultDays: cfg.defaultDays,
      defaultDaysSource: cfg.source,
      defaultDaysRaw: cfg.raw,
      cleanupPaused: cfg.cleanupPaused,
      liveMeetings: live.length,
      grantedMeetings: live.filter((m) => m.grants.length > 0).length,
      expiringIn7dMeetings: live.filter(
        (m) => (m.keep.expiresAt! - MOCK_NOW) / 86_400 <= 7,
      ).length,
      expiredMeetings: meetings.filter((m) => expiredNotPurged(m)).length,
      localBytes: sum(live.map((m) => m.sizeBytes ?? 0)),
    },
  }
}

/** 一场会议在「立即清理」里会被删掉什么。资产数按种子里那份分布数。 */
export function cleanupItem(m: Meeting): Record<string, unknown> {
  return {
    meetingId: m.id,
    subMeetingId: MOCK_SUB_MEETING_ID,
    assetCount: sum(Object.values(m.assets).map((a) => a?.got ?? 0)),
    localBytes: m.sizeBytes ?? 0,
  }
}
