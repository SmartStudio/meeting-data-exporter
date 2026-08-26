import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * 「默认路径一步都不许碰 mock」的看门测试（计划 §3.5、§13.3）。
 *
 * `api/mock/` 不删——它是无后端时开发与截图的唯一手段，spec §7/§8 的形态本来
 * 就要能一键复现，`scripts/a11y-check.ts` 的场景也靠它。但**"看起来能跑、
 * 其实是假数据"是这一轮最需要防的事故**，所以谁能 import 它要有名单，
 * 而且名单只能变短不能变长。
 *
 * ## F2 之后：名单是空的
 *
 * F1 时代会议记录页直接 `import { mockApi }`，假数据离界面只隔着一个 import。
 * F2 把这件事翻过来了：**页面永远只认真 API**，原型模式换掉的是网络层
 * （`api/mock/install.ts` 拦 `fetch`）。于是
 *
 * - `MOCK_CONSUMERS_ALLOWED` 是 `[]`——没有任何组件、hook、域文件碰得到 mock；
 * - 唯一够得着它的是 `PROTO_ENTRY`（`main.tsx`）里那一行**被 `isProtoMode()`
 *   守着的动态 import**。它不是"消费者"，它就是那道门本身：动态 import 意味着
 *   默认路径下这个模块连下载都不会发生。
 *
 * 把这两件事分成两个常量而不是合成一个豁免名单，是因为它们的性质不同：
 * 名单上的每一项都是"还没来得及改"，而这一个是**设计**，它有自己的断言
 * （必须是动态的、必须在 `isProtoMode()` 里）。
 */

const SRC = resolve(process.cwd(), 'src')

/**
 * 还能 import `api/mock/` 的文件（相对 `src/`）。**F2 之后必须是空的。**
 * 想往里加一项之前先想清楚：那一页在默认路径下会显示假数据吗？
 */
const MOCK_CONSUMERS_ALLOWED: string[] = []

/** 原型模式的唯一入口。见文件头——它不是豁免，是那道门。 */
const PROTO_ENTRY = 'main.tsx'

/** 这些目录属于"默认路径"，任何一个文件碰 mock 都是事故，没有豁免。 */
const MUST_BE_CLEAN = ['app/', 'ui/', 'lib/', 'pages/', 'api/client.ts', 'api/validate.ts', 'api/admin/']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

/**
 * 只看 import/export 语句里的模块说明符，注释里提到 mock 不算。
 *
 * 第二个分支是 `mock/xxx` 这种相对写法。**它不列具体文件名**：F8 往
 * `api/mock/` 里加了六个域文件（rules / jobs / storage / audit / content …），
 * 名单式的写法当时就漏了它们——一道只认得出旧文件的门，等于对新文件敞着。
 */
function importsMock(source: string): boolean {
  const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
  specifiers.push(...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''))
  return specifiers.some((s) =>
    /(^|\/)api\/mock(\/|$)|(^|\/)mock\/[A-Za-z0-9_-]+$/.test(s),
  )
}

function mockConsumers(): string[] {
  return walk(SRC)
    .map((f) => relative(SRC, f).split('\\').join('/'))
    // `api/mock/` 自己内部当然互相 import
    .filter((rel) => !rel.startsWith('api/mock/'))
    .filter((rel) => importsMock(readFileSync(resolve(SRC, rel), 'utf-8')))
    .sort()
}

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf-8')
}

describe('api/mock 的处置：留着，但默认路径碰不到它', () => {
  test('除原型入口外，没有任何文件 import mock（名单是空的，且只能变短）', () => {
    const offenders = mockConsumers().filter((rel) => rel !== PROTO_ENTRY)
    expect(offenders).toEqual([...MOCK_CONSUMERS_ALLOWED].sort())
  })

  test('页面 / 外壳 / 基元 / 请求层一个都不碰 mock —— 这几处没有豁免', () => {
    const offenders = mockConsumers().filter((rel) =>
      MUST_BE_CLEAN.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p)),
    )
    expect(offenders).toEqual([])
  })

  test('原型入口确实存在，而且只有它一个', () => {
    expect(mockConsumers()).toEqual([PROTO_ENTRY])
  })

  test('入口是动态 import，而且被 isProtoMode() 守着', () => {
    const entry = read(PROTO_ENTRY)
    // 静态 import 会把原型数据打进默认包里
    expect(entry).not.toMatch(/^import .*from ['"][^'"]*api\/mock/m)
    expect(entry).toMatch(/import\(\s*['"][^'"]*api\/mock\/install['"]\s*\)/)
    // 守卫与 import 必须在同一段：先判断，再加载
    const guarded = /isProtoMode\(\)\s*\)\s*\{[\s\S]{0,400}?import\(\s*['"][^'"]*api\/mock\/install['"]/
    expect(entry).toMatch(guarded)
  })

  test('会议记录页那几个文件是这道门关上的地方（F1 时它们在名单上）', () => {
    for (const f of ['pages/Meetings/index.tsx', 'pages/Meetings/useMeetings.ts']) {
      expect(importsMock(read(f)), `${f} 又开始 import mock 了`).toBe(false)
    }
  })

  test('系统状态与左栏摘要读的是真实端点，不是 mock', () => {
    const status = read('app/SystemStatus.tsx')
    const rail = read('app/Rail.tsx')
    expect(status).toMatch(/from '@\/api\/admin\/health'/)
    expect(rail).toMatch(/from '@\/api\/admin\/health'/)
    expect(importsMock(status)).toBe(false)
    expect(importsMock(rail)).toBe(false)
  })
})
