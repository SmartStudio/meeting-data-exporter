import { createContext, useContext, type ReactNode } from 'react'
import type { AdminIdentity, AdminRole } from '@/api/admin'

/**
 * 当前登录的管理员是谁、是什么角色。
 *
 * ## 为什么默认是只读
 *
 * `createContext` 的默认值是 `null`，`useRole()` 在没有 Provider 时返回
 * **`'readonly'`**。这不是"没接上就退化"的将就，而是这一整条链上唯一安全的
 * 落点：少一个 Provider、少一个字段、响应半截，任何一种"没读到角色"的情形
 * 都必须落到"不能改"，因为反过来的代价（把只读账号的界面画成可改）是让人
 * 以为自己改成了、而后端其实拒了。
 *
 * ## 这一层不是权限
 *
 * 真正的权限是 A8 在 18 条写端点上加的 403（`readonly_role`）。这里做的全部
 * 事情是**别让人白点**——禁用按钮、把原因写在旁边。所以：
 *
 * - **禁用而不是隐藏**。隐藏会让只读用户以为这个功能不存在；禁用 + 一句
 *   「只读账号不能改」说的是实情。
 * - **禁用了也不许省掉错误处理**。一个只读账号绕过界面（另一个标签页里
 *   过期的界面、直接发的请求）仍然发得出写请求，那时页面要能把 403 显示成
 *   一句人话——`api/client.ts` 的 `ForbiddenError` 负责那一半。
 */

/** 按钮上挂的那句短的（title / aria-description），一眼说明白为什么点不动。 */
export const READONLY_HINT = '只读账号不能改'

/** 页头横幅上那句长的。说清能做什么、不能做什么、以及去找谁。 */
export const READONLY_WHY =
  '这个账号是只读角色：能看全部内容，但不能改任何状态。改规则、改授权、延长保留、手动触发任务都需要管理员账号——请让管理员把角色改成 admin。'

/** 用户菜单里那一行。spec §11 缺口 1 点名了它：原来写死「数据管理员 · 可改规则与授权」。 */
export const ROLE_LINE: Record<AdminRole, string> = {
  admin: '数据管理员 · 可改规则与授权',
  readonly: '只读账号 · 只能查看，不能改',
}

const SessionContext = createContext<AdminIdentity | null>(null)

export function SessionProvider({
  identity,
  children,
}: {
  identity: AdminIdentity
  children: ReactNode
}) {
  return <SessionContext.Provider value={identity}>{children}</SessionContext.Provider>
}

/**
 * 当前身份。**没有 Provider 时返回 `null` 而不是抛**——用户菜单之外的调用方
 * 关心的只有角色，而角色有安全的默认值；为了一个"这里本该有 Provider"的
 * 结构问题让整页白屏，换来的信息还不如一排禁用按钮多。
 */
export function useSession(): AdminIdentity | null {
  return useContext(SessionContext)
}

export function useRole(): AdminRole {
  return useContext(SessionContext)?.role ?? 'readonly'
}

export function useReadonly(): boolean {
  return useRole() !== 'admin'
}

/**
 * 写入口上的 `title`。可写时返回 `undefined`（不要给一个空串——空的 title
 * 属性在某些读屏上会念成一次空停顿）。
 *
 * 用法固定是这一对：`disabled={ro || pending}` 配 `title={readonlyTitle(ro)}`。
 * 两者要一起出现：只禁用不说原因，用户看到的是一个坏掉的按钮。
 */
export function readonlyTitle(readonly: boolean): string | undefined {
  return readonly ? READONLY_HINT : undefined
}
