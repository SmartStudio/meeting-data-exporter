import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * 「默认路径一步都不许碰 mock」的看门测试（计划 §3.5）。
 *
 * `api/mock/` 不删——它是无后端时开发与截图的唯一手段，spec §7/§8 的五种形态
 * 本来就要能一键复现，`scripts/a11y-check.ts` 的五个场景也靠它。但**"看起来
 * 能跑、其实是假数据"是这一轮最需要防的事故**，所以谁能 import 它要有名单，
 * 而且名单只能变短不能变长。
 *
 * 名单按 a11y 门槛里 `KNOWN_GAPS` 的同一条规矩办：**用相等断言，不用包含断言**。
 * 过期的豁免是错误不是好消息——F2 把会议记录页换成真 API 之后，这份名单必须
 * 变成空的，而让它变空的唯一提醒就是这条测试在那时候变红。
 */

const SRC = resolve(process.cwd(), 'src')

/**
 * 现在还允许 import `api/mock/` 的文件（相对 `src/` 的路径）。
 *
 * **这三个都归会议记录页（F2）**：F0 的验收明写"会议记录页行为完全不变
 * （还是 mock，F0 不动它的数据来源）"，换真 API 是 F2 的事。F2 做完之后
 * 这个数组要变成 `[]`，同时把 `api/mock/` 的入口收进 `?proto=1` 之下。
 */
const MOCK_CONSUMERS_ALLOWED = [
  'pages/Meetings/index.tsx',
  'pages/Meetings/useMeetings.ts',
]

/** 这些目录属于"默认路径"，任何一个文件碰 mock 都是事故，没有豁免。 */
const MUST_BE_CLEAN = ['app/', 'ui/', 'lib/', 'api/client.ts', 'api/validate.ts', 'api/admin/']

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

/** 只看 import/export 语句里的模块说明符，注释里提到 mock 不算。 */
function importsMock(source: string): boolean {
  const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
  specifiers.push(...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''))
  return specifiers.some((s) => /(^|\/)api\/mock(\/|$)|(^|\/)mock\/(index|meetings|consumers|system)$/.test(s))
}

function mockConsumers(): string[] {
  return walk(SRC)
    .map((f) => relative(SRC, f).split('\\').join('/'))
    // `api/mock/` 自己内部当然互相 import
    .filter((rel) => !rel.startsWith('api/mock/'))
    .filter((rel) => importsMock(readFileSync(resolve(SRC, rel), 'utf-8')))
    .sort()
}

describe('api/mock 的处置：留着，但默认路径碰不到它', () => {
  test('还在 import mock 的文件与名单逐字一致（名单只能变短）', () => {
    expect(mockConsumers()).toEqual([...MOCK_CONSUMERS_ALLOWED].sort())
  })

  test('外壳 / 基元 / 请求层一个都不碰 mock —— 这几处没有豁免', () => {
    const offenders = mockConsumers().filter((rel) =>
      MUST_BE_CLEAN.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p)),
    )
    expect(offenders).toEqual([])
  })

  test('系统状态与左栏摘要读的是真实端点，不是 mock', () => {
    const status = readFileSync(resolve(SRC, 'app/SystemStatus.tsx'), 'utf-8')
    const rail = readFileSync(resolve(SRC, 'app/Rail.tsx'), 'utf-8')
    expect(status).toMatch(/from '@\/api\/admin\/health'/)
    expect(rail).toMatch(/from '@\/api\/admin\/health'/)
    expect(importsMock(status)).toBe(false)
    expect(importsMock(rail)).toBe(false)
  })
})
