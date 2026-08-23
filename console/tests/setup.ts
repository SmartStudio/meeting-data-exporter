import '@testing-library/jest-dom/vitest'

// 把 AbortController / AbortSignal 换回 Node 原生实现（预加载脚本
// `tests/preload-native-fetch.mjs` 存的那份），覆盖掉 vitest 的 jsdom 环境
// 装上去的版本。Request / fetch 本来就还是 Node 原生（undici）的，两边现在
// 是同一套实现，react-router 导航时 `new Request(url, {signal})` 的
// instanceof 检查才对得上。详细原因见 vite.config.ts 里 execArgv 那段注释。
declare global {
  // eslint-disable-next-line no-var
  var __NODE_NATIVE_ABORT_CONTROLLER__: typeof AbortController | undefined
  // eslint-disable-next-line no-var
  var __NODE_NATIVE_ABORT_SIGNAL__: typeof AbortSignal | undefined
}

if (globalThis.__NODE_NATIVE_ABORT_CONTROLLER__ && globalThis.__NODE_NATIVE_ABORT_SIGNAL__) {
  Object.defineProperty(globalThis, 'AbortController', {
    value: globalThis.__NODE_NATIVE_ABORT_CONTROLLER__,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'AbortSignal', {
    value: globalThis.__NODE_NATIVE_ABORT_SIGNAL__,
    configurable: true,
    writable: true,
  })
}
