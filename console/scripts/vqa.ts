#!/usr/bin/env bun
/**
 * 视觉验收量具 —— 把字号/行高分布、可点元素热区、说明段落行宽、溢出可达性
 * 量出来给人看，不判定红绿（F1 收尾 · T0）。
 *
 * ── 为什么要把这东西留在仓库里 ────────────────────────────────────
 * 这一轮视觉验收最早是用一组一次性脚本量出来的（measure.ts / reach.ts /
 * evidence.ts，跑完就扔）。`docs/console/design-system.md` §5 记着同一个
 * 教训：那张无障碍基线表曾经整列写着「✅ 已实测」，其中两行是假保证——
 * **一次性脚本量出来的「✅」会随代码一起腐烂，而它腐烂时不会有人知道。**
 * 无障碍那几项后来收进了 `a11y-check.ts`，变成能重复跑的门槛；这次视觉
 * 验收的测量部分做同一件事，收进这个文件。
 *
 * ── 它和 a11y-check.ts 的分工 ──────────────────────────────────────
 * `a11y-check.ts` 管**通过/不通过**：对比度、Tab 泄漏、横向溢出、裸值、
 * 媒体查询——都是有明确标准（WCAG、构建产物必须长什么样）的判定，失败即
 * 非零退出，能直接进 CI。
 *
 * 这个文件管**量出来给人看**：字号/行高分布、390px 下的可点元素热区、
 * 说明段落的行宽、溢出元素到底是被滚动容器吸收了还是真的够不着。这些
 * 数字背后「够不够」的标准是**设计规范**，不是协议——规范会随产品演进
 * （下一版字号标尺可能从八级变九级），把它硬编成这里的红绿判定，只会
 * 逼着人去改数字凑过关，而不是去改设计。所以本脚本只报数、正常退出，
 * 判断留给看报告的人对照 `docs/console/design-system.md`。
 *
 * ── 为什么跑在 vite build 产物上，不是 dev server ──────────────────
 * 复用 `a11y-check.ts` 同一个理由：类名生成器要换成可读的 `组件名__局部名`
 * （见 `scripts/a11y-vite.config.ts`），报告才能指名道姓，而不是说「有 30
 * 处不达标」——那种报告没人会去改。产物目录用 `node_modules/.vqa-dist`，
 * 刻意与 a11y 的 `node_modules/.a11y-dist` 错开：那边构建配置里
 * `emptyOutDir: true`，两条门槛/两个 agent 同时跑会互相清空对方的产物。
 * 这里用命令行 `--outDir` 覆盖配置里写死的目录，不改那个配置文件本身——
 * 它现在归另一个 agent 改。
 *
 * ── 为什么 waitUntil 用 domcontentloaded，不用 networkidle ─────────
 * 页面头部真的从 Google Fonts 拉字体（`index.html` 里那条 `<link>`），
 * `networkidle` 等的是「500ms 内没有新请求」，而 Web 字体这类跨域请求会
 * 不断刷新这个静默窗口，实测在本机网络下会稳定超时。改成
 * `domcontentloaded` + 显式等 `document.fonts.status === 'loaded'`
 * （带超时兜底），量的是「字体到底有没有真的换上」这件事本身，而不是被
 * 一个不相关的等待策略卡住。
 *
 * ── 用法 ────────────────────────────────────────────────────────
 *   bun scripts/vqa.ts                跑一次生产构建，再量
 *   bun scripts/vqa.ts --skip-build   复用上次的 .vqa-dist 构建产物（改
 *                                     完样式之后不要用，量的会是旧产物）
 */

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { argv, exit } from 'node:process'
import path from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SRC = path.join(ROOT, 'src')
const TOKENS_CSS = path.join(SRC, 'styles', 'tokens.css')
/** 复用 a11y 的构建配置（可读类名），产物目录用命令行覆盖——见文件头。 */
const A11Y_VITE_CONFIG = path.join(ROOT, 'scripts', 'a11y-vite.config.ts')
const REL_OUT_DIR = path.join('node_modules', '.vqa-dist')
const OUT_DIR = path.join(ROOT, REL_OUT_DIR)
const VQA_DIR = path.join(ROOT, '.vqa')
const SHOTS_DIR = path.join(VQA_DIR, 'shots')
const MEASURE_JSON = path.join(VQA_DIR, 'measure.json')

const args = argv.slice(2)
const SKIP_BUILD = args.includes('--skip-build')

/* ══════════════════════════════════════════════════════════════════
   标尺：从 tokens.css 解析，不在这里另抄一份
   ══════════════════════════════════════════════════════════════════
   量「非标」离不开一个「标」。最早的一次性脚本（measure.ts）把字号标尺、
   间距标尺各抄了一份常量数组进脚本本身——那份抄本和 tokens.css 谁改了都
   不会通知对方，标尺涨到九级、间距标尺加一档，这里就悄悄量错，还会一直
   看着像是对的。直接解析 tokens.css 的 `--t-*` / `--s-*` / `--tap-min`
   声明，标尺跟着源文件走，不会漂。
   ══════════════════════════════════════════════════════════════════ */

interface Scales {
  fontScale: number[]
  spaceScale: number[]
  tapMin: number
}

/** 把注释整块抹掉再解析。tokens.css 头部的说明文字里就出现过
 *  `var(--s-4)` 这样的例子，不剥掉注释存在解析出假值的风险。不需要像
 *  a11y-check.ts 的 stripCssComments 那样保留行号——这里不报注释里的
 *  行号，直接删掉最简单。 */
function stripCssComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}

async function readScales(): Promise<Scales> {
  const raw = stripCssComments(await readFile(TOKENS_CSS, 'utf8'))
  const grab = (re: RegExp): number[] => {
    const out = new Set<number>()
    for (const m of raw.matchAll(re)) {
      const v = m[1]
      if (v !== undefined) out.add(Number(v))
    }
    return [...out].sort((a, b) => a - b)
  }
  const fontScale = grab(/--t-[\w-]+:\s*(\d+(?:\.\d+)?)px/g)
  const spaceScale = grab(/--s-[\w-]+:\s*(\d+(?:\.\d+)?)px/g)
  const tapMinMatch = raw.match(/--tap-min:\s*(\d+(?:\.\d+)?)px/)
  if (fontScale.length === 0 || spaceScale.length === 0) {
    console.error('✖ 没能从 tokens.css 解析出字号（--t-*）或间距（--s-*）标尺。')
    console.error('  是不是令牌命名规则改了？改了的话这个脚本的解析正则要跟着改，')
    console.error('  而不是让它安静地把「标尺」解析成空数组，量出一堆假的「非标」。')
    exit(2)
  }
  return {
    fontScale,
    spaceScale,
    tapMin: tapMinMatch?.[1] !== undefined ? Number(tapMinMatch[1]) : 44,
  }
}

/* ══════════════════════════════════════════════════════════════════
   构建 + 静态服务
   ══════════════════════════════════════════════════════════════════ */

async function buildApp(): Promise<void> {
  if (!SKIP_BUILD) {
    const bin = path.join(ROOT, 'node_modules', '.bin', 'vite')
    const r = spawnSync(bin, [
      'build', '--config', A11Y_VITE_CONFIG,
      '--outDir', REL_OUT_DIR,
      '--logLevel', 'warn',
    ], { cwd: ROOT, stdio: 'inherit' })
    if (r.status !== 0) {
      console.error('\n✖ vite build 失败——先把构建修好再量。')
      exit(2)
    }
  }
  if (!existsSync(path.join(OUT_DIR, 'index.html'))) {
    console.error(`\n✖ 构建产物不存在：${OUT_DIR}。去掉 --skip-build 重跑一次。`)
    exit(2)
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/**
 * dist 的静态服务 + SPA 回退 + 登录态桩。
 *
 * `AppShell` 挂载时会真的 `fetch('/api/v1/admin/auth/me')`——`src/api/admin.ts`
 * 头部写明这条**刻意不经过** `?proto=1` 的假后端层，走真实网络请求（登录态
 * 是 httpOnly cookie，塞进业务数据那层 mock 抽象只会让两者都变形）。这台
 * 测试服务器没有后端，SPA 回退如果把这条也答成 200 的 `index.html`，
 * `fetchAdminIdentity()` 看 `res.ok` 为真就去 `res.json()`，解析 HTML 必炸，
 * `AppShell` 因此落进它的错误态——量出来的就不是页面本身的排版，是一屏
 * 「读取失败」。单独兜这一条，答一个会通过的管理员身份（做法与
 * `a11y-check.ts` 相同，这里独立实现一份，因为不许改那个文件）。
 */
function serveDist(dir: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/v1/admin/auth/me' && (req.method ?? 'GET') === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ adminId: 'vqa-harness', username: 'vqa-harness' }))
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

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('\n✖ 启动不了 Chromium。装一次即可：\n')
    console.error('      cd console && npx playwright install chromium\n')
    console.error('  Playwright 原始报错：')
    console.error('  ' + msg.split('\n').slice(0, 4).join('\n  '))
    exit(2)
  }
}

/* ══════════════════════════════════════════════════════════════════
   页面 × 视口
   ══════════════════════════════════════════════════════════════════ */

interface PageSpec {
  id: string
  route: string
  /** 页面挂载完成的等待目标。省略时用 NAV_SELECTOR（AppShell 之下的七条
   *  路由）；`/login` 不经过 AppShell（`routes.tsx` 明写：它是 `/` 的兄弟
   *  节点），没有左栏/顶栏，必须给自己的挂载标志。 */
  waitFor?: string
}

const NAV_SELECTOR = 'nav[aria-label="主导航"]'

/** 要务视觉验收清单点名的八个页面，全部 `?proto=1`（见 `routes.tsx`）。 */
const PAGES: PageSpec[] = [
  { id: 'login', route: '/login', waitFor: 'input[autocomplete="current-password"]' },
  { id: 'meetings', route: '/meetings' },
  { id: 'consumers', route: '/consumers' },
  { id: 'rules', route: '/rules' },
  { id: 'jobs', route: '/jobs' },
  { id: 'storage', route: '/storage' },
  { id: 'audit', route: '/audit' },
  { id: 'preview', route: '/preview/m1' },
]

interface Viewport { id: string; width: number; height: number }

/** 要务视觉验收清单点名的四个视口。 */
const VIEWPORTS: Viewport[] = [
  { id: '1440x900', width: 1440, height: 900 },
  { id: '1280x900', width: 1280, height: 900 },
  { id: '1024x768', width: 1024, height: 768 },
  { id: '390x844', width: 390, height: 844 },
]

let BASE = ''

async function open(page: Page, spec: PageSpec): Promise<void> {
  const url = new URL(BASE + spec.route)
  url.searchParams.set('proto', '1')
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(spec.waitFor ?? NAV_SELECTOR, { timeout: 15000 })
  // 字体就位与否单独由 waitForFonts() 在调用处轮询确认（见下）——这里只等
  // 页面骨架挂载完，不掺进字体判断，两件事分开才不会互相掩盖。
  await page.waitForTimeout(300)
}

/* ══════════════════════════════════════════════════════════════════
   字体验证 —— 用回退字形量出来的排版数字是假的
   ══════════════════════════════════════════════════════════════════
   第一版在这里只探了一次「document.fonts 里现在有什么」，不等——于是每个
   viewport context 里第一次导航（真的要连一次 Google Fonts CDN）几乎必定
   报「缺字体」，32 次里稳定报 5～6 次假警。**会喊狼来了的告警和会腐烂的
   ✅ 是同一种病**（design-system.md §5 那张表的教训）：告警不可信，两周后
   没人会去看它，它真报出「排版数字是回退字形量的」那一次也会被一起划过去。

   改成真的等之后，又踩出第二个假警来源，这个不是"等得不够久"能解决的：
   **不是每一页都用到全部三个字体族**。`--mono`（IBM Plex Mono）只在
   `GlobalBar` / `Meetings` / `Audit` / `Jobs` / `Consumers` / `Rules` /
   `Storage` / `Preview` 这些组件的样式里出现（`grep -rl "var(--mono)" src/`
   能验证），`/login` 从头到尾没有一处等宽数字——它不经过 `AppShell`，连
   `GlobalBar` 都不挂载。要求 `/login` 也把 IBM Plex Mono 摆进
   `document.fonts` 是问错了问题：浏览器压根不会为这一页发出那个字体请求，
   等多久都等不到，那不是「加载失败」，是这一页根本用不上它。

   所以现在分两步：先扫一遍这一页可见元素的 computed `font-family` 首选项，
   算出**这一页实际点名了哪几个必需字体族**（`expectedFontsOn`），再只对
   这个子集轮询 `document.fonts`，等满超时仍然缺才算真缺，并把「等了多久」
   一起记下——告警旁边摆着等待时长，看的人才分得清「这一页真的没上这个
   字体」和「这次网络恰好比预算还慢」。这样 `/login` 天然只被要求
   Archivo + Noto Sans SC，不会被一个它用不上的字体拖着报假警；哪天设计上
   给它加了等宽数字，这里不用改一行代码就会自动开始要求。 */

interface FontCheck { families: string[]; expected: string[]; missing: string[]; waitedMs: number }

/** tokens.css 头部点名的三个字体族。真正逐页要求哪几个是 `expectedFontsOn`
 *  动态判断的（见上），这里只是完整候选集。少一个都意味着某种这一页确实
 *  用到的文字在用系统回退字形渲染——量出来的字号/行高数字看着没问题，
 *  其实量的是另一套字体的度量，不能拿去和设计规范对照。 */
const REQUIRED_FONTS = ['Archivo', 'Noto Sans SC', 'IBM Plex Mono']

async function snapshotFonts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>()
    document.fonts.forEach((f) => { if (f.status === 'loaded') out.add(f.family.replace(/["']/g, '')) })
    return [...out]
  })
}

/** 这一页可见元素里，有哪几个必需字体族被当作首选（computed font-family
 *  栈的第一项）点了名。只看首选项，不看整条回退链——回退链里当然会带着
 *  别的字体族名字，那不代表这一页"要用"它。 */
async function expectedFontsOn(page: Page): Promise<string[]> {
  return page.evaluate((required: string[]) => {
    const found = new Set<string>()
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const first = cs.fontFamily.split(',')[0]?.trim().replace(/["']/g, '')
      if (first && required.includes(first)) found.add(first)
    }
    return [...found]
  }, REQUIRED_FONTS)
}

function missingOf(families: string[], expected: string[]): string[] {
  return expected.filter((need) => !families.some((f) => f.includes(need)))
}

/**
 * 只用轮询，不先等 `document.fonts.ready` 打底。
 *
 * 第一版按直觉加了那一步——`ready` 承诺"当前在下载的字体都 settle 了"，
 * 看着像个免费的起点。实测在这台机器上（这个共享工作树同时有别的 agent
 * 在跑构建/测试，系统在抢资源）它自己冷启动时卡了 **61 秒**：那个 promise
 * 不认我这边的预算，`await` 一下去就是死等，我在 `while` 循环里设的
 * `timeoutMs` 一次都没机会检查。轮询本身已经是权威信号——`document.fonts`
 * 里每个 `FontFace.status === 'loaded'` 直接反映真实状态，不需要一个先聚合
 * 一次、还可能自己卡住的信号打底。去掉它，`waitedMs` 才真的等于「我们打算
 * 等的时间」，不是「某个不受控 promise 决定等多久」。
 *
 * 光在循环体外层比较 `Date.now()` 还不够：那只在**两次 await 之间**检查
 * 预算，如果某一次 `page.evaluate()` / `page.waitForTimeout()` 本身被系统
 * 调度饿死（还是这台共享机器，别的 agent 在抢 CPU），单次调用真的观察到
 * 卡过 **147 秒**——那次卡顿整个发生在一次 await 内部，循环压根没机会检查
 * 时间，报出来的「等了 147868ms」比预算宽了十几倍，这个数字就不可信了。
 * 所以每次调用都单独套 `raceDeadline`：拿一个只依赖 Node 自己计时器、不
 * 依赖浏览器响应的挂钟兜底，谁先到算谁的——保证「等了 Xms」里的 X 不会
 * 因为浏览器卡顿而失控地超出预算，这个数字才配被人拿来做判断。
 */

/** 用 Node 自己的计时器给一个可能被系统调度拖慢的调用兜底，不依赖浏览器
 *  端及时响应。`p` 万一真的还挂着不算失败——它没法被真正取消，只是不再
 *  被这一轮等待，多余的结果会被丢弃。 */
function raceDeadline<T>(p: Promise<T>, deadline: number, fallback: T): Promise<T> {
  const remaining = Math.max(0, deadline - Date.now())
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), remaining)),
  ])
}

async function waitForFonts(page: Page, timeoutMs = 10_000, pollMs = 250): Promise<FontCheck> {
  const start = Date.now()
  const deadline = start + timeoutMs

  // 探不出「这一页该要求哪几个字体族」本身就说明浏览器这会儿不响应——
  // 拿不准的时候落到安全的一侧（`api/admin.ts` 的 `readRole` 也是这个
  // 取舍）：当成三个全要求，而不是当成"一个都不要求"悄悄放行、把这一轮
  // 卡顿伪装成什么都没发生。
  const expected = await raceDeadline(expectedFontsOn(page), deadline, REQUIRED_FONTS)

  let families = await raceDeadline(snapshotFonts(page), deadline, [] as string[])
  let missing = missingOf(families, expected)
  while (missing.length > 0 && Date.now() < deadline) {
    await raceDeadline(page.waitForTimeout(pollMs), deadline, undefined)
    families = await raceDeadline(snapshotFonts(page), deadline, families)
    missing = missingOf(families, expected)
  }
  return { families, expected, missing, waitedMs: Date.now() - start }
}

/* ══════════════════════════════════════════════════════════════════
   量具本体 —— 在浏览器里跑一遍
   ══════════════════════════════════════════════════════════════════
   写成一个独立函数传给 `page.evaluate`（不是拼字符串塞给它）：Playwright
   会把这个函数序列化后在页面里重建，所以它**不能引用任何外层变量**——
   标尺、阈值这些都通过 `args` 显式传进去，不是闭包捕获。这样 Node 侧还能
   拿到强类型的返回值，不用像最早那版脚本那样到处 `as any`。
   ══════════════════════════════════════════════════════════════════ */

interface TypographyRow {
  sel: string; tag: string; fs: number; lh: string; fw: string; ff: string
  w: number; h: number; text: string; len: number
}
interface InteractiveRow {
  /** 有效热区（含包着它的 label）的宽高——**这才是「点不点得中」的那个数**。 */
  sel: string; tag: string; w: number; h: number; x: number; y: number
  /** 元素自己的边框盒。与 w/h 不同时才有意义：原生 checkbox 恒为 13×13。 */
  ownW: number; ownH: number
  text: string; label: string
}
interface ValueGroup { key: string; count: number; samples: string[] }
interface OverflowRow {
  sel: string; over: number; reachable: boolean; scroller: string | null; text: string
}
interface ProbeResult {
  viewportWidth: number
  docScrollWidth: number
  bodyScrollWidth: number
  typography: TypographyRow[]
  offScaleFontSize: TypographyRow[]
  interactive: InteractiveRow[]
  tightTap: InteractiveRow[]
  spacingOffScale: ValueGroup[]
  radii: ValueGroup[]
  longParagraphs: TypographyRow[]
  overflow: OverflowRow[]
}
interface ProbeArgs {
  fontScale: number[]
  spaceScale: number[]
  tapMin: number
  /** 「说明段落」的取数边界，不是判定标准——见调用处注释。 */
  paraMinChars: number
  paraMaxWidth: number
}

function browserProbe(args: ProbeArgs): ProbeResult {
  const { fontScale, spaceScale, tapMin, paraMinChars, paraMaxWidth } = args
  const vw = innerWidth
  const vh = innerHeight

  const sel = (el: Element): string => {
    const parts: string[] = []
    let n: Element | null = el
    let depth = 0
    while (n && n.nodeType === 1 && depth < 4) {
      let s = n.tagName.toLowerCase()
      const cls = (typeof (n as HTMLElement).className === 'string' ? (n as HTMLElement).className : '')
        .trim().split(/\s+/).filter(Boolean)
      if (cls.length) s += '.' + cls.slice(0, 2).join('.')
      parts.unshift(s)
      n = n.parentElement
      depth++
    }
    return parts.join(' > ')
  }
  // 可见性必须连祖先一起判，**因为 opacity 不继承**。关闭态的 Sheet 是
  // `opacity:0 + pointer-events:none + transform:translateY() scale(.99)`：
  // 浮层自己被第一行挡住了，可它里面每一个子元素的 computed opacity 都是 1，
  // 于是全被量了进去——而且是连着祖先那层 scale(.99) 一起量的。
  // 实测代价：`.btn` 报出 33.8 与 34.1 两个高度，看着像「行高继承让按钮不等高」，
  // 其实 33.8 全部来自关闭态 Sheet，34.15 × 0.99 = 33.81。一个量错的数会长成
  // 一条假结论，比没有数更贵——这正是这个脚本存在的理由，不该由它自己犯。
  // `[inert]` 是这个库判「关闭态浮层」的既有写法（见 Overlay.tsx 的 tabbable 判定），
  // 照它走，不另发明一套。
  const visible = (el: Element): boolean => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
    if (el.closest('[inert]')) return false
    for (let p = el.parentElement; p; p = p.parentElement) {
      const pcs = getComputedStyle(p)
      if (pcs.display === 'none' || pcs.visibility === 'hidden' || pcs.opacity === '0') return false
    }
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const ownText = (el: Element): string => {
    let t = ''
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue ?? ''
    return t.replace(/\s+/g, ' ').trim()
  }

  // 可点元素的判定：除了原生控件/role，这个库里还有一种容易漏检的形状——
  // <details><summary> 的展开按钮（AssetPanel 的资产分组用它），补上。
  const INTERACTIVE_SEL = 'button, a[href], input, select, textarea, summary, '
    + '[role="button"], [role="tab"], [role="switch"], [role="menuitem"], '
    + '[tabindex]:not([tabindex="-1"])'
  // 间距：四边 padding、四边 margin、行列 gap。最早那版脚本漏了
  // marginRight / marginLeft——非对称外边距同样是非标间距，补齐。
  const SPACING_PROPS = [
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'rowGap', 'columnGap',
  ] as const

  const typography: TypographyRow[] = []
  const interactive: InteractiveRow[] = []
  const spacingCount = new Map<string, { n: number; s: string[] }>()
  const radiiCount = new Map<string, { n: number; s: string[] }>()
  const overflowEls: Element[] = []

  for (const el of document.querySelectorAll('*')) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()

    const text = ownText(el)
    if (text) {
      typography.push({
        sel: sel(el), tag: el.tagName.toLowerCase(),
        fs: parseFloat(cs.fontSize), lh: cs.lineHeight, fw: cs.fontWeight,
        ff: cs.fontFamily.split(',')[0]?.replace(/["']/g, '') ?? '',
        w: Math.round(r.width), h: Math.round(r.height),
        text: text.slice(0, 60), len: text.length,
      })
    }

    if (el.matches(INTERACTIVE_SEL)) {
      /* 记的是**有效热区**，不是元素自己的盒子。原生 checkbox 恒为 13×13，
         热区长在包着它的 <label> 上（点 label 就是点它，原生行为）——只量
         元素自己会把一个已经补到 44 的勾选框继续报成 13×13，让人以为没修。
         与门槛第 8 项同一套算法，两个量具对同一件事不能给两个答案。 */
      const lab = el.closest('label')
      const lb = lab ? lab.getBoundingClientRect() : r
      const r1 = (n: number): number => Math.round(n * 10) / 10
      interactive.push({
        sel: sel(el), tag: el.tagName.toLowerCase(),
        w: r1(Math.max(r.width, lb.width)), h: r1(Math.max(r.height, lb.height)),
        x: Math.round(r.x), y: Math.round(r.y),
        ownW: r1(r.width), ownH: r1(r.height),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
        label: el.getAttribute('aria-label') ?? '',
      })
    }

    for (const p of SPACING_PROPS) {
      const v = cs[p]
      if (!v || v === '0px' || v === 'normal' || v.includes('%')) continue
      const n = parseFloat(v)
      if (!isFinite(n) || n === 0 || spaceScale.includes(n)) continue
      const key = `${p}:${v}`
      const g = spacingCount.get(key) ?? { n: 0, s: [] }
      g.n++
      if (g.s.length < 3) g.s.push(sel(el))
      spacingCount.set(key, g)
    }

    const br = cs.borderRadius
    if (br && br !== '0px') {
      const g = radiiCount.get(br) ?? { n: 0, s: [] }
      g.n++
      if (g.s.length < 2) g.s.push(sel(el))
      radiiCount.set(br, g)
    }

    if (r.right > vw + 1 && r.width > 0 && r.width < 4000) overflowEls.push(el)
  }

  const offScaleFontSize = typography.filter((t) => !fontScale.includes(t.fs))
  /* 原型专用控件不计入：顶栏那个「系统状态」下拉包在 `{proto && …}` 里，
     只在原型模式渲染，而这个量具必须带 ?proto=1 才有数据可看。按结构判
     （在 protoGroup 子树里），与门槛第 8 项的豁免同一个判据。 */
  const tightTap = interactive.filter((b) =>
    b.w > 0 && b.h > 0 && (b.w < tapMin || b.h < tapMin) && !b.sel.includes('protoGroup'))
  const longParagraphs = typography.filter((t) => t.len >= paraMinChars && t.w > paraMaxWidth)

  // 溢出可达性：区分「被滚动容器吸收」（表格横向滚动，设计好的行为）与
  // 「真的够不着」（design-system.md §5 记的那个坑——只量 scrollWidth 会给
  // 「被 overflow:clip 裁掉、所以量不出来」的元素发通行证）。
  const overflow: OverflowRow[] = overflowEls.slice(0, 80).map((el) => {
    const r = el.getBoundingClientRect()
    let n: Element | null = el.parentElement
    let scroller: Element | null = null
    while (n) {
      const c = getComputedStyle(n)
      if ((c.overflowX === 'auto' || c.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) {
        scroller = n
        break
      }
      n = n.parentElement
    }
    const cx = Math.min(r.x + r.width / 2, vw - 2)
    const cy = Math.min(Math.max(r.y + r.height / 2, 2), vh - 2)
    const hit = document.elementFromPoint(cx, cy)
    const reachable = !!scroller || (!!hit && (el === hit || el.contains(hit) || hit.contains(el)))
    const scrollerSel = scroller ? sel(scroller).split(' > ').pop() ?? null : null
    return {
      sel: sel(el), over: Math.round(r.right - vw), reachable, scroller: scrollerSel,
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 32),
    }
  })

  return {
    viewportWidth: vw,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    typography, offScaleFontSize, interactive, tightTap,
    spacingOffScale: [...spacingCount.entries()].map(([key, g]) => ({ key, count: g.n, samples: g.s })),
    radii: [...radiiCount.entries()].map(([key, g]) => ({ key, count: g.n, samples: g.s })),
    longParagraphs, overflow,
  }
}

/* ══════════════════════════════════════════════════════════════════
   主流程
   ══════════════════════════════════════════════════════════════════ */

/** 「说明段落」的取数边界：own text ≥ 20 字才算「像一段说明」而不是标签/
 *  按钮文案，宽度 > 760px 才算「宽」。两个数字都只是取数用的分界线，不是
 *  判定标准——挑短了会把按钮文案也算进来，挑长了会漏掉两行的短提示。 */
const PARA_MIN_CHARS = 20
const PARA_MAX_WIDTH = 760

type RunResult = ProbeResult & { fonts: FontCheck; error?: string }

function pageOf(key: string): string {
  return key.split('@')[0] ?? key
}

/** 预热用的页面：/meetings，不是 /login。三个必需字体族里 /login 只用得上
 *  两个（拉丁 + 中文，没有等宽数字），预热选一个三个都会触发请求的页面，
 *  才能真的把 CDN 那笔账在这一次付掉，而不是留一部分给正式测量的第一页。 */
const WARMUP_SPEC: PageSpec = { id: 'meetings', route: '/meetings' }

/**
 * 每个新 viewport context 的第一次导航都要真的连一次 Google Fonts CDN——
 * Playwright 的 context 之间不共享 HTTP 缓存，但同一个 context 内的多次
 * 导航会。这笔冷启动开销只该在这里付一次：不预热的话，正式测量的 8 页
 * 循环里第一个页面会撞上下载耗时，字体告警看起来像"这一页有问题"，其实
 * 只是"这个 context 是新的"。
 *
 * 预热失败（页面打不开之类）不算这次跑失败，只记一行——它本来就不代表
 * 任何一页的真实状态，不需要拖累整体结果。
 */
/** 预热专用的字体等待预算，比正式测量的 10 秒宽得多。
 *  这一步存在的唯一理由就是替后面 8 页把 CDN 冷启动这笔账付掉——真的观察
 *  到过这台机器（共享工作树，别的 agent 在抢资源）冷启动要 40～61 秒，10
 *  秒的预算在这里会年年月月失败。给够时间，后面的正式测量才用得上一个
 *  「大概率已经缓存」的 context。90 秒是个有限的硬上限，不是「等到天荒地
 *  老」——真卡到 90 秒也不算这次跑失败，只记一行，字体清单会如实反映当时
 *  缺什么。 */
const WARMUP_FONT_BUDGET_MS = 90_000

async function warmUp(page: Page): Promise<void> {
  try {
    await open(page, WARMUP_SPEC)
    const fonts = await waitForFonts(page, WARMUP_FONT_BUDGET_MS)
    const note = fonts.missing.length
      ? `仍缺 ${fonts.missing.join('、')}`
      : '三个字体族齐了'
    console.log(`  （预热：等 ${fonts.waitedMs}ms，${note}）`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`  （预热失败，不计入结果：${msg.split('\n')[0]}）`)
  }
}

async function run(): Promise<void> {
  await buildApp()
  const { server, port } = await serveDist(OUT_DIR)
  BASE = `http://127.0.0.1:${port}`
  const browser = await launch()
  const scales = await readScales()

  await mkdir(SHOTS_DIR, { recursive: true })

  const raw: Record<string, RunResult> = {}

  for (const vp of VIEWPORTS) {
    // colorScheme 固定浅色：主题维度是 a11y-check.ts 的对比度检查在管，
    // 这里只关心字号/行高/热区这些不该随主题变化的排版数字。
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: 'light' })
    const page = await ctx.newPage()
    await warmUp(page)
    for (const spec of PAGES) {
      const key = `${spec.id}@${vp.id}`
      try {
        await open(page, spec)
        const fonts = await waitForFonts(page)
        const probe = await page.evaluate(browserProbe, {
          fontScale: scales.fontScale, spaceScale: scales.spaceScale, tapMin: scales.tapMin,
          paraMinChars: PARA_MIN_CHARS, paraMaxWidth: PARA_MAX_WIDTH,
        })
        // `timeout` 给宽一点：Playwright 的整页截图内部会自己再等一次
        // `document.fonts.ready`，这个信号在这台机器上（共享工作树，别的
        // agent 在抢 CPU）实测卡过几十秒——45s 试过一次仍不够，连续撞见过
        // 同一个 viewport context 里三个页面接连超时。这不是页面卡住，是
        // 这一刻系统在忙别的事；截图这个动作本身没有"分页面判断该不该等"
        // 的余地（不像字体检查能按页面裁剪要求哪些字体），只能把预算给够。
        await page.screenshot({ path: path.join(SHOTS_DIR, `${spec.id}-${vp.id}.png`), fullPage: true, timeout: 90_000 })
        raw[key] = { ...probe, fonts }
        console.log(
          `${key.padEnd(22)} 文字${String(probe.typography.length).padStart(4)}`
          + ` 可点${String(probe.interactive.length).padStart(3)}`
          + ` 非标字号${String(probe.offScaleFontSize.length).padStart(3)}`
          + ` 溢出${String(probe.overflow.length).padStart(3)}`
          + (fonts.missing.length ? `  ⚠ 等了${fonts.waitedMs}ms仍缺字体：${fonts.missing.join('、')}` : ''),
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`${key.padEnd(22)} ✖ 量不出来：${msg.split('\n')[0]}`)
        raw[key] = {
          viewportWidth: vp.width, docScrollWidth: 0, bodyScrollWidth: 0,
          typography: [], offScaleFontSize: [], interactive: [], tightTap: [],
          spacingOffScale: [], radii: [], longParagraphs: [], overflow: [],
          fonts: { families: [], expected: REQUIRED_FONTS, missing: REQUIRED_FONTS, waitedMs: 0 }, error: msg,
        }
      }
    }
    await ctx.close()
  }

  await browser.close()
  server.close()

  await writeFile(MEASURE_JSON, JSON.stringify(raw, null, 1))

  printSummary(raw, scales.tapMin)
}

/* ══════════════════════════════════════════════════════════════════
   终端摘要
   ══════════════════════════════════════════════════════════════════ */

function printSummary(raw: Record<string, RunResult>, tapMin: number): void {
  const bar = '─'.repeat(78)
  const entries = Object.entries(raw)
  const total = PAGES.length * VIEWPORTS.length

  console.log('\n' + '═'.repeat(78))
  console.log('YAO-DATA 控制台 · 视觉验收量具 —— 只报数，不判定')
  console.log('═'.repeat(78))

  /* ── 字体 ─────────────────────────────────────────────────────── */
  // 排除 `error` 那些：它们的 `fonts` 是异常兜底填的安全默认值（当成三个
  // 都缺），不是真的测过字体后发现缺——这一页的整条测量流程（可能是截图，
  // 可能是导航）先于字体检查失败了，字体这一项从来没被真的问过。把它们
  // 也算进「字体告警」会把两种性质完全不同的失败混进同一个桶：真缺字体
  // 和「这次没量成」。前者该让人去查字体加载，后者该让人去查别的失败原因
  // （见【量不出来的页面】），混在一起两边都会被误判。
  const fontBad = entries.filter(([, r]) => !r.error && r.fonts.missing.length > 0)
  console.log('\n' + bar)
  console.log(`【字体加载】共 ${entries.length} 次页面加载`)
  console.log(bar)
  if (fontBad.length === 0) {
    console.log(`  ✓ 每一页实际用到的必需字体族（候选：${REQUIRED_FONTS.join(' / ')}，逐页按实际渲染判断）都加载成功——下面的字号/行高数字量的是真字体，不是回退字形`)
  } else {
    console.log(`  ⚠⚠⚠ 有 ${fontBad.length} 次等满超时，这一页实际用到的字体族里仍有没加载成功的——下面量出来的排版数字可能是假的（回退字形量出来的）⚠⚠⚠`)
    for (const [k, r] of fontBad.slice(0, 15)) {
      console.log(`    ${k}  等了 ${r.fonts.waitedMs}ms 仍缺 ${r.fonts.missing.join('、')}（document.fonts 里已加载：${r.fonts.families.join(', ') || '（空）'}）`)
    }
    if (fontBad.length > 15) console.log(`    ……还有 ${fontBad.length - 15} 次未列出，见 measure.json 的 fonts 字段`)
  }

  /* ── 量不出来的页面 ───────────────────────────────────────────── */
  const errored = entries.filter(([, r]) => r.error)
  if (errored.length) {
    console.log('\n' + bar)
    console.log(`【量不出来的页面】${errored.length} 处`)
    console.log(bar)
    for (const [k, r] of errored) console.log(`  ✖ ${k}  ${r.error}`)
  }

  /* ── 非标字号 ─────────────────────────────────────────────────── */
  const fsMap = new Map<number, { n: number; pages: Set<string>; sample: TypographyRow }>()
  for (const [k, r] of entries) {
    for (const t of r.offScaleFontSize) {
      const agg = fsMap.get(t.fs) ?? { n: 0, pages: new Set<string>(), sample: t }
      agg.n++
      agg.pages.add(pageOf(k))
      fsMap.set(t.fs, agg)
    }
  }
  const fsTotal = [...fsMap.values()].reduce((a, g) => a + g.n, 0)
  console.log('\n' + bar)
  console.log(`【非标字号】${fsTotal} 处 · ${fsMap.size} 个取值不在八级标尺里`)
  console.log(bar)
  for (const [fs, g] of [...fsMap.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${fs}px × ${g.n}（${[...g.pages].join('、')}）  例：${g.sample.sel} 「${g.sample.text}」`)
  }

  /* ── 非标间距 ─────────────────────────────────────────────────── */
  const spMap = new Map<string, { n: number; pages: Set<string>; samples: string[] }>()
  for (const [k, r] of entries) {
    for (const item of r.spacingOffScale) {
      const agg = spMap.get(item.key) ?? { n: 0, pages: new Set<string>(), samples: [] as string[] }
      agg.n += item.count
      agg.pages.add(pageOf(k))
      for (const s of item.samples) if (agg.samples.length < 3) agg.samples.push(s)
      spMap.set(item.key, agg)
    }
  }
  const spSorted = [...spMap.entries()].sort((a, b) => b[1].n - a[1].n)
  const spTotal = spSorted.reduce((a, [, g]) => a + g.n, 0)
  console.log('\n' + bar)
  console.log(`【非标间距】${spMap.size} 组取值 · 共 ${spTotal} 处不在 4pt 标尺上`)
  console.log(bar)
  for (const [key, g] of spSorted.slice(0, 25)) {
    console.log(`  ${key} × ${g.n}（${[...g.pages].join('、')}）  例：${g.samples.join(' · ')}`)
  }
  if (spSorted.length > 25) console.log(`  ……还有 ${spSorted.length - 25} 组未列出，见 measure.json`)

  /* ── 每页每字号的行高种类数 ───────────────────────────────────── */
  const lhMap = new Map<string, Map<number, Set<string>>>()
  for (const [k, r] of entries) {
    const page = pageOf(k)
    let byFs = lhMap.get(page)
    if (!byFs) { byFs = new Map(); lhMap.set(page, byFs) }
    for (const t of r.typography) {
      const set = byFs.get(t.fs) ?? new Set<string>()
      set.add(t.lh)
      byFs.set(t.fs, set)
    }
  }
  console.log('\n' + bar)
  console.log('【每页每字号的行高种类数】（同一字号在同一页面上出现几种不同行高；四个视口合并统计）')
  console.log(bar)
  for (const [page, byFs] of [...lhMap.entries()].sort()) {
    for (const [fs, lhs] of [...byFs.entries()].sort((a, b) => a[0] - b[0])) {
      const mark = lhs.size > 1 ? '⚠' : ' '
      console.log(`  ${mark} ${page.padEnd(10)} ${String(fs).padStart(3)}px → ${lhs.size} 种（${[...lhs].join(', ')}）`)
    }
  }

  /* ── 390 下不足 tapMin 的可点元素 ─────────────────────────────── */
  const tapAll = entries
    .filter(([k]) => k.endsWith('@390x844'))
    .flatMap(([k, r]) => r.tightTap.map((b) => ({ ...b, page: pageOf(k) })))
  console.log('\n' + bar)
  console.log(`【390px 下不足 ${tapMin}px 的可点元素】${tapAll.length} 个（--tap-min，输入类触控目标下限）`)
  console.log(bar)
  for (const b of tapAll.slice(0, 25)) {
    const own = b.w === b.ownW && b.h === b.ownH ? '' : `（自身 ${b.ownW}×${b.ownH}）`
    console.log(`  ${b.page.padEnd(10)} ${b.w}×${b.h}${own}  ${b.sel}${b.label ? `（aria-label="${b.label}"）` : ''} 「${b.text}」`)
  }
  if (tapAll.length > 25) console.log(`  ……还有 ${tapAll.length - 25} 个未列出，见 measure.json`)

  /* ── 超过 760px 的说明段落 ────────────────────────────────────── */
  const longAll = entries.flatMap(([k, r]) => r.longParagraphs.map((t) => ({ ...t, key: k })))
  console.log('\n' + bar)
  console.log(`【超过 ${PARA_MAX_WIDTH}px 的说明段落】${longAll.length} 处（取数边界：own text ≥ ${PARA_MIN_CHARS} 字，不是判定标准）`)
  console.log(bar)
  for (const t of longAll.slice(0, 20)) {
    console.log(`  ${t.key.padEnd(22)} ${t.w}px  ${t.sel}  「${t.text}」`)
  }
  if (longAll.length > 20) console.log(`  ……还有 ${longAll.length - 20} 处未列出，见 measure.json`)

  /* ── 溢出可达性 ───────────────────────────────────────────────── */
  console.log('\n' + bar)
  console.log('【溢出可达性】区分「被滚动容器吸收」与「真的够不着」（design-system.md §5 记的坑）')
  console.log(bar)
  const clipHidden: string[] = []
  for (const [k, r] of entries) {
    const absorbed = r.overflow.filter((o) => o.reachable).length
    const unreachable = r.overflow.filter((o) => !o.reachable)
    if (r.overflow.length) {
      console.log(`  ${k.padEnd(22)} 溢出 ${r.overflow.length}（吸收 ${absorbed} / 够不着 ${unreachable.length}）`
        + `  de=${r.docScrollWidth} body=${r.bodyScrollWidth} vw=${r.viewportWidth}`)
      for (const o of unreachable.slice(0, 4)) {
        console.log(`      ✗ 超出 ${o.over}px  ${o.sel}  「${o.text}」`)
      }
    }
    // de（documentElement.scrollWidth）没超但 body 超了：clip 裁剪链把它吃掉了，
    // 只看 de 会给这类元素发通行证——design-system.md §5 那条订正记的就是这个。
    if (r.docScrollWidth <= r.viewportWidth && r.bodyScrollWidth > r.viewportWidth) {
      clipHidden.push(`${k}  de=${r.docScrollWidth}（≤视口，看着没事）但 body=${r.bodyScrollWidth}（真的溢出）`)
    }
  }
  if (clipHidden.length) {
    console.log('\n  裁剪链掩盖迹象（documentElement 说没事，body 说有事）：')
    for (const line of clipHidden) console.log(`    ⚠ ${line}`)
  }

  /* ── 产物 ─────────────────────────────────────────────────────── */
  console.log('\n' + bar)
  console.log('【产物】')
  console.log(bar)
  console.log(`  截图：console/.vqa/shots/（${total} 张，页 × 视口）`)
  console.log('  明细：console/.vqa/measure.json')
  console.log('\n' + '═'.repeat(78) + '\n')
}

run().catch((e) => {
  console.error('\n✖ vqa 跑挂了：')
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e))
  exit(1)
})
