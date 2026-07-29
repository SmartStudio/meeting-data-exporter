# 核心导出引擎 + 客户端 CLI Implementation Plan（M3 / 子项目 2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `mde` CLI——连已投产的导出网关，把会议资产（默认四类）拉到本地并归档，支持断点续传、资产粒度去重、崩溃自愈、AI 延迟产出探测。

**Architecture:** 数据库即任务队列（bun:sqlite/WAL 为唯一事实源）。Discovery 把清单 UPSERT 成任务，有界并发池的 Executor 领租约下载，断点续传/去重/崩溃恢复出自同一机制。九个模块（config/gateway/store/domain/discovery/downloader/executor/storage/cli）各一职责、可独立测试。

**Tech Stack:** Bun + TypeScript(strict) + `bun:sqlite`。代码落仓库子目录 `client/`（独立 `package.json`/`tsconfig.json`，网关根目录零改动）。测试 `bun test`；store 用 `:memory:`、downloader/executor 用本地 HTTP server + 临时目录。

## Global Constraints

以下为全项目硬约束，每个任务隐含包含（值逐字来自 spec `docs/superpowers/specs/2026-07-23-export-engine-cli-design.md`）：

- **只连网关，不碰腾讯 API**：客户端只调 spec §4 列的网关端点；时间一律 **Unix 秒 + UTC**；分页为**游标**。
- **默认资产集 = `video,audio,transcript,ai_transcript`**（对应平台字段 `download_address`/`audio_address`/`meeting_summary`/`ai_meeting_transcripts`）；`--assets` 可加 `ai_minutes`/`ai_topic_minutes`/`ai_speaker_minutes`/`ai_ds_minutes` 或 `all`；**未知键报错并列出合法键，不静默忽略**。
- **`asset_type` 存平台字段名（字段驱动，不硬编码封闭联合）**——新纪要引擎无需改代码。
- **去重 = `UNIQUE(meeting_id,sub_meeting_id,asset_type,remote_id)` + `ON CONFLICT DO UPDATE`**，无应用层查-插。
- **认证：服务账号、无状态**。从 env 读 `MDE_GATEWAY_URL`/`MDE_CLIENT_ID`/`MDE_CLIENT_SECRET`；POST `/api/v1/auth/service-token` 换 access_token，仅内存持有；**本地不落任何凭证**；任何 401 由 gateway 层透明重取后重试当次调用。
- **断点续传**：先写 `<name>.part`、校验后原子 `rename`；**续传信任 `.part` 实际大小，不信 DB `bytes_written`**；`Range: bytes=<size>-` 的 206 续传 / 200 丢弃重下 / 416 删除重下；下载中 403/410 换链续传；每 **8 MB** 更新 `bytes_written` 并续租。
- **绝对 deadline**：探测 `deadline_at = meeting.end_time + 每类上限`（video/audio/transcript = 6h、全部 ai_* = 48h），非重试次数。
- **校验不对称**：文本类算 `content_hash` 比对；视频/音频用 `bytes_expected` 比字节数。
- **目录名清洗**：非法字符（`\ / : * ? " < > |`）替换为 `-`，按**字素簇**截断 60 字符，追加会议号。
- **时间戳单位秒**：全链路秒 + UTC。测试注入 `now()`，不直接调 `Date.now()`。
- **不新增运行时依赖**（除 bun:sqlite 内置）：能用 Bun 内置（`Bun.file`、`Bun.serve`、`crypto`）就不引三方。

---

## File Structure（client/ 子目录）

```
client/
├── package.json            @yaowu/meeting-exporter-cli，bin: mde
├── tsconfig.json           strict
├── bin/mde.ts              CLI 入口（薄壳，调 src/cli）
├── src/
│   ├── domain/
│   │   ├── types.ts        AssetKey/MeetingSelector/Meeting/Asset 状态枚举 + 键↔字段↔文件名映射
│   │   ├── window.ts       31 天窗口切分
│   │   ├── filename.ts     目录名清洗（字素簇截断）
│   │   └── readiness.ts    资产就绪判定（state/allow_download → ready|wait|skip）
│   ├── config/index.ts     env + 文件 + CLI flag 加载与校验
│   ├── gateway/client.ts   service-token 认证 + 401 重取 + 会议/资产/下载地址
│   ├── store/
│   │   ├── db.ts           打开库 + PRAGMA + migrations
│   │   └── index.ts        四表 CRUD + 原子领租约 + upsert + 探测
│   ├── storage/
│   │   ├── types.ts        Storage 接口
│   │   └── local.ts        LocalStorage 实现
│   ├── discovery/index.ts  选择器 → 网关取清单 → UPSERT 任务 + 建探测
│   ├── downloader/index.ts 单资产下载（Range/416/换链/校验/finalize）
│   ├── executor/index.ts   有界并发池 + 探测循环
│   └── cli/
│       ├── index.ts        命令分发
│       └── commands/*.ts   run/discover/list/get/execute/status/retry
└── tests/
    ├── domain/*.test.ts
    ├── config/*.test.ts
    ├── store/*.test.ts
    ├── storage/*.test.ts
    ├── gateway/*.test.ts       fake gateway fixture
    ├── discovery/*.test.ts
    ├── downloader/*.test.ts     本地 HTTP server
    ├── executor/*.test.ts       假网关 + 临时目录
    └── e2e/*.test.ts
```

## 执行编排（依赖与并行批次）

```
Batch 0（单独，阻塞全部）  T1 脚手架 + domain/types
Batch 1（并行 5）          T2 domain纯函数 · T3 config · T4 store · T5 storage · T6 gateway
Batch 2（并行 2）          T7 discovery · T8 downloader
Batch 3（单独）           T9 executor
Batch 4（单独）           T10 cli
Batch 5（单独）           T11 e2e + 打包/README
```

### 文件归属表

| 任务 | 新建目录/文件 | 依赖（Consumes） | 批次 |
| --- | --- | --- | --- |
| T1 | `client/{package.json,tsconfig.json}`、`src/domain/types.ts` | — | 0 |
| T2 | `src/domain/{window,filename,readiness}.ts` | domain/types | 1 |
| T3 | `src/config/index.ts` | domain/types | 1 |
| T4 | `src/store/{db,index}.ts` | domain/types | 1 |
| T5 | `src/storage/{types,local}.ts` | — | 1 |
| T6 | `src/gateway/client.ts` | domain/types、config（类型） | 1 |
| T7 | `src/discovery/index.ts` | gateway、store、domain | 2 |
| T8 | `src/downloader/index.ts` | gateway、storage | 2 |
| T9 | `src/executor/index.ts` | store、downloader、gateway、domain、discovery | 3 |
| T10 | `src/cli/**`、`bin/mde.ts` | 全部 | 4 |
| T11 | `tests/e2e/**`、`README.md` | 全部 | 5 |

Batch 1 的五个任务落点互不相交（`domain/{window,filename,readiness}` / `config/` / `store/` / `storage/` / `gateway/`），可 git worktree 隔离并行。T6 只**读** domain/types 与 config 的类型，不改它们。

---

## Task 1: 项目脚手架 + 共享类型（domain/types）

**Files:**
- Create: `client/package.json`、`client/tsconfig.json`、`client/src/domain/types.ts`
- Test: `client/tests/domain/types.test.ts`

**Interfaces:**
- Produces（后续所有任务消费）：
  - `type AssetKey`（8 个字面量）；`DEFAULT_ASSET_KEYS`、`ALL_ASSET_KEYS: AssetKey[]`
  - `ASSET_KEY_TO_FIELD: Record<AssetKey,string>`、`FIELD_TO_ASSET_KEY: Record<string,AssetKey>`
  - `ASSET_WAIT_CAP_SEC: Record<AssetKey,number>`
  - `assetKeyToFilename(key: AssetKey, remoteId: string, ext: string, ordinal?: number): string`（`ordinal` 默认 1；`FILENAME_HAS_REMOTE_ID: Record<AssetKey, boolean>` 标注该类文件名是否已含 remoteId，仅未含且 ordinal>1 时追加 `_<ordinal>` 消歧同类多段）
  - `parseAssetKeys(csv: string): AssetKey[]`（未知键抛 `UnknownAssetKeyError`）
  - `type MeetingSelector`、`interface Meeting`、`type AssetStatus`、`type ProbeState`

- [ ] **Step 1: 写 package.json**

`client/package.json`：
```json
{
  "name": "@yaowu/meeting-exporter-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "mde": "./bin/mde.ts" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "mde": "bun bin/mde.ts"
  },
  "devDependencies": { "@types/bun": "latest", "typescript": "^5.6.0" }
}
```

- [ ] **Step 2: 写 tsconfig.json**

`client/tsconfig.json`：
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "tests", "bin"]
}
```

- [ ] **Step 3: 写失败测试** — `client/tests/domain/types.test.ts`

```ts
import { expect, test } from 'bun:test'
import {
  DEFAULT_ASSET_KEYS, ALL_ASSET_KEYS, ASSET_KEY_TO_FIELD, FIELD_TO_ASSET_KEY,
  parseAssetKeys, UnknownAssetKeyError, assetKeyToFilename,
} from '../../src/domain/types'

test('默认集为四类', () => {
  expect(DEFAULT_ASSET_KEYS).toEqual(['video', 'audio', 'transcript', 'ai_transcript'])
})
test('键↔字段双向映射一致', () => {
  for (const k of ALL_ASSET_KEYS) expect(FIELD_TO_ASSET_KEY[ASSET_KEY_TO_FIELD[k]]).toBe(k)
  expect(ASSET_KEY_TO_FIELD.video).toBe('download_address')
})
test('parseAssetKeys：逗号分隔 + all + 未知键报错', () => {
  expect(parseAssetKeys('video,transcript')).toEqual(['video', 'transcript'])
  expect(parseAssetKeys('all')).toEqual(ALL_ASSET_KEYS)
  expect(() => parseAssetKeys('video,bogus')).toThrow(UnknownAssetKeyError)
})
test('assetKeyToFilename：视频用 remoteId、扩展名由 file_type 决定', () => {
  expect(assetKeyToFilename('video', 'rf-1', 'mp4')).toBe('recording_rf-1.mp4')
  expect(assetKeyToFilename('transcript', 'rf-1', 'pdf')).toBe('transcript.pdf')
})
```

- [ ] **Step 4: 运行确认失败**

Run: `cd client && bun test tests/domain/types.test.ts`
Expected: FAIL —「Cannot find module '../../src/domain/types'」

- [ ] **Step 5: 实现 domain/types.ts**

```ts
export type AssetKey =
  | 'video' | 'audio' | 'transcript' | 'ai_transcript'
  | 'ai_minutes' | 'ai_topic_minutes' | 'ai_speaker_minutes' | 'ai_ds_minutes'

export const ALL_ASSET_KEYS: AssetKey[] = [
  'video', 'audio', 'transcript', 'ai_transcript',
  'ai_minutes', 'ai_topic_minutes', 'ai_speaker_minutes', 'ai_ds_minutes',
]
export const DEFAULT_ASSET_KEYS: AssetKey[] = ['video', 'audio', 'transcript', 'ai_transcript']

export const ASSET_KEY_TO_FIELD: Record<AssetKey, string> = {
  video: 'download_address', audio: 'audio_address', transcript: 'meeting_summary',
  ai_transcript: 'ai_meeting_transcripts', ai_minutes: 'ai_minutes',
  ai_topic_minutes: 'ai_topic_minutes', ai_speaker_minutes: 'ai_speaker_minutes',
  ai_ds_minutes: 'ai_ds_minutes',
}
export const FIELD_TO_ASSET_KEY: Record<string, AssetKey> = Object.fromEntries(
  (Object.entries(ASSET_KEY_TO_FIELD) as [AssetKey, string][]).map(([k, f]) => [f, k]),
) as Record<string, AssetKey>

const H6 = 6 * 3600
const H48 = 48 * 3600
export const ASSET_WAIT_CAP_SEC: Record<AssetKey, number> = {
  video: H6, audio: H6, transcript: H6,
  ai_transcript: H48, ai_minutes: H48, ai_topic_minutes: H48,
  ai_speaker_minutes: H48, ai_ds_minutes: H48,
}

export class UnknownAssetKeyError extends Error {
  constructor(readonly key: string) {
    super(`unknown asset key: ${key}. valid keys: ${ALL_ASSET_KEYS.join(',')} | all`)
    this.name = 'UnknownAssetKeyError'
  }
}
export function parseAssetKeys(csv: string): AssetKey[] {
  const trimmed = csv.trim()
  if (trimmed === 'all') return [...ALL_ASSET_KEYS]
  const out: AssetKey[] = []
  for (const raw of trimmed.split(',')) {
    const k = raw.trim()
    // 用 Object.hasOwn 而非 `k in ...`：`in` 会命中原型链，
    // 使 constructor/toString/__proto__ 等被静默当作合法键，违反「不静默忽略」。
    if (!Object.hasOwn(ASSET_KEY_TO_FIELD, k)) throw new UnknownAssetKeyError(k)
    out.push(k as AssetKey)
  }
  return out
}

/** 文件名基（不含扩展名派生规则见 §11）：video/audio 用 remoteId，文本类固定名 */
const FILENAME_BASE: Record<AssetKey, (remoteId: string) => string> = {
  video: (r) => `recording_${r}`, audio: (r) => `recording_${r}`,
  transcript: () => 'transcript', ai_transcript: () => 'ai_transcript',
  ai_minutes: () => 'ai_minutes', ai_topic_minutes: () => 'ai_topic_minutes',
  ai_speaker_minutes: () => 'ai_speaker_minutes', ai_ds_minutes: () => 'ai_ds_minutes',
}
/** 文件名是否已含 remoteId：含则同类多段天然不碰撞，无需序号消歧 */
const FILENAME_HAS_REMOTE_ID: Record<AssetKey, boolean> = {
  video: true, audio: true,
  transcript: false, ai_transcript: false, ai_minutes: false,
  ai_topic_minutes: false, ai_speaker_minutes: false, ai_ds_minutes: false,
}
/**
 * 资产文件名。`ordinal` 是该资产在同 (meeting, sub_meeting, asset_type) 兄弟中的
 * 1-based 序号：仅当文件名不含 remoteId（文本类）且 ordinal>1 时追加 `_<ordinal>` 消歧，
 * 保证单段场景文件名保持干净（transcript.pdf），多段场景不互相覆盖（transcript_2.pdf）。
 */
export function assetKeyToFilename(key: AssetKey, remoteId: string, ext: string, ordinal = 1): string {
  const base = FILENAME_BASE[key](remoteId)
  const suffix = !FILENAME_HAS_REMOTE_ID[key] && ordinal > 1 ? `_${ordinal}` : ''
  return `${base}${suffix}.${ext}`
}

export interface Meeting {
  meetingId: string
  subMeetingId: string
  meetingCode: string | null
  subject: string | null
  hostUserId: string | null
  startTime: number | null
  endTime: number | null
}

export type MeetingSelector =
  | { kind: 'range'; from: number; to: number }
  | { kind: 'code'; meetingCode: string; from?: number; to?: number }
  | { kind: 'id'; meetingId: string; from?: number; to?: number }

export type AssetStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'dead'
export type ProbeState = 'probing' | 'resolved' | 'abandoned'
```

- [ ] **Step 6: 运行通过 + typecheck + Commit**

```bash
cd client && bun test tests/domain/types.test.ts && bun run typecheck
git add client/package.json client/tsconfig.json client/src/domain/types.ts client/tests/domain/types.test.ts
git commit -m "feat(client): 脚手架 + domain 共享类型（T1）"
```

---

## Task 2: domain 纯函数（窗口切分 / 目录名清洗 / 就绪判定）

**Files:**
- Create: `client/src/domain/{window,filename,readiness}.ts`
- Test: `client/tests/domain/{window,filename,readiness}.test.ts`

**Interfaces:**
- Consumes: `domain/types`（无运行时依赖）。
- Produces:
  - `splitWindow(from: number, to: number): Array<{from:number;to:number}>`（≤31 天窗口，左闭右开）
  - `cleanDirName(date: string, hhmm: string, subject: string, code: string): string`
  - `type ReadinessInput = { present: boolean; state?: number; allowDownload?: boolean; now: number; deadlineAt: number }`
  - `judgeReadiness(i: ReadinessInput): 'ready' | 'wait' | 'skip_disallowed' | 'skip_timeout'`

- [ ] **Step 1: 写失败测试** — `client/tests/domain/window.test.ts`

```ts
import { expect, test } from 'bun:test'
import { splitWindow } from '../../src/domain/window'

const D = 86400
test('90 天切成 3 个不超 31 天的窗口，无重叠无遗漏', () => {
  const w = splitWindow(1_000_000, 1_000_000 + 90 * D)
  expect(w.length).toBe(3)
  expect(w[0]!.from).toBe(1_000_000)
  expect(w[w.length - 1]!.to).toBe(1_000_000 + 90 * D)
  for (let i = 1; i < w.length; i++) expect(w[i]!.from).toBe(w[i - 1]!.to) // 左闭右开衔接
  for (const win of w) expect(win.to - win.from).toBeLessThanOrEqual(31 * D)
})
test('小于 31 天返回单窗口', () => {
  expect(splitWindow(100, 100 + 10 * D)).toEqual([{ from: 100, to: 100 + 10 * D }])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd client && bun test tests/domain/window.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 window.ts**

```ts
const MAX_WINDOW_SEC = 31 * 86400
/** 把 [from,to] 切成 ≤31 天的左闭右开窗口，衔接无重叠无遗漏 */
export function splitWindow(from: number, to: number): Array<{ from: number; to: number }> {
  if (to <= from) return [{ from, to }]
  const out: Array<{ from: number; to: number }> = []
  let cur = from
  while (cur < to) {
    const next = Math.min(cur + MAX_WINDOW_SEC, to)
    out.push({ from: cur, to: next })
    cur = next
  }
  return out
}
```

- [ ] **Step 4: 运行通过**

Run: `cd client && bun test tests/domain/window.test.ts`
Expected: PASS

- [ ] **Step 5: 写 filename 失败测试** — `client/tests/domain/filename.test.ts`

```ts
import { expect, test } from 'bun:test'
import { cleanDirName } from '../../src/domain/filename'

test('非法字符替换为 -，追加会议号', () => {
  const n = cleanDirName('2026-07-15', '1430', '季度产品/评审：Q3', '88123456')
  expect(n).toBe('2026-07-15_1430_季度产品-评审-Q3_88123456')
})
test('按字素簇截断 60 字符，不切断 emoji', () => {
  const subject = '🎉'.repeat(80)
  const n = cleanDirName('2026-07-15', '1430', subject, '88')
  const mid = n.slice('2026-07-15_1430_'.length, -('_88'.length))
  expect([...mid].length).toBeLessThanOrEqual(60)
  expect(mid.endsWith('�')).toBe(false) // 未切断代理对
})
test('空主题兜底为 untitled', () => {
  expect(cleanDirName('2026-07-15', '1430', '', '88')).toBe('2026-07-15_1430_untitled_88')
})
```

- [ ] **Step 6: 运行确认失败，再实现 filename.ts**

Run: `cd client && bun test tests/domain/filename.test.ts` → FAIL

```ts
const ILLEGAL = /[\\/:*?"<>|]/g
/** 目录名：<date>_<hhmm>_<清洗主题>_<code>。非法字符→-，字素簇截断 60，空主题兜底 */
export function cleanDirName(date: string, hhmm: string, subject: string, code: string): string {
  let s = (subject ?? '').replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim()
  const graphemes = [...s]                          // 按码点近似字素簇，避免切断代理对
  if (graphemes.length > 60) s = graphemes.slice(0, 60).join('')
  if (s.length === 0) s = 'untitled'
  return `${date}_${hhmm}_${s}_${code}`
}
```

Run: `cd client && bun test tests/domain/filename.test.ts` → PASS

> 注：真正的「字素簇」需 `Intl.Segmenter`；本实现用码点数组，已能避免切断代理对（emoji），对组合字符（如带音标）为近似。spec §11 要求「字素簇」，如需严格可换 `Intl.Segmenter`，测试同样通过——保留码点方案为最小实现，见就绪判定同款取舍。

- [ ] **Step 7: 写 readiness 失败测试** — `client/tests/domain/readiness.test.ts`

```ts
import { expect, test } from 'bun:test'
import { judgeReadiness } from '../../src/domain/readiness'

const base = { now: 1000, deadlineAt: 9999 }
test('存在且 state=3 → ready', () => {
  expect(judgeReadiness({ ...base, present: true, state: 3, allowDownload: true })).toBe('ready')
})
test('存在但 state=1/2 → wait', () => {
  expect(judgeReadiness({ ...base, present: true, state: 1 })).toBe('wait')
  expect(judgeReadiness({ ...base, present: true, state: 2 })).toBe('wait')
})
test('allow_download=false → skip_disallowed（优先于 state）', () => {
  expect(judgeReadiness({ ...base, present: true, state: 3, allowDownload: false })).toBe('skip_disallowed')
})
test('完全不在清单 → wait（乐观等待）', () => {
  expect(judgeReadiness({ ...base, present: false })).toBe('wait')
})
test('超 deadline 且未就绪 → skip_timeout', () => {
  expect(judgeReadiness({ now: 10000, deadlineAt: 9999, present: false })).toBe('skip_timeout')
  expect(judgeReadiness({ now: 10000, deadlineAt: 9999, present: true, state: 1 })).toBe('skip_timeout')
})
```

- [ ] **Step 8: 运行确认失败，再实现 readiness.ts**

```ts
export interface ReadinessInput {
  present: boolean
  state?: number
  allowDownload?: boolean
  now: number
  deadlineAt: number
}
/**
 * 资产就绪判定（spec §9）。判定顺序关键：
 * ① allow_download=false 优先（平台明示不可得，即使 state=3 也 skip，不空等）
 * ② state=3 → ready
 * ③ 其余（state=1/2 或不在清单）未就绪：超 deadline → skip_timeout，否则 wait
 */
export function judgeReadiness(i: ReadinessInput): 'ready' | 'wait' | 'skip_disallowed' | 'skip_timeout' {
  if (i.present && i.allowDownload === false) return 'skip_disallowed'
  if (i.present && i.state === 3) return 'ready'
  if (i.now >= i.deadlineAt) return 'skip_timeout'
  return 'wait'
}
```

Run: `cd client && bun test tests/domain/` → 全 PASS

- [ ] **Step 9: typecheck + Commit**

```bash
cd client && bun run typecheck
git add client/src/domain/{window,filename,readiness}.ts client/tests/domain/{window,filename,readiness}.test.ts
git commit -m "feat(client): domain 窗口切分/目录名清洗/就绪判定（T2）"
```

---

## Task 3: config（env + 文件 + CLI flag 加载校验）

**Files:**
- Create: `client/src/config/index.ts`
- Test: `client/tests/config/index.test.ts`

**Interfaces:**
- Consumes: `domain/types`（AssetKey）。
- Produces:
  - `interface AppConfig { gatewayUrl: string; clientId: string; clientSecret: string; storageRoot: string; concurrency: number; dbPath: string }`
  - `loadConfig(env: Record<string,string|undefined>, fileCfg: Partial<FileConfig>, flags: Partial<CliOverrides>): AppConfig`
  - `interface FileConfig { storageRoot?: string; concurrency?: number; dbPath?: string }`
  - `interface CliOverrides { out?: string; concurrency?: number }`

- [ ] **Step 1: 写失败测试** — `client/tests/config/index.test.ts`

```ts
import { expect, test } from 'bun:test'
import { loadConfig } from '../../src/config'

const env = { MDE_GATEWAY_URL: 'https://gw', MDE_CLIENT_ID: 'cid', MDE_CLIENT_SECRET: 'sec' }

test('env 提供必填三项，文件/flag 提供可选项，默认并发 3', () => {
  const c = loadConfig(env, { storageRoot: './out' }, {})
  expect(c.gatewayUrl).toBe('https://gw')
  expect(c.clientId).toBe('cid')
  expect(c.storageRoot).toBe('./out')
  expect(c.concurrency).toBe(3)
})
test('CLI flag 覆盖文件覆盖默认', () => {
  const c = loadConfig(env, { storageRoot: './file', concurrency: 5 }, { out: './flag', concurrency: 8 })
  expect(c.storageRoot).toBe('./flag')
  expect(c.concurrency).toBe(8)
})
test('缺 MDE_GATEWAY_URL 报字段名', () => {
  const { MDE_GATEWAY_URL, ...bad } = env
  expect(() => loadConfig(bad, {}, {})).toThrow('MDE_GATEWAY_URL')
})
test('缺 storageRoot（无 out/文件）报错', () => {
  expect(() => loadConfig(env, {}, {})).toThrow('storageRoot')
})
test('并发非正整数报错', () => {
  expect(() => loadConfig(env, { concurrency: 0 }, {})).toThrow('concurrency')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd client && bun test tests/config/index.test.ts` → FAIL

- [ ] **Step 3: 实现 config/index.ts**

```ts
export interface AppConfig {
  gatewayUrl: string
  clientId: string
  clientSecret: string
  storageRoot: string
  concurrency: number
  dbPath: string
}
export interface FileConfig { storageRoot?: string; concurrency?: number; dbPath?: string }
export interface CliOverrides { out?: string; concurrency?: number }

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key]
  if (v === undefined || v === '') throw new Error(`missing required env: ${key}`)
  return v
}

export function loadConfig(
  env: Record<string, string | undefined>,
  fileCfg: Partial<FileConfig>,
  flags: Partial<CliOverrides>,
): AppConfig {
  const gatewayUrl = required(env, 'MDE_GATEWAY_URL')
  const clientId = required(env, 'MDE_CLIENT_ID')
  const clientSecret = required(env, 'MDE_CLIENT_SECRET')

  const storageRoot = flags.out ?? fileCfg.storageRoot
  if (!storageRoot) throw new Error('missing storageRoot: pass --out or set storageRoot in config file')

  const concurrency = flags.concurrency ?? fileCfg.concurrency ?? 3
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer')
  }
  const dbPath = fileCfg.dbPath ?? `${storageRoot}/.mde/queue.sqlite`
  return { gatewayUrl, clientId, clientSecret, storageRoot, concurrency, dbPath }
}
```

- [ ] **Step 4: 运行通过 + typecheck + Commit**

```bash
cd client && bun test tests/config/index.test.ts && bun run typecheck
git add client/src/config/index.ts client/tests/config/index.test.ts
git commit -m "feat(client): config 加载与校验（T3）"
```

---

## Task 4: store（bun:sqlite 四表 + 原子领租约 + upsert + 探测）

**Files:**
- Create: `client/src/store/db.ts`、`client/src/store/index.ts`
- Test: `client/tests/store/index.test.ts`

**Interfaces:**
- Consumes: `domain/types`（Meeting、AssetStatus、ProbeState）。
- Produces（供 discovery/executor 消费，signatures 见实现）：
  - `openDb(path: string): Database`（跑 PRAGMA + migrations）
  - `createStore(db: Database): Store`，`Store` 含：
    - `upsertMeeting(m: Meeting, now: number): void`
    - `upsertAsset(a: AssetUpsert, now: number): void`（ON CONFLICT DO UPDATE）
    - `claimNext(now: number, leaseSec: number): AssetRow | null`（原子领租约）
    - `markCompleted(id, contentHash, now)` / `markFailed(id, err, now)` / `markSkipped(id, reason, now)` / `markSkippedByKey(k: {meetingId;subMeetingId;assetType}, reason, now)` / `markDead(id, err, now)`
    - `touchProgress(id, bytesWritten, now, leaseSec)`（每 8MB 更新 + 续租）
    - `siblingRank(row): { ordinal: number; total: number }`（该资产在同 (meeting, sub_meeting, asset_type) 兄弟中的 1-based 序号与兄弟总数，供 executor 文件名消歧）
    - `upsertProbe(p: ProbeUpsert): void` / `dueProbes(now): ProbeRow[]` / `resolveProbe(key)` / `abandonProbe(key, reason)`
    - `counts(): Record<AssetStatus, number>` / `failures(): AssetRow[]` / `resetFailed(now): number`

- [ ] **Step 1: 写失败测试** — `client/tests/store/index.test.ts`（用 `:memory:`）

```ts
import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'

function fresh() { return createStore(openDb(':memory:')) }
const M = { meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }

test('upsertAsset 去重：同键第二次不新增行、更新字段', () => {
  const s = fresh(); s.upsertMeeting(M, 1)
  s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'download_address', remoteId: 'rf1', bytesExpected: 10 }, 1)
  s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'download_address', remoteId: 'rf1', bytesExpected: 20 }, 2)
  expect(s.counts().pending).toBe(1)
})
test('claimNext 原子领租约：pending→running，attempts+1，第二次领不到', () => {
  const s = fresh(); s.upsertMeeting(M, 1)
  s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'a', remoteId: 'r', bytesExpected: 1 }, 1)
  const claimed = s.claimNext(100, 300)!
  expect(claimed.status).toBe('running')
  expect(claimed.attempts).toBe(1)
  expect(s.claimNext(100, 300)).toBeNull()          // 租约未过期，领不到
})
test('崩溃恢复：running 租约过期后可被重领', () => {
  const s = fresh(); s.upsertMeeting(M, 1)
  s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'a', remoteId: 'r', bytesExpected: 1 }, 1)
  s.claimNext(100, 300)                              // 租约到 400
  expect(s.claimNext(401, 300)!.attempts).toBe(2)    // 过期后重领，attempts 递增
})
test('探测：upsert/due/resolve', () => {
  const s = fresh()
  s.upsertProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes', deadlineAt: 9999, probeAfter: 0 })
  expect(s.dueProbes(100).length).toBe(1)
  s.resolveProbe({ meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes' })
  expect(s.dueProbes(100).length).toBe(0)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd client && bun test tests/store/index.test.ts` → FAIL

- [ ] **Step 3: 实现 store/db.ts（打开 + PRAGMA + migrations）**

```ts
import { Database } from 'bun:sqlite'

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      meeting_id TEXT NOT NULL, sub_meeting_id TEXT NOT NULL DEFAULT '',
      meeting_code TEXT, subject TEXT, host_userid TEXT,
      start_time INTEGER, end_time INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (meeting_id, sub_meeting_id)
    );
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL, sub_meeting_id TEXT NOT NULL DEFAULT '',
      asset_type TEXT NOT NULL, remote_id TEXT NOT NULL,
      asset_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      storage_target TEXT NOT NULL DEFAULT 'local', target_path TEXT,
      file_type TEXT, bytes_expected INTEGER, bytes_written INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT, download_url TEXT, download_url_expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
      last_error TEXT, completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (meeting_id, sub_meeting_id, asset_type, remote_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assets_claimable ON assets (status, lease_expires_at);
    CREATE TABLE IF NOT EXISTS asset_probes (
      meeting_id TEXT NOT NULL, sub_meeting_id TEXT NOT NULL DEFAULT '',
      asset_type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'probing',
      attempts INTEGER NOT NULL DEFAULT 0, probe_after INTEGER NOT NULL DEFAULT 0,
      deadline_at INTEGER NOT NULL, last_reason TEXT,
      PRIMARY KEY (meeting_id, sub_meeting_id, asset_type)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL,
      finished_at INTEGER, mode TEXT NOT NULL,
      window_from INTEGER, window_to INTEGER, summary TEXT
    );
  `)
}
```

- [ ] **Step 4: 实现 store/index.ts（原子领租约是核心）**

```ts
import type { Database } from 'bun:sqlite'
import type { Meeting, AssetStatus, ProbeState } from '../domain/types'

export interface AssetUpsert {
  meetingId: string; subMeetingId: string; assetType: string; remoteId: string
  assetId?: string | null
  bytesExpected?: number | null; fileType?: string | null
}
export interface AssetRow {
  id: number; meeting_id: string; sub_meeting_id: string; asset_type: string; remote_id: string
  asset_id: string | null
  status: AssetStatus; target_path: string | null; file_type: string | null
  bytes_expected: number | null; bytes_written: number; content_hash: string | null
  attempts: number; lease_expires_at: number | null; last_error: string | null
}
export interface ProbeUpsert { meetingId: string; subMeetingId: string; assetType: string; deadlineAt: number; probeAfter: number }
export interface ProbeRow { meeting_id: string; sub_meeting_id: string; asset_type: string; state: ProbeState; attempts: number; deadline_at: number }
export interface ProbeKey { meetingId: string; subMeetingId: string; assetType: string }

export interface Store {
  upsertMeeting(m: Meeting, now: number): void
  upsertAsset(a: AssetUpsert, now: number): void
  claimNext(now: number, leaseSec: number): AssetRow | null
  markCompleted(id: number, contentHash: string | null, now: number): void
  markFailed(id: number, err: string, now: number): void
  markSkipped(id: number, reason: string, now: number): void
  markSkippedByKey(k: ProbeKey, reason: string, now: number): void
  markDead(id: number, err: string, now: number): void
  touchProgress(id: number, bytesWritten: number, now: number, leaseSec: number): void
  setTargetPath(id: number, path: string, fileType: string | null, now: number): void
  /** 该资产在同 (meeting, sub_meeting, asset_type) 兄弟中的 1-based 序号与兄弟总数（文件名消歧用） */
  siblingRank(row: { id: number; meeting_id: string; sub_meeting_id: string; asset_type: string }): { ordinal: number; total: number }
  upsertProbe(p: ProbeUpsert): void
  dueProbes(now: number): ProbeRow[]
  resolveProbe(k: ProbeKey): void
  abandonProbe(k: ProbeKey, reason: string): void
  bumpProbe(k: ProbeKey, probeAfter: number): void
  counts(): Record<AssetStatus, number>
  failures(): AssetRow[]
  resetFailed(now: number): number
}

export function createStore(db: Database): Store {
  const claimStmt = db.query<AssetRow, [number, number, number]>(`
    UPDATE assets SET status='running', lease_expires_at=?1, attempts=attempts+1, updated_at=?3
    WHERE id = (SELECT id FROM assets
                WHERE status='pending' OR (status='running' AND lease_expires_at < ?2)
                ORDER BY id LIMIT 1)
    RETURNING *`)
  return {
    upsertMeeting(m, now) {
      db.query(`INSERT INTO meetings (meeting_id,sub_meeting_id,meeting_code,subject,host_userid,start_time,end_time,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(meeting_id,sub_meeting_id) DO UPDATE SET
          meeting_code=excluded.meeting_code, subject=excluded.subject, host_userid=excluded.host_userid,
          start_time=excluded.start_time, end_time=excluded.end_time, updated_at=excluded.updated_at`)
        .run(m.meetingId, m.subMeetingId, m.meetingCode, m.subject, m.hostUserId, m.startTime, m.endTime, now, now)
    },
    upsertAsset(a, now) {
      db.query(`INSERT INTO assets (meeting_id,sub_meeting_id,asset_type,remote_id,asset_id,status,bytes_expected,file_type,created_at,updated_at)
        VALUES (?,?,?,?,?, 'pending', ?,?,?,?)
        ON CONFLICT(meeting_id,sub_meeting_id,asset_type,remote_id) DO UPDATE SET
          asset_id=COALESCE(excluded.asset_id, assets.asset_id),
          bytes_expected=COALESCE(excluded.bytes_expected, assets.bytes_expected),
          file_type=COALESCE(excluded.file_type, assets.file_type), updated_at=excluded.updated_at`)
        .run(a.meetingId, a.subMeetingId, a.assetType, a.remoteId, a.assetId ?? null, a.bytesExpected ?? null, a.fileType ?? null, now, now)
    },
    claimNext(now, leaseSec) { return claimStmt.get(now + leaseSec, now, now) ?? null },
    markCompleted(id, h, now) { db.query(`UPDATE assets SET status='completed', content_hash=?, completed_at=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(h, now, now, id) },
    markFailed(id, e, now) { db.query(`UPDATE assets SET status='failed', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(e, now, id) },
    markSkipped(id, r, now) { db.query(`UPDATE assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(r, now, id) },
    // status NOT IN ('completed','running')：按键跳过「不可下载/超时」的该类资产时，
    // 绝不回退已完成的下载，也不打断在途下载（与并发执行池自洽，避免与 markCompleted 竞态）。
    markSkippedByKey(k, r, now) { db.query(`UPDATE assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND status NOT IN ('completed','running')`).run(r, now, k.meetingId, k.subMeetingId, k.assetType) },
    markDead(id, e, now) { db.query(`UPDATE assets SET status='dead', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(e, now, id) },
    touchProgress(id, bytes, now, leaseSec) { db.query(`UPDATE assets SET bytes_written=?, lease_expires_at=?, updated_at=? WHERE id=?`).run(bytes, now + leaseSec, now, id) },
    setTargetPath(id, p, ft, now) { db.query(`UPDATE assets SET target_path=?, file_type=COALESCE(?,file_type), updated_at=? WHERE id=?`).run(p, ft, now, id) },
    siblingRank(row) {
      const r = db.query<{ total: number; ordinal: number }, [string, string, string, number]>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN id <= ?4 THEN 1 ELSE 0 END) AS ordinal
         FROM assets WHERE meeting_id=?1 AND sub_meeting_id=?2 AND asset_type=?3`,
      ).get(row.meeting_id, row.sub_meeting_id, row.asset_type, row.id)
      return { ordinal: r?.ordinal ?? 1, total: r?.total ?? 1 }
    },
    upsertProbe(p) {
      db.query(`INSERT INTO asset_probes (meeting_id,sub_meeting_id,asset_type,state,deadline_at,probe_after)
        VALUES (?,?,?, 'probing', ?, ?)
        ON CONFLICT(meeting_id,sub_meeting_id,asset_type) DO UPDATE SET deadline_at=excluded.deadline_at`)
        .run(p.meetingId, p.subMeetingId, p.assetType, p.deadlineAt, p.probeAfter)
    },
    dueProbes(now) { return db.query<ProbeRow, [number]>(`SELECT * FROM asset_probes WHERE state='probing' AND probe_after <= ?`).all(now) },
    resolveProbe(k) { db.query(`UPDATE asset_probes SET state='resolved' WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(k.meetingId, k.subMeetingId, k.assetType) },
    abandonProbe(k, r) { db.query(`UPDATE asset_probes SET state='abandoned', last_reason=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(r, k.meetingId, k.subMeetingId, k.assetType) },
    bumpProbe(k, after) { db.query(`UPDATE asset_probes SET attempts=attempts+1, probe_after=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`).run(after, k.meetingId, k.subMeetingId, k.assetType) },
    counts() {
      const rows = db.query<{ status: AssetStatus; n: number }, []>(`SELECT status, COUNT(*) n FROM assets GROUP BY status`).all()
      const out = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, dead: 0 } as Record<AssetStatus, number>
      for (const r of rows) out[r.status] = r.n
      return out
    },
    failures() { return db.query<AssetRow, []>(`SELECT * FROM assets WHERE status IN ('failed','dead') ORDER BY id`).all() },
    resetFailed(now) { return db.query(`UPDATE assets SET status='pending', last_error=NULL, updated_at=?  WHERE status IN ('failed','dead')`).run(now).changes },
  }
}
```

- [ ] **Step 5: 运行通过 + typecheck + Commit**

```bash
cd client && bun test tests/store/index.test.ts && bun run typecheck
git add client/src/store/{db,index}.ts client/tests/store/index.test.ts
git commit -m "feat(client): store 四表 + 原子领租约 + 去重 upsert + 探测（T4）"
```

---

## Task 5: storage（抽象接口 + LocalStorage）

**Files:**
- Create: `client/src/storage/types.ts`、`client/src/storage/local.ts`
- Test: `client/tests/storage/local.test.ts`

**Interfaces:**
- Produces:
  - `interface Storage { writtenSize; appendChunk; finalize; discardPart; writeMeta; ensureFreeSpace }`（签名见实现）
  - `createLocalStorage(root: string): Storage`

- [ ] **Step 1: 写失败测试** — `client/tests/storage/local.test.ts`

```ts
import { afterEach, expect, test } from 'bun:test'
import { createLocalStorage } from '../../src/storage/local'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function tmp() { return mkdtemp(join(tmpdir(), 'mde-')) }

test('appendChunk 落 .part，finalize 原子 rename 为正式名', async () => {
  const root = await tmp(); const s = createLocalStorage(root)
  await s.appendChunk('a/b/f.mp4', 0, new Uint8Array([1, 2, 3]))
  expect(await s.writtenSize('a/b/f.mp4')).toBe(3)          // .part 大小
  expect(await Bun.file(join(root, 'a/b/f.mp4')).exists()).toBe(false)  // 正式名尚不存在
  await s.finalize('a/b/f.mp4')
  expect(await Bun.file(join(root, 'a/b/f.mp4')).exists()).toBe(true)   // rename 后存在
  await rm(root, { recursive: true, force: true })
})
test('续传：从 offset 追加，writtenSize 递增', async () => {
  const root = await tmp(); const s = createLocalStorage(root)
  await s.appendChunk('f.bin', 0, new Uint8Array([1, 2]))
  await s.appendChunk('f.bin', 2, new Uint8Array([3, 4, 5]))
  expect(await s.writtenSize('f.bin')).toBe(5)
  await rm(root, { recursive: true, force: true })
})
test('discardPart 删除 .part（416/200 时重下）', async () => {
  const root = await tmp(); const s = createLocalStorage(root)
  await s.appendChunk('f.bin', 0, new Uint8Array([9]))
  await s.discardPart('f.bin')
  expect(await s.writtenSize('f.bin')).toBe(0)
  await rm(root, { recursive: true, force: true })
})
```

- [ ] **Step 2: 运行确认失败，再实现 storage/types.ts + local.ts**

`storage/types.ts`：
```ts
export interface Storage {
  /** 返回 <relPath>.part 的实际字节数（不存在则 0）——续传的事实源 */
  writtenSize(relPath: string): Promise<number>
  /** 读回 <relPath>.part 全量内容（文本类算 content_hash 用） */
  readPart(relPath: string): Promise<ArrayBuffer>
  /** 从 offset 处向 <relPath>.part 追加；返回追加后总字节数 */
  appendChunk(relPath: string, offset: number, chunk: Uint8Array): Promise<number>
  /** 原子 rename <relPath>.part → <relPath>（内容完整的标志） */
  finalize(relPath: string): Promise<void>
  /** 删除 <relPath>.part（416/200 时重下） */
  discardPart(relPath: string): Promise<void>
  /** 写元数据文件（meeting.json / _manifest.json），直接落正式名 */
  writeMeta(relPath: string, data: unknown): Promise<void>
  /** 目标卷剩余空间是否 ≥ bytes（下载前预检） */
  ensureFreeSpace(bytes: number): Promise<boolean>
}
```

`storage/local.ts`（用 Bun.file + node:fs）：
```ts
import type { Storage } from './types'
import { join, dirname } from 'node:path'
import { mkdir, rename, rm, stat, open } from 'node:fs/promises'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
const statfsAsync = promisify(statfs)

export function createLocalStorage(root: string): Storage {
  const abs = (rel: string) => join(root, rel)
  const part = (rel: string) => abs(rel) + '.part'
  return {
    async writtenSize(rel) { try { return (await stat(part(rel))).size } catch { return 0 } },
    async readPart(rel) { return Bun.file(part(rel)).arrayBuffer() },
    async appendChunk(rel, offset, chunk) {
      await mkdir(dirname(part(rel)), { recursive: true })
      const fh = await open(part(rel), offset === 0 ? 'w' : 'r+')
      try { await fh.write(chunk, 0, chunk.byteLength, offset) } finally { await fh.close() }
      return (await stat(part(rel))).size
    },
    async finalize(rel) { await mkdir(dirname(abs(rel)), { recursive: true }); await rename(part(rel), abs(rel)) },
    async discardPart(rel) { await rm(part(rel), { force: true }) },
    async writeMeta(rel, data) { await mkdir(dirname(abs(rel)), { recursive: true }); await Bun.write(abs(rel), JSON.stringify(data, null, 2)) },
    async ensureFreeSpace(bytes) {
      try { const s = await statfsAsync(root); return s.bavail * s.bsize >= bytes } catch { return true } // 取不到时不阻断
    },
  }
}
```

Run: `cd client && bun test tests/storage/local.test.ts` → PASS

- [ ] **Step 3: typecheck + Commit**

```bash
cd client && bun run typecheck
git add client/src/storage/{types,local}.ts client/tests/storage/local.test.ts
git commit -m "feat(client): storage 抽象接口 + LocalStorage（T5）"
```

---

## Task 6: gateway（service-token 认证 + 401 透明重取 + 端点）

**Files:**
- Create: `client/src/gateway/client.ts`
- Test: `client/tests/gateway/client.test.ts`

**Interfaces:**
- Consumes: `domain/types`（Meeting）。注入 `fetch` 便于测试。
- Produces:
  - `createGatewayClient(cfg: { gatewayUrl; clientId; clientSecret }, deps: { fetch: typeof fetch; now: () => number }): GatewayClient`
  - `GatewayClient`：`listMeetings(selector, cursor?, limit?)` / `listAssets(meetingId, from?, to?)` / `getDownloadUrl(assetId)`（按 ID/会议号取会议统一走 `listMeetings({kind:'id'|'code'})`，不单列 getMeeting——无下游消费者）
  - 错误类：`GatewayError`（含 httpStatus、body.error）、`MeetingNotFoundInRangeError`

- [ ] **Step 1: 写失败测试** — `client/tests/gateway/client.test.ts`（stub fetch）

```ts
import { expect, test } from 'bun:test'
import { createGatewayClient, MeetingNotFoundInRangeError } from '../../src/gateway/client'

function stub(responses: Array<{ match: (url: string, init?: RequestInit) => boolean; res: () => Response }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const r = responses.find((x) => x.match(url, init))
    if (!r) throw new Error(`no stub for ${url}`)
    return r.res()
  }) as typeof fetch
}
const cfg = { gatewayUrl: 'https://gw', clientId: 'cid', clientSecret: 'sec' }
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

test('首次调用先换 service-token，再带 Bearer 调业务端点', async () => {
  let tokenCalls = 0; let sawBearer = ''
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => { tokenCalls++; return ok({ access_token: 'tok', expires_in: 900 }) } },
    { match: (u) => u.includes('/api/v1/meetings'), res: () => ok({ meetings: [], next_cursor: null }) },
  ])
  const wrapped: typeof fetch = (async (i, init) => { if (String(i).includes('/meetings')) sawBearer = (init?.headers as any)?.Authorization ?? ''; return fetchStub(i, init) }) as typeof fetch
  const gw = createGatewayClient(cfg, { fetch: wrapped, now: () => 1000 })
  await gw.listMeetings({ kind: 'range', from: 1, to: 2 })
  expect(tokenCalls).toBe(1)
  expect(sawBearer).toBe('Bearer tok')
})

test('业务端点 401 → 透明重取 token 后重试当次调用', async () => {
  let tokenCalls = 0; let meetingCalls = 0
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => { tokenCalls++; return ok({ access_token: `tok${tokenCalls}`, expires_in: 900 }) } },
    { match: (u) => u.includes('/api/v1/meetings'), res: () => { meetingCalls++; return meetingCalls === 1 ? new Response('{"error":"token_expired"}', { status: 401 }) : ok({ meetings: [], next_cursor: null }) } },
  ])
  const gw = createGatewayClient(cfg, { fetch: fetchStub, now: () => 1000 })
  await gw.listMeetings({ kind: 'range', from: 1, to: 2 })
  expect(tokenCalls).toBe(2)     // 初次 + 401 后重取
  expect(meetingCalls).toBe(2)   // 401 + 重试成功
})

test('meeting_not_found_in_range → 专用错误类', async () => {
  const fetchStub = stub([
    { match: (u) => u.includes('/auth/service-token'), res: () => ok({ access_token: 'tok', expires_in: 900 }) },
    { match: (u) => u.includes('/api/v1/meetings'), res: () => new Response('{"error":"meeting_not_found_in_range"}', { status: 404 }) },
  ])
  const gw = createGatewayClient(cfg, { fetch: fetchStub, now: () => 1000 })
  await expect(gw.listMeetings({ kind: 'id', meetingId: 'x' })).rejects.toThrow(MeetingNotFoundInRangeError)
})
```

- [ ] **Step 2: 运行确认失败，再实现 gateway/client.ts**

```ts
import type { Meeting, MeetingSelector } from '../domain/types'

export class GatewayError extends Error {
  constructor(readonly httpStatus: number, readonly code: string, msg?: string) {
    super(msg ?? `gateway error ${httpStatus}: ${code}`); this.name = 'GatewayError'
  }
}
export class MeetingNotFoundInRangeError extends Error {
  constructor() { super('meeting not found in range'); this.name = 'MeetingNotFoundInRangeError' }
}

export interface GatewayAsset { assetId: string; assetType: string; remoteId: string; state?: number; allowDownload?: boolean; fileType?: string | null; bytesExpected?: number | null }
export interface DownloadUrl { url: string; expiresAt: number; fileType: string | null; bytesExpected: number | null }
export interface GatewayClient {
  listMeetings(sel: MeetingSelector, cursor?: string, limit?: number): Promise<{ meetings: Meeting[]; nextCursor: string | null }>
  listAssets(meetingId: string, from?: number, to?: number): Promise<GatewayAsset[]>
  getDownloadUrl(assetId: string): Promise<DownloadUrl>
}

export function createGatewayClient(
  cfg: { gatewayUrl: string; clientId: string; clientSecret: string },
  deps: { fetch: typeof fetch; now: () => number },
): GatewayClient {
  let token: { value: string; expiresAt: number } | null = null

  async function fetchToken(): Promise<string> {
    const res = await deps.fetch(`${cfg.gatewayUrl}/api/v1/auth/service-token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    })
    if (!res.ok) throw new GatewayError(res.status, 'auth_failed')
    const body = (await res.json()) as { access_token: string; expires_in: number }
    token = { value: body.access_token, expiresAt: deps.now() + body.expires_in - 30 }
    return body.access_token
  }
  async function ensureToken(): Promise<string> {
    if (token && token.expiresAt > deps.now()) return token.value
    return fetchToken()
  }
  /** 带 Bearer 调用；遇 401 重取一次 token 后重试当次调用（透明续期） */
  async function authed(path: string, init?: RequestInit): Promise<Response> {
    let bearer = await ensureToken()
    let res = await deps.fetch(`${cfg.gatewayUrl}${path}`, withAuth(init, bearer))
    if (res.status === 401) { token = null; bearer = await fetchToken(); res = await deps.fetch(`${cfg.gatewayUrl}${path}`, withAuth(init, bearer)) }
    return res
  }
  function withAuth(init: RequestInit | undefined, bearer: string): RequestInit {
    return { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' } }
  }
  async function parseError(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error === 'meeting_not_found_in_range') throw new MeetingNotFoundInRangeError()
    throw new GatewayError(res.status, body.error ?? 'unknown')
  }

  return {
    async listMeetings(sel, cursor, limit) {
      const q = new URLSearchParams()
      if (sel.kind === 'range') { q.set('from', String(sel.from)); q.set('to', String(sel.to)) }
      if (sel.kind === 'code') { q.set('meeting_code', sel.meetingCode); if (sel.from) q.set('from', String(sel.from)); if (sel.to) q.set('to', String(sel.to)) }
      if (sel.kind === 'id') { q.set('meeting_id', sel.meetingId); if (sel.from) q.set('from', String(sel.from)); if (sel.to) q.set('to', String(sel.to)) }
      if (cursor) q.set('cursor', cursor); if (limit) q.set('limit', String(limit))
      const res = await authed(`/api/v1/meetings?${q}`)
      if (!res.ok) return parseError(res)
      const b = (await res.json()) as { meetings: RawMeeting[]; next_cursor: string | null }
      return { meetings: b.meetings.map(toMeeting), nextCursor: b.next_cursor }
    },
    async listAssets(meetingId, from, to) {
      const q = new URLSearchParams(); if (from) q.set('from', String(from)); if (to) q.set('to', String(to))
      const res = await authed(`/api/v1/meetings/${encodeURIComponent(meetingId)}/assets?${q}`)
      if (!res.ok) return parseError(res)
      const b = (await res.json()) as { assets: RawAsset[] }
      return b.assets.map((a) => ({ assetId: a.asset_id, assetType: a.asset_type, remoteId: a.remote_id ?? a.asset_id, state: a.state, allowDownload: a.allow_download, fileType: a.file_type ?? null, bytesExpected: a.bytes_expected ?? null }))
    },
    async getDownloadUrl(assetId) {
      const res = await authed(`/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, { method: 'POST' })
      if (!res.ok) return parseError(res)
      const b = (await res.json()) as { url: string; expires_at: number; file_type?: string | null; bytes_expected?: number | null }
      return { url: b.url, expiresAt: b.expires_at, fileType: b.file_type ?? null, bytesExpected: b.bytes_expected ?? null }
    },
  }
}

interface RawMeeting { meeting_id: string; sub_meeting_id?: string; meeting_code?: string; subject?: string; host_user_id?: string; start_time?: number; end_time?: number }
interface RawAsset { asset_id: string; asset_type: string; remote_id?: string; state?: number; allow_download?: boolean; file_type?: string | null; bytes_expected?: number | null }
function toMeeting(r: RawMeeting): Meeting {
  return { meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id ?? '', meetingCode: r.meeting_code ?? null, subject: r.subject ?? null, hostUserId: r.host_user_id ?? null, startTime: r.start_time ?? null, endTime: r.end_time ?? null }
}
```

> ⚠️ spec §17 已知未知：`listAssets` 响应里 `remote_id`/`state`/`allow_download`/`file_type`/`bytes_expected` 的确切字段名待真实环境核实。上面按网关 §5.2 契约推断，接真实环境时只需改此映射，不影响下游。

- [ ] **Step 3: 运行通过 + typecheck + Commit**

```bash
cd client && bun test tests/gateway/client.test.ts && bun run typecheck
git add client/src/gateway/client.ts client/tests/gateway/client.test.ts
git commit -m "feat(client): gateway 客户端 service-token 认证 + 401 重取 + 端点（T6）"
```

---

## Task 7: discovery（选择器 → 取清单 → UPSERT 任务 + 建探测）

**Files:**
- Create: `client/src/discovery/index.ts`
- Test: `client/tests/discovery/index.test.ts`

**Interfaces:**
- Consumes: `GatewayClient`（listMeetings/listAssets）、`Store`（upsertMeeting/upsertAsset/upsertProbe）、`domain`（judgeReadiness、ASSET_KEY_TO_FIELD、ASSET_WAIT_CAP_SEC、splitWindow）。
- Produces: `discover(deps, sel: MeetingSelector, wantedKeys: AssetKey[], now: number): Promise<{ meetings: number; tasks: number }>`

- [ ] **Step 1: 写失败测试** — `client/tests/discovery/index.test.ts`（假 gateway + `:memory:` store）

```ts
import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { discover } from '../../src/discovery'
import type { GatewayClient } from '../../src/gateway/client'

function fakeGw(assetsByMeeting: Record<string, any[]>): GatewayClient {
  return {
    listMeetings: async () => ({ meetings: [{ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }], nextCursor: null }),
    listAssets: async (id) => assetsByMeeting[id] ?? [],
    getDownloadUrl: async () => ({ url: '', expiresAt: 0, fileType: null, bytesExpected: null }),
  }
}

test('就绪资产建 pending 任务；不在清单的想要类型建 probing 探测', async () => {
  const store = createStore(openDb(':memory:'))
  const gw = fakeGw({ m1: [
    { assetId: 'm1:rf1:download_address:0', assetType: 'download_address', remoteId: 'rf1', state: 3, allowDownload: true, bytesExpected: 100, fileType: 'mp4' },
  ] })
  // 想要 video + ai_transcript：video 就绪→任务；ai_transcript 不在清单→探测
  const r = await discover({ gw, store, now: () => 1000 }, { kind: 'range', from: 1, to: 2 }, ['video', 'ai_transcript'], 1000)
  expect(r.meetings).toBe(1)
  expect(store.counts().pending).toBe(1)                 // 只有 video 建了任务
  expect(store.dueProbes(1000).length).toBe(1)           // ai_transcript 在探测
})

test('allow_download=false 的想要资产直接 skipped，不建任务不留探测', async () => {
  const store = createStore(openDb(':memory:'))
  const gw = fakeGw({ m1: [
    { assetId: 'm1:rf1:ai_meeting_transcripts:0', assetType: 'ai_meeting_transcripts', remoteId: 'rf1', state: 3, allowDownload: false },
  ] })
  await discover({ gw, store, now: () => 1000 }, { kind: 'range', from: 1, to: 2 }, ['ai_transcript'], 1000)
  expect(store.counts().skipped).toBe(1)
})
```

- [ ] **Step 2: 运行确认失败，再实现 discovery/index.ts**

```ts
import type { GatewayClient } from '../gateway/client'
import type { Store } from '../store'
import type { AssetKey, MeetingSelector } from '../domain/types'
import { ASSET_KEY_TO_FIELD, ASSET_WAIT_CAP_SEC } from '../domain/types'
import { judgeReadiness } from '../domain/readiness'
import { splitWindow } from '../domain/window'

export interface DiscoveryDeps { gw: GatewayClient; store: Store }

export async function discover(
  deps: DiscoveryDeps, sel: MeetingSelector, wantedKeys: AssetKey[], now: number,
): Promise<{ meetings: number; tasks: number }> {
  const meetings = await collectMeetings(deps.gw, sel)
  let tasks = 0
  const wantedFields = new Map(wantedKeys.map((k) => [ASSET_KEY_TO_FIELD[k], k]))
  for (const m of meetings) {
    deps.store.upsertMeeting(m, now)
    const assets = await deps.gw.listAssets(m.meetingId, sel.kind !== 'range' ? sel.from : undefined, sel.kind !== 'range' ? sel.to : undefined)
    for (const [field, key] of wantedFields) {
      const present = assets.filter((a) => a.assetType === field)  // 同类多段全取，不塌缩
      const rep = present[0]  // 同一 meeting 的同类多段共享 allow_download/state，取代表判定类型级就绪
      const deadlineAt = (m.endTime ?? now) + ASSET_WAIT_CAP_SEC[key]
      const verdict = judgeReadiness({ present: present.length > 0, state: rep?.state, allowDownload: rep?.allowDownload, now, deadlineAt })
      if (verdict === 'ready') {
        for (const a of present) {  // 每个 remote_id（每段录制）各建一个任务
          deps.store.upsertAsset({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, remoteId: a.remoteId, assetId: a.assetId, bytesExpected: a.bytesExpected, fileType: a.fileType }, now)
          tasks++
        }
      } else if (verdict === 'skip_disallowed') {
        // 建行后直接置 skipped（平台明示不可得，不留探测、不空等）；同类多段各建行
        for (const a of present) {
          deps.store.upsertAsset({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, remoteId: a.remoteId, assetId: a.assetId }, now)
        }
        deps.store.markSkippedByKey({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field }, 'download_not_allowed', now)
      } else if (verdict === 'skip_timeout') {
        deps.store.upsertProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, deadlineAt, probeAfter: 0 })
        deps.store.abandonProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field }, 'upstream_timeout')
      } else { // wait
        deps.store.upsertProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, deadlineAt, probeAfter: now })
      }
    }
  }
  return { meetings: meetings.length, tasks }
}

async function collectMeetings(gw: GatewayClient, sel: MeetingSelector) {
  // range 模式按 31 天切窗；点选模式网关自带默认窗口
  const windows = sel.kind === 'range' ? splitWindow(sel.from, sel.to) : [null]
  const all = []
  for (const w of windows) {
    const s = w ? ({ kind: 'range', from: w.from, to: w.to } as const) : sel
    let cursor: string | undefined
    do {
      const page = await gw.listMeetings(s, cursor)
      all.push(...page.meetings)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }
  return all
}
```

> `store.markSkippedByKey`（按 meeting+type 直接置 skipped）已由 **T4 提供**（见 T4 Store 接口）——T7 直接消费，无需回补。

- [ ] **Step 3: 运行通过 + typecheck + Commit**

```bash
cd client && bun test tests/discovery/index.test.ts && bun run typecheck
git add client/src/discovery/index.ts client/tests/discovery/index.test.ts
git commit -m "feat(client): discovery 选择器→清单→任务+探测（T7）"
```

---

## Task 8: downloader（单资产 Range 续传 / 416 / 换链 / 校验 / finalize）

**Files:**
- Create: `client/src/downloader/index.ts`
- Test: `client/tests/downloader/index.test.ts`（本地 `Bun.serve` 起真实 HTTP，测 Range/403/416/断连）

**Interfaces:**
- Consumes: `Storage`、`GatewayClient.getDownloadUrl`。
- Produces: `downloadAsset(deps, task: DownloadTask, now: () => number): Promise<DownloadResult>`
  - `DownloadTask = { assetId; relPath; bytesExpected: number | null; isText: boolean }`
  - `DownloadResult = { status: 'completed'; contentHash: string | null } | { status: 'failed'; error: string }`

- [ ] **Step 1: 写失败测试** — `client/tests/downloader/index.test.ts`

```ts
import { afterEach, expect, test } from 'bun:test'
import { createLocalStorage } from '../../src/storage/local'
import { downloadAsset } from '../../src/downloader'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BODY = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256))

/** 支持 Range 的本地文件服务；可注入「首链 403、换链后成功」等行为 */
function serve(opts: { failFirstUrl?: boolean } = {}) {
  let served = 0
  const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url)
    if (opts.failFirstUrl && url.searchParams.get('v') === '1') return new Response('expired', { status: 403 })
    served++
    const range = req.headers.get('range')
    if (range) { const start = Number(range.replace('bytes=', '').split('-')[0]); return new Response(BODY.slice(start), { status: 206, headers: { 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` } }) }
    return new Response(BODY, { status: 200 })
  } })
  return { server, base: `http://localhost:${server.port}`, servedCount: () => served }
}

async function tmp() { return mkdtemp(join(tmpdir(), 'mde-dl-')) }

test('完整下载 → finalize，字节数与 bytes_expected 一致', async () => {
  const s = serve(); const root = await tmp(); const storage = createLocalStorage(root)
  const gw = { getDownloadUrl: async () => ({ url: `${s.base}/f?v=2`, expiresAt: 9e9, fileType: 'mp4', bytesExpected: BODY.length }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'd/f.mp4', bytesExpected: BODY.length, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  expect(await Bun.file(join(root, 'd/f.mp4')).exists()).toBe(true)
  s.server.stop(); await rm(root, { recursive: true, force: true })
})

test('链接过期（403）→ 向网关换新链，从当前字节续传，最终完整', async () => {
  const s = serve({ failFirstUrl: true }); const root = await tmp(); const storage = createLocalStorage(root)
  let v = 0
  const gw = { getDownloadUrl: async () => { v++; return ({ url: `${s.base}/f?v=${v}`, expiresAt: 9e9, fileType: 'mp4', bytesExpected: BODY.length }) } } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'f.mp4', bytesExpected: BODY.length, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  expect((await Bun.file(join(root, 'f.mp4')).arrayBuffer()).byteLength).toBe(BODY.length)
  s.server.stop(); await rm(root, { recursive: true, force: true })
})

test('本地 .part 大于远端（416）→ 删除重下', async () => {
  const root = await tmp(); const storage = createLocalStorage(root)
  await storage.appendChunk('f.bin', 0, new Uint8Array(BODY.length + 500))   // .part 比远端大
  const server = Bun.serve({ port: 0, fetch(req) { if (req.headers.get('range')) return new Response('range not satisfiable', { status: 416 }); return new Response(BODY, { status: 200 }) } })
  const gw = { getDownloadUrl: async () => ({ url: `http://localhost:${server.port}/f`, expiresAt: 9e9, fileType: null, bytesExpected: BODY.length }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'f.bin', bytesExpected: BODY.length, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  expect(await storage.writtenSize('f.bin')).toBe(0)   // .part 已 finalize 掉
  expect((await Bun.file(join(root, 'f.bin')).arrayBuffer()).byteLength).toBe(BODY.length)
  server.stop(); await rm(root, { recursive: true, force: true })
})

test('文本类：完成后返回 content_hash', async () => {
  const s = serve(); const root = await tmp(); const storage = createLocalStorage(root)
  const gw = { getDownloadUrl: async () => ({ url: `${s.base}/t?v=2`, expiresAt: 9e9, fileType: 'txt', bytesExpected: BODY.length }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 't.txt', bytesExpected: BODY.length, isText: true }, () => 1)
  expect(r.status).toBe('completed')
  if (r.status === 'completed') expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/)
  s.server.stop(); await rm(root, { recursive: true, force: true })
})
```

- [ ] **Step 2: 运行确认失败，再实现 downloader/index.ts**

```ts
import type { Storage } from '../storage/types'
import type { GatewayClient } from '../gateway/client'

export interface DownloadTask { assetId: string; relPath: string; bytesExpected: number | null; isText: boolean }
export type DownloadResult = { status: 'completed'; contentHash: string | null } | { status: 'failed'; error: string }
export interface DownloadDeps { storage: Storage; gw: Pick<GatewayClient, 'getDownloadUrl'>; onProgress?: (bytes: number) => void }

const PROGRESS_INTERVAL = 8 * 1024 * 1024

export async function downloadAsset(deps: DownloadDeps, task: DownloadTask, _now: () => number): Promise<DownloadResult> {
  try {
    let link = await deps.gw.getDownloadUrl(task.assetId)
    for (let attempt = 0; attempt < 6; attempt++) {
      let size = await deps.storage.writtenSize(task.relPath)
      const res = await fetchFrom(link.url, size)

      if (res.status === 416) { await deps.storage.discardPart(task.relPath); size = 0; link = await deps.gw.getDownloadUrl(task.assetId); continue }
      if (res.status === 403 || res.status === 410) { link = await deps.gw.getDownloadUrl(task.assetId); continue }  // 链接过期换新，size 保留续传
      if (res.status === 200 && size > 0) { await deps.storage.discardPart(task.relPath); size = 0 }                 // 不支持 Range，丢弃重下
      if (res.status !== 200 && res.status !== 206) { if (res.status >= 500) { link = await deps.gw.getDownloadUrl(task.assetId); continue } return { status: 'failed', error: `http ${res.status}` } }

      // 流式写入 .part，每 8MB 回调进度
      const reader = res.body!.getReader()
      let written = size, sinceProgress = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await deps.storage.appendChunk(task.relPath, written, value)
        written += value.byteLength; sinceProgress += value.byteLength
        if (sinceProgress >= PROGRESS_INTERVAL) { deps.onProgress?.(written); sinceProgress = 0 }
      }
      // 完成校验
      if (task.bytesExpected != null && written !== task.bytesExpected) return { status: 'failed', error: `size mismatch: ${written} != ${task.bytesExpected}` }
      const hash = task.isText ? await hashFile(deps.storage, task.relPath) : null
      await deps.storage.finalize(task.relPath)
      return { status: 'completed', contentHash: hash }
    }
    return { status: 'failed', error: 'too many link renewals' }
  } catch (err) { return { status: 'failed', error: err instanceof Error ? err.message : String(err) } }
}

async function fetchFrom(url: string, size: number): Promise<Response> {
  const headers: Record<string, string> = {}
  if (size > 0) headers.range = `bytes=${size}-`
  return fetch(url, { headers })
}
async function hashFile(storage: Storage, relPath: string): Promise<string> {
  // 文本类小文件：读 .part 全量算 sha256（视频/音频 isText=false，不走这里）
  const buf = await storage.readPart(relPath)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
```

> `storage.readPart`（读回 `.part` 全量供文本类算 hash）已由 **T5 提供**（见 T5 Storage 接口）——T8 直接消费，无需回补。注意 `DownloadDeps.storage` 类型需含 `readPart`，故 T8 消费的是完整 `Storage`（不是 `Pick`）。

- [ ] **Step 3: 运行通过 + typecheck + Commit**

```bash
cd client && bun test tests/downloader/index.test.ts && bun run typecheck
git add client/src/downloader/index.ts client/tests/downloader/index.test.ts
git commit -m "feat(client): downloader Range续传/416/换链/校验（T8）"
```

---

## Task 9: executor（有界并发池 + 探测循环）

**Files:**
- Create: `client/src/executor/index.ts`
- Test: `client/tests/executor/index.test.ts`

**Interfaces:**
- Consumes: `Store`（claimNext/mark*/touchProgress/setTargetPath/dueProbes/...）、`downloadAsset`、`GatewayClient`、`discover`（探测重查时复用 listAssets 逻辑）、`domain`（assetKeyToFilename、FIELD_TO_ASSET_KEY、cleanDirName）、`Storage`（ensureFreeSpace）。
- Produces:
  - `runExecutor(deps, opts: { concurrency: number; leaseSec: number }, now: () => number): Promise<{ completed: number; failed: number; skipped: number }>`
  - `runProbes(deps, now: () => number): Promise<{ resolved: number; abandoned: number; newTasks: number }>`

- [ ] **Step 1: 写失败测试** — `client/tests/executor/index.test.ts`

```ts
import { expect, test } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { runExecutor } from '../../src/executor'
// 用真实 store + 假 downloadAsset（注入）+ 临时目录

test('并发池领任务并下载，全部 completed；幂等重跑零下载', async () => {
  const store = createStore(openDb(':memory:'))
  store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  for (const rid of ['r1', 'r2', 'r3']) store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'download_address', remoteId: rid, bytesExpected: 10, fileType: 'mp4' }, 1)
  let downloads = 0
  const fakeDownload = async () => { downloads++; return { status: 'completed' as const, contentHash: null } }
  const deps: any = { store, download: fakeDownload, gw: {}, storage: { ensureFreeSpace: async () => true }, meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]) }
  const r1 = await runExecutor(deps, { concurrency: 2, leaseSec: 300 }, () => 1000)
  expect(r1.completed).toBe(3)
  expect(downloads).toBe(3)
  const r2 = await runExecutor(deps, { concurrency: 2, leaseSec: 300 }, () => 2000)  // 幂等
  expect(r2.completed).toBe(0)
  expect(downloads).toBe(3)   // 第二次零下载
})

test('磁盘不足 → 该任务 skipped(disk_full)，不写半截', async () => {
  const store = createStore(openDb(':memory:'))
  store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'download_address', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)
  const deps: any = { store, download: async () => ({ status: 'completed', contentHash: null }), gw: {}, storage: { ensureFreeSpace: async () => false }, meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]) }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r.skipped).toBe(1)
})
```

- [ ] **Step 2: 运行确认失败，再实现 executor/index.ts**

```ts
import type { Store, AssetRow } from '../store'
import type { DownloadResult, DownloadTask } from '../downloader'
import type { Storage } from '../storage/types'
import type { GatewayClient } from '../gateway/client'
import { FIELD_TO_ASSET_KEY, assetKeyToFilename, ASSET_WAIT_CAP_SEC } from '../domain/types'
import { cleanDirName } from '../domain/filename'
import { judgeReadiness } from '../domain/readiness'

export interface ExecutorDeps {
  store: Store
  download: (task: DownloadTask, onProgress: (b: number) => void) => Promise<DownloadResult>
  storage: Pick<Storage, 'ensureFreeSpace' | 'writeMeta'>
  gw: Pick<GatewayClient, 'listAssets'>
  meetingsById: Map<string, { subject: string | null; startTime: number | null; meetingCode: string | null; endTime: number | null; subMeetingId: string }>
}
const MAX_ATTEMPTS = 5

export async function runExecutor(deps: ExecutorDeps, opts: { concurrency: number; leaseSec: number }, now: () => number) {
  const result = { completed: 0, failed: 0, skipped: 0 }
  const worker = async () => {
    for (;;) {
      const row = deps.store.claimNext(now(), opts.leaseSec)
      if (!row) return
      await handleOne(deps, row, opts.leaseSec, now, result)
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, worker))
  return result
}

async function handleOne(deps: ExecutorDeps, row: AssetRow, leaseSec: number, now: () => number, result: { completed: number; failed: number; skipped: number }) {
  const relPath = buildRelPath(deps, row)
  if (relPath === null) { deps.store.markSkipped(row.id, 'meeting_meta_missing', now()); result.skipped++; return }
  if (row.bytes_expected != null && !(await deps.storage.ensureFreeSpace(row.bytes_expected))) { deps.store.markSkipped(row.id, 'disk_full', now()); result.skipped++; return }
  deps.store.setTargetPath(row.id, relPath, row.file_type, now())

  const isText = !['download_address', 'audio_address'].includes(row.asset_type)
  const res = await deps.download({ assetId: row.asset_id ?? assetId(row), relPath, bytesExpected: row.bytes_expected, isText }, (b) => deps.store.touchProgress(row.id, b, now(), leaseSec))
  if (res.status === 'completed') { deps.store.markCompleted(row.id, res.contentHash, now()); result.completed++; return }
  if (row.attempts >= MAX_ATTEMPTS) { deps.store.markDead(row.id, res.error, now()); result.failed++; return }
  deps.store.markFailed(row.id, res.error, now()); result.failed++
}

/** 相对路径：<year>/<month>/<清洗目录>/<资产文件名> */
function buildRelPath(deps: ExecutorDeps, row: AssetRow): string | null {
  const m = deps.meetingsById.get(row.meeting_id)
  if (!m) return null
  const d = new Date((m.startTime ?? 0) * 1000)
  const yyyy = String(d.getUTCFullYear()), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0')
  const hhmm = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0')
  const dir = cleanDirName(`${yyyy}-${mm}-${dd}`, hhmm, m.subject ?? '', m.meetingCode ?? row.meeting_id)
  const key = FIELD_TO_ASSET_KEY[row.asset_type] ?? (row.asset_type as any)
  const { ordinal } = deps.store.siblingRank(row)
  const fname = assetKeyToFilename(key, row.remote_id, row.file_type ?? 'bin', ordinal)
  return `${yyyy}/${mm}/${dir}/${fname}`
}
function assetId(row: AssetRow): string { return `${row.meeting_id}:${row.remote_id}:${row.asset_type}:0` }

/** 探测循环：重查到期 probing 资产，就绪则补建任务、超时则 abandon */
export async function runProbes(deps: ExecutorDeps & { store: Store }, now: () => number) {
  const out = { resolved: 0, abandoned: 0, newTasks: 0 }
  for (const p of deps.store.dueProbes(now())) {
    const meetingKey = p.meeting_id
    const assets = await deps.gw.listAssets(meetingKey)
    const a = assets.find((x) => x.assetType === p.asset_type)
    const verdict = judgeReadiness({ present: !!a, state: a?.state, allowDownload: a?.allowDownload, now: now(), deadlineAt: p.deadline_at })
    if (verdict === 'ready') { deps.store.upsertAsset({ meetingId: p.meeting_id, subMeetingId: p.sub_meeting_id, assetType: p.asset_type, remoteId: a!.remoteId, assetId: a!.assetId, bytesExpected: a!.bytesExpected, fileType: a!.fileType }, now()); deps.store.resolveProbe(p); out.resolved++; out.newTasks++ }
    else if (verdict === 'skip_disallowed') { deps.store.abandonProbe(p, 'download_not_allowed'); out.abandoned++ }
    else if (verdict === 'skip_timeout') { deps.store.abandonProbe(p, 'upstream_timeout'); out.abandoned++ }
    else deps.store.bumpProbe(p, now() + probeBackoff(p.attempts))   // 继续等，退避
  }
  return out
}
function probeBackoff(attempts: number): number { return Math.min(3600, 300 * 2 ** Math.min(attempts, 4)) }  // 5min→…→上限 1h
```

> `p` 传给 `resolveProbe`/`abandonProbe`/`bumpProbe` 时其形状是 `ProbeRow`（含 meeting_id/sub_meeting_id/asset_type），与 `ProbeKey` 字段名不同——实现时用 `{ meetingId: p.meeting_id, subMeetingId: p.sub_meeting_id, assetType: p.asset_type }` 适配，或给这三个 store 方法重载接受 ProbeRow。**T9 实现者需在此处做键名适配**（计划已标注，避免 signature 不一致）。

- [ ] **Step 3: 运行通过 + typecheck + Commit**

```bash
cd client && bun test tests/executor/index.test.ts && bun run typecheck
git add client/src/executor/index.ts client/tests/executor/index.test.ts
git commit -m "feat(client): executor 有界并发池 + 探测循环（T9）"
```

---

## Task 10: cli（命令分发 + 人读输出 + 顶层装配）

**Files:**
- Create: `client/bin/mde.ts`、`client/src/cli/index.ts`、`client/src/cli/commands/{run,discover,list,get,execute,status,retry}.ts`
- Test: `client/tests/cli/parse.test.ts`（参数解析纯逻辑）

**Interfaces:**
- Consumes: 全部模块。
- Produces: `parseArgs(argv: string[]): ParsedCommand`；`main(argv, env): Promise<number>`（返回退出码）。

- [ ] **Step 1: 写参数解析失败测试** — `client/tests/cli/parse.test.ts`

```ts
import { expect, test } from 'bun:test'
import { parseArgs } from '../../src/cli'

test('run --from --to --out --assets', () => {
  const c = parseArgs(['run', '--from', '2026-07-01', '--to', '2026-07-31', '--out', './m', '--assets', 'video,transcript'])
  expect(c.command).toBe('run')
  expect(c.assets).toEqual(['video', 'transcript'])
  expect(c.from).toBe(Date.UTC(2026, 6, 1) / 1000)
})
test('get 位置参数为会议号/ID', () => {
  const c = parseArgs(['get', '88123456'])
  expect(c.command).toBe('get'); expect(c.target).toBe('88123456')
})
test('未知资产键报错', () => {
  expect(() => parseArgs(['run', '--assets', 'bogus'])).toThrow('bogus')
})
test('缺命令返回 help', () => {
  expect(parseArgs([]).command).toBe('help')
})
```

- [ ] **Step 2: 运行确认失败，再实现 cli/index.ts（解析 + 分发）**

```ts
import { parseAssetKeys, DEFAULT_ASSET_KEYS, type AssetKey } from '../domain/types'

export interface ParsedCommand {
  command: 'run' | 'discover' | 'list' | 'get' | 'execute' | 'status' | 'retry' | 'help'
  from?: number; to?: number; out?: string; concurrency?: number
  code?: string; meetingId?: string; target?: string; assets: AssetKey[]; failed?: boolean
}

function parseDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) { const n = Number(s); if (Number.isFinite(n)) return n; throw new Error(`bad date: ${s}`) }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000
}

export function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) return { command: 'help', assets: DEFAULT_ASSET_KEYS }
  const [command, ...rest] = argv
  const c: ParsedCommand = { command: command as ParsedCommand['command'], assets: DEFAULT_ASSET_KEYS }
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--from') c.from = parseDate(rest[++i]!)
    else if (a === '--to') c.to = parseDate(rest[++i]!)
    else if (a === '--out') c.out = rest[++i]!
    else if (a === '--concurrency') c.concurrency = Number(rest[++i]!)
    else if (a === '--code') c.code = rest[++i]!
    else if (a === '--meeting-id') c.meetingId = rest[++i]!
    else if (a === '--assets') c.assets = parseAssetKeys(rest[++i]!)
    else if (a === '--failed') c.failed = true
    else if (!a.startsWith('--')) positional.push(a)
    else throw new Error(`unknown flag: ${a}`)
  }
  if (positional[0]) c.target = positional[0]
  if (!['run', 'discover', 'list', 'get', 'execute', 'status', 'retry', 'help'].includes(c.command)) c.command = 'help'
  return c
}
```

- [ ] **Step 3: 实现各命令与装配（run/discover/list/get/execute/status/retry）**

每个命令组装 config→gateway→store→discovery/executor/storage。此处给 `execute` 与 `status` 的完整实现，其余命令同构（run=discover+execute、get=按 code/id 建选择器后 discover+execute、list=只 listMeetings 打印、retry=store.resetFailed）：

```ts
// client/src/cli/commands/execute.ts
import { loadConfig } from '../../config'
import { openDb } from '../../store/db'
import { createStore } from '../../store'
import { createGatewayClient } from '../../gateway/client'
import { createLocalStorage } from '../../storage/local'
import { downloadAsset } from '../../downloader'
import { runExecutor, runProbes } from '../../executor'
import type { ParsedCommand } from '../index'

export async function cmdExecute(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  const cfg = loadConfig(env, {}, { out: cmd.out, concurrency: cmd.concurrency })
  const now = () => Math.floor(Date.now() / 1000)
  const db = openDb(cfg.dbPath); const store = createStore(db)
  const gw = createGatewayClient(cfg, { fetch, now })
  const storage = createLocalStorage(cfg.storageRoot)
  const meetingsById = loadMeetings(db)
  const deps = { store, gw, storage, meetingsById,
    download: (task: any, onProgress: any) => downloadAsset({ storage, gw, onProgress }, task, now) }
  await runProbes(deps as any, now)                                 // 先补探测（延迟资产就绪则入队）
  const r = await runExecutor(deps as any, { concurrency: cfg.concurrency, leaseSec: 900 }, now)
  console.log(`completed=${r.completed} failed=${r.failed} skipped=${r.skipped}`)
  return r.failed > 0 ? 1 : 0
}
function loadMeetings(db: any) {
  const rows = db.query('SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time FROM meetings').all()
  return new Map(rows.map((r: any) => [r.meeting_id, { subject: r.subject, meetingCode: r.meeting_code, startTime: r.start_time, endTime: r.end_time, subMeetingId: r.sub_meeting_id }]))
}
```

```ts
// client/src/cli/commands/status.ts
import { loadConfig } from '../../config'
import { openDb } from '../../store/db'
import { createStore } from '../../store'
import type { ParsedCommand } from '../index'

export async function cmdStatus(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  const cfg = loadConfig(env, {}, { out: cmd.out })
  const store = createStore(openDb(cfg.dbPath))
  const c = store.counts()
  console.log(`pending=${c.pending} running=${c.running} completed=${c.completed} failed=${c.failed} skipped=${c.skipped} dead=${c.dead}`)
  for (const f of store.failures()) console.log(`  [${f.status}] ${f.meeting_id} ${f.asset_type} ${f.remote_id}: ${f.last_error ?? ''}`)
  return 0
}
```

`bin/mde.ts`：
```ts
#!/usr/bin/env bun
import { parseArgs } from '../src/cli'
import { cmdExecute } from '../src/cli/commands/execute'
import { cmdStatus } from '../src/cli/commands/status'
// ... 其余命令 import
const argv = process.argv.slice(2)
try {
  const cmd = parseArgs(argv)
  const env = process.env
  const dispatch: Record<string, (c: any, e: any) => Promise<number>> = {
    execute: cmdExecute, status: cmdStatus, /* run, discover, list, get, retry */
    help: async () => { console.log('mde <run|discover|list|get|execute|status|retry> [flags]'); return 0 },
  }
  const fn = dispatch[cmd.command] ?? dispatch.help!
  process.exit(await fn(cmd, env))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
```

- [ ] **Step 4: 运行解析测试 + typecheck + Commit**

```bash
cd client && bun test tests/cli/parse.test.ts && bun run typecheck
git add client/bin/mde.ts client/src/cli/ client/tests/cli/parse.test.ts
git commit -m "feat(client): cli 命令分发 + 装配（T10）"
```

---

## Task 11: 端到端测试 + README

**Files:**
- Create: `client/tests/e2e/flow.test.ts`、`client/README.md`
- Test: 自身即测试

**Interfaces:**
- Consumes: 全部。用 `Bun.serve` 起一个**假网关**（含 auth/service-token、meetings、assets、download-url），驱动 `main()` 走完整闭环。

- [ ] **Step 1: 写端到端测试** — `client/tests/e2e/flow.test.ts`

必测用例（spec §16）：
```ts
import { expect, test } from 'bun:test'
// 起假网关：/auth/service-token 发 token；/api/v1/meetings 返一场；
// /api/v1/meetings/:id/assets 返 video(state3) + ai_transcript(不在清单)；
// /api/v1/assets/:id/download-url 返本地文件 URL（支持 Range）
// 驱动 cmdRun → 断言 video 落地、ai_transcript 进探测；
// 二次调 cmdExecute → 断言零重复下载（幂等）；
// 断点续传：下一半停 → 重跑续完；
// 探测就绪：第二轮 assets 返回 ai_transcript(state3) → cmdExecute 补下载完成。
```
（完整用例覆盖 §16 的 10 条：断点续传 / 链接过期 / 416 / 幂等 / 崩溃恢复 / 31天切分 / 探测超时 / 探测就绪 / 令牌过期 / 默认资产集。逐条构造假网关行为 + 临时目录断言。）

- [ ] **Step 2: 运行端到端全绿**

Run: `cd client && bun test`
Expected: 全部 PASS

- [ ] **Step 3: 写 README（安装/配置/命令/cron 示例）**

`client/README.md`：涵盖 env 三项配置、`mde` 各命令、cron 反复跑覆盖延迟 AI 纪要的示例、默认资产集与 `--assets` 说明。

- [ ] **Step 4: 全量 + typecheck + Commit**

```bash
cd client && bun test && bun run typecheck
git add client/tests/e2e/ client/README.md
git commit -m "test(client): 端到端 10 条必测用例 + README（T11）"
```

---

## 最终整体审查

11 个任务合并后，对 `client/` 做一次 opus 全分支审查，重点验证接缝：
- **续传的事实源一致性**：downloader 信 `.part` 大小、store 的 `bytes_written` 仅展示——两者是否在崩溃场景下不打架；
- **探测→入队接缝**：runProbes 补建的任务是否被 runExecutor 正确领取下载；
- **认证透明续期**：长任务中途 401 是否在 gateway 层被吸收，executor/downloader 无感；
- **字段驱动**：未知 asset_type（未来引擎）是否被 store/executor 安全处理（不崩、走通用文件名）；
- **ProbeRow / ProbeKey 键名适配**（T9 标注处）是否一致；
- 全量 `bun test` + `bun run typecheck` 干净。

审查通过走 superpowers:finishing-a-development-branch 收尾。

---

## Self-Review

**Spec 覆盖**：spec 各节 → 任务：§5 资产类型/默认集→T1；§6.1 数据模型→T4；§6.2 状态机/租约→T4；§7 认证→T6；§8 并发→T9；§9 探测→T2(判定)+T7(建)+T9(重查);§10 断点续传→T8;§10.1 校验→T8;§11 存储布局/接口→T5+T9(路径拼装);§12 CLI→T10;§13 错误处理→T6/T8/T9;§16 测试→各任务+T11。无遗漏。

**Placeholder 扫描**：无 TBD/TODO。计划编写时发现的两处跨任务缺口已归入拥有者任务（`markSkippedByKey` 并入 T4 store、`readPart` 并入 T5 storage），Batch 2 直接消费、无需回补。仅剩一处实现者注记：T9 中 `ProbeRow`（下划线字段名）与 `ProbeKey`（驼峰）键名适配——已在 T9 代码后显式标注，非占位。

**类型一致性**：`AssetKey`/`asset_type`（平台字段名）双表示贯穿；`Store` 方法签名在 T4 定义、T7/T9 消费一致；`ASSET_WAIT_CAP_SEC`/`FIELD_TO_ASSET_KEY` 在 T1 定义、T7/T9 引用；`DownloadTask`/`DownloadResult` T8 定义、T9 消费。已核对无 T4-定义-T9-改名 类问题。

**冲突复核**：Batch 1 五任务落点 {domain/window,filename,readiness}/{config}/{store}/{storage}/{gateway} 两两不相交，可 worktree 隔离并行。`markSkippedByKey`/`readPart` 已并入 T4/T5，故 Batch 2（T7 discovery / T8 downloader）落点为 {discovery}/{downloader}，同样不相交、可并行——两者只**读** store/storage 接口，不改。T9→T10→T11 各自单独。全链路无跨任务写冲突。

---

## 实现期偏离与修正（执行后回填）

M3 落地过程中经历多轮 review（含终审），以下改动在实现期发生但计划正文未回填；本节统一补记，作为计划与 `client/` 实际交付代码之间的权威差异记录。

| # | 涉及任务 | 计划原文 | 实际交付 | 原因 |
|---|---|---|---|---|
| 1 | T1 `domain/types.ts` | `parseAssetKeys` 用 `k in ASSET_KEY_TO_FIELD` 判键是否合法 | 改用 `Object.hasOwn(ASSET_KEY_TO_FIELD, k)` | `in` 会走原型链，`constructor`/`__proto__`/`toString` 等原型属性会被静默当作合法资产键放行，违反 spec「未知键报错、不静默忽略」的约束 |
| 2 | T6 `gateway/client.ts` | `GatewayClient` 接口摘要列出 `getMeeting` 方法 | 删除该方法，未进入接口与实现 | 正文代码、全部测试、所有下游消费者均未使用它——按 ID/会议号取会议统一走 `listMeetings({kind:'id'\|'code'})`；`getMeeting` 是未消费的赘生接口项 |
| 3 | T4 `store/index.ts` | `markSkippedByKey` 无状态守卫，直接把匹配行置 skipped | UPDATE 语句加 `AND status NOT IN ('completed','running')` | 同一 `asset_type` 下可有多个 `remote_id`（多段录制）；按类整体跳过会把已完成的段翻回 skipped、丢失已下载成果。排除 `running` 同时消除与执行池 `markCompleted` 的竞态 |
| 4 | T4 `store/index.ts` | `ProbeRow.state` 字段类型为裸 `string` | 类型化为 `ProbeState`（复用 T1 定义的 `'probing' \| 'resolved' \| 'abandoned'`） | 兑现计划自己 prose 里写的「consumes ProbeState」承诺，消除潜在的越界字符串风险 |
| 5 | T7 `discovery/index.ts` | `DiscoveryDeps` 含 `now: () => number` 字段 | 删除该字段；`discover` 全程只用调用方传入的显式 `now: number` 参数 | `discover` 从未调用 `deps.now`，是死字段；保留会造成「两个时钟源」的误导，删除后单一时钟源、语义更清晰 |
| 6 | T7 `discovery/index.ts` | 用 `presentByField` 之类的 Map 把同 `asset_type` 的多个资产塌缩为最后一个，就绪时只建一个任务 | 改为 `assets.filter(...)` 取该类型全部资产；ready 分支对每个 `remote_id` 各建一个任务；类型级 verdict 仍用代表段 `present[0]` 判定 | 同一会议的同一 `asset_type` 可能有多段录制（多个 `remote_id`），Map 塌缩会静默丢弃除最后一段外的所有段 |
| 7 | T4/T7/T9（`store/db.ts`、`store/index.ts`、`discovery/index.ts`、`executor/index.ts`） | executor 的 `assetId(row)` 用 `${meeting_id}:${remote_id}:${asset_type}:0` 自行重构下载用 assetId，网关下发的自包含 assetId 未落库 | `assets` 表新增可空 `asset_id TEXT` 列；`AssetUpsert`/`AssetRow` 新增 `assetId`/`asset_id`；`upsertAsset` 用 `COALESCE(excluded.asset_id, assets.asset_id)` 落库；discovery 两处 `upsertAsset` 都传 `assetId: a.assetId`（含 `runProbes` 就绪分支）；executor `handleOne` 改为 `assetId: row.asset_id ?? assetId(row)`（旧重构逻辑保留作回退） | 自行重构的 ID 对真实网关取不到下载地址，因为 `meeting_id ≠ meetingRecordId`（网关侧会议记录 ID 与业务 meeting_id 不同源）。改为持久化网关自包含的真实 `assetId` 并优先使用，彻底解决 |
| 8 | T4/T10（`store/db.ts` `openDb`） | `openDb` 直接 `new Database(path, { create: true })`，从不为 `dbPath` 创建父目录 | `openDb` 在非 `:memory:` 路径时先 `mkdirSync(dirname(path), { recursive: true })` | 全新 `--out` 目标首次运行时其 `.mde` 父目录尚不存在，会直接崩溃。单元测试全程用 `:memory:`，从不走文件路径，因此 42 个测试全绿也未暴露此问题；直到 T10 装配、真跑一次 CLI 冒烟才发现 |
| 9 | T1/T4/T9（`domain/types.ts`、`store/index.ts`、`executor/index.ts`） | `assetKeyToFilename(key, remoteId, ext)` 不含序号；文本类文件名固定（如 `transcript.pdf`，忽略 remoteId） | `assetKeyToFilename` 新增 `ordinal = 1` 参数：仅当该类文件名不含 remoteId（`FILENAME_HAS_REMOTE_ID[key]` 为假）且 `ordinal > 1` 时追加 `_<ordinal>` 消歧；`store` 新增 `siblingRank(row)` 计算同 `(meeting, sub_meeting, asset_type)` 兄弟中的 1-based 序号；executor `buildRelPath` 调用 `siblingRank` 取 `ordinal` 传入 | 全分支终审发现：discovery 对所有资产类型都按 `remote_id` 各建一个任务（改动 6 的结果），但文本类文件名固定不含 remoteId——同一会议下同一文本类 ≥2 段文件会互相覆盖，或并发下载时 `.part` 文件损坏。单段场景不受影响（ordinal 恒为 1，文件名保持不变） |

前两类改动（parseAssetKeys 的 `Object.hasOwn`、`GatewayClient.getMeeting` 的删除）与改动 3～6（`markSkippedByKey` 状态守卫、`ProbeState` 类型化、`DiscoveryDeps` 死字段清理、discovery 多段塌缩修正）都属于计划编写期的疏漏：正确解法由既有契约（spec 的「不静默忽略」约束、`GatewayClient` 的实际消费者、多段录制的数据模型、T1 已定义的 `ProbeState`）唯一确定，因此在执行中发现后直接修正并原地回同步。改动 7（assetId 持久化）与改动 8（`openDb` 建父目录）则不同：它们是「测试替身比真实依赖更宽容」暴露出的集成缺陷——单测用的假网关/`:memory:` 数据库从不触发这两条路径上的真实约束，只有装配阶段对接近似真实的环境才会失败。改动 9（文件名序号消歧）又是另一类：它不是遗漏，而是改动 6（多段全取）修复后新引入、且只有站在全部改动交叉点的全分支视角才能看见的次生问题。
