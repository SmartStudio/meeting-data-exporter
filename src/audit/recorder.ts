/**
 * 网关侧「程序取数据」那一族的审计写入（下载地址、登录、列会议）。
 *
 * ## detail 列（阶段 4 · T15）
 *
 * 这三个方法从前都在**硬塞 `asset_type`**：`recordLogin` 往那一列塞登录失败原因、
 * `recordListing` 往那一列塞会议条数——`audit_log` 在 `detail` 列出现之前，
 * 那是唯一一个还空着、又能装几个字的列。代价是读侧不得不按「有没有 asset_id」
 * 去猜那一列到底是资产类型还是自由文本（见 `handlers/console/audit.ts`）。
 *
 * `migrations/008` 把 `detail TEXT` 加了出来之后，自由文本一律走 `detail`，
 * `asset_type` 回到它的本义：这份资产是哪一类。
 *
 * **既有记录不动、也动不了**：库里那些老行的明细还在 `asset_type` 上，读侧因此
 * 保留了一条回退（`detail IS NULL` 且没有 `asset_id` 时读 `asset_type`）。
 * 那条回退不是历史包袱，是让阶段 4 之前的审计仍然读得出来的唯一办法。
 */
import type { ActorIdentity, AssetType } from '../domain/types'
import { buildAuditDetail, type AuditStore } from '../store/audit'

export interface DownloadUrlAudit {
  actor: ActorIdentity
  /**
   * 写入 audit_log.meeting_id 列，但语义是 meetingRecordId（record 维度），
   * 不是 Tencent 的 meeting_id——调用方（http/handlers/meetings.ts 的
   * downloadUrl）在缓存命中与未命中两条路径下都只保证拿得到 meetingRecordId，
   * 因此统一用它，避免同一列在不同路径混入不同维度的 ID。详见
   * migrations/001_init.sql 里 audit_log.meeting_id 的列注释。
   */
  meetingId: string
  assetId: string
  assetType: AssetType
  decision: 'allow' | 'deny'
  matchedRuleId: number | null
  clientKind: string
  /**
   * 这次判定的**理由原文**，进 `detail` 列。spec §4.10 要求「被拒绝的记录写明
   * 拒绝原因」，而在 `detail` 列出现之前，这句话根本没有地方可放——`matched_rule`
   * 只答得出「命中了第几条」，答不出「为什么这条不放行」。
   *
   * 值直接来自 `policy/access.ts` 的 `allowsAsset().reason`：那是判定引擎自己给出
   * 的一句话，不是这一层的转述。
   *
   * **给不出理由时传 `null`，不要在这里编一句**（阶段 4 计划 §1 约束 3）：
   * 编出来的理由对不回任何一条真跑过的判定，而它在界面上看起来与真理由一模一样。
   */
  reason: string | null
}

export interface AuditRecorder {
  recordDownloadUrl(input: DownloadUrlAudit): Promise<void>
  recordLogin(actor: ActorIdentity, success: boolean, reason?: string): Promise<void>
  recordListing(actor: ActorIdentity, count: number): Promise<void>
}

/** 管控若无法事后核查，等于没有管控 */
export function createAuditRecorder(store: AuditStore, now: () => number): AuditRecorder {
  return {
    async recordDownloadUrl(i) {
      await store.record({
        occurredAt: now(),
        actorType: i.actor.kind,
        actorId: i.actor.tmUserId,
        action: 'issue_download_url',
        meetingId: i.meetingId,
        assetId: i.assetId,
        assetType: i.assetType,
        decision: i.decision,
        matchedRuleId: i.matchedRuleId,
        clientKind: i.clientKind,
        detail: i.reason === null ? null : buildAuditDetail({ text: i.reason }),
      })
    },

    async recordLogin(actor, success, reason) {
      await store.record({
        occurredAt: now(),
        actorType: actor.kind,
        actorId: actor.tmUserId,
        action: 'login',
        meetingId: null,
        assetId: null,
        // 登录与任何一份资产都无关，这一列本来就该是空的
        assetType: null,
        decision: success ? 'allow' : 'deny',
        matchedRuleId: null,
        clientKind: null,
        detail: reason === undefined ? null : buildAuditDetail({ text: reason }),
      })
    },

    async recordListing(actor, count) {
      await store.record({
        occurredAt: now(),
        actorType: actor.kind,
        actorId: actor.tmUserId,
        action: 'list_meetings',
        meetingId: null,
        assetId: null,
        assetType: null,
        decision: 'allow',
        matchedRuleId: null,
        clientKind: null,
        // 数字也留一份结构化的：从前 asset_type 里存的就是一个裸数字，
        // 换成人话之后若不另留 `{ count }`，「这次列出了几场」就只能靠正则从
        // 一句中文里抠出来
        detail: buildAuditDetail({ text: `列出 ${count} 场会议`, data: { count } }),
      })
    },
  }
}
