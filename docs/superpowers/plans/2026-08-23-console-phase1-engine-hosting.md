# 控制台阶段 1 · 引擎服务端宿主化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `client/` 的导出引擎能在网关进程里跑起来——同一套 `executor` / `downloader` /
`discovery`，换成 MySQL 的 `Store` 与进程内的 `AssetSource`，最终 `bun src/worker/index.ts`
能把一场会议的资产拉进服务端归档区。

**Architecture:** 三步。① 把引擎从 `client/src/` 提到 `packages/engine/`，同时把
`GatewayClient` 接口与它的 HTTP 实现拆开（接口进引擎、实现留 CLI）；② 把 `Store` 接口
异步化（MySQL 驱动是异步的，SQLite 实现加 `async` 即可，行为不变）；③ 在 `src/worker/`
写两个新实现——MySQL 的 `Store` 与直连 `catalog/`+`tencent/` 的 `AssetSource`，再加一个
入口把它们装起来。**引擎本身一行逻辑不改。**

**Tech Stack:** Bun + TypeScript(strict) · `bun:sqlite`（CLI 宿主）· MySQL 8.0.19+ /
`mysql2/promise`（服务端宿主）· `bun test`

---

## Global Constraints

- **MySQL 版本下限从 5.7+ 提到 8.0+**。`claimNext` 用 `SELECT … FOR UPDATE SKIP LOCKED`，
  5.7 不支持。本地实测 8.4.9、生产 RDS 8.0.36，均满足。文档里所有 "MySQL 5.7+" 字样必须一并改掉。
- **测试库连接串只经 `TEST_DATABASE_URL` 环境变量传入，绝不写进任何提交的文件**；
  bash 中必须单引号包裹（密码含 `!` 会触发历史展开）。
- **基线**：本计划开工前 `TEST_DATABASE_URL='…' bun test`（仓库根）= **395 pass / 0 fail**，
  `cd client && bun test` = **75 pass / 0 fail**。每个任务结束后这两个数字只许涨不许跌。
- 未设 `TEST_DATABASE_URL` 时根目录会有 28 个失败，全部是网关库测试，与本计划无关。
- **引擎逻辑零改动**：任务 2、3 是纯搬运与纯签名变更。凡是「顺手改一下」的逻辑修改，
  一律不做，记进台账另开任务。
- 新表用 `utf8mb4` / `utf8mb4_unicode_ci` / `ENGINE=InnoDB`，时间列一律 `BIGINT` 存 unix 秒。
- `migrations/*.sql` 里**不许出现分号以外用途的分号**（注释里也不行）——`runMigrations`
  按 `;` 朴素切分语句。
- 提交信息沿用仓库惯例：conventional 前缀 + 中文正文讲「为什么」+ 两条 trailer。

---

## 范围说明：为什么只到阶段 1

[`docs/console/dev-plan.md`](../../console/dev-plan.md) 划了六个阶段。本计划**只覆盖阶段 1
（E1–E4）与阶段 0.3 里现在就能做的部分**，理由：

| 不在本计划里 | 为什么 |
| --- | --- |
| 阶段 0.2 M3.5 真实环境联调 | 需要真实腾讯 / 企微凭证与联调环境，是**你**要做的事，不是代码任务 |
| C6（开放 `end_time` 字段） | 依赖 M3.5 确认 `record_end_time` 真实存在。本计划只清掉那处**已被证伪的过期注释** |
| 阶段 2 及以后 | 依赖阶段 1 落地。现在展开，写到阶段 3 就过期了 |
| 阶段 5 F1 前端骨架 | 不同技术栈、与后端完全并行，应当另起一份计划 |

---

## File Structure

```
packages/engine/                      ← 新增：CLI 与服务端共用的引擎
  package.json                        @yaowu/mde-engine
  tsconfig.json
  src/index.ts                        统一出口，两个宿主只从这里 import
  src/source/types.ts                 ← 新增：AssetSource 接口（从 client/gateway 抽出）
  src/domain/{types,readiness,filename,window}.ts   ← 从 client/src/domain/ 移入
  src/store/types.ts                  ← 从 client/src/store/index.ts 拆出的接口部分
  src/store/sqlite.ts                 ← 同上，SQLite 实现部分
  src/store/db.ts                     ← 从 client/src/store/db.ts 移入
  src/{downloader,executor,discovery}/index.ts      ← 移入
  src/storage/{types,local}.ts        ← 移入
  tests/…                             ← 对应测试一并移入

client/                               ← 只剩 CLI 外壳
  src/gateway/client.ts               HTTP 实现 + GatewayError（接口已移走）
  src/config/index.ts
  src/cli/**

src/worker/                           ← 新增：服务端宿主
  store-mysql.ts                      Store 的 MySQL 实现（含 SKIP LOCKED 领取）
  source-inproc.ts                    AssetSource 的进程内实现（直连 catalog + records）
  index.ts                            装配 + 入口

migrations/002_worker_queue.sql       ← 新增：meetings / meeting_assets / meeting_asset_probes
src/store/db.ts                       runMigrations 改成枚举目录（现在硬编码 001）
```

---

## 任务依赖与并行批次

```
批次 1（三路并行，文件互不重叠）
  T1  消解规格冲突        docs/** + src/domain/types.ts 一处注释
  T2  引擎抽包 + 接口拆分  client/** → packages/engine/**
  T4  migrations 多文件 + 002   src/store/db.ts + migrations/

批次 2（两路并行）
  T3  Store 接口异步化     packages/engine/** + client/**      ← 依赖 T2
  T6  AssetSource 进程内实现  src/worker/source-inproc.ts       ← 依赖 T2

批次 3（单路）
  T5  Store 的 MySQL 实现   src/worker/store-mysql.ts           ← 依赖 T3 + T4

批次 4（单路）
  T7  worker 入口 + 端到端冒烟  src/worker/index.ts             ← 依赖 T5 + T6
```

---

## Task 1: 消解现在就能定的规格冲突

**Files:**
- Modify: `docs/console/spec.md`（§5.1 §5.3 §6.2 §6.3）
- Modify: `docs/console/dev-plan.md`（§5 冲突表标注消解状态）
- Modify: `docs/console/prototype/gate-console.html:3344-3348`（两处显示用的「腾讯侧类型」写错了）
- Modify: `src/domain/types.ts:27-35`（已被证伪的过期注释）

**Interfaces:** 无代码接口变更。本任务的产出是**后续任务的判据**——T5/T7 不读这些文档也能做，
但阶段 3 的规则引擎必须以改完的 `spec.md` §5 为准。

- [ ] **Step 1: 清掉 `src/domain/types.ts` 里已被证伪的注释**

`meetingEndTime()`（`src/tencent/records.ts:66`）在 `d191f5b`（2026-08-21）已经改成从
`record_files[].record_end_time` 取最大值；而这段注释停在 `f00406b`（2026-07-21），
说的还是「本次未做」。它现在是错的，且正因为它，`policy/expr.ts` 还在拒绝 `end_time`。

把 `src/domain/types.ts` 中 `endTime` 上方的注释整段替换为：

```ts
  /**
   * unix 秒 UTC——取自 `record_files[].record_end_time` 的最大值
   * （见 tencent/records.ts 的 meetingEndTime）。`record_files` 全部缺该字段时
   * 回落到 `media_start_time`，此时 endTime === startTime、时长算出来是 0。
   *
   * 策略引擎（policy/expr.ts）目前仍未开放 end_time 作为可查询字段——
   * 那是历史决定（当时 endTime 确实是 startTime 的镜像），条件是
   * **M3.5 联调用真实响应确认 record_end_time 存在**，确认后即可开放。
   * 在此之前不要开放：回落路径下「按时长管控」会静默变成恒不匹配。
   */
```

- [ ] **Step 2: 验证注释与实现现在一致**

Run: `sed -n '/export interface Meeting/,/^}/p' src/domain/types.ts | grep -c "record_end_time"`
Expected: `1`

Run: `grep -n "end_time" src/policy/expr.ts`
Expected: 仍然查不到 `end_time` 作为合法字段（本步不开放它，只改注释）

- [ ] **Step 3: 修 `spec.md` §6.2 的两行错映射**

`spec.md` §6.2 的「腾讯侧类型」列有两行与 M3.5 实测不符。把整张表的第三列换成
**网关实际 emit 的 `asset_type`**，并在表下加一句权威声明：

```markdown
| key | 名称 | 网关 `asset_type` |
| --- | --- | --- |
| `summary` | AI 纪要 | `ai_minutes` |
| `transcript` | 完整转写 | `meeting_summary` |
| `speaker` | 发言人纪要 | `ai_speaker_minutes` |
| `topic` | 话题纪要 | `ai_topic_minutes` |
| `aitr` | AI 转写 | `ai_meeting_transcripts` |
| `digest` | 会议摘要 | `ai_ds_minutes` |
| `video` | 录像 | `video` |
| `audio` | 音频 | `audio` |

**这一列的权威在代码里，不在本表**：`packages/engine/src/domain/types.ts` 的
`ASSET_KEY_TO_GATEWAY_TYPE` 是唯一事实源，本表只是它的人类可读副本。两处不一致时以代码为准。

左列那套短名（`summary` / `aitr` / `digest`）**只是原型 HTML 内部的显示用键**。
前端工程化（F1）时必须直接采用 `AssetKey`，**不要把这套短名带进代码**——同一批资产
已经有过三套叫法，M3.5 为此吃过一次亏（见 `dev-plan.md` §5 C7）。
```

- [ ] **Step 4: 修原型里同样的两处**

`docs/console/prototype/gate-console.html` 第 3344–3348 行的 `ASSETS` 表，第三个元素是
界面上显示的「腾讯侧类型」提示文案，改两处：

```js
const ASSETS = [
  ['summary','AI 纪要','ai_minutes'], ['transcript','完整转写','meeting_summary'],
  ['speaker','发言人纪要','ai_speaker_minutes'], ['topic','话题纪要','ai_topic_minutes'],
  ['aitr','AI 转写','ai_meeting_transcripts'], ['digest','会议摘要','ai_ds_minutes'],
  ['video','录像','video · 体积最大'], ['audio','音频','audio']
];
```

**不要动第一个元素（内部键）。** 那是原型内部的显示用键，改它要连带改十几处 DOM 逻辑，
收益却全在 F1——F1 是新写代码，那时用 `AssetKey` 成本为零。

- [ ] **Step 5: 在 `spec.md` §5.1 写死求值语义的两条细节**

现有 `policy/engine.ts` 是 `a.priority - b.priority`（**升序**）取第一条，且「同优先级
deny 优先」；spec §5.1 要的是**降序**、第一条命中的说了算。两套语义对同一批数据会得出
相反结论。在 §5.1 的求值伪码后面追加：

```markdown
两条必须写死的细节：

1. **同优先级的平局**：按 `id` 升序，先建的先命中。不按 effect 决定平局——
   「deny 优先」是另一套语义（合并式），与本节的「第一条说了算」互斥，混用会让
   规则列表的顺序不再是判定顺序，管理员就读不出结果了。
2. **与现有实现相反**：`src/policy/engine.ts` 当前按 priority **升序**取第一条，
   且同优先级 deny 优先。阶段 3 的 R1 以本节为准重写，**并且必须写迁移**：
   迁移跑完后拿迁移前的规则集与会议集重算一遍，判定结果逐条比对，不一致的列出来
   交人工确认——不许脚本自行决定。
```

- [ ] **Step 6: 在 `spec.md` §5.3 标注 `dept` 的数据依赖**

`dept`（主持人部门）在网关侧**没有数据源**：`src/policy/engine.ts` 的 `subjectMatches`
明写「department / role 需组织架构数据，属后续能力」。在 §5.3 表格下加：

```markdown
> **`dept` 依赖企微通讯录，网关目前没有这份数据。** 它是归档规则最自然的写法
> （「财务部的会议归到 /nas/meetings-finance/」），所以**不删这个字段**，而是把
> 「接企微通讯录 API + 部门同步」立成阶段 3 的前置任务 R0。
> 在 R0 落地前，规则编辑器里这个字段应当可见但禁用，并写明原因——
> 不要让它看起来能用却静默不匹配。
```

- [ ] **Step 7: 在 `spec.md` §6.3 补规则主体的语义**

三栈规则的主体语义与现有 `policy_rules.subject_type/subject_value` 不同。在 §6.3 的
规则结构下加：

```markdown
**主体（谁）在三栈里的含义不同**：

| 栈 | 主体 | 说明 |
| --- | --- | --- |
| 拉取 `fetch` | **无** | 系统级行为，不针对任何人 |
| 归档 `archive` | **无** | 同上 |
| 采集权限 `allow` | **采集程序** | 不是人。对应 `service_accounts.id` |

现有 `policy_rules.subject_type` 只认 `user`，需增加 `program` 取值；fetch / archive
两栈的主体列留空，并在引擎里**显式忽略**（不是「恰好匹配不上」）。
```

- [ ] **Step 8: 在 `dev-plan.md` §5 冲突表里标注状态**

给 C1–C7 每行加一列「状态」：C1 `📌 已写进 spec §5.1，待 R1 实现`、
C2 `✅ 已定`、C3 `✅ 已定`、C4 `✅ 已定`、C5 `📌 改为 R0 前置任务，不删字段`、
C6 `🟡 注释已清，字段待 M3.5`、C7 `✅ 已定`。

- [ ] **Step 9: 验证**

Run: `grep -c "meeting_summary\|ai_meeting_transcripts" docs/console/spec.md docs/console/prototype/gate-console.html`
Expected: 两个文件各 ≥ 2

Run: `TEST_DATABASE_URL='<连接串>' bun test 2>&1 | tail -3`
Expected: `395 pass / 0 fail`（本任务只改注释与文档，测试数字必须原样）

- [ ] **Step 10: Commit**

```bash
git add docs/console/spec.md docs/console/dev-plan.md \
        docs/console/prototype/gate-console.html src/domain/types.ts
git commit -m "docs(console): 消解六处规格冲突，清掉 endTime 的过期注释"
```

---

## Task 2: 引擎抽包 + AssetSource 接口从 HTTP 实现里拆出来

**Files:**
- Create: `packages/engine/package.json` · `packages/engine/tsconfig.json` · `packages/engine/src/index.ts`
- Create: `packages/engine/src/source/types.ts`
- Move: `client/src/{domain,downloader,executor,discovery,storage}/` → `packages/engine/src/`
- Move: `client/src/store/{index,db}.ts` → `packages/engine/src/store/`
- Move: `client/tests/{domain,downloader,executor,discovery,storage,store}/` → `packages/engine/tests/`
- Modify: `package.json`（根，加 `workspaces`）
- Modify: `client/package.json`（加 `@yaowu/mde-engine` 依赖）
- Modify: `client/src/gateway/client.ts`（只留实现与错误类）
- Modify: `client/src/cli/commands/*.ts`（import 路径）

**Interfaces:**
- Produces: `@yaowu/mde-engine` 包，导出 `AssetSource` / `SourceAsset` / `DownloadUrl` /
  `Store` / `Storage` / `Meeting` / `MeetingSelector` / `AssetKey` / `runExecutor` /
  `runProbes` / `discover` / `downloadAsset` / `createStore` / `openDb` / `createLocalStorage`
  以及 `domain/types.ts` 的全部导出
- Consumes: 无

- [ ] **Step 1: 建 workspace**

根 `package.json` 加一行（其余不动）：

```json
  "private": true,
  "workspaces": ["client", "packages/*"],
  "type": "module",
```

- [ ] **Step 2: 建包骨架**

`packages/engine/package.json`：

```json
{
  "name": "@yaowu/mde-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "bun test", "typecheck": "tsc --noEmit" },
  "devDependencies": { "@types/bun": "latest", "typescript": "^5.6.0" }
}
```

`packages/engine/tsconfig.json`（照抄 `client/tsconfig.json`，只改 include）：

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
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: 用 `git mv` 搬文件（保住 rename 历史）**

```bash
mkdir -p packages/engine/src packages/engine/tests
for d in domain downloader executor discovery storage store; do
  git mv client/src/$d packages/engine/src/$d
  git mv client/tests/$d packages/engine/tests/$d
done
```

`client/tests/store/` 下有 `index.test.ts` 与 `migration.test.ts`，一并搬走。

- [ ] **Step 4: 把 `AssetSource` 接口抽出来**

引擎的 `downloader` / `executor` / `discovery` 三处都 `import type { GatewayClient } from
'../gateway/client'`——而 `gateway/client.ts` 是 **CLI 的 HTTP 实现**，引擎不能依赖它。
把接口部分单独建文件，同时改名：服务端**自己就是网关**，叫 `GatewayClient` 会误导。

新建 `packages/engine/src/source/types.ts`：

```ts
import type { Meeting, MeetingSelector } from '../domain/types'

/** 一份可下载的资产。`remoteId` 是平台侧的 record_file_id。 */
export interface SourceAsset {
  assetId: string
  assetType: string
  remoteId: string
  /**
   * 平台转码状态。网关的 assets 响应**不包含此字段**（见
   * src/http/handlers/meetings.ts 的 toWire），所以两个宿主下它都恒为
   * undefined，judgeReadiness 会走「无状态信息」分支。保留字段是为了将来
   * 网关补上时不用改接口。
   */
  state?: number
  allowDownload?: boolean
  fileType?: string | null
  bytesExpected?: number | null
}

export interface DownloadUrl {
  url: string
  expiresAt: number
  fileType: string | null
  bytesExpected: number | null
}

/**
 * 引擎取数的唯一出口。两个实现：
 * - `client/src/gateway/client.ts`  —— HTTP，管理员机器上的 CLI 用
 * - `src/worker/source-inproc.ts`   —— 进程内直连 catalog + records，服务端用
 */
export interface AssetSource {
  listMeetings(sel: MeetingSelector, cursor?: string, limit?: number): Promise<{ meetings: Meeting[]; nextCursor: string | null }>
  listAssets(meetingId: string, from?: number, to?: number): Promise<SourceAsset[]>
  getDownloadUrl(assetId: string): Promise<DownloadUrl>
}
```

- [ ] **Step 5: 三处 import 改指向新接口**

`packages/engine/src/{downloader,executor,discovery}/index.ts` 顶部：

```ts
// 改前
import type { GatewayClient } from '../gateway/client'
// 改后
import type { AssetSource } from '../source/types'
```

同时把文件内的类型引用改名（`downloader` 与 `executor` 是 `Pick<GatewayClient, …>`，
`discovery` 是 `gw: GatewayClient`）：

```ts
// downloader/index.ts
export interface DownloadDeps { storage: Storage; gw: Pick<AssetSource, 'getDownloadUrl'>; onProgress?: (bytes: number) => void }
// executor/index.ts
  gw: Pick<AssetSource, 'listAssets'>
// discovery/index.ts
export interface DiscoveryDeps { gw: AssetSource; store: Store }
```

`GatewayAsset` 在 `discovery`/`executor` 里若被显式引用，改成 `SourceAsset`。

- [ ] **Step 6: `client/src/gateway/client.ts` 只留实现**

删掉文件里的 `GatewayAsset` / `DownloadUrl` / `GatewayClient` 三个 interface 声明，
改从引擎 import；`GatewayError` 与 `MeetingNotFoundInRangeError` **留在这里**——
它们是 HTTP 语义（状态码、错误码），进程内实现用不上：

```ts
import type { AssetSource, SourceAsset, DownloadUrl } from '@yaowu/mde-engine'
import type { Meeting, MeetingSelector } from '@yaowu/mde-engine'

export class GatewayError extends Error { /* 原样保留 */ }
export class MeetingNotFoundInRangeError extends Error { /* 原样保留 */ }

export function createGatewayClient(/* 原样 */): AssetSource { /* 函数体原样 */ }
```

内部的 `RawAsset → GatewayAsset` 转换改成 `→ SourceAsset`，字段映射不变。

- [ ] **Step 7: 写引擎的统一出口**

`packages/engine/src/index.ts`：

```ts
export * from './domain/types'
export { judgeReadiness } from './domain/readiness'
export { cleanDirName } from './domain/filename'
export { splitWindow } from './domain/window'
export type { AssetSource, SourceAsset, DownloadUrl } from './source/types'
export type { Store, AssetRow, AssetUpsert, ProbeRow, ProbeKey, ProbeUpsert } from './store'
export { createStore } from './store'
export { openDb } from './store/db'
export type { Storage } from './storage/types'
export { createLocalStorage } from './storage/local'
export { downloadAsset } from './downloader'
export type { DownloadDeps, DownloadTask, DownloadResult } from './downloader'
export { runExecutor, runProbes } from './executor'
export type { ExecutorDeps } from './executor'
export { discover } from './discovery'
export type { DiscoveryDeps } from './discovery'
```

`createLocalStorage` 的实际导出名以 `storage/local.ts` 为准，不一致就照它改。

- [ ] **Step 8: 改 client 的依赖与 import**

`client/package.json` 加：

```json
  "dependencies": { "@yaowu/mde-engine": "workspace:*" },
```

`client/src/**` 与 `client/bin/**` 里所有指向已搬走模块的相对路径，一律改成
`from '@yaowu/mde-engine'`。找出全部：

```bash
grep -rn "from '\.\./\(domain\|store\|storage\|downloader\|executor\|discovery\)" client/src client/bin
```

- [ ] **Step 9: 引擎测试的 import 改成相对新位置**

`packages/engine/tests/**` 里 `from '../../src/xxx'` 的层级不变（tests 与 src 同级），
但原先引用 `../../src/gateway/client` 的地方要改成 `../../src/source/types`。找出全部：

```bash
grep -rn "gateway/client" packages/engine/tests
```

`client/tests/gateway/client.test.ts` 留在 client，它测的是 HTTP 实现。

- [ ] **Step 10: 装依赖并验证三处 typecheck**

Run: `bun install`
Run: `bun run typecheck` （根）
Run: `cd packages/engine && bun run typecheck`
Run: `cd client && bun run typecheck`
Expected: 三处均无输出（干净）

- [ ] **Step 11: 验证测试总数不变**

Run: `cd packages/engine && bun test 2>&1 | tail -3`
Run: `cd client && bun test 2>&1 | tail -3`
Expected: 两处相加 = **75 pass / 0 fail**（搬家前 client 是 75；一条都不许少）

Run: `TEST_DATABASE_URL='<连接串>' bun test 2>&1 | tail -3`（仓库根）
Expected: `395 pass / 0 fail`

- [ ] **Step 12: 验证 CLI 行为没变**

Run: `cd client && bun bin/mde.ts --help`
Expected: 与搬家前逐字相同的帮助文本

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "refactor(engine): 引擎提到 packages/engine，AssetSource 接口与 HTTP 实现拆开"
```

---

## Task 3: Store 接口异步化

**Files:**
- Modify: `packages/engine/src/store/index.ts`（接口全部返回 Promise，SQLite 实现加 async）
- Modify: `packages/engine/src/executor/index.ts`（含 `buildRelPath` 变异步的连锁）
- Modify: `packages/engine/src/discovery/index.ts`
- Modify: `client/src/cli/commands/{status,retry}.ts`
- Modify: `packages/engine/tests/{store,executor,discovery}/*.test.ts`

**Interfaces:**
- Consumes: T2 产出的 `@yaowu/mde-engine`
- Produces: `Store` 的每个方法都返回 `Promise<…>`。T5 的 MySQL 实现按这个签名写。

**为什么必须做**：`mysql2/promise` 是异步的，同步接口根本没法实现。SQLite 侧只是给
方法加 `async`——`await` 一个同步返回值是 no-op，**行为零变化**。

- [ ] **Step 1: 改接口签名**

`packages/engine/src/store/index.ts` 的 `Store` interface，每个方法包一层 Promise：

```ts
export interface Store {
  upsertMeeting(m: Meeting, now: number): Promise<void>
  upsertAsset(a: AssetUpsert, now: number): Promise<void>
  claimNext(now: number, leaseSec: number): Promise<AssetRow | null>
  markCompleted(id: number, contentHash: string | null, now: number): Promise<void>
  markFailed(id: number, err: string, now: number): Promise<void>
  markSkipped(id: number, reason: string, now: number): Promise<void>
  markSkippedByKey(k: ProbeKey, reason: string, now: number): Promise<void>
  markDead(id: number, err: string, now: number): Promise<void>
  touchProgress(id: number, bytesWritten: number, now: number, leaseSec: number): Promise<void>
  setTargetPath(id: number, path: string, fileType: string | null, now: number): Promise<void>
  siblingRank(row: { id: number; meeting_id: string; sub_meeting_id: string; asset_type: string; file_type: string | null }): Promise<{ ordinal: number; total: number }>
  upsertProbe(p: ProbeUpsert): Promise<void>
  dueProbes(now: number): Promise<ProbeRow[]>
  resolveProbe(k: ProbeKey): Promise<void>
  abandonProbe(k: ProbeKey, reason: string): Promise<void>
  bumpProbe(k: ProbeKey, probeAfter: number): Promise<void>
  counts(): Promise<Record<AssetStatus, number>>
  failures(): Promise<AssetRow[]>
  resetFailed(now: number): Promise<number>
  /**
   * 拼落盘路径要用的会议元数据，键为 meeting_id。
   *
   * 新增这个方法不是顺手加功能——`client/src/cli/commands/{run,execute}.ts` 各有一份
   * **逐字重复**的 `loadMeetings(db)`，都绕过 Store 直接查 SQLite 的 `db`，且全程 `any`。
   * 那条路在 MySQL 宿主下根本不存在，必须收进接口。
   */
  meetingsForPaths(): Promise<Map<string, { subject: string | null; startTime: number | null; meetingCode: string | null; endTime: number | null; subMeetingId: string }>>
}
```

`siblingRank` 的那段中文注释原样保留。

- [ ] **Step 2: SQLite 实现每个方法加 `async`**

`createStore` 返回的对象里，每个方法前加 `async`，**函数体一个字不改**。例如：

```ts
    async upsertMeeting(m, now) { /* 原样 */ },
    async claimNext(now, leaseSec) { return claimStmt.get(now + leaseSec, now, now) ?? null },
    async markCompleted(id, h, now) { /* 原样 */ },
```

再补上新方法（实现就是从两个 CLI 命令里搬过来的那段 SQL，去掉 `any`）：

```ts
    async meetingsForPaths() {
      const rows = db.query<{ meeting_id: string; sub_meeting_id: string; subject: string | null;
                              meeting_code: string | null; start_time: number | null; end_time: number | null }, []>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time FROM meetings`,
      ).all()
      return new Map(rows.map((r) => [r.meeting_id, {
        subject: r.subject, startTime: r.start_time, meetingCode: r.meeting_code,
        endTime: r.end_time, subMeetingId: r.sub_meeting_id,
      }]))
    },
```

- [ ] **Step 3: `executor` 里 `buildRelPath` 连锁变异步**

`buildRelPath` 是同步函数，但它内部调 `deps.store.siblingRank(row)`。这是本任务唯一
**不是机械加 await** 的地方：

```ts
async function buildRelPath(deps: ExecutorDeps, row: AssetRow): Promise<string | null> {
  const m = deps.meetingsById.get(row.meeting_id)
  if (!m) return null
  /* …中间原样… */
  const { ordinal } = await deps.store.siblingRank(row)
  const fname = assetKeyToFilename(key, row.remote_id, row.file_type, ordinal)
  return `${yyyy}/${mm}/${dir}/${fname}`
}
```

`handleOne` 里的调用点：

```ts
  const relPath = await buildRelPath(deps, row)
```

- [ ] **Step 4: 其余调用点机械加 await**

产品代码 25 处、测试 43 处。逐个文件加 `await`，规则：凡 `deps.store.` / `store.` 开头的
调用都要 await。列出全部调用点：

```bash
grep -rn "store\." packages/engine/src client/src --include='*.ts' | grep -v '/store/'
grep -rn "\.\(upsertMeeting\|upsertAsset\|claimNext\|markCompleted\|markFailed\|markSkipped\|markSkippedByKey\|markDead\|touchProgress\|setTargetPath\|siblingRank\|upsertProbe\|dueProbes\|resolveProbe\|abandonProbe\|bumpProbe\|counts\|failures\|resetFailed\)(" packages/engine/tests client/tests
```

注意三个易漏点：

1. `executor` 里 `for (const p of deps.store.dueProbes(now()))` → `for (const p of await deps.store.dueProbes(now()))`
2. `executor` 的 `touchProgress` 在**回调里**：
   `(b) => deps.store.touchProgress(row.id, b, now(), leaseSec)` ——
   `downloader` 的 `onProgress` 签名是 `(bytes: number) => void`，返回 Promise 不报错但
   会成为**未处理的 floating promise**。

   **不要用 `void`**（本计划初稿如此，T3 的评审证明是错的）：`void` 不挂 rejection
   handler，写库失败会被彻底吞掉——异步化之前这个错误会冒泡到 `downloader` 的 catch、
   把资产落成 `failed` 从而可被 `retry` 重置；用 `void` 之后同一个错误变成「资产标成
   completed，但 bytes_written 停在出错前的值，且没有任何日志」。SQLite 宿主下几乎不
   触发，MySQL 宿主下这是按下载块高频触发的池化连接 UPDATE，deadlock / connection
   reset / pool timeout 都很现实——而那正是本计划存在的理由。

   写成：
   ```ts
   (b) => { deps.store.touchProgress(row.id, b, now(), leaseSec)
              .catch((e) => console.warn(`progress write failed: ${e}`)) }
   ```
   注释写明：进度回写是尽力而为，失败不中断下载，**但必须留下痕迹**。
3. 测试里 `expect(store.counts()).toEqual(...)` 之类要改成 `expect(await store.counts())`。
   **漏掉 await 时 `toEqual` 会拿 Promise 去比对象而失败**，不会静默通过——这点是安全的。

- [ ] **Step 4b: 删掉两份重复的 `loadMeetings`，改用新方法**

`client/src/cli/commands/run.ts:34-37` 与 `client/src/cli/commands/execute.ts:24-27` 是
**逐字相同**的两份 helper，都直接查 `db` 绕过 Store，且参数与返回全是 `any`。删掉两份，
调用点改成：

```ts
  const meetingsById = await store.meetingsForPaths()
```

同时把这两个文件里 `deps as any` 的强转去掉——`meetingsById` 有了准确类型之后，
`runProbes(deps, now)` / `runExecutor(deps, …, now)` 应当能直接通过类型检查。
若仍需 `as any`，说明还有别的类型缺口，**在这里补掉，不要留着**。

Run: `grep -rn "loadMeetings\|deps as any" client/src`
Expected: 无输出

- [ ] **Step 5: typecheck 兜底**

Run: `cd packages/engine && bun run typecheck && cd ../../client && bun run typecheck`
Expected: 干净。`noUncheckedIndexedAccess` + strict 下，漏掉的 await 大多会在这里暴露成
`Promise<X>` 不能赋给 `X`。

- [ ] **Step 6: 跑测试，确认行为零变化**

Run: `cd packages/engine && bun test 2>&1 | tail -3`
Run: `cd client && bun test 2>&1 | tail -3`
Expected: 两处相加仍是 **75 pass / 0 fail**。测试数量、通过数**都不许变**——变了说明
不是纯签名改动。

- [ ] **Step 7: 确认没有 floating promise**

Run: `grep -rn "store\.\(mark\|upsert\|touch\|set\|resolve\|abandon\|bump\)" packages/engine/src client/src | grep -v "await\|void "`
Expected: 无输出（每个写操作要么被 await，要么被显式 `void`）

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(engine): Store 接口异步化，为 MySQL 宿主让路"
```

---

## Task 4: migrations 支持多文件 + 002 建服务端队列表

**Files:**
- Modify: `src/store/db.ts`（`runMigrations` 现在硬编码 `001_init.sql`）
- Create: `migrations/002_worker_queue.sql`
- Create: `tests/store/migrations.test.ts`
- Modify: `docs/deploy.md` · `docs/phase-1-summary.md` · `docs/m3.5-integration-runbook.md`
  （"MySQL 5.7+" → "MySQL 8.0+"）

**Interfaces:**
- Produces: 表 `meetings` / `meeting_assets` / `meeting_asset_probes`；`runMigrations(pool)`
  签名不变但会执行 `migrations/` 下全部 `.sql`，按文件名升序

- [ ] **Step 1: 先写失败的测试**

`tests/store/migrations.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'

describe('runMigrations', () => {
  test('执行 migrations 目录下的全部 .sql，不只是 001', async () => {
    await withTestDb(async (pool) => {
      const [rows] = await pool.query<any[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`,
      )
      const names = rows.map((r) => (r.table_name ?? r.TABLE_NAME) as string)
      // 001 的表
      expect(names).toContain('policy_rules')
      // 002 的表
      expect(names).toContain('meetings')
      expect(names).toContain('meeting_assets')
      expect(names).toContain('meeting_asset_probes')
    })
  })

  test('meeting_assets 的唯一键含 file_type', async () => {
    await withTestDb(async (pool) => {
      const [rows] = await pool.query<any[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'meeting_assets'
            AND index_name = 'uk_asset' ORDER BY seq_in_index`,
      )
      const cols = rows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(cols).toEqual(['meeting_id', 'sub_meeting_id', 'asset_type', 'remote_id', 'file_type'])
    })
  })
})
```

`withTestDb` 的确切签名以 `tests/helpers/testdb.ts` 现有实现为准；照它的用法写。

- [ ] **Step 2: 跑测试确认失败**

Run: `TEST_DATABASE_URL='<连接串>' bun test tests/store/migrations.test.ts`
Expected: FAIL —— `expect(names).toContain('meetings')` 失败（002 还不存在，且
`runMigrations` 也还只跑 001）

- [ ] **Step 3: 写 `migrations/002_worker_queue.sql`**

```sql
-- 服务端归档 worker 的队列表。
--
-- 与 001 的 meeting_cache 的关系：meeting_cache 是网关列会议时顺手写的机会性缓存，
-- 只服务策略引擎，字段不全、没有生命周期。本文件的 meetings 是控制台的主表，
-- 承载拉取/归档/保留/授权四个阶段的状态。阶段 4（A2）把控制台的查询接到这张表上之后
-- meeting_cache 退役，届时另写迁移删除，本次不动它。
--
-- 注意 runMigrations 按分号朴素切分语句，本文件任何注释里都不许出现分号。

CREATE TABLE IF NOT EXISTS meetings (
  meeting_id     VARCHAR(64)   NOT NULL,
  sub_meeting_id VARCHAR(64)   NOT NULL DEFAULT '',
  meeting_code   VARCHAR(64)   NULL,
  subject        VARCHAR(512)  NULL,
  host_userid    VARCHAR(128)  NULL,
  start_time     BIGINT        NULL,
  end_time       BIGINT        NULL,
  created_at     BIGINT        NOT NULL,
  updated_at     BIGINT        NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id),
  KEY idx_meetings_start (start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_assets (
  id               BIGINT        NOT NULL AUTO_INCREMENT,
  meeting_id       VARCHAR(64)   NOT NULL,
  sub_meeting_id   VARCHAR(64)   NOT NULL DEFAULT '',
  asset_type       VARCHAR(64)   NOT NULL,
  remote_id        VARCHAR(128)  NOT NULL,
  asset_id         VARCHAR(255)  NULL,
  status           VARCHAR(16)   NOT NULL DEFAULT 'pending',
  storage_target   VARCHAR(16)   NOT NULL DEFAULT 'local',
  target_path      VARCHAR(1024) NULL,
  -- file_type 参与唯一键，故 NOT NULL DEFAULT 空串：同一份录制的多种导出格式
  -- 共享 record_file_id，只有格式能区分它们。可空列进唯一键等于没有约束。
  file_type        VARCHAR(32)   NOT NULL DEFAULT '',
  bytes_expected   BIGINT        NULL,
  bytes_written    BIGINT        NOT NULL DEFAULT 0,
  content_hash     VARCHAR(64)   NULL,
  attempts         INT           NOT NULL DEFAULT 0,
  lease_expires_at BIGINT        NULL,
  last_error       TEXT          NULL,
  completed_at     BIGINT        NULL,
  created_at       BIGINT        NOT NULL,
  updated_at       BIGINT        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_asset (meeting_id, sub_meeting_id, asset_type, remote_id, file_type),
  -- 列序是正确性依赖，不是性能微调：领取是 status 等值 + ORDER BY id，
  -- id 必须紧跟 status 才能用索引自带序满足排序。写成 (status, lease_expires_at, id)
  -- 会 filesort，而 filesort 要先读完并锁住整段可领取集合，于是并发 worker 的
  -- SKIP LOCKED 把它们全跳过、拿到 null、按 `if (!row) return` 集体收工。
  -- 实测：正确列序 4 把记录锁，错误列序 406 把。别当性能项优化掉。
  KEY idx_assets_claimable (status, id, lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_asset_probes (
  meeting_id     VARCHAR(64)   NOT NULL,
  sub_meeting_id VARCHAR(64)   NOT NULL DEFAULT '',
  asset_type     VARCHAR(64)   NOT NULL,
  state          VARCHAR(16)   NOT NULL DEFAULT 'probing',
  attempts       INT           NOT NULL DEFAULT 0,
  probe_after    BIGINT        NOT NULL DEFAULT 0,
  deadline_at    BIGINT        NOT NULL,
  last_reason    VARCHAR(128)  NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id, asset_type),
  KEY idx_probes_due (state, probe_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

SQLite 版有 `download_url` / `download_url_expires_at` 两列，实现从没用过（下载链接
每次现取），这里不建。

- [ ] **Step 4: 改 `runMigrations` 枚举目录**

`src/store/db.ts`：

```ts
import { readdir } from 'node:fs/promises'

/**
 * 逐个执行 migrations/ 下的 .sql，按文件名升序（001、002、…）。
 * migration 文件含多条语句，逐条执行（连接池禁用 multipleStatements）。
 *
 * 切分方式是按分号朴素 split，所以 .sql 文件里除语句结束符外不许出现分号，
 * 注释里也不行。
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const dir = `${import.meta.dir}/../../migrations`
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  for (const name of files) {
    const sql = await Bun.file(`${dir}/${name}`).text()
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const stmt of statements) {
      await pool.query(stmt)
    }
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `TEST_DATABASE_URL='<连接串>' bun test tests/store/migrations.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: 全量回归**

Run: `TEST_DATABASE_URL='<连接串>' bun test 2>&1 | tail -3`
Expected: `397 pass / 0 fail`（395 + 本任务新增 2）

- [ ] **Step 7: 改文档里的 MySQL 版本下限**

`SELECT … FOR UPDATE SKIP LOCKED`（T5 要用）需要 MySQL 8.0，5.7 不支持。把这三处的
"MySQL 5.7+" 改成 "MySQL 8.0+"，并注明原因：

- `docs/phase-1-summary.md:26`
- `docs/m3.5-integration-runbook.md:52`
- `docs/deploy.md`（grep 确认具体行号）

Run: `grep -rn "MySQL 5\.7" docs/`
Expected: 无输出

- [ ] **Step 8: Commit**

```bash
git add src/store/db.ts migrations/002_worker_queue.sql tests/store/migrations.test.ts docs/
git commit -m "feat(store): migrations 支持多文件，新增服务端队列表（002）"
```

---

## Task 5: Store 的 MySQL 实现

**Files:**
- Create: `src/worker/store-mysql.ts`
- Create: `tests/worker/store-mysql.test.ts`

**Interfaces:**
- Consumes: T3 的异步 `Store` 接口（`@yaowu/mde-engine`）；T4 的 002 表
- Produces: `createMysqlStore(pool: Pool): Store`

- [ ] **Step 1: 先写失败的测试（含并发领取）**

`tests/worker/store-mysql.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import { createMysqlStore } from '../../src/worker/store-mysql'

const M = { meetingId: 'm1', subMeetingId: '', meetingCode: '881', subject: '周会',
            hostUserId: 'u1', startTime: 1000, endTime: 2000 }

describe('createMysqlStore', () => {
  test('upsertAsset 按 file_type 区分同一 record_file 的多种格式', async () => {
    await withTestDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      for (const ft of ['txt', 'docx', 'pdf']) {
        await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary',
                              remoteId: 'r1', fileType: ft }, 100)
      }
      expect((await s.counts()).pending).toBe(3)
    })
  })

  test('claimNext 并发领取不重复', async () => {
    await withTestDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      for (let i = 0; i < 20; i++) {
        await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video',
                              remoteId: `r${i}`, fileType: 'mp4' }, 100)
      }
      // 40 路并发抢 20 条：每条只许被一个抢到，剩下 20 次拿到 null
      const got = await Promise.all(
        Array.from({ length: 40 }, () => s.claimNext(200, 60)),
      )
      const rows = got.filter((r) => r !== null)
      const ids = new Set(rows.map((r) => r!.id))
      expect(rows.length).toBe(20)
      expect(ids.size).toBe(20)          // ← 无重复领取
      expect((await s.counts()).running).toBe(20)
    })
  })

  test('租约过期后可被重新领取，attempts 累加', async () => {
    await withTestDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video',
                            remoteId: 'r1', fileType: 'mp4' }, 100)
      const first = await s.claimNext(200, 60)     // 租约到 260
      expect(first).not.toBeNull()
      expect(await s.claimNext(250, 60)).toBeNull()  // 未过期，抢不到
      const again = await s.claimNext(300, 60)       // 已过期
      expect(again!.id).toBe(first!.id)
      expect(again!.attempts).toBe(2)
    })
  })

  test('siblingRank 按 file_type 分组——多格式不加序号，多段才加', async () => {
    await withTestDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      // 同 asset_type、同 file_type、不同 remote_id 的两段 → 组内序号 1、2
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'a', fileType: 'txt' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'b', fileType: 'txt' }, 100)
      // 另一种格式 → 自己一组，序号 1（靠扩展名就能区分，不该被编成 _3）
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'a', fileType: 'pdf' }, 100)

      // claimNext 是 ORDER BY id，取回顺序即插入顺序
      const r1 = (await s.claimNext(200, 60))!
      const r2 = (await s.claimNext(200, 60))!
      const r3 = (await s.claimNext(200, 60))!

      expect(await s.siblingRank(r1)).toEqual({ ordinal: 1, total: 2 })   // txt 组第 1
      expect(await s.siblingRank(r2)).toEqual({ ordinal: 2, total: 2 })   // txt 组第 2 → transcript_2.txt
      expect(await s.siblingRank(r3)).toEqual({ ordinal: 1, total: 1 })   // pdf 组独一份 → transcript.pdf
    })
  })

  test('markSkippedByKey 不回退已完成、不打断执行中', async () => {
    await withTestDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: 'mp4' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'b', fileType: 'mp4' }, 100)
      const done = (await s.claimNext(200, 60))!
      await s.markCompleted(done.id, 'hash', 210)
      await s.markSkippedByKey({ meetingId: 'm1', subMeetingId: '', assetType: 'video' }, 'no', 220)
      const c = await s.counts()
      expect(c.completed).toBe(1)
      expect(c.skipped).toBe(1)
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TEST_DATABASE_URL='<连接串>' bun test tests/worker/store-mysql.test.ts`
Expected: FAIL —— `Cannot find module '../../src/worker/store-mysql'`

- [ ] **Step 3: 实现**

`src/worker/store-mysql.ts`：

```ts
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../store/db'
import type { AssetRow, AssetStatus, ProbeRow, Store } from '@yaowu/mde-engine'

/**
 * Store 的 MySQL 实现。与 packages/engine 的 SQLite 实现是同一个接口的两个宿主：
 * SQLite 服务 mde CLI（管理员机器），本文件服务归档 worker（服务器）。
 *
 * 两者行为必须一致——引擎的 executor 不知道自己跑在哪个宿主上。
 */
export function createMysqlStore(pool: Pool): Store {
  return {
    async upsertMeeting(m, now) {
      await pool.query(
        `INSERT INTO meetings (meeting_id,sub_meeting_id,meeting_code,subject,host_userid,start_time,end_time,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE
           meeting_code=new.meeting_code, subject=new.subject, host_userid=new.host_userid,
           start_time=new.start_time, end_time=new.end_time, updated_at=new.updated_at`,
        [m.meetingId, m.subMeetingId, m.meetingCode, m.subject, m.hostUserId, m.startTime, m.endTime, now, now],
      )
    },

    async upsertAsset(a, now) {
      // file_type 归一成空串而非 null：它参与唯一键，可空列进唯一键等于没有约束
      await pool.query(
        `INSERT INTO meeting_assets (meeting_id,sub_meeting_id,asset_type,remote_id,asset_id,status,bytes_expected,file_type,created_at,updated_at)
         VALUES (?,?,?,?,?,'pending',?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE
           asset_id=COALESCE(new.asset_id, meeting_assets.asset_id),
           bytes_expected=COALESCE(new.bytes_expected, meeting_assets.bytes_expected),
           updated_at=new.updated_at`,
        [a.meetingId, a.subMeetingId, a.assetType, a.remoteId, a.assetId ?? null,
         a.bytesExpected ?? null, a.fileType ?? '', now, now],
      )
    },

    /**
     * 领取一条任务。SQLite 版靠单进程 + 单条 UPDATE…RETURNING 天然互斥；
     * MySQL 是多实例并发，必须显式加行锁。
     *
     * SKIP LOCKED 是关键：没有它，并发的 worker 会在同一行上排队等锁，
     * 拿到锁时那行的 status 早已变成 running，等于白等一轮。有了它，
     * 被别人锁住的行直接跳过，每个 worker 领到不同的任务。
     *
     * 需要 MySQL 8.0+（见本仓库 Global Constraints）。
     */
    async claimNext(now, leaseSec) {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const [picked] = await conn.query<RowDataPacket[]>(
          `SELECT id FROM meeting_assets
            WHERE status='pending' OR (status='running' AND lease_expires_at < ?)
            ORDER BY id LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [now],
        )
        const id = picked[0]?.id as number | undefined
        if (id === undefined) {
          await conn.commit()
          return null
        }
        await conn.query(
          `UPDATE meeting_assets SET status='running', lease_expires_at=?, attempts=attempts+1, updated_at=? WHERE id=?`,
          [now + leaseSec, now, id],
        )
        const [got] = await conn.query<RowDataPacket[]>(
          `SELECT * FROM meeting_assets WHERE id=?`, [id],
        )
        await conn.commit()
        return (got[0] as AssetRow | undefined) ?? null
      } catch (err) {
        await conn.rollback()
        throw err
      } finally {
        conn.release()
      }
    },

    async markCompleted(id, h, now) {
      await pool.query(
        `UPDATE meeting_assets SET status='completed', content_hash=?, completed_at=?, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        [h, now, now, id])
    },
    async markFailed(id, e, now) {
      await pool.query(`UPDATE meeting_assets SET status='failed', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`, [e, now, id])
    },
    async markSkipped(id, r, now) {
      await pool.query(`UPDATE meeting_assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`, [r, now, id])
    },
    // 不回退已完成的下载、不中断执行中的任务——与 SQLite 版逐字一致
    async markSkippedByKey(k, r, now) {
      await pool.query(
        `UPDATE meeting_assets SET status='skipped', last_error=?, lease_expires_at=NULL, updated_at=?
          WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND status NOT IN ('completed','running')`,
        [r, now, k.meetingId, k.subMeetingId, k.assetType])
    },
    async markDead(id, e, now) {
      await pool.query(`UPDATE meeting_assets SET status='dead', last_error=?, lease_expires_at=NULL, updated_at=? WHERE id=?`, [e, now, id])
    },
    async touchProgress(id, bytes, now, leaseSec) {
      await pool.query(`UPDATE meeting_assets SET bytes_written=?, lease_expires_at=?, updated_at=? WHERE id=?`, [bytes, now + leaseSec, now, id])
    },
    async setTargetPath(id, p, ft, now) {
      await pool.query(`UPDATE meeting_assets SET target_path=?, file_type=COALESCE(?,file_type), updated_at=? WHERE id=?`, [p, ft, now, id])
    },

    async siblingRank(row) {
      const [r] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN id <= ? THEN 1 ELSE 0 END) AS ordinal
           FROM meeting_assets
          WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=? AND file_type=?`,
        [row.id, row.meeting_id, row.sub_meeting_id, row.asset_type, row.file_type ?? ''],
      )
      // MySQL 的 SUM 返回 DECIMAL，mysql2 给出的是 string，必须 Number 化
      return { ordinal: Number(r[0]?.ordinal ?? 1), total: Number(r[0]?.total ?? 1) }
    },

    async upsertProbe(p) {
      await pool.query(
        `INSERT INTO meeting_asset_probes (meeting_id,sub_meeting_id,asset_type,state,deadline_at,probe_after)
         VALUES (?,?,?,'probing',?,?) AS new
         ON DUPLICATE KEY UPDATE deadline_at=new.deadline_at`,
        [p.meetingId, p.subMeetingId, p.assetType, p.deadlineAt, p.probeAfter])
    },
    async dueProbes(now) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT * FROM meeting_asset_probes WHERE state='probing' AND probe_after <= ?`, [now])
      return rows as unknown as ProbeRow[]
    },
    async resolveProbe(k) {
      await pool.query(`UPDATE meeting_asset_probes SET state='resolved' WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`, [k.meetingId, k.subMeetingId, k.assetType])
    },
    async abandonProbe(k, r) {
      await pool.query(`UPDATE meeting_asset_probes SET state='abandoned', last_reason=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`, [r, k.meetingId, k.subMeetingId, k.assetType])
    },
    async bumpProbe(k, after) {
      await pool.query(`UPDATE meeting_asset_probes SET attempts=attempts+1, probe_after=? WHERE meeting_id=? AND sub_meeting_id=? AND asset_type=?`, [after, k.meetingId, k.subMeetingId, k.assetType])
    },

    async counts() {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT status, COUNT(*) n FROM meeting_assets GROUP BY status`)
      const out = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, dead: 0 } as Record<AssetStatus, number>
      for (const r of rows) out[r.status as AssetStatus] = Number(r.n)
      return out
    },
    async failures() {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM meeting_assets WHERE status IN ('failed','dead') ORDER BY id`)
      return rows as unknown as AssetRow[]
    },
    async resetFailed(now) {
      const [res] = await pool.query<any>(
        `UPDATE meeting_assets SET status='pending', last_error=NULL, updated_at=? WHERE status IN ('failed','dead')`, [now])
      return res.affectedRows as number
    },

    async meetingsForPaths() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time FROM meetings`)
      return new Map(rows.map((r) => [r.meeting_id as string, {
        subject: (r.subject ?? null) as string | null,
        startTime: r.start_time === null ? null : Number(r.start_time),
        meetingCode: (r.meeting_code ?? null) as string | null,
        endTime: r.end_time === null ? null : Number(r.end_time),
        subMeetingId: r.sub_meeting_id as string,
      }]))
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `TEST_DATABASE_URL='<连接串>' bun test tests/worker/store-mysql.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 并发测试要能真的抓到 bug——先验证它会失败**

临时把 `FOR UPDATE SKIP LOCKED` 改成 `FOR UPDATE`（或整段去掉锁），重跑并发那条：

Run: `TEST_DATABASE_URL='<连接串>' bun test tests/worker/store-mysql.test.ts -t 并发`
Expected: 去掉 SKIP LOCKED 后**测试仍可能通过**（`FOR UPDATE` 也互斥，只是会排队）；
但**整段去掉事务与锁**后必须失败（`ids.size < 20`）。确认失败后改回正确实现。

> 这一步是在验证「测试有没有在测东西」。一个并发测试如果去掉互斥还能过，它就是假的。

- [ ] **Step 6: 全量回归**

Run: `TEST_DATABASE_URL='<连接串>' bun test 2>&1 | tail -3`
Expected: `402 pass / 0 fail`

- [ ] **Step 7: Commit**

```bash
git add src/worker/store-mysql.ts tests/worker/store-mysql.test.ts
git commit -m "feat(worker): Store 的 MySQL 实现，claimNext 用 SKIP LOCKED 支持多实例"
```

---

## Task 6: AssetSource 的进程内实现

**Files:**
- Create: `src/worker/source-inproc.ts`
- Create: `src/domain/assetid.ts`（把仓库里两份私有的 `parseAssetId` 合成一份）
- Create: `tests/worker/source-inproc.test.ts`
- Create: `tests/domain/assetid.test.ts`
- Modify: `src/http/handlers/meetings.ts:243`（删自己那份，改 import）
- Modify: `src/catalog/index.ts:106`（同上，保留 `InvalidAssetIdError` 语义）

**Interfaces:**
- Consumes: T2 的 `AssetSource` / `SourceAsset` / `DownloadUrl`；现有 `Catalog`（`src/catalog/index.ts`）
  与 `RecordsApi`（`src/tencent/records.ts`）
- Produces: `createInProcSource(deps: { recordsApi, catalog, now }): AssetSource`

- [ ] **Step 1: 先写失败的测试**

`tests/worker/source-inproc.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { createInProcSource } from '../../src/worker/source-inproc'
import type { Asset, Meeting } from '../../src/domain/types'

const GW_MEETING: Meeting = {
  meetingId: 'm1', subMeetingId: 's1', meetingRecordId: 'rec1',
  meetingCode: '881-123-40', subject: '周会', hostUserId: 'u1',
  startTime: 1000, endTime: 5000, state: 'completed',
}
const GW_ASSET: Asset = {
  assetId: 'rec1:f1:video:0', meetingId: 'm1', subMeetingId: 's1',
  assetType: 'video', recordFileId: 'f1', fileType: 'mp4',
  bytesExpected: 12345, allowDownload: true,
}

function make(over: Partial<Parameters<typeof createInProcSource>[0]> = {}) {
  return createInProcSource({
    recordsApi: { listMeetings: async () => [GW_MEETING] },
    catalog: { listAssets: async () => [GW_ASSET], resolveDownloadUrl: async () => ({ url: 'https://x/f', expiresAt: 9999 }) },
    now: () => 1234,
    ...over,
  } as any)
}

describe('createInProcSource', () => {
  test('listMeetings 把网关 Meeting 映射成引擎 Meeting，丢掉 meetingRecordId/state', async () => {
    const src = make()
    const { meetings, nextCursor } = await src.listMeetings({ kind: 'range', from: 0, to: 9999 })
    expect(meetings).toEqual([{
      meetingId: 'm1', subMeetingId: 's1', meetingCode: '881-123-40',
      subject: '周会', hostUserId: 'u1', startTime: 1000, endTime: 5000,
    }])
    // recordsApi 内部已分页拉完，进程内没有游标
    expect(nextCursor).toBeNull()
  })

  test('listAssets 把 recordFileId 映射成 remoteId', async () => {
    const src = make()
    const assets = await src.listAssets('m1', 0, 9999)
    expect(assets).toEqual([{
      assetId: 'rec1:f1:video:0', assetType: 'video', remoteId: 'f1',
      allowDownload: true, fileType: 'mp4', bytesExpected: 12345,
    }])
  })

  test('listAssets 不产出 state 字段——网关的 wire 格式本来就没有它', async () => {
    const src = make()
    const [a] = await src.listAssets('m1')
    expect('state' in a!).toBe(false)
  })

  test('一个 meetingId 下多个 sub_meeting 的资产会被合并', async () => {
    const second = { ...GW_MEETING, subMeetingId: 's2', meetingRecordId: 'rec2' }
    const src = make({
      recordsApi: { listMeetings: async () => [GW_MEETING, second] },
      catalog: {
        listAssets: async (m: Meeting) => [{ ...GW_ASSET, subMeetingId: m.subMeetingId, recordFileId: `f-${m.subMeetingId}` }],
        resolveDownloadUrl: async () => ({ url: 'https://x/f', expiresAt: 9999 }),
      },
    } as any)
    const assets = await src.listAssets('m1')
    expect(assets.map((a) => a.remoteId)).toEqual(['f-s1', 'f-s2'])
  })

  test('getDownloadUrl 从 assetId 合成 Asset，不额外打 listAssets', async () => {
    let listCalls = 0
    let seen: any = null
    const src = make({
      catalog: {
        listAssets: async () => { listCalls++; return [GW_ASSET] },
        resolveDownloadUrl: async (a: Asset) => { seen = a; return { url: 'https://x/f', expiresAt: 9999 } },
      },
    } as any)
    const r = await src.getDownloadUrl('recX:fY:ai_minutes:2')
    expect(listCalls).toBe(0)                    // ← 没有多余的往返
    expect(seen.recordFileId).toBe('fY')
    expect(seen.assetType).toBe('ai_minutes')
    // 与 HTTP 网关的响应体一致：只有 url 与 expiresAt 是真的
    expect(r).toEqual({ url: 'https://x/f', expiresAt: 9999, fileType: null, bytesExpected: null })
  })

  test('assetId 格式非法时抛 InvalidAssetIdError', async () => {
    const src = make()
    await expect(src.getDownloadUrl('garbage')).rejects.toThrow('malformed assetId')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/worker/source-inproc.test.ts`
Expected: FAIL —— `Cannot find module '../../src/worker/source-inproc'`

- [ ] **Step 3: 实现**

`src/worker/source-inproc.ts`：

```ts
import type { AssetSource, DownloadUrl, SourceAsset, Meeting as EngineMeeting } from '@yaowu/mde-engine'
import type { Catalog } from '../catalog'
import type { RecordsApi } from '../tencent/records'
import type { Asset, Meeting as GatewayMeeting } from '../domain/types'

export interface InProcSourceDeps {
  recordsApi: RecordsApi
  catalog: Catalog
  now: () => number
}

/**
 * AssetSource 的进程内实现——归档 worker 用，直接调 catalog 与 recordsApi，
 * 不经过 HTTP。
 *
 * ⚠️ 它**绕过 policy/engine.ts，这是对的，不是漏洞**。
 *
 *   ① 拉取      受「拉取规则」管        ← 本文件走这条
 *   ③ 采集权限  受「采集权限规则」管    ← 外部程序取数据时走，由策略引擎判
 *
 * spec §1.4 说「采集权限规则是数据离开企业边界的唯一闸门」。worker 把数据从腾讯
 * 拉进**企业内部**的归档区，没有跨企业边界，所以不该过那道闸门。
 * **闸门在出口，不在入口。** 不要把 policyEngine.decide 加回来。
 */
export function createInProcSource(deps: InProcSourceDeps): AssetSource {
  /** 网关 Meeting → 引擎 Meeting：丢掉 meetingRecordId 与 state，引擎两者都不用 */
  function toEngineMeeting(m: GatewayMeeting): EngineMeeting {
    return {
      meetingId: m.meetingId,
      subMeetingId: m.subMeetingId,
      meetingCode: m.meetingCode,
      subject: m.subject,
      hostUserId: m.hostUserId,
      startTime: m.startTime,
      endTime: m.endTime,
    }
  }

  /**
   * 网关 Asset → 引擎 SourceAsset。字段映射与 HTTP 的 wire 格式逐字一致
   * （见 src/http/handlers/meetings.ts 的 toWire）——两个宿主必须看到同一份数据，
   * 否则引擎在两边的行为会分叉。
   *
   * 注意 state 不设：wire 格式本来就没有这个字段，设了反而会让
   * judgeReadiness 在服务端走与 CLI 不同的分支。
   */
  function toSourceAsset(a: Asset): SourceAsset {
    return {
      assetId: a.assetId,
      assetType: a.assetType,
      remoteId: a.recordFileId,
      allowDownload: a.allowDownload,
      fileType: a.fileType,
      bytesExpected: a.bytesExpected,
    }
  }

  /**
   * 按 meetingId 反查网关 Meeting。catalog.listAssets 需要 meetingRecordId，
   * 而引擎只握着 meetingId——与 HTTP 网关的做法一致（handlers/meetings.ts 也是
   * 重新 listMeetings 一次），不引入任何跨调用缓存。
   */
  async function meetingsById(meetingId: string, from?: number, to?: number): Promise<GatewayMeeting[]> {
    return deps.recordsApi.listMeetings({ kind: 'id', meetingId, from, to }, deps.now())
  }

  return {
    async listMeetings(sel) {
      // recordsApi 内部已按时间窗分页拉完，进程内不存在游标概念
      const meetings = await deps.recordsApi.listMeetings(sel, deps.now())
      return { meetings: meetings.map(toEngineMeeting), nextCursor: null }
    },

    async listAssets(meetingId, from, to) {
      const out: SourceAsset[] = []
      for (const m of await meetingsById(meetingId, from, to)) {
        for (const a of await deps.catalog.listAssets(m)) out.push(toSourceAsset(a))
      }
      return out
    },

    /**
     * 不需要反查资产。`catalog.resolveDownloadUrl` 只读 asset 的三个字段
     * ——`assetType`、`recordFileId`、`assetId`——而这三个全都编码在 assetId 里
     * （`<meetingRecordId>:<recordFileId>:<assetType>:<index>`）。
     *
     * 所以这里造一个**合成 Asset**，与 HTTP 网关的做法逐字一致
     * （src/http/handlers/meetings.ts 的 downloadUrl 也是这么造的，
     * fileType/bytesExpected 同样填 null）。两个宿主行为一致，且不必多打一趟
     * listAssets。
     */
    async getDownloadUrl(assetId) {
      const parsed = parseAssetId(assetId)
      if (parsed === null) throw new InvalidAssetIdError(assetId)
      const asset: Asset = {
        assetId,
        meetingId: '', subMeetingId: '',          // resolveDownloadUrl 不读这两个
        assetType: parsed.assetType,
        recordFileId: parsed.recordFileId,
        fileType: null, bytesExpected: null, allowDownload: true,
      }
      const { url, expiresAt } = await deps.catalog.resolveDownloadUrl(asset)
      // fileType / bytesExpected 恒为 null——HTTP 网关的 download-url 响应体
      // 本来就只有 {url, expires_at}，客户端那两个字段一直是 null。保持一致。
      return { url, expiresAt, fileType: null, bytesExpected: null }
    },
  }
}
```

- [ ] **Step 4: 把 `parseAssetId` 提成共享模块——不许写第三份**

仓库里已经有**两份**私有的 `parseAssetId`：`src/catalog/index.ts:106`（只解出两段）
与 `src/http/handlers/meetings.ts:243`（解出四段，含 assetType）。两份都没导出。
worker 再写一份就是第三份。

新建 `src/domain/assetid.ts`：

```ts
import { ASSET_TYPES, type AssetType } from './types'

export interface ParsedAssetId {
  meetingRecordId: string
  recordFileId: string
  assetType: AssetType
  index: number
}

/**
 * 解析网关签发的 assetId：`<meetingRecordId>:<recordFileId>:<assetType>:<index>`。
 *
 * 格式不合法返回 null——**不要抛异常**，调用方对「不是本网关签发的 id」有各自的
 * 处理方式（HTTP 层返回 400，worker 层是内部错误）。
 */
export function parseAssetId(assetId: string): ParsedAssetId | null {
  const parts = assetId.split(':')
  if (parts.length !== 4) return null
  const [meetingRecordId, recordFileId, assetType, indexRaw] = parts as [string, string, string, string]
  if (meetingRecordId === '' || recordFileId === '') return null
  if (!(ASSET_TYPES as readonly string[]).includes(assetType)) return null
  const index = Number(indexRaw)
  if (!Number.isInteger(index) || index < 0) return null
  return { meetingRecordId, recordFileId, assetType: assetType as AssetType, index }
}
```

然后：

1. `src/http/handlers/meetings.ts` 删掉自己那份（243 行起），改 import 这个
2. `src/catalog/index.ts` 那份只解两段，且**在 `InvalidAssetIdError` 上有语义**
   （见它的类注释）——改成调用共享版并在 null 时抛 `InvalidAssetIdError`
3. `src/worker/source-inproc.ts` import 同一份

新建 `tests/domain/assetid.test.ts` 覆盖：正常解析、段数不对、空段、未知 assetType、
index 非数字。

Run: `grep -rn "function parseAssetId" src/`
Expected: 只有 `src/domain/assetid.ts` 一处

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/worker/source-inproc.test.ts`
Expected: PASS（含 Step 4 新增的反查用例）

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck`
Run: `TEST_DATABASE_URL='<连接串>' bun test 2>&1 | tail -3`
Expected: typecheck 干净；测试全绿

- [ ] **Step 7: Commit**

```bash
git add src/worker/source-inproc.ts tests/worker/source-inproc.test.ts
git commit -m "feat(worker): AssetSource 的进程内实现，直连 catalog 不走 HTTP"
```

---

## Task 7: worker 入口 + 端到端冒烟

**Files:**
- Create: `src/worker/index.ts`
- Create: `tests/worker/e2e.test.ts`
- Modify: `package.json`（加 `"worker": "bun src/worker/index.ts"` 脚本）
- Modify: `.env.example`（加 `MDE_ARCHIVE_ROOT`）

**Interfaces:**
- Consumes: T5 的 `createMysqlStore`、T6 的 `createInProcSource`、引擎的 `discover` /
  `runExecutor` / `runProbes` / `createLocalStorage` / `downloadAsset`
- Produces: `runWorkerOnce(deps, sel, keys, now)` —— 一次「发现 → 下载」的完整轮次

- [ ] **Step 1: 先写端到端测试**

`tests/worker/e2e.test.ts`：桩掉 `recordsApi` 与 `catalog`（它们是腾讯边界），
用**真实 MySQL** + **真实临时目录**跑通一轮，断言：

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTestDb } from '../helpers/testdb'
import { runWorkerOnce } from '../../src/worker/index'

// 用真实的 HTTP 桩服务提供文件内容，让 downloader 的续传逻辑真的跑一遍
// （downloader 内部用 fetch，不能只桩 catalog）

describe('worker 一轮', () => {
  test('发现一场会议的资产并落盘，状态写进 MySQL', async () => {
    await withTestDb(async (pool) => {
      const root = await mkdtemp(join(tmpdir(), 'mde-worker-'))
      try {
        // …装配 runWorkerOnce，桩 recordsApi/catalog，起一个返回固定内容的本地 server…
        const res = await runWorkerOnce(/* deps */, { kind: 'range', from: 0, to: 9999 }, ['transcript'], 1000)
        expect(res.completed).toBe(1)

        // 1. 文件真的落在归档区，且路径符合 <year>/<month>/<清洗目录>/<文件名>
        const body = await readFile(join(root, '1970/01/1970-01-01-0016-周会-881-123-40/transcript.txt'), 'utf8')
        expect(body).toBe('hello')

        // 2. MySQL 里状态是 completed，且算了 content_hash
        const [rows] = await pool.query<any[]>(`SELECT status, content_hash, target_path FROM meeting_assets`)
        expect(rows[0].status).toBe('completed')
        expect(rows[0].content_hash).not.toBeNull()

        // 3. 没有残留 .part
        expect(await Bun.file(join(root, '…/transcript.txt.part')).exists()).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})
```

> 具体的目录名由 `cleanDirName` 生成，实现时先跑一次拿到真实路径再写死断言——
> **不要按想象拼路径**。

- [ ] **Step 2: 跑测试确认失败**

Run: `TEST_DATABASE_URL='<连接串>' bun test tests/worker/e2e.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 worker 入口**

`src/worker/index.ts`：

```ts
import {
  discover, runExecutor, runProbes, downloadAsset, createLocalStorage,
  type AssetKey, type AssetSource, type MeetingSelector, type Store, type Storage,
} from '@yaowu/mde-engine'

export interface WorkerDeps {
  store: Store
  source: AssetSource
  storage: Storage
  concurrency: number
  leaseSec: number
}

/**
 * 一轮完整的拉取：发现 → 补探测 → 执行下载。
 *
 * 与 mde CLI 的 `run` 命令是同一套调用序列——区别只在 store 与 source 的实现。
 * 这正是引擎抽包的目的：两个宿主共用一条代码路径，行为不会分叉。
 */
export async function runWorkerOnce(
  deps: WorkerDeps, sel: MeetingSelector, keys: AssetKey[], now: number,
): Promise<{ meetings: number; tasks: number; completed: number; failed: number; skipped: number }> {
  const found = await discover({ gw: deps.source, store: deps.store }, sel, keys, now)

  const meetingsById = new Map(/* 由 store 读回，供 executor 拼路径 */)
  const execDeps = {
    store: deps.store,
    storage: deps.storage,
    gw: deps.source,
    meetingsById,
    download: (task, onProgress) =>
      downloadAsset({ storage: deps.storage, gw: deps.source, onProgress }, task, () => now),
  }

  await runProbes({ ...execDeps }, () => now)
  const ran = await runExecutor(execDeps, { concurrency: deps.concurrency, leaseSec: deps.leaseSec }, () => now)

  return { ...found, ...ran }
}
```

`meetingsById` 来自 T3 加进 `Store` 的 `meetingsForPaths()`：

```ts
  const meetingsById = await deps.store.meetingsForPaths()
```

**不要在 worker 里绕过 Store 直连 pool。** CLI 那边正是因为绕过去了，才有两份重复的
`loadMeetings(db)`（T3 Step 4b 已经删掉）。

- [ ] **Step 4: CLI 入口（可选参数解析）**

文件末尾加 `if (import.meta.main)` 块：读 `DATABASE_URL` 与 `MDE_ARCHIVE_ROOT`，
装配 pool / store / catalog / recordsApi / source / storage，跑一轮并打印结果。
参数：`--from` `--to` `--meeting` `--assets`（默认 `DEFAULT_ASSET_KEYS`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `TEST_DATABASE_URL='<连接串>' bun test tests/worker/e2e.test.ts`
Expected: PASS

- [ ] **Step 6: 全量回归 + typecheck**

Run: `bun run typecheck && cd packages/engine && bun run typecheck && cd ../../client && bun run typecheck`
Run: `TEST_DATABASE_URL='<连接串>' bun test 2>&1 | tail -3`
Run: `cd client && bun test 2>&1 | tail -3`
Expected: 全绿，且 client 的 75 pass 一条不少

- [ ] **Step 7: Commit**

```bash
git add src/worker/index.ts tests/worker/e2e.test.ts package.json .env.example
git commit -m "feat(worker): 归档 worker 入口，引擎在服务端跑通一轮拉取"
```

---

## 完成判据

阶段 1 算完成，当且仅当：

1. `bun run worker --meeting <真实会议号>` 能把该会议的资产拉进 `MDE_ARCHIVE_ROOT`
2. `meeting_assets` 表里能看到逐条状态、`content_hash`、`target_path`
3. `mde` CLI 的行为**一个字没变**（`cd client && bun test` 仍是 75 pass）
4. 三处 typecheck 干净，根目录测试全绿
5. `src/worker/source-inproc.ts` 顶部那段「为什么绕过策略引擎是对的」的注释在

**阶段 1 不负责**：归档到 NAS、保留窗口、到期清理、规则驱动的拉取范围。
这一轮的 worker 是**手动指定会议范围**跑的，由规则驱动是阶段 3 的事。
