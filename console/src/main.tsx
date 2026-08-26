import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { isProtoMode } from './app/proto'
import './styles/tokens.css'
import './styles/base.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root 节点不存在，无法挂载应用')
}

/**
 * **整个 `src/` 里唯一一处碰得到 `api/mock/` 的地方**，而且它被 `?proto=1`
 * 守着（`tests/mock-gate.test.ts` 用相等断言盯着这两件事）。
 *
 * 用动态 `import()` 而不是顶部静态 import：默认路径下这个模块连**下载**都不会
 * 发生（Vite 会把它切成单独的 chunk）。原型数据不该出现在运维人员打开的那个包里。
 *
 * `await` 在挂载之前：装载晚一步的话，`AppShell` 首帧那几条真实请求已经发出去了,
 * 拦截器接不到，界面会先闪一下"读不到"再变成原型数据。
 */
async function boot(): Promise<void> {
  if (isProtoMode()) {
    const { installProtoApi } = await import('./api/mock/install')
    installProtoApi()
  }
  createRoot(container!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
