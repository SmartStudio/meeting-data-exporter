#!/usr/bin/env bun
/**
 * 无障碍与令牌回归检查 —— 可重复跑的门槛（F1 Task 7）。
 *
 * 原型阶段那三项验证（对比度全页扫描、Tab 泄漏计数、三个宽度无横向溢出）
 * 是一次性脚本。工程化之后必须变成能重复跑的门槛，否则下一次改样式就会
 * 悄悄退回去。任一项失败即非零退出，可直接进 CI。
 *
 * ── 为什么跑在 `vite build` 的产物上，不是 dev server ────────────────
 * 因为要验的东西里有一条是**打包注入顺序**：`Overlay.module.css` 的
 * `.root{outline:none}` 与 `base.css` 的 `:focus-visible` 同优先级，谁赢
 * 完全取决于两段 CSS 谁后注入。dev server 与生产构建的注入顺序不保证相同，
 * 跑 dev server 等于没验到要验的那件事。本脚本自己跑一次生产构建。
 *
 * 唯一与 `npm run build` 的差别：CSS Module 的类名生成器改成
 * `[name]__[local]`（默认是哈希）。它不改变规则顺序、不改变优先级——两者都是
 * 单个类选择器——只是让报告能说出「MeetingRow__extendBtn」而不是「_1f3x9」。
 * brief Step 5：只报「有 3 处失败」的脚本没人会去修。
 *
 * ── 五项检查 ──────────────────────────────────────────────────────
 *   1 对比度      两种主题 × 多个页面形态全页扫描；含语义色令牌的色相/配对
 *                 断言，以及「--ink-4 不许用于文字」。每个形态都要先过
 *                 `assertLive`：该有的东西没渲染出来、或者渲染的是错误态，
 *                 那一次扫描不算数——扫一屏「读取失败」也能扫出几十个元素。
 *   2 Tab 泄漏    真键盘 Tab 走一遍；含关闭态浮层在 Chromium 无障碍树里的缺席、
 *                 以及每一站的焦点环可见性（含浮层基座退化聚焦那条路径）
 *   3 横向溢出    1440 / 1050 / 375；不只量 scrollWidth——被 overflow-x: clip
 *                 切掉的元素量不出来，必须同时验「元素在视口内可达」；
 *                 含进度条/骨架条的实际渲染几何
 *   4 裸值扫描    module.css 里的裸 px / hex / rgb / 半像素字号（纯文本）；
 *                 含构建产物里的裸 outline 复位、@keyframes 里的布局属性、
 *                 深色两处定义的逐字一致
 *   5 媒体查询    prefers-reduced-motion 与三态主题在真实浏览器下真的生效
 *
 * 用法：
 *   npm run a11y                 完整跑（含构建）
 *   npm run a11y -- --skip-build 复用上次的 a11y 构建产物（改样式后不要用）
 *   npm run a11y -- --only=1,3   只跑其中几项
 */

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { argv, exit } from 'node:process'
import path from 'node:path'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SRC = path.join(ROOT, 'src')
const OUT_DIR = path.join(ROOT, 'node_modules', '.a11y-dist')
const TOKENS_CSS = path.join(SRC, 'styles', 'tokens.css')
const PAGE_JS = path.join(ROOT, 'scripts', 'a11y-page.js')

const args = argv.slice(2)
const SKIP_BUILD = args.includes('--skip-build')
const ONLY = (() => {
  const a = args.find((x) => x.startsWith('--only='))
  return a ? new Set(a.slice('--only='.length).split(',').map((s) => s.trim())) : null
})()
function enabled(id: string): boolean {
  return ONLY === null || ONLY.has(id)
}

/* ── 报告收集 ─────────────────────────────────────────────────────── */

interface Finding {
  check: string
  where: string
  lines: string[]
}
const failures: Finding[] = []
const notes: Finding[] = []
let checkedCounters: Record<string, number> = {}

function fail(check: string, where: string, ...lines: string[]): void {
  failures.push({ check, where, lines })
}
function note(check: string, where: string, ...lines: string[]): void {
  notes.push({ check, where, lines })
}
function bump(k: string, n = 1): void {
  checkedCounters[k] = (checkedCounters[k] ?? 0) + n
}

/* ── 令牌文件解析（纯文本，不需要浏览器） ─────────────────────────── */

interface TokenFile {
  names: string[]
  light: Map<string, string>
  darkMedia: Map<string, string>
  darkAttr: Map<string, string>
}

/** 把注释抹成同等长度的空白，而不是删掉。
 *  注释里满是「原型写死 1020px」「--tap-min（44px 触控下限）」这类说明文字，
 *  不剥掉就全是假阳性；但直接删掉会让行号错位——多行注释一删，后面每一行的
 *  行号都往前挪，报出来的位置指向别处，比不报还糟。 */
function stripCssComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** 取出 `sel {` 之后配对到的那一层花括号内容。嵌套（@media）也能正确配平。 */
function blockAfter(src: string, from: number): { body: string; end: number } | null {
  const open = src.indexOf('{', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { body: src.slice(open + 1, i), end: i }
    }
  }
  return null
}

function declMap(body: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const name = decl.slice(0, i).trim()
    if (!name.startsWith('--')) continue
    m.set(name, decl.slice(i + 1).trim())
  }
  return m
}

async function readTokens(): Promise<TokenFile> {
  const raw = stripCssComments(await readFile(TOKENS_CSS, 'utf8'))
  const lightAt = raw.search(/(^|\})\s*:root\s*\{/)
  const light = (() => {
    const b = blockAfter(raw, lightAt < 0 ? 0 : lightAt)
    return b ? declMap(b.body) : new Map<string, string>()
  })()
  const mediaAt = raw.indexOf('@media (prefers-color-scheme: dark)')
  const darkMedia = (() => {
    if (mediaAt < 0) return new Map<string, string>()
    const outer = blockAfter(raw, mediaAt)
    if (!outer) return new Map<string, string>()
    const inner = blockAfter(outer.body, 0)
    return inner ? declMap(inner.body) : new Map<string, string>()
  })()
  const attrAt = raw.indexOf(':root[data-theme="dark"]')
  const darkAttr = (() => {
    if (attrAt < 0) return new Map<string, string>()
    const b = blockAfter(raw, attrAt)
    return b ? declMap(b.body) : new Map<string, string>()
  })()
  const names = [...new Set([...light.keys(), ...darkMedia.keys(), ...darkAttr.keys()])]
  return { names, light, darkMedia, darkAttr }
}

/* ══════════════════════════════════════════════════════════════════
   检查 4：裸值扫描（纯文本，不需要浏览器）
   ══════════════════════════════════════════════════════════════════ */

async function walkCss(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walkCss(p, out)
    else if (e.name.endsWith('.module.css')) out.push(p)
  }
  return out
}

const LAYOUT_ANIM_PROPS = [
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'top', 'right', 'bottom', 'left', 'inset',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'font-size', 'line-height', 'letter-spacing', 'gap', 'row-gap', 'column-gap',
  'flex', 'flex-basis', 'border-width', 'background-position', 'grid-template-columns',
]

async function checkNakedValues(tf: TokenFile): Promise<void> {
  const files = (await walkCss(SRC)).sort()
  bump('module.css 文件', files.length)

  for (const file of files) {
    const rel = path.relative(ROOT, file)
    const raw = await readFile(file, 'utf8')
    /* 注释里满是「原型写死 1020px」「--tap-min（44px 触控下限）」这类说明文字。
       不先剥注释，扫出来的全是假阳性。 */
    const lines = raw.split('\n')
    const stripped = stripCssComments(raw).split('\n')

    stripped.forEach((line, i) => {
      const n = i + 1
      const src = (lines[i] ?? '').trim()

      /* 裸 px：`1px` 边框除外（brief 明确豁免）。var(--x) 里的不算，
         calc() 里的裸数字也算裸值。 */
      for (const m of line.matchAll(/(?<![-\w.])(\d*\.?\d+)px\b/g)) {
        const v = m[1] ?? ''
        if (v === '1' || v === '0') continue
        fail('4 裸值', `${rel}:${n}`, `裸像素 ${v}px —— ${src}`, '  尺寸一律走 tokens.css 的具名令牌')
      }
      /* 半像素字号：中文字形是实心方块，没有拉丁字母的负空间吃掉那半个像素 */
      for (const m of line.matchAll(/font-size\s*:\s*[^;]*?(\d+\.\d+)(px|rem|em)/g)) {
        fail('4 裸值', `${rel}:${n}`, `半像素字号 ${m[1]}${m[2]} —— ${src}`)
      }
      for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        fail('4 裸值', `${rel}:${n}`, `裸 hex ${m[0]} —— ${src}`, '  颜色只在 tokens.css 里定义')
      }
      for (const m of line.matchAll(/\brgba?\s*\(/g)) {
        void m
        fail('4 裸值', `${rel}:${n}`, `裸 rgb()/rgba() —— ${src}`, '  颜色只在 tokens.css 里定义')
      }
      /* 颜色不许写进 @media / [data-theme] 块（design-system.md §1 第 3 条）：
         那样的颜色在「跟随系统」状态下不生效，而那是默认状态。 */
      if (/^\s*@media[^{]*prefers-color-scheme/.test(line) || /\[data-theme[^\]]*\]/.test(line)) {
        note('4 裸值', `${rel}:${n}`, `组件里出现主题条件块 —— ${src}`, '  颜色只该在 tokens.css 里定义；这里若只切非颜色属性则无妨')
      }
    })

    /* @keyframes 里出现布局属性 = 每帧 reflow（design-system.md §6） */
    const noComment = stripCssComments(raw)
    for (const m of noComment.matchAll(/@keyframes\s+([\w-]+)/g)) {
      const b = blockAfter(noComment, (m.index ?? 0) + m[0].length)
      if (!b) continue
      for (const p of LAYOUT_ANIM_PROPS) {
        const re = new RegExp(`(^|[;{\\s])${p}\\s*:`, 'm')
        if (re.test(b.body)) {
          fail('4 裸值', rel, `@keyframes ${m[1]} 动了布局属性 ${p} —— 每帧触发 reflow`)
        }
      }
    }
    /* transition 里出现布局属性，同理 */
    for (const m of noComment.matchAll(/transition(-property)?\s*:\s*([^;}]+)/g)) {
      const decl = (m[2] ?? '').trim()
      for (const p of LAYOUT_ANIM_PROPS) {
        if (new RegExp(`(^|[,\\s])${p}([,\\s]|$)`).test(decl)) {
          fail('4 裸值', rel, `transition 里有布局属性 ${p} —— ${decl}`)
        }
      }
    }
  }

  /* 深色两处定义必须逐字一致：design-system.md §7 要求 @media 块与
     [data-theme="dark"] 块同时存在，两边漂了就是「切换器在某个方向不生效」。 */
  const a = tf.darkMedia
  const b = tf.darkAttr
  if (a.size === 0 || b.size === 0) {
    fail('4 裸值', 'tokens.css', `三态主题缺块：@media 深色块 ${a.size} 条声明，:root[data-theme="dark"] ${b.size} 条`)
  } else {
    for (const [k, v] of a) {
      if (!b.has(k)) fail('4 裸值', 'tokens.css', `@media 深色块有 ${k}，:root[data-theme="dark"] 没有 —— 显式切深色时这个令牌会退回浅色值`)
      else if (b.get(k) !== v) fail('4 裸值', 'tokens.css', `${k} 两处深色定义不一致：@media=${v} / [data-theme="dark"]=${b.get(k)}`)
    }
    for (const k of b.keys()) {
      if (!a.has(k)) fail('4 裸值', 'tokens.css', `:root[data-theme="dark"] 有 ${k}，@media 深色块没有 —— 「跟随系统」下这个令牌不会变深`)
    }
    bump('深色令牌对照', a.size)
  }
  /* 「跟随系统」是移除属性，不是写 data-theme="system" */
  const themeSrc = await readFile(path.join(SRC, 'theme', 'useTheme.ts'), 'utf8')
  if (!/removeAttribute\(\s*['"]data-theme['"]\s*\)/.test(themeSrc)) {
    fail('4 裸值', 'src/theme/useTheme.ts', '「跟随系统」没有走 removeAttribute("data-theme")')
  }
}

/** 构建产物里任何裸的 outline 复位。`.root{outline:none}` 与 base.css 的
 *  `:focus-visible{outline:...}` 同优先级，谁赢取决于注入顺序——不该有人赌这个。 */
async function checkBuiltCss(cssPath: string): Promise<void> {
  const css = await readFile(cssPath, 'utf8')
  for (const m of css.matchAll(/([^{}]+)\{([^}]*outline\s*:\s*(?:none|0)[^}]*)\}/g)) {
    const sel = (m[1] ?? '').trim()
    if (/:focus-visible/.test(sel)) continue // 有意在 :focus-visible 上另给环的写法
    fail('4 裸值', path.relative(ROOT, cssPath),
      `构建产物里有裸的 outline 复位：${sel} { ${(m[2] ?? '').trim()} }`,
      '  它与 base.css 的 :focus-visible 同优先级，谁赢只取决于打包注入顺序')
  }
  const fvAt = css.indexOf(':focus-visible{outline')
  if (fvAt < 0) {
    fail('4 裸值', path.relative(ROOT, cssPath), 'base.css 的 :focus-visible 焦点环规则没进构建产物')
  } else {
    bump('构建产物 CSS 字节', css.length)
  }
}

/* ══════════════════════════════════════════════════════════════════
   构建 + 静态服务
   ══════════════════════════════════════════════════════════════════ */

async function buildApp(): Promise<string> {
  if (!SKIP_BUILD) {
    /* 单独起一个 vite 进程而不是 import('vite').build()：后者会把 vite 的
       模块图拉进 bun 进程，和 vitest/config 的类型层纠缠，得不偿失。 */
    const conf = path.join(ROOT, 'scripts', 'a11y-vite.config.ts')
    const bin = path.join(ROOT, 'node_modules', '.bin', 'vite')
    const r = spawnSync(bin, ['build', '--config', conf, '--logLevel', 'warn'], {
      cwd: ROOT, stdio: 'inherit',
    })
    if (r.status !== 0) {
      console.error('\n✖ vite build 失败——先把构建修好再跑无障碍门槛。')
      exit(2)
    }
  }
  if (!existsSync(path.join(OUT_DIR, 'index.html'))) {
    console.error(`\n✖ 构建产物不存在：${OUT_DIR}。去掉 --skip-build 重跑。`)
    exit(2)
  }
  const assets = await readdir(path.join(OUT_DIR, 'assets'))
  const css = assets.find((f) => f.endsWith('.css'))
  if (!css) {
    console.error('\n✖ 构建产物里没有 CSS 文件。')
    exit(2)
  }
  return path.join(OUT_DIR, 'assets', css)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

/** dist 的静态服务 + SPA 回退。用 node:http 而不是 Bun.serve——
 *  tsconfig 的 types 里没有 bun，用 node: 前缀的模块两边都能跑也能过 tsc。
 *
 *  Task 6 之后 `AppShell` 挂载时会真的 `fetch('/api/v1/admin/auth/me')`。
 *  这台服务器不挂后端，SPA 回退会把这条请求也答成 200 的 `index.html`——
 *  `fetchAdminIdentity()` 看 `res.ok` 为真就去 `res.json()`，解析 HTML 必炸，
 *  `AppShell` 因此落进它的 error 态，下面所有以 `nav[aria-label="主导航"]`
 *  为挂载标志的场景（几乎全部）会统一超时，而不是各自该有的样子。这里单独
 *  兜一下这一条路径，答一个真的会通过的管理员身份，让门槛验的还是页面本身
 *  的无障碍状态，不是这台没有后端的测试服务器答不出登录态这件事。 */
function serveDist(dir: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/v1/admin/auth/me' && (req.method ?? 'GET') === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ adminId: 'a11y-harness', username: 'a11y-harness' }))
      return
    }
    let rel = decodeURIComponent(url.pathname)
    if (rel.endsWith('/')) rel += 'index.html'
    let file = path.join(dir, rel)
    if (!file.startsWith(dir) || !existsSync(file)) file = path.join(dir, 'index.html')
    readFile(file).then(
      (buf) => {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
        res.end(buf)
      },
      () => { res.writeHead(500); res.end('read error') },
    )
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

/* ══════════════════════════════════════════════════════════════════
   浏览器
   ══════════════════════════════════════════════════════════════════ */

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('')
    console.error('✖ 启动不了 Chromium，本门槛的三项检查（对比度 / Tab 泄漏 / 横向溢出）')
    console.error('  必须在真实浏览器里跑，jsdom 顶不上——它不跑布局、不实现 inert 的行为语义。')
    console.error('')
    console.error('  装一次浏览器即可：')
    console.error('')
    console.error('      cd console && npx playwright install chromium')
    console.error('')
    console.error('  （CI 里加在 `npm ci` 之后；只需要 chromium。Linux runner 上用')
    console.error('    `npx playwright install --with-deps chromium` 一并补系统库。）')
    console.error('')
    console.error('  Playwright 原始报错：')
    console.error('  ' + msg.split('\n').slice(0, 4).join('\n  '))
    exit(2)
  }
}

/* ══════════════════════════════════════════════════════════════════
   页面形态
   ══════════════════════════════════════════════════════════════════ */

let BASE = ''
const STATE_SELECT = 'select[aria-label^="系统状态"]'
/** 七条挂在 AppShell 下的路由共同的挂载标志。`/login` 不经过 AppShell
 *  （routes.tsx 明写：它是 `/` 的兄弟节点，没有左栏/顶栏），必须给
 *  自己的 `waitFor`，否则等的是永远不会出现的主导航，15s 后超时。 */
const NAV_SELECTOR = 'nav[aria-label="主导航"]'

interface Scene {
  id: string
  why: string
  route: string
  /** 页面挂载完成的等待目标，供 open() 用。省略时用 NAV_SELECTOR（适用于
   *  AppShell 之下的七条路由）；不经过 AppShell 的页面必须显式给出自己的
   *  挂载标志——语义选择器，不用 CSS Module 哈希类名，避免样式重命名就打断。 */
  waitFor?: string
  setup?: (page: Page) => Promise<void>
  /**
   * **这一屏必须真的渲染出来的东西**，`setup` 跑完之后逐个等。
   *
   * 加这一条是因为 F8 之前六个页面的场景等于没扫：`NAV_SELECTOR`（左栏导航）
   * 在**错误态下照样存在**——那台测试服务器只桩了 `auth/me`，页面拿不到数据，
   * 于是场景稳稳地扫过一屏"读取失败"，然后报「通过」。三个页面任务各自独立
   * 发现了这件事。
   *
   * 所以每个场景都要点名它这一屏该有的形态标志（那条红色横幅、那张失败项表、
   * 那个打开的抽屉）。等不到就是失败，而不是安静地扫别的东西。
   */
  expect?: string[]
  /**
   * 这一屏**就是**错误态。
   *
   * 只有一处：`load-failed`——那是 spec §8 的数据三态之一，它的红框本来就是
   * 要验的东西。除它以外，页面上出现错误标志一律是失败，没有豁免：
   * 一条「这一页反正也读不到，先豁免着」会让那一页从此静音。
   */
  errorOnPurpose?: boolean
}

/**
 * 这几处只要出现在页面上，这一屏就不是页面本身的样子了。
 *
 * 与 `expect` 是两个方向的同一件事：`expect` 说"该有的必须有"，这里说
 * "不该有的一个都不许有"。分开写是因为漏一个 `expect` 只是少验一点，
 * 而扫到错误态是**假通过**——门槛报绿，其实那一页从来没被验过。
 */
const ERROR_MARKERS = [
  // 逐个点名，**不用 `[data-testid$="-error"]` 这种后缀匹配**：归档存储页那条
  // 「NAS 无法连通」的 testid 就叫 `nas-error`，它是一种要验的内容形态，
  // 不是这一页读不出来。一个太宽的选择器会把想验的东西判成失败。
  '[data-testid="meetings-error"]',
  '[data-testid="jobs-error"]',
  '[data-testid="storage-error"]',
  '[data-testid="audit-error"]',
  '[data-testid="admin-auth-error"]', // AppShell 连登录态都读不到
  '[data-alert="unreadable"]', // 顶栏：系统状态读取失败
  '[class*="pageErr"]', // 内容预览页
  '[class*="pageError"]', // 采集授权页
  '[class*="Rules__error"]', // 自动规则页
]

const SCENES: Scene[] = [
  { id: 'ok', why: '正常态', route: '/meetings' },
  { id: 'nas-down', why: 'NAS 断连（保留窗口清零、授权撤下）', route: '/meetings', setup: (p) => setState(p, 'nas-down') },
  { id: 'tencent-down', why: '腾讯会议不可达', route: '/meetings', setup: (p) => setState(p, 'tencent-down') },
  {
    id: 'load-failed',
    why: '会议数据读取失败',
    route: '/meetings',
    setup: (p) => setState(p, 'load-failed'),
    // 这一屏要的就是那个红框（spec §8 的三态之一），见 Scene.errorOnPurpose
    errorOnPurpose: true,
    expect: ['[data-testid="meetings-error"]'],
  },
  { id: 'loading', why: '加载中（骨架屏）', route: '/meetings', setup: (p) => setState(p, 'loading') },
  { id: 'empty', why: '一场会议都没有', route: '/meetings', setup: (p) => setState(p, 'empty') },
  { id: 'row-hover', why: 'hover 才浮出的「＋30 天」/ 详情按钮', route: '/meetings', setup: hoverRow },
  { id: 'selected', why: '选中若干行 → 批量条（反相表面）', route: '/meetings', setup: selectRows },
  { id: 'drawer', why: '详情抽屉打开', route: '/meetings', setup: openDrawer },
  { id: 'popover', why: '时间范围菜单打开', route: '/meetings', setup: openPopover },
  { id: 'grant', why: '授权面板打开', route: '/meetings', setup: openGrant },
  { id: 'toast', why: '延长保留期后的 toast', route: '/meetings', setup: fireToast },
  {
    id: 'login',
    why: '登录页（spec.md §4.1；刻意不经过 AppShell，无左栏/顶栏，见 routes.tsx）',
    route: '/login',
    waitFor: 'input[autocomplete="current-password"]',
  },

  /* ── 另外六个页面（F8） ────────────────────────────────────────
     阶段 5 之前这里只有一个 `page-shell` 场景扫 `/consumers`，注释写着
     「空壳共用的页头骨架」——那时六个页面确实还是空壳。现在它们都接了线，
     每一页至少一个正常态，有明显形态分支的各给一个。

     `?proto=1` 下的假后端（`src/api/mock/install.ts`）是这些场景的地基：
     它答不出来的端点，页面就只能渲染错误态，扫过去等于没扫。所以每一条都带
     `expect`，点名这一屏该有的形态标志。 */

  {
    id: 'rules',
    why: '自动规则三栈（写坏 conds 的 / 停用的 / 带 issues 的各一条）',
    route: '/rules',
    // 按 **data 属性**点名，不按 class 名：CSS Module 的类名在 dev 与构建产物里
    // 命名规则都不一样（`_why_hash` vs `Rules__why_hash`），本来就不是契约。
    // 这几条原来写的是 `Rules__issues` / `Rules__condBad`，改版把它们改名之后
    // 这一屏就"跑过去了但扫的不是这一页"。
    expect: ['li[data-off="true"]', 'li[data-flag="unreadable"]', 'li[data-tone="fail"]'],
  },
  {
    id: 'rules-editor',
    why: '规则编辑器打开 + 影响预览（新放行的数字、琥珀警告）',
    route: '/rules',
    setup: openRuleEditor,
    expect: [
      '[role="dialog"][data-state="open"]',
      '[role="group"][aria-label="影响预览"]',
      '[class*="RuleEditor__amber"]',
    ],
  },
  {
    id: 'rules-matches',
    why: '命中的会议面板（规则行右边那个数字点开）',
    route: '/rules',
    setup: openRuleMatches,
    expect: ['[role="dialog"][data-state="open"]', '[class*="Rules__matchList"]'],
  },
  {
    id: 'jobs',
    why: '定时任务：已经落后的红横幅 + 从没跑过 + 正在跑 + 失败项表',
    route: '/jobs',
    expect: [
      'ul[aria-label="内置定时任务"]',
      '[data-testid="jobs-overdue"]',
      '[data-testid="job-spark"]',
      '[data-testid="failure-row"][data-escalated="true"]',
    ],
  },
  {
    id: 'jobs-stalled',
    why: '拉取任务连续失败（琥珀横幅，从运行记录推出来的判断）',
    // 先在会议记录页把状态拨过去，再走左栏进定时任务页，见 viaState()
    route: '/meetings',
    setup: (p) => viaState(p, 'tencent-down', '/jobs'),
    expect: ['[data-testid="jobs-fetch-stalled"]', 'ul[aria-label="内置定时任务"]'],
  },
  {
    id: 'storage',
    why: '归档存储正常态：容量条 + 八格统计',
    route: '/storage',
    expect: ['[data-testid="stat-archived"]', '[data-testid="nas-capacity"] [role="img"]'],
  },
  {
    id: 'storage-nas-down',
    why: 'NAS 不可达：容量探不到（null 不折成 0）',
    route: '/meetings',
    setup: (p) => viaState(p, 'nas-down', '/storage'),
    expect: ['[data-testid="nas-error"]', '[data-testid="stat-archive-failed"]'],
  },
  {
    id: 'storage-invalid-days',
    why: '保留天数配置非法 + 归档失败数暂不可得 + 到期清理已暂停',
    route: '/storage?world=degraded',
    expect: [
      '[data-testid="retention-alert"]',
      '[data-testid="stat-archive-failed"] [class*="statVMissing"]',
      '[data-testid="cleanup-state"][class*="cleanupPaused"]',
    ],
  },
  {
    id: 'storage-cleanup',
    why: '「立即清理」二次确认：红色危险按钮（这一屏它是禁用态）+ 为什么现在没得删',
    route: '/storage',
    setup: openCleanupSheet,
    expect: ['[role="dialog"][data-state="open"]', '[data-testid="cleanup-blocked"]'],
  },
  {
    id: 'audit',
    why: '操作审计：被拒绝 / 存疑的结果 / 认不出的操作者 / 后端还没登记中文名的动作',
    route: '/audit',
    expect: [
      '[data-testid="audit-window"]',
      // 改版把「拒绝」从 data-deny 换成了 data-flag（准许是默认值，不标）。
      // 两种都点名：拒绝要有色条，存疑也要有——它们是这一屏存在的理由。
      'tr[data-flag="deny"]',
      'tr[data-flag="unknown"]',
      '[data-testid^="audit-result-"][data-kind="unknown"]',
      // 「这一页有 N 种动作后端还没登记中文名」那块告示牌（阶段 5 · F9）。
      // 它用的是 --warn 那组颜色，两种主题都要过对比度
      '[data-testid="audit-unlabeled-actions"]',
    ],
  },
  {
    id: 'audit-detail',
    why: '展开一条的完整记录',
    route: '/audit',
    setup: openAuditDetail,
    expect: ['[data-testid^="audit-expanded-"]'],
  },
  {
    id: 'consumers',
    why: '采集授权：能取走什么 + 已授权但现在取不到（带原因汇总）',
    route: '/consumers',
    expect: [
      '[data-testid="reach-kb-indexer"][data-kind="reachable"]',
      // 「另有 N 场已授权但现在取不到」那一块是 reach 的兄弟节点，不在它里面
      '[class*="asideLead"]',
      '[class*="tallyItem"]',
    ],
  },
  {
    id: 'consumers-sheet',
    why: '「现在能取走什么」清单抽屉打开',
    route: '/consumers',
    setup: openInventorySheet,
    expect: ['[role="dialog"][data-state="open"]', '[class*="InventorySheet__row"]'],
  },
  {
    id: 'preview',
    why: '内容预览 · 纪要 tab（资产按类合并成组，展开一组让明细也进扫描）',
    route: '/preview/m1',
    // 资产明细（后端理由、逐格式的体积与 NAS 路径）折在 `<details>` 里。不展开
    // 就扫，对比度这一项只量得到收起来的那几行 summary——一次**扫不到东西却报
    // 「通过」**的检查，和上一轮条状元素扫描从 20 掉到 0 是同一个坑。
    setup: expandAssetGroup,
    expect: [
      '[role="tablist"][aria-label="内容视图"]',
      'button[role="tab"][data-tab="minutes"][aria-selected="true"]',
      '[class*="AssetPanel__state"]',
      // 展开真的生效了才算数：明细里的路径行只在 [open] 之后可见
      '[class*="AssetPanel__group"][open] [class*="AssetPanel__item"]',
    ],
  },
  {
    id: 'preview-transcript',
    why: '内容预览 · 转写文字 tab',
    route: '/preview/m1',
    setup: (p) => previewTab(p, 'transcript'),
    expect: ['#pv-tab-transcript[aria-selected="true"]', 'ul[aria-label="转写分段"]'],
  },
  {
    id: 'preview-timeline',
    why: '内容预览 · 时间轴 tab（转写分段，不是章节）',
    route: '/preview/m1',
    setup: (p) => previewTab(p, 'timeline'),
    expect: ['#pv-tab-timeline[aria-selected="true"]', '[class*="Preview__backendText"]'],
  },
  {
    id: 'preview-restricted',
    why: '被规则禁止采集的会议：琥珀警示条 + 认不出时间戳格式的转写',
    route: '/preview/m6',
    setup: (p) => previewTab(p, 'timeline'),
    expect: ['[role="note"][class*="Preview__warn"]', '[class*="Preview__emptyBox"]'],
  },
]

async function setState(page: Page, v: string): Promise<void> {
  await page.selectOption(STATE_SELECT, v)
  await page.waitForTimeout(450)
}
async function hoverRow(page: Page): Promise<void> {
  await page.locator('tbody tr').first().hover()
  await page.waitForTimeout(250)
}
async function selectRows(page: Page): Promise<void> {
  const boxes = page.locator('tbody tr input[type="checkbox"]')
  const n = Math.min(2, await boxes.count())
  for (let i = 0; i < n; i++) await boxes.nth(i).check()
  await page.waitForTimeout(450)
}
async function openDrawer(page: Page): Promise<void> {
  await hoverRow(page)
  await page.locator('button[aria-label$="的详情"]').first().click()
  await page.waitForTimeout(450)
}
async function openPopover(page: Page): Promise<void> {
  // **幂等**：菜单已经开着就什么都不做。再点一次触发器是把它关掉，
  // 而主题三选搬进菜单之后，连点三颗按钮之间需要保证它一直开着。
  const trigger = page.locator('button[aria-haspopup="menu"]').first()
  if ((await trigger.getAttribute('aria-expanded')) === 'true') return
  await trigger.click()
  await page.waitForTimeout(350)
}
async function openGrant(page: Page): Promise<void> {
  // 按**可读名**定位，不按 class 名。改版把这个按钮的类从 grantAdd 改成
  // progAdd，这条夹具就等了 30 秒然后整轮挂掉——而 class 名本来就不是契约。
  // aria-label 是：给「<标题>」授权一个采集程序 / 再给「…」授权一个采集程序。
  // 顺带：无障碍扫描本来就该按可读名找元素。
  await page.locator('button[aria-label*="授权一个采集程序"]').first().click()
  await page.waitForTimeout(450)
}
/* ── 另外六个页面的形态搭建 ─────────────────────────────────────── */

/**
 * 把系统状态拨到 `state`（**两层都拨**），再走左栏导航进目标页。
 *
 * 三步各有各的必要：
 *
 * 1. **顶栏那个下拉**驱动的是全局告警横幅（`app/SystemStatus.tsx` 的 protoAlert）。
 * 2. **`window.__mdeProto`** 驱动的是数据层（`api/mock/install.ts` 的
 *    `applyNasDown` / `applyTencentDown`）。页面碰不到 `api/mock/`（那是设计），
 *    所以那个下拉够不着数据——只拨它，归档存储页照样报 NAS 连得上。
 *    两层不一起拨，屏幕上就会出现"横幅说断了、页面说好着"。
 * 3. **走左栏**（客户端路由，React 状态跟着过去）让目标页重新挂载一次：
 *    定时任务页与归档存储页挂载时各取一次数就不再取了，它们没有理由去订阅一个
 *    演示用的开关。直接开目标页再拨状态，页面上什么都不会变，
 *    场景就会稳稳地扫一屏正常态然后报「通过」——那正是 F8 要修掉的那种假通过。
 *    （整页 reload 也不行：那个状态是 React state，刷新就回到 `ok`。）
 */
async function viaState(page: Page, state: string, to: string): Promise<void> {
  await setState(page, state)
  await page.evaluate(`window.__mdeProto.setSystemState(${JSON.stringify(state)})`)
  await page.click(`${NAV_SELECTOR} a[href="${to}"]`)
  await page.waitForTimeout(700)
}

/** 影响预览有 350ms 防抖，防抖之后还要跑一次 `POST /rules/preview`。 */
const PREVIEW_SETTLE_MS = 900

async function openRuleEditor(page: Page): Promise<void> {
  // 新建（而不是编辑现有的那条）：默认草稿是「标题含空串」，它命中全部会议，
  // 于是预览里 opened / warnings 都有东西——正是要扫的那几种颜色。
  await page.getByRole('button', { name: '新建采集权限规则' }).click()
  await page.waitForTimeout(PREVIEW_SETTLE_MS)
}
async function openRuleMatches(page: Page): Promise<void> {
  await page.locator('[class*="Rules__hits"]').first().click()
  await page.waitForTimeout(500)
}
async function openCleanupSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: '立即清理已到期文件' }).click()
  // 打开时先跑一次 dry-run（POST /storage/cleanup-now，不带 confirm）
  await page.waitForTimeout(500)
}
async function openAuditDetail(page: Page): Promise<void> {
  await page.getByRole('button', { name: '完整记录' }).first().click()
  await page.waitForTimeout(250)
}
async function openInventorySheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: '查看清单' }).first().click()
  await page.waitForTimeout(450)
}
/**
 * 把资产面板的第一组展开。折在 `<details>` 里的明细（后端逐条写的理由、每个格式
 * 的体积与 NAS 路径）不展开就不在渲染树里可见，对比度与横向溢出两项都量不到它。
 */
async function expandAssetGroup(page: Page): Promise<void> {
  await page.click('[class*="AssetPanel__summary"]')
  await page.waitForTimeout(200)
}

async function previewTab(page: Page, id: string): Promise<void> {
  await page.click(`#pv-tab-${id}`)
  // 转写那一 tab 会自己再取一次正文
  await page.waitForTimeout(700)
}

async function fireToast(page: Page): Promise<void> {
  await hoverRow(page)
  const btn = page.locator('button[aria-label^="把「"]').first()
  if (await btn.count()) {
    await btn.click()
    await page.waitForTimeout(400)
  }
}

/**
 * `?proto=1` 把顶栏那两个原型控件调出来（见 `src/app/GlobalBar.tsx`）。它们默认
 * 不渲染，而本脚本的五个系统形态场景（nas-down / tencent-down / load-failed /
 * loading / empty）全靠其中的状态下拉驱动——不带这个参数，`setState` 找不到
 * `STATE_SELECT`，那五个场景会直接超时失败。
 */
/**
 * 每个场景各扫到了多少个文字元素。**这是"场景真的扫到内容了"的那份证据**，
 * 单独打一张表：一个只剩页头骨架的错误态也能扫出几十个元素，光看总数看不出来，
 * 逐场景摆开才看得出哪一屏明显比别的薄。
 */
const sceneScans = new Map<string, { why: string; route: string; light: number; dark: number }>()

function recordScan(s: Scene, theme: 'light' | 'dark', checked: number): void {
  const row = sceneScans.get(s.id) ?? { why: s.why, route: s.route, light: 0, dark: 0 }
  row[theme] = checked
  sceneScans.set(s.id, row)
}

function printScenes(): void {
  if (sceneScans.size === 0) return
  const bar = '─'.repeat(78)
  console.log('\n' + bar)
  console.log('场景覆盖（每个形态在两种主题下各扫到多少个文字元素）')
  console.log(bar)
  const w = Math.max(...[...sceneScans.keys()].map((k) => k.length))
  for (const [id, r] of sceneScans) {
    const nums = `浅 ${String(r.light).padStart(4)} · 深 ${String(r.dark).padStart(4)}`
    console.log(`  ${id.padEnd(w)}  ${nums}  ${r.route}　${r.why}`)
  }
}

/**
 * 这一屏到底是不是它该有的样子。**这是场景有没有意义的那道验收**。
 *
 * 分两件事验：`expect` 里点名的形态标志必须真的出现；`ERROR_MARKERS` 里那几种
 * 错误态一个都不许出现。第二条尤其重要——错误态下 `NAV_SELECTOR` 照样在，
 * 页面框架也照样渲染，扫过去的元素数还不少，报告里看起来一切正常。
 *
 * `proto_not_implemented` 单独拎出来说：那是假后端少了一条端点，
 * 修的地方在 `src/api/mock/install.ts`，不在页面里。
 */
async function assertLive(page: Page, s: Scene, check: string, where: string): Promise<void> {
  for (const sel of s.expect ?? []) {
    try {
      await page.waitForSelector(sel, { timeout: 6000 })
    } catch {
      fail(
        check,
        where,
        `这一屏没渲染出该有的东西：等不到 ${sel}`,
        '    场景是跑过去了，但扫的不是这一页的内容——等于这一页没进门槛。',
        `    先手动开一次 ${s.route}${s.route.includes('?') ? '&' : '?'}proto=1 看它到底渲染了什么。`,
      )
    }
  }

  const probe =
    `(() => { const ms = ${JSON.stringify(ERROR_MARKERS)};` +
    ' return { hit: ms.filter((m) => document.querySelector(m) !== null),' +
    " notImpl: document.body.innerText.includes('proto_not_implemented') } })()"
  const bad = (await page.evaluate(probe)) as { hit: string[]; notImpl: boolean }
  if (s.errorOnPurpose) bad.hit = []

  if (bad.notImpl) {
    fail(
      check,
      where,
      '这一屏上有 `proto_not_implemented`：原型模式的假后端少答了一条端点',
      '    页面渲染的是错误态，这一次扫描不算数。补在 src/api/mock/install.ts。',
    )
  }
  for (const m of bad.hit) {
    fail(
      check,
      where,
      `这一屏是错误态（命中 ${m}），扫到的不是页面本身`,
      '    要么假后端少答了一条端点，要么这一页真的坏了——两种都得先修，不能豁免。',
    )
  }
}

async function open(page: Page, route: string, waitFor: string = NAV_SELECTOR): Promise<void> {
  const url = new URL(BASE + route)
  url.searchParams.set('proto', '1')
  await page.goto(url.toString(), { waitUntil: 'load' })
  await page.waitForSelector(waitFor, { timeout: 15000 })
  await page.waitForFunction('document.fonts.status === "loaded"', null, { timeout: 6000 }).catch(() => {})
  await page.waitForTimeout(120)
}

/* ══════════════════════════════════════════════════════════════════
   检查 1：对比度（两种主题各扫一遍）+ 语义色令牌
   ══════════════════════════════════════════════════════════════════ */

interface ScanRow {
  desc: string; text: string; fg: string; fgEff: string; bg: string
  opacity: number; size: number; weight: number; large: boolean
  ratio: number; need: number; imageAt?: string
}
interface ScanResult {
  checked: number; fails: ScanRow[]; unresolved: ScanRow[]
  largeExempt: ScanRow[]; inkFourText: ScanRow[]
}

function fmtRow(r: ScanRow): string {
  return `${r.ratio}:1（要 ${r.need}:1）「${r.text}」 ${r.fg} 压 ${r.bg}`
    + (r.opacity < 1 ? ` ×opacity ${r.opacity} → 实际 ${r.fgEff}` : '')
    + ` · ${r.size}px/${r.weight}${r.large ? ' 大字' : ''}\n    ${r.desc}`
}

async function runContrast(page: Page, theme: 'light' | 'dark'): Promise<void> {
  for (const s of SCENES) {
    await open(page, s.route, s.waitFor)
    if (s.setup) {
      try { await s.setup(page) } catch (e) {
        fail('1 对比度', `${theme}/${s.id}`, `形态没搭起来：${e instanceof Error ? e.message : String(e)}`)
        continue
      }
    }
    await assertLive(page, s, '1 对比度', `${theme}/${s.id}`)
    const r = await page.evaluate('window.__a11y.scanContrast()') as ScanResult
    bump('对比度：受检文字元素', r.checked)
    recordScan(s, theme, r.checked)
    for (const row of r.fails) fail('1 对比度', `${theme}/${s.id}`, fmtRow(row))
    for (const row of r.inkFourText) {
      fail('1 对比度', `${theme}/${s.id}`,
        `--ink-4 用在了文字上（它是图形专用：描边/分隔/填充）「${row.text}」\n    ${row.desc}`)
    }
    for (const row of r.unresolved) {
      note('1 对比度', `${theme}/${s.id}`, `底是背景图，自动判不了（${row.imageAt}）：${fmtRow(row)}`)
    }
    for (const row of r.largeExempt) {
      note('1 对比度', `${theme}/${s.id}`, `按大字 3:1 放行（正文口径会红）：${fmtRow(row)}`)
    }
  }
}

/* ── 语义色令牌：不只是"够不够对比度"，还要"是不是那个色相" ────────── */

interface TokenVal { raw: string; hex: string; rgb: number[]; a: number; h: number; s: number; l: number }

const HUE_RULES: Array<{ token: string; band: [number, number]; minSat: number; role: string }> = [
  { token: '--fail', band: [340, 26], minSat: 0.35, role: '红＝归档失败＝一个月后永久丢失，本系统最严重的状态' },
  { token: '--fail-line', band: [335, 32], minSat: 0.15, role: '红系描边' },
  { token: '--fail-soft', band: [330, 38], minSat: 0.04, role: '红系浅底' },
  { token: '--warn', band: [22, 62], minSat: 0.30, role: '琥珀＝有人手动改写了规则 / 保留期快到了' },
  { token: '--warn-line', band: [22, 62], minSat: 0.15, role: '琥珀系描边' },
  { token: '--warn-soft', band: [18, 72], minSat: 0.04, role: '琥珀系浅底' },
  { token: '--brand', band: [198, 252], minSat: 0.45, role: '蓝＝数据可被取走 / 主交互' },
  { token: '--brand-text', band: [198, 252], minSat: 0.45, role: '蓝字' },
  { token: '--brand-press', band: [198, 252], minSat: 0.40, role: '蓝按下态' },
  { token: '--brand-line', band: [196, 256], minSat: 0.15, role: '蓝系描边' },
  { token: '--brand-soft', band: [192, 262], minSat: 0.04, role: '蓝系浅底' },
]

const NEUTRALS = ['--ink', '--ink-2', '--ink-3', '--ink-4', '--ground', '--surface', '--surface-2', '--rail', '--line', '--line-soft']

const PAIRS: Array<{ fg: string; bg: string; need: number; why: string }> = [
  { fg: '--on-brand', bg: '--brand', need: 4.5, why: '主按钮文字压品牌实底' },
  { fg: '--on-fail', bg: '--fail', need: 4.5, why: '压在失败实底上的字（深色下 --fail 变浅，白字只有 2.52:1）' },
  { fg: '--accent-invert', bg: '--ink', need: 4.5, why: '反相表面（toast / 批量条 / tip）上的强调色' },
  { fg: '--ground', bg: '--ink', need: 4.5, why: '反相表面上的正文' },
  { fg: '--brand-text', bg: '--brand-soft', need: 4.5, why: '蓝字压蓝浅底（#0066FF 在这里只有 4.18，所以才有 --brand-text）' },
  { fg: '--brand-text', bg: '--surface', need: 4.5, why: '蓝字压卡片底' },
  { fg: '--fail', bg: '--surface', need: 4.5, why: '归档失败的红字压卡片底' },
  { fg: '--fail', bg: '--ground', need: 4.5, why: '归档失败的红字压页面底' },
  { fg: '--warn', bg: '--surface', need: 4.5, why: '保留期将至的琥珀字压卡片底' },
  { fg: '--brand', bg: '--surface', need: 3, why: '焦点环压卡片底' },
  { fg: '--brand', bg: '--ground', need: 3, why: '焦点环压页面底' },
  { fg: '--brand', bg: '--rail', need: 3, why: '焦点环压填充块底（骨架屏 / 审计页的 --rail 块）' },
  // 左栏在改版后不再用 --rail 当底，改成了暗带 --nav。上面那条测的已经不是左栏，
  // 补这一条测真的左栏——焦点环压在暗带上仍然要过 3:1。
  { fg: '--brand', bg: '--nav', need: 3, why: '焦点环压左栏暗带底' },
  { fg: '--ink-4', bg: '--surface', need: 3, why: '图形专用色（描边/分隔/填充）压卡片底' },
  { fg: '--code-note', bg: '--code-ground', need: 4.5, why: '代码块注释（内容表面，不跟随主题）' },
  { fg: '--video-ink-3', bg: '--video-ground', need: 4.5, why: '播放器三级文字（内容表面，不跟随主题）' },
]

function lum(rgb: number[]): number {
  const f = (c: number): number => {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0] ?? 0) + 0.7152 * f(rgb[1] ?? 0) + 0.0722 * f(rgb[2] ?? 0)
}
function ratio(a: number[], b: number[]): number {
  const la = lum(a)
  const lb = lum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
function inBand(h: number, band: [number, number]): boolean {
  const [lo, hi] = band
  return lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi
}
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

async function runTokenSemantics(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await open(page, '/meetings')
  const res = await page.evaluate('window.__a11y.tokens()') as { values: Record<string, TokenVal>; dataTheme: string | null }
  const v = res.values
  bump('语义色令牌断言', HUE_RULES.length + NEUTRALS.length + PAIRS.length)

  for (const r of HUE_RULES) {
    const t = v[r.token]
    if (!t) { fail('1 对比度', `${theme}/令牌`, `${r.token} 解析不出颜色`); continue }
    const h = Math.round(t.h)
    const s = Math.round(t.s * 100) / 100
    if (!inBand(t.h, r.band)) {
      fail('1 对比度', `${theme}/令牌`,
        `${r.token} = ${t.raw}（${t.hex}）色相 ${h}°，不在 ${r.band[0]}–${r.band[1]}° 内`,
        `  ${r.role}`,
        '  语义色的含义是产品语义的一部分：色相跑了，所有「引用了 var(…) 」的测试仍然全绿，但用户看到的意思变了')
    } else if (t.s < r.minSat) {
      fail('1 对比度', `${theme}/令牌`,
        `${r.token} = ${t.raw}（${t.hex}）饱和度 ${s}，低于 ${r.minSat} —— 已经褪成灰，认不出是「${r.role}」`)
    }
  }

  for (const n of NEUTRALS) {
    const t = v[n]
    if (!t) { fail('1 对比度', `${theme}/令牌`, `${n} 解析不出颜色`); continue }
    const d = Math.max(...t.rgb) - Math.min(...t.rgb)
    if (d > 40) {
      fail('1 对比度', `${theme}/令牌`, `${n} = ${t.raw}（${t.hex}）通道极差 ${d}，不再是中性色`,
        '  中性色是把品牌蓝抽掉饱和度得到的冷灰，不是一个可以随手改成彩色的位置')
    } else if (d >= 6 && !inBand(t.h, [190, 262])) {
      fail('1 对比度', `${theme}/令牌`, `${n} = ${t.raw}（${t.hex}）色相 ${Math.round(t.h)}°，不是冷灰（190–262°，源自品牌色相 222）`)
    }
  }

  /* 三个语义色必须互相认得出来 */
  const trio: Array<[string, string]> = [['--fail', '--warn'], ['--fail', '--brand'], ['--warn', '--brand']]
  for (const [a, b] of trio) {
    const ta = v[a]
    const tb = v[b]
    if (!ta || !tb) continue
    const gap = hueGap(ta.h, tb.h)
    if (gap < 25) {
      fail('1 对比度', `${theme}/令牌`, `${a}(${ta.hex}, ${Math.round(ta.h)}°) 与 ${b}(${tb.hex}, ${Math.round(tb.h)}°) 色相只差 ${Math.round(gap)}°，两个语义分不开`)
    }
  }

  for (const p of PAIRS) {
    const f = v[p.fg]
    const b = v[p.bg]
    if (!f || !b) { fail('1 对比度', `${theme}/令牌`, `${p.fg} / ${p.bg} 解析不出颜色`); continue }
    const r = Math.round(ratio(f.rgb, b.rgb) * 100) / 100
    if (r + 0.005 < p.need) {
      fail('1 对比度', `${theme}/令牌`, `${p.fg}(${f.hex}) 压 ${p.bg}(${b.hex}) = ${r}:1，要 ${p.need}:1 —— ${p.why}`)
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
   检查 2：Tab 泄漏 · 无障碍树 · 焦点环
   ══════════════════════════════════════════════════════════════════ */

interface Stop {
  key: string; desc: string; name: string; rendered: boolean; focusVisible: boolean
  rect: { x: number; y: number; w: number; h: number }
  outlineStyle: string; outlineWidth: number; outlineColor: string
  outlineRatio: number; aroundBg: string
  inClosedOverlay: boolean; inert: boolean
}

async function tabWalk(page: Page, cap = 400): Promise<Stop[]> {
  await page.evaluate('window.__a11y.blurAll()')
  const stops: Stop[] = []
  const seen = new Set<string>()
  /* 焦点跑出文档（Tab 到浏览器 chrome）时 activeInfo() 给 null。不能就此收工——
     再按一下通常会从文档开头绕回来，就此 break 会漏掉整整半页的可聚焦元素。
     连着两次都在文档外才算走完。 */
  let blanks = 0
  for (let i = 0; i < cap; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate('window.__a11y.activeInfo()') as Stop | null
    if (!info) {
      if (++blanks >= 2) break
      continue
    }
    blanks = 0
    if (seen.has(info.key)) break
    seen.add(info.key)
    stops.push(info)
  }
  return stops
}

// StatusDot 不在这张表里：它已经没有可点变体（见 ui/StatusDot.tsx 的注释），
// Tab 一圈本来就走不到它。要求探针去验一个不存在的焦点环，验的是别的东西。
const COMPONENT_COVERAGE = ['Input__', 'Button__', 'Chip__']

async function runTabAndFocus(page: Page, context: BrowserContext): Promise<void> {
  const cdp: CDPSession = await context.newCDPSession(page)
  await cdp.send('Accessibility.enable')

  /* 两个形态：干净页面；以及「浮层开过又关上」——关闭态浮层仍然挂在 DOM 里，
     那正是 44 个泄漏元素当年藏身的地方。 */
  const cases: Array<{ id: string; setup: (p: Page) => Promise<void> }> = [
    { id: 'ok', setup: async () => {} },
    {
      id: 'overlay-opened-then-closed',
      setup: async (p) => {
        await openDrawer(p)
        await p.keyboard.press('Escape')
        await p.waitForTimeout(500)
        await openPopover(p)
        await p.keyboard.press('Escape')
        await p.waitForTimeout(500)
        await openGrant(p)
        await p.keyboard.press('Escape')
        await p.waitForTimeout(500)
      },
    },
  ]

  const covered = new Set<string>()

  for (const c of cases) {
    await open(page, '/meetings')
    await c.setup(page)

    /* 顺序要紧：静态口径必须在 Tab 走查**之前**量。走查会把「聚焦即浮出」的
       按钮逐个点亮，走完之后再量，这条口径就恒等于 0 —— 一个永远绿的假门槛。 */
    await page.evaluate('window.__a11y.clearProbes()')
    const st = await page.evaluate('window.__a11y.staticFocusables()') as {
      total: number; invisible: Array<{ desc: string; name: string; key: string | null }>
    }

    const stops = await tabWalk(page)
    bump('Tab 站点', stops.length)
    if (stops.length < 10) {
      fail('2 Tab 泄漏', c.id, `只走到 ${stops.length} 个 Tab 站点——页面没起来，或 Tab 走查本身坏了`)
    }

    for (const s of stops) {
      for (const k of COMPONENT_COVERAGE) if (s.desc.includes(k)) covered.add(k)

      if (!s.rendered) {
        fail('2 Tab 泄漏', c.id,
          `Tab 停在了一个看不见的元素上：「${s.name}」`,
          `    ${s.desc}`,
          `    盒子 ${Math.round(s.rect.w)}×${Math.round(s.rect.h)} @ (${Math.round(s.rect.x)}, ${Math.round(s.rect.y)})`
          + (s.inClosedOverlay ? '，且它在一个 data-state="closed" 的浮层里' : ''))
        continue
      }
      if (s.inClosedOverlay) {
        fail('2 Tab 泄漏', c.id, `Tab 停在关闭态浮层内的控件上：「${s.name}」\n    ${s.desc}`)
      }
      if (!s.focusVisible) {
        note('2 Tab 泄漏', c.id, `键盘 Tab 过去却没有匹配 :focus-visible：「${s.name}」 ${s.desc}`)
        continue
      }
      if (s.outlineStyle === 'none' || s.outlineWidth < 1) {
        fail('2 Tab 泄漏', c.id,
          `焦点环不可见：「${s.name}」 outline-style=${s.outlineStyle} width=${s.outlineWidth}px`,
          `    ${s.desc}`,
          '    焦点环必须在按下 Tab 的那一帧就在（design-system.md §5）')
      } else if (s.outlineRatio + 0.005 < 3) {
        fail('2 Tab 泄漏', c.id,
          `焦点环对比度不足：「${s.name}」 ${s.outlineColor} 压 ${s.aroundBg} = ${s.outlineRatio}:1，要 3:1`,
          `    ${s.desc}`)
      }
    }

    /* 关闭态浮层：必须 inert，且不该出现在 Chromium 的无障碍树里。
       jsdom 不实现 inert 的行为语义，userEvent.tab() 也不认它——
       这一条只有在真实浏览器里才验得到。 */
    const closed = await page.evaluate('window.__a11y.closedOverlays()') as Array<{
      desc: string; inert: boolean; isPanel: boolean
      controls: Array<{ desc: string; name: string }>
      texts: string[]
    }>
    bump('关闭态浮层', closed.length)
    if (c.id === 'overlay-opened-then-closed' && closed.length === 0) {
      fail('2 Tab 泄漏', c.id, '浮层开过又关上之后，页面里一个 data-state="closed" 的浮层都没有——这条检查落空了')
    }

    const visibleNames = await page.evaluate('window.__a11y.visibleFocusableNames()') as string[]
    const visible = new Set(visibleNames)

    const ax = await cdp.send('Accessibility.getFullAXTree')
    const axNames = new Set<string>()
    for (const n of ax.nodes) {
      if (n.ignored) continue
      const nm = n.name && typeof n.name.value === 'string' ? n.name.value.replace(/\s+/g, ' ').trim() : ''
      if (nm) axNames.add(nm)
    }
    bump('无障碍树可见节点名', axNames.size)

    for (const ov of closed) {
      /* 遮罩（.scrim）也带 data-state，但它是 aria-hidden 的纯装饰、没有可聚焦
         内容，不需要 inert。只有真正的浮层面板（带 role 的那个）必须 inert。 */
      if (ov.isPanel && !ov.inert) {
        fail('2 Tab 泄漏', c.id,
          `关闭态浮层没有 inert：${ov.desc}`,
          '    opacity:0 / transform:translateX(100%) 都不会把元素移出 Tab 序列与无障碍树')
      }
      for (const ctl of ov.controls) {
        if (!ctl.name || visible.has(ctl.name)) continue
        if (axNames.has(ctl.name)) {
          fail('2 Tab 泄漏', c.id,
            `关闭态浮层里的控件仍然在无障碍树里：「${ctl.name}」`,
            `    ${ctl.desc}`,
            `    所在浮层：${ov.desc}`)
        }
      }
    }

    /* 静态口径与走查结果对账。静止时看不见、但 Tab 停上去就浮出来的按钮
       （`.extendBtn` / `.detailBtn` 的 :focus-visible 规则）不是泄漏——那是
       「聚焦即显形」，和藏在关闭浮层里够不着又念得出来的控件是两回事。 */
    const shownWhenFocused = new Set(stops.filter((x) => x.rendered).map((x) => x.key))
    const leaked = st.invisible.filter((x) => x.key === null || !shownWhenFocused.has(x.key))
    for (const x of leaked) {
      fail('2 Tab 泄漏', c.id,
        `可聚焦但不可见、没有 inert、Tab 停上去也不浮出：「${x.name}」\n    ${x.desc}`)
    }
    note('2 Tab 泄漏', c.id,
      `可聚焦元素 ${st.total} 个；Tab 实际走过 ${stops.length} 站；静止时「可聚焦但不可见」${st.invisible.length} 个，`
      + `其中 ${st.invisible.length - leaked.length} 个是聚焦即浮出（Tab 停上去时可见，不算泄漏）；泄漏 ${leaked.length}`)
  }

  for (const k of COMPONENT_COVERAGE) {
    if (!covered.has(k)) {
      fail('2 Tab 泄漏', '焦点环覆盖', `Tab 一圈没走到任何 ${k.replace('__', '')} —— 这个组件的焦点环没有被验到`)
    }
  }

  /* 浮层基座退化聚焦：内容为空时焦点落到 .root 本身，环还在不在。
     `.root{outline:none}` 与 base.css 的 `:focus-visible` 同优先级，
     谁赢取决于打包注入顺序——这就是本脚本必须跑在构建产物上的原因。 */
  await open(page, '/meetings')
  await openDrawer(page)
  const cls = await page.evaluate('window.__a11y.overlayRootClass()') as string | null
  if (!cls) {
    fail('2 Tab 泄漏', '浮层基座', '页面上找不到任何浮层面板，取不到 Overlay 基座的类名')
  } else {
    const rootOnly = cls.split(/\s+/).filter((c) => /Overlay__/.test(c)).join(' ')
    for (const attr of [rootOnly || cls, cls]) {
      const r = await page.evaluate(`window.__a11y.probeOverlayFocusRing(${JSON.stringify(attr)})`) as {
        classAttr: string; focused: boolean; focusVisible: boolean
        outlineStyle: string; outlineWidth: number; outlineColor: string
        outlineRatio: number; aroundBg: string
      }
      if (!r.focused) { fail('2 Tab 泄漏', '浮层基座', `class="${attr}" 的探针元素聚焦失败`); continue }
      if (!r.focusVisible) {
        note('2 Tab 泄漏', '浮层基座', `class="${attr}"：focus({focusVisible:true}) 没让它匹配 :focus-visible，本条改由构建产物文本扫描兜底`)
        continue
      }
      bump('浮层基座焦点环探针')
      if (r.outlineStyle === 'none' || r.outlineWidth < 1) {
        fail('2 Tab 泄漏', '浮层基座',
          `空内容浮层退化到聚焦容器本身时，焦点环被吃掉了：class="${attr}"`,
          `    outline-style=${r.outlineStyle} outline-width=${r.outlineWidth}px`,
          '    组件级 outline 复位与 base.css 的 :focus-visible 同优先级，本次构建里前者赢了')
      } else if (r.outlineRatio + 0.005 < 3) {
        fail('2 Tab 泄漏', '浮层基座',
          `浮层基座焦点环对比度不足：${r.outlineColor} 压 ${r.aroundBg} = ${r.outlineRatio}:1，要 3:1`)
      }
    }
  }
  await cdp.detach()
}

/* ══════════════════════════════════════════════════════════════════
   检查 3：横向溢出 + 视口内可达 + 条状元素几何
   ══════════════════════════════════════════════════════════════════ */

const WIDTHS = [1440, 1050, 375]

interface LayoutResult {
  page: {
    scrollWidth: number; clientWidth: number; innerWidth: number
    bodyScrollWidth: number; bodyClientWidth: number
    htmlOverflowX: string; bodyOverflowX: string
  }
  outOfViewport: Array<{ desc: string; name: string; left: number; right: number; width: number; viewport: number; over: number }>
  occluded: Array<{ desc: string; name: string; hitBy: string }>
  squeezed: Array<{ desc: string; left: number; avail: number; natural: number; rendered: number; centerPct: number; viewport: number }>
}

let vacuityNoted = false
let barsSeen = 0

async function runLayout(page: Page): Promise<void> {
  // 加了 'storage'：改版把单值进度条的调用点删光之后，条状几何扫描在这几个场景里
  // 一个元素都找不到，而报告照样显示"通过"。容量条现在是全站唯一的条，它必须在扫描里。
  const scenes = SCENES.filter((s) => ['ok', 'selected', 'drawer', 'loading', 'nas-down', 'login', 'storage'].includes(s.id))
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 })
    for (const s of scenes) {
      await open(page, s.route, s.waitFor)
      if (s.setup) {
        try { await s.setup(page) } catch (e) {
          fail('3 横向溢出', `${w}px/${s.id}`, `形态没搭起来：${e instanceof Error ? e.message : String(e)}`)
          continue
        }
      }
      await assertLive(page, s, '3 横向溢出', `${w}px/${s.id}`)
      const r = await page.evaluate('window.__a11y.scanLayout()') as LayoutResult
      bump('视口 × 形态')

      if (r.page.scrollWidth > r.page.clientWidth) {
        fail('3 横向溢出', `${w}px/${s.id}`,
          `页面横滚：documentElement.scrollWidth=${r.page.scrollWidth} > clientWidth=${r.page.clientWidth}`)
      }
      /* html 上的 overflow-x: clip 会把 documentElement.scrollWidth 摁死在
         clientWidth 上——实测注入一个 5000px 宽的元素，它仍然报 1440。也就是说
         brief 里那条 `documentElement.scrollWidth <= clientWidth` 在本工程**永远
         不会红**。body.scrollWidth 不受 clip 影响（clip 不产生滚动容器，
         scrollWidth 仍然量的是布局溢出），真正扛这条的是它。 */
      if (r.page.bodyScrollWidth > r.page.bodyClientWidth + 1) {
        fail('3 横向溢出', `${w}px/${s.id}`,
          `内容溢出到 body 之外：body.scrollWidth=${r.page.bodyScrollWidth} > clientWidth=${r.page.bodyClientWidth}`,
          '    表格自己的 overflow-x 容器不算——那种滚动不会累加到 body 上')
      }
      const bothClipped = /^(clip|hidden)$/.test(r.page.htmlOverflowX) && /^(clip|hidden)$/.test(r.page.bodyOverflowX)
      if (!vacuityNoted && bothClipped) {
        vacuityNoted = true
        note('3 横向溢出', '口径说明',
          `html 与 body 的 overflow-x 同为 ${r.page.htmlOverflowX}/${r.page.bodyOverflowX}（base.css 的 \`html, body { overflow-x: clip }\`），`,
          '    documentElement.scrollWidth 于是被摁死在 clientWidth 上，那条断言在本工程永远不会红。',
          '    要两个都是 clip 才会这样——放开任意一个它就能报出真实内容宽（实测 375 → 781）。',
          '    真正扛横向溢出的是 body.scrollWidth 与「元素在视口内可达」两条。')
      }
      /* 只量 scrollWidth 会漏：html/body 是 overflow-x: clip，被切掉的东西
         量不出来，一个只看 scrollWidth 的检查恰恰会给"被裁掉所以够不着"发通行证。 */
      for (const el of r.outOfViewport) {
        fail('3 横向溢出', `${w}px/${s.id}`,
          `元素跑出视口、够不着：「${el.name || '(无名)'}」 左 ${el.left} 右 ${el.right}，视口宽 ${el.viewport}（超出 ${el.over}px）`,
          `    ${el.desc}`,
          '    页面本身不横滚（overflow-x: clip 把它切掉了），所以只量 scrollWidth 抓不到这一条')
      }
      for (const el of r.squeezed) {
        fail('3 横向溢出', `${w}px/${s.id}`,
          `固定定位的条挤不进自己的位置：left=${el.left}px 之后只剩 ${el.avail}px 可用，它却要 ${el.rendered}px（已挤到 min-content，内容自然宽 ${el.natural}px）`,
          `    渲染出来的中心落在视口 ${el.centerPct}% 处，视口宽 ${el.viewport}px`,
          `    ${el.desc}`,
          '    页面不横滚、元素左右边也都在视口内——只量 scrollWidth 或"有没有跑出视口"都抓不到这一条')
      }
      for (const el of r.occluded) {
        note('3 横向溢出', `${w}px/${s.id}`,
          `中心点被别的元素接住：「${el.name || '(无名)'}」 ${el.desc}\n    命中的是 ${el.hitBy}`)
      }

      if (w === WIDTHS[0]) {
        const bars = await page.evaluate('window.__a11y.scanBars()') as {
          problems: Array<Record<string, unknown>>; seen: Array<Record<string, unknown>>
        }
        barsSeen += bars.seen.length
        bump('条状元素', bars.seen.length)
        for (const p of bars.problems) {
          fail('3 横向溢出', `${w}px/${s.id}`, `条状元素几何：${String(p.why)}`, `    ${String(p.desc)}`)
        }
      }
    }
  }
  // **空扫守卫**：一项扫 0 个元素的检查等于没在检查，但报告里它显示"通过"。
  // 这一轮就发生过：改版删光了单值进度条的调用点，条状几何从扫 20 个变成扫 0 个，
  // 六项门槛依旧全绿。要么把新的条挂上 data-bar，要么这项检查该删——两条路都得有人决定。
  if (barsSeen === 0) {
    fail('3 横向溢出', '条状元素', '一个带 data-bar="track" 的元素都没扫到——这项几何检查现在什么都没检查',
      '    要么页面上真的没有条了（那就删掉这项检查，别留一个恒绿的空壳）,',
      '    要么新的条没挂 data-bar="track"（见 src/ui/ProgressBar.tsx）。')
  }

  await page.setViewportSize({ width: WIDTHS[0] ?? 1440, height: 900 })
}

/* ══════════════════════════════════════════════════════════════════
   检查 5：prefers-reduced-motion 与三态主题在真实浏览器下真的生效
   ══════════════════════════════════════════════════════════════════ */

interface MotionScan {
  anims: Array<{ desc: string; name: string; duration: string; ms: number[]; iterations: string }>
  trans: Array<{ desc: string; properties: string[]; durations: number[]; maxMs: number; layoutProps: string[] }>
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

async function runMedia(page: Page, tf: TokenFile): Promise<void> {
  /* 先在「不减少动效」下确认确实有动画在跑——否则下面那条断言是空的。 */
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' })
  await open(page, '/meetings')
  await setState(page, 'loading')
  const full = await page.evaluate('window.__a11y.scanMotion()') as MotionScan
  const lively = full.anims.filter((a) => Math.max(...a.ms) > 100)
  bump('动画声明', full.anims.length)
  bump('过渡声明', full.trans.length)
  if (lively.length === 0) {
    fail('5 媒体查询', 'reduced-motion', '常态下一个时长超过 100ms 的动画都没有——"减少动效生效"这条断言是空的，抓不到任何东西')
  }
  for (const t of full.trans) {
    if (t.layoutProps.length > 0) {
      fail('5 媒体查询', '动效属性', `过渡里有布局属性 ${t.layoutProps.join('/')}（每帧触发 reflow）：${t.properties.join(', ')}`, `    ${t.desc}`)
    }
  }

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page, '/meetings')
  await setState(page, 'loading')
  const reduced = await page.evaluate('window.__a11y.scanMotion()') as MotionScan
  for (const a of reduced.anims) {
    const worst = Math.max(...a.ms)
    if (worst > 1) {
      fail('5 媒体查询', 'reduced-motion', `减少动效下动画仍在跑：${a.name} ${a.duration}（${a.iterations} 次）`, `    ${a.desc}`)
    }
  }
  for (const t of reduced.trans) {
    if (t.maxMs > 1) {
      fail('5 媒体查询', 'reduced-motion', `减少动效下过渡仍是 ${t.maxMs}ms：${t.properties.join(', ')}`, `    ${t.desc}`)
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  /* 三态主题。「跟随系统」＝根元素上**没有** data-theme 属性。 */
  const darkNames = [...tf.darkAttr.keys()]
  const probe = async (): Promise<Record<string, string | null>> =>
    await page.evaluate(`window.__a11y.readVars(${JSON.stringify(darkNames)})`) as Record<string, string | null>

  const expectAll = (got: Record<string, string | null>, want: Map<string, string>, where: string): void => {
    for (const [k, v] of want) {
      const g = got[k]
      if (g === undefined || g === null || norm(g) !== norm(v)) {
        fail('5 媒体查询', where, `${k} 实测 ${String(g)}，tokens.css 里写的是 ${v}`)
      }
    }
  }

  const lightWanted = new Map<string, string>()
  for (const k of darkNames) {
    const lv = tf.light.get(k)
    if (lv) lightWanted.set(k, lv)
  }

  await page.emulateMedia({ colorScheme: 'light' })
  await open(page, '/meetings')
  let got = await probe()
  if (got['#data-theme'] !== null) fail('5 媒体查询', '跟随系统', `默认状态下根元素带了 data-theme="${got['#data-theme']}"；「跟随系统」必须是没有这个属性`)
  expectAll(got, lightWanted, '跟随系统 + 浅色')

  await page.emulateMedia({ colorScheme: 'dark' })
  await open(page, '/meetings')
  got = await probe()
  if (got['#data-theme'] !== null) fail('5 媒体查询', '跟随系统', `跟随系统 + 深色下根元素带了 data-theme="${got['#data-theme']}"`)
  expectAll(got, tf.darkMedia, '跟随系统 + 深色（@media 块）')
  bump('三态主题令牌比对', darkNames.length * 4)

  /* 显式浅色必须在系统深色下赢。
     主题三选从顶栏搬进了头像菜单（顶栏最贵的位置不该给一年点一次的设置），
     所以每次导航之后要先把菜单打开——夹具不跟着 UI 走，就会像这次一样
     等 30 秒然后整轮挂掉。 */
  await openPopover(page)
  await page.getByRole('button', { name: '浅色', exact: true }).click()
  await page.waitForTimeout(150)
  got = await probe()
  if (got['#data-theme'] !== 'light') fail('5 媒体查询', '显式浅色', `点了「浅色」但 data-theme=${String(got['#data-theme'])}`)
  expectAll(got, lightWanted, '显式浅色（系统为深色）')

  /* 显式深色必须在系统浅色下赢 */
  await page.emulateMedia({ colorScheme: 'light' })
  await openPopover(page)
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await page.waitForTimeout(150)
  got = await probe()
  if (got['#data-theme'] !== 'dark') fail('5 媒体查询', '显式深色', `点了「深色」但 data-theme=${String(got['#data-theme'])}`)
  expectAll(got, tf.darkAttr, '显式深色（系统为浅色）')

  /* 切回跟随系统必须把属性摘掉 */
  await openPopover(page)
  await page.getByRole('button', { name: '跟随系统', exact: true }).click()
  await page.waitForTimeout(150)
  got = await probe()
  if (got['#data-theme'] !== null) fail('5 媒体查询', '跟随系统', `切回「跟随系统」后 data-theme 仍是 ${String(got['#data-theme'])}；必须是移除属性，不是写 data-theme="system"`)
  expectAll(got, lightWanted, '切回跟随系统（系统为浅色）')
}

/* ══════════════════════════════════════════════════════════════════
   串起来。任一项失败即非零退出。
   ══════════════════════════════════════════════════════════════════ */

const CHECK_TITLES: Array<[string, string]> = [
  ['0 已知缺口', '已知缺口名单与实际一致（过期的豁免算失败）'],
  ['1 对比度', '两种主题全页对比度 + 语义色令牌'],
  ['2 Tab 泄漏', 'Tab 泄漏 · 无障碍树 · 焦点环'],
  ['3 横向溢出', '1440 / 1050 / 375 无横向溢出且元素可达'],
  ['4 裸值', 'module.css 无裸 px / hex / rgb'],
  ['5 媒体查询', 'reduced-motion 与三态主题真的生效'],
]

/* ══════════════════════════════════════════════════════════════════
   已知缺口名单
   ══════════════════════════════════════════════════════════════════

   **这份名单现在是空的。** 它原来装着 8 条来自 `spec.md` §11 缺口 #2（移动端）
   的豁免：顶栏 7 个控件在 375px 下跑出视口，加上批量条被自身 left 偏移挤成竖柱。
   F7 把那个缺口做完之后（窄屏断点：左栏收到顶上、顶栏换行、表格改卡片、
   批量条改 left/right 双锚定），8 条同时不再复现，第 2 条硬约束因此让门槛红了，
   于是按它自己的要求把这两组从名单里删掉。

   名单留着（而不是连这段注释一起删）是因为下一次同样会需要它：
   有 spec / 裁定背书的已知缺口该具名列在这里，而不是把某一项检查关掉。

   这份名单不是「把门槛调哑」的开关，它有三条硬约束，缺一条就退化成静音：

     1. 每条缺口**具名 + 写明理由 + 指向 spec 条目**，并且照常**大声打印**出来。
        它出现在报告最显眼的一节里，不是被 filter 掉的一行。
     2. 某条缺口**不再复现**时，门槛**红**。过期的豁免是错误，不是好消息——
        将来有人顺手把 BatchBar 修好了，豁免却留着，下次它真坏了就没人喊了。
     3. 任何**不在名单上**的问题，照常红。名单按元素+症状精确匹配，
        绝不会顺手吃掉一条新问题。

   往这里加一条之前先问：它是不是真的有 spec / 裁定背书？没有就不该进来。 */

interface GapItem {
  /** 人话：这一条到底是什么。会原样打印。 */
  what: string
  /** 属于哪一项检查。那一项没跑（--only）时本条不参与对账，免得误报"豁免过期"。 */
  check: string
  /** 形态过滤（`375px/selected` 之类）。 */
  where: RegExp
  /** 对失败正文（含定位串那几行）的精确匹配。 */
  text: RegExp
}

interface KnownGap {
  id: string
  title: string
  ref: string
  reason: string[]
  items: GapItem[]
}

/** 空 = 现在没有任何已知缺口被豁免。上面那段注释记着这里曾经装过什么、为什么空了。 */
const KNOWN_GAPS: KnownGap[] = []

interface AbsorbedItem { item: GapItem; hits: Finding[] }
interface GapResult { gap: KnownGap; absorbed: AbsorbedItem[]; stale: GapItem[]; skipped: GapItem[] }

/** 把名单上的失败从 failures 里摘出来；名单上却不再复现的，反过来变成一条失败。 */
function reconcileGaps(): GapResult[] {
  const out: GapResult[] = []
  for (const gap of KNOWN_GAPS) {
    const res: GapResult = { gap, absorbed: [], stale: [], skipped: [] }
    for (const item of gap.items) {
      if (!enabled(item.check[0] ?? '')) { res.skipped.push(item); continue }
      const hits = failures.filter(
        (f) => f.check === item.check && item.where.test(f.where) && item.text.test(f.lines.join('\n')),
      )
      if (hits.length === 0) {
        res.stale.push(item)
        continue
      }
      for (const h of hits) failures.splice(failures.indexOf(h), 1)
      res.absorbed.push({ item, hits })
    }
    out.push(res)
  }
  /* 过期的豁免是错误。放在这里而不是 note 里，就是要它计入退出码。 */
  for (const r of out) {
    for (const item of r.stale) {
      fail('0 已知缺口', r.gap.id,
        `已知缺口「${item.what}」不再复现了`,
        '    豁免过期了：要么它被修好了，要么它的症状变了、名单上的匹配已经指不中。',
        `    请把这一条从 scripts/a11y-check.ts 的 KNOWN_GAPS[${r.gap.id}] 里删掉。`,
        '    留着一条永不命中的豁免，等于给这块地方永久静音——下次它真坏了没人会喊。')
    }
  }
  return out
}

function printGaps(results: GapResult[]): void {
  const shown = results.filter((r) => r.absorbed.length > 0 || r.stale.length > 0)
  if (shown.length === 0) return
  const bar = '─'.repeat(78)
  console.log('\n' + bar)
  console.log('已知缺口（已裁定不由 F1 修——但每一条都必须仍然复现，否则上面会红）')
  console.log(bar)
  for (const r of shown) {
    const total = r.absorbed.reduce((n, a) => n + a.hits.length, 0)
    console.log(`\n▣ ${r.gap.id}　${r.gap.title}`)
    console.log(`  依据：${r.gap.ref}`)
    r.gap.reason.forEach((line, i) => console.log(`  ${i === 0 ? '理由：' : '　　　'}${line}`))
    console.log(`  仍在复现 ${r.absorbed.length} 条 / ${total} 次命中：`)
    for (const a of r.absorbed) {
      const wheres = [...new Set(a.hits.map((h) => h.where))]
      console.log(`    · ${a.item.what}`)
      console.log(`      ${(a.hits[0]?.lines[0] ?? '').trim()}`)
      console.log(`      形态：${wheres.join('、')}`)
    }
    if (r.stale.length) {
      console.log(`  ✖ 已过期 ${r.stale.length} 条（见上面的失败明细）：`)
      for (const item of r.stale) console.log(`    · ${item.what}`)
    }
    if (r.skipped.length) {
      console.log(`  ○ 本次未对账 ${r.skipped.length} 条（所属检查被 --only 跳过）`)
    }
  }
}

/* 同一处问题会在十几个形态里各报一遍。原样打出来是 66 行几乎一样的文字，
   没人会去读，更没人会去修。按「抹掉元素名之后相同」归成"同型"，
   报告里每型最多展开 4 条，其余折成一行计数——具体到哪个元素仍在。 */
function shape(line: string): string {
  return line.replace(/「[^」]*」/g, '「…」').replace(/\[aria-label="[^"]*"\]/g, '')
}

function report(): number {
  const width = 78
  const bar = '─'.repeat(width)

  /* 顺序要紧：先对账，它会把名单上的失败摘出去、把过期的豁免变成新的失败，
     下面的分组统计才是最终口径。 */
  const gapResults = reconcileGaps()

  if (notes.length) {
    console.log('\n' + bar)
    console.log('提示（不计入成败，但值得看一眼）')
    console.log(bar)
    for (const n of notes) {
      console.log(`  · [${n.check}] ${n.where}`)
      for (const l of n.lines) console.log(`    ${l}`)
    }
  }

  printScenes()
  printGaps(gapResults)

  const byCheck = new Map<string, Finding[]>()
  for (const f of failures) {
    const arr = byCheck.get(f.check) ?? []
    arr.push(f)
    byCheck.set(f.check, arr)
  }

  if (failures.length) {
    console.log('\n' + bar)
    console.log('失败明细')
    console.log(bar)
    for (const [id, title] of CHECK_TITLES) {
      const arr = byCheck.get(id)
      if (!arr || !arr.length) continue

      const exact = new Map<string, { lines: string[]; wheres: string[] }>()
      for (const f of arr) {
        const k = f.lines.join('\n')
        const g = exact.get(k) ?? { lines: f.lines, wheres: [] }
        g.wheres.push(f.where)
        exact.set(k, g)
      }
      const groups = new Map<string, Array<{ lines: string[]; wheres: string[] }>>()
      for (const g of exact.values()) {
        const k = shape(g.lines[0] ?? '')
        const a = groups.get(k) ?? []
        a.push(g)
        groups.set(k, a)
      }

      console.log(`\n■ ${id}　${title}　—— ${groups.size} 类 / ${exact.size} 处 / 共 ${arr.length} 次命中`)
      for (const [, list] of groups) {
        console.log('')
        for (const g of list.slice(0, 4)) {
          console.log(`  ✖ ${g.lines[0] ?? ''}`)
          for (const l of g.lines.slice(1)) console.log(`  ${l}`)
          const uniq = [...new Set(g.wheres)]
          console.log(`      形态：${uniq.slice(0, 6).join('、')}${uniq.length > 6 ? ` 等 ${uniq.length} 个` : ''}`)
        }
        if (list.length > 4) {
          const rest = list.slice(4)
          const hits = rest.reduce((n, g) => n + g.wheres.length, 0)
          console.log(`      …以及另外 ${rest.length} 个同型元素（${hits} 次命中），下面列出它们的定位串：`)
          for (const g of rest) console.log(`        · ${(g.lines[1] ?? g.lines[0] ?? '').trim()}`)
        }
      }
    }
  }

  console.log('\n' + bar)
  console.log('无障碍与令牌回归检查')
  console.log(bar)
  for (const [k, v] of Object.entries(checkedCounters)) console.log(`  ${k}：${v}`)
  console.log('')
  let kinds = 0
  for (const [id, title] of CHECK_TITLES) {
    if (!enabled(id[0] ?? '')) { console.log(`  ○ ${id}　${title}　（本次跳过）`); continue }
    const arr = byCheck.get(id) ?? []
    const k = new Set(arr.map((f) => shape(f.lines[0] ?? ''))).size
    kinds += k
    console.log(`  ${arr.length === 0 ? '✔' : '✖'} ${id}　${title}　`
      + (arr.length === 0 ? '通过' : `${k} 类问题 / ${arr.length} 次命中`))
  }
  const absorbed = gapResults.reduce((n, r) => n + r.absorbed.reduce((m, a) => m + a.hits.length, 0), 0)
  const gapItems = gapResults.reduce((n, r) => n + r.absorbed.length, 0)
  if (absorbed > 0) {
    console.log('')
    console.log(`  另有 ${gapItems} 条已知缺口仍在复现（${absorbed} 次命中），已具名列在上面的「已知缺口」一节，`)
    console.log('  依据 spec.md §11 缺口 #2 不由 F1 修。它们没有被静音：任何一条不再复现，本门槛会红。')
  }
  console.log('')
  if (failures.length === 0) {
    console.log('  全部通过。')
    return 0
  }
  console.log(`  共 ${kinds} 类问题、${failures.length} 次命中。`)
  return 1
}

async function main(): Promise<void> {
  const tf = await readTokens()
  bump('令牌总数', tf.names.length)

  if (enabled('4')) await checkNakedValues(tf)

  const needsBrowser = ['1', '2', '3', '5'].some((k) => enabled(k))

  /* 构建产物里的裸 outline 复位也归第 4 项——它同样是"文本扫描"，
     只是扫的是打包之后的 CSS：那条规则赢没赢，只有在产物里才看得出来。 */
  const cssPath = await buildApp()
  if (enabled('4')) await checkBuiltCss(cssPath)

  if (!needsBrowser) exit(report())

  const { server, port } = await serveDist(OUT_DIR)
  BASE = `http://127.0.0.1:${port}`

  const browser: Browser = await launch()
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    deviceScaleFactor: 1,
  })
  await context.addInitScript({
    content: `window.__A11Y_TOKEN_NAMES__ = ${JSON.stringify(tf.names)};`
      + ` try { localStorage.removeItem('mde-console-theme') } catch (e) {}`,
  })
  await context.addInitScript({ path: PAGE_JS })

  const page: Page = await context.newPage()
  page.on('pageerror', (e) => fail('2 Tab 泄漏', '页面运行时', `页面抛异常，本次扫描的结论都不可信：${e.message.split('\n')[0]}`))

  try {
    if (enabled('1')) {
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await runTokenSemantics(page, theme)
        await runContrast(page, theme)
      }
      await page.emulateMedia({ colorScheme: 'light' })
    }
    if (enabled('2')) await runTabAndFocus(page, context)
    if (enabled('3')) await runLayout(page)
    if (enabled('5')) await runMedia(page, tf)
  } finally {
    await context.close()
    await browser.close()
    server.close()
  }

  exit(report())
}

await main()
