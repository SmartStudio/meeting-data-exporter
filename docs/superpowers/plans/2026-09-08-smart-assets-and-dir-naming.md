# 资产分类对齐腾讯产品 + 归档目录去中文 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 资产从 8 类收成与腾讯下载菜单一致的 6 类（逐字稿 / 时间轴 / 纪要 / 录像 / 音频 / 优化版逐字稿），纪要与时间轴改走不要 STS 的智能接口；归档目录名去掉中文主题段，并把存量目录与库里的路径一次性改过来。

**Architecture:** 网关新增 `src/tencent/smart.ts` 封装 `/v1/smart/minutes` 与 `/v1/smart/chapters`；`catalog` 在列资产时探测这两类是否存在、在签发下载地址时把正文编成 `data:` URL 返回，引擎 downloader 零改动。引擎的 `AssetKey` 联合改成 6 项，`meetingDirPath` 去掉主题段；一次性脚本改名存量目录并同事务改三张表的路径列。控制台纪要 tab 去掉模板切换，时间轴 tab 开始显示真章节。

**Tech Stack:** Bun + TypeScript（网关 `src/`、引擎 `packages/engine/`、CLI `client/`）、MySQL 8（`tests/helpers/testdb.ts` 需要 `TEST_DATABASE_URL`）、React 19 + Vite + vitest（`console/`）。

**Spec:** `docs/superpowers/specs/2026-09-08-smart-assets-and-dir-naming-design.md`

## Global Constraints

- 资产名只用引擎的 `AssetKey`（`video / audio / transcript / ai_transcript / ai_minutes / chapters`）与网关的 `asset_type`。**禁止**引入原型短名 `summary / aitr / digest`（spec §6.2、dev-plan §5 C7）。
- 中文名**全项目唯一一份**在 `src/domain/asset-labels.ts`，控制台的 `ASSET_LABEL` 逐字抄它。本次统一为：录像 / 音频 / 逐字稿 / 逐字稿（智能优化版）/ 纪要 / 时间轴。
- 上屏文案不许出现规格章节号、`snake_case` 机器名、端点模板、反引号代码标识（spec §4.4 2026-08-31 条）。
- `migrations/*.sql` 注释里不许出现分号。本计划**不加迁移**。
- 三处 `createCatalog(...)` 接线（`src/index.ts`、`src/worker/index.ts`、`src/worker/scheduler.ts`）必须同时改，漏一处是编译错误而不是运行期静默。
- 提交信息格式照仓库既有：`feat(scope): 中文一句话` / `fix(scope): …` / `refactor(scope): …`，结尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 测试命令：网关 `bun test <path>`；引擎 `cd packages/engine && bun test`；控制台 `cd console && bun run typecheck && bun run test`；全量 `bun test && bun run typecheck`。凡改了 `packages/engine/src`，主工作树跑网关测试前要确认没在 worktree 里（见 memory `worktree-resolves-to-main-engine`）。
- 改名脚本与回填**只在上线阶段（Task 11）对生产跑**，开发期只跑测试库与临时目录。

---

### Task 1: 引擎资产词汇表收成 6 类

**Files:**
- Modify: `packages/engine/src/domain/types.ts:1-90`
- Test: `packages/engine/tests/domain/types.test.ts`

**Interfaces:**
- Produces: `AssetKey = 'video'|'audio'|'transcript'|'ai_transcript'|'ai_minutes'|'chapters'`；`ALL_ASSET_KEYS`、`DEFAULT_ASSET_KEYS`（同 ALL）；`ASSET_KEY_TO_GATEWAY_TYPE.chapters === 'chapters'`；`assetKeyToFilename('ai_minutes', r, 'md') === 'minutes.md'`、`assetKeyToFilename('chapters', r, 'json') === 'chapters.json'`；`ASSET_WAIT_CAP_SEC.chapters === 48h`。

- [ ] **Step 1: 改测试**

`packages/engine/tests/domain/types.test.ts`：
- 第 8 行改为 `expect(DEFAULT_ASSET_KEYS).toEqual(['video', 'audio', 'transcript', 'ai_transcript', 'ai_minutes', 'chapters'])`
- 第 50-57 行那条「映射值必须逐字等于网关 ASSET_TYPES」的 `GATEWAY_ASSET_TYPES` 改为：

```ts
  const GATEWAY_ASSET_TYPES = [
    'video', 'audio', 'meeting_summary', 'ai_meeting_transcripts',
    'ai_minutes', 'chapters',
  ]
```
- 第 71 行 `isTextAssetType('ai_ds_minutes')` 改为 `expect(isTextAssetType('chapters')).toBe(true)`
- 第 100 行 `assetKeyToFilename('ai_topic_minutes', 'rf1', 'docs')` 改为两条：

```ts
  expect(assetKeyToFilename('ai_minutes', 'rf1', 'md')).toBe('minutes.md')
  expect(assetKeyToFilename('chapters', 'rf1', 'json')).toBe('chapters.json')
```
- 文件里其余出现 `ai_topic_minutes` / `ai_speaker_minutes` / `ai_ds_minutes` 的地方（第 41、53 行注释与数组）一并删掉。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/engine && bun test tests/domain/types.test.ts`
Expected: FAIL（`DEFAULT_ASSET_KEYS` 不等、`chapters` 键不存在导致 TS 报错或断言失败）

- [ ] **Step 3: 改 `packages/engine/src/domain/types.ts`**

```ts
export type AssetKey =
  | 'video' | 'audio' | 'transcript' | 'ai_transcript'
  | 'ai_minutes' | 'chapters'

export const ALL_ASSET_KEYS: AssetKey[] = [
  'video', 'audio', 'transcript', 'ai_transcript', 'ai_minutes', 'chapters',
]
/** 纪要与时间轴不再依赖 STS（走 /v1/smart/*，见 src/tencent/smart.ts），默认全要 */
export const DEFAULT_ASSET_KEYS: AssetKey[] = [...ALL_ASSET_KEYS]

export const ASSET_KEY_TO_GATEWAY_TYPE: Record<AssetKey, string> = {
  video: 'video', audio: 'audio', transcript: 'meeting_summary',
  ai_transcript: 'ai_meeting_transcripts', ai_minutes: 'ai_minutes',
  chapters: 'chapters',
}
```

`ASSET_WAIT_CAP_SEC`：

```ts
export const ASSET_WAIT_CAP_SEC: Record<AssetKey, number> = {
  video: H6, audio: H6, transcript: H6,
  ai_transcript: H48, ai_minutes: H48, chapters: H48,
}
```

`FILENAME_BASE` / `FILENAME_HAS_REMOTE_ID`：

```ts
const FILENAME_BASE: Record<AssetKey, (remoteId: string) => string> = {
  video: (r) => `recording_${r}`, audio: (r) => `recording_${r}`,
  transcript: () => 'transcript', ai_transcript: () => 'ai_transcript',
  ai_minutes: () => 'minutes', chapters: () => 'chapters',
}
const FILENAME_HAS_REMOTE_ID: Record<AssetKey, boolean> = {
  video: true, audio: true,
  transcript: false, ai_transcript: false, ai_minutes: false, chapters: false,
}
```

把文件头注释里「八类」「四类纪要」相关的段落改成：`ai_minutes` 与 `chapters` 来自腾讯智能接口（`src/tencent/smart.ts`），文件是网关生成的 `minutes.md` / `chapters.json`；`ASSET_KEY_TO_GATEWAY_TYPE` 那段「平台字段 → 网关 asset_type」表加一行 `（智能接口）→ chapters`。

- [ ] **Step 4: 跑引擎全部测试**

Run: `cd packages/engine && bun test`
Expected: `types.test.ts` PASS；`manifest/index.test.ts`、`discovery/index.test.ts`、`store/index.test.ts` 若引用了被删的键会 FAIL——把它们里的 `ai_topic_minutes` / `ai_speaker_minutes` / `ai_ds_minutes` 改成 `ai_minutes` 或 `chapters`（用 `grep -rn "ai_topic_minutes\|ai_speaker_minutes\|ai_ds_minutes" packages/engine/tests` 找），语义上是「某一类文本资产」的地方用 `ai_minutes`。改完再跑，Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/domain/types.ts packages/engine/tests
git commit -m "refactor(engine): 资产键收成六类——纪要一类、新增时间轴，删三个纪要模板类型"
```

---

### Task 2: 会议目录名去掉主题段

**Files:**
- Modify: `packages/engine/src/domain/filename.ts:27-58`
- Test: `packages/engine/tests/domain/filename.test.ts`、`packages/engine/tests/manifest/index.test.ts:22-23`、`tests/worker/e2e.test.ts:63-64`

**Interfaces:**
- Produces: `cleanDirName(date: string, hhmm: string, code: string): string` → `'<date>_<hhmm>_<code>'`；`meetingDirPath(m, fallbackCode)` → `'<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<code>'`；`cleanSubjectSegment` 原样保留（`{标题}` 占位符用）。

- [ ] **Step 1: 改 `filename.test.ts` 的前三条**

```ts
test('目录名 = 日期_时分_会议号，不含主题', () => {
  expect(cleanDirName('2026-07-15', '1430', '88123456')).toBe('2026-07-15_1430_88123456')
})
test('会议号里的非法字符替换为 -', () => {
  expect(cleanDirName('2026-07-15', '1430', 'a/b:c')).toBe('2026-07-15_1430_a-b-c')
})
test('会议号为空时兜底 untitled', () => {
  expect(cleanDirName('2026-07-15', '1430', '')).toBe('2026-07-15_1430_untitled')
})
```
删掉原来「按字素簇截断 60 字符」那条（截断只属于主题段，`cleanSubjectSegment` 的三条用例仍然覆盖它）。另加一条：

```ts
test('meetingDirPath：UTC 年月 + 日期_时分_会议号，会议号缺失顶 fallbackCode', () => {
  const m = { subject: '季度产品/评审：Q3', startTime: Date.UTC(2026, 6, 15, 14, 30) / 1000, meetingCode: null }
  expect(meetingDirPath(m, 'mid-1')).toBe('2026/07/2026-07-15_1430_mid-1')
  expect(meetingDirPath({ ...m, meetingCode: '881-123-40' }, 'mid-1')).toBe('2026/07/2026-07-15_1430_881-123-40')
})
```
把 `import` 补上 `meetingDirPath`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/engine && bun test tests/domain/filename.test.ts`
Expected: FAIL（`cleanDirName` 参数个数不同、输出含主题）

- [ ] **Step 3: 改 `filename.ts`**

```ts
/** 目录名：<date>_<hhmm>_<code>。主题不进目录名——它在同目录 meeting.json 的 subject 里 */
export function cleanDirName(date: string, hhmm: string, code: string): string {
  let c = (code ?? '').replace(ILLEGAL, '-').trim()
  if (c === '') c = 'untitled'
  return `${date}_${hhmm}_${c}`
}
```
`meetingDirPath` 里那行改为 `const dir = cleanDirName(`${yyyy}-${mm}-${dd}`, hhmm, m.meetingCode ?? fallbackCode)`。`MeetingDirInfo.subject` 字段保留（`{标题}` 模板与 `meeting.json` 还用它）。

文件头 `cleanSubjectSegment` 的注释里「`cleanDirName` 把它和 `date_hhmm_主题_code` 那个完整格式焊在一起」这句改成「本地目录名自 2026-09-08 起不含主题（中间层带中文在跨系统挂载时编码不稳，见 spec 2.4），本函数只服务归档模板的 `{标题}` 占位符」。

- [ ] **Step 4: 改另外两处手算目录常量**

`packages/engine/tests/manifest/index.test.ts:23` 与 `tests/worker/e2e.test.ts:64`：

```ts
const DIR = '2026/08/2026-08-20_0930_881-123-40'
```
上一行注释同步改为「手算：2026 / 08 / 2026-08-20_0930_<会议号>」。

- [ ] **Step 5: 跑相关测试**

Run: `cd packages/engine && bun test && cd ../.. && bun test tests/worker/e2e.test.ts tests/worker/archive.test.ts tests/policy/archive-dir.test.ts`
Expected: 全 PASS（`archive-dir.test.ts` 用的是 `cleanSubjectSegment`，不受影响；若 `e2e.test.ts` 还因为 Task 3 之前的类型名失败，先记下，Task 3 结束后复跑）

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/domain/filename.ts packages/engine/tests/domain/filename.test.ts packages/engine/tests/manifest/index.test.ts tests/worker/e2e.test.ts
git commit -m "feat(engine): 会议目录名去掉主题段——中间层不再含中文，主题只在 meeting.json"
```

---

### Task 3: 网关词汇表、中文名、错误码

**Files:**
- Modify: `src/domain/types.ts:1-12`、`src/domain/asset-labels.ts`、`src/tencent/errors.ts:13`
- Test: `tests/tencent/errors.test.ts`、以及全仓 grep 到的旧键测试

**Interfaces:**
- Produces: `ASSET_TYPES = ['video','audio','meeting_summary','ai_meeting_transcripts','ai_minutes','chapters']`；`ASSET_LABEL: Record<AssetKey,string>` 六项；`classify(500182) === 'asset_permanent'`。

- [ ] **Step 1: 加错误码测试**

`tests/tencent/errors.test.ts` 末尾：

```ts
test('500182「未打开智能录制开关」是资产级永久错误：跳过该资产、不重试', () => {
  expect(classify(500182)).toBe('asset_permanent')
  expect(new TencentApiError(500182, 400, '该文件未打开智能录制开关，请联系文件所有者').classification).toBe('asset_permanent')
})
```
（若文件没 import `classify`，补上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tencent/errors.test.ts`
Expected: FAIL（现在是 `transient`）

- [ ] **Step 3: 改三处源码**

`src/tencent/errors.ts`：

```ts
/**
 * 资产本身不存在，跳过该资产但不影响其他。
 * 500182「该文件未打开智能录制开关」：/v1/smart/minutes、/v1/smart/chapters 对没开
 * 智能录制的录制文件返回它（2026-09-08 实调）。原先落入 transient，一次探测白重试 5 次。
 */
const ASSET_PERMANENT = new Set([4051, 4049, 500182])
```

`src/domain/types.ts`：

```ts
/** 六类资产。前四类取值来自腾讯 /v1/addresses 响应字段名；后两类是网关自己的名字，
 *  来自 /v1/smart/minutes 与 /v1/smart/chapters（src/tencent/smart.ts） */
export const ASSET_TYPES = [
  'video',
  'audio',
  'meeting_summary',
  'ai_meeting_transcripts',
  'ai_minutes',
  'chapters',
] as const
```

`src/domain/asset-labels.ts`（注释里的「八类」改「六类」，表改为）：

```ts
export const ASSET_LABEL: Record<AssetKey, string> = {
  video: '录像',
  audio: '音频',
  transcript: '逐字稿',
  ai_transcript: '逐字稿（智能优化版）',
  ai_minutes: '纪要',
  chapters: '时间轴',
}
```

- [ ] **Step 4: 全仓清掉旧键**

Run: `grep -rn "ai_topic_minutes\|ai_speaker_minutes\|ai_ds_minutes" src tests client/src --include=*.ts`

对每处：`src/catalog/*` 与 `tests/catalog/*`、`tests/tencent/addresses.test.ts` 留给 Task 5；其余（`tests/policy/access.test.ts`、`tests/policy/stacks.test.ts`、`tests/http/console-grants.test.ts`、`tests/store/archives.test.ts`、`tests/store/contents.test.ts`、`tests/worker/visibility.test.ts`）把旧键替换成 `ai_minutes`（用作「某类文本资产」的地方）；一条断言里同时列多个类型的，改成 `['ai_minutes', 'chapters']` 或按语义删多余项。

- [ ] **Step 5: 类型检查 + 跑受影响测试**

Run: `bun run typecheck 2>&1 | grep -v "src/catalog\|tests/catalog\|tests/tencent/addresses" ; bun test tests/tencent/errors.test.ts tests/policy tests/http/console-grants.test.ts tests/store/archives.test.ts tests/worker/visibility.test.ts`
Expected: typecheck 只剩 `src/catalog` 与其测试的报错（Task 5 修）；列出的测试 PASS。`tests/store/contents.test.ts` 可能因为 md 解析还没做而部分红，留到 Task 7。

- [ ] **Step 6: Commit**

```bash
git add src/domain src/tencent/errors.ts tests
git commit -m "refactor(domain): 资产类型收成六类、中文名对齐腾讯菜单，500182 归入资产级永久错误"
```

---

### Task 4: 腾讯智能接口封装 `src/tencent/smart.ts`

**Files:**
- Create: `src/tencent/smart.ts`
- Test: `tests/tencent/smart.test.ts`

**Interfaces:**
- Consumes: `TencentClient.get(path, query, opts)`（`src/tencent/client.ts`）、`TencentApiError`（`src/tencent/errors.ts`）。
- Produces:

```ts
export const SMART_MINUTES_QUOTA_KEY = '/v1/smart/minutes/{record_file_id}'
export interface SmartChapter { chapterId: string; name: string; startMs: number }
export interface SmartApi {
  /** markdown 正文（含待办段）；平台判「没开智能化/未生成」时 null */
  getMinutes(recordFileId: string): Promise<string | null>
  /** 章节列表；同上 null。空列表也当 null */
  getChapters(recordFileId: string): Promise<SmartChapter[] | null>
}
export function createSmartApi(client: TencentClient, operatorId: string): SmartApi
/** chapters.json 的唯一序列化：稳定字段、末尾换行、不含 pic_url */
export function serializeChapters(recordFileId: string, chapters: readonly SmartChapter[]): string
```

- [ ] **Step 1: 写测试 `tests/tencent/smart.test.ts`**

```ts
import { expect, test } from 'bun:test'
import { createSmartApi, serializeChapters, SMART_MINUTES_QUOTA_KEY } from '../../src/tencent/smart'
import { TencentApiError } from '../../src/tencent/errors'
import type { QueryParams } from '../../src/tencent/url'
import type { RequestOptions, TencentClient } from '../../src/tencent/client'

interface Call { path: string; query: QueryParams; opts?: RequestOptions }

function stubClient(handler: (path: string, query: QueryParams) => unknown): { client: TencentClient; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    client: {
      get: async <T,>(path: string, query: QueryParams, opts?: RequestOptions) => {
        calls.push({ path, query, opts })
        return handler(path, query) as T
      },
      post: async <T,>() => ({}) as T,
      currentQps: () => 5,
    },
  }
}

test('getMinutes：路径带 record_file_id，text_type=2，配额键是常量', async () => {
  const { client, calls } = stubClient(() => ({ meeting_minute: { minute: '## 会议摘要\n\n正文', todo: '' } }))
  const api = createSmartApi(client, 'op-1')
  const md = await api.getMinutes('rf-1')
  expect(md).toBe('## 会议摘要\n\n正文\n')
  expect(calls[0]).toEqual({
    path: '/v1/smart/minutes/rf-1',
    query: { operator_id: 'op-1', operator_id_type: 1, text_type: 2 },
    opts: { quotaKey: SMART_MINUTES_QUOTA_KEY },
  })
})

test('getMinutes：todo 非空时拼成「## 待办」段', async () => {
  const { client } = stubClient(() => ({ meeting_minute: { minute: '正文', todo: '- 甲：周五前交方案' } }))
  const md = await createSmartApi(client, 'op-1').getMinutes('rf-1')
  expect(md).toBe('正文\n\n## 待办\n\n- 甲：周五前交方案\n')
})

test('getMinutes：正文为空视为没有（null）', async () => {
  const { client } = stubClient(() => ({ meeting_minute: { minute: '   ', todo: '' } }))
  expect(await createSmartApi(client, 'op-1').getMinutes('rf-1')).toBeNull()
})

test('getMinutes：资产级永久错误（500182）返回 null，不抛', async () => {
  const { client } = stubClient(() => { throw new TencentApiError(500182, 400, '该文件未打开智能录制开关') })
  expect(await createSmartApi(client, 'op-1').getMinutes('rf-1')).toBeNull()
})

test('getMinutes：transient 错误原样抛出', async () => {
  const { client } = stubClient(() => { throw new TencentApiError(190310, 400, '超限') })
  await expect(createSmartApi(client, 'op-1').getMinutes('rf-1')).rejects.toBeInstanceOf(TencentApiError)
})

test('getChapters：query 带 record_file_id，章节名 base64 解码，start_time 转数字', async () => {
  const name = Buffer.from('广告系统数据流转', 'utf8').toString('base64')
  const { client, calls } = stubClient(() => ({
    chapter_list: [
      { chapter_id: 'C1', chapter_name: name, pic_url: 'https://img?sign=x&t=1', start_time: '7837' },
      { chapter_id: 'C2', chapter_name: '', start_time: 'abc' },
    ],
  }))
  const ch = await createSmartApi(client, 'op-1').getChapters('rf-1')
  expect(calls[0]!.path).toBe('/v1/smart/chapters')
  expect(calls[0]!.query).toEqual({ operator_id: 'op-1', operator_id_type: 1, record_file_id: 'rf-1' })
  expect(ch).toEqual([
    { chapterId: 'C1', name: '广告系统数据流转', startMs: 7837 },
    { chapterId: 'C2', name: '', startMs: 0 },
  ])
})

test('getChapters：空列表与 500182 都是 null', async () => {
  const empty = stubClient(() => ({ chapter_list: [] }))
  expect(await createSmartApi(empty.client, 'op-1').getChapters('rf-1')).toBeNull()
  const off = stubClient(() => { throw new TencentApiError(500182, 400, '未打开') })
  expect(await createSmartApi(off.client, 'op-1').getChapters('rf-1')).toBeNull()
})

test('serializeChapters：稳定字段、两空格缩进、末尾换行、不含 pic_url', () => {
  const s = serializeChapters('rf-1', [{ chapterId: 'C1', name: '开场', startMs: 7837 }])
  expect(s).toBe(JSON.stringify({ schemaVersion: 1, recordFileId: 'rf-1', chapters: [{ chapterId: 'C1', name: '开场', startMs: 7837 }] }, null, 2) + '\n')
  expect(s).not.toContain('pic_url')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tencent/smart.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 `src/tencent/smart.ts`**

```ts
import type { TencentClient } from './client'
import { TencentApiError } from './errors'

/**
 * 腾讯「智能录制管理」两个接口的封装：
 *   GET /v1/smart/minutes/{record_file_id}   智能纪要（109458）
 *   GET /v1/smart/chapters?record_file_id=   智能章节（105658）
 *
 * 两者走 AK/SK，**不要 STS-Token**——STS 文档（127651）列的「数据敏感」接口只有
 * 「查询单个录制详情」与「查询录制转写详情」两个。2026-09-08 对生产租户实调验证。
 *
 * 纪要固定用平台默认模板（不传 llm / minute_type）：腾讯录制页的「纪要文本」下载
 * 就是当前模板那一份，这里与它对齐；不提供模板选择（spec 2.3）。
 *
 * 没开智能录制的文件平台回 500182，errors.ts 归为 asset_permanent；这里把
 * asset_permanent 一律翻成 null（「这一类不存在」），其余错误原样抛——client 已经
 * 对 transient 重试过 5 次，再吞就是静默丢数据。
 */

/** 路径带变量，必须给稳定配额键，否则按 path 匹配一次都对不上（见 client.ts） */
export const SMART_MINUTES_QUOTA_KEY = '/v1/smart/minutes/{record_file_id}'

export interface SmartChapter {
  chapterId: string
  /** 平台给的是 base64(UTF-8)，这里已解码 */
  name: string
  /** 章节起点，毫秒 */
  startMs: number
}

export interface SmartApi {
  getMinutes(recordFileId: string): Promise<string | null>
  getChapters(recordFileId: string): Promise<SmartChapter[] | null>
}

interface RawMinutes { meeting_minute?: { minute?: string; todo?: string } }
interface RawChapters {
  chapter_list?: Array<{ chapter_id?: string; chapter_name?: string; pic_url?: string; start_time?: string }>
}

function isUnavailable(err: unknown): boolean {
  return err instanceof TencentApiError && err.classification === 'asset_permanent'
}

function decodeName(b64: string | undefined): string {
  if (!b64) return ''
  return Buffer.from(b64, 'base64').toString('utf8')
}

export function createSmartApi(client: TencentClient, operatorId: string): SmartApi {
  const op = { operator_id: operatorId, operator_id_type: 1 }
  return {
    async getMinutes(recordFileId) {
      let res: RawMinutes
      try {
        res = await client.get<RawMinutes>(
          `/v1/smart/minutes/${recordFileId}`,
          { ...op, text_type: 2 },
          { quotaKey: SMART_MINUTES_QUOTA_KEY },
        )
      } catch (err) {
        if (isUnavailable(err)) return null
        throw err
      }
      const minute = (res.meeting_minute?.minute ?? '').trim()
      if (minute === '') return null
      const todo = (res.meeting_minute?.todo ?? '').trim()
      return todo === '' ? `${minute}\n` : `${minute}\n\n## 待办\n\n${todo}\n`
    },

    async getChapters(recordFileId) {
      let res: RawChapters
      try {
        res = await client.get<RawChapters>('/v1/smart/chapters', { ...op, record_file_id: recordFileId })
      } catch (err) {
        if (isUnavailable(err)) return null
        throw err
      }
      const out: SmartChapter[] = []
      for (const c of res.chapter_list ?? []) {
        if (!c.chapter_id) continue
        const startMs = Number(c.start_time ?? '')
        out.push({ chapterId: c.chapter_id, name: decodeName(c.chapter_name), startMs: Number.isFinite(startMs) ? startMs : 0 })
      }
      return out.length === 0 ? null : out
    },
  }
}

/**
 * `chapters.json` 的唯一序列化。**不含 pic_url**：那个链接带签名与时间戳，两次调用
 * 字节不同，会让「列资产」与「下载」两次拿到的内容对不上。
 */
export function serializeChapters(recordFileId: string, chapters: readonly SmartChapter[]): string {
  return JSON.stringify({ schemaVersion: 1, recordFileId, chapters }, null, 2) + '\n'
}
```

- [ ] **Step 4: 跑测试**

Run: `bun test tests/tencent/smart.test.ts`
Expected: PASS（8 条）

- [ ] **Step 5: Commit**

```bash
git add src/tencent/smart.ts tests/tencent/smart.test.ts
git commit -m "feat(tencent): 封装智能纪要与智能章节接口——AK/SK 直调，不要 STS"
```

---

### Task 5: catalog 改走智能接口，`data:` URL 交付正文

**Files:**
- Modify: `src/catalog/assets.ts`、`src/catalog/index.ts`
- Test: `tests/catalog/assets.test.ts`、`tests/catalog/index.test.ts`、`tests/tencent/addresses.test.ts`

**Interfaces:**
- Consumes: `SmartApi`、`serializeChapters`（Task 4）。
- Produces:

```ts
// catalog/assets.ts
export interface SmartPresence { minutes: boolean; chapters: boolean }
export function extractAssets(meetingId, subMeetingId, meetingRecordId, detail: RawDetail, allowDownload: boolean, smart: SmartPresence): Asset[]
// catalog/index.ts
export interface CatalogDeps { addressesApi: AddressesApi; smartApi: SmartApi; stsManager: StsManager; now: () => number }
```
assetId：`<rec>:<file>:ai_minutes:md`、`<rec>:<file>:chapters:json`；`resolveDownloadUrl` 对这两类返回 `data:` URL，`expiresAt = now + 300`。

- [ ] **Step 1: 改 `tests/catalog/assets.test.ts`**

fixture `detail` 删掉 `ai_minutes / ai_topic_minutes / ai_speaker_minutes / ai_ds_minutes` 四个字段。用例改为：

```ts
const NONE = { minutes: false, chapters: false }
const BOTH = { minutes: true, chapters: true }

test('提取六类资产：四类来自 addresses 详情，纪要与时间轴由 smart 探测结果决定', () => {
  const assets = extractAssets('m1', '', 'rec-1', detail, true, BOTH)
  expect(assets.map((a) => a.assetType).sort()).toEqual([
    'ai_meeting_transcripts', 'ai_minutes', 'audio', 'chapters', 'meeting_summary', 'video',
  ])
})

test('smart 探测为否时不产生纪要 / 时间轴', () => {
  const types = extractAssets('m1', '', 'rec-1', detail, true, NONE).map((a) => a.assetType)
  expect(types).not.toContain('ai_minutes')
  expect(types).not.toContain('chapters')
})

test('纪要与时间轴的 assetId 末段固定为 md / json，file_type 同值', () => {
  const assets = extractAssets('m1', '', 'rec-1', detail, true, BOTH)
  const minutes = assets.find((a) => a.assetType === 'ai_minutes')!
  const chapters = assets.find((a) => a.assetType === 'chapters')!
  expect(minutes.assetId).toBe('rec-1:f1:ai_minutes:md')
  expect(minutes.fileType).toBe('md')
  expect(minutes.bytesExpected).toBeNull()
  expect(chapters.assetId).toBe('rec-1:f1:chapters:json')
  expect(chapters.fileType).toBe('json')
})
```
原「assetId 唯一且含字段名与定位键」用例的 `'rec-1:f1:ai_minutes:txt'` 改成 `'rec-1:f1:meeting_summary:txt'`；「缺 file_type 回退 idx」用例把 `ai_minutes: [...]` 改成 `meeting_summary: [{ download_address: 'a' }]`、断言 `'rec-1:f1:meeting_summary:idx0'`；所有 `extractAssets(...)` 调用补第六个参数。

- [ ] **Step 2: 改 `tests/catalog/index.test.ts`**

两条既有用例（数组顺序、历史下标）把 `ai_minutes` 换成 `ai_meeting_transcripts`（它仍走 51180 + STS，是这两条用例真正要钉的路径），`createCatalog` 的 deps 加 `smartApi: NO_SMART`。文件顶部加：

```ts
import type { SmartApi } from '../../src/tencent/smart'
const NO_SMART: SmartApi = { getMinutes: async () => null, getChapters: async () => null }
```
新增：

```ts
test('listAssets：allow_download 时探测 smart 两类，探测结果决定是否列出', async () => {
  const calls: string[] = []
  const catalog = createCatalog({
    addressesApi: {
      listByRecordId: async () => [{ record_file_id: 'f1', download_address: 'https://cos/v.mp4', download_address_file_type: 'mp4', allow_download: true }],
      detailByFileId: async () => ({ record_file_id: 'f1' }),
    } as never,
    smartApi: {
      getMinutes: async (id) => { calls.push(`minutes:${id}`); return '# 纪要\n' },
      getChapters: async (id) => { calls.push(`chapters:${id}`); return null },
    },
    stsManager: { getToken: async () => { throw new StsTokenUnavailableError() } } as never,
    now: () => 1_700_000_000,
  })
  const assets = await catalog.listAssets({ meetingId: 'm1', subMeetingId: '', meetingRecordId: 'rec1' } as never)
  expect(calls).toEqual(['minutes:f1', 'chapters:f1'])
  expect(assets.map((a) => a.assetType).sort()).toEqual(['ai_minutes', 'video'])
})

test('listAssets：allow_download=false 时不探测 smart', async () => {
  let called = 0
  const catalog = createCatalog({
    addressesApi: {
      listByRecordId: async () => [{ record_file_id: 'f1', download_address: 'https://cos/v.mp4', allow_download: false }],
      detailByFileId: async () => ({ record_file_id: 'f1' }),
    } as never,
    smartApi: { getMinutes: async () => { called++; return 'x' }, getChapters: async () => { called++; return null } },
    stsManager: { getToken: async () => { throw new StsTokenUnavailableError() } } as never,
    now: () => 1_700_000_000,
  })
  const assets = await catalog.listAssets({ meetingId: 'm1', subMeetingId: '', meetingRecordId: 'rec1' } as never)
  expect(called).toBe(0)
  expect(assets.map((a) => a.assetType)).toEqual(['video'])
})

test('resolveDownloadUrl：纪要返回 data: URL，正文 base64 可还原', async () => {
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [], detailByFileId: async () => ({ record_file_id: 'f1' }) } as never,
    smartApi: { getMinutes: async () => '## 会议摘要\n\n正文\n', getChapters: async () => null },
    stsManager: { getToken: async () => { throw new StsTokenUnavailableError() } } as never,
    now: () => 1_700_000_000,
  })
  const { url, expiresAt } = await catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:ai_minutes:md', meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes',
    recordFileId: 'f1', fileType: 'md', bytesExpected: null, allowDownload: true,
  })
  expect(url.startsWith('data:text/markdown;charset=utf-8;base64,')).toBe(true)
  expect(await (await fetch(url)).text()).toBe('## 会议摘要\n\n正文\n')
  expect(expiresAt).toBe(1_700_000_000 + 300)
})

test('resolveDownloadUrl：时间轴返回 chapters.json 的 data: URL', async () => {
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [], detailByFileId: async () => ({ record_file_id: 'f1' }) } as never,
    smartApi: { getMinutes: async () => null, getChapters: async () => [{ chapterId: 'C1', name: '开场', startMs: 7837 }] },
    stsManager: { getToken: async () => { throw new StsTokenUnavailableError() } } as never,
    now: () => 1_700_000_000,
  })
  const { url } = await catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:chapters:json', meetingId: 'm1', subMeetingId: '', assetType: 'chapters',
    recordFileId: 'f1', fileType: 'json', bytesExpected: null, allowDownload: true,
  })
  expect(url.startsWith('data:application/json;charset=utf-8;base64,')).toBe(true)
  expect(JSON.parse(await (await fetch(url)).text())).toEqual({ schemaVersion: 1, recordFileId: 'f1', chapters: [{ chapterId: 'C1', name: '开场', startMs: 7837 }] })
})

test('resolveDownloadUrl：smart 说没有时抛 AssetUrlMissingError，不碰 STS', async () => {
  let sts = 0
  const catalog = createCatalog({
    addressesApi: { listByRecordId: async () => [], detailByFileId: async () => ({ record_file_id: 'f1' }) } as never,
    smartApi: { getMinutes: async () => null, getChapters: async () => null },
    stsManager: { getToken: async () => { sts++; return 't' } } as never,
    now: () => 1_700_000_000,
  })
  await expect(catalog.resolveDownloadUrl({
    assetId: 'rec1:f1:ai_minutes:md', meetingId: 'm1', subMeetingId: '', assetType: 'ai_minutes',
    recordFileId: 'f1', fileType: 'md', bytesExpected: null, allowDownload: true,
  })).rejects.toBeInstanceOf(AssetUrlMissingError)
  expect(sts).toBe(0)
})
```
import 里补 `AssetUrlMissingError`、`StsTokenUnavailableError`（后者从 `../../src/sts/manager`）。

`tests/tencent/addresses.test.ts`：所有 `createCatalog({...})` 的 deps 加 `smartApi: NO_SMART`（同上定义），旧键出现处按 Task 3 Step 4 的规则改（这里的语义是「STS 路径的纪要类」→ 改成 `ai_meeting_transcripts`）。

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/catalog tests/tencent/addresses.test.ts`
Expected: FAIL（`smartApi` 不在 deps、`extractAssets` 少参数、`chapters` 类型不存在）

- [ ] **Step 4: 改 `src/catalog/assets.ts`**

```ts
export interface RawDetail {
  record_file_id: string
  download_address?: string
  download_address_file_type?: string
  audio_address?: string
  audio_address_file_type?: string
  meeting_summary?: RawFileEntry[]
  ai_meeting_transcripts?: RawFileEntry[]
}

/** 智能接口的探测结果：这个 record_file 有没有纪要 / 章节（catalog/index.ts 调 smartApi 得出） */
export interface SmartPresence {
  minutes: boolean
  chapters: boolean
}

/** 数组型字段 → 资产类型。纪要与时间轴不在这里——它们来自 /v1/smart/*，见下面 SMART_ASSETS */
const ARRAY_FIELDS: Array<[keyof RawDetail, AssetType]> = [
  ['meeting_summary', 'meeting_summary'],
  ['ai_meeting_transcripts', 'ai_meeting_transcripts'],
]

/**
 * 智能接口产出的两类：文件是网关自己生成的（minutes.md / chapters.json），
 * 所以 selector 与 file_type 都是固定值，没有「平台数组顺序」的问题。
 */
const SMART_ASSETS: Array<[keyof SmartPresence, AssetType, string]> = [
  ['minutes', 'ai_minutes', 'md'],
  ['chapters', 'chapters', 'json'],
]
```
`extractAssets` 签名加 `smart: SmartPresence`；`allow_download` 那行注释改为「ai_meeting_transcripts 在 allow_download=false 时平台返回空」，判定改为 `const allowed = assetType === 'ai_meeting_transcripts' ? allowDownload : true`；循环后加：

```ts
  for (const [flag, assetType, ext] of SMART_ASSETS) {
    // bytesExpected 留 null：正文两次调用之间可能被平台重新生成，不能拿列资产时的长度卡下载
    if (smart[flag]) push(assetType, ext, ext, true)
  }
```
文件头「六类文本资产」的注释改为「两类 addresses 文本资产 + 两类智能接口资产」。

- [ ] **Step 5: 改 `src/catalog/index.ts`**

- import 加 `import { serializeChapters, type SmartApi } from '../tencent/smart'`。
- `AI_TYPES` 改名 `STS_TYPES = new Set<AssetType>(['ai_meeting_transcripts'])`，注释：只剩优化版逐字稿走 51180。
- 加常量 `const SMART_URL_TTL_SEC = 5 * 60`（`data:` URL 没有真实时效，给一个与详情链接同量级的数，让引擎的续签逻辑有个明确的到期点）。
- `CatalogDeps` 加 `smartApi: SmartApi`。
- `UrlSource` 与 `mergeDetail` 删掉四个纪要字段，`mergeDetail` 只留 `ai_meeting_transcripts: aiDetail?.ai_meeting_transcripts`。
- 加辅助：

```ts
function dataUrl(mime: string, text: string): string {
  return `data:${mime};charset=utf-8;base64,${Buffer.from(text, 'utf8').toString('base64')}`
}

/** 每个 record_file 两次调用；allow_download=false 时平台对所有智能内容一律回空，不白打 */
async function probeSmart(api: SmartApi, recordFileId: string, allowDownload: boolean): Promise<SmartPresence> {
  if (!allowDownload) return { minutes: false, chapters: false }
  const minutes = (await api.getMinutes(recordFileId)) !== null
  const chapters = (await api.getChapters(recordFileId)) !== null
  return { minutes, chapters }
}
```
（`SmartPresence` 从 `./assets` import。）
- `listAssets` 循环内：

```ts
        const allowDownload = file.allow_download ?? true
        const smart = await probeSmart(deps.smartApi, file.record_file_id, allowDownload)
        out.push(...extractAssets(meeting.meetingId, meeting.subMeetingId, meeting.meetingRecordId, merged, allowDownload, smart))
```
- `resolveDownloadUrl` 开头（在 STS 分支之前）：

```ts
      if (asset.assetType === 'ai_minutes') {
        const md = await deps.smartApi.getMinutes(asset.recordFileId)
        if (md === null) throw new AssetUrlMissingError(asset.assetId)
        return { url: dataUrl('text/markdown', md), expiresAt: now + SMART_URL_TTL_SEC }
      }
      if (asset.assetType === 'chapters') {
        const chapters = await deps.smartApi.getChapters(asset.recordFileId)
        if (chapters === null) throw new AssetUrlMissingError(asset.assetId)
        return { url: dataUrl('application/json', serializeChapters(asset.recordFileId, chapters)), expiresAt: now + SMART_URL_TTL_SEC }
      }
```
在 `Catalog` 接口 `resolveDownloadUrl` 的文档注释里写明：纪要与时间轴返回的是 **`data:` URL**（正文内嵌），引擎 downloader 与 CLI 对它做普通 `fetch` 即可；`data:` 不支持 Range，downloader 收到 200 时会丢弃 `.part` 重下，正文只有几 KB，无害。

- [ ] **Step 6: 跑测试与类型检查**

Run: `bun test tests/catalog tests/tencent && bun run typecheck 2>&1 | grep -v "src/index.ts\|src/worker" || true`
Expected: 测试 PASS；typecheck 只剩三处接线报 `smartApi` 缺失（Task 6 修）。

- [ ] **Step 7: Commit**

```bash
git add src/catalog tests/catalog tests/tencent/addresses.test.ts
git commit -m "feat(catalog): 纪要与时间轴改走智能接口，下载地址以 data: URL 内嵌正文"
```

---

### Task 6: 三处接线 + 假腾讯服务 + 进程内 source 用例

**Files:**
- Modify: `src/index.ts:66-83`、`src/worker/index.ts:630-650`、`src/worker/scheduler.ts:934-950`、`tests/fake-tencent/server.ts:36-50,186-200`
- Test: `tests/worker/source-inproc.test.ts:160-200`、`tests/worker/e2e.test.ts`

- [ ] **Step 1: 三处接线**

三个文件里 `const addressesApi = createAddressesApi(...)` 下一行各加：

```ts
  const smartApi = createSmartApi(tencentClient, config.tencent.operatorId)
```
`createCatalog({ addressesApi, stsManager, now })` 改为 `createCatalog({ addressesApi, smartApi, stsManager, now })`。import：`import { createSmartApi } from './tencent/smart'`（worker 两处是 `'../tencent/smart'`）。

`src/worker/index.ts:633-637` 与 `scheduler.ts:936-937` 那段「表里没有有效 token 时 AI 纪要类下载会以 StsTokenUnavailableError 显式失败」的注释改为「只影响优化版逐字稿（ai_meeting_transcripts）；纪要与时间轴走智能接口，不依赖 STS」。`src/sts/manager.ts` 的 `StsTokenUnavailableError` 文案改为 `'no valid STS-Token available; the optimised transcript (ai_meeting_transcripts) is temporarily unavailable. Recording, audio, transcript, minutes and chapters are unaffected.'`。

- [ ] **Step 2: 假腾讯服务加两条路由**

`tests/fake-tencent/server.ts`：`FakeTencentState` 加

```ts
  /** GET /v1/smart/minutes/:id 的 markdown；没登记的文件回 500182 */
  smartMinutesByFileId: Map<string, string>
  /** GET /v1/smart/chapters?record_file_id= 的原始章节；没登记的文件回 500182 */
  smartChaptersByFileId: Map<string, Array<{ chapter_id: string; chapter_name: string; start_time: string; pic_url?: string }>>
```
`createFakeTencentState()` 各初始化 `new Map()`。路由，放在 `/v1/addresses/` 分支之后：

```ts
      if (req.method === 'GET' && url.pathname.startsWith('/v1/smart/minutes/')) {
        const fileId = decodeURIComponent(url.pathname.slice('/v1/smart/minutes/'.length))
        const md = state.smartMinutesByFileId.get(fileId)
        if (md === undefined) return Response.json(errorEnvelope(500182, '该文件未打开智能录制开关，请联系文件所有者'), { status: 400 })
        return Response.json({ meeting_minute: { minute: md, todo: '' } })
      }

      if (req.method === 'GET' && url.pathname === '/v1/smart/chapters') {
        const fileId = url.searchParams.get('record_file_id') ?? ''
        const list = state.smartChaptersByFileId.get(fileId)
        if (list === undefined) return Response.json(errorEnvelope(500182, '该文件未打开智能录制开关，请联系文件所有者'), { status: 400 })
        return Response.json({ chapter_list: list })
      }
```

- [ ] **Step 3: `tests/worker/source-inproc.test.ts` 补真实 catalog 用例**

第 160 行起那组「不打桩 catalog」的 describe 里，`createCatalog({...})` 加 `smartApi`，并新增一条：

```ts
  test('纪要走 smart 接口：listAssets 列出 ai_minutes，getDownloadUrl 给 data: URL', async () => {
    const source = makeWithSmart({
      getMinutes: async () => '# 纪要\n',
      getChapters: async () => null,
    })
    const assets = await source.listAssets('m1')
    const minutes = assets.find((a) => a.assetType === 'ai_minutes')!
    expect(minutes.assetId.endsWith(':ai_minutes:md')).toBe(true)
    const link = await source.getDownloadUrl(minutes.assetId)
    expect(await (await fetch(link.url)).text()).toBe('# 纪要\n')
  })
```
其中 `makeWithSmart(smart: SmartApi)` 是该 describe 内既有工厂函数的变体：把传入的 `smart` 放进 `createCatalog` 的 deps，其余（recordsApi 返回一场 `meetingRecordId='rec1'` 的会议、addressesApi 返回一个 `record_file_id='f1'` 且 `allow_download: true` 的文件）照抄该 describe 现有的构造。

- [ ] **Step 4: `tests/worker/e2e.test.ts` 补纪要落盘断言**

在 fixture 里给 `state.smartMinutesByFileId.set('f-sum-1', '## 会议摘要\n\n正文\n')`（`f-sum-1` 是该文件既有的转写 record_file_id；若 e2e 不经过假服务而是直接打桩 `AssetSource`，则改为在桩的 `listAssets` 里多返回一条 `{ assetId: 'rec-1:f-sum-1:ai_minutes:md', assetType: 'ai_minutes', remoteId: 'f-sum-1', fileType: 'md', bytesExpected: null }`，`getDownloadUrl` 对它返回 `data:text/markdown;charset=utf-8;base64,` + base64 正文）。跑完一轮后断言：

```ts
  expect(await readFile(join(localRoot, DIR, 'minutes.md'), 'utf8')).toBe('## 会议摘要\n\n正文\n')
```
`_manifest.json` 的断言里 `assets` 多一项 `{ assetType: 'ai_minutes', assetKey: 'ai_minutes', fileType: 'md', fileName: 'minutes.md', ... }`（按该测试现有的清单断言形状补）。

- [ ] **Step 5: 跑全量网关测试 + typecheck**

Run: `bun run typecheck && bun test`
Expected: 全 PASS（`tests/store/contents.test.ts` 若还红，属于 Task 7）

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/worker src/sts/manager.ts tests/fake-tencent tests/worker
git commit -m "feat(worker): 三个宿主接入智能接口；假腾讯服务补 smart 路由与 500182"
```

---

### Task 7: 正文入库认 md / json

**Files:**
- Modify: `src/store/contents.ts:52,300-305`
- Test: `tests/store/contents.test.ts`

- [ ] **Step 1: 加测试**

`tests/store/contents.test.ts` 里找到既有的「docx 记 unsupported_format」那条 `buildAssetContent` 用例，仿它加：

```ts
test('buildAssetContent：md 与 json 都是纯文本，按 parsed 入库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mde-contents-'))
  try {
    for (const [ext, body] of [['md', '## 会议摘要\n\n正文\n'], ['json', '{"schemaVersion":1,"chapters":[]}\n']] as const) {
      const p = join(dir, `x.${ext}`)
      await writeFile(p, body, 'utf8')
      const hash = createHash('sha256').update(body, 'utf8').digest('hex')
      const r = await buildAssetContent(
        { meetingId: 'm', subMeetingId: '', assetType: ext === 'md' ? 'ai_minutes' : 'chapters', remoteId: 'r', fileType: ext },
        p, hash, 1000,
      )
      expect(r.kind).toBe('record')
      if (r.kind === 'record') {
        expect(r.record.status).toBe('parsed')
        expect(r.record.content).toBe(body)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```
（`buildAssetContent` 的实参顺序以文件里既有用例为准，照抄。）

- [ ] **Step 2: 跑测试确认失败**

Run: `TEST_DATABASE_URL=... bun test tests/store/contents.test.ts`
Expected: 新用例 FAIL（`unsupported_format`）

- [ ] **Step 3: 改 `contents.ts`**

```ts
/** 能被当纯文本入库的扩展名。docx / pdf 不是纯文本，装解析器是另一件事（计划 §3 T4 的「坑」） */
const PARSABLE_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'md', 'json'])
```
第 300 行判断改为 `if (!PARSABLE_EXTENSIONS.has(ext))`，reason 改为：

```ts
      reason: `file_type=${key.fileType || '(空)'} 不是纯文本，本版本只解析 ${[...PARSABLE_EXTENSIONS].join(' / ')}——docx / pdf 需要单独的解析器，不在控制台阶段 4 的范围内`,
```
把文件里其它引用 `PARSABLE_EXTENSION` 的地方（第 354 行附近的第二处 reason）同样改掉。

- [ ] **Step 4: 跑测试**

Run: `TEST_DATABASE_URL=... bun test tests/store/contents.test.ts tests/worker/archive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/contents.ts tests/store/contents.test.ts
git commit -m "feat(store): 正文入库认 md / json——纪要与时间轴落库后预览页读得到"
```

---

### Task 8: 控制台后端：时间轴端点读真章节

**Files:**
- Modify: `src/http/handlers/console/content.ts:1223-1298`
- Test: `tests/http/console-content.test.ts`

**Interfaces:**
- Produces（`GET /api/v1/admin/meetings/:id/content/chapters` 响应）：`chapters: Array<{ id: string; name: string; at: number }>`（`at` 秒，按 `at` 升序）；`source: 'tencent' | 'none'`；`text` 两种文案。`cues` / `cuesFrom` / `sample` 不变。

- [ ] **Step 1: 加测试**

在 `tests/http/console-content.test.ts` 里仿既有的 chapters 用例（它会造 `asset_contents` 行）加：

```ts
test('chapters：库里有 chapters 类正文时解析成章节，source=tencent', async () => {
  // 造一行 asset_contents：asset_type='chapters', file_type='json', status='parsed'
  const body = JSON.stringify({ schemaVersion: 1, recordFileId: 'rf-1', chapters: [
    { chapterId: 'C2', name: '第二段', startMs: 120500 },
    { chapterId: 'C1', name: '开场', startMs: 7837 },
  ] }, null, 2) + '\n'
  await seedContent(pool, { meetingId: MEETING_ID, assetType: 'chapters', remoteId: 'rf-1', fileType: 'json', content: body })
  const res = await app.fetch(adminGet(`/api/v1/admin/meetings/${MEETING_ID}/content/chapters`))
  const json = await res.json()
  expect(json.source).toBe('tencent')
  expect(json.chapters).toEqual([
    { id: 'C1', name: '开场', at: 7 },
    { id: 'C2', name: '第二段', at: 120 },
  ])
})

test('chapters：正文不是合法 JSON 时 chapters 为空、source=none，不抛', async () => {
  await seedContent(pool, { meetingId: MEETING_ID, assetType: 'chapters', remoteId: 'rf-1', fileType: 'json', content: '{not json' })
  const res = await app.fetch(adminGet(`/api/v1/admin/meetings/${MEETING_ID}/content/chapters`))
  const json = await res.json()
  expect(res.status).toBe(200)
  expect(json.chapters).toEqual([])
  expect(json.source).toBe('none')
})
```
`seedContent` / `adminGet` / `MEETING_ID` / `app` 用该文件已有的同名（或同用途）帮助函数；没有 `seedContent` 就仿 `tests/store/contents.test.ts` 的 `parsedRecord` + `createContentsStore(pool).put(...)` 写一行。

- [ ] **Step 2: 跑测试确认失败**

Run: `TEST_DATABASE_URL=... bun test tests/http/console-content.test.ts`
Expected: 两条新用例 FAIL（`chapters` 恒空、`source` 恒 `none`）

- [ ] **Step 3: 改 `getChapters`**

在 `CHAPTERS_TEXT` 处替换为两段文案与一个解析函数：

```ts
export interface ChapterItem { id: string; name: string; at: number }

const CHAPTERS_TEXT_NONE =
  '这场会议没有章节：腾讯会议只对开了智能录制的录制文件生成章节，这一场的录制文件没有开，' +
  '或者时间轴还没拉取归档。下面的分段是按逐字稿的时间戳切出来的，不是章节，但时间是真的，点一下就能跳转。'
const CHAPTERS_TEXT_HAVE =
  '章节来自腾讯会议的智能录制，已随时间轴归档。下面的分段是按逐字稿的时间戳切出来的，两者可以互相对照。'

/**
 * chapters.json（src/tencent/smart.ts 的 serializeChapters 写的）→ 章节列表，按起点升序。
 * 解析不了一律回空数组：一份坏文件不该把整个时间轴端点打成 500；正文原样在库里，
 * `?type=chapters` 能看到它。
 */
function parseChapterSegments(segs: readonly ContentSegmentRow[]): ChapterItem[] {
  const out: ChapterItem[] = []
  for (const s of segs) {
    if (s.status !== 'parsed' || s.content === null) continue
    let doc: { chapters?: Array<{ chapterId?: string; name?: string; startMs?: number }> }
    try {
      doc = JSON.parse(s.content)
    } catch {
      continue
    }
    for (const c of doc.chapters ?? []) {
      if (typeof c.chapterId !== 'string' || typeof c.startMs !== 'number') continue
      out.push({ id: c.chapterId, name: typeof c.name === 'string' ? c.name : '', at: Math.floor(c.startMs / 1000) })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}
```
`getChapters` 里在取 cues 之前加：

```ts
  const chapterSegs = await ctx.deps.contents.listSegments(key.meetingId, key.subMeetingId, ASSET_KEY_TO_GATEWAY_TYPE.chapters)
  const chapters = parseChapterSegments(chapterSegs)
```
响应改为：

```ts
    chapters,
    source: chapters.length > 0 ? 'tencent' : 'none',
    text: chapters.length > 0 ? CHAPTERS_TEXT_HAVE : CHAPTERS_TEXT_NONE,
```
文件头第 6 行的端点说明与「T16 裁定 chapters 恒空」相关注释（第 75-80 行）改为「chapters 来自 `chapters` 类正文（chapters.json），没有时为空数组并说明原因」。

- [ ] **Step 4: 跑测试**

Run: `TEST_DATABASE_URL=... bun test tests/http/console-content.test.ts`
Expected: PASS（含既有的「chapters 为空」用例——它现在走 `source: 'none'` 路径，断言若写死了旧文案要同步改）

- [ ] **Step 5: Commit**

```bash
git add src/http/handlers/console/content.ts tests/http/console-content.test.ts
git commit -m "feat(console-api): 时间轴端点读 chapters.json 解析真章节，没有时说清为什么"
```

---

### Task 9: 控制台前端：一个纪要、真时间轴、六类词汇

**Files:**
- Modify: `console/src/api/types.ts:14-22`、`console/src/api/admin/content.ts:185-272`、`console/src/api/admin/programs.ts:44-48`、`console/src/pages/Meetings/MeetingDetail.tsx:67-71`、`console/src/pages/Preview/MinutesTab.tsx`、`console/src/pages/Preview/text.tsx:5,97-102`、`console/src/pages/Preview/TimelineTab.tsx`、`console/src/pages/Preview/index.tsx:300-305`、`console/src/api/mock/{content,meetings,rules,audit,consumers}.ts`
- Docs: `docs/console/spec.md` §4.4（第 296-298 行）、§4.4 表格（第 352 行）、§6.2（第 628-640 行）

- [ ] **Step 1: 词汇表**

`console/src/api/types.ts` 的 `AssetKey` 联合改为六项：`'video' | 'audio' | 'transcript' | 'ai_transcript' | 'ai_minutes' | 'chapters'`。

`console/src/api/admin/content.ts`、`console/src/api/admin/programs.ts:44-48`、`console/src/pages/Meetings/MeetingDetail.tsx:67-71` 三处 `ASSET_LABEL` 表逐字改为 Task 3 的六项（录像 / 音频 / 逐字稿 / 逐字稿（智能优化版）/ 纪要 / 时间轴）。

`console/src/api/admin/content.ts`：删掉 `MINUTES_TEMPLATES` 与 `FILE_TYPES`（第 250-272 行，含注释）；`ChaptersView.chapters` 类型改为：

```ts
export interface ChapterItem { id: string; name: string; at: number }
// ChaptersView 内：
  /** 腾讯智能录制的章节，按起点升序；没开智能录制的会议为空数组，`text` 说明原因 */
  chapters: ChapterItem[]
  /** `'tencent'` 有章节 / `'none'` 没有 */
  source: string
```

- [ ] **Step 2: 纪要 tab 去掉模板与格式切换**

`console/src/pages/Preview/text.tsx`：删掉 `pickDefaultTemplate`（第 97-102 行）与第 5 行的 import。

`console/src/pages/Preview/MinutesTab.tsx`：
- 文件头注释「模板切换不是装饰性下拉」整段替换为：

```ts
/**
 * 纪要 tab。**只有一类**：`ai_minutes`，来自腾讯智能纪要接口的默认模板——腾讯录制页
 * 的「纪要文本」下载给的就是当前模板这一份，控制台与它对齐（spec 2.3，2026-09-08）。
 * 此前的四个模板对应的是 51180 接口的四个文件字段，那套分法已经删掉。
 *
 * 正文是 markdown 源文，用 <pre> 直出；富文本渲染不在本次范围。
 */
```
- import 去掉 `FILE_TYPES`、`MINUTES_TEMPLATES`、`pickDefaultTemplate`、`RadioRow`；props 去掉 `assets`；
- 组件体改为：

```tsx
const MINUTES_ASSET_KEY: AssetKey = 'ai_minutes'

export function MinutesTab({ meetingId, archivedAt, heightMemo }: MinutesTabProps) {
  const res = useResource(() => fetchContentSelection(meetingId, { type: MINUTES_ASSET_KEY }), [meetingId])
  const floor = useHeightFloor(res.state === 'loading', heightMemo)

  return (
    <div className={styles.tabBody}>
      <div ref={floor.ref} style={floor.style} className={styles.docSlot}>
        {/* 下面三段 loading / error / ready 原样保留 */}
```
（`AssetKey` 从 `@/api/types` import；工具条 `<div className={styles.toolbar}>…</div>` 整块删除。）
- `console/src/pages/Preview/index.tsx:300-305` 的 `<MinutesTab>` 去掉 `assets={index.assets}`。

- [ ] **Step 3: 时间轴 tab 显示章节**

`console/src/pages/Preview/TimelineTab.tsx`：
- 文件头注释「这一页最容易做错的一件事」整段替换为：

```ts
/**
 * 时间轴 tab：上半是腾讯智能录制的**章节**（`data.chapters`，2026-09-08 起有真来源：
 * chapters.json），下半是按逐字稿时间戳切出的**转写分段**（`data.cues`）。
 * 两者都能点击跳转。没开智能录制的会议章节为空，`data.text` 说明原因，
 * 转写分段照常显示——不拿分段冒充章节。
 */
```
- 顶部那段 `<p className={styles.notice}>本系统<b>没有「章节」这一类数据</b>…</p>` 删掉，只保留 `<p className={styles.backendText}><Emphasis text={data.text} /></p>`。
- 在 `backendText` 之后、`from !== null` 之前插入：

```tsx
      {data.chapters.length > 0 && (
        <section aria-label="章节">
          <h3 className={styles.sectionTitle}>章节</h3>
          <ul className={styles.cueList}>
            {data.chapters.map((c) => (
              <li key={c.id}>
                <button type="button" className={styles.cue} onClick={() => onSeek(c.at)}>
                  <time className={styles.cueTime}>{fmtClock(c.at)}</time>
                  <span className={styles.cueText}>{c.name === '' ? '（未命名章节）' : c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
```
- 转写分段那个 `<ul>` 前加 `<h3 className={styles.sectionTitle}>转写分段</h3>`；`aria-label` 改为 `"转写分段（按逐字稿时间戳切分）"`。
- `Preview.module.css` 若没有 `.sectionTitle`，加：`.sectionTitle { margin: 12px 0 6px; font-size: 13px; font-weight: 600; color: var(--fg-2); }`（颜色变量以该文件既有变量名为准）。

- [ ] **Step 4: mock 数据**

`console/src/api/mock/*.ts` 里所有 `ai_topic_minutes` / `ai_speaker_minutes` / `ai_ds_minutes` 的条目删掉；`assets` 计数对象里保留 `ai_minutes`，加 `chapters: { got: 1, total: 1 }`（只在原本就列出每类计数的对象里加）。`mock/content.ts` 若有 chapters 视图的 mock，`chapters` 给两条 `{ id: 'C1', name: '开场', at: 7 }, { id: 'C2', name: '需求评审', at: 120 }`，`source: 'tencent'`。

- [ ] **Step 5: 文档**

`docs/console/spec.md`：
- 第 296-298 行改为「**三个 tab**：纪要 / 时间轴 / 转写文字」「**纪要只有一份**：腾讯智能纪要接口的默认模板，与腾讯录制页「纪要文本」下载一致（2026-09-08 翻案：此前按 51180 的四个字段做了四个模板，那不是四份产品，是同一份纪要的模板参数）」「**时间轴有真章节**：来自智能章节接口，没开智能录制的会议为空并说明原因」。
- 第 352 行表格那行「模板第四项待办清单 → 会议摘要」整行删掉。
- §6.2 表改为六行（列：AssetKey / 名称 / 网关 asset_type / 来源），内容照本计划 Task 3 与 spec 2.1 那张表；标题「八类资产」改「六类资产」。

- [ ] **Step 6: typecheck + vitest**

Run: `cd console && bun run typecheck && bun run test`
Expected: PASS。再全仓 `grep -rn "ai_topic_minutes\|ai_speaker_minutes\|ai_ds_minutes\|MINUTES_TEMPLATES\|pickDefaultTemplate" console/src src packages client docs/console/spec.md` → 无输出。

- [ ] **Step 7: Commit**

```bash
git add console docs/console/spec.md
git commit -m "feat(console): 纪要只有一份、时间轴显示真章节，资产名对齐腾讯下载菜单"
```

---

### Task 10: 存量目录改名脚本 `scripts/rename-archive-dirs.ts`

**Files:**
- Create: `scripts/rename-archive-dirs.ts`
- Test: `tests/scripts/rename-archive-dirs.test.ts`

**Interfaces:**
- Consumes: `meetingDirPath`（Task 2 新格式）、`cleanSubjectSegment`（引擎）、`createPool` / `runMigrations`（`src/store/db.ts`）。
- Produces:

```ts
export interface RenameArgs { apply: boolean }
export function parseArgs(argv: string[]): RenameArgs
export function legacyMeetingDirPath(m: { subject: string | null; startTime: number | null; meetingCode: string | null }, fallbackCode: string): string
export interface RenameItem {
  meetingId: string; subMeetingId: string
  oldRel: string; newRel: string
  local: { from: string; to: string; exists: boolean }
  nas: { from: string; to: string; exists: boolean } | null
}
export async function planRenames(pool: Pool, localRoot: string): Promise<RenameItem[]>
export async function applyOne(pool: Pool, item: RenameItem): Promise<'renamed' | 'skipped_nothing_to_do' | 'conflict'>
```

- [ ] **Step 1: 写测试 `tests/scripts/rename-archive-dirs.test.ts`**

```ts
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTestDb } from '../helpers/testdb'
import { applyOne, legacyMeetingDirPath, parseArgs, planRenames } from '../../scripts/rename-archive-dirs'
import type { Pool } from '../../src/store/db'

const START = Date.UTC(2026, 8, 2, 1, 27) / 1000  // 2026-09-02 01:27 UTC

async function seed(pool: Pool, localRoot: string, nasDir: string) {
  await pool.execute(
    `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
     VALUES ('m1', '', '42677674068', '硬件早会', 'u', ?, ?, 1, 1)`, [START, START + 1800])
  const oldRel = '2026/09/2026-09-02_0127_硬件早会_42677674068'
  await pool.execute(
    `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, created_at, updated_at)
     VALUES ('m1', '', 'meeting_summary', 'r1', 'txt', 'completed', ?, 1, 1)`, [`${oldRel}/transcript.txt`])
  await pool.execute(
    `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
     VALUES ('m1', '', 'meeting_summary', 'r1', 'txt', ?, ?, ?, 1)`,
    [`${oldRel}/transcript.txt`, join(nasDir, oldRel, 'transcript.txt'), 'a'.repeat(64)])
  await pool.execute(
    `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, created_at, updated_at)
     VALUES ('m1', '', ?, 1, 30, 1, 1)`, [nasDir])
  await mkdir(join(localRoot, oldRel), { recursive: true })
  await writeFile(join(localRoot, oldRel, 'transcript.txt'), 'hello')
  await mkdir(join(nasDir, oldRel), { recursive: true })
  await writeFile(join(nasDir, oldRel, 'transcript.txt'), 'hello')
  await writeFile(join(nasDir, oldRel, '_manifest.json'), JSON.stringify({
    schemaVersion: 1, meetingId: 'm1', subMeetingId: '',
    assets: [{ assetType: 'meeting_summary', fileName: 'transcript.txt', nasPath: join(nasDir, oldRel, 'transcript.txt'), nasHash: 'a'.repeat(64) }],
    archive: { archivedAt: 1, retentionDays: 30, nasDir },
  }, null, 2))
  return oldRel
}

test('parseArgs：默认 dry-run，--apply 才动手', () => {
  expect(parseArgs([])).toEqual({ apply: false })
  expect(parseArgs(['--apply'])).toEqual({ apply: true })
})

test('legacyMeetingDirPath 复现 2026-09-08 之前的目录名', () => {
  expect(legacyMeetingDirPath({ subject: '硬件早会', startTime: START, meetingCode: '42677674068' }, 'm1'))
    .toBe('2026/09/2026-09-02_0127_硬件早会_42677674068')
})

test('plan + apply：本地与 NAS 目录改名，三张表的路径同步，manifest 的 nasPath 重写；再跑一次无事可做', async () => {
  await withTestDb(async (pool) => {
    const localRoot = await mkdtemp(join(tmpdir(), 'mde-local-'))
    const nasRoot = await mkdtemp(join(tmpdir(), 'mde-nas-'))
    const nasDir = join(nasRoot, 'all')
    try {
      const oldRel = await seed(pool, localRoot, nasDir)
      const newRel = '2026/09/2026-09-02_0127_42677674068'

      const plan = await planRenames(pool, localRoot)
      expect(plan).toHaveLength(1)
      expect(plan[0]!.oldRel).toBe(oldRel)
      expect(plan[0]!.newRel).toBe(newRel)
      expect(plan[0]!.local.exists).toBe(true)
      expect(plan[0]!.nas!.exists).toBe(true)

      expect(await applyOne(pool, plan[0]!)).toBe('renamed')

      await stat(join(localRoot, newRel, 'transcript.txt'))
      await stat(join(nasDir, newRel, 'transcript.txt'))
      await expect(stat(join(localRoot, oldRel))).rejects.toThrow()

      const [ma] = await pool.execute<any[]>(`SELECT target_path FROM meeting_assets WHERE meeting_id='m1'`)
      expect(ma[0].target_path).toBe(`${newRel}/transcript.txt`)
      const [aa] = await pool.execute<any[]>(`SELECT local_path, nas_path FROM archived_assets WHERE meeting_id='m1'`)
      expect(aa[0].local_path).toBe(`${newRel}/transcript.txt`)
      expect(aa[0].nas_path).toBe(join(nasDir, newRel, 'transcript.txt'))

      const manifest = JSON.parse(await readFile(join(nasDir, newRel, '_manifest.json'), 'utf8'))
      expect(manifest.assets[0].nasPath).toBe(join(nasDir, newRel, 'transcript.txt'))

      const again = await planRenames(pool, localRoot)
      expect(again[0]!.local.exists).toBe(false)
      expect(again[0]!.nas!.exists).toBe(false)
      expect(await applyOne(pool, again[0]!)).toBe('skipped_nothing_to_do')
    } finally {
      await rm(localRoot, { recursive: true, force: true })
      await rm(nasRoot, { recursive: true, force: true })
    }
  })
})

test('目标目录已存在时报 conflict，不动任何东西', async () => {
  await withTestDb(async (pool) => {
    const localRoot = await mkdtemp(join(tmpdir(), 'mde-local-'))
    const nasRoot = await mkdtemp(join(tmpdir(), 'mde-nas-'))
    try {
      const oldRel = await seed(pool, localRoot, join(nasRoot, 'all'))
      await mkdir(join(localRoot, '2026/09/2026-09-02_0127_42677674068'), { recursive: true })
      const plan = await planRenames(pool, localRoot)
      expect(await applyOne(pool, plan[0]!)).toBe('conflict')
      await stat(join(localRoot, oldRel, 'transcript.txt'))
      const [ma] = await pool.execute<any[]>(`SELECT target_path FROM meeting_assets WHERE meeting_id='m1'`)
      expect(ma[0].target_path).toBe(`${oldRel}/transcript.txt`)
    } finally {
      await rm(localRoot, { recursive: true, force: true })
      await rm(nasRoot, { recursive: true, force: true })
    }
  })
})
```
（`withTestDb` 的回调签名以 `tests/helpers/testdb.ts` 为准；`meeting_archives` 若还有 NOT NULL 列（`extended_days` 有默认值），按 003 补。）

- [ ] **Step 2: 跑测试确认失败**

Run: `TEST_DATABASE_URL=... bun test tests/scripts/rename-archive-dirs.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 `scripts/rename-archive-dirs.ts`**

```ts
#!/usr/bin/env bun
/**
 * 会议目录去掉主题段的一次性改名（spec 2.4，2026-09-08）。
 *
 *   旧：<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<清洗主题>_<会议号>
 *   新：<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<会议号>
 *
 * 用法：
 *   DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts            # dry-run，只打印
 *   DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts --apply    # 真改
 *
 * 对每场会议（`meetings` 表一行）：
 *   1. 本地归档区：<localRoot>/<旧> → <localRoot>/<新>
 *   2. NAS：<meeting_archives.nas_dir>/<旧> → <nas_dir>/<新>（没归档过的会议没有这一步）
 *   3. 同一事务改 meeting_assets.target_path、archived_assets.local_path / nas_path 的前缀
 *   4. 重写 NAS 新目录里 _manifest.json 的 assets[].nasPath
 * 目录改名先于写库；写库失败把目录改回去。目标目录已存在一律 conflict、什么都不动。
 *
 * 可重复跑：旧目录不存在（本地、NAS 都是）的会议直接 skipped。
 *
 * 跑之前**停掉定时任务与网关**：改名与归档流水线并发，会让一半文件写到旧目录。
 */
import { rename, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { cleanSubjectSegment, meetingDirPath } from '@yaowu/mde-engine'
import { createPool, runMigrations, type Pool } from '../src/store/db'

export interface RenameArgs { apply: boolean }
export function parseArgs(argv: string[]): RenameArgs {
  return { apply: argv.includes('--apply') }
}

interface DirMeeting { subject: string | null; startTime: number | null; meetingCode: string | null }

/** 2026-09-08 之前 packages/engine/src/domain/filename.ts 的 meetingDirPath，逐字复刻 */
export function legacyMeetingDirPath(m: DirMeeting, fallbackCode: string): string {
  const d = new Date((m.startTime ?? 0) * 1000)
  const yyyy = String(d.getUTCFullYear()), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0')
  const hhmm = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}/${mm}/${yyyy}-${mm}-${dd}_${hhmm}_${cleanSubjectSegment(m.subject ?? '')}_${m.meetingCode ?? fallbackCode}`
}

export interface RenameItem {
  meetingId: string
  subMeetingId: string
  oldRel: string
  newRel: string
  local: { from: string; to: string; exists: boolean }
  nas: { from: string; to: string; exists: boolean } | null
}

interface MeetingRow extends RowDataPacket {
  meeting_id: string; sub_meeting_id: string; meeting_code: string | null; subject: string | null; start_time: number | null
  nas_dir: string | null
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

export async function planRenames(pool: Pool, localRoot: string): Promise<RenameItem[]> {
  const [rows] = await pool.execute<MeetingRow[]>(
    `SELECT m.meeting_id, m.sub_meeting_id, m.meeting_code, m.subject, m.start_time, a.nas_dir
       FROM meetings m
       LEFT JOIN meeting_archives a ON a.meeting_id = m.meeting_id AND a.sub_meeting_id = m.sub_meeting_id
      ORDER BY m.meeting_id, m.sub_meeting_id`,
  )
  const out: RenameItem[] = []
  for (const r of rows) {
    const m: DirMeeting = { subject: r.subject, startTime: r.start_time, meetingCode: r.meeting_code }
    const oldRel = legacyMeetingDirPath(m, r.meeting_id)
    const newRel = meetingDirPath(m, r.meeting_id)
    const localFrom = join(localRoot, oldRel), localTo = join(localRoot, newRel)
    const nas = r.nas_dir === null ? null : { from: join(r.nas_dir, oldRel), to: join(r.nas_dir, newRel), exists: await exists(join(r.nas_dir, oldRel)) }
    out.push({ meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id, oldRel, newRel, local: { from: localFrom, to: localTo, exists: await exists(localFrom) }, nas })
  }
  return out
}

async function rewriteManifest(dir: string, oldPrefix: string, newPrefix: string): Promise<void> {
  const p = join(dir, '_manifest.json')
  if (!(await exists(p))) return
  const doc = JSON.parse(await readFile(p, 'utf8')) as { assets?: Array<{ nasPath?: string }> }
  for (const a of doc.assets ?? []) {
    if (typeof a.nasPath === 'string' && a.nasPath.startsWith(oldPrefix)) a.nasPath = newPrefix + a.nasPath.slice(oldPrefix.length)
  }
  await writeFile(p, JSON.stringify(doc, null, 2))
}

export async function applyOne(pool: Pool, item: RenameItem): Promise<'renamed' | 'skipped_nothing_to_do' | 'conflict'> {
  const doLocal = item.local.exists
  const doNas = item.nas !== null && item.nas.exists
  if (!doLocal && !doNas) return 'skipped_nothing_to_do'
  if ((doLocal && (await exists(item.local.to))) || (doNas && (await exists(item.nas!.to)))) return 'conflict'

  if (doLocal) await rename(item.local.from, item.local.to)
  if (doNas) await rename(item.nas!.from, item.nas!.to)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const oldPrefix = `${item.oldRel}/`, newPrefix = `${item.newRel}/`
    await conn.execute(
      `UPDATE meeting_assets SET target_path = CONCAT(?, SUBSTRING(target_path, ?))
        WHERE meeting_id = ? AND sub_meeting_id = ? AND target_path LIKE ?`,
      [newPrefix, oldPrefix.length + 1, item.meetingId, item.subMeetingId, `${oldPrefix}%`],
    )
    await conn.execute(
      `UPDATE archived_assets SET local_path = CONCAT(?, SUBSTRING(local_path, ?))
        WHERE meeting_id = ? AND sub_meeting_id = ? AND local_path LIKE ?`,
      [newPrefix, oldPrefix.length + 1, item.meetingId, item.subMeetingId, `${oldPrefix}%`],
    )
    if (item.nas !== null) {
      const nasOld = `${item.nas.from}/`, nasNew = `${item.nas.to}/`
      await conn.execute(
        `UPDATE archived_assets SET nas_path = CONCAT(?, SUBSTRING(nas_path, ?))
          WHERE meeting_id = ? AND sub_meeting_id = ? AND nas_path LIKE ?`,
        [nasNew, nasOld.length + 1, item.meetingId, item.subMeetingId, `${nasOld}%`],
      )
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    if (doLocal) await rename(item.local.to, item.local.from)
    if (doNas) await rename(item.nas!.to, item.nas!.from)
    throw err
  } finally {
    conn.release()
  }

  if (doNas) await rewriteManifest(item.nas!.to, `${item.nas!.from}/`, `${item.nas!.to}/`)
  return 'renamed'
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  const localRoot = process.env.MDE_ARCHIVE_ROOT
  if (!databaseUrl || !localRoot) { console.error('需要 DATABASE_URL 与 MDE_ARCHIVE_ROOT'); return 2 }
  const pool = createPool(databaseUrl)
  try {
    await runMigrations(pool)
    const plan = await planRenames(pool, localRoot)
    let renamed = 0, skipped = 0, conflict = 0
    for (const item of plan) {
      const todo = item.local.exists || (item.nas?.exists ?? false)
      if (!todo) { skipped++; continue }
      console.log(`${item.meetingId}/${item.subMeetingId || '-'}\n  ${item.oldRel}\n  → ${item.newRel}\n  local=${item.local.exists} nas=${item.nas?.exists ?? 'n/a'}`)
      if (!args.apply) continue
      const r = await applyOne(pool, item)
      if (r === 'renamed') renamed++
      else if (r === 'conflict') { conflict++; console.error(`  conflict：目标目录已存在，未动`) }
      else skipped++
    }
    console.log(args.apply ? `renamed=${renamed} skipped=${skipped} conflict=${conflict}` : `dry-run：${plan.length} 场会议，其中 ${plan.length - skipped} 场需要改名（加 --apply 执行）`)
    return conflict > 0 ? 1 : 0
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1) })
}
```

- [ ] **Step 4: 跑测试**

Run: `TEST_DATABASE_URL=... bun test tests/scripts/rename-archive-dirs.test.ts`
Expected: PASS（4 条）

- [ ] **Step 5: `.env.example` 与规则编辑器示例**

`.env.example` 里描述归档目录模板的那段（搜 `{标题}`）加一句：「目录名自 2026-09-08 起不含会议主题；`{标题}` 占位符仍可用，但会把中文带进 NAS 路径，跨系统挂载时编码不稳，不推荐」。`src/http/handlers/console/rules.ts` 下发给编辑器的模板示例若含 `{标题}`，改成 `meetings/{年}/{月}`。

- [ ] **Step 6: Commit**

```bash
git add scripts/rename-archive-dirs.ts tests/scripts/rename-archive-dirs.test.ts .env.example src/http/handlers/console/rules.ts
git commit -m "feat(scripts): 存量会议目录去主题段的一次性改名——本地、NAS、三张表、manifest 同步"
```

---

### Task 11: 上线与回填 runbook + 记忆更新

**Files:**
- Create: `docs/2026-09-08-smart-assets-rollout.md`
- Modify: `/Users/zouyanjian/.claude/projects/-Users-zouyanjian-other-try-yaowu-meeting-data-exporter/memory/sts-blocks-five-asset-types.md` 与 `MEMORY.md` 索引行

- [ ] **Step 1: 写 runbook `docs/2026-09-08-smart-assets-rollout.md`**

```markdown
# 2026-09-08 上线：六类资产 + 目录去中文

## 0. 前置
- 本机与服务器的定时任务都停掉（`MDE_SCHEDULER` 进程 / systemd unit），网关也停——改名脚本与归档并发会把文件写进旧目录。
- 备份：`mysqldump <db> meetings meeting_assets archived_assets meeting_archives > backup-2026-09-08.sql`。

## 1. 部署代码
`git pull && bun install && bun run typecheck`；控制台 `cd console && bun run build`。

## 2. 改名
    DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts          # 看清单
    DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts --apply
预期最后一行 `conflict=0`。有 conflict 的会议手工看两个目录，合并后再跑一次（脚本可重复跑）。

## 3. 起服务
先起网关，再起定时任务。看一轮日志无 `InvalidAssetIdError`。

## 4. 回填纪要与时间轴
    bun src/worker/index.ts --from 2026-09-01 --to <今天>
discovery 会给窗口内每场会议补 `ai_minutes` / `chapters`（没开智能录制的会议 chapters 直接 abandoned，理由 upstream_timeout）；下载走 data: URL；`listMeetingsNeedingArchive` 按「completed 数 > archived 数」把这些会议再归一次档，正文随归档入库。

## 5. 验收
    SELECT asset_type, COUNT(*) FROM archived_assets GROUP BY 1;   -- 出现 ai_minutes / chapters
    SELECT asset_type, status, COUNT(*) FROM asset_contents GROUP BY 1,2;  -- ai_minutes/chapters 为 parsed
    SELECT asset_type, last_error, COUNT(*) FROM meeting_assets WHERE status IN ('dead','skipped') GROUP BY 1,2;
NAS 抽一场：`<nas_dir>/2026/09/2026-09-0X_HHMM_<会议号>/` 下有 `minutes.md`、`chapters.json`（开了智能录制的）、`_manifest.json` 里 `nasPath` 指向新目录。
控制台：任一场会议 → 内容预览 → 三个 tab 都有内容；规则编辑器资产类型下拉是六项。

## 6. 回滚
代码回退到上一版；目录名不回滚（新格式对旧代码也只是「另一场会议的目录」，旧代码会在旧路径新建目录，不会破坏已有文件）。
```

- [ ] **Step 2: 更新记忆文件**

把 `memory/sts-blocks-five-asset-types.md` 改名为 `smart-assets-via-smart-api.md`（`name: smart-assets-via-smart-api`），正文改为：

```markdown
---
name: smart-assets-via-smart-api
description: 纪要与时间轴走 /v1/smart/*，不要 STS；只剩优化版逐字稿卡 STS；目录名不含主题
metadata:
  type: project
---

2026-09-08 起资产是六类：video / audio / transcript(meeting_summary) / ai_transcript(ai_meeting_transcripts) /
ai_minutes / chapters。纪要与时间轴来自 `src/tencent/smart.ts`（`/v1/smart/minutes`、`/v1/smart/chapters`），
AK/SK 直调、**不要 STS**，catalog 以 `data:` URL 交付正文。只有 `ai_meeting_transcripts` 仍走 51180 + STS。

没开智能录制的录制文件，两个接口回 500182（asset_permanent）→ 这一类视为不存在。历史会议的纪要取得到
（实调 9 月 2 日的会议有），章节看开关。

归档目录名自同日起是 `<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<会议号>`，不含主题；存量目录用
`scripts/rename-archive-dirs.ts` 改过。

**How to apply:** 看到纪要空态先查 `asset_contents` 有没有 `ai_minutes` 行，再查 `meeting_assets` 该类的
status/last_error；不要去查 STS。看到时间轴空态先看 last_error 是否 upstream_timeout（= 没开智能录制）。
相关：[[sts-single-active-token-per-app]]、[[verify-status-from-git-not-docs]]
```
`MEMORY.md` 里对应那一行改为 `- [纪要/时间轴走智能接口，不要 STS](smart-assets-via-smart-api.md) — 六类资产；500182 = 没开智能录制；目录名不含主题`。

- [ ] **Step 3: 全量验证**

Run: `bun run typecheck && bun test && (cd packages/engine && bun test) && (cd client && bun run typecheck && bun test) && (cd console && bun run typecheck && bun run test)`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add docs/2026-09-08-smart-assets-rollout.md
git commit -m "docs: 六类资产与目录去中文的上线 runbook"
```

---

## 自查记录

- **Spec 覆盖**：2.1 → Task 1/3/9；2.2 → Task 4/5/6；2.3 → Task 7/8/9；2.4 → Task 2/10；2.5 → Task 11。
- **类型一致**：`SmartApi.getMinutes/getChapters`、`SmartPresence`、`serializeChapters`、`ChapterItem` 在 Task 4/5/8/9 命名一致；`extractAssets` 第六参 `smart` 在 Task 5 定义、测试同名。
- **不含占位符**：每步有代码或精确到行的改法；两处「照该文件既有帮助函数」都指明了替代来源。
- **阶段独立**：Task 1-3 后系统可编译、可跑（纪要类暂时不产出）；Task 4-6 后纪要与时间轴可落盘；Task 7-9 后控制台可见；Task 10-11 是数据迁移与上线，可独立推迟。
