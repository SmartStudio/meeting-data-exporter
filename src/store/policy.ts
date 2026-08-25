import type { RowDataPacket } from 'mysql2'
import type { RuleCond } from '../policy/conds'
import type { StackKind, StackRule } from '../policy/stacks'
import type { Pool } from './db'

/**
 * 规则的读侧（阶段 3 · T1）。
 *
 * 返回的就是引擎要的 `StackRule`（`src/policy/stacks.ts`）——这里不再有一套
 * 自己的 `PolicyRule` 形状。中间多一层「store 的规则类型」只会带来一次映射，
 * 而每一次映射都是一次可能悄悄改变判定的机会（旧实现就在这一层把
 * `resource_expr` 的解析失败兜底成 `{}` = 匹配一切）。
 *
 * ## SQL 排序与判定顺序是两件事
 *
 * `ORDER BY kind, priority DESC, id ASC` 与 `sortStackRules` 的口径一致，但
 * **判定顺序的事实源是 `sortStackRules`**，不是这条 SQL：引擎每次求值都会自己
 * 再排一遍。SQL 这一份只保证「读出来的顺序稳定、且与界面上看到的判定顺序一致」，
 * 便于人直接翻 DB 时能对上。两者不同步也不会改变判定结果——`sortStackRules`
 * 还处理了 SQL 排不出来的东西（priority 是脏数据时排到最后）。
 * 索引 `idx_policy_lookup (kind, enabled, priority, id)` 正是按这条查询建的。
 */
export interface PolicyStore {
  /** 三栈的全部启用规则。一次判定要跑三栈时用它，省两次往返 */
  listEnabledRules(): Promise<StackRule[]>
  /** 只取某一栈的启用规则。网关只判 allow 栈，取三栈是白读两栈 */
  listEnabledStackRules(kind: StackKind): Promise<StackRule[]>
}

interface RuleRow extends RowDataPacket {
  id: number
  kind: string
  priority: number
  join_op: string
  conds: unknown
  subject_type: string
  subject_value: string
  asset_types: unknown
  effect: string
  note: string | null
  enabled: number
}

const SELECT_COLUMNS = `id, kind, priority, join_op, conds, subject_type, subject_value,
          asset_types, effect, note, enabled`
const ORDER_BY = 'ORDER BY kind ASC, priority DESC, id ASC'

/**
 * MySQL 的 JSON 列由 mysql2 自动解析为 JS 值，但驱动版本差异可能返回字符串，
 * 因此统一做一次防御性解析。**解析不出来时用的兜底必须落在安全侧**，见下面
 * 两个调用点各自的注释——这不是一个可以随手填 `{}` / `[]` 的参数。
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

/**
 * `conds` 解析失败时的兜底。**绝不能是 `[]`**：空 conds 在求值器里是
 * 「匹配一切」（`conds.ts` 的 `evaluateRule`），一列坏掉的 JSON 会因此把规则
 * 变成放行全部会议的兜底规则——授权中枢里最不该出现的那种静默放行。
 *
 * 这里给一个**不是数组**的值：`evaluateRule` 判 `Array.isArray` 为假 →
 * 这条规则不参与匹配；`describeRuleIssues` 报出「conds 不是数组，这条规则不会
 * 命中任何会议」，管理员在规则列表里看得见。
 *
 * 同理，列里存着 JSON 对象/数字（无 schema 校验的 JSON 列装得下）时也**原样带出**，
 * 不在这里归一化成数组——归一化等于替坏数据编一个能求值的形状。
 */
const CONDS_UNPARSABLE = '__conds_unparsable__' as unknown as RuleCond[]

function mapRow(r: RuleRow): StackRule {
  return {
    id: Number(r.id),
    kind: r.kind as StackKind,
    priority: Number(r.priority),
    enabled: Boolean(r.enabled),
    // join_op 是脏数据时**不归一化**：求值器本来就把认不出的连接词当「且」处理，
    // 但静态检查要能报出「连接词『xor』不认识」。store 一旦悄悄改成 'and'，
    // 管理员在规则列表里就再也看不见这个错。断言只是把列类型带进 CondRule。
    join: r.join_op as StackRule['join'],
    conds: parseJsonColumn<RuleCond[]>(r.conds, CONDS_UNPARSABLE),
    // fetch / archive 是系统级行为，这两列对它们没有意义，存的是空串。
    // 读成 null 而不是 ''：引擎与静态检查里「没有主体」是一种情况，判定理由
    // 里印出来也是 null 而不是一对空引号。
    subjectType: r.subject_type === '' ? null : r.subject_type,
    subjectValue: r.subject_value === '' ? null : r.subject_value,
    // asset_types 解析不出来时兜底成空数组是安全的：引擎对空资产集的结论是
    // 「一类都取不到」（`decisionAllowsAsset` 恒为 false），落在拒绝一侧。
    assetTypes: parseJsonColumn<string[]>(r.asset_types, []),
    effect: r.effect,
    note: r.note,
  }
}

export function createPolicyStore(pool: Pool): PolicyStore {
  return {
    async listEnabledRules() {
      const [rows] = await pool.execute<RuleRow[]>(
        `SELECT ${SELECT_COLUMNS}
           FROM policy_rules
          WHERE enabled = 1
          ${ORDER_BY}`,
      )
      return rows.map(mapRow)
    },

    async listEnabledStackRules(kind) {
      const [rows] = await pool.execute<RuleRow[]>(
        `SELECT ${SELECT_COLUMNS}
           FROM policy_rules
          WHERE kind = ? AND enabled = 1
          ${ORDER_BY}`,
        [kind],
      )
      return rows.map(mapRow)
    },
  }
}
