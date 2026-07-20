import type { RowDataPacket } from 'mysql2'
import type { Pool } from './db'

export interface PolicyRule {
  id: number
  priority: number
  subjectType: 'user' | 'department' | 'role'
  subjectValue: string
  resourceExpr: Record<string, unknown>
  assetTypes: string[]
  effect: 'allow' | 'deny'
}

export interface PolicyStore {
  listEnabledRules(): Promise<PolicyRule[]>
}

interface RuleRow extends RowDataPacket {
  id: number
  priority: number
  subject_type: string
  subject_value: string
  resource_expr: unknown
  asset_types: unknown
  effect: string
}

/**
 * MySQL 的 JSON 列由 mysql2 自动解析为 JS 值，但驱动版本差异可能返回字符串，
 * 因此统一做一次防御性解析。
 */
function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

export function createPolicyStore(pool: Pool): PolicyStore {
  return {
    async listEnabledRules() {
      const [rows] = await pool.execute<RuleRow[]>(
        `SELECT id, priority, subject_type, subject_value, resource_expr, asset_types, effect
           FROM policy_rules
          WHERE enabled = 1
          ORDER BY priority ASC, id ASC`,
      )
      return rows.map((r) => ({
        id: Number(r.id),
        priority: r.priority,
        subjectType: r.subject_type as PolicyRule['subjectType'],
        subjectValue: r.subject_value,
        resourceExpr: parseJsonColumn<Record<string, unknown>>(r.resource_expr, {}),
        assetTypes: parseJsonColumn<string[]>(r.asset_types, []),
        effect: r.effect as PolicyRule['effect'],
      }))
    },
  }
}
