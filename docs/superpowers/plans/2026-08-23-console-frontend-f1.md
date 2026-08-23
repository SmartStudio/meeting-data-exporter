# 控制台前端 F1 · 工程骨架与会议记录页 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `docs/console/prototype/gate-console.html` 这份单文件原型变成一个真的前端工程：
令牌层、浮层基座、设计系统基元、mock 数据层、布局外壳，外加**会议记录页跑通**。
产出是一份 `npm run dev` 就能操作的控制台，数据是假的，形态与交互是真的。

**Architecture:** Vite + React + TypeScript(strict)，CSS Modules + `tokens.css`。
不引状态库、不引 UI 框架、不引 Tailwind。数据层是一个 40 行的 `useResource` hook
覆盖「加载中 / 加载失败 / 数据」三态，mock 数据**按将来 API 的形状**定义而不是照抄
原型的展示字符串。**与后端阶段 1 完全并行，零依赖。**

**Tech Stack:** Vite 6 · React 19 · TypeScript strict · react-router-dom 7 ·
CSS Modules · Vitest + @testing-library/react · Playwright（仅用于回归检查脚本）

---

## Global Constraints

- **组件里不许出现裸的 px / hex / rgba / 具名颜色。** 缺值就去 `tokens.css` 加一个具名令牌。
  这是 `design-system.md` §1 的第一条硬规矩，T7 有脚本扫它。
- **`--ink-4` 是图形专用**（描边 / 分隔 / 填充）。白底上只有 3.72:1，**禁止用于文字**，
  文字梯度到 `--ink-3` 为止。
- **颜色只在 `tokens.css` 里定义**，组件永远只引用令牌名。不许把颜色写进 `@media` 或
  `[data-theme]` 块——那样在「跟随系统」状态下不会生效。
- **中文排版**：不用 uppercase、不用宽字距、不用负字距。唯一例外是等宽数字的 `-.02em`。
- **不引入半像素字号。** 字号只从 `--t-2xs` … `--t-3xl` 八级里取。
- **资产类型用 `AssetKey`**（`video` / `audio` / `transcript` / `ai_transcript` /
  `ai_minutes` / `ai_topic_minutes` / `ai_speaker_minutes` / `ai_ds_minutes`）。
  **不要把原型里的 `summary` / `aitr` / `digest` 这套短名带进代码**——同一批资产已经
  有过三套叫法，M3.5 为此吃过一次亏（`dev-plan.md` §5 C7）。
- **无障碍基线不许退**（`design-system.md` §5，原型已实测通过）：文字对比度 WCAG AA、
  焦点环可见且不做出现动画、隐藏浮层退出 Tab 序列、1440/1050/375 无横向溢出、
  输入类触控目标 ≥44px、`prefers-reduced-motion` 生效。
- **只动 `transform` 与 `opacity`**，不动布局属性做动画。三档时长 `--dur-1/2/3`、
  三个具名缓动 `--ease-out/in/in-out`，不用浏览器默认的 `ease`。
- **原型里的所有数字都是编的。** 搬 mock 数据时照搬，但不要在任何文档或界面里
  把它们当作真实统计引用。顶栏那个「原型 · 全部数字为示例」的标记要保留。

---

## 范围说明：F1 到底做到哪

`dev-plan.md` 阶段 5 原先把 F1 写成「工程骨架 + 令牌接入 + 从原型拆组件（中）」，
同一节的说明里却写着「产出是一份能用假数据跑起来的**完整前端**」。**这两句自相矛盾**，
七个页面加播放器与转写联动远不是「中」。本计划按下面这条线重新划：

| | 内容 |
| --- | --- |
| **F1 做**（本计划） | 工程骨架 · 令牌层 · 主题三态 · 浮层基座 · 设计系统基元 · mock 数据层 · 布局外壳与路由 · **会议记录页（含分诊条、表格、多选、键盘操作）** · 无障碍回归检查脚本 |
| **F1 不做** | 会议详情抽屉、内容预览页、采集授权、自动规则、定时任务、归档存储、操作审计 |

**为什么把会议记录页放进 F1**：一个只有外壳没有页面的骨架，证明不了令牌体系和组件
抽象是对的。会议记录页是密度最高的一页——表格、分诊条、多选与跨页全选、进度条、
pill、键盘操作全在里面。它跑通了，其余页面都是它的子集。

**F1 落地后，阶段 5 的后续任务顺延为**：

```
F2  会议详情抽屉 + 内容预览页      （抽屉与预览是两块独立的大件）
F3  自动规则页 + 规则编辑器
F4  采集授权页 + 接入向导
F5  定时任务 / 归档存储 / 操作审计
F6  把 mock 数据层换成真 API       ← 等后端 A2/A3/A6 就绪，一次性切换
F7  spec §11 的五个缺口
```

原先的 F2「会议记录页 + 详情抽屉」被 F1 吃掉了一半。**本计划验收后要同步改
`dev-plan.md` 阶段 5 的表格**，别让两份文档对不上。

---

## File Structure

```
console/                              ← 新增，与 client/ packages/ 并列
  package.json                        @yaowu/mde-console
  tsconfig.json                       strict + noUncheckedIndexedAccess
  vite.config.ts
  index.html
  src/
    main.tsx                          入口
    styles/
      tokens.css                      ← 104 个令牌，从 prototype/tokens.css 迁入
      base.css                        reset + 排版基线 + 焦点环 + reduced-motion
    theme/useTheme.ts                 三态主题（跟随系统 / 强制浅 / 强制深）
    lib/
      format.ts                       时间戳 → 展示串、字节 → 人类可读、天数计算
      useResource.ts                  加载中 / 加载失败 / 数据 三态
      keys.ts                         键盘操作绑定
    api/
      types.ts                        ← 按**将来 API 的形状**定义，不是原型的展示串
      mock/{meetings,consumers,rules,jobs,storage,audit,system}.ts
      mock/index.ts                   五种系统状态的切换
    ui/                               设计系统基元（与业务无关）
      Overlay.tsx  Drawer.tsx  Popover.tsx  Sheet.tsx  Toast.tsx
      Button.tsx   Input.tsx   Pill.tsx     Chip.tsx
      StatusDot.tsx ProgressBar.tsx Skeleton.tsx  Table.tsx
    app/
      AppShell.tsx  Rail.tsx  GlobalBar.tsx  SystemStatus.tsx  ShortcutBar.tsx
      routes.tsx
    pages/
      Meetings/                       会议记录页（F1 唯一实做的页面）
        index.tsx  TriageBar.tsx  MeetingTable.tsx  MeetingRow.tsx
        BatchBar.tsx  GrantPicker.tsx
      _Placeholder.tsx                其余六页的占位（标题 + 一句「F2–F5 实现」）
  tests/                              Vitest + Testing Library
  scripts/a11y-check.ts               Playwright 回归检查（对比度 / Tab / 溢出）
```

---

## 任务依赖与并行批次

```
批次 1（两路并行）
  T1  工程骨架 + 令牌 + 主题三态       console/{package.json,vite.config.ts,src/styles,src/theme}
  T2  API 形状类型 + mock 数据 + 三态 hook   console/src/{api,lib}   ← 纯 TS，不依赖构建

批次 2（三路并行，文件不重叠）
  T3  布局外壳 + 路由 + 系统状态       console/src/app/**
  T4  浮层基座（inert / Esc / 焦点）    console/src/ui/{Overlay,Drawer,Popover,Sheet,Toast}
  T5  设计系统基元                     console/src/ui/{Button,Input,Pill,Chip,StatusDot,ProgressBar,Skeleton,Table}

批次 3（单路）
  T6  会议记录页                       console/src/pages/Meetings/**   ← 依赖 T2–T5

批次 4（单路）
  T7  无障碍与令牌回归检查             console/scripts/a11y-check.ts   ← 要有真页面才能扫
```

---

## Task 1: 工程骨架 + 令牌层 + 主题三态

**Files:**
- Create: `console/package.json` · `console/tsconfig.json` · `console/vite.config.ts` · `console/index.html`
- Create: `console/src/main.tsx` · `console/src/App.tsx`
- Create: `console/src/styles/tokens.css`（从 `docs/console/prototype/tokens.css` 迁入）
- Create: `console/src/styles/base.css`
- Create: `console/src/theme/useTheme.ts`
- Create: `console/tests/theme.test.tsx`
- Modify: `package.json`（根，`workspaces` 加 `console`）

**Interfaces:**
- Produces: `useTheme(): { theme: 'system'|'light'|'dark'; setTheme(t): void }`；
  全部 104 个令牌可用；`npm run dev` / `build` / `test` / `typecheck` 四个脚本

- [ ] **Step 1: 建工程**

`console/package.json`：

```json
{
  "name": "@yaowu/mde-console",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "a11y": "bun scripts/a11y-check.ts"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

`console/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests", "scripts", "vite.config.ts"]
}
```

`console/vite.config.ts`：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5273 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: true,          // CSS Modules 的类名在测试里要能解析
  },
})
```

`console/tests/setup.ts`：`import '@testing-library/jest-dom/vitest'`

根 `package.json` 的 `workspaces` 加一项：`["client", "console", "packages/*"]`

- [ ] **Step 2: 迁入令牌层**

```bash
cp docs/console/prototype/tokens.css console/src/styles/tokens.css
```

在 `console/src/styles/tokens.css` 顶部加一段权威声明（**这一段很重要，不加两边必然分叉**）：

```css
/* 控制台设计令牌 —— 104 个。
 *
 * 权威在**本文件**。docs/console/prototype/tokens.css 与 gate-console.html 里的
 * 内联令牌块从此是历史快照，只用于回看原型，不再跟着改。
 *
 * 三条硬规矩（详见 docs/console/design-system.md §1）：
 *   1. 组件里不许出现裸的 px / hex / rgba。缺值就来这里加一个具名令牌。
 *   2. --ink-4 是图形专用（描边/分隔/填充）。白底 3.72:1，禁止用于文字。
 *   3. 颜色只在本文件定义。不许写进 @media 或 [data-theme] 块——
 *      那样在「跟随系统」状态下不生效，而那是默认状态。
 */
```

同时在 `docs/console/design-system.md` 开头那句「令牌文件：prototype/tokens.css」改成
指向 `console/src/styles/tokens.css`，并注明原型那份已是快照。

- [ ] **Step 3: 写 `base.css`**

reset + 排版基线 + 焦点环 + reduced-motion。**全部值取自令牌**：

```css
*, *::before, *::after { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  background: var(--ground);          /* 必须显式指定：宿主会在自己的主题下画底 */
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--t-md);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
/* 横向溢出用 clip 不用 hidden——hidden 会让 position: sticky 失效 */
html, body { overflow-x: clip; }
/* [hidden] 的 UA display:none 会被任何 class 级 display 盖掉 */
[hidden] { display: none !important; }
/* button 不继承页面文字色，漏写在深色模式下就是黑字压深底（实测 1.07:1） */
button, input, select, textarea { font: inherit; color: inherit; }

:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
  /* 焦点环不做出现动画——它必须在按下 Tab 的那一帧就在 */
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 4: 先写失败的主题测试**

`console/tests/theme.test.tsx`：

```tsx
import { describe, expect, test, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTheme } from '../src/theme/useTheme'

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme')
  localStorage.clear()
})

describe('useTheme', () => {
  test('默认是「跟随系统」——根元素上不打任何标记', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('system')
    // 「跟随系统」必须是**没有属性**，不是 data-theme="system"：
    // tokens.css 的暗色块选择器是 :root:not([data-theme="light"])，
    // 打上任何标记都会改变匹配。
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  test('切到深色写 data-theme="dark"，切回系统清掉属性', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setTheme('dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    act(() => result.current.setTheme('system'))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  test('选择被记住，重新挂载后仍在', () => {
    const { result, unmount } = renderHook(() => useTheme())
    act(() => result.current.setTheme('light'))
    unmount()
    const again = renderHook(() => useTheme())
    expect(again.result.current.theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  test('localStorage 不可用时不崩，退回跟随系统', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('blocked') }
    try {
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('system')
    } finally {
      Storage.prototype.getItem = orig
    }
  })
})
```

- [ ] **Step 5: 跑测试确认失败**

Run: `cd console && npm run test`
Expected: FAIL —— `Cannot find module '../src/theme/useTheme'`

- [ ] **Step 6: 实现 `useTheme`**

```ts
import { useCallback, useEffect, useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'
const KEY = 'mde-console-theme'

/** 读存储。私密窗口 / 禁用站点数据的浏览器会直接抛，不能让它炸掉整个应用。 */
function read(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch { return 'system' }
}

function apply(t: Theme): void {
  // 「跟随系统」是**移除属性**，不是写 data-theme="system"。
  // tokens.css 的暗色块是 :root:not([data-theme="light"])，任何标记都会改变匹配。
  if (t === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', t)
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setState] = useState<Theme>(read)

  useEffect(() => { apply(theme) }, [theme])

  const setTheme = useCallback((t: Theme) => {
    setState(t)
    try { t === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t) } catch { /* 存不了就只在本次会话生效 */ }
  }, [])

  return { theme, setTheme }
}
```

- [ ] **Step 7: 最小 App 验证令牌真的生效**

`console/src/App.tsx` 先渲染一块用令牌画的色板 + 主题切换按钮；`main.tsx` 挂载并
`import './styles/tokens.css'; import './styles/base.css'`。

- [ ] **Step 8: 验证**

Run: `cd console && npm install && npm run typecheck`
Expected: 干净

Run: `cd console && npm run test`
Expected: 4 tests PASS

Run: `cd console && npm run build`
Expected: 构建成功

Run: `cd console && npm run dev`，浏览器打开，切三次主题
Expected: 浅色 / 深色 / 跟随系统三态都对；开系统深色模式后「跟随系统」显示深色

- [ ] **Step 9: Commit**

```bash
git add console/ package.json docs/console/design-system.md
git commit -m "feat(console): 前端工程骨架，令牌层与三态主题"
```

---

## Task 2: API 形状的类型 + mock 数据 + 三态 hook

**Files:**
- Create: `console/src/api/types.ts`
- Create: `console/src/api/mock/{meetings,consumers,system}.ts` · `console/src/api/mock/index.ts`
- Create: `console/src/lib/format.ts` · `console/src/lib/useResource.ts`
- Create: `console/tests/{format,useResource,mock}.test.ts(x)`

**Interfaces:**
- Produces: `Meeting` / `AssetCount` / `Grant` / `Why` / `KeepWindow` / `Consumer` /
  `SystemState` 等类型；`useResource<T>(fetcher, deps)` 返回
  `{ state: 'loading'|'error'|'ready'; data?: T; error?: Error; retry(): void }`；
  `mockApi` 及五种系统状态的切换

**这一任务定下所有组件的 props 形状，先做完再动 UI。**

- [ ] **Step 1: 按 API 形状定类型——不要照抄原型的展示字符串**

原型的 mock 数据用的是**已经格式化好的展示串**：

```js
{ when:'8-21 14:00', dur:'1:52', assets:19, total:19,
  keep:{ archivedOn:'8 月 21 日', expiresOn:'9 月 20 日', daysLeft:28 } }
```

这对一份要证明形态的原型没问题，但对工程是错的：**真 API 会返回 unix 秒和数字**
（网关侧全部时间列是 `BIGINT` 存 unix 秒，见 `migrations/002_worker_queue.sql`）。
照抄展示串的话，F6 换真 API 时每个组件都要重写。

`console/src/api/types.ts`：

```ts
/** 与网关的 AssetKey 逐字一致。不要引入 summary / aitr / digest 那套短名。 */
export type AssetKey =
  | 'video' | 'audio' | 'transcript' | 'ai_transcript'
  | 'ai_minutes' | 'ai_topic_minutes' | 'ai_speaker_minutes' | 'ai_ds_minutes'

export type FetchState   = 'done' | 'running' | 'blocked' | 'none'
export type ArchiveState = 'done' | 'running' | 'failed' | 'off' | 'blocked'
export type AllowState   = 'allow' | 'deny'

/**
 * 判定理由的来源。呈现样式由它决定：
 * rule 中性 · hand 琥珀 · fail 红 · expired/wait/na 是生命周期原因，
 * 优先级高于权限原因（详见 spec.md §6.1）。
 */
export type WhyKind = 'rule' | 'hand' | 'fail' | 'expired' | 'wait' | 'na' | 'deny'
export interface Why { by: WhyKind; text: string }

export interface KeepWindow {
  /** unix 秒。归档成功的那一刻——保留窗口从这里起算，不是从会议日 */
  archivedAt: number | null
  /** unix 秒。archivedAt + keepDays，由后端算好下发 */
  expiresAt: number | null
  /** 被人工延长过几次 */
  extended: number
  /** 本地文件是否已被到期清理删掉（记录与 NAS 路径仍在） */
  filesGone: boolean
}

export interface Meeting {
  id: string
  title: string
  code: string
  /** unix 秒 */
  startAt: number
  /** 秒。endAt - startAt，后端算好下发 */
  durationSec: number
  host: string
  /** 各类资产已拿到 / 应有。null 表示该类不适用 */
  assets: Partial<Record<AssetKey, { got: number; total: number }>>
  fetch: FetchState
  archive: ArchiveState
  allow: AllowState
  /** 已授权的采集程序 id。只有 allow 且在保留期内才有意义 */
  grants: string[]
  /** 被人工改写过的阶段 */
  hand: Array<'fetch' | 'archive' | 'allow'>
  keep: KeepWindow
  nasPath: string | null
  /** 字节 */
  sizeBytes: number | null
  why: { fetch: Why; archive: Why; allow: Why }
  history: Array<{ at: number; text: string }>
}

export interface Consumer { id: string; name: string; scope: string }

/** 分诊条五格。每格可点即筛选 */
export interface Triage {
  archiveFailed: number
  expiringIn7d: number
  awaitingGrant: number
  inProgress: number
  nasOnly: number
}

/**
 * 系统状态。五种形态是规格的一部分（spec.md §7、§8），不是彩蛋——
 * 每种的告警等级和给出的操作都不一样。
 */
export type SystemState = 'ok' | 'loading' | 'load-failed' | 'empty' | 'nas-down' | 'tencent-down'
```

- [ ] **Step 2: 先写失败的 format 测试**

`console/tests/format.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { fmtDateTime, fmtDuration, fmtBytes, daysLeft, fmtDay } from '../src/lib/format'

describe('format', () => {
  test('fmtDateTime 用本地时区，不补年（同年）', () => {
    // 2026-08-21 14:00 本地
    const t = new Date(2026, 7, 21, 14, 0).getTime() / 1000
    expect(fmtDateTime(t, new Date(2026, 7, 23))).toBe('8-21 14:00')
  })
  test('fmtDateTime 跨年时补上年份', () => {
    const t = new Date(2025, 11, 31, 9, 5).getTime() / 1000
    expect(fmtDateTime(t, new Date(2026, 7, 23))).toBe('2025-12-31 09:05')
  })
  test('fmtDuration 用 时:分，不足一小时也补 0', () => {
    expect(fmtDuration(6720)).toBe('1:52')
    expect(fmtDuration(2820)).toBe('0:47')
    expect(fmtDuration(0)).toBe('0:00')
  })
  test('fmtBytes 三位有效数字，二进制单位', () => {
    expect(fmtBytes(23907140)).toBe('22.8 MB')
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(null)).toBe('—')
  })
  test('daysLeft 按自然日算，不是按 86400 秒的整除', () => {
    // 今天 23 日 23:59，到期 24 日 00:01 —— 只差 2 分钟，但那是「明天」，应当是 1 天
    const now = new Date(2026, 7, 23, 23, 59)
    const exp = new Date(2026, 7, 24, 0, 1).getTime() / 1000
    expect(daysLeft(exp, now)).toBe(1)
  })
  test('daysLeft 已过期返回 0，不返回负数', () => {
    const now = new Date(2026, 7, 23)
    expect(daysLeft(new Date(2026, 7, 20).getTime() / 1000, now)).toBe(0)
  })
  test('fmtDay 中文写法', () => {
    expect(fmtDay(new Date(2026, 7, 21).getTime() / 1000)).toBe('8 月 21 日')
  })
})
```

> `daysLeft` 那两条是重点。原型里 `daysLeft` 是写死的常数，工程里必须算——
> **按自然日算，不是 `Math.floor(差值 / 86400)`**。差一天在这个产品里等于
> 「以为还有时间，其实今晚就删」。

- [ ] **Step 3: 跑测试确认失败，然后实现 `format.ts`**

Run: `cd console && npm run test -- format`
Expected: FAIL（模块不存在）

实现全部七个函数，`daysLeft` 用**日历日差**：把两侧都归到当地零点再相减。

- [ ] **Step 4: 先写失败的 `useResource` 测试**

`console/tests/useResource.test.tsx`：覆盖四件事——

1. 初始是 `loading`
2. 成功后变 `ready` 且带 data
3. 抛错后变 `error` 且带 error，**不是静默空数组**
4. `retry()` 会重新发起，且期间回到 `loading`
5. **组件卸载后迟到的响应不写 state**（否则 React 会警告，且在页面切换频繁时会闪回旧数据）

- [ ] **Step 5: 实现 `useResource`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

export type Resource<T> =
  | { state: 'loading' }
  | { state: 'error'; error: Error }
  | { state: 'ready'; data: T }

/**
 * 三态数据 hook。spec.md §8 要求加载中 / 加载失败 / 空态各有各的出口，
 * 所以这里**不把失败折叠成空数据**——那正是「用一句『暂无数据』把三者糊在一起」。
 *
 * 刻意不引 TanStack Query：F1 阶段数据全是 mock，没有缓存、失效、重试的需求。
 * 等 F6 接真 API 时再评估——那时才知道需不需要。
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
): Resource<T> & { retry: () => void } {
  const [res, setRes] = useState<Resource<T>>({ state: 'loading' })
  const [nonce, setNonce] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    setRes({ state: 'loading' })
    fetcher()
      .then((data) => { if (alive.current) setRes({ state: 'ready', data }) })
      .catch((e: unknown) => {
        if (alive.current) setRes({ state: 'error', error: e instanceof Error ? e : new Error(String(e)) })
      })
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const retry = useCallback(() => setNonce((n) => n + 1), [])
  return { ...res, retry }
}
```

- [ ] **Step 6: 迁 mock 数据**

从 `docs/console/prototype/gate-console.html` 提取 `MEETINGS`（9 场）、`CONSUMERS`（3 个）
等常量，**转成 `types.ts` 的形状**——展示串转回时间戳与数字：

| 原型 | mock 里应当是 |
| --- | --- |
| `when:'8-21 14:00'` | `startAt: <2026-08-21 14:00 的 unix 秒>` |
| `dur:'1:52'` | `durationSec: 6720` |
| `size:'22.8 MB'` | `sizeBytes: 23907140` |
| `keep.archivedOn:'8 月 21 日'` | `keep.archivedAt: <unix 秒>` |
| `keep.daysLeft:28` | **删掉**——由 `daysLeft(expiresAt, now)` 算 |
| `assets:19, total:19` | `assets: { video:{got:1,total:1}, ai_minutes:{got:3,total:3}, … }` |
| `hist:[['08-23 14:02','…']]` | `history:[{ at:<unix 秒>, text:'…' }]` |

**mock 里的「今天」固定为 2026-08-23**，与原型一致——否则 `daysLeft` 会随真实日期漂移，
截图和测试都对不上。用一个导出的 `MOCK_NOW` 常量，页面从它取时间基准。

- [ ] **Step 7: 五种系统状态的 mock 切换**

`console/src/api/mock/index.ts` 导出 `mockApi(state: SystemState)`，按状态返回不同结果：

| state | 行为 |
| --- | --- |
| `ok` | 正常返回 9 场会议 |
| `loading` | 永不 resolve（配合骨架屏） |
| `load-failed` | reject 一个带详情的 Error |
| `empty` | 返回空数组 |
| `nas-down` | 归档失败数从 1 变 5；**受影响会议的保留窗口清零、授权撤下**（spec §7.2） |
| `tencent-down` | 会议数据照常，仅标记「拉新的受影响」 |

`nas-down` 那条是**数据层的责任，不是横幅**——spec §7.2 说「故障必须在数据里可见」。
在 mock 里就要做对，否则页面会以为只是加个横幅。

- [ ] **Step 8: 写 mock 一致性测试**

`console/tests/mock.test.ts`：

```ts
test('nas-down 时受影响会议的保留窗口清零、授权被撤下', async () => {
  const ms = await mockApi('nas-down').listMeetings()
  const broken = ms.filter((m) => m.archive === 'failed')
  expect(broken.length).toBe(5)
  for (const m of broken) {
    expect(m.keep.archivedAt).toBeNull()    // 没归档成功就不该开始计时
    expect(m.keep.expiresAt).toBeNull()
    expect(m.grants).toEqual([])            // 没归档成功的东西不该对外可见
  }
})

test('empty 与 load-failed 是两种不同的结果，不能折叠', async () => {
  await expect(mockApi('empty').listMeetings()).resolves.toEqual([])
  await expect(mockApi('load-failed').listMeetings()).rejects.toThrow()
})

test('mock 数据的资产键全部落在 AssetKey 里', async () => {
  const valid = new Set(['video','audio','transcript','ai_transcript','ai_minutes','ai_topic_minutes','ai_speaker_minutes','ai_ds_minutes'])
  for (const m of await mockApi('ok').listMeetings()) {
    for (const k of Object.keys(m.assets)) expect(valid.has(k)).toBe(true)
  }
})
```

- [ ] **Step 9: 验证**

Run: `cd console && npm run test`
Expected: 全部 PASS（format 7 + useResource 5 + mock 3 + theme 4 = 19）

Run: `cd console && npm run typecheck`
Expected: 干净

- [ ] **Step 10: Commit**

```bash
git add console/src/api console/src/lib console/tests
git commit -m "feat(console): API 形状的类型与 mock 数据层，三态 useResource"
```

---

## Task 3: 布局外壳 + 路由 + 系统状态

**Files:**
- Create: `console/src/app/{AppShell,Rail,GlobalBar,SystemStatus,ShortcutBar,routes}.tsx`
- Create: `console/src/app/*.module.css`
- Create: `console/src/pages/_Placeholder.tsx`
- Create: `console/tests/shell.test.tsx`
- Modify: `console/src/App.tsx`

**Interfaces:**
- Consumes: T1 的令牌与 `useTheme`；T2 的 `SystemState`
- Produces: `<AppShell>`；七条路由 `/meetings` `/consumers` `/rules` `/jobs` `/storage`
  `/audit` `/preview/:id`；`SystemStateContext`

- [ ] **Step 1: 先写失败的外壳测试**

```tsx
test('左栏七项都在，且当前项有 aria-current', ...)
test('点左栏切路由，内容区跟着换', ...)
test('顶栏的系统状态下拉能切到五种形态', ...)
test('顶栏保留「原型 · 全部数字为示例」标记', ...)
test('rail 宽度取自 --rail-w，不是写死的 196px', ...)   // 查计算样式引用的是 var
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd console && npm run test -- shell`

- [ ] **Step 3: 实现 `Rail`（左栏七项）**

七项与 `spec.md` §3 逐字一致：会议记录 / 采集授权 / 自动规则 / 定时任务 / 归档存储 /
操作审计；内容预览不占导航（从会议列表点标题进入）。

**全中文，不要英文行话**——这是既定的产品约束。

骨架尺寸只用令牌：

```css
.rail {
  width: var(--rail-w);
  background: var(--rail);      /* 比内容区暗一档，导航本就该退后 */
  padding: var(--s-5) var(--s-3);
}
```

- [ ] **Step 4: 实现 `GlobalBar`（顶栏）**

高度 `var(--gbar-h)`，含：产品名、全局搜索入口（⌘K，F1 只放入口不实现）、
**系统状态下拉**、主题切换、用户菜单、以及「原型 · 全部数字为示例」标记。

- [ ] **Step 5: 实现 `SystemStatus` + Context**

五种形态（`spec.md` §7、§8）通过 Context 下发给页面。**它不是调试开关，是规格的一部分**
——每种形态的告警等级与给出的操作都不同，页面必须能各自响应。

`nas-down` 时告警条上要有**「暂停到期清理」**按钮：那是唯一能阻止不可逆损失的动作，
所以它必须在告警条本身上，不能藏进设置。F1 只画按钮 + 确认弹层，不接后端。

- [ ] **Step 6: 实现 `ShortcutBar`（底部常驻快捷键条）**

`spec.md` §9 的九个键。F1 只渲染这条；键位绑定在 T6 随会议记录页一起做。

- [ ] **Step 7: 路由与占位页**

`routes.tsx` 用 `react-router-dom` 的 `createBrowserRouter`。除 `/meetings` 外六页渲染
`_Placeholder`，写明「F2–F5 实现」，**不要留空白页**——空白页在演示时看起来像坏了。

- [ ] **Step 8: 验证**

Run: `cd console && npm run test -- shell` → PASS
Run: `cd console && npm run dev` → 七项都能点开，五种系统状态能切

- [ ] **Step 9: Commit**

```bash
git add console/src/app console/src/pages/_Placeholder.tsx console/tests/shell.test.tsx console/src/App.tsx
git commit -m "feat(console): 布局外壳、七项路由与五种系统状态"
```

---

## Task 4: 浮层基座 —— inert / Esc / 焦点管理

**Files:**
- Create: `console/src/ui/{Overlay,Drawer,Popover,Sheet,Toast}.tsx` + 对应 `.module.css`
- Create: `console/tests/overlay.test.tsx`

**Interfaces:**
- Produces: `<Overlay open onClose>`（基座）；`<Drawer>` `<Popover>` `<Sheet>` `<Toast>`

**这是最容易做错的一块，所以单独一个任务。** 原型第一版有 44 个可聚焦元素藏在看不见的
浮层里仍然能 Tab 到——**其中包括登录之后仍然能 Tab 到、仍然会被读屏念出来的
「账号 / 密码 / 登录」**。

- [ ] **Step 1: 先写失败的测试**

`console/tests/overlay.test.tsx`：

```tsx
test('关闭时内部元素退出 Tab 序列', async () => {
  render(<Overlay open={false}><button>藏起来的</button></Overlay>)
  // inert 会同时移出 Tab 序列与无障碍树
  expect(screen.getByText('藏起来的').closest('[inert]')).not.toBeNull()
})

test('打开时焦点移进浮层，关闭后回到触发元素', async () => { … })
test('Esc 关闭', async () => { … })
test('Tab 在浮层内循环，不会跑到底层页面', async () => { … })
test('退场动画期间仍然是 inert——不能等动画放完才切', async () => { … })
test('Toast 例外：它不抢焦点，但也不能被 Tab 到（除非有动作按钮）', async () => { … })
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `Overlay` 基座**

关键三条，逐条写进代码注释：

```tsx
/**
 * 浮层基座。三件事必须一起做对：
 *
 * 1. **inert，不是 hidden。** opacity:0 和 transform:translateX(100%) 都**不会**
 *    把元素移出 Tab 序列或无障碍树。inert 只切交互与无障碍树、不影响绘制，
 *    所以退场动画能照常播完。React 19 支持 inert 作为布尔 prop。
 *
 *    别照搬原型里那个 MutationObserver 盯 data-show 的写法——那是给静态 HTML
 *    打的补丁。React 里浮层的开关本来就是 state，直接设属性即可。
 *
 * 2. **焦点要还回去。** 打开时记住 document.activeElement，关闭时还原。
 *    不还的话，关掉抽屉后焦点掉到 body，再按 Tab 会从页首重新开始。
 *
 * 3. **Esc 关闭要就近。** 多层浮层时只关最上面那层，用一个栈。
 */
```

- [ ] **Step 4: 在 `Drawer` / `Popover` / `Sheet` / `Toast` 上套基座**

四者的差别只在定位与进场方向，交互契约共用。`Toast` 是唯一不抢焦点的——
它有动作按钮时该按钮要可达，没有时整块不该被 Tab 到。

`Toast` 的动作按钮压在反相表面上，**颜色必须用 `--accent-invert`**：那块底跟主题
反向（浅色模式下是近黑、深色模式下是近白），用 `--brand` 在浅色下只有 2.85:1。

- [ ] **Step 5: 验证**

Run: `cd console && npm run test -- overlay` → PASS（6 tests）

- [ ] **Step 6: Commit**

```bash
git add console/src/ui console/tests/overlay.test.tsx
git commit -m "feat(console): 浮层基座，隐藏即 inert 且焦点可还原"
```

---

## Task 5: 设计系统基元

**Files:**
- Create: `console/src/ui/{Button,Input,Pill,Chip,StatusDot,ProgressBar,Skeleton,Table}.tsx` + `.module.css`
- Create: `console/tests/ui.test.tsx`

**Interfaces:**
- Produces: 八个基元组件，全部只用令牌取值

- [ ] **Step 1: 先写失败的测试**

```tsx
test('Button 三档（primary / default / quiet）都渲染，disabled 不可点', …)
test('按下反馈是 translateY(1px) 且不加过渡——按下应当是即时的', …)
test('Input 触控目标 ≥44px', …)
test('StatusDot 的四态各有可读文本，不只有颜色', …)   // 颜色不能是唯一信息载体
test('ProgressBar 有 role=progressbar 与 aria-valuenow', …)
test('Skeleton 用 transform 做动画，不动 background-position', …)
test('Table 的横向溢出裹在自己的 overflow-x 容器里，页面 body 不横滚', …)
```

> `StatusDot` 那条是无障碍的硬要求：拉取 / 归档两个圆点是**开关**（点一下重跑该阶段），
> 光靠红绿区分状态，色觉障碍用户读不出来。每个点要带 `aria-label` 与 tooltip 文本。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现八个基元**

约束逐条落地：

- 条状元素（进度条、容量条、骨架条）用 `--r-pill`，语义是「半高」而不是某个像素值
- `Skeleton` 用 `::after` + `transform` 平移，**不动 `background-position`**（非合成属性，
  每帧触发 paint）；`prefers-reduced-motion` 下 `animation: none !important`
- 按下反馈统一 `transform: translateY(1px)` 且**不加过渡**
- 所有循环动画用 CSS 写，**不用 SVG SMIL**——CSS 的 `prefers-reduced-motion` 管不了 SMIL

- [ ] **Step 4: 令牌合规自查**

Run: `grep -rnE ':\s*-?[0-9]+(\.[0-9]+)?px|#[0-9a-fA-F]{3,8}\b|rgba?\(' console/src/ui/*.module.css | grep -v "1px solid\|0px"`
Expected: 无输出（`1px` 边框宽度是唯一允许的裸值，其余一律令牌）

- [ ] **Step 5: 验证并提交**

Run: `cd console && npm run test -- ui` → PASS（7 tests）

```bash
git add console/src/ui console/tests/ui.test.tsx
git commit -m "feat(console): 设计系统基元八件"
```

---

## Task 6: 会议记录页

**Files:**
- Create: `console/src/pages/Meetings/{index,TriageBar,MeetingTable,MeetingRow,BatchBar,GrantPicker}.tsx` + `.module.css`
- Create: `console/src/lib/keys.ts`
- Create: `console/tests/meetings.test.tsx`

**Interfaces:**
- Consumes: T2 的类型与 mock、T3 的 Context、T4 的浮层、T5 的基元

- [ ] **Step 1: 先写失败的测试**

```tsx
test('分诊条五格都在，点某格即筛选', …)
test('加载中时分诊条用骨架卡而不是隐藏——隐藏会让布局跳', …)
test('空态分三种，出口各不相同', …)          // 筛没了 / 这段时间没有 / 系统里一场都没有
test('加载失败给出错误详情与重试，不是「暂无数据」', …)
test('勾表头只选本页；要选全部得再点一次，且明说总数', …)
test('归档失败的行是红的，且分诊条第一格计数与之相符', …)
test('保留进度条 hover 出现「+30 天」', …)
test('人工改写过的行有标记', …)
test('j/k 上下移动，空格选中，回车打开详情', …)
test('nas-down 时保留窗口清零、授权 pill 消失', …)
test('375px 下页面不横滚（表格自己滚）', …)
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现分诊条**

五格（`spec.md` §4.2），把「现在有什么需要处理」压成一行：

| 格 | 颜色 | 语义 |
| --- | --- | --- |
| 归档失败 | 红 | **到期会永久丢失** |
| 7 天内到期 | 琥珀 | 过期后须去 NAS 取 |
| 待授权 | 蓝 | 准许采集但没给程序 |
| 处理中 | 中性 | 拉取或归档进行中 |
| 仅存 NAS | 中性 | 本地已清理 |

三个语义色各自只有一个含义，**不要为了好看把琥珀用在别处**。

- [ ] **Step 4: 实现表格**

六列（`spec.md` §4.2）。三处要点：

1. **拉取 · 归档两个圆点即开关**，点一下重跑该阶段——不是纯展示
2. **标题是按钮**，点进内容预览（F1 里跳到占位页）
3. **已授权给**是可加可删的 pill，`+ 授权给…` 打开程序选择浮层

- [ ] **Step 5: 实现批量条与跨页全选的逃生门**

勾选后底部浮出批量条（授权 / 延长 / 重跑）。**勾表头只选本页**；要选全部得再点一次，
且明说总数——「一次点击选中 300 场并批量改授权」是这个产品里最贵的误操作。

- [ ] **Step 6: 实现键盘操作**

`console/src/lib/keys.ts`：`j`/`k` 移动、`空格` 选中、`回车` 详情、`1`/`2`/`3` 拉取/归档/授权、
`e` 延长、`p` 预览、`/` 搜索、`Esc` 关浮层。

**输入框获得焦点时不要拦截**——否则在搜索框里打 `j` 会跳行。

- [ ] **Step 7: 三种空态各给各的出口**

`spec.md` §8：筛选筛没了（给「清除筛选」）/ 这段时间没有（给「换时间范围」）/
系统里一场都没有（给「去看拉取规则」）。**用同一句「暂无数据」把三者糊在一起，
人就不知道下一步该做什么。**

- [ ] **Step 8: 验证**

Run: `cd console && npm run test -- meetings` → PASS（11 tests）
Run: `cd console && npm run dev` → 五种系统状态逐个切，肉眼确认数据层变化（不只是横幅）

- [ ] **Step 9: Commit**

```bash
git add console/src/pages/Meetings console/src/lib/keys.ts console/tests/meetings.test.tsx
git commit -m "feat(console): 会议记录页——分诊条、表格、批量与键盘操作"
```

---

## Task 7: 无障碍与令牌回归检查

**Files:**
- Create: `console/scripts/a11y-check.ts`
- Modify: `console/package.json`（`a11y` 脚本已在 T1 加好）

**Interfaces:**
- Produces: `npm run a11y` —— 非零退出即失败，可进 CI

原型阶段那些验证（对比度全页扫描、Tab 泄漏计数、三个宽度无横向溢出）是**一次性脚本**。
工程化之后必须变成能重复跑的门槛，否则下一次改样式就会悄悄退回去。

- [ ] **Step 1: 对比度扫描**

遍历页面上每个有文本的元素，取其**最近的有实底的祖先**作为背景，算 WCAG 对比度。

**颜色必须过 canvas 解析，不能正则抠 `getComputedStyle().backgroundColor`**——
现代浏览器会返回 `oklab(0.972361 …)` 这类字符串，正则抠出来的数字当成 RGB 0–255
会得到完全错误的比值（原型阶段实测抠出过 1.06 和 4.15 两个假数）：

```ts
const cx = document.createElement('canvas').getContext('2d')!
function toRgb(css: string): [number, number, number] {
  cx.fillStyle = '#000'; cx.fillStyle = css          // 非法值会保留上一次的 #000
  cx.fillRect(0, 0, 1, 1)
  const [r, g, b] = cx.getImageData(0, 0, 1, 1).data
  return [r!, g!, b!]
}
```

阈值：正文 4.5:1、大字（≥18.66px 或 ≥14px 粗体）3:1。**两种主题各扫一遍**。

- [ ] **Step 2: Tab 泄漏计数**

数「可聚焦但不可见」的元素个数。判据：`tabIndex >= 0` 或是可聚焦标签，且
`getBoundingClientRect()` 面积为 0、或祖先链上有 `opacity: 0` / `visibility: hidden` /
`display: none` 而**没有** `inert`。

Expected: **0**。原型修复前是 44。

- [ ] **Step 3: 横向溢出**

在 1440 / 1050 / 375 三个宽度下断言 `document.documentElement.scrollWidth <= clientWidth`。
表格自己的 `overflow-x` 容器不算——**页面 body 不许横滚**。

- [ ] **Step 4: 裸值扫描**

扫 `console/src/**/*.module.css`，报出裸的 px（`1px` 边框除外）、hex、`rgb()`/`rgba()`、
以及半像素字号。这条不需要浏览器，纯文本扫描。

- [ ] **Step 5: 把四项串成一个脚本，任一失败即非零退出**

输出要**指名道姓**：哪个元素、什么颜色压什么底、比值多少。只报「有 3 处失败」的脚本
没人会去修。

- [ ] **Step 6: 验证脚本真的能抓到问题**

临时把某个 `--ink-3` 的文字改成 `--ink-4`（3.72:1，不达 AA），跑一次：

Run: `cd console && npm run a11y`
Expected: **FAIL**，且明确指出是哪个元素、比值 3.72

改回去再跑：

Run: `cd console && npm run a11y`
Expected: 四项全过，退出码 0

> 这一步是在验证「检查有没有在检查」。一个改坏了还能过的门槛，就不是门槛。

- [ ] **Step 7: Commit**

```bash
git add console/scripts/a11y-check.ts console/package.json
git commit -m "feat(console): 无障碍与令牌回归检查，可重复跑"
```

---

## 完成判据

F1 算完成，当且仅当：

1. `cd console && npm run dev` 起得来，七项导航都能点开，会议记录页可操作
2. 五种系统状态逐个切都对，且 **`nas-down` 的变化体现在数据里**（保留窗口清零、
   授权撤下），不只是一条横幅
3. 三态主题（跟随系统 / 浅 / 深）都对，**默认「跟随系统」时根元素上没有任何 `data-theme` 标记**
4. `npm run test` 全绿，`npm run typecheck` 干净，`npm run build` 成功
5. `npm run a11y` 四项全过：两种主题对比度零失败 · Tab 泄漏 0 · 三个宽度无横向溢出 ·
   无裸 px/hex
6. `console/src/` 里搜不到 `summary` / `aitr` / `digest` 这套资产短名

**F1 不负责**：接任何真实 API、其余六个页面、内容预览播放器、规则编辑器、
spec §11 的五个缺口。

**F1 落地后要做的两件文档同步**：

1. `dev-plan.md` 阶段 5 的表格按本文「范围说明」改
2. `design-system.md` 开头的令牌文件指向改成 `console/src/styles/tokens.css`，
   并注明 `docs/console/prototype/tokens.css` 已是历史快照
