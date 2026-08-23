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
    poolOptions: {
      forks: { execArgv: ['--no-experimental-webstorage'] },
    },
  },
})
