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
  // 开发期把 /api 转发给本地网关。控制台的管理员接口（console/src/api/admin.ts）
  // 用相对路径 + httpOnly cookie 认会话，不走 mock 层，所以 dev server 必须能把
  // 这些请求交出去——否则它按自己的路由处理，浏览器里连登录都走不到。
  //
  // 走同源转发而不是让前端直接请求 http://localhost:3000，是因为会话 cookie 是
  // SameSite=Strict：跨源请求浏览器不会带上它，直连的话登录完立刻又变成未登录。
  //
  // 只影响 `vite dev`，不进构建产物：生产部署是反向代理把前端静态文件与网关
  // 挂在同一个源下（docs/deploy.md §1），本来就同源，不需要这层。
  server: {
    port: 5273,
    proxy: {
      // 网关默认 :3000（src/index.ts 读 PORT）。换端口时设 MDE_GATEWAY_ORIGIN，
      // 不用改这个文件。
      '/api': { target: process.env.MDE_GATEWAY_ORIGIN ?? 'http://localhost:3000' },
    },
  },
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
    //
    // 退出条件：升级到 vitest ^4.0.0 之后，删掉本 test.pool 段与
    // tests/preload-native-fetch.mjs，跑一遍 `npm run test -- shell`——
    // 点击导航那几条能过就说明上游修好了，这个补丁可以走。
    // 没有退出条件的 workaround 会无限期滞留，所以写在这里而不是提交信息里。
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
