/**
 * 「归档存储」页（spec.md §4.9）与「延长 30 天」（§4.3）的 API —— 阶段 4 · T8（A3）。
 *
 * 五个端点，全部要管理员会话：
 *   GET  /api/v1/admin/storage                    NAS 状态 + 容量 + 保留窗口统计
 *   POST /api/v1/admin/storage/retention-days     改默认保留天数
 *   POST /api/v1/admin/storage/cleanup-pause      暂停 / 恢复到期清理
 *   POST /api/v1/admin/storage/cleanup-now        立即清理已到期（默认 dry-run）
 *   POST /api/v1/admin/meetings/:meetingId/extend 延长这一场的保留窗口
 *
 * 三条贯穿本文件的规矩，改动之前先读：
 *
 * 1. **不自己算到期时刻。** 保留窗口的到期公式只有一处定义，就是
 *    `src/worker/retention.ts` 导出的 `expiresAt`。两处各存一份公式的后果是
 *    「界面说还剩 3 天，而清理昨天就删了文件」——只在被延长过的会议上现形，
 *    是最难向人解释的一种不一致。
 *
 * 2. **不自己 statfs。** 连通与容量一律走 `src/worker/nas-probe.ts` 的 probeNas
 *    （由装配处注入）。handler 里另跑一次 statfs 会给出与 worker 看到的不一样的数字。
 *
 * 3. **每一次写操作都记审计**（阶段 4 计划 §1 第 6 条），`actor_type = 'admin'`。
 *    顺序一律是"先做事、再记账"：审计是对已发生事实的记录，不能先记再做——
 *    先记后做一旦中间失败，审计里就留下了一件没发生过的事。
 */
import type { RouteCtx } from '../../router'
import { json, readJson } from '../../respond'
import { requireAdminAuth } from '../../middleware'
import {
  ACTION_EXTEND_RETENTION,
  auditSubMeetingAssetId,
  buildAuditDetail,
  type AuditEntry,
  type AuditStore,
} from '../../../store/audit'
import type { ArchivesStore } from '../../../store/archives'
import type { ConsoleStorageStore } from '../../../store/console-storage'
import type { NasProbeResult } from '../../../worker/nas-probe'
import type { CleanupExecuted, CleanupPreview } from '../../../worker/retention'
import { expiresAt } from '../../../worker/retention'

/**
 * 到期清理的执行入口。注入两个函数而不是注入 `RetentionDeps`，是为了让 handler
 * 拿不到 `localRoot`——它不该知道文件在哪，只该知道"清理这件事由谁去做"。
 * `execute` 的实现里那个 `confirm: true` 常量由装配处写死（见 src/index.ts），
 * handler 这一层用"调不调 execute"来表达确认，不去伪造那个字面量。
 */
export interface CleanupRunner {
  preview(now: number): Promise<CleanupPreview>
  execute(now: number): Promise<CleanupExecuted>
}

export type StorageArchives = Pick<
  ArchivesStore,
  | 'getSetting'
  | 'setSetting'
  | 'extendRetention'
  | 'findMeetingArchive'
  | 'listExpiredUnpurged'
  | 'listMeetingsNeedingArchive'
>

export interface StorageDeps {
  /** NAS 挂载点原值，只用于在页面上原样显示"归档到哪儿去了"。
   *  未配置时为 null——此时 probeNas 也一定返回 reachable:false，不会显示成"正常"。 */
  nasRoot: string | null
  /** 连通与容量。装配处绑定 worker/nas-probe.ts 的 probeNas。 */
  probeNas(): Promise<NasProbeResult>
  /** §4.9 那四个整表聚合数 */
  stats: ConsoleStorageStore
  archives: StorageArchives
  /**
   * 审计写侧。直接用 `AuditStore.record`，不往 `audit/recorder.ts` 上加方法：
   * recorder.ts 现在的三个方法都是"网关替某个程序取数据"那一族，管理员写操作
   * 是另一族；而本阶段有五个并行任务都要写管理员审计，各自往同一个文件上加一个
   * 方法必然互相冲突。等这一族的形状在几个 handler 里稳定下来，再一次性收进
   * recorder.ts 比现在各猜一个签名划算。
   */
  audit: Pick<AuditStore, 'record'>
  /**
   * 到期清理。**null = 本进程没挂载本地归档区**（网关进程未配 MDE_ARCHIVE_ROOT）。
   * 此时清理端点返回 503 并说明原因，绝不静默返回一个"没有可清理的"——
   * 那会让操作员以为清理跑过了。
   */
  cleanup: CleanupRunner | null
}

/** 保留天数的合法区间，与原型里那个 `<input type="number" min="1" max="365">` 一致 */
const MIN_RETENTION_DAYS = 1
const MAX_RETENTION_DAYS = 365

/**
 * `default_retention_days` 没设过时归档流水线用的内置默认值。
 *
 * **这是 `src/worker/archive.ts` 的 `DEFAULT_RETENTION_DAYS` 的镜像**，那个常量
 * 是模块私有的，本任务不改那个文件（阶段 2 已交付并验证），所以只能在这里再写一份。
 * 两边漂移的后果是页面上的"默认 N 天"与新归档会议真实拿到的保留天数不一致；
 * 响应里因此带上 `defaultDaysSource`，让"这是回退值"这件事本身可见——
 * 一旦改动其中一个，请同时改另一个。
 */
const FALLBACK_DEFAULT_RETENTION_DAYS = 30

/**
 * §4.3 的按钮写死是「延长 30 天」，所以默认就是 30，**不跟随
 * `default_retention_days`**。跟随的话，管理员把默认改成 90 之后，一个写着
 * 「延长 30 天」的按钮会静静地加 90 天——按钮上的字与它做的事必须一致。
 * 要加别的天数，请求体显式给 `days`。
 */
const EXTEND_DEFAULT_DAYS = 30

const SEVEN_DAYS_SEC = 7 * 86_400

// 这里曾有一个 clipDetail：自由文本被塞进 audit_log.asset_type（VARCHAR(64)），
// 一条清理失败的原因（带 NAS 路径与 errno）几乎必然超过 64 字符，于是被裁掉后半段
// ——而后半段正是查下去要用的东西。migrations/008 的 detail TEXT 之后不再需要它，
// 明细走 buildAuditDetail，上限与截断留痕都收在 src/store/audit.ts 一处。

/**
 * 「到期清理是不是被暂停了」。
 *
 * **极性必须与 `src/worker/retention.ts` 里那个私有的 isPaused 逐字一致**：
 * 除了明确说"没暂停"（键没写过、或者值恰好是 '0'），一律算暂停。读到一个不认识
 * 的值时当成"没暂停"继续删是不可逆的错，当成"暂停"最多晚一天清理。
 *
 * 这里之所以再写一份，是因为那个函数没有导出，而本任务不改那个文件。两份实现
 * 漂移的后果很重（页面说"清理正常运行"、而清理其实停着，或者反过来），所以
 * tests/http/console-storage.test.ts 里有一条用例拿同一批原始值同时喂给真的
 * `executeCleanup` 和这个函数逐值比对——靠注释叮嘱挡不住漂移，靠那条用例能。
 */
function isCleanupPaused(raw: string | null): boolean {
  return !(raw === null || raw === '0')
}

interface RetentionDefault {
  days: number | null
  source: 'setting' | 'fallback' | 'invalid'
  raw: string | null
}

/**
 * 读 `default_retention_days`。认不出来的值**不悄悄换成 30**：
 * `archive.ts` 那边是 `retentionSetting ? Number(retentionSetting) : DEFAULT`，
 * 一个 'abc' 会让它拿到 NaN，而不是回退到 30。页面上显示 30 等于替一个坏掉的
 * 配置打掩护，所以这里如实报 invalid，把原值一并回给前端。
 */
function readRetentionDefault(raw: string | null): RetentionDefault {
  if (raw === null || raw === '') {
    return { days: FALLBACK_DEFAULT_RETENTION_DAYS, source: 'fallback', raw }
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) {
    return { days: null, source: 'invalid', raw }
  }
  return { days: n, source: 'setting', raw }
}

function isValidDays(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_RETENTION_DAYS && v <= MAX_RETENTION_DAYS
}

interface AdminAuditInput {
  adminId: string
  action: string
  /**
   * 一句话明细，进 `audit_log.detail`（TEXT，migrations/008）。
   *
   * 从前它被裁到 64 字符塞进 `asset_type`——清理失败的原因带着 NAS 路径与 errno，
   * 被裁掉的正是能查下去的那半段。现在不再裁，上限与超限留痕由
   * `buildAuditDetail` 统一负责（8000 码点，这一族明细离它差两个数量级）。
   */
  detail: string
  decision: 'allow' | 'deny'
  meetingId?: string | null
  /** 周期性会议的场次落这一列：audit_log 没有 sub_meeting_id 列，
   *  而只写 meeting_id 会让同一 meeting_id 下的几场混成一条流。 */
  subMeetingId?: string | null
}

async function recordAdminWrite(ctx: RouteCtx, i: AdminAuditInput): Promise<void> {
  const entry: AuditEntry = {
    occurredAt: ctx.deps.now(),
    actorType: 'admin',
    actorId: i.adminId,
    action: i.action,
    meetingId: i.meetingId ?? null,
    // 场次的编法由 audit.ts 那个共享函数说了算——`keep.extended` 正是按它去数的
    // （阶段 4 · T17），两边各拼各的会让读侧一条都数不着而不报任何错
    assetId:
      i.subMeetingId === undefined || i.subMeetingId === null
        ? null
        : auditSubMeetingAssetId(i.subMeetingId),
    // 存储这一族的动作（改保留天数、暂停清理、删本地文件）对象不是某一份资产，
    // 这一列没有值可填。从前它装着一句话明细，那是 detail 列还不存在时的将就（T15）
    assetType: null,
    decision: i.decision,
    matchedRuleId: null,
    clientKind: 'console',
    detail: buildAuditDetail({ text: i.detail }),
  }
  await ctx.deps.storage.audit.record(entry)
}

// ────────────────────────────────────────────────────────────────
// GET /api/v1/admin/storage
// ────────────────────────────────────────────────────────────────

export async function getStorage(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const s = ctx.deps.storage
  const now = ctx.deps.now()

  const [probe, aggregates, unpurged, needingArchive, pausedRaw, retentionRaw] = await Promise.all([
    s.probeNas(),
    s.stats.aggregates(),
    // 返回的是 local_purged_at IS NULL 且 archived_at <= now 的全部归档行，
    // 也就是「保留期内（本地文件还在）」这一格的总体。archived_at 恒在过去，
    // 所以这条查询在这里等价于"全部未清理的归档"，只是顺手挡掉时钟错乱写进来的
    // 未来时间戳——那种行本来也不该被算进保留窗口统计。
    s.archives.listExpiredUnpurged(now),
    s.archives.listMeetingsNeedingArchive(),
    s.archives.getSetting('cleanup_paused'),
    s.archives.getSetting('default_retention_days'),
  ])

  // 到期与否只问 retention.ts 的 expiresAt，边界也照抄它的"严格过期"
  // （正好走到到期那一秒还不算到期，下一轮才删）。
  let expired = 0
  let expiringIn7d = 0
  for (const rec of unpurged) {
    const at = expiresAt(rec)
    if (at < now) expired++
    else if (at - now <= SEVEN_DAYS_SEC) expiringIn7d++
  }

  const total = probe.totalBytes
  const available = probe.availableBytes
  // 「其他占用」= 总 - 剩余 - 本系统。本系统那一份是**我们自己的记账**
  // （archived_assets × 平台声明的字节数），与 NAS 上真实占用可能对不齐
  // （压缩、去重、别人删过我们的文件），算出负数时钳到 0——负的容量条没有意义，
  // 而且真实的"已用/剩余"两个数仍然照 statfs 原样透出，看得出对不上账。
  const usedByOthers =
    total === null || available === null ? null : Math.max(0, total - available - aggregates.nasBytes)

  const retentionDefault = readRetentionDefault(retentionRaw)

  return json(200, {
    nas: {
      root: s.nasRoot,
      reachable: probe.reachable,
      checkedAt: probe.checkedAt,
      latencyMs: probe.latencyMs,
      error: probe.error,
      totalBytes: total,
      availableBytes: available,
      usedByUsBytes: aggregates.nasBytes,
      usedByOthersBytes: usedByOthers,
      archivedMeetings: aggregates.archivedMeetings,
      // 还有 completed 资产没进 archived_assets 的场次。它同时包含"还没轮到"和
      // "一直归档不成功"两种会议——两者在库里现在长得一模一样（见下面 failedMeetings）。
      pendingMeetings: needingArchive.length,
      // spec §4.9 要的第三个数。归档失败项现在**不落库**：archive.ts 的失败计数
      // 只是本轮内存里的数字，原因只走 console.error（阶段 4 计划 E-d）。
      // 在 T11 建出 job_failures 之前，这里报 null 并说明原因，不编一个数——
      // 把一个缺口伪装成一次判定比不说更糟（同 E-c）。
      failedMeetings: null,
      failedMeetingsNote:
        '归档失败项尚未落库：失败原因目前只写进 worker 日志（阶段 4 计划 E-d）。' +
        '调度器任务建出 job_failures 表之后这里才会有数字，在那之前不编。',
    },
    retention: {
      defaultDays: retentionDefault.days,
      defaultDaysSource: retentionDefault.source,
      defaultDaysRaw: retentionDefault.raw,
      cleanupPaused: isCleanupPaused(pausedRaw),
      liveMeetings: unpurged.length,
      grantedMeetings: aggregates.grantedLiveMeetings,
      expiringIn7dMeetings: expiringIn7d,
      expiredMeetings: expired,
      localBytes: aggregates.localBytes,
    },
  })
}

// ────────────────────────────────────────────────────────────────
// POST /api/v1/admin/storage/retention-days
// ────────────────────────────────────────────────────────────────

interface RetentionDaysBody {
  days?: unknown
}

export async function setRetentionDays(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const body = await readJson<RetentionDaysBody>(req)
  if (!isValidDays(body?.days)) {
    return json(400, { error: 'invalid_days', min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS })
  }
  const days = body.days

  const s = ctx.deps.storage
  const previous = readRetentionDefault(await s.archives.getSetting('default_retention_days'))
  await s.archives.setSetting('default_retention_days', String(days), ctx.deps.now())

  await recordAdminWrite(ctx, {
    adminId: auth.identity.adminId,
    action: 'set_retention_days',
    // 旧值一并记下：光看"改成了 45"回答不了"从多少改的"，而改小会让一批会议
    // 立刻到期（下一轮清理就删本地文件），事后追责需要那个差值。
    detail: `${previous.days ?? previous.raw ?? 'unset'} -> ${days}`,
    decision: 'allow',
  })

  return json(200, { defaultDays: days, previousDefaultDays: previous.days })
}

// ────────────────────────────────────────────────────────────────
// POST /api/v1/admin/storage/cleanup-pause
// ────────────────────────────────────────────────────────────────

interface CleanupPauseBody {
  paused?: unknown
}

/**
 * 「暂停到期清理」——spec §1.2 / §7.2 说的**唯一能阻止不可逆损失的开关**。
 * 三件事一件不能少：
 *   持久化：写 system_settings（不是内存标志。NAS 断连通常伴随重启或切换，
 *           内存标志会在最需要它的时候消失）
 *   记审计：谁在什么时候把它按下/松开
 *   回显：响应里带当前状态，而且是**写完之后重新读一遍**的值，不是把请求体抄回去
 */
export async function setCleanupPause(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const body = await readJson<CleanupPauseBody>(req)
  if (typeof body?.paused !== 'boolean') {
    return json(400, { error: 'missing_paused' })
  }
  const paused = body.paused

  const s = ctx.deps.storage
  // 只写 '1' / '0' 这两个值。retention.ts 的判定是"除了 '0' 和没写过一律算暂停"，
  // 写 'true' / 'yes' 之类同样会被当成暂停，但那会让库里出现第三种取值，
  // 下一个读这张表的人得重新推一遍语义。
  await s.archives.setSetting('cleanup_paused', paused ? '1' : '0', ctx.deps.now())

  await recordAdminWrite(ctx, {
    adminId: auth.identity.adminId,
    action: 'set_cleanup_paused',
    detail: paused ? '暂停到期清理' : '恢复到期清理',
    decision: 'allow',
  })

  // 写后重读：回显的是库里此刻的真值，而不是请求说过什么。这条开关最不能出的错
  // 就是"页面说已恢复、实际还停着"，抄请求体正好挡不住这一类错。
  const effective = isCleanupPaused(await s.archives.getSetting('cleanup_paused'))
  return json(200, { cleanupPaused: effective })
}

// ────────────────────────────────────────────────────────────────
// POST /api/v1/admin/storage/cleanup-now
// ────────────────────────────────────────────────────────────────

interface CleanupNowBody {
  confirm?: unknown
}

/**
 * 「立即清理已到期文件」。**默认 dry-run**（retention.ts 的硬要求 3）：
 * 不带 `confirm: true` 时只返回预览，正好就是原型里那个确认弹窗要列的内容
 * （哪些会议、多大）。真删必须显式带 `confirm: true`。
 *
 * 清理被暂停时不返回 4xx 而是照常返回结果、把 `paused: true` 摆在里面：
 * executeCleanup 本来就会在暂停时什么都不做并如实回报，前端据此显示
 * 「清理已暂停，没有删除任何文件」比一个 409 更说得清发生了什么。
 * 审计那边记成 decision='deny'，与"被拒绝的记录是红的"（§4.10）对齐。
 */
export async function cleanupNow(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const s = ctx.deps.storage
  if (s.cleanup === null) {
    return json(503, {
      error: 'local_archive_root_not_configured',
      message:
        '本进程没有挂载本地归档区（MDE_ARCHIVE_ROOT 未配置），无法执行到期清理。' +
        '这不是"没有可清理的文件"——请检查网关进程的挂载与环境变量。',
    })
  }

  const body = await readJson<CleanupNowBody>(req)
  const now = ctx.deps.now()

  if (body?.confirm !== true) {
    // 预览是只读的（不读文件、不算哈希、不删任何东西），因此不记审计——
    // §1 第 6 条要的是"每一次写操作"。
    const preview = await s.cleanup.preview(now)
    return json(200, {
      dryRun: true,
      cleanupPaused: isCleanupPaused(await s.archives.getSetting('cleanup_paused')),
      items: preview.items,
      totalBytes: preview.totalBytes,
    })
  }

  const result = await s.cleanup.execute(now)

  // 逐场一条：删掉某场会议的本地文件是不可逆的，详情抽屉底部那段"这场会议的
  // 操作历史"（§4.3）要查得到是谁在什么时候删的。只记一条汇总的话，
  // 按 meeting_id 查历史时这件事根本不出现。
  for (const item of result.purged) {
    await recordAdminWrite(ctx, {
      adminId: auth.identity.adminId,
      action: 'purge_local',
      meetingId: item.meetingId,
      subMeetingId: item.subMeetingId,
      detail: `删本地文件 ${item.assetCount} 个，${item.localBytes} 字节`,
      decision: 'allow',
    })
  }
  // 校验不过 = 本轮拒绝删除，需要人工介入。在 job_failures（T11）建出来之前，
  // 审计流是这些失败项唯一能被看见的地方，所以逐条记成"被拒绝"。
  for (const f of result.verificationFailed) {
    await recordAdminWrite(ctx, {
      adminId: auth.identity.adminId,
      action: 'purge_blocked',
      meetingId: f.meetingId,
      subMeetingId: f.subMeetingId,
      detail: f.reason,
      decision: 'deny',
    })
  }
  for (const f of result.failed) {
    await recordAdminWrite(ctx, {
      adminId: auth.identity.adminId,
      action: 'purge_failed',
      meetingId: f.meetingId,
      subMeetingId: f.subMeetingId,
      detail: f.reason,
      decision: 'deny',
    })
  }
  await recordAdminWrite(ctx, {
    adminId: auth.identity.adminId,
    action: 'cleanup_now',
    detail:
      `清理 ${result.purged.length} 场 / 拒删 ${result.verificationFailed.length} 场 / ` +
      `出错 ${result.failed.length} 场${result.paused ? '（清理已暂停）' : ''}`,
    // 一场都没删（被暂停）时记成被拒绝：审计页上它是红的，与"什么都没发生"分得开
    decision: result.paused && result.purged.length === 0 ? 'deny' : 'allow',
  })

  return json(200, {
    dryRun: false,
    paused: result.paused,
    purged: result.purged,
    verificationFailed: result.verificationFailed,
    failed: result.failed,
  })
}

// ────────────────────────────────────────────────────────────────
// POST /api/v1/admin/meetings/:meetingId/extend
// ────────────────────────────────────────────────────────────────

interface ExtendBody {
  days?: unknown
  subMeetingId?: unknown
}

/**
 * §4.3 的「延长 30 天」。
 *
 * 路径上只有 meetingId，但保留窗口的键是 `(meeting_id, sub_meeting_id)`
 * ——周期性会议同一个 meeting_id 下有多场，各有各的归档时间与保留窗口。
 * 场次由请求体的 `subMeetingId` 给，缺省是空串（与库里 `NOT NULL DEFAULT ''`
 * 的单场会议一致）。不做"猜一场"的兜底：猜错就是延长了另一场，而被漏掉的那场
 * 照常到期删除，事后完全看不出来。
 */
export async function extendMeetingRetention(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const meetingId = ctx.params.meetingId ?? ''
  if (meetingId === '') return json(400, { error: 'missing_meeting_id' })

  const body = await readJson<ExtendBody>(req)
  const days = body?.days === undefined ? EXTEND_DEFAULT_DAYS : body.days
  if (!isValidDays(days)) {
    return json(400, { error: 'invalid_days', min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS })
  }
  const subMeetingId = typeof body?.subMeetingId === 'string' ? body.subMeetingId : ''

  const s = ctx.deps.storage
  const rec = await s.archives.findMeetingArchive(meetingId, subMeetingId)
  // extendRetention 是一条无条件的 UPDATE：记录不存在时它影响 0 行、不报错。
  // 不先查就发出去，等于对着一个不存在的会议返回 200——界面显示"已延长 30 天"，
  // 而库里什么都没发生。
  if (rec === null) {
    return json(404, { error: 'archive_not_found', meetingId, subMeetingId })
  }
  // 本地文件已经被清理掉了，延长保留窗口延不回来（§4.9：到期只删本地文件，
  // 记录与 NAS 路径永久保留）。给一个明确的 409，而不是延长一个空窗口。
  if (rec.localPurgedAt !== null) {
    return json(409, {
      error: 'already_purged',
      meetingId,
      subMeetingId,
      purgedAt: rec.localPurgedAt,
      message: '这场会议的本地文件已被清理，延长保留窗口不会把文件找回来——请按 NAS 路径取。',
    })
  }

  await s.archives.extendRetention(meetingId, subMeetingId, days, ctx.deps.now())

  // 新的到期时刻仍然只问 expiresAt，不在这里拼 `rec.archivedAt + ... `——
  // extendRetention 是累加（`extended_days = extended_days + ?`），所以把
  // 这次加的天数叠到刚读到的那一行上，再交给唯一的那个公式算。
  const extendedDays = rec.extendedDays + days
  const nextExpiresAt = expiresAt({ ...rec, extendedDays })

  await recordAdminWrite(ctx, {
    adminId: auth.identity.adminId,
    // 动作名走共享常量：`console-meetings.ts` 的 `keep.extended` 按它数条数
    action: ACTION_EXTEND_RETENTION,
    meetingId,
    subMeetingId,
    detail: `延长 ${days} 天（累计 ${extendedDays} 天）`,
    decision: 'allow',
  })

  return json(200, {
    meetingId,
    subMeetingId,
    addedDays: days,
    extendedDays,
    archivedAt: rec.archivedAt,
    expiresAt: nextExpiresAt,
  })
}
