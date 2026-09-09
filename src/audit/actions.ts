/**
 * `audit_log.action` 的动作登记表（阶段 5 · A9）。**全项目唯一一份。**
 *
 * ## 为什么把它从 handlers/console/audit.ts 提出来单独放
 *
 * 这张表从前长在**读侧**（审计 API 的 handler）里，而动作名是**写侧**各个 handler
 * 各写各的字面量。两侧从来没有任何东西把它们钉在一起，结果是可以预料的：
 * 到阶段 5 为止库里会出现 28 种动作，表里只有 3 行——**界面上「动作」那一列
 * 有 25 种记录显示成英文 snake_case**。不会有测试变红，不会有门槛变红，界面也不坏，
 * 只是这一页存在的全部理由（给人读）在一大半记录上落了空。
 *
 * 提到 `src/audit/` 之后：写侧从这里取常量，读侧从这里取标签，**同一份数据**。
 * 加一个动作时如果只加常量不加标签，`AUDIT_ACTION` 那个 `satisfies` 当场编译不过
 * （`AuditAction` 是从标签表的键推出来的）；如果两个都不加而直接写字面量，
 * `tests/audit/actions.test.ts` 的源码扫描会点名那一行。
 *
 * ## 标签怎么写
 *
 * 说清「对什么做了什么」，不做 snake_case 直译。「谁」由审计行的**操作者**那一列
 * 单独回答（`actor`），标签里不重复。所以是「删除一场会议的本地副本」，
 * 不是「purge local」。
 *
 * ## 认不出的动作：说出来，不要回退成原值
 *
 * 库里出现一个没登记的动作时 `auditActionLabel` 回 `null`，读侧另外把这一页里
 * 所有没登记的动作**点名列出来**（`unlabeledActions`）。回退成 snake_case 原值
 * 看着更"完整"，代价是前端再也分不出「这个动作就叫这个名字」与「这个动作没人
 * 登记过」——于是漏登记永远不会被发现，正是这张表变成 3 行的原因。
 */

/**
 * 动作原值 → 界面上的「动作」。**加新动作时在这里补一行**，
 * 不补的话写侧（`AUDIT_ACTION`）编译不过。
 */
export const AUDIT_ACTION_LABELS = {
  // ── 网关侧：程序 / 人从网关取数据 ──────────────────────────────────
  /** `src/audit/recorder.ts`。这是数据真的出境的那一刻 */
  issue_download_url: '签发下载链接',
  login: '登录网关',
  list_meetings: '列出可访问的会议',

  // ── 控制台 · 管理员账号（阶段 5 · A8）────────────────────────────
  create_admin_account: '新建管理员账号',
  delete_admin_account: '删除管理员账号',
  /** 改的永远是调用者自己的密码，路径上没有 :id */
  change_admin_password: '修改自己的登录密码',
  /** 改的是**别人**（或自己）的角色，路径上有 :id。detail 里写明了改前改后 */
  change_admin_role: '修改管理员账号的角色',

  // ── 控制台 · 采集程序 ─────────────────────────────────────────────
  create_program: '接入新的采集程序',
  enable_program: '启用采集程序',
  disable_program: '停用采集程序',
  rotate_program_secret: '轮换采集程序的凭据',
  /** 程序级自动授权的开关与资产范围（方案 2）。detail 第一行写明开/关与范围 */
  set_program_auto_grant: '设置采集程序的自动授权',

  // ── 控制台 · 逐会议授权与人工改写 ────────────────────────────────
  grant_meeting: '把一场会议授权给采集程序',
  revoke_grant: '撤销一场会议的采集授权',
  put_override: '对一场会议写人工改写',
  revoke_override: '撤销一场会议的人工改写',
  /**
   * 自动授权轮**代人做的**那一次授权（方案 2）：`actor_type = 'system'`、
   * `actor_id = 'auto_grant'`，每授权一场记一条。
   *
   * 与 `grant_meeting` 分成两个动作而不是共用一个：那一列是审计页的筛选条件，
   * 合并之后「这场会议是谁授权的」就只能靠 actor 那一列去猜，而「人点的」与
   * 「系统按规则代点的」正是事后复盘最要分清的两件事。
   */
  auto_grant_meeting: '系统按规则自动把一场会议授权给采集程序',

  // ── 控制台 · 自动规则 ─────────────────────────────────────────────
  rule_create: '新建自动规则',
  rule_update: '修改自动规则',
  /** 只改 enabled 的那一条路（出事时「关掉这条规则」必须永远能成功） */
  rule_toggle: '启用或停用自动规则',
  rule_delete: '删除自动规则',

  // ── 控制台 · 归档存储与保留窗口 ──────────────────────────────────
  set_retention_days: '修改本地保留天数',
  set_cleanup_paused: '暂停或恢复到期清理',
  cleanup_now: '立即执行一次到期清理',
  /** 逐场一条：删本地文件不可逆，会议详情的操作历史要查得到是谁删的 */
  purge_local: '删除一场会议的本地副本',
  /** 校验没过，本轮拒绝删除，需要人工介入（记成 deny） */
  purge_blocked: '拒删一场会议的本地副本（校验没过）',
  purge_failed: '删除一场会议的本地副本时出错',
  extend_retention: '延长一场会议的本地保留窗口',

  // ── 控制台 · 定时任务 ─────────────────────────────────────────────
  run_job: '手动触发定时任务',
  /** 把一条失败项对应会议的 failed/dead 资产打回下载队列（attempts 清零） */
  job_failure_retry: '重试一条失败项',
  /** 把一条失败项对应会议的 dead 资产判成不用管了（skipped/ignored_by_admin） */
  job_failure_ignore: '忽略一条失败项',

  // ── 控制台 · 内容查看（两条都留痕，spec §2）──────────────────────
  view_content: '查看会议内容',
  /** 采集规则不准许，这次是管理员豁免看的——spec §4.10 明文点名的那一行 */
  view_restricted_content: '查看被规则禁止采集的会议内容',
} as const

/** 登记过的动作名。写侧只能用这些——没登记的动作编译不过 */
export type AuditAction = keyof typeof AUDIT_ACTION_LABELS

/**
 * 写侧引用动作名的地方。**不要在 handler 里写字面量**：
 * 「筛选用的字符串」与「写入用的字符串」一旦分成两处，改名的那一次会让筛选
 * 静静地筛出零条，没有任何报错（`ACTION_EXTEND_RETENTION` 的注释里记着这条教训）。
 */
export const AUDIT_ACTION = {
  issueDownloadUrl: 'issue_download_url',
  login: 'login',
  listMeetings: 'list_meetings',

  createAdminAccount: 'create_admin_account',
  deleteAdminAccount: 'delete_admin_account',
  changeAdminPassword: 'change_admin_password',
  changeAdminRole: 'change_admin_role',

  createProgram: 'create_program',
  enableProgram: 'enable_program',
  disableProgram: 'disable_program',
  rotateProgramSecret: 'rotate_program_secret',
  setProgramAutoGrant: 'set_program_auto_grant',

  grantMeeting: 'grant_meeting',
  revokeGrant: 'revoke_grant',
  putOverride: 'put_override',
  revokeOverride: 'revoke_override',
  autoGrantMeeting: 'auto_grant_meeting',

  ruleCreate: 'rule_create',
  ruleUpdate: 'rule_update',
  ruleToggle: 'rule_toggle',
  ruleDelete: 'rule_delete',

  setRetentionDays: 'set_retention_days',
  setCleanupPaused: 'set_cleanup_paused',
  cleanupNow: 'cleanup_now',
  purgeLocal: 'purge_local',
  purgeBlocked: 'purge_blocked',
  purgeFailed: 'purge_failed',
  extendRetention: 'extend_retention',

  runJob: 'run_job',
  jobFailureRetry: 'job_failure_retry',
  jobFailureIgnore: 'job_failure_ignore',

  viewContent: 'view_content',
  viewRestrictedContent: 'view_restricted_content',
} as const satisfies Record<string, AuditAction>

/**
 * 「延长保留窗口」这个动作在 `audit_log.action` 里的取值（阶段 4 · T17）。
 *
 * 它有两个消费方，而它们分属读写两侧：写在
 * `src/http/handlers/console/storage.ts` 的延长端点，数在
 * `src/store/console-meetings.ts` 的 `keep.extended`。各写一个字符串字面量的话，
 * 哪天有人把动作名改成 `retention_extend`，写侧照常记账、读侧照常返回 0——
 * 界面上会显示「从没延长过」，没有任何东西会报错。
 *
 * **值原本定义在 `src/store/audit.ts`**，阶段 5 · A9 挪到登记表旁边，
 * 那边保留一条 re-export 以免改动既有 import。
 */
export const ACTION_EXTEND_RETENTION = AUDIT_ACTION.extendRetention

/**
 * 自动授权轮在 `audit_log.actor_id` 里的固定身份（方案 2）。
 *
 * 写侧是 `src/worker/auto-grant.ts`，读侧是 `handlers/console/audit.ts` 的
 * `resolveActorNames`（把它显示成「系统 · 自动授权」）。两处各写一个字符串字面量的话，
 * 哪天改了名字，写侧照常记账、读侧照常回 null——界面上那一列会显示成一串谁都不认识的
 * id，而没有任何东西会报错。与 `ACTION_EXTEND_RETENTION` 是同一个理由。
 *
 * 它长在**这里**而不是 auto-grant.ts，是为了让网关侧的读代码不必 import 一个 worker
 * 模块才拿得到一个字符串常量——与 `JOB_ARCHIVE_NAS` 住在 `store/jobs.ts` 而不是
 * `worker/scheduler.ts` 是同一条边界。
 */
export const AUTO_GRANT_ACTOR_ID = 'auto_grant'

/**
 * 库里的动作名 → 标签。**没登记时回 `null`，不回原值**（见文件头第三节）。
 *
 * 用 `Object.hasOwn` 而不是 `LABELS[action]`：`'toString'` / `'__proto__'`
 * 这类键会从原型链上摸到一个函数，于是一个脏动作名会得到一个看起来像标签的东西。
 */
export function auditActionLabel(action: string): string | null {
  if (!Object.hasOwn(AUDIT_ACTION_LABELS, action)) return null
  return AUDIT_ACTION_LABELS[action as AuditAction]
}

/**
 * 一句给人看的话，跟在「这个动作没有登记标签」后面。
 *
 * 它是**响应的一部分**而不是日志：审计页要能显示「这一页里有 N 种动作后端没有
 * 登记中文名」，否则漏登记只有在有人盯着某一行发呆时才会被发现。
 */
export const UNLABELED_ACTION_HINT =
  '这个动作在后端没有登记中文标签（src/audit/actions.ts 的 AUDIT_ACTION_LABELS 里没有这一行），' +
  '界面上显示的是 audit_log 里的原值。'

export interface UnlabeledAction {
  action: string
  /** 这一批记录里它出现了几次 */
  count: number
  hint: string
}

/**
 * 这一批记录里有哪些动作没有登记标签，各出现几次。
 *
 * 按**首次出现的顺序**返回，不排序：读侧要的是「这一页里的哪几行读不懂」，
 * 顺序与行序一致更好对。全部登记过时返回空数组而不是 null——
 * 前端不必区分「没有」与「没算」。
 */
export function unlabeledActions(actions: readonly string[]): UnlabeledAction[] {
  const counts = new Map<string, number>()
  for (const action of actions) {
    if (auditActionLabel(action) !== null) continue
    counts.set(action, (counts.get(action) ?? 0) + 1)
  }
  return [...counts].map(([action, count]) => ({ action, count, hint: UNLABELED_ACTION_HINT }))
}
