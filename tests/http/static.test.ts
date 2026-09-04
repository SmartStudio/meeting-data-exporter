/**
 * 控制台静态文件服务（阶段 6 · R6-b，src/http/static.ts）。
 *
 * 上线计划 S2 的四条判据，三条在这里能验：根路径给登录页（index.html）、深链接不
 * 404、拼错的 `/api/...` 不能拿到 HTML。第四条「浏览器真的打开」只能在机器上看。
 *
 * 不走真库：这一层与数据无关，只关心路径怎么落到文件、以及哪些路径**不归它管**。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsoleStatic, isConsolePath } from '../../src/http/static'

let dist: string
let serve: ReturnType<typeof createConsoleStatic>

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'mde-console-dist-'))
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>console</title>')
  await writeFile(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)')
  await writeFile(join(dist, 'favicon.svg'), '<svg/>')
  serve = createConsoleStatic(dist)
})

afterAll(async () => {
  await rm(dist, { recursive: true, force: true })
})

const get = (path: string, method = 'GET') => serve.serve(new Request(`http://gw${path}`, { method }), path)

describe('isConsolePath —— 网关自己的前缀整片划出去', () => {
  test('API / webhook / 认证 / 设备页 / 探活都不是页面', () => {
    for (const p of ['/api', '/api/v1/admin/xxx', '/api/v1/meetings', '/webhook/tencent-meeting', '/auth/wecom/callback', '/device', '/healthz']) {
      expect(isConsolePath(p)).toBe(false)
    }
  })
  test('根路径、页面路由、资产都是', () => {
    for (const p of ['/', '/audit', '/meetings/123', '/assets/index-abc123.js', '/favicon.svg', '/apiary']) {
      expect(isConsolePath(p)).toBe(true)
    }
  })
})

describe('serve', () => {
  test('根路径给 index.html，text/html，不缓存', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('<title>console</title>')
  })

  test('深链接（无扩展名、文件不存在）回退到 index.html，由前端路由接管', async () => {
    for (const p of ['/audit', '/meetings/123', '/jobs/']) {
      const res = await get(p)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<title>console</title>')
    }
  })

  test('带哈希的资产按文件发，长期缓存', async () => {
    const res = await get('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe('console.log(1)')
  })

  test('根目录下的普通文件（favicon）按文件发，但不 immutable', async () => {
    const res = await get('/favicon.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  test('带扩展名却不存在的资源是 404 JSON，不是一份 HTML 冒充 JS', async () => {
    const res = await get('/assets/index-old000.js')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  test('HEAD 给头不给正文', async () => {
    const res = await get('/assets/index-abc123.js', 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String('console.log(1)'.length))
    expect(await res.text()).toBe('')
  })

  test('路径穿越出不了 dist：一律 404，不区分「不存在」与「不许看」', async () => {
    for (const p of ['/../.env', '/assets/../../.env', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await get(p)
      expect(res.status).toBe(404)
    }
  })

  test('坏的百分号编码也是 404，不抛到 500', async () => {
    const res = await get('/%E0%A4%A')
    expect(res.status).toBe(404)
  })

  test('dist 里没有 index.html 时页面路径 404（构建产物残缺，不静默发空页）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mde-console-empty-'))
    try {
      const res = await createConsoleStatic(empty).serve(new Request('http://gw/'), '/')
      expect(res.status).toBe(404)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
