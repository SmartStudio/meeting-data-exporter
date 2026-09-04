/**
 * 控制台前端的静态文件服务（阶段 6 · 上线计划 R6-b，选的是「网关 serve」）。
 *
 * 为什么由网关来发而不是反向代理：控制台的会话 cookie 是 `SameSite=Strict`，
 * 前端与 `/api` 必须同源；生产机上现成的反向代理属于另一个项目，为了一个静态目录
 * 去改它的配置，等于把本系统的可用性押在别人的部署上。网关自己多一条兜底路由，
 * 一个进程管完。
 *
 * 顺序约束（上线计划 S2 的判据 3）：**这条路由只在全部 API 路由都不匹配之后才轮到**，
 * 且 `isConsolePath` 把 `/api/`、`/webhook/`、`/auth/`、`/device`、`/healthz` 整片
 * 划出去——否则一个拼错的 `/api/v1/admin/xxx` 会拿到 `index.html` 而不是 404 JSON，
 * 前端的 validate.ts 会报出一个指向错方向的解析错误。
 *
 * SPA 回退只给「像页面的路径」：没有扩展名的路径（`/audit`、`/meetings/123`）回
 * `index.html`，由前端路由接管；带扩展名却不存在的（`/assets/old-hash.js`）回 404，
 * 把一份 HTML 当 JS 发给浏览器只会得到一个更难懂的语法错误。
 *
 * 路径穿越：`resolve` 之后必须仍在 dist 目录之内，否则一律 404——不区分「不存在」
 * 与「不许看」，两者对外表现相同即可，不给探测者多一个比特。
 */
import { extname, resolve, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import { json } from './respond'

/** 网关自己的路由前缀。这些路径下不匹配的请求是 404，不是页面 */
const RESERVED_PREFIXES = ['/api/', '/webhook/', '/auth/']
const RESERVED_EXACT = new Set(['/api', '/webhook', '/auth', '/device', '/healthz'])

export function isConsolePath(pathname: string): boolean {
  if (RESERVED_EXACT.has(pathname)) return false
  return !RESERVED_PREFIXES.some((p) => pathname.startsWith(p))
}

export interface ConsoleStatic {
  /** 只处理 GET / HEAD；调用方已经保证 `isConsolePath(pathname)` 为真 */
  serve(req: Request, pathname: string): Promise<Response>
}

/** 构建产物里带内容哈希的资产（vite 默认落在 assets/），可以长期缓存 */
const IMMUTABLE_PREFIX = '/assets/'

export function createConsoleStatic(distDir: string): ConsoleStatic {
  const root = resolve(distDir)
  const indexHtml = resolve(root, 'index.html')

  async function fileResponse(req: Request, abs: string, cacheControl: string): Promise<Response> {
    const file = Bun.file(abs)
    const headers: Record<string, string> = {
      'content-type': file.type || 'application/octet-stream',
      'content-length': String(file.size),
      'cache-control': cacheControl,
    }
    // HEAD 不发正文，但长度与类型照给——浏览器与探活脚本靠它们判断
    return new Response(req.method === 'HEAD' ? null : file, { status: 200, headers })
  }

  return {
    async serve(req, pathname) {
      let decoded: string
      try {
        decoded = decodeURIComponent(pathname)
      } catch {
        return json(404, { error: 'not_found' })
      }
      const abs = resolve(root, `.${decoded}`)
      if (abs !== root && !abs.startsWith(root + sep)) return json(404, { error: 'not_found' })

      const st = await stat(abs).catch(() => null)
      if (st?.isFile()) {
        const cache = decoded.startsWith(IMMUTABLE_PREFIX)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
        return fileResponse(req, abs, cache)
      }
      // 带扩展名的资源不存在就是不存在
      if (extname(decoded) !== '') return json(404, { error: 'not_found' })

      const idx = await stat(indexHtml).catch(() => null)
      if (!idx?.isFile()) return json(404, { error: 'not_found' })
      return fileResponse(req, indexHtml, 'no-cache')
    },
  }
}
