import type { ReactElement, ReactNode } from 'react'
import { render as rtlRender, type RenderOptions, type RenderResult } from '@testing-library/react'
import type { AdminIdentity } from '../../src/api/admin'
import { SessionProvider } from '../../src/app/session'

/**
 * 页面用例的 `render`：把被测页面包进一个**管理员**会话里。
 *
 * 为什么需要它：`useRole()` 在没有 `SessionProvider` 时返回 `readonly`
 * （`src/app/session.tsx` 说明了这个默认值为什么必须落在只读一侧）。只挂单页的
 * 用例不经过 `AppShell`，也就没有那个 Provider——不包一层的话，它们跑的是
 * 只读视角，一屏禁用按钮，断言"点了会发请求"的用例会全线红。
 *
 * 用法是**在测试文件里用它顶掉 `@testing-library/react` 的 `render`**：
 *
 * ```ts
 * import { screen, waitFor } from '@testing-library/react'
 * import { render } from '../helpers/session'
 * ```
 *
 * 这样几十处 `render(<XxxPage />)` 一处都不用改，而"这些用例跑的是管理员视角"
 * 这件事在文件头一眼可见。要跑只读视角用 `renderAsRole(ui, 'readonly')`。
 */

export const ADMIN_IDENTITY: AdminIdentity = {
  adminId: 'test-admin',
  username: '测试管理员',
  role: 'admin',
}

export const READONLY_IDENTITY: AdminIdentity = {
  adminId: 'test-readonly',
  username: '测试只读',
  role: 'readonly',
}

function wrapper(identity: AdminIdentity) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <SessionProvider identity={identity}>{children}</SessionProvider>
  }
}

/** RTL 的 `wrapper` 选项，`rerender` 会保留它——所以用它而不是手写一层 JSX。 */
export function renderAsRole(
  ui: ReactElement,
  role: 'admin' | 'readonly',
  options: Omit<RenderOptions, 'wrapper'> = {},
): RenderResult {
  return rtlRender(ui, {
    ...options,
    wrapper: wrapper(role === 'admin' ? ADMIN_IDENTITY : READONLY_IDENTITY),
  })
}

export function render(ui: ReactElement, options: Omit<RenderOptions, 'wrapper'> = {}): RenderResult {
  return renderAsRole(ui, 'admin', options)
}
