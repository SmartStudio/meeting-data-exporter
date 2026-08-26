import type { AssetKey, Consumer, Meeting } from '../types'

/**
 * 迁自原型的 `CONSUMERS`。
 *
 * 原来还有一个 `scope` 字段（'AI 纪要 + 完整转写' 一类），阶段 5 · F4 连同
 * `Consumer.scope` 一起删了：真实的 `GET /api/v1/admin/programs` 不下发它，
 * 留着就是拿一个配置串冒充"这个程序实际能取到什么"（spec.md §4.5）。
 */
export const CONSUMERS: Consumer[] = [
  { id: 'kb-indexer', name: '知识库索引器' },
  { id: 'daily-digest', name: '简报机器人' },
  { id: 'dw-sync', name: '数据仓库同步' },
]

/**
 * 「这个程序实际能取到什么」——`GET /programs/:id/inventory`。
 *
 * `assetTypes` 是**三个「与」求交之后的结果**（授权范围 ∩ 规则允许 ∩ 实际存在），
 * 不是某一处的配置值。spec §4.5 那句话的全部价值在这里，所以这份种子里它逐个
 * 程序不同，且窄于"八类全给"。
 */
const REACH: Record<string, AssetKey[]> = {
  'kb-indexer': ['ai_minutes', 'transcript'],
  'daily-digest': ['ai_minutes', 'ai_topic_minutes', 'transcript'],
  'dw-sync': ['ai_ds_minutes'],
}

/** 「快到期」的口径，与后端同一个数。 */
const EXPIRING_SOON_DAYS = 7

/**
 * 一场已授权的会议为什么现在取不到。
 *
 * 每一条都要带上 `remedy`（去哪儿修）——「取不到」而不说去哪儿修，管理员只能
 * 一页页翻。这几个 code 与后端的枚举逐字一致。
 */
function blockersFor(m: Meeting): Array<{ code: string; remedy: string; reason: string }> {
  const out: Array<{ code: string; remedy: string; reason: string }> = []
  if (m.allow === 'deny') {
    out.push({
      code: 'rule_denied',
      remedy: 'rules',
      reason: m.why.allow.text,
    })
  }
  if (m.keep.filesGone) {
    out.push({
      code: 'local_purged',
      remedy: 'nas',
      reason: '本地文件已在保留期结束时清理，NAS 上的副本不通过采集接口对外提供。',
    })
  } else if (m.keep.archivedAt === null) {
    out.push({
      code: 'no_local_files',
      remedy: 'pipeline',
      reason: m.why.archive.text,
    })
  }
  return out
}

function item(m: Meeting, program: string, nowSec: number, shiftSec: number): Record<string, unknown> {
  const expiresAt = m.keep.expiresAt === null ? null : m.keep.expiresAt + shiftSec
  const idMatch = /#(\d+)/.exec(m.why.allow.text)
  return {
    meetingId: m.id,
    subMeetingId: '',
    assetTypes: REACH[program] ?? [],
    expiresAt,
    expiringSoon:
      expiresAt !== null && expiresAt - nowSec <= EXPIRING_SOON_DAYS * 86_400 && expiresAt > nowSec,
    overridden: m.hand.length > 0,
    decision: {
      effect: m.allow,
      reason: m.why.allow.text,
      ruleId: idMatch === null ? null : Number(idMatch[1]),
      note: null,
      source: m.why.allow.by === 'rule' || m.why.allow.by === 'deny' ? 'rule' : 'default',
    },
    blockers: blockersFor(m),
  }
}

/**
 * **只看已经授权给它的那几场**。
 *
 * 「被挡下」说的是"授权在，但现在取不到"（采集授权页那句「另有 N 场已授权但
 * 现在取不到」），不是"全库里它没被授权的那些"——后者是一个几乎等于全库的数，
 * 放进这个清单只会把真正需要处理的那几场淹掉。
 */
export function buildInventory(
  programId: string,
  meetings: readonly Meeting[],
  opts: { nowSec: number; shiftSec: number },
): Record<string, unknown> {
  const granted = meetings.filter((m) => m.grants.includes(programId))
  const reachable = granted.filter((m) => m.allow === 'allow' && !m.keep.filesGone && m.keep.archivedAt !== null)
  const blocked = granted.filter((m) => !reachable.includes(m))

  const fetchable = reachable.map((m) => item(m, programId, opts.nowSec, opts.shiftSec))
  return {
    programId,
    now: opts.nowSec,
    fetchableCount: fetchable.length,
    blockedCount: blocked.length,
    expiringSoonCount: fetchable.filter((i) => i.expiringSoon === true).length,
    expiringSoonDays: EXPIRING_SOON_DAYS,
    assetTypes: REACH[programId] ?? [],
    fetchable,
    blocked: blocked.map((m) => item(m, programId, opts.nowSec, opts.shiftSec)),
  }
}
