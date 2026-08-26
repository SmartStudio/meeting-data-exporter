/**
 * A3 采集授权 API（阶段 4 · T7）：spec §4.5 那一页的后端。
 *
 * ```
 * GET    /api/v1/admin/programs                                采集程序列表
 * POST   /api/v1/admin/programs                                接入新程序（四步向导的落点）
 * GET    /api/v1/admin/programs/:id/inventory                  「现在可取走 N 场会议的……」
 * POST   /api/v1/admin/meetings/:meetingId/grants              授权给某程序
 * DELETE /api/v1/admin/meetings/:meetingId/grants/:programId   撤销授权
 * PUT    /api/v1/admin/meetings/:meetingId/override            写人工改写
 * DELETE /api/v1/admin/meetings/:meetingId/override/:kind      撤销人工改写
 * ```
 *
 * ## 一、清单是**现算**的（计划 E-e）
 *
 * `computeProgramInventory` 每次请求跑一遍，不落缓存表。它发出去的查询数与会议数无关
 * （规则 1 次、归档 1 次、改写 1 次、会议元数据 1 次，外加至多 1 次本地资产），
 * 1–3 个采集程序、几百场会议的规模现算完全够。
 *
 * 更要紧的不是性能：开缓存表意味着「控制台显示的可取清单」与网关 `AccessGate` 的
 * 实时判定变成两份真相，而漂移的方向恰好是最坏的那一个——控制台说能取、实际取不到，
 * 或者反过来。将来现算真慢了再加缓存是纯增量改动（换的是 `computeProgramInventory`
 * 内部，本文件的调用点不变）；**先开表才是不可逆的那个方向。**
 *
 * ## 二、「7 天内到期」的阈值判在这一层（阶段 3 的 D-v）
 *
 * `visibility.ts` 刻意只给 `expiresAt` 这个事实，理由写在它的文件头「这一层给事实，
 * 不给阈值」——阈值写死在 worker 里的话，界面上想换个天数就得改 worker。
 * 所以阈值在这里，并且**随响应下发**（`expiringSoonDays`），前端不再抄一份 7。
 *
 * ## 三、`kind` 与 `effect` 原样递给 store，这一层不判、不转、不推断
 *
 * 阶段 3 的 D-u：`kind` 是改写行上**唯一没有安全侧可落**的字段——填成另一栈会让
 * 一条 fetch 改写（effect `all`）被归档栈当成一段合法的目录模板，录像归进一个叫
 * all 的目录；填成三栈之外则没有任何一栈认领，管理员明确做出的决定变成一次
 * 界面上毫无痕迹的空操作。防线有两道：store 的 `assertOverrideKind` 与
 * `migrations/006` 的 CHECK。
 *
 * **在 handler 里再判一次就是第三份「合法值清单」，三份早晚会分叉。** 所以这里只校验
 * 「是不是一个非空字符串」（那是本层own 的事：请求体反序列化出来的东西可能是数字、
 * 对象、undefined），值本身原样递下去。
 *
 * 代价写在这里免得以后当 bug 修：**非法 kind 在 HTTP 上表现为 500 而不是 400。**
 * 这是有意的取舍——控制台只会发三个合法值，收到别的说明有第三方客户端或前端 bug，
 * 500 加一条服务端错误日志正是这种情况该有的响亮失败。要换成 400 就得在这里复制
 * 一份合法集合，那正是 D-u 要防的事。
 *
 * ## 四、每一次写操作都记审计（计划 §1 约束 6）
 *
 * 走 `AuditStore.record` 而不是 `AuditRecorder`：那个 recorder 的三个方法都是
 * 「程序取数据」维度的（下载地址、登录、列会议），而 A3/A5/A6 各自都要往里加
 * 管理员维度的方法。阶段 4 有三个任务并行改控制台的写侧，各自往 recorder 上加一个
 * 方法必然互相冲突，且那三个方法除了 action 常量以外一模一样。审计写侧的语义在
 * `record` 上已经完整，这里直接用它。
 *
 * 一句话明细走 `audit_log.detail`（阶段 4 · T15）。这里原先把「对哪个程序、
 * 哪一场次、什么范围」硬塞进 `meeting_id` / `asset_id` / `asset_type` 三列，
 * 其中 `asset_type` 只有 64 字符，全八类的范围必然被截——而「授权了什么范围」
 * 正是这一行审计要回答的问题。现在：`meeting_id` / `asset_id` 各归其位
 * （会议、对象键），明细整句进 `detail`，`asset_type` 留空。
 */

import type { AssetKey } from '@yaowu/mde-engine'
import type { RouteCtx } from '../../router'
import { json, readJson } from '../../respond'
import { requireAdminAuth, requireAdminWrite } from '../../middleware'
import type { AdminIdentity } from '../../../auth/admin'
import { generateServiceSecret, hashServiceSecret } from '../../../auth/service'
import { buildAuditDetail } from '../../../store/audit'
import type { MeetingKey } from '../../../store/grants'
import {
  computeProgramInventory,
  type InventoryEntry,
  type VisibilityDeps,
} from '../../../worker/visibility'

/**
 * 「其中 N 场 7 天内到期」的阈值（spec §4.5 的琥珀标记）。
 * 随响应下发，见文件头第二节。
 */
const EXPIRING_SOON_DAYS = 7

/**
 * 采集程序 id 的合法字符集。它不只是一个主键：
 * - 它是采集权限规则的**主体值**（`policy_rules.subject_value`，见 seed-dev.ts 的文件头）；
 * - 它会成为 `/api/v1/admin/programs/:id/inventory` 的一段路径；
 * - 它会被对接方贴进 shell 的 `export MDE_CLIENT_ID=`。
 *
 * 三处都不喜欢空格、斜杠和非 ASCII。首字符要求是字母数字，免得出现 `-x` 这种
 * 会被命令行当成选项的 id。长度上限 64 = `service_accounts.id` 的列宽。
 */
const PROGRAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** `service_accounts.name` 的列宽 */
const PROGRAM_NAME_MAX = 128
/** `service_accounts.tm_userid` 的列宽 */
const TM_USERID_MAX = 128

// ── 公共小工具 ────────────────────────────────────────────────

/**
 * 周期性会议的场次 id 从查询串取，**四个端点统一一处来源**。
 *
 * 会议的真实主键是 `(meeting_id, sub_meeting_id)`，而路由上只有 `:meetingId`。
 * 两个 DELETE 没有请求体，能承载第二段键的地方只剩查询串；POST/PUT 若改从请求体取，
 * 同一个键就有了两种写法，前端迟早会在某一个端点上漏掉它——而漏掉的后果是
 * 静默地操作了主场次（空串）而不是管理员选中的那一场。
 *
 * 缺省是空串 = 主场次，与库里 `sub_meeting_id NOT NULL DEFAULT ''` 一致。
 */
function subMeetingIdOf(req: Request): string {
  return new URL(req.url).searchParams.get('sub') ?? ''
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 资产范围的三态解析（阶段 3 的 D-n，读写两侧都不许合并）：
 * - `null`     不额外限制，以规则栈判定为准
 * - 非空数组   白名单
 * - `[]`       **什么都不授权**（不是「不限制」）
 *
 * 返回 `undefined` 表示这份请求体不合法，由调用方报 400。
 *
 * **字段缺失（`undefined`）也算不合法**，不默认成 `null`：三态里 `null` 是最宽的
 * 那一个，让它当缺省值等于一次静默放行——前端少发一个字段，管理员本想只授权
 * AI 纪要，实际授权了规则放行的全部资产，而两边的界面都显示"已授权"。
 */
function parseAssetTypes(v: unknown): string[] | null | undefined {
  if (v === null) return null
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
  return undefined
}

/**
 * 一次管理员写操作的审计目标，编进 `audit_log.asset_id`（255 字符，够宽）。
 *
 * `@` 后面是周期性会议的场次 id；主场次（空串）不写 `@`，省得每条记录都拖一个
 * 空后缀。`target` 是这次动作的对象：授权是 programId，改写是 kind，接入新程序是新 id。
 * 三者都在 `PROGRAM_ID_RE` / 三个 kind 字面量的字符集里，不含 `@`。
 */
function auditTarget(target: string, subMeetingId: string): string {
  return subMeetingId === '' ? target : `${target}@${subMeetingId}`
}

interface AdminWrite {
  action: string
  /** 没有会议维度的动作（接入新程序）传 null */
  meetingId: string | null
  target: string
  subMeetingId: string
  /**
   * 一句话明细，进 `audit_log.detail`（TEXT，migrations/008）。
   *
   * 从前它被塞进 `asset_type VARCHAR(64)`，于是「授权了哪几类资产」这句话在
   * 全八类时必然被截断——而那正是这一行审计要回答的问题。detail 之后不再截断，
   * 上限见 `AUDIT_DETAIL_MAX_CHARS`（8000 码点，这一族明细离它差三个数量级）。
   */
  detail: string
}

/** 管理员写操作的审计。`actor_type = 'admin'`，`client_kind = 'console'` */
async function recordAdminWrite(
  ctx: RouteCtx,
  identity: AdminIdentity,
  w: AdminWrite,
): Promise<void> {
  await ctx.deps.auditStore.record({
    occurredAt: ctx.deps.now(),
    actorType: 'admin',
    // adminId 而不是 username：用户名可以改，审计要指得住同一个人
    actorId: identity.adminId,
    action: w.action,
    meetingId: w.meetingId,
    assetId: auditTarget(w.target, w.subMeetingId),
    // 这一族动作（授权、改写、接入程序）的对象不是某一份资产，这一列没有值可填。
    // 从前它装着一句话明细，那是 detail 列还不存在时的将就；现在填 null，
    // 免得读侧把「授权范围 …」显示成「资产类型」
    assetType: null,
    // 管理员的写操作不是一次「准许/拒绝」的判定。这一列 NOT NULL，取 allow 表示
    // 「这次操作被执行了」——被参数校验挡回去的请求压根走不到这里，不会留记录
    decision: 'allow',
    matchedRuleId: null,
    clientKind: 'console',
    detail: buildAuditDetail({ text: w.detail }),
  })
}

/**
 * 资产范围写进审计明细的形式。null 是「不限制」，写 `*` 与规则里的写法一致。
 *
 * **全八类连起来 100 出头，从前会被 `asset_type` 的 64 字符切掉后半段**，
 * 于是「授权了什么范围」这个问题在最需要它的那几条记录上恰好答不出来。
 * 明细搬进 `detail` 之后不再截断，这里也就不必再为了省字数缩写类型名。
 */
function scopeDetail(assetTypes: string[] | null): string {
  return assetTypes === null ? '*' : assetTypes.length === 0 ? '(空集：什么都不授权)' : assetTypes.join(',')
}

/** 采集清单要用的那几个 store，从 `AppDeps` 上拼出 `VisibilityDeps` */
function visibilityDeps(ctx: RouteCtx): VisibilityDeps {
  return {
    policy: ctx.deps.policyStore,
    grants: ctx.deps.grantsStore,
    archives: ctx.deps.archivesStore,
    // T1 落地前由 src/index.ts 里的临时实现顶着，见那里的注释
    getMeetings: ctx.deps.getMeetings,
  }
}

// ── 采集程序 ──────────────────────────────────────────────────

export async function listPrograms(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  // 直接下发 store 的返回值：那个类型里根本没有 secret_hash，
  // 挑字段这件事在 store 那一层就做完了（见 src/store/programs.ts 的文件头）
  return json(200, await ctx.deps.programs.list())
}

interface CreateProgramBody {
  id?: unknown
  name?: unknown
  tmUserId?: unknown
  expiresAt?: unknown
}

/**
 * 接入新程序（spec §4.5 的四步向导）。
 *
 * **明文凭据只在这一次响应里出现**，不落盘、不入库、不进审计、不进日志——
 * 库里只有 argon2id 哈希，与 `scripts/seed-dev.ts` 完全一致（两处共用
 * `src/auth/service.ts` 的 `generateServiceSecret` / `hashServiceSecret`，
 * 那个文件里就是校验凭据的地方，产出与校验因此不可能各用一套）。
 *
 * 丢了不能找回，只能轮换——这一点前端要在向导的最后一步说清楚。
 */
export async function createProgram(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const body = await readJson<CreateProgramBody>(req)
  if (body === null) return json(400, { error: 'invalid_json' })

  const { id, name, tmUserId, expiresAt } = body
  if (!nonEmptyString(id) || !PROGRAM_ID_RE.test(id)) {
    return json(400, {
      error: 'invalid_program_id',
      hint: '只能用字母数字开头，其后为字母数字与 . _ -，最长 64 字符——它同时是采集权限规则的主体与 URL 的一段',
    })
  }
  if (!nonEmptyString(name) || name.length > PROGRAM_NAME_MAX) {
    return json(400, { error: 'invalid_name', maxLength: PROGRAM_NAME_MAX })
  }
  // tm_userid 这一列 NOT NULL，且它是这个程序调腾讯 API 与留痕的身份。
  // 在这里塞一个默认值（比如网关自己的 operatorId）等于让一批程序共用同一个
  // 操作者身份，审计里再也分不开是哪个程序取走的数据
  if (!nonEmptyString(tmUserId) || tmUserId.length > TM_USERID_MAX) {
    return json(400, { error: 'invalid_tm_userid', maxLength: TM_USERID_MAX })
  }
  let expires: number | null = null
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= ctx.deps.now()) {
      return json(400, { error: 'invalid_expires_at', hint: '要么不填（永不过期），要么是一个将来的 unix 秒' })
    }
    expires = expiresAt
  }

  const secret = generateServiceSecret()
  const created = await ctx.deps.programs.create({
    id,
    name,
    secretHash: await hashServiceSecret(secret),
    tmUserId,
    expiresAt: expires,
    now: ctx.deps.now(),
  })
  // 重名不是一次写操作，没有东西可审计——而且这条路径上**没有任何一行被改动**
  // （store 靠主键冲突挡回来，绝不 UPSERT，见 src/store/programs.ts 的文件头）
  if (!created) return json(409, { error: 'program_id_taken' })

  await recordAdminWrite(ctx, auth.identity, {
    action: 'create_program',
    meetingId: null,
    target: id,
    subMeetingId: '',
    detail: `接入新程序 ${name}（tm_userid=${tmUserId}）`,
  })

  return json(201, {
    id,
    name,
    tmUserId,
    enabled: true,
    expiresAt: expires,
    createdAt: ctx.deps.now(),
    /** 明文凭据。**只有这一次**——库里只存哈希，服务端此后无从还原 */
    secret,
    secretShownOnce: true,
    // 阶段 5 · A8：与轮换那条端点共用同一句话，见 SECRET_SHOWN_ONCE_NOTE
    secretNote: SECRET_SHOWN_ONCE_NOTE,
  })
}

/**
 * 明文凭据只出现这一次，响应里必须把这件事说出来（阶段 5 · A8）。
 *
 * 建号与轮换两条路径共用同一句话：它们给出的是同一种东西，说法不一致会让
 * 对接方以为其中一条另有找回的办法。**没有任何"再看一次"的端点**——
 * 有的话就等于把哈希存储的意义整个抵消掉。
 */
const SECRET_SHOWN_ONCE_NOTE =
  '这是唯一一次能看到这个凭据明文的机会：服务端只存哈希，此后无从还原。' +
  '现在就把它存进对接方的密钥管理里——丢了不能找回，只能再轮换一次（旧凭据会当场失效）。'

interface PatchProgramBody {
  enabled?: unknown
}

/**
 * 停用 / 启用一个采集程序（spec §11 缺口 4）。
 *
 * ## 停用之后，它已有的授权怎么办：保留
 *
 * 计划 §11.2 的裁定，理由是**停用是一个可逆动作**。连带删授权会让「停用再启用」
 * 变成一次不可逆的数据丢失——几十场逐会议授权删掉之后没有任何地方可以恢复，
 * 而管理员按下「停用」时想表达的是「先别取了」，不是「把我配了一下午的授权清掉」。
 *
 * 「停用之后确实取不到数据」由 `src/policy/access.ts` 保证：AccessGate 在读规则
 * **和改写**之前就因 `enabled = 0` 拒绝。这一条必须在那一层，不能只靠
 * `auth/service.ts` 的登录校验——那里只挡「拿凭据换令牌」，而**已经签发出去的
 * 访问令牌在停用之后仍然有效到自然过期**。只挡登录，等于「停用」这个按钮在
 * 最长一个令牌生命周期内什么都没做。
 */
export async function patchProgram(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const id = ctx.params.id!
  const body = await readJson<PatchProgramBody>(req)
  if (body === null) return json(400, { error: 'invalid_json' })
  // 只认真正的布尔值。`"false"` / `0` / `undefined` 一律 400——把它们各自
  // 折成某一侧，就会出现「点了停用、程序还在取数据」而且没有任何报错
  if (typeof body.enabled !== 'boolean') {
    return json(400, { error: 'invalid_enabled', hint: 'enabled 必须是 true 或 false' })
  }
  const enabled = body.enabled

  const before = await ctx.deps.programs.find(id)
  if (before === null) return json(404, { error: 'program_not_found' })

  const changed = await ctx.deps.programs.setEnabled(id, enabled)
  // find 到 setEnabled 之间被别人删掉了。不能当成改成功
  if (!changed) return json(404, { error: 'program_not_found' })

  await recordAdminWrite(ctx, auth.identity, {
    action: enabled ? 'enable_program' : 'disable_program',
    meetingId: null,
    target: id,
    subMeetingId: '',
    detail: enabled
      ? `启用采集程序 ${before.name}——它此前的逐会议授权一直保留着，现在重新生效`
      : `停用采集程序 ${before.name}。已有授权保留（停用可逆），但采集判定一律拒绝，` +
        `包括已经签发、还没过期的访问令牌`,
  })

  // 回显写后重读的真值，而不是回显请求体：前端照它更新卡片，
  // 回显请求体等于让界面显示「我以为写进去的东西」
  const after = await ctx.deps.programs.find(id)
  return json(200, after ?? { id, enabled })
}

/**
 * 轮换一个采集程序的凭据（spec §11 缺口 4）。
 *
 * **新凭据只在这一次响应里出现**，库里只存 argon2id 哈希——与建号那条路径逐字
 * 一致（两处共用 `src/auth/service.ts` 的 `generateServiceSecret` /
 * `hashServiceSecret`，那个文件里就是校验凭据的地方，产出与校验因此不可能各用一套）。
 *
 * **旧凭据当场失效**，这是轮换的全部意义。所以它不是一个可以随手点的按钮：
 * 对接方那边的定时任务会在下一次换令牌时开始 401，前端必须在按下之前说清这件事。
 *
 * 轮换**不改 `enabled`**：给一个停用中的程序轮换凭据，它仍然是停用的。
 */
export async function rotateProgramSecret(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const id = ctx.params.id!
  const program = await ctx.deps.programs.find(id)
  if (program === null) return json(404, { error: 'program_not_found' })

  const secret = generateServiceSecret()
  const rotated = await ctx.deps.programs.rotateSecret(id, await hashServiceSecret(secret))
  if (!rotated) return json(404, { error: 'program_not_found' })

  await recordAdminWrite(ctx, auth.identity, {
    action: 'rotate_program_secret',
    meetingId: null,
    target: id,
    subMeetingId: '',
    // 明文与它的任何片段都不进审计。这一行要回答的是「谁在什么时候换的」，
    // 不是「换成了什么」
    detail: `轮换采集程序 ${program.name} 的凭据，旧凭据即刻失效`,
  })

  return json(200, {
    id,
    name: program.name,
    rotatedAt: ctx.deps.now(),
    /** 明文凭据。**只有这一次**——库里只存哈希，服务端此后无从还原 */
    secret,
    secretShownOnce: true,
    secretNote: SECRET_SHOWN_ONCE_NOTE,
  })
}

// ── 采集清单（§4.5 那句蓝底的话） ──────────────────────────────

/** 一场会议在清单里的样子。`decision.trace` 不下发：那是影响预览与详情抽屉要的东西 */
interface InventoryItemView {
  meetingId: string
  subMeetingId: string
  assetTypes: AssetKey[]
  expiresAt: number | null
  /** 阈值判在这一层，见文件头第二节 */
  expiringSoon: boolean
  overridden: boolean
  decision: {
    effect: string
    reason: string
    ruleId: number | null
    note: string | null
    source: string
  } | null
  blockers: InventoryEntry['blockers']
}

/**
 * 这场会议算不算「快到期」。
 *
 * `expiresAt === null` 是「还没归档过，保留窗口还没开始计时」——**没有到期时刻可言，
 * 不是"马上到期"**。把 null 当 0 算会让每一场刚拉下来还没归档的会议都顶着琥珀标记。
 *
 * 已经过了到期时刻但文件还在（清理被暂停，见 `visibility.ts` 第二节）的会议
 * **算在内**：它比「7 天内到期」更紧急，下一轮清理恢复就没了。用 `<=` 而不是区间
 * 判断，正是为了不把差值为负的那些漏在外面。
 */
function isExpiringSoon(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now + EXPIRING_SOON_DAYS * 86_400
}

function toItem(e: InventoryEntry, now: number): InventoryItemView {
  return {
    meetingId: e.meetingId,
    subMeetingId: e.subMeetingId,
    assetTypes: e.assetTypes,
    expiresAt: e.expiresAt,
    expiringSoon: isExpiringSoon(e.expiresAt, now),
    overridden: e.overridden,
    decision:
      e.decision === null
        ? null
        : {
            effect: e.decision.effect,
            reason: e.decision.reason,
            ruleId: e.decision.ruleId,
            note: e.decision.note,
            source: e.decision.source,
          },
    blockers: e.blockers,
  }
}

/**
 * spec §4.5 卡片正中间那句蓝底的话：
 * 「现在可取走 **4** 场会议的 AI 纪要 + 完整转写」（其中 1 场 7 天内到期）。
 *
 * 三个部分分别是 `fetchableCount` / `assetTypes` / `expiringSoonCount`，
 * 全部由 `computeProgramInventory` 现算的结果导出，**没有一个是配置值**。
 */
export async function programInventory(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const programId = ctx.params.id ?? ''
  // 程序不存在必须与「接进来了但一场都还没授权」分开：两者的清单都是 0 场，
  // 界面上长得一模一样，而管理员会以为是授权没生效，回授权页反复点，
  // 真正的问题却是 id 拼错了
  if ((await ctx.deps.programs.find(programId)) === null) {
    return json(404, { error: 'program_not_found' })
  }

  const now = ctx.deps.now()
  const inv = await computeProgramInventory(visibilityDeps(ctx), { programId, now })
  const fetchable = inv.fetchable.map((e) => toItem(e, now))

  return json(200, {
    programId: inv.programId,
    /** 这次重算用的时刻。求值器不读时钟，带上它这份清单就可回放 */
    now: inv.now,
    fetchableCount: inv.fetchable.length,
    blockedCount: inv.blocked.length,
    /** 「其中 N 场 7 天内到期」——只数可取的那些，「其中」指的就是它们 */
    expiringSoonCount: fetchable.filter((e) => e.expiringSoon).length,
    /** 阈值随响应下发，前端不再抄一份 7 */
    expiringSoonDays: EXPIRING_SOON_DAYS,
    /** 可取会议的资产类型并集，按 ALL_ASSET_KEYS 的顺序 */
    assetTypes: inv.assetTypes,
    fetchable,
    /** 已授权但现在取不到的那些，各自带着理由与「该去哪一页」 */
    blocked: inv.blocked.map((e) => toItem(e, now)),
  })
}

// ── 逐会议授权 ────────────────────────────────────────────────

interface GrantBody {
  programId?: unknown
  assetTypes?: unknown
}

export async function grantMeeting(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const body = await readJson<GrantBody>(req)
  if (body === null) return json(400, { error: 'invalid_json' })
  if (!nonEmptyString(body.programId)) return json(400, { error: 'missing_program_id' })

  const assetTypes = parseAssetTypes(body.assetTypes)
  if (assetTypes === undefined) {
    return json(400, {
      error: 'missing_asset_types',
      hint: '必须显式给出：null = 不额外限制（以规则栈判定为准），[] = 什么都不授权，非空数组 = 白名单',
    })
  }

  // 授权给一个不存在的程序会留下一条指向空气的行：它不会出现在任何一份清单里
  // （清单是按程序算的），于是管理员在会议详情里看到"已授权"，采集侧却永远取不到
  if ((await ctx.deps.programs.find(body.programId)) === null) {
    return json(404, { error: 'program_not_found' })
  }

  // 会议存不存在这里**不查**：`computeProgramInventory` 已经会把它报成
  // `meeting_unknown` 并落到拒绝一侧，理由里写明"授权行指着一场不存在的会议"。
  // 在这里再挡一道就是第二处真相，且会挡掉"先授权、等 discovery 补上元数据"
  // 这条本来合法的顺序
  const meetingId = ctx.params.meetingId ?? ''
  const subMeetingId = subMeetingIdOf(req)
  const granted = await ctx.deps.grantsStore.grant({
    meetingId,
    subMeetingId,
    programId: body.programId,
    assetTypes,
    now: ctx.deps.now(),
  })

  await recordAdminWrite(ctx, auth.identity, {
    action: 'grant_meeting',
    meetingId,
    target: body.programId,
    subMeetingId,
    detail: scopeDetail(assetTypes),
  })

  // 200 而不是 201：`grant` 是幂等的（范围相同就原样返回旧行，不同则撤旧插新，
  // 见 store/grants.ts），这次调用未必创建了什么。返回的是**当前生效的那一条**
  return json(200, granted)
}

export async function revokeGrant(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const meetingId = ctx.params.meetingId ?? ''
  const programId = ctx.params.programId ?? ''
  const subMeetingId = subMeetingIdOf(req)
  const revoked = await ctx.deps.grantsStore.revoke(meetingId, subMeetingId, programId, ctx.deps.now())

  // 撤了个本来就没有的授权照样记：管理员点「撤销」这件事发生过。不记的话，
  // 日后查「谁动了这条授权」会看到一段空白，而当事人记得自己点过
  await recordAdminWrite(ctx, auth.identity, {
    action: 'revoke_grant',
    meetingId,
    target: programId,
    subMeetingId,
    detail: revoked ? '撤销授权' : '撤销授权（noop：当时没有生效的授权行）',
  })

  // 不用 204：`revoked` 这个布尔是有信息的——界面要能说出「已经撤销过了」，
  // 而不是让管理员以为自己刚刚撤掉了一条正在生效的授权
  return json(200, { revoked })
}

// ── 人工改写 ──────────────────────────────────────────────────

interface OverrideBody {
  kind?: unknown
  effect?: unknown
  assetTypes?: unknown
  reason?: unknown
}

/**
 * 写一条人工改写（spec §5.4：改写优先于所有规则）。
 *
 * `kind` 与 `effect` **原样递给 store**，这一层不判合法值，理由见文件头第三节。
 */
export async function putOverride(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const body = await readJson<OverrideBody>(req)
  if (body === null) return json(400, { error: 'invalid_json' })
  // 只校验"是不是一个非空字符串"——那是本层own 的事（反序列化出来的可能是数字、
  // 对象、undefined）。值本身交给 store 的 assertOverrideKind 与库里的 CHECK
  if (!nonEmptyString(body.kind)) return json(400, { error: 'missing_kind' })
  if (!nonEmptyString(body.effect)) return json(400, { error: 'missing_effect' })
  // 理由不是可选的：它会进判定理由与审计（spec §6.3），一条没有理由的改写
  // 在半年后就是一个谁都解释不了的例外
  if (!nonEmptyString(body.reason)) return json(400, { error: 'missing_reason' })

  const assetTypes = parseAssetTypes(body.assetTypes)
  if (assetTypes === undefined) {
    return json(400, {
      error: 'missing_asset_types',
      hint: '必须显式给出：null = 沿用规则栈判定的那一份范围，[] = 一类都不放行，非空数组 = 白名单',
    })
  }

  const meetingId = ctx.params.meetingId ?? ''
  const subMeetingId = subMeetingIdOf(req)
  // 防线开火时这里会抛，于是下面的审计不会执行——没写成的事不能留一条说写成了的记录
  const override = await ctx.deps.grantsStore.putOverride({
    meetingId,
    subMeetingId,
    kind: body.kind as never,
    effect: body.effect,
    assetTypes,
    reason: body.reason,
    now: ctx.deps.now(),
  })

  await recordAdminWrite(ctx, auth.identity, {
    action: 'put_override',
    meetingId,
    target: body.kind,
    subMeetingId,
    detail: `${body.effect} · ${body.reason}`,
  })

  return json(200, override)
}

export async function revokeOverride(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const meetingId = ctx.params.meetingId ?? ''
  // 路径上的 kind 同样原样递下去，不在这里过滤
  const kind = ctx.params.kind ?? ''
  const subMeetingId = subMeetingIdOf(req)
  const revoked = await ctx.deps.grantsStore.revokeOverride(
    meetingId,
    subMeetingId,
    kind as never,
    ctx.deps.now(),
  )

  await recordAdminWrite(ctx, auth.identity, {
    action: 'revoke_override',
    meetingId,
    target: kind,
    subMeetingId,
    detail: revoked ? '撤销人工改写' : '撤销人工改写（noop：当时没有生效的改写行）',
  })

  return json(200, { revoked })
}
