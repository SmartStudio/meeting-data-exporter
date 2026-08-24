# M6 控制台 · 阶段 2 实现计划：归档流水线 + 管理员会话

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。Steps 用 checkbox（`- [ ]`）语法追踪进度。

**Goal:** 落地 `docs/console/dev-plan.md` 阶段 2（P1 NAS 适配器 / P2 归档流水线 / P3 保留与到期清理 / P4 NAS 探测）+ 可提前到本阶段的 A1（管理员会话与账号管理），并把控制台登录页从占位接上真实后端。完成后：会议的资产能从本地归档到 NAS 并校验哈希、到期清理有 dry-run 与不可逆删除前的安全闸门、管理员能用独立账号密码登录控制台。

**Architecture:** 归档 worker（`src/worker/archive.ts`）复用 `packages/engine` 的 `Storage` 接口，新增一个 NAS 实现（`nas.ts`，语义上是 `local.ts` 的姊妹实现，外加网络挂载超时防护）。归档记录与保留窗口是控制台专属状态，落在新表 `meeting_archives`（服务端 `src/store/archives.ts`，不进 `packages/engine`——引擎包只管"怎么下载"，不管"下载完之后控制台怎么展示与到期"）。管理员会话是与现有 JWT/服务账号体系完全独立的第三条认证线（D1 已定），复用 `Bun.password` argon2id 与 `auth/tokens.ts` 的 token 生成原语，但不复用其 `ActorIdentity`/刷新轮换机制——管理员会话滑动续期即可，1–3 人的运维面板不需要 refresh-token 家族撤销那一整套机器。

**Tech Stack:** Bun + TypeScript(strict) + `bun:sqlite`（不涉及，本阶段全在 MySQL 侧）+ `mysql2`；前端 React 19 + Vite + React Router 7，沿用 `console/src/styles/tokens.css`。

## Global Constraints

以下为 `dev-plan.md` / `spec.md` / `backend-gap.md` 里对本阶段有约束力的原文要求，逐条列出，每个任务隐式继承：

- **NAS 是主存储，不是备份**：没有归档成功的会议，本地保留期一到就彻底没有了（spec §1.2）。归档失败是最高级别告警。
- **保留窗口自归档成功日起算**，不是自会议日起算（dev-plan §3 阶段2 · P3）。
- **到期清理是全系统唯一执行不可逆删除的代码**，三条硬要求逐字生效（dev-plan §6）：
  1. 删之前**当场重新校验** NAS 上文件的哈希与库里记录一致——不是查"归档任务报过成功"，是重新读一遍算一遍
  2. **"暂停到期清理"开关必须持久化**，不能是内存标志
  3. **必须有 dry-run，且默认先跑 dry-run**
- **到期只删本地文件，数据库记录永久保留**——会议标题、时间、主持人、内容哈希、归档到 NAS 的具体目录（spec §4.9）
- **NAS 断连时**：分诊条"归档失败"从 1 变 5；受影响会议的保留窗口清零；告警条上直接给"暂停到期清理"（spec §7.2）。**本阶段范围**：实现暂停开关本身与保留窗口清零；"撤下授权"部分依赖 `meeting_grants`（阶段 3 R3 才建表），本阶段不做，在 Task 8 里显式留一个调用点占位并写清楚原因，不是遗漏。
- **D1（已定）**：控制台管理员账号密码登录，与企微身份体系完全解耦，登录接口不得查询企微 / 腾讯会议侧任何接口。
- **管理员凭据**：argon2id 哈希，复用 `Bun.password` + `src/auth/service.ts` 的时序安全比对模式（账号不存在时也跑一次等时哈希校验，避免枚举）。
- **控制台"记住此设备 30 天"**，与 US-3.3 的 7 天交互式登录是两套独立会话体系，不得混用同一张表/同一套刷新语义。
- **MySQL 迁移文件约定**：`runMigrations` 按文件名升序执行、按分号朴素切分语句——`.sql` 文件的注释里不允许出现分号（`src/store/db.ts`）。
- **worker 并发度与连接池**：任何新增的 MySQL 查询路径都要意识到 `POOL_CONNECTION_LIMIT = 10` 与 `assertConcurrencyFitsPool` 的硬上限，不得引入无界的未 await 查询。
- **网络挂载可能挂住而非报错**：任何触达 NAS 路径的 fs 调用必须走超时包装（`withFsTimeout`），不能假设 fs 调用一定会在有限时间内返回或抛错。
- **测试目录约定**：后端测试在仓库根 `tests/`，镜像 `src/` 的路径（如 `src/worker/archive.ts` → `tests/worker/archive.test.ts`）；引擎包测试在 `packages/engine/tests/`，镜像 `packages/engine/src/`；控制台前端测试在 `console/tests/`，镜像 `console/src/`；CLI 测试在 `client/tests/`。**不要**把测试文件放进 `src/`/`console/src/` 内部。
- **代码注释纪律**：本仓库现有代码对"为什么"写得很详细（非显而易见的约束、边界条件、之前踩过的坑），新代码延续这个风格——但只写 WHY，不写 WHAT。

---

## 用户故事映射表

按 `docs/superpowers/specs/2026-07-20-user-stories.md` 已确认故事与本轮新拟的 P5 控制台草稿故事（尚未写回该文件，草稿状态）。**验收时按对应故事的验收标准逐条核对**，不是"代码跑起来就算完"。

| Task | 落点 | 对应用户故事 | 验收方式 |
| --- | --- | --- | --- |
| 1 | migrations/003 | （基础设施，无直接故事） | 五张新表建出来，`bun test` 全绿，`runMigrations` 幂等可重跑 |
| 2 | P1 NAS 适配器 | US-5.4（部分，为探测提供连通基础） | 单元测试覆盖 `Storage` 接口契约 + NAS 断连/超时场景 |
| 3 | A1 管理员会话+账号 | **US-3.4** 独立账号登录控制台、**US-3.5** 管理运维账号 | 用账号密码登录成功/失败、30 天记住、添加/移除运维账号、移除后会话失效、系统内至少留一个账号 |
| 4 | P4 NAS 探测 | US-5.4 查看 NAS 挂载与容量状态 | 连通状态、容量占比可查询，NAS 不可达时返回明确降级结果而非挂起 |
| 5 | A1-CLI bootstrap | US-3.5 的前置条件（首个账号怎么来） | `admin_accounts` 为空时可用，建完自动失效，之后再跑报错 |
| 6 | 控制台登录页接线 | US-3.4 的前端验收面 | 浏览器里能用账号密码登录进 `/meetings`，登录失败显示统一错误文案 |
| 7 | P2 归档流水线 | US-2.4（归档段状态）、US-2.5（撤销归档，仅记录层面，UI 留给 F2 后续任务） | 本地文件成功写入 NAS 后哈希校验通过才落 `meeting_archives`；哈希不符不落库、不删本地 |
| 8 | P3 保留与到期清理 | **US-5.6**（立即清理+预览，本阶段最高风险故事）、US-2.6（延长保留）、US-5.5（默认保留天数） | dry-run 默认、二次确认才真删、删前重新校验哈希、暂停开关持久化且重启后仍生效 |

---

## File Structure

| 文件 | 操作 | 任务 | 职责 |
| --- | --- | --- | --- |
| `migrations/003_console_stage2.sql` | 新建 | 1 | `admin_accounts` / `admin_sessions` / `archived_assets` / `meeting_archives` / `system_settings` 五张表 |
| `packages/engine/src/storage/fs-timeout.ts` | 新建 | 2 | 从 `src/worker/index.ts` 抽出的通用 fs 超时包装，供 NAS 相关代码共用 |
| `packages/engine/src/storage/nas.ts` | 新建 | 2 | 实现 `Storage` 接口的 NAS 版本 |
| `packages/engine/src/index.ts` | 修改 | 2 | 导出 `createNasStorage` / `withFsTimeout` / `FsTimeoutError` |
| `src/worker/index.ts` | 修改 | 2 | 改为从 `@yaowu/mde-engine` 导入 `withFsTimeout`/`FsTimeoutError`，删除本地重复定义 |
| `src/store/admin.ts` | 新建 | 3 | `admin_accounts` / `admin_sessions` 的 MySQL 存取 |
| `src/auth/admin.ts` | 新建 | 3 | 管理员认证：密码校验、会话签发/校验/滑动续期 |
| `src/http/handlers/console/auth.ts` | 新建 | 3 | 登录/登出/当前身份/账号管理 6 个 handler |
| `src/http/middleware.ts` | 修改 | 3 | 新增 `requireAdminAuth`（与现有 `requireAuth` 并列） |
| `src/http/router.ts` | 修改 | 3 | 挂载 `/api/v1/admin/auth/*`、`/api/v1/admin/accounts*` |
| `src/worker/nas-probe.ts` | 新建 | 4 | NAS 连通性 + 容量探测 |
| `scripts/admin-bootstrap.ts` | 新建 | 5 | 首个管理员账号引导脚本，直连 MySQL（不经网关） |
| `console/src/pages/Login/index.tsx` + `.module.css` | 新建 | 6 | 登录页 |
| `console/src/api/admin.ts` | 新建 | 6 | 登录页调用真实 API 的薄封装（不经过 mock 层） |
| `console/src/app/routes.tsx` | 修改 | 6 | 加 `/login` 路由 + 未登录重定向 |
| `console/src/app/AppShell.tsx` | 修改 | 6 | 挂载认证守卫 |
| `src/store/archives.ts` | 新建 | 7 | `meeting_archives` 的 MySQL 存取 |
| `src/worker/archive.ts` | 新建 | 7 | 归档流水线：本地 → NAS，校验哈希，写归档记录 |
| `src/worker/retention.ts` | 新建 | 8 | 保留窗口计算 + 到期清理（dry-run / 确认删除 / 暂停开关） |

---

## 依赖关系与并行批次

```
批次 0（阻塞一切，单独一个 subagent）
  Task 1  migrations/003
      │
      ├──────────────┬──────────────────────────┐
      ▼              ▼                          │
批次 1（2 路并行）                                │
  Task 2  P1 NAS 存储适配器      Task 3  A1 管理员会话+账号        │
      │                              │        │                 │
      ▼                              ▼        ▼                 │
批次 2（4 路并行）                                                │
  Task 4  P4 NAS 探测 (dep: 2)   Task 5  CLI bootstrap (dep: 3)  │
  Task 7  P2 归档流水线 (dep: 1+2)  Task 6  登录页接线 (dep: 3)    │
      │
      ▼
批次 3（单独）
  Task 8  P3 保留与到期清理 (dep: 1+7)
```

**为什么 P3 必须等 P2**：保留窗口从"归档成功日"起算，没有归档流水线产出的 `meeting_archives` 行就没有起算点，Task 8 的测试数据也依赖 Task 7 写入的记录格式。

**为什么 P4 不放进批次 1**：dev-plan.md §4 的编排图把它画在"与 P2/P3 并行"（即 P1 完成之后再起步），且 P4 会复用 Task 2 里抽出的 `withFsTimeout`，早一批开工没有收益。

**为什么登录页（Task 6）和 CLI bootstrap（Task 5）不能和 A1（Task 3）同批**：两者都要调用 Task 3 产出的接口/模块（登录页调 HTTP 接口，CLI bootstrap 调 `src/auth/admin.ts` 导出的哈希函数），必须等 Task 3 先落地。

---

## Task 1: migrations/003 —— 控制台阶段 2 建表

**Files:**
- Create: `migrations/003_console_stage2.sql`
- Modify: `tests/store/migrations.test.ts`（读现有文件，跟随其既有断言模式，为新增五张表追加断言——不要另开一个测试文件，迁移文件历来是这一个测试集体覆盖）

**Interfaces:**
- Produces：五张表，供 Task 3（admin_accounts / admin_sessions）、Task 7（archived_assets / meeting_archives）、Task 8（meeting_archives / system_settings）使用

- [ ] **Step 1：写迁移文件**

```sql
-- 控制台阶段 2：管理员账号与会话、归档记录、系统级设置。
--
-- admin_accounts / admin_sessions 是与 device_authorizations / refresh_tokens
-- 完全独立的第三条认证线（D1，见 dev-plan.md）——不共用任何一张已有的登录相关表，
-- 这是刻意的隔离，不是遗漏。
--
-- meeting_assets（002）只管单个资产的**本地下载**状态，本文件新增的两张表
-- 各自管一层，三者不重叠、不互相改写对方的列：
--   archived_assets  单个资产的 NAS 副本状态（本表新增）——归档流水线（Task 7）
--                    只在这张表里写 NAS 路径与哈希，绝不回写 meeting_assets——
--                    否则一旦回写覆盖了 target_path，到期清理（Task 8）就再也
--                    找不到本地文件原来在哪，"只删本地、留 NAS 路径"这条硬要求
--                    就没法实现。meeting_assets 从下载完成后就是只读的历史事实。
--   meeting_archives 整场会议的保留窗口（本表新增）——时钟是"这场会议"，不是
--                    "这个资产"（spec.md §4.3：本地保留段显示的是一个归档日、
--                    一个到期日，不是每个资产各自的）
--
-- system_settings 是通用键值表，本次只用两个 key：
--   cleanup_paused         到期清理暂停开关，必须持久化（dev-plan.md §6 硬要求 2）
--   default_retention_days 新归档会议的默认保留天数（US-5.5）
-- 用一张通用表而不是各开一个专属字段，是因为这两个值都是"系统级单例配置"，
-- 以后大概率还会再长出几个同类配置项，不必每次都开一次迁移加列。
--
-- 注意 runMigrations 按分号朴素切分语句，本文件任何注释里都不许出现分号。

CREATE TABLE IF NOT EXISTS admin_accounts (
  id            VARCHAR(64)  NOT NULL,
  username      VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    BIGINT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  token_hash VARCHAR(64)  NOT NULL,
  admin_id   VARCHAR(64)  NOT NULL,
  expires_at BIGINT       NOT NULL,
  created_at BIGINT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_admin_session_token (token_hash),
  KEY idx_admin_session_admin (admin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 与 meeting_assets 共用同一组自然键（meeting_id, sub_meeting_id, asset_type,
-- remote_id, file_type），可直接 JOIN；PRIMARY KEY 顺带当唯一约束，防止同一个
-- 资产被并发的两轮归档各写一行。
CREATE TABLE IF NOT EXISTS archived_assets (
  meeting_id     VARCHAR(64)   NOT NULL,
  sub_meeting_id VARCHAR(64)   NOT NULL DEFAULT '',
  asset_type     VARCHAR(64)   NOT NULL,
  remote_id      VARCHAR(128)  NOT NULL,
  file_type      VARCHAR(32)   NOT NULL DEFAULT '',
  -- 与 meeting_assets.target_path 的值相同（本地相对路径的副本，不是唯一来源）——
  -- 复制一份进来是为了到期清理（Task 8）不必再跨表回查 meeting_assets 就知道
  -- 删哪个本地文件。meeting_assets 自己那一份仍然保留、永远不改，两处只是
  -- 恰好同值，不构成"两个来源"的不一致风险，因为这一列写入之后不会再更新。
  local_path     VARCHAR(1024) NOT NULL,
  nas_path       VARCHAR(1024) NOT NULL,
  nas_hash       VARCHAR(64)   NOT NULL,
  archived_at    BIGINT        NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id, asset_type, remote_id, file_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_archives (
  meeting_id      VARCHAR(64)   NOT NULL,
  sub_meeting_id  VARCHAR(64)   NOT NULL DEFAULT '',
  nas_dir         VARCHAR(1024) NOT NULL,
  archived_at     BIGINT        NOT NULL,
  retention_days  INT           NOT NULL,
  extended_days   INT           NOT NULL DEFAULT 0,
  -- NULL = 本地文件还在；非 NULL = 已到期清理，记录与 nas_dir 永久保留（spec §4.9）
  local_purged_at BIGINT        NULL,
  created_at      BIGINT        NOT NULL,
  updated_at      BIGINT        NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id),
  KEY idx_archives_expiry (local_purged_at, archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key   VARCHAR(64) NOT NULL,
  setting_value TEXT        NOT NULL,
  updated_at    BIGINT      NOT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2：扩展迁移测试**

读 `tests/store/migrations.test.ts` 现有写法（大概率是"对一个测试数据库跑 `runMigrations`，断言关键表存在/可重复执行不报错"这个形状）。按同样模式追加：五张新表存在、对 `admin_accounts`/`admin_sessions`/`archived_assets` 的唯一键约束生效（重复 `username`/`token_hash`/同一资产自然键插入应报错）、`runMigrations` 对已跑过的库再跑一次不报错（幂等）。

- [ ] **Step 3：跑测试确认通过**

```
bun test tests/store/migrations.test.ts
```

- [ ] **Step 4：提交**

```bash
git add migrations/003_console_stage2.sql tests/store/migrations.test.ts
git commit -m "feat(store): 控制台阶段 2 建表——管理员账号会话、归档记录、系统设置"
```

---

## Task 2: P1 —— NAS 存储适配器

**Files:**
- Create: `packages/engine/src/storage/fs-timeout.ts`
- Create: `packages/engine/src/storage/nas.ts`
- Create: `packages/engine/tests/storage/fs-timeout.test.ts`
- Create: `packages/engine/tests/storage/nas.test.ts`
- Modify: `packages/engine/src/index.ts`
- Modify: `src/worker/index.ts`
- Modify: 任何现有引用 `src/worker/index.ts` 里 `withFsTimeout`/`FsTimeoutError` 的测试文件（先 `grep -rn "withFsTimeout\|FsTimeoutError" tests/` 找出来，逐个改 import 来源）

**Interfaces:**
- Consumes：`Storage` 接口（`packages/engine/src/storage/types.ts`，已存在，不改）
- Produces：
  - `withFsTimeout<T>(p: Promise<T>, what: string, ms: number): Promise<T>`
  - `class FsTimeoutError extends Error`
  - `createNasStorage(root: string, timeoutMs?: number): Storage`
  - 三者均从 `@yaowu/mde-engine` 导出，供 Task 4（NAS 探测）与 Task 7（归档流水线）使用

**这一步先做什么、为什么**：`src/worker/index.ts` 里已经有 `FsTimeoutError` 与 `withFsTimeout`（治网络挂载"挂住而不报错"的问题），但它们是私有的、写在 worker 入口文件里。NAS 适配器同样要面对"挂载可能挂住"这个问题，与其在 `packages/engine` 里重写一遍，不如把这两样**搬到** `packages/engine`（作为通用能力），worker 侧改成从包里 import。这不是重复造轮子，也不是过度设计——是同一个问题在两处出现后做的必要抽取。

- [ ] **Step 1：抽出 fs-timeout 工具**

把 `src/worker/index.ts` 里现有的 `FsTimeoutError` 类与 `withFsTimeout` 函数（含其全部注释——那些注释解释的是"为什么需要超时包装"这个通用道理，不是 worker 特有的）逐字搬到 `packages/engine/src/storage/fs-timeout.ts`，只改：去掉签名里默认值对 `ARCHIVE_PROBE_TIMEOUT_MS` 的引用（那个常量留在 worker 侧，`fs-timeout.ts` 不该有默认值，调用方必须显式传 `ms`）。

```typescript
export class FsTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms — a hung network mount blocks fs calls instead of failing them`)
    this.name = 'FsTimeoutError'
  }
}

export function withFsTimeout<T>(p: Promise<T>, what: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FsTimeoutError(what, ms)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
```

- [ ] **Step 2：fs-timeout 单元测试**

复刻 `src/worker/index.ts` 注释里提到的 FIFO 挂起技巧（先 `grep -rn "mkfifo\|FIFO" tests/ packages/` 确认现有项目里是否已经有这个技巧的实现可以照抄；若没有，用 `node:child_process` 的 `execSync('mkfifo ' + path)` 建一个没有读者的命名管道，对它 `writeFile` 必然永久阻塞在 `open`，从而确定性地触发超时分支，不存在竞速）。至少覆盖：

1. 正常 promise 在超时前 resolve → 返回其结果，`FsTimeoutError` 不抛出
2. 正常 promise 在超时前 reject → 原始错误原样抛出（不是 `FsTimeoutError`）
3. promise 挂住不返回 → 在 `ms` 后抛出 `FsTimeoutError`，错误信息包含 `what`
4. 无论哪种结局，`finally` 里的 `clearTimeout` 都跑了（用一个 spy 或者跑完之后 `setTimeout` 计数验证没有残留定时器）

- [ ] **Step 3：NAS storage 实现**

`nas.ts` 与 `local.ts`（已读，见下方对照）语义完全一致，唯一区别是每个真正触达文件系统的调用都包一层 `withFsTimeout`：

```typescript
import type { Storage } from './types'
import { join, dirname } from 'node:path'
import { mkdir, rename, rm, stat, open } from 'node:fs/promises'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
import { withFsTimeout } from './fs-timeout'
const statfsAsync = promisify(statfs)

/** NAS 挂载点的 fs 调用超时。5s 对本地盘/健康 NAS 都宽到离谱，只在真挂住时触发。 */
const NAS_TIMEOUT_MS = 5_000

export function createNasStorage(root: string, timeoutMs: number = NAS_TIMEOUT_MS): Storage {
  const abs = (rel: string) => join(root, rel)
  const part = (rel: string) => abs(rel) + '.part'
  const wrap = <T>(p: Promise<T>, what: string) => withFsTimeout(p, what, timeoutMs)
  return {
    async writtenSize(rel) {
      try { return (await wrap(stat(part(rel)), `stat(${part(rel)})`)).size }
      catch (err) {
        if (err instanceof Error && err.name === 'FsTimeoutError') throw err
        return 0
      }
    },
    async readPart(rel) { return Bun.file(part(rel)).arrayBuffer() },
    async appendChunk(rel, offset, chunk) {
      await wrap(mkdir(dirname(part(rel)), { recursive: true }), `mkdir(${dirname(part(rel))})`)
      const fh = await wrap(open(part(rel), offset === 0 ? 'w' : 'r+'), `open(${part(rel)})`)
      try { await wrap(fh.write(chunk, 0, chunk.byteLength, offset), `write(${part(rel)})`) }
      finally { await fh.close() }
      return (await wrap(stat(part(rel)), `stat(${part(rel)})`)).size
    },
    async finalize(rel) {
      await wrap(mkdir(dirname(abs(rel)), { recursive: true }), `mkdir(${dirname(abs(rel))})`)
      await wrap(rename(part(rel), abs(rel)), `rename(${part(rel)})`)
    },
    async discardPart(rel) { await wrap(rm(part(rel), { force: true }), `rm(${part(rel)})`) },
    async writeMeta(rel, data) {
      await wrap(mkdir(dirname(abs(rel)), { recursive: true }), `mkdir(${dirname(abs(rel))})`)
      await wrap(Bun.write(abs(rel), JSON.stringify(data, null, 2)), `write(${abs(rel)})`)
    },
    async ensureFreeSpace(bytes) {
      try {
        const s = await wrap(statfsAsync(root), `statfs(${root})`)
        return s.bavail * s.bsize >= bytes
      } catch (err) {
        if (err instanceof Error && err.name === 'FsTimeoutError') throw err
        return true // 取不到时不阻断，与 local.ts 一致
      }
    },
  }
}
```

**注意 `writtenSize` 与 `ensureFreeSpace` 里的判别逻辑**：`local.ts` 原版对任何异常都吞掉返回兜底值（0 / true）。NAS 版本必须先看是不是 `FsTimeoutError`——挂起超时是"NAS 可能已经断连"这个要紧信号，不能被当成"文件不存在"或"空间够"悄悄吞掉，那会让归档 worker 在 NAS 已经失联的情况下误以为一切正常继续写。file-not-found 之类的普通 fs 错误才应该走兜底路径。

- [ ] **Step 4：NAS storage 测试**

读 `packages/engine/tests/storage/local.test.ts` 的现有结构，对同一份 `Storage` 接口契约（`writtenSize`/`readPart`/`appendChunk`/`finalize`/`discardPart`/`writeMeta`/`ensureFreeSpace`）跑一遍等价用例（用临时目录当"NAS 根"）。在此之上新增 NAS 特有场景：

1. 用 Step 2 的 FIFO 技巧模拟挂起的挂载，断言 `appendChunk`/`finalize`/`writeMeta` 在超时后抛出 `FsTimeoutError` 而不是永久挂起
2. 断言 `writtenSize` 遇到 `FsTimeoutError` 时**不**吞掉、原样抛出（对照普通"文件不存在"场景仍返回 0）
3. 断言 `ensureFreeSpace` 遇到 `FsTimeoutError` 时**不**吞掉、原样抛出（对照真实 `statfs` 失败场景仍返回 `true`）

- [ ] **Step 5：更新包导出与 worker 侧引用**

`packages/engine/src/index.ts` 追加：

```typescript
export { createNasStorage } from './storage/nas'
export { withFsTimeout, FsTimeoutError } from './storage/fs-timeout'
```

`src/worker/index.ts`：删除本地的 `FsTimeoutError` class 与 `withFsTimeout` function 定义（连同其注释），改为从 `'@yaowu/mde-engine'` 的 import 列表里加上 `withFsTimeout, FsTimeoutError`。`assertArchiveRootUsable` 函数体不变——它调用的 `withFsTimeout` 现在来自包导入，行为完全一致。

- [ ] **Step 6：全量跑相关测试确认没有破坏现有行为**

```bash
bun test tests/worker/
cd packages/engine && bun test
```

Expected：全绿，尤其 `tests/worker/e2e.test.ts`（如果它间接覆盖了 `assertArchiveRootUsable`）不受影响。

- [ ] **Step 7：提交**

```bash
git add packages/engine/src/storage/fs-timeout.ts packages/engine/src/storage/nas.ts \
        packages/engine/tests/storage/fs-timeout.test.ts packages/engine/tests/storage/nas.test.ts \
        packages/engine/src/index.ts src/worker/index.ts
git commit -m "feat(engine): NAS 存储适配器，抽出 fs 超时包装供归档链路共用"
```

---

## Task 3: A1 —— 管理员会话与账号管理

**Files:**
- Create: `src/store/admin.ts`
- Create: `src/auth/admin.ts`
- Create: `src/http/handlers/console/auth.ts`
- Create: `tests/store/admin.test.ts`
- Create: `tests/auth/admin.test.ts`
- Create: `tests/http/console/auth.test.ts`
- Modify: `src/http/middleware.ts`（新增 `requireAdminAuth`）
- Modify: `src/http/router.ts`（挂载新路由、`AppDeps` 加字段）
- Test: `tests/http/middleware.test.ts`（为新增的 `requireAdminAuth` 追加用例）

**Interfaces:**
- Consumes：`Bun.password`（内置）；`generateOpaqueToken`/`hashToken`（`src/auth/tokens.ts`，已存在，直接复用，不重新实现）
- Produces：
  - `AdminStore`（`src/store/admin.ts`）
  - `createAdminStore(pool: Pool): AdminStore`（`src/store/admin.ts`，与 `src/store/auth.ts` 的 `createAuthStore(pool)` 同一种工厂函数模式——函数名必须精确是这个，Task 5 与本任务自己的 Step 9 都按这个名字导入）
  - `createAdminAuth(deps): AdminAuth`，其中 `AdminAuth = { authenticate, hashPassword, issueSession, verifySession, revokeSession, revokeAllSessionsFor }`（`src/auth/admin.ts`）
  - `requireAdminAuth(req, adminAuth, now): Promise<AdminAuthResult>`（`src/http/middleware.ts`）
  - 供 Task 5（CLI bootstrap）使用：`AdminAuth.hashPassword`、`AdminStore.createAccount`/`countAccounts`
  - 供 Task 6（登录页）使用：下方六个端点的请求/响应契约

**设计取舍（与本轮更早在对话里提过的方案不同，这里显式改口）**：此前讨论曾提议管理员会话完全照抄 `refresh_tokens` 的"短 JWT + 长 refresh、刷新即轮换、复用检测连坐撤销"整套机制。写到这一步发现那套机制是为**大量业务用户 + 真实token被盗场景**设计的（US-3.3）。控制台只有 1–3 个内部管理员，且 spec.md §10 本身就明确不做自助注册/找回密码——安全模型已经是刻意收紧到最小的。这里改为**单一 opaque token + 滑动续期**：更少的移动件，同样满足"30 天记住 + 无感续期 + 登出立即失效 + 移除账号立即失效其全部会话"这四条硬要求，没有牺牲任何一条已确认的验收标准。如果不认可这个简化，告诉我，改回全套 refresh 家族机制不难。

- [ ] **Step 1：`AdminStore`**

```typescript
// src/store/admin.ts
import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import type { Pool } from './db'

export interface AdminAccount {
  id: string
  username: string
  passwordHash: string
  createdAt: number
}

export interface AdminSession {
  adminId: string
  expiresAt: number
}

export interface AdminStore {
  countAccounts(): Promise<number>
  findByUsername(username: string): Promise<AdminAccount | null>
  findById(id: string): Promise<AdminAccount | null>
  listAccounts(): Promise<AdminAccount[]>
  createAccount(input: { id: string; username: string; passwordHash: string; now: number }): Promise<void>
  /** 返回是否真的删到了一行（供 handler 判断"账号不存在"与"删成功"） */
  deleteAccount(id: string): Promise<boolean>
  createSession(input: { tokenHash: string; adminId: string; expiresAt: number; now: number }): Promise<void>
  findSessionByTokenHash(tokenHash: string): Promise<AdminSession | null>
  touchSessionExpiry(tokenHash: string, newExpiresAt: number): Promise<void>
  deleteSession(tokenHash: string): Promise<void>
  /** 账号被移除时级联撤销；返回撤销的会话数（仅用于日志，非行为依据） */
  deleteSessionsByAdminId(adminId: string): Promise<number>
}

// 行映射函数与 pool.execute 调用完全照抄 src/store/auth.ts 的风格：
// RowDataPacket 子接口 + mapXRow 纯函数 + 参数化查询。字段名 snake_case ↔
// camelCase 的映射规则、AUTO_INCREMENT 主键的处理方式都跟 auth.ts 保持一致，
// 不要另发明一套约定。deleteAccount/deleteSession 用 ResultSetHeader.affectedRows
// 判断是否真的删到行（参照 auth.ts 的 authorize() 用 affectedRows === 1 判断防重放
// 的写法）。createSession 用普通 INSERT（token_hash 唯一冲突直接抛出，不做 upsert）。
```

读 `src/store/auth.ts` 全文作为逐行对照的模板实现上面这个接口——两者的字段风格、错误处理风格必须一致，不要另创一套。

- [ ] **Step 2：`AdminStore` 测试**

镜像 `tests/store/auth.test.ts` 的结构（若该文件存在则直接对照其用例形状；若测试库用的是可注入的假 pool 或真实测试库连接，跟随现有约定）。覆盖：`createAccount`+`findByUsername` 往返、`username` 唯一冲突报错、`countAccounts` 从 0 到 N、`deleteAccount` 对不存在的 id 返回 `false`、`createSession`+`findSessionByTokenHash` 往返、`touchSessionExpiry` 更新后重新查询能看到新值、`deleteSessionsByAdminId` 删除该管理员的全部会话且不影响其他管理员的会话。

- [ ] **Step 3：`src/auth/admin.ts`**

```typescript
import { timingSafeEqual } from 'node:crypto'
import type { AdminAccount, AdminStore } from '../store/admin'
import { generateOpaqueToken, hashToken } from './tokens'

export class AdminAuthError extends Error {
  constructor() {
    super('invalid admin credentials')
    this.name = 'AdminAuthError'
  }
}

export class AdminSessionInvalidError extends Error {
  constructor() {
    super('invalid or expired admin session')
    this.name = 'AdminSessionInvalidError'
  }
}

export interface AdminIdentity {
  adminId: string
  username: string
}

/** "记住此设备" 勾选时的会话有效期（spec.md §4.1 登录页文案原文即 30 天） */
export const ADMIN_SESSION_REMEMBER_DAYS = 30
/** 不勾选时的会话有效期——仍落库以支持"移除账号立即失效"，只是窗口短得多 */
export const ADMIN_SESSION_SHORT_HOURS = 12
/**
 * 剩余有效期低于此阈值才续期（而不是每次请求都续期）——避免管理员面板这种
 * 低频访问场景下，每次请求都触发一次 UPDATE，没有必要的写放大。
 */
const TOUCH_THRESHOLD_SEC = 5 * 24 * 3600

// 与 auth/service.ts 相同的枚举防御：账号不存在时仍跑一次等时哈希校验，
// 使"账号不存在"与"密码错误"两种失败在响应时序上不可区分。
const DUMMY_HASH_PROMISE = Bun.password.hash('invalid-placeholder-not-a-real-secret', {
  algorithm: 'argon2id',
})
DUMMY_HASH_PROMISE.catch(() => {})

export interface AdminAuthDeps {
  store: AdminStore
}

export interface AdminAuth {
  authenticate(username: string, password: string): Promise<AdminAccount>
  hashPassword(password: string): Promise<string>
  issueSession(adminId: string, remember: boolean, now: number): Promise<{ token: string; expiresAt: number }>
  verifySession(token: string, now: number): Promise<AdminIdentity>
  revokeSession(token: string): Promise<void>
  revokeAllSessionsFor(adminId: string): Promise<void>
}

export function createAdminAuth(deps: AdminAuthDeps): AdminAuth {
  return {
    async authenticate(username, password) {
      const account = await deps.store.findByUsername(username)
      const hashToCheck = account?.passwordHash ?? (await DUMMY_HASH_PROMISE)
      const ok = await Bun.password.verify(password, hashToCheck)
      if (account === null || !ok) throw new AdminAuthError()
      return account
    },

    async hashPassword(password) {
      return Bun.password.hash(password, { algorithm: 'argon2id' })
    },

    async issueSession(adminId, remember, now) {
      const token = generateOpaqueToken()
      const ttlSec = remember ? ADMIN_SESSION_REMEMBER_DAYS * 86400 : ADMIN_SESSION_SHORT_HOURS * 3600
      const expiresAt = now + ttlSec
      await deps.store.createSession({ tokenHash: hashToken(token), adminId, expiresAt, now })
      return { token, expiresAt }
    },

    async verifySession(token, now) {
      const tokenHash = hashToken(token)
      const session = await deps.store.findSessionByTokenHash(tokenHash)
      if (session === null || now >= session.expiresAt) throw new AdminSessionInvalidError()

      const account = await deps.store.findById(session.adminId)
      if (account === null) throw new AdminSessionInvalidError() // 账号已被移除

      // 滑动续期：只在剩余有效期跌破阈值时才写库。续期到的新有效期固定用
      // "记住此设备"的 30 天窗口——本函数拿不到当初登录时是否勾选了记住，
      // 而滑动续期这个动作本身只在长会话上才有意义（短会话 12 小时内用完即弃，
      // 走不到这条续期分支也无妨）。
      if (session.expiresAt - now < TOUCH_THRESHOLD_SEC) {
        await deps.store.touchSessionExpiry(tokenHash, now + ADMIN_SESSION_REMEMBER_DAYS * 86400)
      }

      return { adminId: account.id, username: account.username }
    },

    async revokeSession(token) {
      await deps.store.deleteSession(hashToken(token))
    },

    async revokeAllSessionsFor(adminId) {
      await deps.store.deleteSessionsByAdminId(adminId)
    },
  }
}
```

- [ ] **Step 4：`src/auth/admin.ts` 测试**

镜像 `tests/auth/service.test.ts` 的结构（同样的假 `AdminStore` 注入方式）。覆盖：正确密码 `authenticate` 成功；错误密码/不存在账号统一抛 `AdminAuthError`（且两种情况耗时量级相近——可以像现有测试那样只断言"都调用了一次 `Bun.password.verify`"来证明走了同一条时序路径，而不是真的做计时断言，那样会 flaky）；`issueSession` 勾选/不勾选 remember 时 `expiresAt` 差值分别约等于 30 天/12 小时；`verifySession` 对不存在的 token、已过期的 token 均抛 `AdminSessionInvalidError`；`verifySession` 对账号已被删除（`findById` 返回 null）的会话同样抛出（模拟"账号被移除后会话立即失效"）；剩余有效期小于阈值时调用了 `touchSessionExpiry`，大于阈值时没调用。

- [ ] **Step 5：`requireAdminAuth` 中间件**

追加到 `src/http/middleware.ts`（与现有 `requireAuth` 并列，签名故意不同——管理员会话校验必须查库，做不成同步函数）：

```typescript
import type { AdminAuth, AdminIdentity } from '../auth/admin'
import { AdminSessionInvalidError } from '../auth/admin'

export const ADMIN_SESSION_COOKIE = 'mde_admin_session'

export type AdminAuthResult =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; response: Response }

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

export async function requireAdminAuth(
  req: Request,
  adminAuth: AdminAuth,
  now: number,
): Promise<AdminAuthResult> {
  const token = readCookie(req, ADMIN_SESSION_COOKIE)
  if (token === null) {
    return { ok: false, response: json(401, { error: 'missing_admin_session' }) }
  }
  try {
    const identity = await adminAuth.verifySession(token, now)
    return { ok: true, identity }
  } catch (err) {
    if (err instanceof AdminSessionInvalidError) {
      return { ok: false, response: json(401, { error: 'invalid_admin_session' }) }
    }
    throw err
  }
}
```

- [ ] **Step 6：`requireAdminAuth` 测试追加进 `tests/http/middleware.test.ts`**

覆盖：无 cookie → 401 `missing_admin_session`；cookie 值对应的 token 校验失败（用一个抛 `AdminSessionInvalidError` 的假 `AdminAuth`）→ 401 `invalid_admin_session`；校验成功 → `ok: true` 且带回 identity；cookie 头里混了别的 cookie（如 `foo=bar; mde_admin_session=xxx; baz=qux`）时仍能正确取到值（这是 cookie 解析最容易写错的边界）。

- [ ] **Step 7：console 认证 handler**

```typescript
// src/http/handlers/console/auth.ts
import { randomUUID } from 'node:crypto'
import type { RouteCtx } from '../../router'
import { json, readJson } from '../../respond'
import { requireAdminAuth, ADMIN_SESSION_COOKIE } from '../../middleware'
import { AdminAuthError } from '../../../auth/admin'

interface LoginBody { username?: string; password?: string; remember?: boolean }

/** Secure 在本地开发（非 https）下会导致浏览器直接丢弃 cookie；生产环境必须为 true。
 *  跟随 gatewayBaseUrl 是否为 https 判断，而不是写死——避免"本地登录页收到 cookie
 *  但浏览器悄悄不存"这种排查成本极高的静默失败。 */
function cookieAttrs(secure: boolean, maxAgeSec: number): string {
  const parts = [`Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=${maxAgeSec}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export async function login(req: Request, ctx: RouteCtx): Promise<Response> {
  const body = await readJson<LoginBody>(req)
  if (!body?.username || !body.password) {
    return json(400, { error: 'missing_credentials' })
  }
  try {
    const account = await ctx.deps.adminAuth.authenticate(body.username, body.password)
    const { token, expiresAt } = await ctx.deps.adminAuth.issueSession(account.id, body.remember === true, ctx.deps.now())
    const maxAge = expiresAt - ctx.deps.now()
    const res = json(200, { adminId: account.id, username: account.username })
    res.headers.append('set-cookie', `${ADMIN_SESSION_COOKIE}=${token}; ${cookieAttrs(ctx.deps.cookieSecure, maxAge)}`)
    return res
  } catch (err) {
    // 统一"账号或密码错误"，不区分——spec.md §4.1：表单级报错，故意不说哪个字段错
    if (err instanceof AdminAuthError) return json(401, { error: 'invalid_credentials' })
    throw err
  }
}

export async function logout(req: Request, ctx: RouteCtx): Promise<Response> {
  const cookieHeader = req.headers.get('cookie') ?? ''
  const match = /(?:^|;\s*)mde_admin_session=([^;]+)/.exec(cookieHeader)
  if (match?.[1]) await ctx.deps.adminAuth.revokeSession(decodeURIComponent(match[1]))
  const res = json(204, null)
  res.headers.append('set-cookie', `${ADMIN_SESSION_COOKIE}=; ${cookieAttrs(ctx.deps.cookieSecure, 0)}`)
  return res
}

export async function me(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  return json(200, auth.identity)
}

export async function listAccounts(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const accounts = await ctx.deps.adminStore.listAccounts()
  // passwordHash 绝不出现在响应里
  return json(200, accounts.map((a) => ({ id: a.id, username: a.username, createdAt: a.createdAt })))
}

interface CreateAccountBody { username?: string; password?: string }

export async function createAccount(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const body = await readJson<CreateAccountBody>(req)
  if (!body?.username || !body.password) return json(400, { error: 'missing_fields' })
  const existing = await ctx.deps.adminStore.findByUsername(body.username)
  if (existing !== null) return json(409, { error: 'username_taken' })
  const id = randomUUID()
  const passwordHash = await ctx.deps.adminAuth.hashPassword(body.password)
  await ctx.deps.adminStore.createAccount({ id, username: body.username, passwordHash, now: ctx.deps.now() })
  return json(201, { id, username: body.username })
}

export async function deleteAccount(req: Request, ctx: RouteCtx): Promise<Response> {
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response
  const targetId = ctx.params.id!
  // 系统内至少保留一个账号（US-3.5 验收标准）：删前查计数，等于 1 就拒绝，
  // 不给"最后一个也删了、谁都进不去控制台"的机会。
  const count = await ctx.deps.adminStore.countAccounts()
  if (count <= 1) return json(409, { error: 'cannot_delete_last_account' })
  const deleted = await ctx.deps.adminStore.deleteAccount(targetId)
  if (!deleted) return json(404, { error: 'account_not_found' })
  // 移除账号后其会话立即失效（US-3.5 验收标准）——不等自然过期
  await ctx.deps.adminAuth.revokeAllSessionsFor(targetId)
  return json(204, null)
}
```

**`count <= 1` 与 `deleteAccount` 之间存在竞态**（两个并发请求都读到 count=2 然后都删）——对 1–3 人的运维面板、且两个管理员同时删账号这种操作本就极罕见，用应用层判断即可，不必上事务锁。如果实现者认为这个竞态窗口不可接受，可以改成 `DELETE ... WHERE id=? AND (SELECT COUNT(*) FROM admin_accounts) > 1` 单语句原子化，但要先确认 MySQL 允许子查询引用同一张正在删除的表（部分场景不允许），这是一个明确的可选加固项，不是本任务的硬性要求。

- [ ] **Step 8：handler 测试**

镜像 `tests/http/auth.test.ts` 的结构（假 deps 注入、直接调用 handler 函数、断言 `Response` 的 status/body/set-cookie）。覆盖 login 成功/失败、logout 清 cookie、me 未登录 401/已登录 200、listAccounts 不泄露 passwordHash、createAccount 用户名冲突 409、deleteAccount 对最后一个账号拒绝且不实际删除、deleteAccount 成功后调用了 `revokeAllSessionsFor`。

- [ ] **Step 9：路由与依赖注入接线**

`src/http/router.ts` 的 `AppDeps` interface 追加：

```typescript
adminAuth: AdminAuth
adminStore: AdminStore
/** 生产环境必须为 true（cookie 的 Secure 属性依据它）；本地 http 开发环境为 false */
cookieSecure: boolean
```

`ROUTES` 数组追加（挂在现有列表末尾，`import * as consoleAuthHandlers from './handlers/console/auth'`）：

```typescript
compile('POST', '/api/v1/admin/auth/login', consoleAuthHandlers.login),
compile('POST', '/api/v1/admin/auth/logout', consoleAuthHandlers.logout),
compile('GET', '/api/v1/admin/auth/me', consoleAuthHandlers.me),
compile('GET', '/api/v1/admin/accounts', consoleAuthHandlers.listAccounts),
compile('POST', '/api/v1/admin/accounts', consoleAuthHandlers.createAccount),
compile('DELETE', '/api/v1/admin/accounts/:id', consoleAuthHandlers.deleteAccount),
```

`RATE_LIMITED` 集合追加 `'POST /api/v1/admin/auth/login'`（登录端点必须限流，跟现有的服务账号/设备登录端点同等对待）。

`src/index.ts`（应用装配入口，未列在 Files 里是因为改动极小）需要在组装 `AppDeps` 时新增 `adminAuth: createAdminAuth({ store: createAdminStore(pool) })`、`adminStore: createAdminStore(pool)`、`cookieSecure: process.env.NODE_ENV === 'production'`（或读 `config.ts` 里已有的类似判断方式——先看 `src/index.ts` 现状再决定具体取值来源，不要引入第二套"是否生产环境"的判断逻辑）。

- [ ] **Step 10：全量跑 http 测试确认路由表没有冲突**

```bash
bun test tests/http/ tests/store/ tests/auth/
```

- [ ] **Step 11：提交**

```bash
git add src/store/admin.ts src/auth/admin.ts src/http/handlers/console/auth.ts \
        src/http/middleware.ts src/http/router.ts src/index.ts \
        tests/store/admin.test.ts tests/auth/admin.test.ts tests/http/console/auth.test.ts \
        tests/http/middleware.test.ts
git commit -m "feat(console): 管理员会话与账号管理 API（A1），独立于企微/服务账号认证线"
```

---

## Task 4: P4 —— NAS 连通与容量探测

**Files:**
- Create: `src/worker/nas-probe.ts`
- Create: `tests/worker/nas-probe.test.ts`

**Interfaces:**
- Consumes：`withFsTimeout`（`@yaowu/mde-engine`，Task 2 产出）
- Produces：`probeNas(root: string, timeoutMs?: number): Promise<NasProbeResult>`，供后续阶段 4 的归档存储页 API（A3，不在本计划范围）调用

**与 `assertArchiveRootUsable`（`src/worker/index.ts`）的关系**：那个函数是 worker **启动期**的硬校验，失败就整体拒绝启动。这里的 `probeNas` 是**运行期可重复调用**的探测，用于给控制台"归档存储"页展示连通状态与容量占比（spec.md §4.9），失败时返回一个描述失败原因的结果对象，**不抛异常、不影响调用方继续运行**——这是两者语义上唯一但关键的区别，实现时不要图省事直接复用 `assertArchiveRootUsable` 本体（它是"检查完就抛"的风格，接口不匹配）。

- [ ] **Step 1：实现**

```typescript
import { stat, writeFile, rm } from 'node:fs/promises'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
import { withFsTimeout, FsTimeoutError } from '@yaowu/mde-engine'
const statfsAsync = promisify(statfs)

const PROBE_TIMEOUT_MS = 5_000

export interface NasProbeResult {
  reachable: boolean
  checkedAt: number
  /** 探测耗时（ms）。超时/失败时为触发失败前实际耗费的时间，非 null。 */
  latencyMs: number
  totalBytes: number | null
  availableBytes: number | null
  /** reachable=false 时的人类可读原因；reachable=true 时为 null */
  error: string | null
}

/**
 * now 取函数是为了让测试能控制 checkedAt，不是为了别的——探测本身不依赖时钟推进。
 */
export async function probeNas(
  root: string,
  now: () => number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<NasProbeResult> {
  const startedAt = Date.now()
  const fail = (error: string): NasProbeResult => ({
    reachable: false,
    checkedAt: now(),
    latencyMs: Date.now() - startedAt,
    totalBytes: null,
    availableBytes: null,
    error,
  })

  try {
    const st = await withFsTimeout(stat(root), `stat(${root})`, timeoutMs)
    if (!st.isDirectory()) return fail(`not a directory: ${root}`)

    const probePath = `${root}/.mde-nas-probe-${process.pid}`
    try {
      await withFsTimeout(writeFile(probePath, ''), `write probe in ${root}`, timeoutMs)
    } finally {
      await withFsTimeout(rm(probePath, { force: true }), `cleanup probe in ${root}`, timeoutMs).catch(() => {})
    }

    const space = await withFsTimeout(statfsAsync(root), `statfs(${root})`, timeoutMs)
    return {
      reachable: true,
      checkedAt: now(),
      latencyMs: Date.now() - startedAt,
      totalBytes: space.blocks * space.bsize,
      availableBytes: space.bavail * space.bsize,
      error: null,
    }
  } catch (err) {
    if (err instanceof FsTimeoutError) return fail(err.message)
    return fail(err instanceof Error ? err.message : String(err))
  }
}
```

- [ ] **Step 2：测试**

覆盖：健康目录 → `reachable: true` 且 `totalBytes`/`availableBytes` 为正数；路径不存在 → `reachable: false`，`error` 提及路径；路径存在但不是目录（建一个同名文件）→ `reachable: false`；用 Task 2 里确认过的 FIFO 挂起技巧模拟挂起挂载 → 在 `timeoutMs` 附近返回 `reachable: false` 且 `error` 来自 `FsTimeoutError`（而不是测试本身超时/挂起）；只读目录（`chmod 0o500`，跟 `assertArchiveRootUsable` 现有测试一个思路）→ `reachable: false`。

- [ ] **Step 3：提交**

```bash
git add src/worker/nas-probe.ts tests/worker/nas-probe.test.ts
git commit -m "feat(worker): NAS 连通与容量探测（P4），运行期可重复调用不影响进程存活"
```

---

## Task 5: 首个管理员账号引导脚本

**Files:**
- Create: `scripts/admin-bootstrap.ts`
- Create: `tests/scripts/admin-bootstrap.test.ts`

**Interfaces:**
- Consumes：`createAdminStore`（Task 3）、`createAdminAuth`（Task 3）、`createPool`/`runMigrations`（`src/store/db.ts`，已存在）

**与本轮此前讨论的一处修正**：此前把这个引导能力设想成 `mde admin bootstrap`（CLI 子命令）。写到这一步发现不合适——`client/` 里的 CLI 现有的每条命令都是"经网关 HTTP + 本地 SQLite 队列"这个模型，唯独这个操作要**直连服务器的 MySQL** 建第一条管理员记录（不可能有一个"未登录也能建管理员"的网关 API，那是明摆着的洞）。给 `client/` 单独加一个 `mysql2` 依赖只为了这一个跟其余命令完全不同路数的操作，会把 CLI 的架构边界搅浑。仓库里已经有 `scripts/preflight.ts`、`scripts/seed-dev.ts` 这类"直连数据库的运维脚本"先例，本任务跟随这个先例，落在 `scripts/admin-bootstrap.ts`，用 `bun scripts/admin-bootstrap.ts` 直接跑，不是 `mde` 的子命令。如果不认可这处改动，告诉我。

- [ ] **Step 1：实现**

```typescript
#!/usr/bin/env bun
// scripts/admin-bootstrap.ts
//
// 首个管理员账号的引导脚本。只在 admin_accounts 表为空时可用——建完第一个账号
// 后自动失效，此后创建/移除管理员账号一律走控制台内"添加运维人员"（US-3.5）。
// 直连数据库而非经网关 HTTP，理由见本任务说明。运行这个脚本需要 DATABASE_URL，
// 也就是需要服务器/部署环境的数据库访问权限——能跑这个脚本的人本来就能直接
// 操作数据库，所以密码走命令行参数（会进 shell history）是可接受的取舍，
// 不必为一次性引导操作单独实现遮蔽输入。

import { randomUUID } from 'node:crypto'
import { createPool, runMigrations } from '../src/store/db'
import { createAdminStore } from '../src/store/admin'
import { createAdminAuth } from '../src/auth/admin'

export function parseArgs(argv: string[]): { username: string; password: string } {
  let username: string | undefined
  let password: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--username') username = argv[++i]
    else if (argv[i] === '--password') password = argv[++i]
  }
  if (!username || !password) {
    throw new Error('usage: bun scripts/admin-bootstrap.ts --username <name> --password <password>')
  }
  if (password.length < 8) {
    throw new Error('password must be at least 8 characters')
  }
  return { username, password }
}

async function main(): Promise<number> {
  const { username, password } = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('missing required env: DATABASE_URL')

  const pool = createPool(databaseUrl)
  try {
    await runMigrations(pool)
    const store = createAdminStore(pool)
    const auth = createAdminAuth({ store })

    const count = await store.countAccounts()
    if (count > 0) {
      console.error(
        `admin_accounts already has ${count} account(s) — bootstrap only works on an empty table. ` +
          'Use the console’s "添加运维人员" to add more accounts.',
      )
      return 1
    }

    const passwordHash = await auth.hashPassword(password)
    await store.createAccount({
      id: randomUUID(),
      username,
      passwordHash,
      now: Math.floor(Date.now() / 1000),
    })
    console.log(`created first admin account: ${username}`)
    return 0
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('admin bootstrap failed', err)
      process.exit(1)
    })
}
```

- [ ] **Step 2：测试**

只测 `parseArgs`（纯函数，导出可测）——实际建账号的路径是 `store.createAccount`/`store.countAccounts`/`auth.hashPassword` 的直接组合，这几个在 Task 3 已经测过，这里重复测等于测两遍同一件事。覆盖：`--username`/`--password` 都给时正确解析；缺任一个抛出带 usage 提示的错误；密码短于 8 位抛出。

```
bun test tests/scripts/admin-bootstrap.test.ts
```

- [ ] **Step 3：提交**

```bash
git add scripts/admin-bootstrap.ts tests/scripts/admin-bootstrap.test.ts
git commit -m "feat(scripts): 首个管理员账号引导脚本，仅在 admin_accounts 为空时可用"
```

---

## Task 6: 控制台登录页接线

**Files:**
- Create: `console/src/pages/Login/index.tsx`
- Create: `console/src/pages/Login/Login.module.css`
- Create: `console/src/api/admin.ts`
- Create: `console/tests/pages/Login.test.tsx`
- Modify: `console/src/app/routes.tsx`
- Modify: `console/src/app/AppShell.tsx`

**Interfaces:**
- Consumes：Task 3 的六个 `/api/v1/admin/*` 端点；`console/src/lib/useResource.ts`（已存在——**先读这个文件**，登录态检查复用它已有的 loading/error/success 三态模式，不要另造一套）；`console/src/ui/Button`、`console/src/ui/Input`（已存在的设计系统基元）
- Produces：`/login` 路由；`checkAdminSession()`/`adminLogin()`/`adminLogout()`（`console/src/api/admin.ts`），供后续阶段（F5 账号设置等）复用

**这一页為什么不经过 `console/src/api/mock/`**：mock 层（`mockApi(state)`）是为"会议/程序列表"这类**业务数据**准备的五态模拟，登录态是完全不同性质的东西（有真实的 cookie、有真实的 401），硬塞进同一个 mock 抽象只会让两者都变形。`console/src/api/admin.ts` 直接 `fetch`，不经过 mock 层，这是有意的架构分界，不是遗漏。

- [ ] **Step 1：`console/src/api/admin.ts`**

```typescript
export interface AdminIdentity {
  adminId: string
  username: string
}

const BASE = '/api/v1/admin'

/** credentials: 'include' 是让 httpOnly cookie 能被浏览器带上/收下的必要条件 */
async function call(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, credentials: 'include' })
}

export class AdminAuthError extends Error {}

export async function adminLogin(username: string, password: string, remember: boolean): Promise<AdminIdentity> {
  const res = await call('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, remember }),
  })
  if (res.status === 401) throw new AdminAuthError('账号或密码错误')
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  return res.json()
}

export async function adminLogout(): Promise<void> {
  await call('/auth/logout', { method: 'POST' })
}

/** 未登录返回 null，而不是抛出——调用方（路由守卫）要的是"有没有登录"这个布尔判断，
 *  不是异常处理流。401 是这个探测本身预期的正常结果之一。 */
export async function fetchAdminIdentity(): Promise<AdminIdentity | null> {
  const res = await call('/auth/me', { method: 'GET' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`session check failed: ${res.status}`)
  return res.json()
}
```

- [ ] **Step 2：登录页组件**

严格按 spec.md §4.1 的行为（已读，原文摘录如下）实现，不要即兴发挥：

> 账号 + 密码 + 「记住此设备 30 天」。仅限内部管理员，无自助注册、无找回密码（文案明说「忘记密码请联系系统管理员开通」）。报错行是**表单级**的（"账号或密码错误"故意不说是哪个字段错了），常驻占位，避免出错时表单跳一行。底部四阶段点线是产品模型的可视化，不是进度条。

```typescript
// console/src/pages/Login/index.tsx（结构示意，具体 JSX/样式按 design-system.md 与
// 现有 ui/Button、ui/Input 的用法来写，不要引入新的按钮/输入框实现）
import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { adminLogin, AdminAuthError } from '@/api/admin'
import Button from '@/ui/Button'
import Input from '@/ui/Input'
import styles from './Login.module.css'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await adminLogin(username, password, remember)
      const from = (location.state as { from?: string } | null)?.from ?? '/meetings'
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof AdminAuthError ? err.message : '登录失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  // 报错行常驻占位（用固定高度的容器包 error，不用条件渲染整行）——
  // 避免出错时表单因为多出/少了一行而跳动，spec.md §4.1 明确要求。
  return (
    <div className={styles.page}>
      <form className={styles.form} onSubmit={onSubmit}>
        <Input label="账号" value={username} onChange={setUsername} autoFocus />
        <Input label="密码" type="password" value={password} onChange={setPassword} />
        <label className={styles.remember}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          记住此设备 30 天
        </label>
        <div className={styles.errorSlot} role="alert">{error}</div>
        <Button type="submit" disabled={submitting}>{submitting ? '登录中…' : '登录'}</Button>
        <p className={styles.hint}>忘记密码请联系系统管理员开通</p>
      </form>
      {/* 四阶段点线：拉取 → 归档 NAS → 本地保留 → 到期，纯展示，不接状态 */}
      <ol className={styles.stages}>
        <li>拉取</li><li>归档 NAS</li><li>本地保留</li><li>到期</li>
      </ol>
    </div>
  )
}
```

`Input` 组件的确切 props（`label`/`value`/`onChange`/`type`/`autoFocus` 是否都存在、命名是否一致）**必须先读 `console/src/ui/Input.tsx` 核实**，上面只是契约示意，不是照抄稿。

- [ ] **Step 3：路由守卫**

`console/src/app/routes.tsx` 加一条 `/login` 路由（不经过 `AppShell`——登录页没有左栏/顶栏）；`AppShell` 内部（或包一层 `RequireAdmin` 组件）用 `useResource`（读它现有签名后对齐用法）在挂载时调 `fetchAdminIdentity()`：

- loading 态：显示现有的骨架屏模式（`console/src/ui/Skeleton`），不要新发明一个 loading UI
- 成功且返回 `null`（未登录）：`<Navigate to="/login" state={{ from: location.pathname }} replace />`
- 成功且返回身份：正常渲染 `<Outlet />`
- error 态（非 401 的网络错误）：复用现有"加载失败"模式（如果 `AppShell` 目前没有这个模式，参照 `Meetings` 页对 `load-failed` 系统状态的处理方式）

- [ ] **Step 4：测试**

镜像 `console/tests/` 现有测试的写法（`@testing-library/react` + `createMemoryRouter`，`routes.tsx` 已经是为了这个目的导出 `routes` 数据而不是建好的 router 实例）。覆盖：未登录访问 `/meetings` 被重定向到 `/login`；登录页提交正确凭据后跳转到原本想去的页面；提交错误凭据后显示"账号或密码错误"且表单不跳动（错误出现前后容器高度不变，可以断言 DOM 结构里 `errorSlot` 一直存在，只是文本内容变化）；已登录状态下直接访问 `/login` 应该跳过登录页（可选加固，不是硬性要求，视实现者判断）。

- [ ] **Step 5：手动验证**

```bash
cd console && bun run dev
```

用浏览器打开，确认：未登录直接跳 `/login`；输错密码看到统一错误文案且表单不跳动；勾选/不勾选"记住此设备"都能登录成功；登录成功后能看到会议记录页。**这一步必须真的在浏览器里点一遍，不能只看测试绿了就算数**——本计划的 Global Constraints 与仓库既有约定都要求 UI 改动过浏览器验证。

- [ ] **Step 6：提交**

```bash
git add console/src/pages/Login console/src/api/admin.ts console/src/app/routes.tsx console/src/app/AppShell.tsx console/tests/pages/Login.test.tsx
git commit -m "feat(console): 登录页接入真实管理员会话 API，未登录路由守卫"
```

---

## Task 7: P2 —— 归档流水线

**Files:**
- Create: `src/store/archives.ts`
- Create: `src/worker/archive.ts`
- Create: `tests/store/archives.test.ts`
- Create: `tests/worker/archive.test.ts`

**Interfaces:**
- Consumes：`createNasStorage`/`withFsTimeout`（Task 2，用于 NAS 侧超时防护）；`meeting_assets` 表（002，**只读**，见下方"三张表边界"）
- Produces：`archiveMeeting(deps, meetingId, subMeetingId, now): Promise<ArchiveOutcome>`，供 worker 主循环与 Task 8 使用；`ArchivesStore`（`src/store/archives.ts`）供 Task 8 直接复用

**三张表的边界（写在这里，因为本任务是唯一同时接触三张表的任务，边界在这里最容易被破坏）**：`meeting_assets`（002）从资产下载完成那一刻起是**只读历史事实**——本任务绝不 UPDATE 它的任何一列。NAS 侧路径与哈希只写进新表 `archived_assets`。整场会议的保留窗口只写进 `meeting_archives`。这样"到期只删本地文件"（Task 8）才有本地路径可查——它就在 `meeting_assets.target_path` 里，从来没被覆盖过。

- [ ] **Step 0：核实两处尚未验证的细节**

在写代码之前，实现者必须先读两个文件确认下面两件事，因为本任务的正确性依赖它们：

1. 读 `src/worker/store-mysql.ts` 与 `migrations/002_worker_queue.sql`，确认 `meeting_assets.target_path` 在资产下载完成（`status='completed'`）时，存的是**相对于本地归档根目录（`MDE_ARCHIVE_ROOT`）的相对路径**还是绝对路径。下面的代码假设是相对路径（与 `packages/engine/src/storage/local.ts` 的 `relPath` 概念一致）；如果实测是绝对路径，`archive.ts` 里拼本地源文件路径的那一行要相应去掉 `join(localRoot, ...)`。
2. 读 `packages/engine/src/domain/filename.ts` 的 `cleanDirName`，确认它是否已经导出了"给定会议信息生成一个安全目录名"的能力——如果有，Step 2 的 `nasDirFor` 应该复用它拼目录名的规则（避免同一份"清洗文件名"逻辑出现第二份实现），只是外面套一层"按年/月分桶"。

- [ ] **Step 1：`ArchivesStore`**

```typescript
// src/store/archives.ts
import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import type { Pool } from './db'

/** meeting_assets 里一行"已完成下载"的资产——字段照抄 002 的列，只读用途 */
export interface CompletedAssetRow {
  meetingId: string
  subMeetingId: string
  assetType: string
  remoteId: string
  fileType: string
  targetPath: string
  bytesWritten: number
}

export interface ArchivedAssetRecord {
  meetingId: string
  subMeetingId: string
  assetType: string
  remoteId: string
  fileType: string
  /** 本地相对路径的副本，值取自 meeting_assets.target_path——写入后不再更新，
   *  用途见 Task 8：到期清理要删本地文件，不必为此再跨表查 meeting_assets */
  localPath: string
  nasPath: string
  nasHash: string
  archivedAt: number
}

export interface MeetingArchiveRecord {
  meetingId: string
  subMeetingId: string
  nasDir: string
  archivedAt: number
  retentionDays: number
  extendedDays: number
  localPurgedAt: number | null
}

export interface ArchivesStore {
  /** WHERE status='completed'，供归档流水线挑出"下载完成但还没进 archived_assets"的资产 */
  listCompletedAssets(meetingId: string, subMeetingId: string): Promise<CompletedAssetRow[]>
  /** 该资产是否已经在 archived_assets 里有记录（用于跳过已归档过的资产，支持重跑） */
  isAssetArchived(row: Pick<CompletedAssetRow, 'meetingId' | 'subMeetingId' | 'assetType' | 'remoteId' | 'fileType'>): Promise<boolean>
  recordArchivedAsset(input: ArchivedAssetRecord): Promise<void>
  /** 某场会议 meeting_assets 里 completed 的资产总数，与 archived_assets 里已归档的数量做比较，
   *  用来判断"这场会议是不是全部资产都归档完了"（只有全部完成才创建/更新 meeting_archives） */
  countCompletedAssets(meetingId: string, subMeetingId: string): Promise<number>
  countArchivedAssets(meetingId: string, subMeetingId: string): Promise<number>

  upsertMeetingArchive(input: {
    meetingId: string
    subMeetingId: string
    nasDir: string
    archivedAt: number
    retentionDays: number
    now: number
  }): Promise<void>
  findMeetingArchive(meetingId: string, subMeetingId: string): Promise<MeetingArchiveRecord | null>
  extendRetention(meetingId: string, subMeetingId: string, addDays: number, now: number): Promise<void>
  /** Task 8 用：查全部到期且未清理的会议 */
  listExpiredUnpurged(now: number): Promise<MeetingArchiveRecord[]>
  /** Task 8 用：某场会议已归档到 NAS 的全部资产（据此重新校验哈希、找本地文件删） */
  listArchivedAssetsForMeeting(meetingId: string, subMeetingId: string): Promise<ArchivedAssetRecord[]>
  markLocalPurged(meetingId: string, subMeetingId: string, now: number): Promise<void>

  /** system_settings 读写，键名固定为 'cleanup_paused' / 'default_retention_days' */
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string, now: number): Promise<void>
}
```

行映射与查询写法照抄 `src/store/auth.ts`/`src/store/admin.ts` 的风格（`RowDataPacket` 子接口 + `mapXRow` + 参数化查询）。`upsertMeetingArchive` 用 `INSERT ... ON DUPLICATE KEY UPDATE`（这是本模块唯一需要 upsert 语义的地方——归档流水线可能对同一场会议多次调用，直到全部资产都归档完才第一次真正建这行记录，之后不会再更新，所以 upsert 只是为了防止"极端情况下并发跑了两次归档"时报主键冲突，不是常态路径会走到 UPDATE 分支）。**`ON DUPLICATE KEY UPDATE` 子句只能更新 `nas_dir`、`archived_at`、`retention_days`、`updated_at` 这四列，绝不能包含 `extended_days`**——`upsertMeetingArchive` 的入参里根本没有 `extendedDays`（它只由 `extendRetention` 修改），如果 UPDATE 子句无脑把它也列进去（哪怕值是 `VALUES(extended_days)` 这种"看似安全"的写法，因为 INSERT 语句本身也没给这一列传值，会退回列定义的 `DEFAULT 0`），一次意外的重复归档调用就会把管理员刚做的"延长 30 天"悄悄清零。

- [ ] **Step 2：ArchivesStore 测试**

覆盖每个方法的往返正确性；`isAssetArchived`/`countArchivedAssets` 在归档前后的返回值变化；`upsertMeetingArchive` 对同一 `(meetingId, subMeetingId)` 调用两次不报错、`archived_at` 取第二次的值（因为 `ON DUPLICATE KEY UPDATE` 语义）；`extendRetention` 调用后 `findMeetingArchive` 返回的 `extendedDays` 累加正确（不是覆盖）；`getSetting` 对不存在的 key 返回 `null`。

- [ ] **Step 3：归档流水线**

```typescript
// src/worker/archive.ts
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { join, dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { withFsTimeout } from '@yaowu/mde-engine'
import type { ArchivesStore, CompletedAssetRow } from '../store/archives'

const NAS_WRITE_TIMEOUT_MS = 5_000
const DEFAULT_RETENTION_DAYS = 30

async function sha256File(path: string): Promise<string> {
  // 流式读取，不用 arrayBuffer() 一次性载入内存——录像资产可以有几个 GB，
  // 一次性读入会把归档 worker 的内存打爆。
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * 本阶段（阶段 2）用"按年/月 + 会议 ID"的固定目录规则，不是规则驱动的。
 * spec.md §4.6 描述的"归档规则决定进 NAS 的哪个目录"要到阶段 3（R1 三栈规则
 * 引擎）才有配置入口——在那之前用一个确定性的默认规则，不阻塞归档能力本身
 * 上线。等 R1/R4 落地后这里要接一个真正的规则求值，不是最终形态，这里显式记着。
 */
function nasDirFor(nasRoot: string, meetingId: string, subMeetingId: string, archivedAtSec: number): string {
  const d = new Date(archivedAtSec * 1000)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dirName = subMeetingId ? `${meetingId}_${subMeetingId}` : meetingId
  return join(nasRoot, String(year), month, dirName)
}

export interface ArchiveDeps {
  archives: ArchivesStore
  localRoot: string
  nasRoot: string
  /** 默认 sha256File；测试用来注入一个会返回不匹配哈希的假实现，
   *  制造"NAS 写入内容与本地不一致"这个场景——不这样做的话，Step 4 的
   *  用例 3（校验失败分支）在真实文件系统上无法确定性地构造出来
   *  （复制操作本身是正确的，没有天然会失败的路径）。 */
  hashFile?: (path: string) => Promise<string>
}

export interface ArchiveOutcome {
  meetingId: string
  subMeetingId: string
  /** 本轮新归档成功的资产数（不含此前已归档过的） */
  newlyArchived: number
  /** 哈希校验不一致、本轮跳过的资产数——不是致命错误，下一轮会重试 */
  verificationFailed: number
  /** completed 资产是否已全部归档完（据此决定要不要写 meeting_archives） */
  fullyArchived: boolean
}

async function archiveOneAsset(
  deps: ArchiveDeps,
  asset: CompletedAssetRow,
  nasDir: string,
  now: number,
): Promise<'archived' | 'verification_failed'> {
  const localPath = join(deps.localRoot, asset.targetPath)
  const nasPath = join(nasDir, asset.targetPath) // 沿用与本地一致的相对结构，方便人工按路径核对

  const doHash = deps.hashFile ?? sha256File
  const localHash = await doHash(localPath)

  await withFsTimeout(mkdir(dirname(nasPath), { recursive: true }), `mkdir(${dirname(nasPath)})`, NAS_WRITE_TIMEOUT_MS)
  await withFsTimeout(
    pipeline(createReadStream(localPath), createWriteStream(nasPath)),
    `copy to ${nasPath}`,
    NAS_WRITE_TIMEOUT_MS,
  )
  // 重新读回 NAS 上刚写的文件算哈希，不信任"写操作没抛异常"——这是 dev-plan.md
  // §6 对不可逆删除那条硬要求（重新校验，不查记录）的同一种精神在归档侧的体现：
  // 校验永远针对"实际在 NAS 上的字节"，不针对"我们以为发生了什么"。
  const nasHash = await withFsTimeout(doHash(nasPath), `hash ${nasPath}`, NAS_WRITE_TIMEOUT_MS)

  if (localHash !== nasHash) {
    return 'verification_failed'
  }

  await deps.archives.recordArchivedAsset({
    meetingId: asset.meetingId,
    subMeetingId: asset.subMeetingId,
    assetType: asset.assetType,
    remoteId: asset.remoteId,
    fileType: asset.fileType,
    localPath: asset.targetPath,
    nasPath,
    nasHash,
    archivedAt: now,
  })
  return 'archived'
}

export async function archiveMeeting(
  deps: ArchiveDeps,
  meetingId: string,
  subMeetingId: string,
  now: number,
): Promise<ArchiveOutcome> {
  const completed = await deps.archives.listCompletedAssets(meetingId, subMeetingId)
  const nasDir = nasDirFor(deps.nasRoot, meetingId, subMeetingId, now)

  let newlyArchived = 0
  let verificationFailed = 0
  for (const asset of completed) {
    if (await deps.archives.isAssetArchived(asset)) continue // 已归档过，跳过（支持安全重跑）
    const outcome = await archiveOneAsset(deps, asset, nasDir, now)
    if (outcome === 'archived') newlyArchived++
    else verificationFailed++
  }

  const totalCompleted = await deps.archives.countCompletedAssets(meetingId, subMeetingId)
  const totalArchived = await deps.archives.countArchivedAssets(meetingId, subMeetingId)
  const fullyArchived = totalCompleted > 0 && totalCompleted === totalArchived

  if (fullyArchived) {
    const retentionSetting = await deps.archives.getSetting('default_retention_days')
    const retentionDays = retentionSetting ? Number(retentionSetting) : DEFAULT_RETENTION_DAYS
    await deps.archives.upsertMeetingArchive({ meetingId, subMeetingId, nasDir, archivedAt: now, retentionDays, now })
  }

  return { meetingId, subMeetingId, newlyArchived, verificationFailed, fullyArchived }
}
```

**为什么这里不用 Task 2 的 `createNasStorage`，明明它就是为归档准备的**：`Storage` 接口是按"边下载边写、可断点续传"设计的（`appendChunk` + `finalize`），服务的是"数据从网络进来、逐块落盘"这个场景。这里是相反的场景——本地已经有一个**完整**的文件，要一次性搬到 NAS 上，用途是"流式拷贝 + 拷贝后整体求哈希"，用 `appendChunk` 反而要么把整个文件读进内存当一个大 chunk（违反下面"不能一次性载入内存"的约束），要么手工切块调用多次（重新实现一遍流式拷贝，还是绕不开自己写 pipeline）。所以这里直接用 `node:fs` 的 `pipeline(createReadStream, createWriteStream)`，只借 Task 2 抽出来的 `withFsTimeout` 防止 NAS 那一端挂起。`createNasStorage` 本身仍然是有效交付物——它满足的是 dev-plan.md 明确要的"实现同一个 Storage 接口"，为将来可能出现的"直接下载到 NAS"路径或其他消费者留着，不是本任务白造了一个用不上的东西。

**为什么 `verificationFailed` 不让整场会议的归档失败、也不重试同一个哈希不一致的资产而是就地跳过**：跳过之后 `isAssetArchived` 仍会在下一轮返回 `false`（因为没写 `archived_assets`），所以下一轮 worker 循环会自动重试这个资产——不需要专门的重试计数字段。哪些资产在"重试但一直失败"，这是阶段 4 才有的展示能力（分诊条的"归档失败"格），本任务只需要保证正确性（不会把校验失败的资产错误地标记为已归档），不需要在这里实现展示。

- [ ] **Step 4：归档流水线测试**

用临时目录分别当 `localRoot` 与 `nasRoot`（不需要真的 mock NAS，本地文件系统语义已经足够验证逻辑正确性；NAS 特有的挂起/超时场景已经在 Task 2 的 `nas.test.ts` 覆盖过，这里不重复）。覆盖：

1. 单个资产归档成功 → `archived_assets` 有记录、哈希与本地文件一致、`newlyArchived === 1`
2. 会议的全部 completed 资产都归档成功 → `meeting_archives` 被创建，`fullyArchived === true`
3. 只归档了部分资产（人为让某个资产的本地文件在复制后被篡改，模拟 NAS 写入损坏）→ 该资产 `verificationFailed`，`archived_assets` 里没有它的记录，`meeting_archives` **不**被创建（因为不是 `fullyArchived`）
4. 对已经全部归档过的会议重跑一次 → `newlyArchived === 0`（`isAssetArchived` 挡住了重复归档），不重复写 `archived_assets`
5. 分两轮跑：第一轮部分资产完成、第二轮剩余资产完成 → 第二轮之后 `fullyArchived === true` 且 `meeting_archives` 被创建（验证"分批完成"场景，不要求所有资产必须在同一轮里一起就绪）

- [ ] **Step 5：接入 worker 主循环**

读 `src/worker/index.ts` 的 `runWorkerOnce`，在其现有的"发现 → 探测 → 执行下载"之后追加一步"对本轮涉及的会议调用 `archiveMeeting`"。具体接入点由实现者根据 `runWorkerOnce` 现有返回结构（`WorkerRound`）判断——`WorkerRound` 大概率需要加一个 `archived: { newlyArchived: number; verificationFailed: number }` 汇总字段，跟随现有 `probes`/`completed`/`failed` 这几个字段的风格。**不要**把归档逻辑内联进 `runWorkerOnce` 函数体，作为独立的 `archiveMeeting` 调用保持关注点分离，方便 Task 8 单独复用 `ArchivesStore` 而不必牵扯下载逻辑。

- [ ] **Step 6：提交**

```bash
git add src/store/archives.ts src/worker/archive.ts src/worker/index.ts \
        tests/store/archives.test.ts tests/worker/archive.test.ts
git commit -m "feat(worker): 归档流水线（P2）——本地到 NAS 复制并双端校验哈希"
```

---

## Task 8: P3 —— 保留窗口与到期清理

**Files:**
- Create: `src/worker/retention.ts`
- Create: `tests/worker/retention.test.ts`

**Interfaces:**
- Consumes：`ArchivesStore`（Task 7）
- Produces：`previewCleanup`/`executeCleanup`，供未来阶段 4 的存储管理 API（不在本计划范围，A3 会调用这两个函数）

**这是整个阶段 2 风险最高的任务（dev-plan.md §6 明确点名）。三条硬要求逐字实现，不是"大致做到"：**

1. 删之前**当场重新校验**哈希，不信任 `archived_assets.nas_hash` 这个此前记录的值——虽然 Task 7 归档时已经校验过一次，但从归档到到期之间可能经过几十天，这段时间里 NAS 上的文件有可能被外部因素改动，"上次校验过"不等于"现在还一致"
2. 暂停开关持久化在 `system_settings`（Task 1 已建表），**不是**内存变量
3. **默认 dry-run**，真删须显式二次确认

- [ ] **Step 1：核心逻辑**

```typescript
// src/worker/retention.ts
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFsTimeout } from '@yaowu/mde-engine'
import type { ArchivesStore, ArchivedAssetRecord, MeetingArchiveRecord } from '../store/archives'

const NAS_READ_TIMEOUT_MS = 5_000

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export interface RetentionDeps {
  archives: ArchivesStore
  localRoot: string
}

export interface CleanupItem {
  meetingId: string
  subMeetingId: string
  /** 该会议本地占用的字节数（供预览页展示"删了能腾出多少空间"，来自 meeting_assets.bytes_written 之和——
   *  实现者从 archives store 或直接查询里取得，不在本文件重新定义查询） */
  localBytes: number
  assetCount: number
}

export interface CleanupPreview {
  dryRun: true
  items: CleanupItem[]
  totalBytes: number
}

export interface CleanupExecuted {
  dryRun: false
  paused: boolean
  /** paused=true 时 items 为空，说明本轮因暂停开关直接跳过 */
  purged: CleanupItem[]
  /** 哈希重新校验不一致、本轮拒绝删除的会议——需要人工介入，不是静默跳过 */
  verificationFailed: Array<{ meetingId: string; subMeetingId: string; reason: string }>
}

function expiresAt(rec: MeetingArchiveRecord): number {
  return rec.archivedAt + (rec.retentionDays + rec.extendedDays) * 86400
}

async function isPaused(archives: ArchivesStore): Promise<boolean> {
  return (await archives.getSetting('cleanup_paused')) === '1'
}

/**
 * 预览：只读，永远安全，不需要检查暂停开关（暂停开关管的是"删不删"，
 * 预览不删任何东西）。
 */
export async function previewCleanup(deps: RetentionDeps, now: number): Promise<CleanupPreview> {
  const candidates = (await deps.archives.listExpiredUnpurged(now)).filter((r) => expiresAt(r) < now)
  const items: CleanupItem[] = []
  let totalBytes = 0
  for (const rec of candidates) {
    const assets = await deps.archives.listArchivedAssetsForMeeting(rec.meetingId, rec.subMeetingId)
    // 预览阶段不读文件、不算哈希——那是"真删"才需要付出的代价（可能触达几十个
    // NAS 文件），预览只需要知道"有哪些、大概多大"，字节数来自已经落库的记录。
    items.push({ meetingId: rec.meetingId, subMeetingId: rec.subMeetingId, assetCount: assets.length, localBytes: 0 })
  }
  return { dryRun: true, items, totalBytes }
}

/**
 * 真删。confirm 必须显式为 true——调用方（未来 A3 的 API）不给默认值，
 * 逼着每一次调用点都写明白"这次是真删"，不能靠参数省略意外触发。
 */
export async function executeCleanup(deps: RetentionDeps, now: number, confirm: true): Promise<CleanupExecuted> {
  if (await isPaused(deps.archives)) {
    return { dryRun: false, paused: true, purged: [], verificationFailed: [] }
  }

  const candidates = (await deps.archives.listExpiredUnpurged(now)).filter((r) => expiresAt(r) < now)
  const purged: CleanupItem[] = []
  const verificationFailed: Array<{ meetingId: string; subMeetingId: string; reason: string }> = []

  for (const rec of candidates) {
    const assets = await deps.archives.listArchivedAssetsForMeeting(rec.meetingId, rec.subMeetingId)

    // 硬要求 1：删之前当场重新校验 NAS 上每个文件的哈希，不信任 archived_assets
    // 里记录的旧值。任何一个资产校验不过，整场会议本轮都不删——不做"部分删"，
    // 否则库里的 local_purged_at 语义会变得含糊（到底是"全删了"还是"删了一半"）。
    let allVerified = true
    for (const asset of assets) {
      try {
        const currentHash = await withFsTimeout(sha256File(asset.nasPath), `hash ${asset.nasPath}`, NAS_READ_TIMEOUT_MS)
        if (currentHash !== asset.nasHash) { allVerified = false; break }
      } catch {
        allVerified = false
        break
      }
    }
    if (!allVerified) {
      verificationFailed.push({
        meetingId: rec.meetingId,
        subMeetingId: rec.subMeetingId,
        reason: 'NAS 上文件哈希与归档记录不一致，或读取失败——已跳过，不删除任何本地文件',
      })
      continue
    }

    // 校验全部通过——只删本地文件，NAS 副本与数据库记录永久保留（spec.md §4.9）。
    // asset.localPath 是 Task 7 归档时复制进 archived_assets 的本地相对路径副本，
    // 不需要跨表回查 meeting_assets。
    for (const asset of assets) {
      await rm(join(deps.localRoot, asset.localPath), { force: true })
    }
    await deps.archives.markLocalPurged(rec.meetingId, rec.subMeetingId, now)
    purged.push({ meetingId: rec.meetingId, subMeetingId: rec.subMeetingId, assetCount: assets.length, localBytes: 0 })
  }

  return { dryRun: false, paused: false, purged, verificationFailed }
}
```

- [ ] **Step 2：测试**

覆盖三条硬要求逐条验证，不能只测"功能跑通"：

1. **dry-run 默认且从不删除**：`previewCleanup` 对到期会议返回正确的候选列表，但断言调用前后本地文件、`archived_assets`、`meeting_archives.local_purged_at` 均无变化
2. **暂停开关生效**：`system_settings.cleanup_paused = '1'` 时 `executeCleanup` 直接返回 `paused: true`，不触达任何文件；改回 `'0'` 后才能真删
3. **暂停开关持久化**：这条测试尤其重要——不是测"设了就生效"，而是测"用一个全新的 `ArchivesStore` 实例（模拟进程重启）读到的暂停状态与设置前一致"，证明它不是内存变量
4. **删前重新校验哈希**：人为在测试里篡改 NAS 侧文件内容（不改 `archived_assets.nas_hash`，模拟"记录还是旧的，文件已经变了"）→ `executeCleanup` 拒绝删除该会议的本地文件，出现在 `verificationFailed` 里，`local_purged_at` 仍为 `null`
5. **哈希一致时正常清理**：本地文件被删、`markLocalPurged` 被调用、`meeting_archives` 这行记录本身**没有**被删除（数据库记录永久保留）、NAS 上的文件**没有**被删除
6. **未到期的会议不受影响**：`archivedAt + retentionDays` 还没到 `now` 的会议不出现在候选里
7. **`extendedDays` 生效**：一场本会因 `retentionDays` 到期、但 `extendedDays` 足够大的会议，不出现在候选里（验证"延长 30 天"这个动作的下游效果，即使"延长"这个写操作本身在阶段 4 的 API 才暴露给前端）

- [ ] **Step 3：提交**

```bash
git add src/worker/retention.ts tests/worker/retention.test.ts
git commit -m "feat(worker): 保留窗口与到期清理（P3）——dry-run 默认、删前重新校验哈希、暂停开关持久化"
```

---

## 完成判据

- [ ] 8 个任务全部完成，每个任务的 task reviewer 判定 spec ✅ 且质量 approved
- [ ] `bun test`（仓库根）、`cd packages/engine && bun test`、`cd console && bun run test`、`cd client && bun test` 全部通过
- [ ] `bun run typecheck`（根）与 `cd console && bun run typecheck` 通过
- [ ] `cd console && bun run a11y`（Task 6 新增的登录页必须过现有的无障碍回归门槛，不能因为新页面拉低整体分数）
- [ ] Task 6 的 Step 5（浏览器手动验证）确认完成——登录页在真实浏览器里走过一遍，不只是测试绿
- [ ] 用户故事映射表里的 8 行逐条核对：US-3.4、US-3.5、US-5.6 这三条的验收标准，除了单元测试覆盖之外，能用一句话说清楚"具体是哪几个测试用例证明了它"
- [ ] 最终整体审查（参照 `superpowers:requesting-code-review` 的 code-reviewer 走一遍全分支 diff）
- [ ] 更新 `docs/console/dev-plan.md` §3 阶段 2 的任务表与 §4 的并行编排图，把 P1–P4 与 A1 标记为已完成——这份计划完成后 dev-plan.md 本身要跟上现实，不能让它继续显示"未开工"

