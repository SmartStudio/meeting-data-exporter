import { fileURLToPath, URL } from 'node:url'
// defineConfig 从 'vitest/config' 取（而非 'vite'）：它是 vite 的 UserConfig
// 叠加了 `test` 字段类型的超集，否则 tsc 会报 `test` 不是已知属性。
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: 5273 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: true,          // CSS Modules 的类名在测试里要能解析
    // Node 22+ 自带一个实验性全局 localStorage（未给 --localstorage-file 时读写恒为
    // undefined）。它会抢占 jsdom 提供的那份：vitest 填充 globalThis 时只在某个键名
    // 已在 KEYS 白名单里才会覆盖已存在的同名全局，而 localStorage 目前不在这份白名单
    // 里，于是 Node 那个不能用的桩会被原样保留，jsdom 的实现永远替换不进去。
    // 关掉这个实验特性就不会有同名全局，vitest 才能正常把 jsdom 的 localStorage 接上。
    //
    // --import 指向的预加载脚本解决另一个同类问题（同一套白名单机制，方向相反）：
    // vitest 的 jsdom 环境把 AbortController / AbortSignal 换成 jsdom 自己的实现
    // （这两个键在白名单里，会无条件覆盖 Node 原生同名全局），但 Request / fetch
    // 不在白名单里、始终保留 Node 原生（undici）实现。react-router 的数据路由
    // 每次导航都会 `new Request(url, {signal: new AbortController().signal})`——
    // 这时 AbortController 是 jsdom 的，Request 却是 undici 的，undici 内部对
    // signal 做 instanceof 检查认的是它自己那份 Node 原生 AbortSignal，两边对
    // 不上就抛 "Expected signal ... to be an instance of AbortSignal"（Node 24+
    // 通用问题，见 vitest-dev/vitest#8374，vitest 4 之前没有修）。
    // 预加载脚本赶在 jsdom 接管 globalThis 之前，把 Node 原生的 AbortController /
    // AbortSignal 存一份副本；`tests/setup.ts` 里再用它们把这两个全局换回来。
    poolOptions: {
      forks: {
        execArgv: [
          '--no-experimental-webstorage',
          '--import',
          fileURLToPath(new URL('./tests/preload-native-fetch.mjs', import.meta.url)),
        ],
      },
    },
  },
})
