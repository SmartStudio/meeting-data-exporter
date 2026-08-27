import { loadConfig } from './config'
import { createPool, runMigrations } from './store/db'
import { createStsStore } from './store/sts'
import { createGrantsStore } from './store/grants'
import { createPolicyStore } from './store/policy'
import { createAuthStore } from './store/auth'
import { createAdminStore } from './store/admin'
import { createAuditStore } from './store/audit'
import { createJobsStore, schedulerTzOffsetSec } from './store/jobs'
import { createMeetingCacheStore } from './store/meetings'
import { createTencentClient } from './tencent/client'
import { createRecordsApi } from './tencent/records'
import { createAddressesApi } from './tencent/addresses'
import { createCatalog } from './catalog/index'
import { createStsManager } from './sts/manager'
import { createTokenCipher } from './sts/cipher'
import { verifySignature, decryptEvent, decryptCheckStr } from './sts/crypto'
import { createAccessGate } from './policy/access'
import { createArchivesStore } from './store/archives'
import { createAuditRecorder } from './audit/recorder'
import { createDeviceFlow } from './auth/device'
import { createWecomClient } from './auth/wecom'
import { createIdentityMapper } from './auth/identity'
import { createServiceAuth } from './auth/service'
import { createAdminAuth } from './auth/admin'
import { createApp, type AppDeps } from './http/router'
import { createAuditMeetingLookup } from './http/handlers/console/audit'
import { createContentLookup } from './http/handlers/console/content'
import { createLoginRateLimiter } from './http/ratelimit'
import { createProgramsStore } from './store/programs'
import { createConsoleMeetingsStore } from './store/console-meetings'
import type { MeetingKey } from './store/grants'
import type { Meeting } from './domain/types'
import type { RowDataPacket } from 'mysql2/promise'
import { createConsoleStorageStore } from './store/console-storage'
import { probeNas } from './worker/nas-probe'
import { previewCleanup, executeCleanup } from './worker/retention'
import type { StorageDeps } from './http/handlers/console/storage'
import type { VisibilityDeps } from './worker/visibility'

/** STS-Token 续期检查间隔：剩余有效期低于 1/3 时才会真正发起申请（见 sts/manager.ts） */
const STS_RENEW_CHECK_INTERVAL_MS = 5 * 60 * 1000

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const pool = createPool(config.databaseUrl)
  await runMigrations(pool)

  const now = (): number => Math.floor(Date.now() / 1000)

  const tencentClient = createTencentClient(config.tencent, {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // 毫秒时钟：项目里通用的 now() 是秒级，喂给令牌桶会让补充速率慢 1000 倍
    nowMs: Date.now,
  })
  const recordsApi = createRecordsApi(tencentClient, config.tencent.operatorId)
  const addressesApi = createAddressesApi(tencentClient, config.tencent.operatorId)

  const stsStore = createStsStore(pool)
  const tokenCipher = createTokenCipher(config.stsEncKey)
  const stsManager = createStsManager({
    store: stsStore,
    client: tencentClient,
    operatorId: config.tencent.operatorId,
    webhookToken: config.webhook.token,
    aesKey: config.webhook.aesKey,
    encrypt: tokenCipher.encrypt,
    decrypt: tokenCipher.decrypt,
    verify: verifySignature,
    decryptEvent,
    decryptCheckStr,
  })

  const catalog = createCatalog({ addressesApi, stsManager, now })

  const policyStore = createPolicyStore(pool)
  // 网关这边只读改写，不写。写侧在控制台的管理端点里（阶段 4）
  const grantsStore = createGrantsStore(pool)
  // 采集程序（`service_accounts`）的控制台读侧。**建在 accessGate 之前**：
  // 判定要问它「这个程序还启用着吗」（阶段 5 · A8，spec §11 缺口 4）。
  // 下面 AppDeps.programs 用的是同一个实例——两处各建一个不会出错，但会让
  // 「判定读的是不是控制台改的那张表」变成一句要去核对的话
  const programsStore = createProgramsStore(pool)
  const accessGate = createAccessGate({
    store: policyStore,
    grants: grantsStore,
    // 查不到的程序按「不启用」处理：它被删掉之后令牌可能还没过期，
    // 而「查不到」与「停用了」对判定而言是同一件事（见 ProgramStatusSource）
    programs: { isProgramEnabled: async (id) => (await programsStore.find(id))?.enabled === true },
  })
  // 网关只用它读「这场会议归档了没有」（规则的 arch 条件）——归档流水线的写侧
  // 在 worker 进程里，两边共用同一份 store 定义，不各写一遍 SQL
  const archivesStore = createArchivesStore(pool)

  const auditStore = createAuditStore(pool)
  const auditRecorder = createAuditRecorder(auditStore, now)

  const authStore = createAuthStore(pool)
  const deviceFlow = createDeviceFlow({ store: authStore, baseUrl: config.gatewayBaseUrl })
  // 企微未配置 = 本次部署不启用扫码登录（合法形态），设备授权流程整体返回 501
  const wecomClient = config.wecom === null ? null : createWecomClient(config.wecom, { fetch, now })
  if (wecomClient === null) {
    console.warn('[startup] WeCom 未配置：设备授权流程（扫码登录）已停用，客户端请使用服务账号认证')
  }
  const identityMapper = createIdentityMapper(config.identityStrategy, {
    lookupTable: async (wecomUserId) => (await authStore.lookupIdentityMap(wecomUserId))?.tmUserId ?? null,
    lookupByEmail: async (email) => (await authStore.lookupIdentityByEmail(email))?.tmUserId ?? null,
  })
  const serviceAuth = createServiceAuth({ store: authStore })
  const meetingsCache = createMeetingCacheStore(pool)
  const loginRateLimiter = createLoginRateLimiter()

  // 管理员会话与账号管理（Task 3，A1）——与企微/服务账号认证完全独立的第三条认证线，
  // 不共用 authStore/上面任何一张登录相关表（见 migrations/003_console_stage2.sql 的注释）
  const adminStore = createAdminStore(pool)
  const adminAuth = createAdminAuth({ store: adminStore })
  // cookie 的 Secure 属性：本仓库目前没有任何「是否生产环境」的既有判断机制
  // （既无 NODE_ENV 读取，也无 config.ts 里的同类字段），因此不引入 NODE_ENV
  // 这第一套判断逻辑，而是复用已经校验过的 config.gatewayBaseUrl——它就是本次
  // 部署对外可见的地址，协议是 https 即视为可以安全下发 Secure cookie。
  // 本地 http 开发环境 gatewayBaseUrl 一般是 http://localhost:3000 之类，此时
  // cookieSecure=false，避免"浏览器悄悄丢弃 cookie"这种排查成本极高的静默失败
  // （见 http/handlers/console/auth.ts 的 cookieAttrs 注释）。
  const cookieSecure = new URL(config.gatewayBaseUrl).protocol === 'https:'

  // 采集授权（阶段 4 · T7，A3）。程序列表与建号的读写侧——注意这个 store 的读侧
  // 类型里没有 secret_hash，控制台想漏也漏不出去（见 store/programs.ts 的文件头）。
  // 实例在上面 accessGate 那里就建好了（阶段 5 · A8 之后判定也要读它）

  /**
   * 采集清单（`worker/visibility.ts`）要批量的会议元数据。正主就是 T1 的
   * `ConsoleMeetingsStore.getMeetings`——它与 `VisibilityDeps.getMeetings` 的语义
   * 逐条对得上，包括「查不到的会议不造空壳顶上」那一条。
   *
   * **曾经的一处缺口（T13），已修**：`meetings` 表的列全部 nullable，而 `getMeetings`
   * 把 `subject IS NULL` 折成空串。空标题会让 `title has X → allow` 判不匹配
   * （落在安全侧），但同样会让 `title has X → deny` 判不匹配——**落在放行侧**，
   * 再被一条低优先级的 allow 规则接手。
   *
   * **修法**：判定分开「事实为空」与「没有这个事实」，一共加了三段，都不是重构：
   *
   * 1. `getMeetings` 折成空串的**同时记一笔账**——`MeetingMeta.missingFacts`
   *    （`store/console-meetings.ts` 的 `toDomainMeeting`）。行照样返回，不丢掉：
   *    对一行确实存在、只是列是 NULL 的记录，说「在 meetings 表里查不到」是假话。
   * 2. `policy/conds.ts`：用到了缺失事实的条件返回新的 `fact_missing`，
   *    与「真的比对过，不成立」是两条路径；整条规则据此给出 `undecidable`。
   * 3. `policy/stacks.ts`：判不出来的规则**说了算但说不清楚**，与 effect 脏数据
   *    同一个处理——不再往下找，落到本栈的安全侧（allow → deny，fetch / archive
   *    → skip），`source` 记 `'undecidable'`，理由里写明是元数据不全而非不匹配。
   *
   * 归档侧的同一个口子（`worker/archive.ts` 的 `factsFor` 也在 `?? ''`）一并堵上。
   * 清单里这类会议报 `meeting_unknown`，但理由与「表里查不到」不是同一句话。
   */
  const consoleMeetings = createConsoleMeetingsStore(pool, { policy: policyStore })
  // 归档存储页（阶段 4 · T8，A3）。两个根目录走 process.env 而不是 loadConfig，
  // 与 worker 那边同一口径（它们是由 systemd / 容器挂载决定的进程编排参数）。
  //
  // 与 worker 不同的是**这里不做启动期强校验**：网关的其余功能（取数、授权、审计）
  // 与 NAS 挂载无关，为一个只服务于一张页面的路径把整个网关拒绝启动是过度反应。
  // 代价被显式挡在两处，都不会静默：
  //   - 没配 MDE_NAS_ROOT：probeNas 收到空串直接返回 reachable=false + 一句原因，
  //     页面上就是"NAS 不可达"，而不是一片空白或"正常"
  //   - 没配 MDE_ARCHIVE_ROOT：cleanup 注入成 null，清理端点返回 503 并说清是
  //     挂载/配置问题，而不是"没有可清理的文件"
  const nasRoot = process.env.MDE_NAS_ROOT ?? ''
  const localArchiveRoot = process.env.MDE_ARCHIVE_ROOT ?? ''
  if (nasRoot === '' || localArchiveRoot === '') {
    console.warn(
      '[startup] MDE_NAS_ROOT / MDE_ARCHIVE_ROOT 未全部配置：控制台「归档存储」页的' +
        '连通探测与「立即清理已到期」会相应降级（详见 http/handlers/console/storage.ts）',
    )
  }
  // 定时任务的读写侧。**一个实例给两处用**：AppDeps.jobs（定时任务页）与
  // 下面 StorageDeps.jobFailures（归档存储页的「归档失败 N 场」，阶段 5 · A8）。
  // 各建一个不会出错，但会让「两个页面上的失败数是不是同一个来源」变成一句
  // 要去核对的话
  const jobsStore = createJobsStore(pool)
  const storage: StorageDeps = {
    nasRoot: nasRoot === '' ? null : nasRoot,
    // 容量与连通只有这一个来源。handler 里绝不另跑 statfs，否则控制台看到的数字
    // 会与 worker 归档时看到的不是同一份
    probeNas: () => probeNas(nasRoot, now),
    stats: createConsoleStorageStore(pool),
    archives: archivesStore,
    audit: auditStore,
    cleanup:
      localArchiveRoot === ''
        ? null
        : {
            preview: (t) => previewCleanup({ archives: archivesStore, localRoot: localArchiveRoot }, t),
            // `confirm: true` 这个字面量只出现在装配处这一行：retention.ts 要求
            // 每一个调用点都写明"这次是真删"，handler 那边用"调不调 execute"表达
            // 确认，不去伪造这个常量
            execute: (t) => executeCleanup({ archives: archivesStore, localRoot: localArchiveRoot }, t, true),
          },
    // spec §4.9 的「归档失败」计数（阶段 5 · A8）。与定时任务页读的是同一张
    // job_failures、同一个实例
    jobFailures: jobsStore,
  }

  // 控制台的会议查询（阶段 4 · T5，A2）。
  // meetingVisibility 的四件依赖与 worker 的采集清单重算（computeProgramInventory）
  // 是**同一组**——控制台答「这场会议准不准采集」和网关真去取时的判定必须同源，
  // 各判一遍的下场是「详情抽屉说准许、程序取的时候被拒」。
  // 会议查询 store 用上面那一个实例，不另建。
  const meetingVisibility: VisibilityDeps = {
    policy: policyStore,
    grants: grantsStore,
    archives: archivesStore,
    getMeetings: (keys) => consoleMeetings.getMeetings(keys),
  }

  const deps: AppDeps = {
    now,
    jwtSecret: config.jwtSecret,
    gatewayBaseUrl: config.gatewayBaseUrl,
    recordsApi,
    catalog,
    accessGate,
    archives: archivesStore,
    auditRecorder,
    deviceFlow,
    wecomClient,
    identityMapper,
    serviceAuth,
    authStore,
    stsManager,
    meetingsCache,
    loginRateLimiter,
    trustedProxyHops: config.trustedProxyHops,
    adminAuth,
    adminStore,
    cookieSecure,
    // 阶段 4 · T7（A3 采集授权）
    programs: programsStore,
    grantsStore,
    policyStore,
    archivesStore,
    auditStore,
    getMeetings: consoleMeetings.getMeetings,
    storage,
    // 审计读侧（阶段 4 · A5）。与 auditRecorder 是同一个 createAuditStore 的
    // 两个面：写侧只有 record()，读侧只有查询，两者共用同一份 SQL 定义
    auditQuery: auditStore,
    auditMeetings: createAuditMeetingLookup(pool),
    // 阶段 4 · T6（A3 规则 API）。会议查询 store 与上面 getMeetings 用的是**同一个实例**：
    // 两份实例指向同一个池只是多一层间接，而 triage 的「待授权」与影响预览都要
    // 求值采集权限栈，注入的 policy 必须是同一份
    consoleMeetings,
    meetingVisibility,
    meetingHistory: auditStore,
    // 归档失败那一格的真原因（阶段 5 · D-4）。**同一个 jobsStore 实例**——
    // 定时任务页的失败项表、归档存储页的「归档失败 N 场」、抽屉里这句话读的
    // 必须是同一张 job_failures，否则三处会互相打架
    archiveFailures: jobsStore,
    // 阶段 4 · T10（A6 内容读取）。`asset_contents` 的读侧，与 T4 的写侧
    // （src/store/contents.ts，由 worker 与回填脚本使用）分成两个面：网关进程
    // 只读、只按三段键取正文，写侧那套 NAS 读文件 + 哈希校验一行都用不上
    contents: createContentLookup(pool),
    // 阶段 4 · T11（A4 定时任务）——**只装读侧与手动触发的排队**。
    // 调度器本身在 worker 进程里（src/worker/scheduler.ts），网关一行都不碰：
    // 网关是多实例的，四个任务各跑 N 份意味着 N 个实例同时对同一批本地文件
    // 执行不可逆删除。
    jobs: {
      jobs: jobsStore,
      audit: auditStore,
      // **必须与调度器进程用同一个值**，两处读的是同一个环境变量。
      // 配得不一样时「下次运行」会比真实时刻差几个小时，而且不报任何错。
      tzOffsetSec: schedulerTzOffsetSec(process.env),
    },
  }

  const app = createApp(deps)
  // PORT / HOST 走 process.env 而非 loadConfig：它们是进程编排参数（由 systemd /
  // 容器 / 反向代理决定），不是业务配置。HOST 用于把监听面收窄到内网地址——
  // 例如只让同机的反向代理访问时填其网桥地址，避免服务直接暴露在公网。
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer in 1..65535, got: ${process.env.PORT}`)
  }
  const hostname = process.env.HOST || '0.0.0.0'
  const server = Bun.serve({ port, hostname, fetch: app })
  console.log(`meeting-export-gateway listening on ${hostname}:${server.port}`)

  // 回调是异步的——不能等到过期才申请（design doc §5.3）。启动时先跑一次，
  // 随后每 5 分钟检查一次剩余有效期，真正发起续期申请的频率由 ensureFresh
  // 内部的 1/3 阈值判断决定，这里只负责定期"问一下要不要续"。
  const renewLoop = (): void => {
    const t = now()
    stsManager.ensureFresh(t).catch((err: unknown) => {
      console.error('sts ensureFresh failed', err)
    })
    // 看门狗另一半：清理超时未回调的 pending，防止其无界增长
    stsManager.pruneStale(t).catch((err: unknown) => {
      console.error('sts pruneStale failed', err)
    })
  }
  renewLoop()
  setInterval(renewLoop, STS_RENEW_CHECK_INTERVAL_MS)
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err)
  process.exit(1)
})
