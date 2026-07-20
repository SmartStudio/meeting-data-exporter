import type { Pool } from './db'

export interface AuditEntry {
  occurredAt: number
  actorType: string
  actorId: string
  action: string
  meetingId: string | null
  assetId: string | null
  assetType: string | null
  decision: 'allow' | 'deny'
  matchedRuleId: number | null
  clientKind: string | null
}

export interface AuditStore {
  record(entry: AuditEntry): Promise<void>
}

export function createAuditStore(pool: Pool): AuditStore {
  return {
    async record(e) {
      await pool.execute(
        `INSERT INTO audit_log
           (occurred_at, actor_type, actor_id, action, meeting_id, asset_id,
            asset_type, decision, matched_rule, client_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [e.occurredAt, e.actorType, e.actorId, e.action, e.meetingId, e.assetId,
         e.assetType, e.decision, e.matchedRuleId, e.clientKind],
      )
    },
  }
}
