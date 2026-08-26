import type { AuthStore } from '../store/auth'
import type { MeetingCacheStore } from '../store/meetings'
import type { RecordsApi } from '../tencent/records'
import type { Catalog } from '../catalog/index'
import type { StsManager } from '../sts/manager'
import type { AccessGate, MeetingMeta } from '../policy/access'
import type { ArchivesStore } from '../store/archives'
import type { AuditRecorder } from '../audit/recorder'
import type { DeviceFlow } from '../auth/device'
import type { WecomClient } from '../auth/wecom'
import type { IdentityMapper } from '../auth/identity'
import type { ServiceAuth } from '../auth/service'
import type { AdminAuth } from '../auth/admin'
import type { AdminStore } from '../store/admin'
import { internalError, json } from './respond'
import * as authHandlers from './handlers/auth'
import * as deviceHandlers from './handlers/device'
import * as meetingsHandlers from './handlers/meetings'
import * as webhookHandlers from './handlers/webhook'
import * as consoleAuthHandlers from './handlers/console/auth'
import * as consoleStorageHandlers from './handlers/console/storage'
import type { StorageDeps } from './handlers/console/storage'
import type { RateLimiter } from './ratelimit'
import type { ProgramsStore } from '../store/programs'
import type { GrantsStore, MeetingKey } from '../store/grants'
import type { PolicyStore } from '../store/policy'
import type { AuditStore } from '../store/audit'
import * as consoleGrantsHandlers from './handlers/console/grants'
import type { AuditQueryStore } from '../store/audit'
import * as consoleAuditHandlers from './handlers/console/audit'
import type { AuditMeetingLookup } from './handlers/console/audit'
// 阶段 4 · T6（A3 规则 API + 影响预览）新增的三条依赖与一组路由。
// 追加在文件末尾一侧，不动上面任何一行——本波次有几个任务同时往这个文件里加东西，
// 冲突保持成纯追加型才好合。
import type { ConsoleMeetingsStore } from '../store/console-meetings'
import * as consoleRulesHandlers from './handlers/console/rules'
import * as consoleMeetingsHandlers from './handlers/console/meetings'
import type { VisibilityDeps } from '../worker/visibility'
// 阶段 4 · T10（A6 内容读取 API）新增的一条依赖与两条路由。同样只追加，
// 不动上面任何一行——本波次几个任务都在往这个文件里加东西，冲突保持成纯追加型才好合。
import * as consoleContentHandlers from './handlers/console/content'
import type { ContentLookup } from './handlers/console/content'
// 阶段 4 · T11（A4 定时任务）新增的一条依赖与两条路由。同样只追加，不动上面任何一行。
// **这里 import 的是 handler 与 store，不是 src/worker/scheduler.ts**——
// 调度器属于 worker 进程，网关一行都不许碰，见那个文件的文件头。
import * as consoleJobsHandlers from './handlers/console/jobs'
import type { JobsDeps } from './handlers/console/jobs'

/**
 * 聚合全部前置任务的模块实例，供路由层组装。测试用 stub 注入，
 * src/index.ts 用真实模块装配——两者共用同一份类型契约。
 */
export interface AppDeps {
  now: () => number
  jwtSecret: string
  gatewayBaseUrl: string
  recordsApi: RecordsApi
  catalog: Catalog
  /** 采集权限判定（allow 栈）。网关只判第三栈，拉取/归档两栈是 worker 的事 */
  accessGate: AccessGate
  /** 规则里的 `arch` 条件要的归档状态。只用到这一个方法，故收窄到它 */
  archives: Pick<ArchivesStore, 'listArchivedMeetingKeys'>
  auditRecorder: AuditRecorder
  deviceFlow: DeviceFlow
  /** 企微未配置时为 null——WECOM_ROUTES 里的路由会因此统一返回 501 */
  wecomClient: WecomClient | null
  identityMapper: IdentityMapper
  serviceAuth: ServiceAuth
  authStore: AuthStore
  stsManager: StsManager
  meetingsCache: MeetingCacheStore
  /** 登录端点限流器（IP 维度 + handler 内的账号维度共用同一个实例，见 ratelimit.ts） */
  loginRateLimiter: RateLimiter
  /** 网关前方会追加 X-Forwarded-For 的可信代理层数，决定 clientIp 取右数第几段 */
  trustedProxyHops: number
  /** 管理员会话与账号管理（Task 3，A1）——与企微/服务账号认证完全独立的第三条认证线 */
  adminAuth: AdminAuth
  adminStore: AdminStore
  /** 生产环境必须为 true（cookie 的 Secure 属性依据它）；本地 http 开发环境为 false */
  cookieSecure: boolean

  // ── 阶段 4 · T7（A3 采集授权 API + 采集清单） ─────────────────────
  /** 采集程序（service_accounts）的控制台读写侧。读侧不含 secret_hash */
  programs: ProgramsStore
  /** 逐会议授权与人工改写的**写侧**。上面 accessGate 内部持有的那份只用于读判定 */
  grantsStore: GrantsStore
  /**
   * 采集清单重算要读归档行（local_purged_at / nas_dir）与本地资产。
   * 上面那个 `archives` 是收窄到 listArchivedMeetingKeys 的 Pick，只够规则的
   * arch 条件用，读不到清单要的那三列，故另开一个字段而不是把它改宽——
   * 改宽会动到既有行，而本阶段有多个任务在并行往这个文件追加东西。
   */
  archivesStore: ArchivesStore
  /**
   * 一批会议的元数据，**批量**。采集清单按程序算，逐场取就是成百上千次往返。
   *
   * 声明成结构化的函数字段而不是某个 store 的方法类型：它的正主是 T1 的
   * `ConsoleMeetingsStore.getMeetings`，T1 落地前由 `src/index.ts` 里的临时实现
   * 顶着。与 `src/worker/archive.ts` 的 `ArchiveDeps.getMeeting` 是同一个先例。
   *
   * 查不到的会议**不要造一个空壳顶上**：返回数组里没有它，`visibility.ts` 会把它
   * 判成「判不出来」并落到拒绝一侧（见那个文件里 VisibilityDeps.getMeetings 的注释）。
   * 查得到但元数据不全的行照样返回，带上 `missingFacts`（阶段 4 · T13）——
   * **类型必须是 `MeetingMeta` 而不是 `Meeting`**：两者结构上可以互相赋值，
   * 写成 `Meeting` 编译一样过，但那笔账就在类型上看不见了，下一个人会以为没有。
   */
  getMeetings: (keys: readonly MeetingKey[]) => Promise<readonly MeetingMeta[]>
  /** 归档存储页与保留窗口动作（阶段 4 · T8，A3）。形状与理由见
   *  handlers/console/storage.ts 的文件头——NAS 探测、到期清理、审计写侧都在里面，
   *  刻意不复用上面那个收窄成 listArchivedMeetingKeys 的 `archives` 字段 */
  storage: StorageDeps
  /** 审计读侧（阶段 4 · T3）。与写侧 auditRecorder 分成两个字段是故意的——
   *  只写不读的调用点不该被迫实现两个用不上的查询，见 store/audit.ts 的注释 */
  auditQuery: AuditQueryStore
  /** 审计「对象」列的会议标题批量补齐（阶段 4 · T9）。audit_log 只存 id，
   *  标题在 meetings / meeting_cache 两张表里，逐行查一页就是 200 次往返 */
  auditMeetings: AuditMeetingLookup
  // ── 阶段 4 · T6（A3 规则 API）──────────────────────────────────────────
  /**
   * 规则的读写侧（T2）。**判定路径不走这里**：网关判 allow 栈走 `accessGate`，
   * 这一份是控制台规则页的 CRUD 与影响预览要的「含 disabled 的全部规则」，
   * 采集清单重算（T7 的 inventory 端点）要的启用规则也读它。
   */
  policyStore: PolicyStore
  /**
   * 审计写侧。管理员的每一次写操作都要落一行（阶段 4 计划 §1 约束 6），而
   * `auditRecorder` 只认网关那三种动作（下载、登录、列会议），管理侧的动作
   * 直接走 store 的 `record`——在 recorder 上给每个管理端点加一个方法，
   * 只是把同一个 `AuditEntry` 换个地方拼。
   */
  auditStore: AuditStore
  /**
   * 控制台的会议查询（T1）。会议记录页的查询底座，也是影响预览与「这条规则命中
   * 哪几场」要的会议事实来源——会议全集只有这一个来源：`meetings` 那张表，
   * 不碰 `meeting_cache`（见计划 §0 E-a）。
   */
  consoleMeetings: ConsoleMeetingsStore
  /**
   * 单场会议的采集权限答疑（`explainMeetingAccess`）与整页批量求值
   * （`evaluateInventory`）共用的那组读法。**与采集清单重算是同一套依赖**——
   * 控制台说「准许采集」而网关取的时候被拒，就是这两处各判一遍的下场。
   */
  meetingVisibility: VisibilityDeps
  /**
   * 会议详情抽屉底部那一段操作历史（阶段 4 · T3 的读侧）。
   *
   * 收窄到 `listForMeeting` 一个方法：这个 handler 只答「这场会议发生过什么」，
   * 不做审计流的分页筛选（那是 A5 的事）。与 `archives: Pick<ArchivesStore, …>`
   * 同一个理由——依赖上写着用得到的那几件事，读代码的人不必去猜。
   */
  meetingHistory: Pick<AuditQueryStore, 'listForMeeting'>
  /**
   * `asset_contents` 的读侧（阶段 4 · T10，A6）。写侧是 T4 的 `src/store/contents.ts`,
   * 本字段一个字都不改它。
   *
   * 单开一个窄接口而不是把 `ContentsStore` 整个塞进来：那个 store 的 `get` 要**五段全键**,
   * 答不了内容预览真正要问的「这场会议这一类有几段」——而同一类文本资产可以有多段
   * （见 migrations/007_asset_contents.sql 的表头），按四段查会漏掉第二段。
   * 与 `auditMeetings` 收窄成两个方法是同一个先例。
   */
  contents: ContentLookup
  /**
   * 定时任务的**读侧 + 手动触发的排队**（阶段 4 · T11，A4）。
   *
   * 它只握着 `JobsStore` 与审计写侧——**网关不执行任何任务**。「立即运行」在这里
   * 落一行 `job_runs.status='queued'`，由 worker 进程的调度器认领。网关是多实例的，
   * 四个任务各跑 N 份意味着 N 个实例同时对同一批本地文件执行不可逆删除。
   */
  jobs: JobsDeps
}

export interface RouteCtx {
  params: Record<string, string>
  deps: AppDeps
}

type Handler = (req: Request, ctx: RouteCtx) => Promise<Response>

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

/** `:param` 段编译为具名捕获组；`[^/]+` 保证不会跨段匹配，路由间天然无歧义 */
function compile(method: string, path: string, handler: Handler): Route {
  const keys: string[] = []
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1))
        return '([^/]+)'
      }
      return segment
    })
    .join('/')
  return { method, pattern: new RegExp(`^${pattern}$`), keys, handler }
}

const ROUTES: Route[] = [
  compile('POST', '/api/v1/auth/device/code', authHandlers.deviceCode),
  compile('POST', '/api/v1/auth/device/token', authHandlers.deviceToken),
  compile('GET', '/auth/wecom/callback', authHandlers.wecomCallback),
  compile('GET', '/device', deviceHandlers.devicePage),
  compile('POST', '/api/v1/auth/refresh', authHandlers.refresh),
  compile('POST', '/api/v1/auth/service-token', authHandlers.serviceToken),
  compile('POST', '/api/v1/auth/logout', authHandlers.logout),

  compile('GET', '/api/v1/meetings', meetingsHandlers.listMeetings),
  compile('GET', '/api/v1/meetings/:meetingId', meetingsHandlers.getMeeting),
  compile('GET', '/api/v1/meetings/:meetingId/assets', meetingsHandlers.listAssets),
  compile('POST', '/api/v1/assets/:assetId/download-url', meetingsHandlers.downloadUrl),

  // 同一路径两个方法：GET 是事件订阅配置时的 URL 有效性校验（腾讯要求回调服务
  // 必须同时支持 GET 与 POST），POST 才是事件推送。缺 GET 则后台连保存都保存不上。
  compile('GET', '/webhook/tencent-meeting', webhookHandlers.handleWebhookVerify),
  compile('POST', '/webhook/tencent-meeting', webhookHandlers.handleWebhook),

  compile('GET', '/healthz', async () => json(200, { status: 'ok' })),

  // 管理员会话与账号管理（Task 3，A1）——与上面企微/服务账号认证线完全独立，
  // 不共用 requireAuth，走各自的 requireAdminAuth（见 middleware.ts）
  compile('POST', '/api/v1/admin/auth/login', consoleAuthHandlers.login),
  compile('POST', '/api/v1/admin/auth/logout', consoleAuthHandlers.logout),
  compile('GET', '/api/v1/admin/auth/me', consoleAuthHandlers.me),
  compile('GET', '/api/v1/admin/accounts', consoleAuthHandlers.listAccounts),
  compile('POST', '/api/v1/admin/accounts', consoleAuthHandlers.createAccount),
  compile('DELETE', '/api/v1/admin/accounts/:id', consoleAuthHandlers.deleteAccount),

  // A3 采集授权（阶段 4 · T7）。全部走 requireAdminAuth，见 handlers/console/grants.ts。
  // 周期性会议的场次 id 一律从查询串 `?sub=` 取（路由上只有 :meetingId，而两个
  // DELETE 没有请求体），四个会议维度的端点因此只有一种写法
  compile('GET', '/api/v1/admin/programs', consoleGrantsHandlers.listPrograms),
  compile('POST', '/api/v1/admin/programs', consoleGrantsHandlers.createProgram),
  compile('GET', '/api/v1/admin/programs/:id/inventory', consoleGrantsHandlers.programInventory),
  compile('POST', '/api/v1/admin/meetings/:meetingId/grants', consoleGrantsHandlers.grantMeeting),
  compile('DELETE', '/api/v1/admin/meetings/:meetingId/grants/:programId', consoleGrantsHandlers.revokeGrant),
  compile('PUT', '/api/v1/admin/meetings/:meetingId/override', consoleGrantsHandlers.putOverride),
  compile('DELETE', '/api/v1/admin/meetings/:meetingId/override/:kind', consoleGrantsHandlers.revokeOverride),
  // 归档存储与保留窗口（阶段 4 · T8，A3）——spec §4.9 两块 + §4.3 的「延长 30 天」
  compile('GET', '/api/v1/admin/storage', consoleStorageHandlers.getStorage),
  compile('POST', '/api/v1/admin/storage/retention-days', consoleStorageHandlers.setRetentionDays),
  compile('POST', '/api/v1/admin/storage/cleanup-pause', consoleStorageHandlers.setCleanupPause),
  compile('POST', '/api/v1/admin/storage/cleanup-now', consoleStorageHandlers.cleanupNow),
  compile('POST', '/api/v1/admin/meetings/:meetingId/extend', consoleStorageHandlers.extendMeetingRetention),
  // 操作审计（阶段 4 · A5，T9）。spec §4.10
  compile('GET', '/api/v1/admin/audit', consoleAuditHandlers.listAudit),
  compile('GET', '/api/v1/admin/meetings/:meetingId/history', consoleAuditHandlers.meetingHistory),
  // 自动规则（阶段 4 · T6，A3）。全部走 requireAdminAuth，写操作一律进 audit_log。
  // /preview 与 /:id 不会互相吃掉：compile 出来的 `[^/]+` 不跨段，
  // 而 preview 是 POST、:id 是 PATCH/DELETE，方法先一步就分开了
  compile('GET', '/api/v1/admin/rules', consoleRulesHandlers.listRules),
  compile('POST', '/api/v1/admin/rules', consoleRulesHandlers.createRule),
  compile('POST', '/api/v1/admin/rules/preview', consoleRulesHandlers.previewRules),
  compile('GET', '/api/v1/admin/rules/:id/matches', consoleRulesHandlers.ruleMatches),
  compile('PATCH', '/api/v1/admin/rules/:id', consoleRulesHandlers.patchRule),
  compile('DELETE', '/api/v1/admin/rules/:id', consoleRulesHandlers.deleteRule),
  // A2 会议查询（阶段 4 · T5）。**triage 必须排在 :meetingId 前面**——路由是
  // 顺序匹配的，`:meetingId` 编译成 `([^/]+)`，会先把 `/meetings/triage` 吃掉，
  // 于是分诊条请求变成「查一场 id 为 triage 的会议」，稳定返回 404。
  compile('GET', '/api/v1/admin/meetings/triage', consoleMeetingsHandlers.meetingTriage),
  compile('GET', '/api/v1/admin/meetings', consoleMeetingsHandlers.listMeetings),
  compile('GET', '/api/v1/admin/meetings/:meetingId', consoleMeetingsHandlers.getMeeting),
  // A6 内容预览（阶段 4 · T10）。spec §4.4。两条都走 requireAdminAuth，且**两条都留痕**
  // ——管理员查看会议内容会留痕，被规则禁止采集的那些尤其（spec §2）。
  //
  // 不会与上面那条 `/:meetingId` 打架：`compile` 出来的 `[^/]+` 不跨段，三段路径
  // 匹配不到两段的模式。`/content/chapters` 与 `/content` 同理，多一段就是另一条路由。
  compile('GET', '/api/v1/admin/meetings/:meetingId/content', consoleContentHandlers.getContent),
  compile('GET', '/api/v1/admin/meetings/:meetingId/content/chapters', consoleContentHandlers.getChapters),
  // A4 定时任务（阶段 4 · T11）。spec §4.8。
  // `/jobs/:name/run` 与 `/jobs` 段数不同，compile 出来的 `[^/]+` 不跨段，
  // 两者不会互相吃掉
  compile('GET', '/api/v1/admin/jobs', consoleJobsHandlers.listJobs),
  compile('POST', '/api/v1/admin/jobs/:name/run', consoleJobsHandlers.runJob),
]

/**
 * 依赖企业微信的路由。企微未配置（`deps.wecomClient === null`）时统一返回 501。
 *
 * 为什么 device/code 与 device/token 也在列：设备授权只能由 wecomCallback 完成
 * （`completeAuthorization` 仅在那里被调用），没有企微就永远走不完。发一个注定
 * 无法被授权的 device_code，比直接说「本部署未启用」更糟。
 *
 * 放在路由表而非各 handler 内：新增设备流程路由时不会漏掉这道守卫。
 */
const WECOM_ROUTES = new Set([
  'POST /api/v1/auth/device/code',
  'POST /api/v1/auth/device/token',
  'GET /auth/wecom/callback',
  'GET /device',
])

/** 仅对写型登录端点限流（webhook 是腾讯侧调用、GET /device 是浏览器页，均不在此列） */
const RATE_LIMITED = new Set([
  'POST /api/v1/auth/device/code',
  'POST /api/v1/auth/device/token',
  'POST /api/v1/auth/service-token',
  'POST /api/v1/auth/refresh',
  // 管理员登录端点：与设备/服务账号登录端点同等对待，防止密码穷举
  'POST /api/v1/admin/auth/login',
])

/**
 * 取客户端 IP 用于限流。XFF 由每跳代理在末尾追加，越靠右越可信——最左段是
 * 客户端自填、可伪造的值，绝不能取首段（否则换个请求头即可绕过限流）。
 * 取右数第 trustedHops 段：trustedHops = 网关前方会追加 XFF 的可信代理层数
 * （默认 1，单层反向代理）。链条比预期短时回退到最左端已知值。
 */
function clientIp(req: Request, trustedHops: number): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (parts.length > 0) {
      // 纵深防御：即便 loadConfig 已校验 trustedHops 为正整数，这里仍不用 `!`
      // 强行断言——任何残留路径算出空下标时，回退到 x-real-ip/'unknown'，
      // 避免产生 undefined 限流 key（会把不同客户端合并进同一个桶）。
      const seg = parts[Math.max(0, parts.length - trustedHops)]
      if (seg) return seg
    }
  }
  return req.headers.get('x-real-ip') ?? 'unknown'
}

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // 限流在路由派发之前：按「方法+路径」精确匹配（这些端点无路径参数），
    // key 含 pathname 与 ip: 命名空间前缀，使每个端点对每个 IP 有独立的桶，
    // 且不会与 handler 内的账号维度桶（acct: 前缀，见 handlers/auth.ts）撞 key。
    if (RATE_LIMITED.has(`${req.method} ${url.pathname}`)) {
      if (!deps.loginRateLimiter.allow(`ip:${url.pathname}|${clientIp(req, deps.trustedProxyHops)}`, deps.now())) {
        return json(429, { error: 'rate_limited' })
      }
    }

    if (deps.wecomClient === null && WECOM_ROUTES.has(`${req.method} ${url.pathname}`)) {
      return json(501, { error: 'wecom_not_configured' })
    }

    for (const route of ROUTES) {
      if (route.method !== req.method) continue
      const match = route.pattern.exec(url.pathname)
      if (!match) continue

      const params: Record<string, string> = {}
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? '')
      })

      try {
        return await route.handler(req, { params, deps })
      } catch (err) {
        return internalError(err)
      }
    }

    return json(404, { error: 'not_found' })
  }
}
