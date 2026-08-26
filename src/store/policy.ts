import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { evaluateCond, type CondReason, type MeetingFacts, type RuleCond } from '../policy/conds'
import {
  describeStackRuleIssues,
  normalizeAssetTypes,
  normalizeEffect,
  STACK_KIND_LABEL,
  type StackKind,
  type StackRule,
} from '../policy/stacks'
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

  // ── 管理侧（阶段 4 · T2）。判定路径一概不走下面这些方法 ──────────────

  /**
   * 列出规则，**含 disabled 的**，按判定顺序排列，每条带上静态检查结果。
   *
   * 上面两个读法只返回 enabled 的，那是判定路径要的；规则页要的是另一件事——
   * 停用的规则也得显示出来，否则管理员停用一条之后它就从界面上消失、再也开不回来。
   */
  listAllRules(kind?: StackKind): Promise<AdminRule[]>
  /** 单条，规则编辑器与审计用。不存在返回 null */
  getRule(id: number): Promise<AdminRule | null>
  /** 新建。校验不过**拒绝 promise**，一行都不落库 */
  createRule(input: RuleDraft & { now: number }): Promise<AdminRule>
  /**
   * 改。**合并到当前行之后整体校验**，不是只校验传进来的那几个字段——
   * 规则的合法性有跨字段的部分（allow 栈必须有采集程序主体、fetch 栈必须没有），
   * 只看 patch 会让「把 allow 改成 fetch、主体忘了清」这类改动溜过去。
   *
   * 规则不存在返回 null（不抛），校验不过则拒绝 promise 且旧行一个字段都不改。
   */
  updateRule(id: number, patch: RulePatch): Promise<AdminRule | null>
  /**
   * 启用 / 停用。**不做内容校验**，见 `createPolicyStore` 里那条注释：
   * 出事时「把这条规则关掉」是唯一能立刻止血的动作，不能因为这条规则本身是坏的
   * 就把这个动作也一并锁死。
   */
  setEnabled(id: number, enabled: boolean, now: number): Promise<AdminRule | null>
  /**
   * 删。返回**被删掉的那条规则的完整内容**，不是布尔——`policy_rules` 没有软删除的列，
   * 删完这条规则在库里就不存在了，「它当时长什么样」只能由调用方记进 `audit_log`
   * （计划 §1 约束 6）。不把内容带出来，这条痕迹就无从记起。
   */
  deleteRule(id: number): Promise<AdminRule | null>
}

/**
 * 管理员填的一条规则。字段与 `StackRule` 对齐（同名同义），差别只在这里没有 `id`
 * 与 `enabled` 之外的运行期信息——**不另起一套字段名**，两套名字之间的映射
 * 正是这个文件的头部注释在讲的那种「每一次映射都是一次可能悄悄改变判定的机会」。
 */
export interface RuleDraft {
  kind: StackKind
  priority: number
  join: 'and' | 'or'
  conds: RuleCond[]
  /** allow 栈必须是 `'program'`；fetch / archive 必须留空（null） */
  subjectType: string | null
  /** allow 栈对应 `service_accounts.id` */
  subjectValue: string | null
  assetTypes: string[]
  effect: string
  note: string | null
  /** 建这条规则的管理员（`admin_accounts.id`）。改规则时不会被改写 */
  createdBy?: string | null
  /** 不给时新建为启用 */
  enabled?: boolean
}

/** 改规则的入参。`createdBy` 不在里面：那一列记的是「谁建的」，改不得 */
export type RulePatch = Partial<Omit<RuleDraft, 'createdBy'>> & { now: number }

/**
 * 规则页要的一行：引擎要的 `StackRule` + 管理侧的元数据 + 静态检查结果。
 *
 * `issues` 是 `describeStackRuleIssues` 的原样结果，读侧带出来是必须的（计划 §3 T2
 * 验收 3）：一条建完就静默失效的规则——条件恒不成立、准许采集却没列出任何资产类型——
 * 在界面上必须看得见，否则管理员会以为它生效了。**写侧拦不住的那些问题正是它报的**，
 * 两者的分工见 `validateDraft`。
 */
export interface AdminRule extends StackRule {
  createdBy: string | null
  createdAt: number
  updatedAt: number
  issues: string[]
}

/**
 * 写侧校验不通过。**必须由 async 方法拒绝 promise 抛出，不许同步抛**——
 * `PolicyStore` 的方法全是 async，同步抛会绕过调用方的 `.catch()`，
 * 阶段 3 的 `putOverride` 踩过这个坑（见 `grants.ts` 里那条注释）。
 *
 * `issues` 是逐条的中文问题描述，可直接下发给规则编辑器逐条标红，
 * 所以校验**不短路**：一次把能说的都说完，别让管理员改一条提交一次。
 */
export class PolicyRuleInvalid extends Error {
  constructor(readonly issues: string[]) {
    super(`policy rule rejected: ${issues.join('；')}`)
    this.name = 'PolicyRuleInvalid'
  }
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
 *
 * 写侧是同一件事的另一面：`validateDraft` **拒绝空 conds 与非数组 conds**，
 * 不让这种规则从控制台进来。读侧堵的是已经在库里的坏数据（库外还有别的写入者、
 * 或者数据损坏），写侧堵的是新的——两道都要，因为这是数据出境的闸门。
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

// ── 管理侧的行映射 ──────────────────────────────────────────────────────

interface AdminRuleRow extends RuleRow {
  created_by: string | null
  created_at: number
  updated_at: number
}

/** 判定路径不需要这三列，所以只有管理侧的查询多读它们，热路径的 SELECT 一个字不改 */
const ADMIN_COLUMNS = `${SELECT_COLUMNS}, created_by, created_at, updated_at`

function mapAdminRow(r: AdminRuleRow): AdminRule {
  const rule = mapRow(r)
  return {
    ...rule,
    createdBy: r.created_by,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    // 坏行也要能列出来（管理员正是要看见它才能修），所以这里只描述问题、不抛
    issues: describeStackRuleIssues(rule),
  }
}

// ── 写侧校验 ────────────────────────────────────────────────────────────

/**
 * ## 写侧拒什么、只报什么
 *
 * 这条线不是「越严越好」，两边各有各的事故：
 *
 * **拒绝**（写不进去）——两类：
 *   a. **判定会比管理员的本意更宽**：空 conds（求值器里是「匹配一切」，
 *      一条空条件的 allow 规则就是放行全库的兜底规则）、非数组 conds。
 *   b. **存进去的东西和管理员填的不是一回事**：effect 是脏数据（读侧会替它落到
 *      本栈安全侧）、资产类型名不认识（读侧会丢掉那一类）、note 超列宽（MySQL 非严格
 *      模式下会截断）、priority 不是整数（MySQL 会取整，判定顺序跟着变）、
 *      kind / join_op / 主体填错。
 *   还有条件里的拼写错误（未知字段、不支持的运算符、值类型不对）：这三种没有任何
 *   正当用途，而它们造出来的死规则在 allow 栈里可能让一条本该拦住的 deny 落空、
 *   由低优先级的 allow 接手。写侧是唯一一次「管理员就站在这里、能当场改」的机会。
 *
 * **只报不拒**（照写，问题进 `AdminRule.issues`）——「这条规则没用」那一类：
 *   `dept` 条件当前没有数据源（企微通讯录未接入）——那是系统能力缺口，规则本身没写错，
 *   管理员可以先配着等通讯录接上；准许采集却没列出任何资产类型——它落在安全侧
 *   （一类都取不到），不是「比本意更宽」。这些读侧本来就要显示（验收 3），
 *   在写侧一并拦掉只会让人配不成规则。
 *
 * 校验一律走 `stacks.ts` / `conds.ts` 已有的那几个函数，**不另写一套判断**：
 * 同一批语义在这个项目里已经有过多套写法，两份逻辑迟早漂移，而漂移的表现是
 * 「写进去时说合法、求值时不匹配」。
 */
const RULE_KINDS: ReadonlySet<string> = new Set<string>(['fetch', 'archive', 'allow'])

/** `policy_rules.priority` 是 INT。超范围时 MySQL 非严格模式会截到边界值 */
const PRIORITY_MIN = -2_147_483_648
const PRIORITY_MAX = 2_147_483_647

/**
 * 探针事实。`evaluateCond` 在碰 facts 之前就把形状 / 字段 / 运算符 / 值查完了
 * （`conds.ts` 里那四个 return 都在 switch 之前），所以拿任意一组事实探一次，
 * 得到的下面那四种 reason 与会议数据无关，是纯静态结论。
 *
 * 这样写而不是自己再照着 `CONDITION_FIELDS` 判一遍：值层的阻断性检查
 * （`blockingValueIssue`）是 `conds.ts` 的模块私有函数，复制一份就是第二套判断。
 */
const PROBE_FACTS: MeetingFacts = {
  title: '',
  hostUserId: '',
  dept: null,
  startTime: 0,
  endTime: 0,
  recordEndTime: 0,
  archived: false,
}

/** 与会议数据无关、纯粹是「填错了」的那几种。`no_data_source` / `not_matched` 不在内 */
const BLOCKING_COND_REASONS: ReadonlySet<CondReason> = new Set<CondReason>([
  'malformed',
  'unknown_field',
  'unknown_op',
  'bad_value',
])

/**
 * 列宽检查。按**码点**数，与 MySQL 的 VARCHAR(n) 一致（JS 的 `.length` 数的是
 * UTF-16 码元，一个 emoji 会算成 2）。
 *
 * 为什么值得单独拦一道：MySQL 非严格模式下超长是**静默截断**。被截掉一半的 note
 * 会原样出现在每一条判定理由里（spec §6.3），而截断在界面上看不出来。
 */
function checkColumnWidth(issues: string[], label: string, value: string, max: number): void {
  const chars = [...value].length
  if (chars > max) {
    issues.push(`${label}有 ${chars} 个字符，超过列宽 ${max}——写进去会被数据库截断，请先改短`)
  }
}

function validateDraft(d: RuleDraft, now: number): string[] {
  const issues: string[] = []

  if (!Number.isInteger(now) || now <= 0) {
    // 0 / NaN 会写出一条「1970 年建的」规则，审计里再也说不出它是什么时候进来的
    issues.push(`写入时刻必须是正整数 unix 秒时间戳，收到「${String(now)}」`)
  }

  const kindOk = RULE_KINDS.has(d.kind)
  if (!kindOk) {
    issues.push(
      `kind「${String(d.kind)}」不是三栈之一（fetch / archive / allow），` +
        '这条规则不会参与任何判定；kind 填错没有安全侧可落，只能拒绝写入',
    )
  }

  if (!Number.isInteger(d.priority) || d.priority < PRIORITY_MIN || d.priority > PRIORITY_MAX) {
    issues.push(
      `priority「${String(d.priority)}」必须是 ${PRIORITY_MIN} ~ ${PRIORITY_MAX} 之间的整数——` +
        '小数会被数据库取整、超范围会被截到边界，两种都会悄悄改变判定顺序',
    )
  }

  if (d.join !== 'and' && d.join !== 'or') {
    issues.push(
      `连接词「${String(d.join)}」不认识（只能是 and / or）；` +
        '求值器会把它当「且」处理，那多半不是这条规则想写的意思',
    )
  }

  if (!Array.isArray(d.conds)) {
    issues.push('conds 不是数组，这条规则不会命中任何会议')
  } else if (d.conds.length === 0) {
    issues.push(
      'conds 是空数组：空条件在求值器里是「匹配一切」，这等于一条覆盖全部会议的兜底规则。' +
        '要写全放行/全拉取的兜底规则，请显式写一个恒真的条件，不能靠「什么都不填」',
    )
  } else {
    d.conds.forEach((cond, i) => {
      const ev = evaluateCond(cond, PROBE_FACTS, 0)
      if (BLOCKING_COND_REASONS.has(ev.reason)) {
        issues.push(`第 ${i + 1} 个条件写不进去：${ev.detail}`)
      }
    })
  }

  // 资产类型名不认识 → 读侧会把那一类丢掉，写侧不给这个待遇：
  // 丢掉的那一类在界面上看起来像是已经授权出去了
  for (const issue of normalizeAssetTypes(d.assetTypes).issues) {
    issues.push(`asset_types 写不进去：${issue.replace('，已忽略', '')}`)
  }

  if (kindOk) {
    const { issue: effectIssue } = normalizeEffect(d.kind, d.effect)
    if (effectIssue !== null) {
      // normalizeEffect 的措辞是读侧的（「按本栈的安全侧…处理」）。写侧不落这个兜底：
      // 读侧那样做是为了容忍库里已有的坏行，一次新的写入没有这个理由
      issues.push(`effect 写不进去：${effectIssue}——写侧不替管理员落这个兜底，请改正后重试`)
    }

    if (d.kind === 'allow') {
      if (d.subjectType !== 'program') {
        issues.push(
          `采集权限规则的主体必须是采集程序（subject_type = 'program'），` +
            `当前是「${String(d.subjectType)}」，这条规则不会对任何程序生效`,
        )
      }
      if (typeof d.subjectValue !== 'string' || d.subjectValue === '') {
        issues.push('采集权限规则没有指定采集程序（subject_value 为空），这条规则不会对任何程序生效')
      }
    } else if (
      (typeof d.subjectType === 'string' && d.subjectType !== '') ||
      (typeof d.subjectValue === 'string' && d.subjectValue !== '')
    ) {
      issues.push(
        `${STACK_KIND_LABEL[d.kind]}是系统级行为，不针对任何主体；` +
          `写侧不接受带主体的规则——一条挂着「${String(d.subjectType)}:${String(d.subjectValue)}」的规则` +
          '在界面上看起来限定了范围，实际对全部会议生效（引擎会显式忽略这个主体）',
      )
    }
  }

  if (typeof d.effect === 'string') checkColumnWidth(issues, 'effect', d.effect, 255)
  if (d.note !== null && d.note !== undefined) {
    if (typeof d.note !== 'string') issues.push(`note 必须是字符串或 null，收到「${String(d.note)}」`)
    else checkColumnWidth(issues, 'note', d.note, 255)
  }
  if (typeof d.subjectValue === 'string') checkColumnWidth(issues, 'subject_value', d.subjectValue, 128)
  if (typeof d.createdBy === 'string') checkColumnWidth(issues, 'created_by', d.createdBy, 128)

  return issues
}

/** 校验不过就拒绝 promise。调用点必须在 async 函数体内，否则就成了同步抛 */
function assertValidDraft(d: RuleDraft, now: number): void {
  const issues = validateDraft(d, now)
  if (issues.length > 0) throw new PolicyRuleInvalid(issues)
}

/** 域模型的 null 主体写回库里的空串（列是 NOT NULL DEFAULT ''，见 004 的表头注释） */
function subjectColumn(v: string | null | undefined): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 在一条连接上开事务跑一段，出错回滚。回滚失败不许盖掉真正的根因。
 *
 * 与 `grants.ts` 里那个同名函数是一样的十行——两个 store 各自独立，
 * 等到第三个也要用时再提到 `db.ts` 里去，现在提取只是多一层间接。
 */
async function inTransaction<T>(pool: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const out = await fn(conn)
    await conn.commit()
    return out
  } catch (err) {
    try {
      await conn.rollback()
    } catch {
      /* 忽略：根因是 err */
    }
    throw err
  } finally {
    conn.release()
  }
}

export function createPolicyStore(pool: Pool): PolicyStore {
  type Queryable = Pick<Pool, 'execute'>

  async function selectAdminRule(
    conn: Queryable,
    id: number,
    forUpdate = false,
  ): Promise<AdminRule | null> {
    const [rows] = await conn.execute<AdminRuleRow[]>(
      `SELECT ${ADMIN_COLUMNS} FROM policy_rules WHERE id = ? ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    )
    return rows[0] ? mapAdminRow(rows[0]) : null
  }

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

    async listAllRules(kind) {
      // enabled 不进 WHERE：停用的规则也要显示，位置就在它启用时会站的那一格，
      // 管理员因此看得出「把它开回来会插在谁前面」
      const [rows] =
        kind === undefined
          ? await pool.execute<AdminRuleRow[]>(`SELECT ${ADMIN_COLUMNS} FROM policy_rules ${ORDER_BY}`)
          : await pool.execute<AdminRuleRow[]>(
              `SELECT ${ADMIN_COLUMNS} FROM policy_rules WHERE kind = ? ${ORDER_BY}`,
              [kind],
            )
      return rows.map(mapAdminRow)
    },

    getRule(id) {
      return selectAdminRule(pool, id)
    },

    // 声明成 async 而不是同步箭头：校验失败要**拒绝 promise**，不是同步抛。
    // 同步抛会绕过调用方的 .catch()，在一个全是 async 方法的接口里制造一个例外
    // （阶段 3 的 putOverride 踩过，见 grants.ts）
    async createRule(input) {
      const { now } = input
      assertValidDraft(input, now)
      const [res] = await pool.execute<ResultSetHeader>(
        `INSERT INTO policy_rules
           (kind, priority, join_op, conds, subject_type, subject_value, asset_types, effect,
            note, created_by, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.kind,
          input.priority,
          input.join,
          JSON.stringify(input.conds),
          subjectColumn(input.subjectType),
          subjectColumn(input.subjectValue),
          JSON.stringify(input.assetTypes),
          input.effect,
          input.note,
          input.createdBy ?? null,
          input.enabled === false ? 0 : 1,
          now,
          now,
        ],
      )
      const created = await selectAdminRule(pool, res.insertId)
      if (created === null) {
        // 刚插进去就读不到：只可能是同一瞬间被别的写入者删了。响亮地报出来，
        // 不要返回一个我们凭 input 拼出来的「假装是库里那一行」的对象
        throw new Error(`policy rule #${res.insertId} vanished right after insert`)
      }
      return created
    },

    async updateRule(id, patch) {
      const { now } = patch
      return inTransaction(pool, async (conn) => {
        // FOR UPDATE 把并发的两次编辑串起来。没有它，两个管理员各读一份、各写一份，
        // 后写的那次会带着**过期的快照**覆盖回去，先写的那次改动就此消失——
        // 而这里改的是数据出境的闸门，一次静默丢失的改动是查不出来的
        const current = await selectAdminRule(conn, id, true)
        if (current === null) return null

        // 合并到当前行之后整体校验。current.conds 可能是 CONDS_UNPARSABLE 那个哨兵
        //（非数组），此时除非 patch 里把 conds 一并改对，否则整条改不动——
        // 这正是想要的：坏行要修就得修利索。真要先止血，走 setEnabled(false)
        const merged: RuleDraft = {
          kind: patch.kind ?? current.kind,
          priority: patch.priority ?? current.priority,
          join: patch.join ?? (current.join as 'and' | 'or'),
          conds: patch.conds ?? current.conds,
          subjectType: patch.subjectType !== undefined ? patch.subjectType : current.subjectType,
          subjectValue: patch.subjectValue !== undefined ? patch.subjectValue : current.subjectValue,
          assetTypes: patch.assetTypes ?? current.assetTypes,
          effect: patch.effect ?? current.effect,
          note: patch.note !== undefined ? patch.note : current.note,
          enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
        }
        assertValidDraft(merged, now)

        await conn.execute<ResultSetHeader>(
          `UPDATE policy_rules
              SET kind = ?, priority = ?, join_op = ?, conds = ?, subject_type = ?,
                  subject_value = ?, asset_types = ?, effect = ?, note = ?, enabled = ?,
                  updated_at = ?
            WHERE id = ?`,
          [
            merged.kind,
            merged.priority,
            merged.join,
            JSON.stringify(merged.conds),
            subjectColumn(merged.subjectType),
            subjectColumn(merged.subjectValue),
            JSON.stringify(merged.assetTypes),
            merged.effect,
            merged.note,
            merged.enabled === false ? 0 : 1,
            now,
            id,
          ],
        )
        // created_at / created_by 不在 SET 里：那两列记的是「谁什么时候建的」，改不得
        return selectAdminRule(conn, id)
      })
    },

    async setEnabled(id, enabled, now) {
      if (!Number.isInteger(now) || now <= 0) {
        throw new PolicyRuleInvalid([`写入时刻必须是正整数 unix 秒时间戳，收到「${String(now)}」`])
      }
      // **故意不校验规则内容**：一条 conds 坏掉的规则照样要停得掉。
      // 出事时「把这条规则关掉」是唯一能立刻止血的动作，若它也要先过校验，
      // 恰恰是最该关掉的那条规则会变成关不掉的
      await pool.execute<ResultSetHeader>(
        'UPDATE policy_rules SET enabled = ?, updated_at = ? WHERE id = ?',
        [enabled ? 1 : 0, now, id],
      )
      // 不看 affectedRows：MySQL 默认只数「真的改了的行」，把一次「本来就是这个状态」
      // 的重复点击报成「规则不存在」。重读一次，读得到就是存在
      return selectAdminRule(pool, id)
    },

    async deleteRule(id) {
      // 先读后删：`policy_rules` 没有软删除的列，删完内容就没了，
      // 调用方要靠这份内容把「删掉的是什么」记进 audit_log
      const existing = await selectAdminRule(pool, id)
      if (existing === null) return null
      const [res] = await pool.execute<ResultSetHeader>('DELETE FROM policy_rules WHERE id = ?', [id])
      // 读到了却删不到：这一瞬间别人已经删过了。报 null（这次调用没删掉任何东西），
      // 免得调用方按「我删的」记一条审计
      return res.affectedRows > 0 ? existing : null
    },
  }
}
