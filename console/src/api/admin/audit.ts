/**
 * 操作审计（audit.ts 的列表端点）。spec.md §4.10。
 *
 * 源头是 `src/http/handlers/console/audit.ts` 与 `src/store/audit.ts`，
 * 下面每一条约定都能在那两个文件里找到出处。
 *
 * ## 时间是 unix 秒，不是毫秒
 *
 * `audit_log.occurred_at` 的唯一写入者是 `src/audit/recorder.ts`，取的是
 * `Math.floor(Date.now() / 1000)`。阶段 4 有**两个独立的实施者**在这一列上
 * 栽过（那份注释一度写成毫秒），错的方向很隐蔽：当成毫秒算窗口下界会得到
 * 一个负数，于是拉的是全表，而界面上一切正常。
 *
 * 本文件所有时间字段（`at` / `window.from` / `window.to`，以及传出去的
 * `from` / `to`）**一律是秒**。要变成人能读的串就走 `lib/format.ts`，
 * 不要在别处乘 1000。
 *
 * ## 筛选维度以后端为准，前端不补内存版
 *
 * 后端支持的六个维度就是下面 `AuditFilter` 的六个字段。**没有全文搜索**
 * ——原型那个「搜操作者 / 动作 / 会议号」的输入框在真 API 上没有对应参数。
 * 在前端补一个内存版的模糊搜索，翻到第二页就失效（第二页是另一次请求，
 * 只带回那一页的 50 条），而用户看不出来。所以这一层只暴露后端真有的东西，
 * 缺的记进任务报告。
 *
 * ## 空集合 ≠ 不筛选
 *
 * `?actorKind=` / `?action=,` 拆出空集合时后端返回 400 `empty_filter`，
 * 刻意不当成「不筛选」——两者在界面上长得一模一样（都是一张空表）。
 * 所以空数组在这里直接不发这个键。
 *
 * ## 类型定义在本文件（计划 G-b）
 *
 * `AuditRow` 一族只有操作审计页一个消费者，往 `api/types.ts` 里塞就是把它
 * 变成第二个汇聚点——阶段 5 有七个页面任务并行，那就是七路冲突。
 */

import { apiGet } from '../client'
import { reader } from '../validate'

const BASE = '/api/v1/admin'
const ENDPOINT = `GET ${BASE}/audit`

/* ── 常量：照抄后端，不在页面里各写一个 ────────────────────────── */

/** `AUDIT_DEFAULT_LIMIT`（`src/store/audit.ts`）。不传 limit 时后端用它。 */
export const AUDIT_DEFAULT_LIMIT = 50

/** `AUDIT_MAX_LIMIT`。超了后端 **400 而不是静默钳制**——静默钳制的结果是
 *  「我要 500 条，给了我 200 条」，而调用方会以为审计就这么多条。 */
export const AUDIT_MAX_LIMIT = 200

/**
 * 能拿来筛的三种操作者色块（spec §4.10：`prog` 蓝 / `person` 中性 / `sys` 灰）。
 *
 * **`unknown` 不在其中**：它是「不在后端那张映射表里的 actor_type」，是一个
 * 补集，`IN (...)` 表达不出来，传上去后端回 400 `invalid_actor_kind`。
 * 这不是前端可以绕过去的——绕过去的唯一办法是把整页拉回来自己筛，
 * 那在第二页上就是错的。界面上要说清这件事，见 `pages/Audit`。
 */
export const AUDIT_FILTERABLE_ACTOR_KINDS = ['prog', 'person', 'sys'] as const

export type AuditFilterActorKind = (typeof AUDIT_FILTERABLE_ACTOR_KINDS)[number]

/* ── 类型 ───────────────────────────────────────────────────────── */

/**
 * 操作者。
 *
 * `kind` 不收窄成联合而是留 `string`：后端现在给 `prog` / `person` / `sys` /
 * `unknown` 四种，将来多一种色块时，前端应当把它**原样显示出来**，
 * 而不是因为不在枚举里就悄悄折成 `unknown`——那是把一次人的操作说成认不出，
 * 与后端在 `actorKindOf` 里拒绝乱塞是同一个道理。
 *
 * `type` 是库里的原值（`service_account` / `wecom_user` / `admin` / …），
 * 展开明细时要显示它：色块是概括，原值才是能对回库里的那一个。
 */
export interface AuditActor {
  kind: string
  type: string
  id: string
  /**
   * 人名。只有管理员账号解析得出（后端查 `admin_accounts`），其余一律 null。
   *
   * **null 时显示 `id`，不许拿 id 冒充人名**——同 `AuditObjectRef.title`
   * 补不齐时不拿 id 顶上是同一条：一个看着像名字的 id 会让人以为这个人就叫这个。
   * 账号删掉之后它的历史记录仍然只有 id，那时 id 就是仅有的线索。
   */
  name: string | null
}

/**
 * 「对象」列。`audit_log` 只存一个 ID，标题由后端批量补齐。
 *
 * `idKind` 说明这个 ID 是哪个维度的（`issue_download_url` 存的是
 * `meeting_record_id`，其余存 `meeting_id`）。`meetingId` 是归一化到会议维度
 * 的那一个，**反查不到时是 null**——后端刻意不拿 `id` 顶上，前端也不许。
 *
 * `title` 为 null = 补不齐标题。界面上要说「标题缺失」，不能拿 ID 冒充标题：
 * 一个看着像标题的 ID 会让管理员以为这场会议就叫这个名字。
 */
export interface AuditObjectRef {
  id: string
  idKind: string
  meetingId: string | null
  title: string | null
  code: string | null
}

/** 这条记录涉及的那份资产。整块为 null = 这次动作的对象不是某一份资产。 */
export interface AuditAssetRef {
  id: string
  type: string | null
}

/**
 * 结果。`decision` 是库里的原值，`kind` 是后端归的三档。
 *
 * `kind === 'unknown'` 是**库里出现了既不是 allow 也不是 deny 的脏值**：
 * 后端刻意不归一化（归进 allow 是静默放行，归进 deny 是冤枉一次真发生过的
 * 放行），界面上要标成「存疑」，不能二选一。
 *
 * `reason` 是**库里真有的话**——`detail` 的第一行，退到「命中规则 #N」，
 * 两处都没有就是 null。后端一个字都不加工，前端更不许编。
 */
export interface AuditResult {
  decision: string
  kind: string
  reason: string | null
}

export interface AuditRow {
  id: number
  /** **unix 秒**。见文件头。 */
  at: number
  actor: AuditActor
  /** 库里的原值。筛选也用它，所以界面上要看得见。 */
  action: string
  /** 界面词汇。后端认不出的动作给 null，此时显示 `action` 原值。 */
  actionLabel: string | null
  object: AuditObjectRef | null
  asset: AuditAssetRef | null
  /**
   * 这次操作的明细全文。**第一行是一句人话，其余是紧凑 JSON 附文。**
   *
   * **可能为 null**：`detail` 是阶段 4 才加的列（迁移 008），这一列出现之前
   * 的历史记录没有。为 null 时界面上显示「无细节」而**不是留空**——
   * 空白让人以为是渲染坏了。
   */
  detail: string | null
  result: AuditResult
  matchedRuleId: number | null
  clientKind: string | null
}

/**
 * 本次结果的时间窗口，**连同「它是怎么来的」**。
 *
 * `isDefault` 为 true 时是后端替我们兜的最近 7 天，`text` 是那句要原样显示给
 * 管理员的话。看不见的默认窗口比慢查询危险得多：管理员在审计页上找不到某个
 * 操作会读成「这个操作没发生过」，而真相是「它在窗口之外」。
 */
export interface AuditWindow {
  from: number
  to: number | null
  isDefault: boolean
  days: number
  text: string | null
}

/**
 * 这一页 / 这一段历史里，**后端没有登记中文标签**的动作。
 *
 * 逐行的 `actionLabel` 为 null 已经把这件事说了一半，但那一半只有在有人盯着
 * 某一行发呆时才看得见。后端因此按动作汇总一次（阶段 5 · A9），界面上要显示
 * 成一句「这一页有 N 种动作后端还没登记名字」。
 *
 * **前端不许自己补一份动作名映射表**。补了之后「后端漏登记」这件事就被永久
 * 掩盖：界面上一切正常，而后端那张表停在 3 行——审计页停摆两轮的原因正是
 * 这个（F5c 报告缺口 1）。A9 为防漏登记加了类型收窄与源码扫描两道门，
 * 前端兜底等于把那两道门的价值抵消掉。
 *
 * 全部登记过时是 `[]`（不是 null）：前端不必区分「没有」与「没算」。
 */
export interface UnlabeledAction {
  /** 库里的原值。 */
  action: string
  /** **这一页 / 这一段历史里**它出现了几次。 */
  count: number
  /** 一句人话，**原样上屏**，前端不改写。 */
  hint: string
}

export interface AuditPage {
  rows: AuditRow[]
  /** 去掉分页之后的命中总数，翻页时不变。 */
  total: number
  limit: number
  offset: number
  window: AuditWindow
  /** 见 `UnlabeledAction`。顺序是首次出现的顺序，与行序一致，好对。 */
  unlabeledActions: UnlabeledAction[]
}

/** 后端支持的**全部**筛选维度。这里没有的，前端也不许有。 */
export interface AuditFilter {
  /** unix 秒，时间下界（含）。`0` 是一次真实取值＝「不设下界」。 */
  from?: number
  /** unix 秒，时间上界（不含）。半开区间 `[from, to)`。 */
  to?: number
  /** 精确匹配，不是模糊搜索。 */
  actorId?: string
  actorKind?: readonly AuditFilterActorKind[]
  /** `audit_log.action` 的原值，精确匹配，可多选。 */
  action?: readonly string[]
  decision?: 'allow' | 'deny'
  limit?: number
  offset?: number
}

/* ── 校验 ───────────────────────────────────────────────────────── */

type R = ReturnType<typeof reader>

function readActor(r: R, o: Record<string, unknown>, where: string): AuditActor {
  const a = r.object(o.actor, `${where}.actor`)
  const at = `${where}.actor`
  return {
    kind: r.str(a, 'kind', at),
    type: r.str(a, 'type', at),
    id: r.str(a, 'id', at),
    /*
     * **这一处是宽读**，本文件其余字段一律严格。
     *
     * `name` 是 2026-08-31 加的键。用 `r.strOrNull` 的话，键**缺失**（老网关）
     * 也会打成形状错，于是一个只是版本不齐的后端会让整页审计显示「读取失败」——
     * 而这个字段只影响「显示人名还是显示 id」，两种都能看。缺了就当没有,
     * 退回显示 id（那正是它上一版的样子）。
     *
     * 代价是 `name: 123` 这种脏值也会被读成 null 而不是报错。对一个纯展示字段
     * 这是对的取舍：判定与可回溯性一个都不依赖它。同 `admin/meetings.ts` 的
     * `readWhy`——那里也是全文件唯一一处宽容，理由一样。
     */
    name: typeof a.name === 'string' ? a.name : null,
  }
}

function readObject(r: R, o: Record<string, unknown>, where: string): AuditObjectRef | null {
  const raw = r.objOrNull(o, 'object', where)
  if (raw === null) return null
  const at = `${where}.object`
  return {
    id: r.str(raw, 'id', at),
    idKind: r.str(raw, 'idKind', at),
    meetingId: r.strOrNull(raw, 'meetingId', at),
    title: r.strOrNull(raw, 'title', at),
    code: r.strOrNull(raw, 'code', at),
  }
}

function readAsset(r: R, o: Record<string, unknown>, where: string): AuditAssetRef | null {
  const raw = r.objOrNull(o, 'asset', where)
  if (raw === null) return null
  const at = `${where}.asset`
  return { id: r.str(raw, 'id', at), type: r.strOrNull(raw, 'type', at) }
}

function readResult(r: R, o: Record<string, unknown>, where: string): AuditResult {
  const raw = r.object(o.result, `${where}.result`)
  const at = `${where}.result`
  return {
    decision: r.str(raw, 'decision', at),
    kind: r.str(raw, 'kind', at),
    reason: r.strOrNull(raw, 'reason', at),
  }
}

function readRow(r: R, raw: Record<string, unknown>, where: string): AuditRow {
  return {
    id: r.num(raw, 'id', where),
    at: r.num(raw, 'at', where),
    actor: readActor(r, raw, where),
    action: r.str(raw, 'action', where),
    actionLabel: r.strOrNull(raw, 'actionLabel', where),
    object: readObject(r, raw, where),
    asset: readAsset(r, raw, where),
    detail: r.strOrNull(raw, 'detail', where),
    result: readResult(r, raw, where),
    matchedRuleId: r.numOrNull(raw, 'matchedRuleId', where),
    clientKind: r.strOrNull(raw, 'clientKind', where),
  }
}

/**
 * `unlabeledActions` 的读法。**两条端点共用**（`/audit` 与
 * `/meetings/:id/history`），所以放在这里由 `api/admin/meetings.ts` import——
 * 各读各的就是两份会各自漂的解析。
 *
 * 缺这个键就报形状错，不当成空数组：那样一来"后端全都登记过了"与
 * "后端根本没算这件事"在界面上长得一模一样，而这条字段存在的全部理由
 * 恰恰是把后者暴露出来。
 */
export function readUnlabeledActions(r: R, o: Record<string, unknown>): UnlabeledAction[] {
  return r.objList(o, 'unlabeledActions', '').map((x, i) => {
    const at = `unlabeledActions[${i}]`
    return { action: r.str(x, 'action', at), count: r.num(x, 'count', at), hint: r.str(x, 'hint', at) }
  })
}

function readWindow(r: R, o: Record<string, unknown>): AuditWindow {
  const raw = r.object(o.window, 'window')
  return {
    from: r.num(raw, 'from', 'window'),
    to: r.numOrNull(raw, 'to', 'window'),
    isDefault: r.bool(raw, 'isDefault', 'window'),
    days: r.num(raw, 'days', 'window'),
    text: r.strOrNull(raw, 'text', 'window'),
  }
}

/* ── 端点 ───────────────────────────────────────────────────────── */

/**
 * `GET /api/v1/admin/audit`。
 *
 * 行的顺序是后端定的（`occurred_at DESC, id DESC`），这里**原样保留**：
 * 审计是可回溯性的底座，不做任何折叠、去重或换序——两条看起来一样的记录
 * 就是发生过两次。
 */
export async function listAudit(filter: AuditFilter = {}): Promise<AuditPage> {
  const query: Record<string, unknown> = {}
  // `undefined` 的键不会出现在 URL 里（`api/client.ts` 的 buildQuery），
  // 所以这里只需要把「空集合」和「空白串」这两种也挡掉——它们发出去
  // 分别是 400 empty_filter 与一次真实的「操作者 ID 是空串」。
  if (filter.from !== undefined) query.from = filter.from
  if (filter.to !== undefined) query.to = filter.to
  const actorId = filter.actorId?.trim()
  if (actorId !== undefined && actorId !== '') query.actorId = actorId
  if (filter.actorKind !== undefined && filter.actorKind.length > 0) {
    query.actorKind = [...filter.actorKind]
  }
  if (filter.action !== undefined && filter.action.length > 0) query.action = [...filter.action]
  if (filter.decision !== undefined) query.decision = filter.decision
  if (filter.limit !== undefined) query.limit = filter.limit
  if (filter.offset !== undefined) query.offset = filter.offset

  const raw = await apiGet<unknown>(`${BASE}/audit`, query)
  const r = reader(ENDPOINT)
  const o = r.object(raw, '')
  return {
    rows: r.objList(o, 'rows', '').map((row, i) => readRow(r, row, `rows[${i}]`)),
    total: r.num(o, 'total', ''),
    limit: r.num(o, 'limit', ''),
    offset: r.num(o, 'offset', ''),
    window: readWindow(r, o),
    unlabeledActions: readUnlabeledActions(r, o),
  }
}
