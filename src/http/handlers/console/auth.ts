import { randomUUID } from 'node:crypto'
import type { RouteCtx } from '../../router'
import { json, readJson } from '../../respond'
import { requireAdminAuth, requireAdminWrite, readCookie, ADMIN_SESSION_COOKIE } from '../../middleware'
import { AdminAuthError, ADMIN_PASSWORD_MIN_LENGTH, isAdminPasswordAcceptable } from '../../../auth/admin'
import type { AdminIdentity } from '../../../auth/admin'
import { buildAuditDetail } from '../../../store/audit'

/**
 * 账号这一族动作在 `audit_log.action` 里的取值（阶段 5 · A8）。
 *
 * 常量而不是字面量：审计页要按动作筛选，而「筛选用的字符串」与「写入用的
 * 字符串」一旦分成两处，改名的那一次会让筛选静静地筛出零条——没有任何报错。
 * 与 `ACTION_EXTEND_RETENTION` 同一个理由。
 */
export const ACTION_CREATE_ACCOUNT = 'create_admin_account'
export const ACTION_DELETE_ACCOUNT = 'delete_admin_account'
export const ACTION_CHANGE_PASSWORD = 'change_admin_password'

/**
 * 账号一族写操作的审计。`actor_type = 'admin'`，`client_kind = 'console'`，
 * 形状跟随 `handlers/console/grants.ts` 的 `recordAdminWrite`（同一族动作只该有
 * 一种记法，否则审计页要按两种形状分别解释同一件事）。
 *
 * **`detail` 里绝不许出现密码或它的任何片段**——审计日志的读者比密码的读者多得多，
 * 而一条「把新密码记进了审计」的记录是撤不回来的：它会被备份、被导出、被复制进
 * 工单。改密码这条记录该说的是「谁在什么时候改了自己的密码、顺手踢掉了几个会话」，
 * 不是改成了什么。
 */
async function recordAccountWrite(
  ctx: RouteCtx,
  identity: AdminIdentity,
  w: { action: string; target: string; detail: string },
): Promise<void> {
  await ctx.deps.auditStore.record({
    occurredAt: ctx.deps.now(),
    actorType: 'admin',
    // adminId 而不是 username：用户名可以改，审计要指得住同一个人
    actorId: identity.adminId,
    action: w.action,
    // 账号维度的动作没有会议
    meetingId: null,
    assetId: w.target,
    assetType: null,
    // 这一列 NOT NULL，取 allow 表示「这次操作被执行了」——被校验挡回去的
    // 请求压根走不到这里，不会留记录
    decision: 'allow',
    matchedRuleId: null,
    clientKind: 'console',
    detail: buildAuditDetail({ text: w.detail }),
  })
}

interface LoginBody { username?: string; password?: string; remember?: boolean }

/** Secure 在本地开发（非 https）下会导致浏览器直接丢弃 cookie；生产环境必须为 true。
 *  跟随 gatewayBaseUrl 是否为 https 判断，而不是写死——避免"本地登录页收到 cookie
 *  但浏览器悄悄不存"这种排查成本极高的静默失败。 */
function cookieAttrs(secure: boolean, maxAgeSec: number): string {
  const parts = [`Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=${maxAgeSec}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export async function login(req: Request, ctx: RouteCtx): Promise<Response> {
  const body = await readJson<LoginBody>(req)
  if (!body?.username || !body.password) {
    return json(400, { error: 'missing_credentials' })
  }
  try {
    const account = await ctx.deps.adminAuth.authenticate(body.username, body.password)
    const { token, expiresAt } = await ctx.deps.adminAuth.issueSession(account.id, body.remember === true, ctx.deps.now())
    const maxAge = expiresAt - ctx.deps.now()
    const res = json(200, { adminId: account.id, username: account.username })
    res.headers.append('set-cookie', `${ADMIN_SESSION_COOKIE}=${token}; ${cookieAttrs(ctx.deps.cookieSecure, maxAge)}`)
    return res
  } catch (err) {
    // 统一"账号或密码错误"，不区分——spec.md §4.1：表单级报错，故意不说哪个字段错
    if (err instanceof AdminAuthError) return json(401, { error: 'invalid_credentials' })
    throw err
  }
}

export async function logout(req: Request, ctx: RouteCtx): Promise<Response> {
  // 读 cookie 走 middleware 的 readCookie + ADMIN_SESSION_COOKIE 常量，不自己写正则：
  // 之前那份手写正则把 cookie 名写成了字面量，改名之后它会静静地匹配不上——响应里
  // 清除 cookie 的那一句照常发出（客户端看起来登出了），服务端会话却永远不被撤销。
  const token = readCookie(req, ADMIN_SESSION_COOKIE)
  // 空值（`mde_admin_session=;`）不值得往下走一次撤销——与改用 readCookie 之前的
  // `if (match?.[1])` 行为一致
  if (token) await ctx.deps.adminAuth.revokeSession(token)
  const res = json(204, null)
  res.headers.append('set-cookie', `${ADMIN_SESSION_COOKIE}=; ${cookieAttrs(ctx.deps.cookieSecure, 0)}`)
  return res
}

export async function me(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  return json(200, auth.identity)
}

export async function listAccounts(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const accounts = await ctx.deps.adminStore.listAccounts()
  // passwordHash 绝不出现在响应里。role 下发（阶段 5 · A8）：spec §4.11 的账号表
  // 要显示每个人是什么角色，前端从这里取，不自己猜
  return json(
    200,
    accounts.map((a) => ({ id: a.id, username: a.username, createdAt: a.createdAt, role: a.role })),
  )
}

interface CreateAccountBody { username?: string; password?: string; role?: unknown }

export async function createAccount(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const body = await readJson<CreateAccountBody>(req)
  if (!body?.username || !body.password) return json(400, { error: 'missing_fields' })
  // 角色（阶段 5 · A8）。**认不出来的取值报 400，不悄悄折成某一个角色**：
  // 前端把 'read-only' 写成 'readonly' 之外的任何拼法，都该当场看见，
  // 而不是建出一个角色与界面上勾选的不一样的账号。
  //
  // 省略 = 'admin'：这条端点在 009 之前建出来的就是数据管理员，
  // 而 spec §4.11 那个按钮写的是「添加运维人员」。要建只读账号得显式说，
  // 反过来（默认只读）会让还没更新的前端建出一批什么都干不了的账号。
  const role = body.role === undefined ? 'admin' : body.role
  if (role !== 'admin' && role !== 'readonly') {
    return json(400, { error: 'invalid_role', allowed: ['admin', 'readonly'] })
  }
  // 密码门槛与 scripts/admin-bootstrap.ts 共用同一个判定（src/auth/admin.ts），
  // 不在这里另写一个 `.length < 8`：同一套凭证系统不能因为建号入口不同而有两条标准。
  // minLength 一并回给前端，好让"添加运维人员"的表单能直接说清差多少，
  // 不用把 8 这个数字在前端再抄一遍。
  if (!isAdminPasswordAcceptable(body.password)) {
    return json(400, { error: 'password_too_short', minLength: ADMIN_PASSWORD_MIN_LENGTH })
  }
  const existing = await ctx.deps.adminStore.findByUsername(body.username)
  if (existing !== null) return json(409, { error: 'username_taken' })
  const id = randomUUID()
  const passwordHash = await ctx.deps.adminAuth.hashPassword(body.password)
  await ctx.deps.adminStore.createAccount({
    id, username: body.username, passwordHash, now: ctx.deps.now(), role,
  })
  await recordAccountWrite(ctx, auth.identity, {
    action: ACTION_CREATE_ACCOUNT,
    target: id,
    detail: `新建控制台账号 ${body.username}（角色 ${role}）`,
  })
  return json(201, { id, username: body.username, role })
}

export async function deleteAccount(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const targetId = ctx.params.id!
  // 系统内至少保留一个账号（US-3.5 验收标准）：删前查计数，等于 1 就拒绝，
  // 不给"最后一个也删了、谁都进不去控制台"的机会。
  const count = await ctx.deps.adminStore.countAccounts()
  if (count <= 1) return json(409, { error: 'cannot_delete_last_account' })
  const deleted = await ctx.deps.adminStore.deleteAccount(targetId)
  if (!deleted) return json(404, { error: 'account_not_found' })
  // 移除账号后其会话立即失效（US-3.5 验收标准）——不等自然过期
  await ctx.deps.adminAuth.revokeAllSessionsFor(targetId)
  // 先做事、再记账：审计是对已发生事实的记录，先记后做一旦中间失败，
  // 审计里就留下了一件没发生过的事（同 storage.ts 的三条规矩之三）
  await recordAccountWrite(ctx, auth.identity, {
    action: ACTION_DELETE_ACCOUNT,
    target: targetId,
    detail: `移除控制台账号 ${targetId}，其全部会话已一并吊销`,
  })
  return json(204, null)
}

// ────────────────────────────────────────────────────────────────
// POST /api/v1/admin/auth/password —— 修改自己的密码（spec §11 缺口 5）
// ────────────────────────────────────────────────────────────────

interface ChangePasswordBody { currentPassword?: unknown; newPassword?: unknown }

/**
 * 改自己的密码。**改的永远是当前会话对应的那个账号**，请求体里没有 `adminId`
 * 这种字段——有的话就等于给了一条「管理员改别人密码」的路，而那需要另一套
 * 权限判定与另一条审计动作，不该藏在这一条端点里。
 *
 * ## 三件不能省的事
 *
 * 1. **必须校验 `currentPassword`。** 只凭会话 cookie 就能改密码，等于一次 XSS
 *    就能永久接管账号：偷到 cookie 的人把密码换掉，真正的主人再也登不进来，
 *    而 cookie 本身可能几小时后就过期了——攻击者需要的正是这一步把临时的
 *    访问变成永久的。校验走 `adminAuth.authenticate`（与登录同一条路径，
 *    等时哈希校验也在里面），不在这里另写一次 `Bun.password.verify`。
 * 2. **改完吊销该账号在别处的会话。** 旧密码换来的会话不该在密码换掉之后还活着
 *    ——「我怀疑密码泄露了所以改密码」这件事必须真的把别人踢下去。当前这一条
 *    留着，否则用户改完密码立刻 401（见 AdminStore.deleteSessionsByAdminIdExcept）。
 * 3. **强度门槛与建号那条路径共用同一份校验**（`isAdminPasswordAcceptable`）。
 *    同一套凭证系统只能有一个门槛，`90036a2` 已经把两条路径统一过一次了。
 *
 * ## 只读角色也能改自己的密码
 *
 * 这一条**不走 `requireAdminWrite`**，是本轮唯一一条经过深思的例外（另两条是
 * logout 与 login）。理由：它写的是调用者自己的凭据，不是任何系统状态，
 * 也不改角色——挡住它并不能防住任何越权，只会让一个怀疑自己密码泄露的只读
 * 操作员无法自救，而那是一个比「只读账号改了自己的密码」严重得多的问题。
 */
export async function changePassword(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const body = await readJson<ChangePasswordBody>(req)
  const { currentPassword, newPassword } = body ?? {}
  if (typeof currentPassword !== 'string' || currentPassword.length === 0 ||
      typeof newPassword !== 'string' || newPassword.length === 0) {
    return json(400, { error: 'missing_fields' })
  }
  if (!isAdminPasswordAcceptable(newPassword)) {
    return json(400, { error: 'password_too_short', minLength: ADMIN_PASSWORD_MIN_LENGTH })
  }
  // 新旧相同不是一次改密码。放过去的话，用户会看到「改成功了，另外 3 台设备
  // 已退出」——密码没变，别处的会话却真的被踢了，两件事都与他以为的不一样
  if (newPassword === currentPassword) {
    return json(400, { error: 'password_unchanged' })
  }

  try {
    await ctx.deps.adminAuth.authenticate(auth.identity.username, currentPassword)
  } catch (err) {
    // 与登录端点同一句话：不说是"当前密码错"还是"账号没了"。
    // 401 而不是 403：这是一次凭据校验失败，不是权限不够
    if (err instanceof AdminAuthError) return json(401, { error: 'invalid_current_password' })
    throw err
  }

  const passwordHash = await ctx.deps.adminAuth.hashPassword(newPassword)
  const updated = await ctx.deps.adminStore.updatePassword(auth.identity.adminId, passwordHash)
  // 账号在这两步之间被别人删掉了。**不能返回 200**——那会让用户以为密码改好了，
  // 而其实什么都没写进去
  if (!updated) return json(404, { error: 'account_not_found' })

  // 当前这条 cookie 一定还在（requireAdminAuth 刚用它校验过）
  const currentToken = readCookie(req, ADMIN_SESSION_COOKIE) ?? ''
  const revoked = await ctx.deps.adminAuth.revokeOtherSessionsFor(auth.identity.adminId, currentToken)

  await recordAccountWrite(ctx, auth.identity, {
    action: ACTION_CHANGE_PASSWORD,
    target: auth.identity.adminId,
    // 密码本身与它的任何片段（长度也不写：那是一条真实的暴力破解线索）都不进这里
    detail: `修改了自己的控制台密码，同时吊销了该账号在别处的 ${revoked} 个会话`,
  })

  // 200 而不是 204：前端要把"另外 N 台设备已退出"这句话说出来，
  // 那是这次操作的一个后果，不说清楚会让人以为改密码只影响下次登录
  return json(200, { revokedOtherSessions: revoked })
}
