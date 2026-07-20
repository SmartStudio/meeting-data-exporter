import type { ActorIdentity, AssetType } from '../domain/types'
import type { AuditStore } from '../store/audit'

export interface DownloadUrlAudit {
  actor: ActorIdentity
  meetingId: string
  assetId: string
  assetType: AssetType
  decision: 'allow' | 'deny'
  matchedRuleId: number | null
  clientKind: string
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
        assetType: reason ?? null,
        decision: success ? 'allow' : 'deny',
        matchedRuleId: null,
        clientKind: null,
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
        assetType: String(count),
        decision: 'allow',
        matchedRuleId: null,
        clientKind: null,
      })
    },
  }
}
