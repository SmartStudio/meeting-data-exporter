# 定时任务页失败项动作与 404 永久缺失 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「定时任务」页的失败项从一张只能看的表变成能处理的待办：404 判成平台永久缺失自动收敛、原因写成人话、每条失败项能重试或忽略、落后横幅可关。

**Architecture:** 四段互不重叠的改动，按依赖顺序落地。引擎侧下载器新增 `permanent` 判定、执行器把它转成 `skipped('upstream_missing')`；网关侧加一列 `job_failures.detail`（原始报错）与一个 `src/worker/failure-text.ts`（把 `last_error` 翻成人话），再加两个批量端点与两个 Store 方法（SQLite 与 MySQL 两个宿主一起改）；控制台侧把关闭横幅的 hook 泛化成 `useDismissedBanner`，并给失败项表加行级与组级动作。

**Tech Stack:** Bun + TypeScript monorepo；网关 `src/`（MySQL / mysql2）、引擎 `packages/engine/`（SQLite / bun:sqlite）、控制台 `console/`（React 19 + Vite + vitest）。网关与引擎测试用 `bun test <path>`，控制台用 `cd console && bunx vitest run <path>`。

**Spec:** `docs/superpowers/specs/2026-09-09-jobs-failures-actions-design.md`

## Global Constraints

这一节是**每个任务的隐含要求**。所有引号里的字符串逐字照抄，不许改一个字。

- **规格**：`docs/superpowers/specs/2026-09-09-jobs-failures-actions-design.md`。有分歧以它为准。
- **前置规格由另一份计划并行实现，本计划一个字都不许碰这些位置**：`src/tencent/records.ts`（整文件）、`src/worker/store-mysql.ts` 的 `meetingsForPaths`、`packages/engine/src/executor/index.ts` 的 `buildRelPath`、`scripts/` 整个目录。改 `packages/engine/src/executor/index.ts` 时**只动 `handleOne` 里处理下载结果那几行**（`res.status === 'completed'` 之后、`markDead` 之前），别的行不要顺手整理。
- **两个 Store 宿主一起改**：引擎侧 `packages/engine/src/store/index.ts`（SQLite，表名 `assets`）与网关侧 `src/worker/store-mysql.ts`（MySQL，表名 `meeting_assets`）是同一个 `Store` 接口的两个实现。新增方法必须两边都写、语句结构逐条对齐。只改一边的后果是**两边都不报错**，只是 CLI 与服务器行为分叉。
- **网关测试用真 MySQL**：`tests/helpers/testdb.ts` 的 `withTestDb()`，要 `TEST_DATABASE_URL` 指向一个有 `CREATE DATABASE` 权限的实例。store 层与端点层都不许 mock 数据库。
- **迁移文件是 `migrations/014_job_failures_detail.sql`**（013 归并行的那份周期会议规格）。两条硬约束（见 `src/store/db.ts` 的 `runMigrations`）：按分号朴素切分语句，**注释里也不许出现分号**；每次启动都重跑，所以 `ALTER TABLE ADD COLUMN` 必须走 information_schema 守卫 + PREPARE/EXECUTE（写法照抄 `migrations/011_program_auto_grant.sql`）。
- **端点路径**（两个都要管理员写权限 `requireAdminWrite`，都写审计）：
  - `POST /api/v1/admin/jobs/failures/retry`
  - `POST /api/v1/admin/jobs/failures/ignore`
- **请求体** `{ ids: number[] }`（`job_failures.id`，**1–100 个**）；**响应** `{ affected: number, skipped: number[] }`，`skipped` 是没能处理的失败项 id（找不到、已恢复、或不是可操作的失败项）。
- **可操作的失败项只有一种**：`job_name = 'fetch_recordings'` 且 `meeting_id IS NOT NULL` 且 `resolved_at IS NULL`。其他任务的失败项每轮自己判定、自己恢复，端点对它们返回 skipped。
- **审计动作名**：`job_failure_retry` / `job_failure_ignore`。登记表在 `src/audit/actions.ts`（`AUDIT_ACTION_LABELS` + `AUDIT_ACTION`），镜像清单在 `tests/audit/actions.test.ts` 的 `WRITTEN_ACTIONS`——**三处一起改**，少改一处编译不过或测试红。
- **资产状态里的两个 skip 理由**：`upstream_missing`（下载器判定平台永久缺失）、`ignored_by_admin`（管理员点了忽略）。
- **原因人话**（`describeDownloadError` 的五个返回值，逐字）：`腾讯那边没有这个文件` / `腾讯下载服务出错` / `本地写入失败` / `下载不完整` / `下载失败`。
- **控制台按钮文案**（逐字）：行级 `重试`、`忽略`；组级 `全部重试`、`全部忽略`；折叠原始报错的那个 `技术详情`；两条横幅的关闭按钮可访问名都是 `关闭这条提醒`。
- **localStorage 键**：落后横幅 `mde.jobs.overdue.dismissed`，连续失败横幅仍是 `mde.jobs.fetch-stall.dismissed`（行为一个字都不许变）。
- 不加任何新配置项、不加任何新依赖。

---

## 文件结构

**新建**

| 文件 | 职责 |
| --- | --- |
| `migrations/014_job_failures_detail.sql` | `job_failures` 加一列 `detail TEXT NULL` |
| `src/worker/failure-text.ts` | 把 `meeting_assets.last_error` 翻成人话 / 拼原始明细。纯函数，不碰库 |
| `tests/worker/failure-text.test.ts` | 上面那个模块的逐条口径 |
| `tests/http/console-jobs-failures.test.ts` | 两个动作端点，跑在真 MySQL 上 |

**修改**

| 文件 | 改什么 |
| --- | --- |
| `packages/engine/src/downloader/index.ts` | `DownloadResult` 加 `permanent?: true`；404 换链再试一次 |
| `packages/engine/src/executor/index.ts` | `handleOne` 里认 `permanent` → `markSkipped('upstream_missing')`（**只改这几行**） |
| `packages/engine/src/store/index.ts` | `Store` 接口 + SQLite 实现加 `retryMeetingAssets` / `ignoreDeadAssets` |
| `src/worker/store-mysql.ts` | MySQL 实现同两个方法；`DeadAsset` 加 `remoteId` / `fileType`，`deadAssets()` 多取两列 |
| `src/store/jobs.ts` | `detail` 贯穿 `RecordFailureInput` / `JobFailureRecord` / SQL；新增 `listFailuresById` / `resolveFailuresByIds`；导出 `JOB_FETCH_RECORDINGS` |
| `src/worker/scheduler.ts` | `JobFailInput` 加 `detail`；`ctx.fail` 透传；`recordDeadAssets` 改用 `failure-text.ts` |
| `src/http/handlers/console/jobs.ts` | `failureView` 带 `detail`；新增两个动作 handler；`JobsDeps` 加 `assets` |
| `src/http/router.ts` | 两条新路由 |
| `src/index.ts` | 给 `deps.jobs.assets` 接上 `createMysqlStore(pool)` |
| `src/audit/actions.ts` | 两个新动作的标签与常量 |
| `console/src/api/admin/jobs.ts` | `JobFailure.detail`；`retryFailures` / `ignoreFailures` |
| `console/src/api/mock/jobs.ts` | 种子失败项带 `detail` |
| `console/src/api/mock/install.ts` | 两个动作端点的假实现 |
| `console/src/pages/Jobs/dismiss.ts` | 泛化成 `useDismissedBanner(storageKey, identity)` |
| `console/src/pages/Jobs/view.ts` | `overdueIdentity` / `isActionableFailure` / 三句动作文案 |
| `console/src/pages/Jobs/index.tsx` | 落后横幅加关闭按钮；失败项动作的状态机与 toast |
| `console/src/pages/Jobs/FailuresTable.tsx` | 「操作」列、组级按钮、`技术详情` |
| `console/src/pages/Jobs/Jobs.module.css` | 操作列与 `技术详情` 的样式 |
| `docs/console/spec.md` | §4.8 那句「不能关」改写 |
| `docs/2026-09-09-jobs-failures-rollout.md` | 上线 runbook（新建，但归在文档任务里） |

---

## Task 1：引擎——404 判永久缺失，执行器转 skipped

**Files:**
- Modify: `packages/engine/src/downloader/index.ts`
- Modify: `packages/engine/src/executor/index.ts`（**只改 `handleOne` 里处理下载结果的那几行**）
- Test: `packages/engine/tests/downloader/index.test.ts`、`packages/engine/tests/executor/index.test.ts`

**Interfaces:**
- Produces：`DownloadResult` 的 failed 分支多一个可选字段 `permanent?: true`。完整类型：
  ```ts
  export type DownloadResult =
    | { status: 'completed'; contentHash: string | null; bytesWritten: number }
    | { status: 'failed'; error: string; permanent?: true }
  ```
  执行器对 `permanent === true` 的结果调 `store.markSkipped(row.id, 'upstream_missing', now)` 并计入 `result.skipped`。
- Consumes：`Storage.discardPart(relPath)`、`AssetSource.getDownloadUrl(assetId)`、`Store.markSkipped(id, reason, now)`（都已存在）。

- [ ] **Step 1: 写下载器的两条失败用例（先红）**

追加到 `packages/engine/tests/downloader/index.test.ts` 末尾（文件里已有 `BODY` / `tmp()` / `serve()` 三个辅助，直接用）：

```ts
// 2026-09-09 本机实测：「转写_」录制记录的 video 在腾讯那边根本没有这个文件，
// 每一次请求都回 404。换一条新链接再试一次是为了排除「这条链接本身过期了」
// （403/410 之外还有平台偶发把过期链接回成 404 的情形）；第二次仍 404 就是
// 平台的事实，重试多少次都是同一个答案——交给执行器判永久缺失，不要走退避到 dead。
test('404 换一条新链接再试一次；第二次仍 404 → permanent', async () => {
  const root = await tmp(); const storage = createLocalStorage(root)
  let served = 0
  const server = Bun.serve({ port: 0, fetch() { served++; return new Response('not found', { status: 404 }) } })
  let urls = 0
  const gw = { getDownloadUrl: async () => { urls++; return { url: `http://localhost:${server.port}/f?v=${urls}`, expiresAt: 9e9, fileType: 'mp4', bytesExpected: null } } } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'f.mp4', bytesExpected: null, isText: false }, () => 1)
  expect(r).toEqual({ status: 'failed', error: 'http 404', permanent: true })
  expect(served).toBe(2)   // 只多试一次，不是把 6 次换链额度耗光
  expect(urls).toBe(2)     // 换过一次链
  server.stop(); await rm(root, { recursive: true, force: true })
})

// 换链之后 **不保留 size**（与 403/410 那条路径的区别）：404 之后拿到的新链接
// 很可能指向另一份文件，拿旧的 .part 去续传会拼出一个字节数对不上的坏文件。
test('404 之后换链成功：旧的 .part 被丢弃，落盘是完整文件而不是续上去的', async () => {
  const root = await tmp(); const storage = createLocalStorage(root)
  await storage.appendChunk('f.bin', 0, BODY.slice(0, 400))   // 上一轮下到 400 字节就断了
  const server = Bun.serve({ port: 0, fetch(req) {
    if (new URL(req.url).searchParams.get('v') === '1') return new Response('not found', { status: 404 })
    // 带 Range 就说明 .part 没被丢掉——这正是这条用例要挡的那个 bug
    if (req.headers.get('range')) return new Response('unexpected range', { status: 416 })
    return new Response(BODY, { status: 200 })
  } })
  let v = 0
  const gw = { getDownloadUrl: async () => { v++; return { url: `http://localhost:${server.port}/f?v=${v}`, expiresAt: 9e9, fileType: null, bytesExpected: null } } } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'f.bin', bytesExpected: null, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  if (r.status === 'completed') expect(r.bytesWritten).toBe(BODY.length)   // 1000，不是 1400
  server.stop(); await rm(root, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑它，确认红**

Run: `bun test packages/engine/tests/downloader/index.test.ts`
Expected: 两条新用例 FAIL——第一条实际拿到 `{ status: 'failed', error: 'http 404' }`（没有 `permanent`）、`served` 是 1；第二条 416。

- [ ] **Step 3: 改下载器**

`packages/engine/src/downloader/index.ts`。先把类型改掉：

```ts
export type DownloadResult =
  | { status: 'completed'; contentHash: string | null; bytesWritten: number }
  /**
   * `permanent` = **平台确认没有这个文件**，不是「这次没成」。只有 404 走到这里
   * （换过一条新链接仍然 404）。执行器据此把资产判成 `skipped/upstream_missing`，
   * 不走退避、不进 dead——重试五次拿到的是同一个 404，而那五次之后留下的
   * 一条 dead 行会永远挂在「失败项 · 需要处理」上，等一个不存在的修复。
   */
  | { status: 'failed'; error: string; permanent?: true }
```

再在 `downloadAsset` 的循环里加一个计数器与一条分支。`for` 之前：

```ts
    let link = await deps.gw.getDownloadUrl(task.assetId)
    let renewedFor404 = false
    for (let attempt = 0; attempt < 6; attempt++) {
```

在 403/410 那一行**之后**、`res.status === 200 && size > 0` 那一行**之前**插入：

```ts
      // 404 与 403/410 走同一条换链路径，但**不保留 size**：换回来的新链接可能
      // 指向另一份文件，拿旧的 .part 续传会拼出一个坏文件。只换一次——第二次
      // 仍 404 就是平台的事实，再换五次也是同一个答案。
      if (res.status === 404) {
        if (renewedFor404) return { status: 'failed', error: 'http 404', permanent: true }
        renewedFor404 = true
        await deps.storage.discardPart(task.relPath)
        link = await deps.gw.getDownloadUrl(task.assetId)
        continue
      }
```

（`size` 不必手动清零：循环顶部每一轮都重新 `await deps.storage.writtenSize(task.relPath)`。）

- [ ] **Step 4: 跑下载器测试，确认全绿**

Run: `bun test packages/engine/tests/downloader/index.test.ts`
Expected: PASS（含原有 7 条）。

- [ ] **Step 5: 写执行器用例（先红）**

追加到 `packages/engine/tests/executor/index.test.ts` 末尾：

```ts
// ---------------------------------------------------------------------------
// 「平台没有这个文件」不是失败，是一个确定的答案。
//
// 走退避 → dead 的代价不是多试五次，是**留下一条永远处理不掉的失败项**：dead 是
// 终态，`recordDeadAssets` 每轮把它重记一遍，运维在「失败项 · 需要处理」上看到的
// 是一件永远没人能修好的事。skipped 是「确认取不到」，清单里写得明明白白，
// 而且不计入归档判定（completed 数 > archived 数），不再拖住会议的「已归档」。
// ---------------------------------------------------------------------------
test('下载器报 permanent：转 skipped(upstream_missing)，不进 failed 也不进 dead', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', fileType: 'mp4' }, 1)
  const deps: any = {
    store,
    download: async () => ({ status: 'failed' as const, error: 'http 404', permanent: true }),
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]),
  }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r).toEqual({ completed: 0, failed: 0, skipped: 1 })

  const row = (await store.assetsForMeeting('m1', ''))[0]!
  expect(row.status).toBe('skipped')
  expect(row.last_error).toBe('upstream_missing')
  expect(row.lease_expires_at).toBeNull()
  expect(row.attempts).toBe(1)                              // 第一次就定案，没有五次退避
  expect(await store.claimNext(99_999, 300)).toBeNull()      // 队列下一轮也不会再领它
})

test('permanent 只对带这个标记的结果生效：普通 failed 照旧走退避', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', fileType: 'mp4' }, 1)
  const deps: any = {
    store,
    download: async () => ({ status: 'failed' as const, error: 'http 500' }),
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]]),
  }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r.failed).toBe(1)
  expect((await store.assetsForMeeting('m1', ''))[0]!.status).toBe('failed')
})
```

- [ ] **Step 6: 跑它，确认红**

Run: `bun test packages/engine/tests/executor/index.test.ts`
Expected: 第一条 FAIL——实际 `{ completed: 0, failed: 1, skipped: 0 }`，行是 `failed`。

- [ ] **Step 7: 改执行器**

`packages/engine/src/executor/index.ts` 的 `handleOne`，在 `markCompleted` 那一行与 `row.attempts >= MAX_ATTEMPTS` 那一行**之间**插入一行（**这个任务只改这里**）：

```ts
  if (res.status === 'completed') { await deps.store.markCompleted(row.id, res.contentHash, res.bytesWritten, now()); result.completed++; return }
  // 平台确认没有这个文件（下载器换过一条新链仍 404）：重试是在等一个不会到来的
  // 修复，而五次之后那条 dead 行会永远挂在「失败项 · 需要处理」上。skipped 是
  // 「确认取不到」，清单里说得出为什么，也不计入归档判定。
  if (res.permanent === true) { await deps.store.markSkipped(row.id, 'upstream_missing', now()); result.skipped++; return }
  if (row.attempts >= MAX_ATTEMPTS) { await deps.store.markDead(row.id, res.error, now()); result.failed++; return }
```

- [ ] **Step 8: 跑引擎全套**

Run: `bun test packages/engine/tests/executor/index.test.ts packages/engine/tests/downloader/index.test.ts`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add packages/engine/src/downloader/index.ts packages/engine/src/executor/index.ts \
        packages/engine/tests/downloader/index.test.ts packages/engine/tests/executor/index.test.ts
git commit -m "fix(engine): 下载 404 换一次链仍 404 就判平台永久缺失，转 skipped 不再堆 dead"
```

---

## Task 2：`job_failures.detail` 一路贯通到控制台契约

**Files:**
- Create: `migrations/014_job_failures_detail.sql`
- Modify: `src/store/jobs.ts`（`JobFailureRecord` / `RecordFailureInput` / `FailureSqlRow` / `FAILURE_COLS` / `mapFailure` / `recordFailure`）
- Modify: `src/http/handlers/console/jobs.ts`（`failureView`）
- Modify: `console/src/api/admin/jobs.ts`（`JobFailure` / `readFailure`）
- Modify: `console/src/api/mock/jobs.ts`（`failure()`）
- Test: `tests/store/jobs.test.ts`、`tests/http/console-jobs.test.ts`、`console/tests/api/jobs.test.ts`

**Interfaces:**
- Produces：
  - `JobFailureRecord.detail: string | null`（读侧）
  - `RecordFailureInput.detail?: string | null`（写侧，不给 = `null`）
  - `GET /api/v1/admin/jobs` 的 `failures[].detail: string | null`
  - 控制台 `JobFailure.detail: string | null`
- Consumes：无（本任务不产生新调用方，Task 3 才往 `detail` 里写东西）。

- [ ] **Step 1: 写 store 层用例（先红）**

追加到 `tests/store/jobs.test.ts` 末尾（文件里已有 `withStore` 辅助）：

```ts
// `reason` 从此只放人话，原始技术信息进 `detail`（规格 §2.4）。两列分开的理由：
// 归并键是「任务 + 原因 + 影响」，原始报错里带着路径和 remote_id，塞进 reason
// 会让 23 场同一件事的会议变成 23 个不同的组。
test('detail 与 reason 分开往返；不给 detail 时是 null，不是空串', async () => {
  await withStore(async (store) => {
    await store.recordFailure({
      jobName: 'fetch_recordings', target: 'm-1|', targetLabel: '', meetingId: 'm-1', subMeetingId: '',
      reason: '录像：腾讯那边没有这个文件', detail: 'video/r-1/mp4: http 404',
      impact: '影响', maxAttempts: 5, attempts: 5, now: 1000,
    })
    await store.recordFailure({
      jobName: 'archive_nas', target: 'm-2|', targetLabel: '', meetingId: 'm-2', subMeetingId: '',
      reason: 'NAS 写入超时', impact: '影响', maxAttempts: 5, now: 1000,
    })
    const fs = await store.listFailures()
    expect(fs.find((f) => f.target === 'm-1|')!.detail).toBe('video/r-1/mp4: http 404')
    // 「这条失败项没有技术明细」用 null 表达，空串读起来像一次组装失败
    expect(fs.find((f) => f.target === 'm-2|')!.detail).toBeNull()
  })
})

test('同一个 target 再失败一次：detail 被后一次覆盖（它说的是"最近这一次"）', async () => {
  await withStore(async (store) => {
    const base = {
      jobName: 'fetch_recordings', target: 'm-1|', targetLabel: '', meetingId: 'm-1', subMeetingId: '',
      reason: '录像：下载失败', impact: '影响', maxAttempts: 5, attempts: 5,
    }
    await store.recordFailure({ ...base, detail: 'video/r-1/mp4: http 500', now: 1000 })
    await store.recordFailure({ ...base, detail: 'video/r-1/mp4: http 404', now: 2000 })
    const fs = await store.listFailures()
    expect(fs).toHaveLength(1)
    expect(fs[0]!.detail).toBe('video/r-1/mp4: http 404')
  })
})
```

- [ ] **Step 2: 跑它，确认红**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/store/jobs.test.ts`
Expected: FAIL——TypeScript 报 `detail` 不在 `RecordFailureInput` 上。

- [ ] **Step 3: 写迁移**

新建 `migrations/014_job_failures_detail.sql`：

```sql
-- job_failures 加一列 detail：原始技术信息（错误原文、资产 id、路径），
-- 从此 reason 那一列只放人话。
--
-- 规格：docs/superpowers/specs/2026-09-09-jobs-failures-actions-design.md 第 2.4 节
-- 写侧：src/worker/failure-text.ts 的 deadAssetsDetail，经 scheduler 的 recordDeadAssets
-- 读侧：GET /api/v1/admin/jobs 的 failures[].detail，控制台失败项表的「技术详情」
--
-- ## 为什么非得分成两列
--
-- 失败项表按「任务 + 原因 + 影响」归并（console/src/pages/Jobs/view.ts 的
-- groupFailures），判据是三段文字**逐字相同**。原始报错里带着 remote_id 与
-- 本地路径，每一条都不一样——把它留在 reason 里，一轮拉取里 23 场会议的
-- 同一件事就是 23 个组，整页要滚三屏才见底。而那些信息又不能扔：运维判断
-- 「该去查什么」靠的就是它。所以分列，不是二选一。
--
-- 可空是它的语义本身：归档任务那种失败项本来就只有一句人话，没有技术明细。
-- NULL = 没有明细，读侧据此不画「技术详情」那个折叠。
--
-- ## 迁移的两条硬约束（src/store/db.ts 的 runMigrations）
--
-- 1. 按分号朴素切分语句，所以除语句结束符外本文件不许出现分号，注释里尤其不行
-- 2. 每次启动都重跑。ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
--    必须走 information_schema 守卫 + PREPARE/EXECUTE（写法照抄 011）

SET @mig014_has_detail := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'job_failures'
     AND COLUMN_NAME = 'detail'
);

SET @mig014_sql := IF(@mig014_has_detail = 0,
  'ALTER TABLE job_failures ADD COLUMN detail TEXT NULL',
  'DO 0');

PREPARE mig014a FROM @mig014_sql;
EXECUTE mig014a;
DEALLOCATE PREPARE mig014a;
```

- [ ] **Step 4: 改 `src/store/jobs.ts`**

四处，逐处照抄：

1) `JobFailureRecord`，在 `impact` 之后加：
```ts
  impact: string
  /**
   * 原始技术信息（错误原文、资产 id、文件格式）。**没有明细就是 null**——
   * 归档那种失败项本来只有一句人话。`reason` 从此只放人话，理由见 migrations/014。
   */
  detail: string | null
```

2) `RecordFailureInput`，在 `impact` 之后加：
```ts
  impact: string
  /** 原始技术信息。不给 = 这条失败项没有明细（写进库里是 NULL，不是空串） */
  detail?: string | null
```

3) `FailureSqlRow` 加 `detail: string | null`；`FAILURE_COLS` 加上它：
```ts
const FAILURE_COLS = `id, job_name, target, target_label, meeting_id, sub_meeting_id,
                      reason, impact, detail, attempts, max_attempts, first_failed_at,
                      last_failed_at, resolved_at`
```
`mapFailure` 里 `impact: r.impact,` 之后加 `detail: r.detail,`。

4) `recordFailure` 的 SQL 与参数（注意 `ON DUPLICATE KEY UPDATE` 里那三行引用 `resolved_at` 的赋值仍必须排在把它清空的那一行之前）：
```ts
      await pool.query(
        `INSERT INTO job_failures
           (job_name, target, target_label, meeting_id, sub_meeting_id, reason, impact, detail,
            attempts, max_attempts, first_failed_at, last_failed_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, ?, ?, NULL) AS new
         ON DUPLICATE KEY UPDATE
           target_label = new.target_label,
           meeting_id = new.meeting_id,
           sub_meeting_id = new.sub_meeting_id,
           reason = new.reason,
           impact = new.impact,
           detail = new.detail,
           max_attempts = new.max_attempts,
           attempts = COALESCE(?, IF(job_failures.resolved_at IS NULL, job_failures.attempts + 1, 1)),
           first_failed_at =
             IF(job_failures.resolved_at IS NULL, job_failures.first_failed_at, new.first_failed_at),
           last_failed_at = new.last_failed_at,
           resolved_at = NULL`,
        [
          i.jobName,
          i.target,
          i.targetLabel,
          i.meetingId,
          i.subMeetingId,
          i.reason,
          i.impact,
          // undefined 会让 mysql2 的占位符直接抛，而「不给明细」是合法调用
          i.detail ?? null,
          i.attempts ?? null,
          i.maxAttempts,
          i.now,
          i.now,
          // UPDATE 分支里那个 COALESCE 的参数——同一个值绑第二次
          i.attempts ?? null,
        ],
      )
```

- [ ] **Step 5: 跑 store 测试，确认绿**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/store/jobs.test.ts`
Expected: PASS。

- [ ] **Step 6: 写 handler 与控制台契约的用例（先红）**

`tests/http/console-jobs.test.ts`：`failure()` 工厂里 `resolvedAt: null,` 之前加一行 `detail: null,`；`JobsBody` 的 `failures` 元素类型里加 `detail: string | null`；追加一条用例：

```ts
test('失败项带 detail 下发（没有明细就是 null，不是空串）', async () => {
  const { ctx } = fakeCtx({
    failures: [
      failure({ id: 1, detail: 'video/r-1/mp4: http 404' }),
      failure({ id: 2, detail: null }),
    ],
  })
  const body = (await (await listJobs(req('/api/v1/admin/jobs'), ctx)).json()) as JobsBody
  expect(body.failures[0]!.detail).toBe('video/r-1/mp4: http 404')
  expect(body.failures[1]!.detail).toBeNull()
})
```

`console/tests/api/jobs.test.ts`：它的 `failure()` 工厂里 `lastFailedAt` 之后加一行
`detail: null,`（默认没有明细，与归档那种失败项一致），然后在 `describe('fetchJobs()', …)`
里追加一条（`stubFetch` / `payload` / `failure` 都是该文件已有的辅助）：

```ts
  test('失败项的 detail 读出来；没有明细读成 null，不是空串', async () => {
    stubFetch(payload({
      failuresTotal: 2,
      failures: [
        failure({ id: 1, detail: 'video/r-1/mp4: http 404' }),
        failure({ id: 2 }),
      ],
    }))
    const o = await fetchJobs()
    expect(o.failures[0]!.detail).toBe('video/r-1/mp4: http 404')
    expect(o.failures[1]!.detail).toBeNull()
  })

  test('detail 这个键整个缺失时报形状错——它是契约里的必有字段，不静默补 null', async () => {
    const f = failure()
    delete (f as Record<string, unknown>).detail
    stubFetch(payload({ failures: [f] }))
    await expect(fetchJobs()).rejects.toBeInstanceOf(ApiShapeError)
  })
```

- [ ] **Step 7: 跑它们，确认红**

Run: `bun test tests/http/console-jobs.test.ts` 与 `cd console && bunx vitest run tests/api/jobs.test.ts`
Expected: FAIL（`detail` 未下发 / 未读出）。

- [ ] **Step 8: 改 handler 与控制台契约**

`src/http/handlers/console/jobs.ts` 的 `failureView`，在 `impact` 之后加：
```ts
    impact: f.impact,
    /**
     * 原始技术信息。`reason` 是人话、这一列是原文，控制台里它是一个默认收起的
     * 「技术详情」折叠——归并键（任务 + 原因 + 影响）不含它，所以 23 场同样
     * 404 的会议仍然归成一组，而每一场自己的 remote_id 一个都没丢。
     */
    detail: f.detail,
```

`console/src/api/admin/jobs.ts`：`JobFailure` 里 `impact` 之后加
```ts
  /** 原始技术信息（错误原文 / 资产 id / 格式）。**没有明细就是 null**，界面据此不画折叠 */
  detail: string | null
```
`readFailure` 里 `impact` 之后加 `detail: r.strOrNull(o, 'detail', where),`。

`console/src/api/mock/jobs.ts`：`failure()` 的入参对象加 `detail?: string | null`，返回对象里 `impact: o.impact,` 之后加 `detail: o.detail ?? null,`；并给种子里 `archive_nas` 那批失败项各补一句明细：
```ts
        reason: 'NAS 写入失败：目标目录不可写（errno 30, EROFS）。',
        detail: `nas write /nas/meetings/${m.id}: EROFS: read-only file system`,
```
整轮那一条（`target: '__round__'`）保持 `detail` 不给（它没有技术明细）。

- [ ] **Step 9: 跑全部相关测试**

Run:
```
TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/store/jobs.test.ts tests/http/console-jobs.test.ts
cd console && bunx vitest run tests/api/jobs.test.ts tests/mock.test.ts && bunx tsc --noEmit
```
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add migrations/014_job_failures_detail.sql src/store/jobs.ts src/http/handlers/console/jobs.ts \
        console/src/api/admin/jobs.ts console/src/api/mock/jobs.ts \
        tests/store/jobs.test.ts tests/http/console-jobs.test.ts console/tests/api/jobs.test.ts
git commit -m "feat(jobs): job_failures 加 detail 列，原始报错与人话原因分开下发"
```

---

## Task 3：`failure-text.ts`——原因用人话，原始报错进 detail

**Files:**
- Create: `src/worker/failure-text.ts`
- Create: `tests/worker/failure-text.test.ts`
- Modify: `src/worker/store-mysql.ts`（`DeadAsset` 加两个字段、`deadAssets()` 多取两列。**不要碰 `meetingsForPaths`**）
- Modify: `src/worker/scheduler.ts`（`JobFailInput.detail`、`ctx.fail` 透传、`recordDeadAssets`）
- Test: `tests/worker/scheduler.test.ts`、`tests/worker/store-mysql.test.ts`

**Interfaces:**
- Consumes：`JobsStore.recordFailure({ …, detail })`（Task 2 产出）；`ASSET_LABEL`（`src/domain/asset-labels.ts`）；`GATEWAY_TYPE_TO_ASSET_KEY`（`@yaowu/mde-engine`）。
- Produces：
  ```ts
  export interface FailingAsset {
    assetType: string        // 网关的 asset_type（video / meeting_summary / ai_minutes …）
    remoteId: string
    fileType: string | null
    lastError: string | null
  }
  export function describeDownloadError(lastError: string | null): string
  export function assetTypeLabel(assetType: string): string
  export function deadAssetsReason(assets: readonly FailingAsset[]): string
  export function deadAssetsDetail(assets: readonly FailingAsset[]): string
  ```
  `DeadAsset`（`src/worker/store-mysql.ts`）多两个字段 `remoteId: string` / `fileType: string | null`，因此它结构上满足 `FailingAsset`。
  `JobFailInput` 多一个 `detail?: string | null`。

- [ ] **Step 1: 写 `failure-text` 的用例（先红）**

新建 `tests/worker/failure-text.test.ts`：

```ts
import { expect, test } from 'bun:test'
import {
  assetTypeLabel,
  deadAssetsDetail,
  deadAssetsReason,
  describeDownloadError,
} from '../../src/worker/failure-text'

/**
 * 失败项的 `reason` 那一列是给**运维**看的第一眼。它从前是原始报错直接拼的：
 *
 *   下载重试用尽，已放弃：video（ENOENT: no such file or directory, open
 *   '/Users/…/transcript_3.txt.part'）
 *
 * 三个毛病：一句英文 errno 说不出「该找谁」；路径还是改名前的旧路径（误导）；
 * 每一条的路径都不一样，于是归并键（任务 + 原因 + 影响）失效，23 场同一件事
 * 变成 23 行。这个模块把它翻成一句人话，原文进 `detail`。
 */

test('404 = 平台没有这个文件——它不是"我们这边出了错"', () => {
  expect(describeDownloadError('http 404')).toBe('腾讯那边没有这个文件')
})

test('5xx 与换链换到头都是上游的下载服务出错', () => {
  expect(describeDownloadError('http 500')).toBe('腾讯下载服务出错')
  expect(describeDownloadError('http 503')).toBe('腾讯下载服务出错')
  expect(describeDownloadError('too many link renewals')).toBe('腾讯下载服务出错')
})

test('本地文件系统的三个 errno 归成一句：该去看盘和权限', () => {
  expect(describeDownloadError("ENOENT: no such file or directory, open '/x/y.part'")).toBe('本地写入失败')
  expect(describeDownloadError('EACCES: permission denied')).toBe('本地写入失败')
  expect(describeDownloadError('ENOSPC: no space left on device')).toBe('本地写入失败')
})

test('字节数对不上是"下载不完整"，不是"下载失败"——那是两种处理', () => {
  expect(describeDownloadError('size mismatch: 100 != 200')).toBe('下载不完整')
})

test('认不出的错与没有错误信息都回一句最弱的话，不编一个原因', () => {
  expect(describeDownloadError('connect ETIMEDOUT 10.0.0.1:443')).toBe('下载失败')
  expect(describeDownloadError(null)).toBe('下载失败')
  expect(describeDownloadError('')).toBe('下载失败')
})

// 404 那条要排在 5xx 之前判：`http 404` 不以 `http 5` 开头，两条不会打架，
// 但顺序写反时 `http 500` 会被 startsWith('http 4') 之类的手滑写法捞走。
test('判定顺序：含 ENOENT 的 404 仍然算「腾讯那边没有这个文件」', () => {
  expect(describeDownloadError('http 404')).toBe('腾讯那边没有这个文件')
})

test('资产名用全项目那一份中文；认不出的类型原样带出，不映成任何一个已知的', () => {
  expect(assetTypeLabel('video')).toBe('录像')
  expect(assetTypeLabel('meeting_summary')).toBe('逐字稿')
  expect(assetTypeLabel('ai_minutes')).toBe('纪要')
  expect(assetTypeLabel('chapters')).toBe('时间轴')
  expect(assetTypeLabel('brand_new_thing')).toBe('brand_new_thing')
})

test('一场会议一句话：<中文资产名>：<人话>，用「；」连接', () => {
  const reason = deadAssetsReason([
    { assetType: 'video', remoteId: 'r1', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'meeting_summary', remoteId: 'r2', fileType: 'txt', lastError: 'ENOENT: open x' },
  ])
  expect(reason).toBe('录像：腾讯那边没有这个文件；逐字稿：本地写入失败')
})

// 归并是这句话存在的全部理由：同一场会议的三段录像同样 404 时，写三遍
// 「录像：腾讯那边没有这个文件」既没多说什么，又把这一行撑长。
test('同类同因的多条压成一句', () => {
  const reason = deadAssetsReason([
    { assetType: 'video', remoteId: 'r1', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'video', remoteId: 'r2', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'video', remoteId: 'r3', fileType: 'mp4', lastError: 'http 404' },
  ])
  expect(reason).toBe('录像：腾讯那边没有这个文件')
})

// 但**同类不同因**必须两句都在：一段录像 404、另一段磁盘满，是两件事、两种处置。
test('同类不同因不压：两句都在', () => {
  const reason = deadAssetsReason([
    { assetType: 'video', remoteId: 'r1', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'video', remoteId: 'r2', fileType: 'mp4', lastError: 'ENOSPC' },
  ])
  expect(reason).toBe('录像：腾讯那边没有这个文件；录像：本地写入失败')
})

test('detail 一条一行，带资产类型 / remote_id / 格式与错误原文', () => {
  const detail = deadAssetsDetail([
    { assetType: 'video', remoteId: 'r1', fileType: 'mp4', lastError: 'http 404' },
    { assetType: 'meeting_summary', remoteId: 'r2', fileType: null, lastError: null },
  ])
  expect(detail).toBe('video/r1/mp4: http 404\nmeeting_summary/r2/: 无错误信息')
})
```

- [ ] **Step 2: 跑它，确认红**

Run: `bun test tests/worker/failure-text.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 写 `src/worker/failure-text.ts`**

```ts
/**
 * 失败项那一句话的措辞（规格 2026-09-09 §2.4）。**纯函数，不碰库、不碰网络。**
 *
 * ## 为什么原始报错不能直接当 reason
 *
 * 2026-09-09 本机实测，`job_failures.reason` 里躺着的是这种东西：
 *
 *   下载重试用尽，已放弃：video（ENOENT: no such file or directory,
 *   open '/Users/…/2026-09-01_会议主题/transcript_3.txt.part'）
 *
 * 三个毛病，每一个单独都够格重写这一句：
 *
 * 1. **说不出该找谁**。`ENOENT` 是本地盘的事，`http 404` 是腾讯那边根本没有
 *    这个文件——前者要人去看磁盘，后者一辈子都修不好。原文把这两件事写成
 *    一样长的一串英文
 * 2. **路径是改名之前的旧路径**，指向一个已经不存在的目录。一句会误导人的明细
 *    比没有明细更糟
 * 3. **它把归并打散了**。失败项表按「任务 + 原因 + 影响」归并（控制台的
 *    `groupFailures`），判据是三段文字逐字相同。原文里带着 remote_id 和路径，
 *    每条都不一样，于是一轮拉取里 23 场同一件事的会议就是 23 行
 *
 * 所以拆成两列：`reason` 一句人话（进归并键），`detail` 原文（不进归并键，
 * 界面上是一个默认收起的「技术详情」）。信息一点没少，只是各归各位。
 *
 * ## 为什么在 worker 侧而不是 domain 侧
 *
 * 它的唯一调用方是调度器任务一的 `recordDeadAssets`，输入是
 * `meeting_assets.last_error` ——一列只有 worker 会写的字段。放进 `src/domain/`
 * 会让人以为网关那一侧也该用它，而网关拿不到那一列。
 */
import { GATEWAY_TYPE_TO_ASSET_KEY } from '@yaowu/mde-engine'
import { ASSET_LABEL } from '../domain/asset-labels'

/** 一条放弃掉的资产，只带拼这两句话用得上的四个字段。`DeadAsset` 结构上满足它 */
export interface FailingAsset {
  /** 网关的 `asset_type`（video / meeting_summary / ai_minutes …），不是客户端的 AssetKey */
  assetType: string
  remoteId: string
  fileType: string | null
  lastError: string | null
}

/**
 * 把 `meeting_assets.last_error` 翻成一句人话。
 *
 * 判据是**前缀 / 包含**，不是精确匹配：错误原文里带着可变的路径、字节数、主机名。
 * 顺序即优先级，认不出的一律落到最弱的那句——**不编一个原因**。
 */
export function describeDownloadError(lastError: string | null): string {
  if (lastError === null) return '下载失败'
  if (lastError.startsWith('http 404')) return '腾讯那边没有这个文件'
  if (lastError.startsWith('http 5') || lastError.startsWith('too many link renewals')) {
    return '腾讯下载服务出错'
  }
  if (lastError.includes('ENOENT') || lastError.includes('EACCES') || lastError.includes('ENOSPC')) {
    return '本地写入失败'
  }
  if (lastError.startsWith('size mismatch')) return '下载不完整'
  return '下载失败'
}

/**
 * 网关 `asset_type` 的中文名。表在 `src/domain/asset-labels.ts`——**全项目唯一一份**，
 * 这里不另起一套叫法。认不出的类型原样带出：映成某个已知资产名是在编造，
 * 而一个英文原值在界面上是一个看得见的提醒。
 */
export function assetTypeLabel(assetType: string): string {
  const key = GATEWAY_TYPE_TO_ASSET_KEY[assetType]
  return key === undefined ? assetType : ASSET_LABEL[key]
}

/**
 * 一场会议的失败原因：`<中文资产名>：<人话>`，用「；」连接。
 *
 * 去重的键是**整句**（类型 + 人话），不是只看类型：同一场会议的三段录像同样
 * 404 时压成一句（写三遍没多说什么），但一段 404、另一段磁盘满时两句都要在
 * ——那是两件事、两种处置。
 */
export function deadAssetsReason(assets: readonly FailingAsset[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const a of assets) {
    const line = `${assetTypeLabel(a.assetType)}：${describeDownloadError(a.lastError)}`
    if (seen.has(line)) continue
    seen.add(line)
    parts.push(line)
  }
  return parts.join('；')
}

/**
 * 原始技术信息，一条资产一行：`<asset_type>/<remote_id>/<file_type>: <lastError>`。
 *
 * **不去重**：这里要的就是「到底是哪几条资产」，去重会把 remote_id 这个唯一能
 * 让人回库里找到那一行的东西弄丢。
 */
export function deadAssetsDetail(assets: readonly FailingAsset[]): string {
  return assets
    .map((a) => `${a.assetType}/${a.remoteId}/${a.fileType ?? ''}: ${a.lastError ?? '无错误信息'}`)
    .join('\n')
}
```

- [ ] **Step 4: 跑它，确认绿**

Run: `bun test tests/worker/failure-text.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 `deadAssets()` 与调度器的用例（先红）**

`tests/worker/store-mysql.test.ts`：把 `deadAssets 给此刻全部 dead 的行…` 那条用例里对返回形状的断言补上两列（照抄它现有的建行方式），并在同一 `describe` 里追加：

```ts
  test('deadAssets 带回 remote_id 与 file_type——失败项的技术明细要靠它们定位到行', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r-9', fileType: 'mp4' }, 100)
      const row = (await s.claimNext(200, 60))!
      await s.markDead(row.id, 'http 404', 300)
      expect(await s.deadAssets()).toEqual([
        { meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r-9', fileType: 'mp4', lastError: 'http 404', attempts: 1 },
      ])
    })
  })
```

`tests/worker/scheduler.test.ts`：现有那条 `任务一：dead 资产的失败项是资产状态的镜像…` 里的三个 fixture 要补 `remoteId` / `fileType`，且对 `reason` 的两条断言改成人话。逐条替换：

```ts
  const video = { meetingId: 'm-1', subMeetingId: '', assetType: 'video', remoteId: 'rv', fileType: 'mp4', lastError: 'http 404', attempts: 5 }
  const summary = { meetingId: 'm-1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'rs', fileType: 'txt', lastError: 'ENOENT: open /x/y.part', attempts: 5 }
  const other = { meetingId: 'm-2', subMeetingId: 's-1', assetType: 'video', remoteId: 'ro', fileType: 'mp4', lastError: 'ENOSPC: no space left on device', attempts: 5 }
```
```ts
    // reason 是人话，且**不含原始报错**——原文在 detail 里，那是为了让归并键
    // （任务 + 原因 + 影响）对 23 场同一件事的会议真的相同
    expect(m1.reason).toBe('录像：腾讯那边没有这个文件；逐字稿：本地写入失败')
    expect(m1.reason).not.toContain('ENOENT')
    // 原文一个字没丢，只是挪了个位置
    expect(m1.detail).toContain('video/rv/mp4: http 404')
    expect(m1.detail).toContain('meeting_summary/rs/txt: ENOENT: open /x/y.part')
```

- [ ] **Step 6: 跑它们，确认红**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/worker/store-mysql.test.ts tests/worker/scheduler.test.ts`
Expected: FAIL（`deadAssets` 少两列；`reason` 还是老拼法；`detail` 是 null）。

- [ ] **Step 7: 改 `src/worker/store-mysql.ts`**

`DeadAsset` 里 `assetType` 之后加两个字段：
```ts
  assetType: string
  /** 平台侧的记录 id 与文件格式。失败项的技术明细靠这两个才能回库里定位到具体那一行 */
  remoteId: string
  fileType: string | null
  lastError: string | null
```
`deadAssets()` 的 SQL 与映射（**只改这个方法**）：
```ts
    async deadAssets() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, asset_type, remote_id, file_type, last_error, attempts
           FROM meeting_assets WHERE status='dead' ORDER BY id`,
      )
      return rows.map((r) => ({
        meetingId: r.meeting_id as string,
        subMeetingId: r.sub_meeting_id as string,
        assetType: r.asset_type as string,
        remoteId: r.remote_id as string,
        // 列是 NOT NULL DEFAULT ''，但读侧照样按可空处理：空串与 NULL 在
        // 「这条资产是什么格式」上是同一个答案（不知道），拼明细时都落成空
        fileType: (r.file_type ?? null) as string | null,
        lastError: (r.last_error ?? null) as string | null,
        attempts: Number(r.attempts),
      }))
    },
```
（顺带把它上方那句注释里的「只取四列」改成「只取这几列」。）

- [ ] **Step 8: 改 `src/worker/scheduler.ts`**

1) 顶部 import 里加：
```ts
import { deadAssetsDetail, deadAssetsReason } from './failure-text'
```

2) `JobFailInput` 里 `reason` 之后加：
```ts
  reason: string
  /** 原始技术信息。不给 = 这条失败项只有一句人话（归档那种本来就是） */
  detail?: string | null
```

3) `launch()` 里 `ctx.fail` 的 `reason: input.reason,` 之后加：
```ts
          reason: input.reason,
          detail: input.detail ?? null,
```

4) `recordDeadAssets` 里那个 `ctx.fail({...})` 的 `reason` 整块换掉：
```ts
      // 一句人话进 reason（它是归并键的一段：23 场同样 404 的会议必须归成一组），
      // 原始报错整份进 detail。翻译口径在 ./failure-text.ts，那里写着为什么不能
      // 把 `ENOENT: … '/Users/…/transcript_3.txt.part'` 直接当 reason 用。
      reason: deadAssetsReason(assets),
      detail: deadAssetsDetail(assets),
```
（`ctx.fail` 上方那段「资产类型与最后一次的错各自带着」的注释一并换成上面这段，别留两句互相矛盾的说明。）

- [ ] **Step 9: 跑 worker 全套**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/worker/failure-text.test.ts tests/worker/store-mysql.test.ts tests/worker/scheduler.test.ts`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add src/worker/failure-text.ts src/worker/store-mysql.ts src/worker/scheduler.ts \
        tests/worker/failure-text.test.ts tests/worker/store-mysql.test.ts tests/worker/scheduler.test.ts
git commit -m "feat(jobs): dead 资产的失败原因改写成人话，原始报错落进 detail"
```

---

## Task 4：两个 Store 方法 + 两个动作端点

**Files:**
- Modify: `packages/engine/src/store/index.ts`（`Store` 接口 + SQLite 实现）
- Modify: `src/worker/store-mysql.ts`（MySQL 实现。**仍然不许碰 `meetingsForPaths`**）
- Modify: `src/store/jobs.ts`（`JOB_FETCH_RECORDINGS`、`listFailuresById`、`resolveFailuresByIds`）
- Modify: `src/http/handlers/console/jobs.ts`（`JobsDeps.assets`、两个 handler）
- Modify: `src/http/router.ts`、`src/index.ts`
- Modify: `src/audit/actions.ts`
- Test: `packages/engine/tests/store/index.test.ts`、`tests/worker/store-mysql.test.ts`、`tests/store/jobs.test.ts`、`tests/audit/actions.test.ts`
- Create: `tests/http/console-jobs-failures.test.ts`

**Interfaces:**
- Produces：
  ```ts
  // packages/engine/src/store/index.ts
  export interface MeetingAssetsKey { meetingId: string; subMeetingId: string }
  // Store 接口新增：
  retryMeetingAssets(k: MeetingAssetsKey, now: number): Promise<number>
  ignoreDeadAssets(k: MeetingAssetsKey, now: number): Promise<number>

  // src/store/jobs.ts 新增：
  export const JOB_FETCH_RECORDINGS: JobName
  // JobsStore 接口新增：
  listFailuresById(ids: readonly number[]): Promise<JobFailureRecord[]>
  resolveFailuresByIds(ids: readonly number[], now: number): Promise<number>

  // src/http/handlers/console/jobs.ts 新增导出：
  export async function retryFailures(req: Request, ctx: RouteCtx): Promise<Response>
  export async function ignoreFailures(req: Request, ctx: RouteCtx): Promise<Response>
  // JobsDeps 新增：
  assets: Pick<Store, 'retryMeetingAssets' | 'ignoreDeadAssets'>

  // src/audit/actions.ts 新增：
  AUDIT_ACTION.jobFailureRetry === 'job_failure_retry'
  AUDIT_ACTION.jobFailureIgnore === 'job_failure_ignore'
  ```
- Consumes：Task 2 的 `JobFailureRecord`（含 `detail`、`resolvedAt`）；`requireAdminWrite`、`readJson`、`json`、`buildAuditDetail`（都已存在）。

- [ ] **Step 1: 写两个宿主的 Store 用例（先红）**

`packages/engine/tests/store/index.test.ts` 末尾追加：

```ts
// ── 失败项动作要用的两个写法（规格 2026-09-09 §2.3）──────────────────
//
// 与 `resetFailed` 的分工要分清：那个是**整库**的人工逃生口（CLI 的 mde retry），
// 而且刻意不清 attempts。这两个是**一场会议**的，由控制台上的一次点击驱动，
// 所以 retry 必须清 attempts——不清的话一条 attempts 已经到 5 的行被打回来
// 之后只剩一次机会，第一次失败就又是 dead，界面上表现为「点了重试没有用」。

test('retryMeetingAssets 只动这一场的 failed/dead，清零 attempts 与那个"最早可再领取时间"', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertMeeting({ ...M, meetingId: 'm2' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', remoteId: 'r2' }, 1)
  await s.upsertAsset({ meetingId: 'm2', subMeetingId: '', assetType: 'video', remoteId: 'r3' }, 1)
  const a1 = (await s.claimNext(100, 300))!      // m1/video
  const a2 = (await s.claimNext(100, 300))!      // m1/audio
  const b1 = (await s.claimNext(100, 300))!      // m2/video
  await s.markDead(a1.id, 'http 404', 110)
  await s.markFailed(a2.id, 'boom', 110, 9_999_999)
  await s.markDead(b1.id, 'http 404', 110)

  expect(await s.retryMeetingAssets({ meetingId: 'm1', subMeetingId: '' }, 200)).toBe(2)

  const m1rows = await s.assetsForMeeting('m1', '')
  for (const r of m1rows) {
    expect(r.status).toBe('pending')
    expect(r.attempts).toBe(0)                   // 清零：不清的话回队列只剩一次机会
    expect(r.last_error).toBeNull()
    expect(r.lease_expires_at).toBeNull()
  }
  // 别的会议一个字都没动
  expect((await s.assetsForMeeting('m2', ''))[0]!.status).toBe('dead')
})

test('retryMeetingAssets 不碰 completed / skipped / running', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', remoteId: 'r2' }, 1)
  const a1 = (await s.claimNext(100, 300))!
  const a2 = (await s.claimNext(100, 300))!
  await s.markCompleted(a1.id, null, 10, 110)
  await s.markSkipped(a2.id, 'upstream_missing', 110)
  expect(await s.retryMeetingAssets({ meetingId: 'm1', subMeetingId: '' }, 200)).toBe(0)
  expect((await s.assetsForMeeting('m1', '')).map((r) => r.status).sort()).toEqual(['completed', 'skipped'])
})

test('ignoreDeadAssets 只把 dead 转 skipped(ignored_by_admin)，failed 不动', async () => {
  const s = fresh(); await s.upsertMeeting(M, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', remoteId: 'r2' }, 1)
  const a1 = (await s.claimNext(100, 300))!
  const a2 = (await s.claimNext(100, 300))!
  await s.markDead(a1.id, 'http 404', 110)
  await s.markFailed(a2.id, 'boom', 110, 9_999_999)   // 还在自动重试中，不该被"忽略"顺手关掉

  expect(await s.ignoreDeadAssets({ meetingId: 'm1', subMeetingId: '' }, 200)).toBe(1)
  const rows = await s.assetsForMeeting('m1', '')
  const dead = rows.find((r) => r.id === a1.id)!
  expect(dead.status).toBe('skipped')
  expect(dead.last_error).toBe('ignored_by_admin')
  expect(dead.lease_expires_at).toBeNull()
  expect(rows.find((r) => r.id === a2.id)!.status).toBe('failed')
})

// 周期性会议的场次不许串：两场共用 meeting_id，只按前一段筛会把另一场也打回队列
test('两个写法都按精确的 (meeting_id, sub_meeting_id) 筛，不串场次', async () => {
  const s = fresh()
  await s.upsertMeeting({ ...M, subMeetingId: 's1' }, 1)
  await s.upsertMeeting({ ...M, subMeetingId: 's2' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 's1', assetType: 'video', remoteId: 'r1' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 's2', assetType: 'video', remoteId: 'r2' }, 1)
  const x = (await s.claimNext(100, 300))!
  const y = (await s.claimNext(100, 300))!
  await s.markDead(x.id, 'e', 110)
  await s.markDead(y.id, 'e', 110)
  expect(await s.retryMeetingAssets({ meetingId: 'm1', subMeetingId: 's1' }, 200)).toBe(1)
  expect((await s.assetsForMeeting('m1', 's2'))[0]!.status).toBe('dead')
})
```

`tests/worker/store-mysql.test.ts` 的 `describe('createMysqlStore', …)` 里追加同语义的一组（MySQL 侧必须自己测，两个宿主的 SQL 是两份）：

```ts
  test('retryMeetingAssets：只动这一场的 failed/dead，attempts 清零，别的会议不动', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertMeeting({ ...M, meetingId: 'm2' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 100)
      await s.upsertAsset({ meetingId: 'm2', subMeetingId: '', assetType: 'video', remoteId: 'r3' }, 100)
      const a = (await s.claimNext(200, 60))!
      const b = (await s.claimNext(200, 60))!
      await s.markDead(a.id, 'http 404', 300)
      await s.markDead(b.id, 'http 404', 300)

      expect(await s.retryMeetingAssets({ meetingId: 'm1', subMeetingId: '' }, 400)).toBe(1)
      const back = (await s.assetsForMeeting('m1', ''))[0]!
      expect(back.status).toBe('pending')
      expect(back.attempts).toBe(0)
      expect(back.last_error).toBeNull()
      expect(back.lease_expires_at).toBeNull()
      expect((await s.assetsForMeeting('m2', ''))[0]!.status).toBe('dead')
      // 清零之后是完整的五次机会，不是「回队列再失败一次就又 dead」
      expect((await s.claimNext(500, 60))!.attempts).toBe(1)
    })
  })

  test('ignoreDeadAssets：dead → skipped(ignored_by_admin)，failed 不动', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', remoteId: 'r2' }, 100)
      const a = (await s.claimNext(200, 60))!
      const b = (await s.claimNext(200, 60))!
      await s.markDead(a.id, 'http 404', 300)
      await s.markFailed(b.id, 'boom', 300, 9_999_999)

      expect(await s.ignoreDeadAssets({ meetingId: 'm1', subMeetingId: '' }, 400)).toBe(1)
      const rows = await s.assetsForMeeting('m1', '')
      expect(rows.find((r) => r.id === a.id)!.status).toBe('skipped')
      expect(rows.find((r) => r.id === a.id)!.last_error).toBe('ignored_by_admin')
      expect(rows.find((r) => r.id === b.id)!.status).toBe('failed')
    })
  })
```

- [ ] **Step 2: 跑它们，确认红**

Run: `bun test packages/engine/tests/store/index.test.ts` 与 `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/worker/store-mysql.test.ts`
Expected: FAIL——两个方法不存在。

- [ ] **Step 3: 改引擎 Store（接口 + SQLite）**

`packages/engine/src/store/index.ts`：`ProbeKey` 那几行之后加类型：

```ts
/** 一场会议（精确到场次）。失败项动作作用在这个粒度上，不是单条资产 */
export interface MeetingAssetsKey { meetingId: string; subMeetingId: string }
```

`Store` 接口里 `resetFailed` 之后加两个方法（带注释）：

```ts
  /**
   * 把**一场会议**的 failed / dead 打回队列，返回改了几行（规格 2026-09-09 §2.3）。
   *
   * 与 `resetFailed` 的分工要分清，两者不能互相替代：
   *
   *   - `resetFailed`：**整库**、给 CLI 的 `mde retry`，且刻意**不清** attempts
   *   - 这一个：**一场会议**、由控制台失败项表上的「重试」驱动，**清零** attempts
   *
   * 清零是这条路径的必要条件，不是顺手：一条 attempts 已经到 5 的 dead 行不清零
   * 就打回队列，`claimNext` 领它时 attempts 变 6、越过 MAX_ATTEMPTS，第一次失败
   * 就直接又是 dead。界面上表现为「点了重试，过一会儿它又出现了」——而运维没有
   * 任何办法看出这是设计如此。清零之后它拿到的是完整的五次。
   *
   * 按**精确的 (meeting_id, sub_meeting_id)** 筛：周期性会议各场次共用 meeting_id，
   * 只按前一段筛会把别的场次一起打回队列。
   */
  retryMeetingAssets(k: MeetingAssetsKey, now: number): Promise<number>
  /**
   * 把**一场会议**的 dead 判成「不用管了」（`skipped` + `last_error='ignored_by_admin'`），
   * 返回改了几行。
   *
   * 只动 `dead`，不动 `failed`：failed 还在自动退避重试中（`markFailed` 写的
   * lease_expires_at 就是下次可领时间），把它一并按掉等于替队列做了一个它没做的
   * 决定。而 dead 是终态，队列从此不再碰它——「忽略」在那上面才是一个真实的动作。
   *
   * 转 `skipped` 而不是删行：`_manifest.json` 要答得出「哪些资产是确认取不到的、
   * 为什么」，`ignored_by_admin` 就是那个为什么。删掉等于把这场会议的缺口说成
   * 「不知有无」。资产不再是 dead，下一轮 `recordDeadAssets` 也不会再登记它。
   */
  ignoreDeadAssets(k: MeetingAssetsKey, now: number): Promise<number>
```

SQLite 实现（`createStore` 里 `resetFailed` 之后）：

```ts
    async retryMeetingAssets(k, now) {
      return db.query(`UPDATE assets SET status='pending', attempts=0, last_error=NULL, lease_expires_at=NULL, updated_at=?
                        WHERE meeting_id=? AND sub_meeting_id=? AND status IN ('failed','dead')`)
        .run(now, k.meetingId, k.subMeetingId).changes
    },
    async ignoreDeadAssets(k, now) {
      return db.query(`UPDATE assets SET status='skipped', last_error='ignored_by_admin', lease_expires_at=NULL, updated_at=?
                        WHERE meeting_id=? AND sub_meeting_id=? AND status='dead'`)
        .run(now, k.meetingId, k.subMeetingId).changes
    },
```

- [ ] **Step 4: 改 MySQL 宿主**

`src/worker/store-mysql.ts`，`resetFailed` 之后加（**只加这两个方法**）：

```ts
    // 与 SQLite 版逐字同义（表名不同）。**两处必须一起改**：只改一边的话
    // CLI 与服务器对同一个动作给出不同结果，而两边都不报错。
    // 语义（尤其是「为什么 retry 清零 attempts、ignore 只动 dead」）见引擎侧
    // `Store.retryMeetingAssets` / `Store.ignoreDeadAssets` 的注释。
    async retryMeetingAssets(k, now) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='pending', attempts=0, last_error=NULL, lease_expires_at=NULL, updated_at=?
          WHERE meeting_id=? AND sub_meeting_id=? AND status IN ('failed','dead')`,
        [now, k.meetingId, k.subMeetingId],
      )
      return res.affectedRows
    },
    async ignoreDeadAssets(k, now) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE meeting_assets SET status='skipped', last_error='ignored_by_admin', lease_expires_at=NULL, updated_at=?
          WHERE meeting_id=? AND sub_meeting_id=? AND status='dead'`,
        [now, k.meetingId, k.subMeetingId],
      )
      return res.affectedRows
    },
```

- [ ] **Step 5: 跑两边 Store 测试**

Run: `bun test packages/engine/tests/store/index.test.ts` 与 `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/worker/store-mysql.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交这一半**

```bash
git add packages/engine/src/store/index.ts src/worker/store-mysql.ts \
        packages/engine/tests/store/index.test.ts tests/worker/store-mysql.test.ts
git commit -m "feat(store): 两个宿主都加 retryMeetingAssets / ignoreDeadAssets"
```

- [ ] **Step 7: 写 `JobsStore` 两个新方法的用例（先红）**

`tests/store/jobs.test.ts` 末尾追加：

```ts
test('listFailuresById 按 id 取（含已恢复的），空数组不发查询直接返回空', async () => {
  await withStore(async (store) => {
    const base = { targetLabel: '', subMeetingId: '', impact: '影响', maxAttempts: 5, now: 1000 }
    await store.recordFailure({ ...base, jobName: 'fetch_recordings', target: 'm-1|', meetingId: 'm-1', reason: 'a' })
    await store.recordFailure({ ...base, jobName: 'archive_nas', target: 'm-2|', meetingId: 'm-2', reason: 'b' })
    const all = await store.listFailures()
    const ids = all.map((f) => f.id)
    expect((await store.listFailuresById(ids)).map((f) => f.id).sort()).toEqual([...ids].sort())
    expect(await store.listFailuresById([])).toEqual([])
    // 认不出的 id 就是查不到，不报错——端点据此把它们放进 skipped
    expect(await store.listFailuresById([999_999])).toEqual([])
  })
})

test('resolveFailuresByIds 只关还开着的，返回真的被关掉的行数', async () => {
  await withStore(async (store) => {
    const base = { targetLabel: '', subMeetingId: '', impact: '影响', maxAttempts: 5, now: 1000 }
    await store.recordFailure({ ...base, jobName: 'fetch_recordings', target: 'm-1|', meetingId: 'm-1', reason: 'a' })
    await store.recordFailure({ ...base, jobName: 'fetch_recordings', target: 'm-2|', meetingId: 'm-2', reason: 'b' })
    const ids = (await store.listFailures()).map((f) => f.id)

    expect(await store.resolveFailuresByIds(ids, 2000)).toBe(2)
    expect(await store.listFailures()).toEqual([])
    // 再关一次是 0，不是 2：已经恢复的不重复计，端点的 affected 才不会撒谎
    expect(await store.resolveFailuresByIds(ids, 3000)).toBe(0)
    const all = await store.listFailures({ includeResolved: true })
    expect(all.every((f) => f.resolvedAt === 2000)).toBe(true)
  })
})
```

- [ ] **Step 8: 跑它，确认红**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/store/jobs.test.ts`
Expected: FAIL——两个方法不在 `JobsStore` 上。

- [ ] **Step 9: 改 `src/store/jobs.ts`**

1) `JOB_ARCHIVE_NAS` 旁边加一个同样理由的常量：
```ts
/**
 * 拉取任务的名字，单独导出。与 `JOB_ARCHIVE_NAS` 同一个先例：它有两个跨模块的
 * 消费方——写侧是调度器任务一，读侧是失败项动作端点的「可操作」判据
 * （`job_name = 'fetch_recordings'`，规格 §2.3）。两处各写一个字面量的话，
 * 哪天任务改名，写侧照常记账、端点把每一条都判成不可操作，而界面上只会显示
 * 「按钮点了没反应」，没有任何东西报错。
 */
export const JOB_FETCH_RECORDINGS: JobName = 'fetch_recordings'
```

2) `JobsStore` 接口里 `listFailures` 之后加：
```ts
  /**
   * 按 id 取失败项，**含已恢复的**。只给动作端点用：它必须分得清
   * 「这个 id 不存在」与「这条已经恢复了」——两者都进 `skipped`，但把
   * 已恢复的当成不存在会让人以为自己点错了 id。
   */
  listFailuresById(ids: readonly number[]): Promise<JobFailureRecord[]>
  /**
   * 把这几条失败项标成已恢复，返回**真的被标记的行数**（已经恢复过的不重复计）。
   *
   * 与 `resolveStaleFailures` 的分工：那个是轮次跑完后按时间线自动关，
   * 这个是人在界面上按了「重试 / 忽略」之后立刻关——不立刻关的话，那一行要
   * 等到下一轮拉取（最多 15 分钟）才消失，而按钮点下去屏幕上什么都没变。
   */
  resolveFailuresByIds(ids: readonly number[], now: number): Promise<number>
```

3) `createJobsStore` 里 `listFailures` 之后加实现：
```ts
    async listFailuresById(ids) {
      // 空数组是「这次没有要问的失败项」，不是「不筛选」——退化成无条件查询会
      // 把整张表捞回来，而端点会照着它去改一堆没人点过的会议
      if (ids.length === 0) return []
      const holes = ids.map(() => '?').join(', ')
      const [rows] = await pool.execute<FailureSqlRow[]>(
        `SELECT ${FAILURE_COLS} FROM job_failures WHERE id IN (${holes}) ORDER BY id`,
        [...ids],
      )
      return rows.map(mapFailure)
    },

    async resolveFailuresByIds(ids, now) {
      if (ids.length === 0) return 0
      const holes = ids.map(() => '?').join(', ')
      const [res] = await pool.execute<ResultSetHeader>(
        `UPDATE job_failures SET resolved_at = ?
          WHERE resolved_at IS NULL AND id IN (${holes})`,
        [now, ...ids],
      )
      return res.affectedRows
    },
```

- [ ] **Step 10: 跑 store 测试，确认绿**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/store/jobs.test.ts`
Expected: PASS。

- [ ] **Step 11: 登记两个审计动作（先让登记表测试红）**

`tests/audit/actions.test.ts` 的 `WRITTEN_ACTIONS` 里，`'run_job',` 那一行下面加两行：
```ts
  // 定时任务
  'run_job',
  'job_failure_retry',
  'job_failure_ignore',
```
文件头注释里 `- \`src/http/handlers/console/jobs.ts\`：\`run_job\`` 那一行改成
`- \`src/http/handlers/console/jobs.ts\`：\`run_job\` 与失败项动作两个`。

Run: `bun test tests/audit/actions.test.ts`
Expected: FAIL——「每一个会被写进 audit_log 的动作都登记了标签」报缺两个。

`src/audit/actions.ts`：`AUDIT_ACTION_LABELS` 的定时任务那一段加两行：
```ts
  // ── 控制台 · 定时任务 ─────────────────────────────────────────────
  run_job: '手动触发定时任务',
  /** 把一条失败项对应会议的 failed/dead 资产打回下载队列（attempts 清零） */
  job_failure_retry: '重试一条失败项',
  /** 把一条失败项对应会议的 dead 资产判成不用管了（skipped/ignored_by_admin） */
  job_failure_ignore: '忽略一条失败项',
```
`AUDIT_ACTION` 里 `runJob: 'run_job',` 之后加：
```ts
  runJob: 'run_job',
  jobFailureRetry: 'job_failure_retry',
  jobFailureIgnore: 'job_failure_ignore',
```

Run: `bun test tests/audit/actions.test.ts`
Expected: PASS。

- [ ] **Step 12: 写端点用例（真 MySQL，先红）**

新建 `tests/http/console-jobs-failures.test.ts`：

```ts
/**
 * 失败项的两个动作端点（规格 2026-09-09 §2.3）。
 *
 * ## 为什么这一族跑真库，而 tests/http/console-jobs.test.ts 用假 store
 *
 * 那个文件测的是**胶水**（下次运行算得对不对、手动触发到底排没排队），假 store
 * 够用。这两个端点不是胶水：它们的全部内容就是「哪些行被改成了什么状态」——
 * 一场会议的 dead 资产回到 pending、attempts 清零、别的会议一行没动、失败项那一行
 * 被关掉。这些在假 store 上只能看到「返回了 200」。
 *
 * 所以这里把 `createJobsStore` 与 `createMysqlStore` 都接在同一个临时库上，
 * 只有管理员会话是假的。
 */
import { expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import { createJobsStore, jobFailureTarget } from '../../src/store/jobs'
import { createMysqlStore } from '../../src/worker/store-mysql'
import { ignoreFailures, retryFailures } from '../../src/http/handlers/console/jobs'
import { AdminSessionInvalidError } from '../../src/auth/admin'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AuditEntry } from '../../src/store/audit'
import type { AppDeps, RouteCtx } from '../../src/http/router'

const NOW = 1_800_000_000
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }
const READONLY: AdminIdentity = { adminId: 'admin-2', username: 'bob', role: 'readonly' }

function fakeAdminAuth(identity: AdminIdentity | null): AdminAuth {
  return {
    async authenticate() { throw new Error('not stubbed') },
    async hashPassword() { throw new Error('not stubbed') },
    async issueSession() { throw new Error('not stubbed') },
    async verifySession() {
      if (identity === null) throw new AdminSessionInvalidError()
      return identity
    },
    async revokeSession() { throw new Error('not stubbed') },
    async revokeAllSessionsFor() { throw new Error('not stubbed') },
    async revokeOtherSessionsFor() { throw new Error('not stubbed') },
  }
}

interface Rig {
  ctx: RouteCtx
  audits: AuditEntry[]
  jobs: ReturnType<typeof createJobsStore>
  store: ReturnType<typeof createMysqlStore>
}

async function withRig(
  fn: (rig: Rig) => Promise<void>,
  identity: AdminIdentity | null = ADMIN,
): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try {
    const jobs = createJobsStore(pool)
    const store = createMysqlStore(pool)
    const audits: AuditEntry[] = []
    const deps = {
      now: () => NOW,
      adminAuth: fakeAdminAuth(identity),
      jobs: {
        jobs,
        assets: store,
        audit: { async record(e: AuditEntry) { audits.push(e) } },
        tzOffsetSec: 0,
        fetchLookbackHours: 24,
      },
    } as unknown as AppDeps
    await fn({ ctx: { params: {}, deps }, audits, jobs, store })
  } finally {
    await cleanup()
  }
}

function post(path: string, body: unknown): Request {
  return new Request(`https://gw.example${path}`, {
    method: 'POST',
    headers: { cookie: 'mde_admin_session=t', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 一场会议 + 一条 dead 资产 + 一条对应的失败项，返回失败项 id */
async function seedDeadMeeting(
  rig: Rig,
  o: { meetingId: string; subMeetingId?: string; jobName?: string } ,
): Promise<number> {
  const subMeetingId = o.subMeetingId ?? ''
  await rig.store.upsertMeeting({
    meetingId: o.meetingId, subMeetingId, meetingCode: '881', subject: '周会',
    hostUserId: 'u1', startTime: 1000, endTime: 2000,
  }, NOW - 9000)
  await rig.store.upsertAsset({
    meetingId: o.meetingId, subMeetingId, assetType: 'video', remoteId: `r-${o.meetingId}`, fileType: 'mp4',
  }, NOW - 9000)
  const row = (await rig.store.claimNext(NOW - 8000, 60))!
  await rig.store.markDead(row.id, 'http 404', NOW - 7000)
  await rig.jobs.recordFailure({
    jobName: o.jobName ?? 'fetch_recordings',
    target: jobFailureTarget(o.meetingId, subMeetingId),
    targetLabel: '', meetingId: o.meetingId, subMeetingId,
    reason: '录像：腾讯那边没有这个文件', detail: `video/r-${o.meetingId}/mp4: http 404`,
    impact: '影响', attempts: 5, maxAttempts: 5, now: NOW - 7000,
  })
  const f = (await rig.jobs.listFailures()).find((x) => x.meetingId === o.meetingId)!
  return f.id
}

test('重试：资产回队列且 attempts 清零，失败项当场关掉', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await retryFailures(post('/api/v1/admin/jobs/failures/retry', { ids: [id] }), rig.ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ affected: 1, skipped: [] })

    const asset = (await rig.store.assetsForMeeting('m-1', ''))[0]!
    expect(asset.status).toBe('pending')
    expect(asset.attempts).toBe(0)          // 不清零的话回队列只剩一次机会
    expect(asset.last_error).toBeNull()
    // 「需要处理」上当场就没有它了，不用等下一轮拉取
    expect(await rig.jobs.listFailures()).toEqual([])
  })
})

test('忽略：dead 转 skipped(ignored_by_admin)，下一轮不会再被登记', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await ignoreFailures(post('/api/v1/admin/jobs/failures/ignore', { ids: [id] }), rig.ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ affected: 1, skipped: [] })

    const asset = (await rig.store.assetsForMeeting('m-1', ''))[0]!
    expect(asset.status).toBe('skipped')
    expect(asset.last_error).toBe('ignored_by_admin')
    // 资产不再是 dead → deadAssets 不再给它 → recordDeadAssets 不会重记
    expect(await rig.store.deadAssets()).toEqual([])
  })
})

test('不是可操作的那种：归档任务的失败项一行不改，进 skipped', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1', jobName: 'archive_nas' })
    const res = await retryFailures(post('/api/v1/admin/jobs/failures/retry', { ids: [id] }), rig.ctx)
    expect(await res.json()).toEqual({ affected: 0, skipped: [id] })
    // 归档失败项每轮自己判定、自己恢复，端点碰它只会把两套机制搅在一起
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('dead')
    expect(await rig.jobs.listFailures()).toHaveLength(1)
  })
})

test('已经恢复的、以及库里没有的 id：都进 skipped，不报错也不假装做了', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    await rig.jobs.resolveFailuresByIds([id], NOW - 100)
    const res = await retryFailures(
      post('/api/v1/admin/jobs/failures/retry', { ids: [id, 999_999] }), rig.ctx,
    )
    expect(await res.json()).toEqual({ affected: 0, skipped: [id, 999_999] })
  })
})

test('一次多条：能做的做了，不能做的逐个报回去', async () => {
  await withRig(async (rig) => {
    const ok1 = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const ok2 = await seedDeadMeeting(rig, { meetingId: 'm-2' })
    const bad = await seedDeadMeeting(rig, { meetingId: 'm-3', jobName: 'archive_nas' })
    const res = await retryFailures(
      post('/api/v1/admin/jobs/failures/retry', { ids: [ok1, bad, ok2] }), rig.ctx,
    )
    expect(await res.json()).toEqual({ affected: 2, skipped: [bad] })
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('pending')
    expect((await rig.store.assetsForMeeting('m-2', ''))[0]!.status).toBe('pending')
  })
})

test('周期性会议按场次动，不串到同 meeting_id 的另一场', async () => {
  await withRig(async (rig) => {
    const s1 = await seedDeadMeeting(rig, { meetingId: 'm-9', subMeetingId: 's-1' })
    await seedDeadMeeting(rig, { meetingId: 'm-9', subMeetingId: 's-2' })
    await retryFailures(post('/api/v1/admin/jobs/failures/retry', { ids: [s1] }), rig.ctx)
    expect((await rig.store.assetsForMeeting('m-9', 's-1'))[0]!.status).toBe('pending')
    expect((await rig.store.assetsForMeeting('m-9', 's-2'))[0]!.status).toBe('dead')
  })
})

test('每条动作一条审计：记得下是哪场会议、哪个动作、这一批有多少条', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    await ignoreFailures(post('/api/v1/admin/jobs/failures/ignore', { ids: [id] }), rig.ctx)
    expect(rig.audits).toHaveLength(1)
    const a = rig.audits[0]!
    expect(a.action).toBe('job_failure_ignore')
    expect(a.actorType).toBe('admin')
    expect(a.actorId).toBe('admin-1')
    expect(a.decision).toBe('allow')
    expect(a.clientKind).toBe('console')
    expect(a.meetingId).toBe('m-1')
    expect(a.assetId).toBe(`failure:${jobFailureTarget('m-1', '')}`)
    expect(a.detail).toContain('忽略')
    expect(JSON.parse(a.detail!.split('\n')[1]!)).toMatchObject({ failureId: id, batchSize: 1 })
  })
})

test('请求体不合规一律 400，且一行都不改', async () => {
  await withRig(async (rig) => {
    await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const bodies: unknown[] = [
      {},                                   // 没有 ids
      { ids: [] },                          // 空数组不是「全选」
      { ids: Array.from({ length: 101 }, (_, i) => i + 1) },  // 超过 100
      { ids: ['1'] },                       // 字符串 id
      { ids: [1.5] },                       // 非整数
      { ids: [0] },                         // 自增主键从 1 起
    ]
    for (const b of bodies) {
      const res = await retryFailures(post('/api/v1/admin/jobs/failures/retry', b), rig.ctx)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('invalid_ids')
    }
    // 「一行都不改」是这条用例的重点：一次手滑不该变成一次做了一半的批量操作
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('dead')
    expect(await rig.jobs.listFailures()).toHaveLength(1)
    expect(rig.audits).toHaveLength(0)
  })
})

test('同一个 id 报两次只做一遍——affected 不许因为重复而虚报', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await retryFailures(
      post('/api/v1/admin/jobs/failures/retry', { ids: [id, id] }), rig.ctx,
    )
    expect(await res.json()).toEqual({ affected: 1, skipped: [] })
    expect(rig.audits).toHaveLength(1)
  })
})

test('只读角色 403，未登录 401——两种都不许改任何一行', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await retryFailures(post('/api/v1/admin/jobs/failures/retry', { ids: [id] }), rig.ctx)
    expect(res.status).toBe(403)
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('dead')
    expect(rig.audits).toHaveLength(0)
  }, READONLY)

  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await ignoreFailures(post('/api/v1/admin/jobs/failures/ignore', { ids: [id] }), rig.ctx)
    expect(res.status).toBe(401)
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('dead')
  }, null)
})
```

> `seedDeadMeeting` 在只读 / 未登录那两个 rig 里也照跑：它是**直接走 store 写的**，
> 不经过 handler，所以不受认证影响——那正是「401/403 之后一行都没改」这条断言的前提。

- [ ] **Step 13: 跑它，确认红**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/http/console-jobs-failures.test.ts`
Expected: FAIL——`retryFailures` / `ignoreFailures` 不存在。

- [ ] **Step 14: 写两个 handler**

`src/http/handlers/console/jobs.ts`：

import 补 `readJson` 与 `JOB_FETCH_RECORDINGS`、`Store` 类型：
```ts
import { json, readJson } from '../../respond'
import type { Store } from '@yaowu/mde-engine'
import {
  JOB_CATALOG,
  JOB_FETCH_RECORDINGS,
  JOB_RUNS_SPARKLINE_LIMIT,
  describeSchedule,
  jobSpec,
  nextDueAt,
  type JobFailureRecord,
  type JobRunRecord,
  type JobSchedule,
  type JobsStore,
} from '../../../store/jobs'
```

`JobsDeps` 里 `audit` 之后加：
```ts
  /**
   * 资产队列的写侧，**收窄到失败项动作要用的那两个方法**。
   *
   * 装配处给的是 `createMysqlStore(pool)`（`src/worker/store-mysql.ts`）。那个模块的
   * import 全是 `import type`，模块图上零运行时依赖——它是一个 store，不是调度器，
   * 与「调度器不进网关进程」那条约束不冲突（网关本来就 import 着 `src/store/*`）。
   *
   * 收窄成 Pick 而不是整个 `Store`：这个 handler 不该够得着 `claimNext`。网关是
   * 多实例的，一个能领任务的网关就是五个任务各跑 N 份的第一步。
   */
  assets: Pick<Store, 'retryMeetingAssets' | 'ignoreDeadAssets'>
```

`FAILURES_PAGE_LIMIT` 旁边加常量与三个纯函数：
```ts
/** 一次批量动作最多多少个 id（规格 §2.3）。上限与 `FAILURES_PAGE_LIMIT` 同值不是巧合：
 *  屏幕上一次最多就这么多条，「全部重试」永远塞不满这个上限 */
const FAILURE_ACTION_MAX_IDS = 100

/**
 * 请求体里的 ids。**任何一处不合规就整条拒绝**，不做「挑出合法的那几个继续」——
 * 那会让一次手滑（多打一个字符串）变成一次只做了一半的批量操作，而调用方
 * 从 200 响应里看不出自己少做了什么。
 */
function parseFailureIds(body: unknown): number[] | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = (body as { ids?: unknown }).ids
  if (!Array.isArray(raw)) return null
  if (raw.length < 1 || raw.length > FAILURE_ACTION_MAX_IDS) return null
  const out: number[] = []
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return null
    // 同一个 id 报两次是同一件事，做两遍没有意义（第二遍的 affected 还会撒谎）
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/**
 * 可操作的失败项只有一种（规格 §2.3）：调度器任务一按 dead 资产登记的、
 * 会议维度的、还没恢复的那种。
 *
 * 其余任务的失败项每轮由各自的枚举源重新判定、`resolveStaleFailures` 自动关掉
 * ——对它们「重试」没有对应的动作可做（下一轮本来就会再试一次），「忽略」更是
 * 一个假承诺（它下一轮还会回来）。端点对它们返回 skipped，界面上也不给按钮。
 */
function isActionableFailure(f: JobFailureRecord): boolean {
  return f.jobName === JOB_FETCH_RECORDINGS && f.meetingId !== null && f.resolvedAt === null
}

const FAILURE_ACTION_TEXT = { retry: '重试', ignore: '忽略' } as const
type FailureActionKind = keyof typeof FAILURE_ACTION_TEXT
```

在文件末尾加动作实现：
```ts
// ────────────────────────────────────────────────────────────────
// POST /api/v1/admin/jobs/failures/{retry,ignore}
// ────────────────────────────────────────────────────────────────

/**
 * 失败项上的两个动作（规格 §2.3）。
 *
 * ## 为什么这两个动作能在网关里真的执行，而「立即运行」只能排队
 *
 * 「立即运行」要跑一整轮任务体（归档要搬文件、清理要删文件），网关是多实例的，
 * 跑起来就是 N 份同时对同一批文件动手。这两个动作是**两条 UPDATE**：把一场
 * 会议的资产行改个状态。幂等、无副作用、跑几遍结果一样，没有理由绕一圈去排队
 * ——排队的话管理员点完还要等下一个 tick 才看得见变化。
 *
 * ## 顺序：先改资产、再关失败项、最后记账
 *
 * 失败项是「资产此刻是否 dead」的镜像（见 scheduler.ts 的 recordDeadAssets）。
 * 先关失败项再改资产的话，中间失败会留下一条「已恢复」的记录而资产还是 dead
 * ——下一轮它又被重新登记，运维看到的是一条自己关掉又自己回来的失败项。
 * 审计放最后，理由同 runJob：审计是对**已发生事实**的记录。
 */
async function actOnFailures(
  req: Request,
  ctx: RouteCtx,
  action: FailureActionKind,
): Promise<Response> {
  const auth = await requireAdminWrite(req, ctx.deps.adminAuth, ctx.deps.now())
  if (!auth.ok) return auth.response

  const ids = parseFailureIds(await readJson<unknown>(req))
  if (ids === null) {
    return json(400, {
      error: 'invalid_ids',
      message:
        `请求体要 {"ids": [失败项 id, …]}，1–${FAILURE_ACTION_MAX_IDS} 个正整数。` +
        '有一个不合规就整条拒绝——只做一半的批量操作在 200 响应里看不出来。',
    })
  }

  const d = ctx.deps.jobs
  const now = ctx.deps.now()

  const found = await d.jobs.listFailuresById(ids)
  const byId = new Map(found.map((f) => [f.id, f]))
  const doable: JobFailureRecord[] = []
  const skipped: number[] = []
  for (const id of ids) {
    const f = byId.get(id)
    if (f !== undefined && isActionableFailure(f)) doable.push(f)
    else skipped.push(id)   // 找不到、已恢复、或不是可操作的那种——三种都不编一个结果
  }

  for (const f of doable) {
    const key = { meetingId: f.meetingId!, subMeetingId: f.subMeetingId }
    if (action === 'retry') await d.assets.retryMeetingAssets(key, now)
    else await d.assets.ignoreDeadAssets(key, now)
  }
  await d.jobs.resolveFailuresByIds(doable.map((f) => f.id), now)

  // 逐条一行审计（与 purge_local 同一个先例）：这一列要答得出「是谁把哪一场
  // 会议的资产打回了队列」。一批一条的话，事后按会议查审计就查不到这件事。
  for (const f of doable) {
    const entry: AuditEntry = {
      occurredAt: now,
      actorType: 'admin',
      actorId: auth.identity.adminId,
      action: action === 'retry' ? AUDIT_ACTION.jobFailureRetry : AUDIT_ACTION.jobFailureIgnore,
      meetingId: f.meetingId,
      // audit_log 没有「对象类型」这一列，assetId 在管理员这一族里当对象键用。
      // `failure:` 前缀免得与会议维度的记录（`sub:` 前缀）混在一起
      assetId: `failure:${f.target}`,
      assetType: null,
      decision: 'allow',
      matchedRuleId: null,
      clientKind: 'console',
      detail: buildAuditDetail({
        text: `${FAILURE_ACTION_TEXT[action]}失败项 #${f.id}（${f.reason}）`,
        // 结构化的一份：批量里的一条与单点的一条，事后要分得开
        data: { failureId: f.id, jobName: f.jobName, target: f.target, batchSize: ids.length },
      }),
    }
    await d.audit.record(entry)
  }

  return json(200, { affected: doable.length, skipped })
}

/** 打回下载队列：`meeting_assets` 的 failed/dead → pending，attempts 清零 */
export async function retryFailures(req: Request, ctx: RouteCtx): Promise<Response> {
  return actOnFailures(req, ctx, 'retry')
}

/** 判成不用管了：`meeting_assets` 的 dead → skipped/ignored_by_admin */
export async function ignoreFailures(req: Request, ctx: RouteCtx): Promise<Response> {
  return actOnFailures(req, ctx, 'ignore')
}
```

- [ ] **Step 15: 接路由与装配**

`src/http/router.ts`，在那两条 jobs 路由**之前**插入（更具体的先匹配；两条路径段数相同但末段字面量不同，不会互相吃掉，先放仍是好习惯）：
```ts
  // 失败项动作在 `/jobs/:name/run` **之前**：两者段数相同，末段的字面量不同，
  // 所以其实互不相干；顺序是给读代码的人看的——具体路径排在带参数的前面
  compile('POST', '/api/v1/admin/jobs/failures/retry', consoleJobsHandlers.retryFailures),
  compile('POST', '/api/v1/admin/jobs/failures/ignore', consoleJobsHandlers.ignoreFailures),
  compile('GET', '/api/v1/admin/jobs', consoleJobsHandlers.listJobs),
  compile('POST', '/api/v1/admin/jobs/:name/run', consoleJobsHandlers.runJob),
```

`src/index.ts`：顶部 import 加
```ts
import { createMysqlStore } from './worker/store-mysql'
```
`jobs:` 那个对象里 `audit: auditStore,` 之后加
```ts
      // 失败项的「重试 / 忽略」要改 meeting_assets。store-mysql 的 import 全是
      // `import type`，模块图上零运行时依赖，不会把引擎/调度器拖进网关进程
      assets: createMysqlStore(pool),
```

- [ ] **Step 16: 补假 store 的两个新方法，跑全部网关测试**

`tests/http/console-jobs.test.ts` 里那个 `jobs: JobsStore` 假实现补两行：
```ts
    listFailuresById: notUsed('listFailuresById'),
    resolveFailuresByIds: notUsed('resolveFailuresByIds'),
```
并在 `deps.jobs` 里补 `assets: { retryMeetingAssets: notUsed('retryMeetingAssets'), ignoreDeadAssets: notUsed('ignoreDeadAssets') }`（`listJobs` / `runJob` 都不该碰它）。

Run:
```
bun run typecheck
TEST_DATABASE_URL=$TEST_DATABASE_URL bun test tests/http/console-jobs-failures.test.ts tests/http/console-jobs.test.ts tests/audit/actions.test.ts tests/store/jobs.test.ts
```
Expected: PASS。

- [ ] **Step 17: 提交**

```bash
git add src/store/jobs.ts src/http/handlers/console/jobs.ts src/http/router.ts src/index.ts \
        src/audit/actions.ts tests/http/console-jobs-failures.test.ts \
        tests/http/console-jobs.test.ts tests/audit/actions.test.ts tests/store/jobs.test.ts
git commit -m "feat(console-api): 失败项可重试/忽略的两个管理端点，带审计与可操作判据"
```

---

## Task 5：控制台——关闭横幅的 hook 泛化，落后横幅可关

**Files:**
- Modify: `console/src/pages/Jobs/dismiss.ts`
- Modify: `console/src/pages/Jobs/view.ts`（新增 `overdueIdentity`）
- Modify: `console/src/pages/Jobs/index.tsx`
- Test: `console/tests/pages/Jobs.test.tsx`、`console/tests/pages/JobsView.test.ts`

**Interfaces:**
- Produces：
  ```ts
  // console/src/pages/Jobs/dismiss.ts
  export interface DismissedBanner { hidden: boolean; dismiss: () => void }
  export const STALL_DISMISS_KEY = 'mde.jobs.fetch-stall.dismissed'
  export const OVERDUE_DISMISS_KEY = 'mde.jobs.overdue.dismissed'
  export function useDismissedBanner(storageKey: string, identity: string | null): DismissedBanner
  export function useDismissedStall(stall: FetchStall | null): DismissedBanner

  // console/src/pages/Jobs/view.ts
  export function overdueIdentity(jobs: readonly JobItem[]): string | null
  ```
- Consumes：`overdueJobs(jobs)`（已存在）。

- [ ] **Step 1: 写 `overdueIdentity` 的用例（先红）**

`console/tests/pages/JobsView.test.ts`：把 `overdueIdentity` 加进文件顶部**已有的那个**
`import { … } from '../../src/pages/Jobs/view'` 块（别新开一行 import），然后在末尾追加
（`job()` / `run()` 是该文件已有的工厂）：

```ts
/**
 * 「这一批落后」的身份。与连续失败横幅同一套机制：关掉的只是**眼前这一段**。
 * 任一任务再跑一次（lastRun.id 变）、或落后的集合变了，身份就变、横幅回来。
 */
describe('落后横幅的身份', () => {
  const ok = (name: string) => job({ name, health: 'ok' })
  const late = (name: string, runId: number | null) =>
    job({ name, health: 'overdue', lastRun: runId === null ? null : run({ id: runId }) })

  test('没有落后的任务就没有身份——存储键该被删掉', () => {
    expect(overdueIdentity([ok('a'), ok('b')])).toBeNull()
  })

  test('按任务名排序拼 <name>@<lastRunId>，用 | 连接——与后端下发顺序无关', () => {
    expect(overdueIdentity([late('b', 22), ok('c'), late('a', 11)])).toBe('a@11|b@22')
    expect(overdueIdentity([late('a', 11), late('b', 22)])).toBe('a@11|b@22')
  })

  test('从没跑过的落后任务用 none，不用 0——0 是一个真实的 id 取值', () => {
    expect(overdueIdentity([late('a', null)])).toBe('a@none')
  })

  test('任一任务又跑了一轮，身份就变（横幅因此回来）', () => {
    expect(overdueIdentity([late('a', 11), late('b', 22)]))
      .not.toBe(overdueIdentity([late('a', 12), late('b', 22)]))
  })

  test('落后集合变了，身份也变', () => {
    expect(overdueIdentity([late('a', 11)])).not.toBe(overdueIdentity([late('a', 11), late('b', 22)]))
  })
})
```

- [ ] **Step 2: 跑它，确认红**

Run: `cd console && bunx vitest run tests/pages/JobsView.test.ts`
Expected: FAIL——`overdueIdentity` 不存在。

- [ ] **Step 3: 写 `overdueIdentity`**

`console/src/pages/Jobs/view.ts`，紧跟在 `overdueJobs` 后面：

```ts
/**
 * 「这一批落后」的身份字符串；一个落后任务都没有时是 null。
 *
 * 与连续失败横幅那条（`fetchStall().latestFailedRunId`）是同一套机制：关掉的只是
 * **眼前这一段**，不是永久禁用一条告警。身份 = 落后任务按名字排序后，每个拼成
 * `<name>@<lastRunId ?? 'none'>`，用 `|` 连接。
 *
 * 三个细节各有理由：
 *
 * - **按名字排序**：后端下发顺序是 `JOB_CATALOG` 的顺序，今天稳定，但身份字符串
 *   不该建立在一个没人承诺过的顺序上——顺序一变，一条已经关掉的横幅会自己跳回来
 * - **带上 lastRunId**：任一落后任务再跑一次（哪怕仍然落后），那就是一件你还没看过
 *   的新事实，横幅该回来
 * - **从没跑过用 `none` 而不是 0**：0 是一个真实的自增 id 取值，用它当哨兵会让
 *   「从没跑过」与「跑过第 0 轮」撞成同一个身份
 */
export function overdueIdentity(jobs: readonly JobItem[]): string | null {
  const late = overdueJobs(jobs)
  if (late.length === 0) return null
  return [...late]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((j) => `${j.name}@${j.lastRun === null ? 'none' : j.lastRun.id}`)
    .join('|')
}
```

- [ ] **Step 4: 跑它，确认绿**

Run: `cd console && bunx vitest run tests/pages/JobsView.test.ts`
Expected: PASS。

- [ ] **Step 5: 写落后横幅可关的用例（先红）**

`console/tests/pages/Jobs.test.tsx`：把那条 `'「N 个任务已经落后」那条没有关闭按钮——它是这件事在控制台里唯一的出处'` **整条删掉**，并追加一个新的 describe：

```ts
/**
 * 落后横幅也关得掉（规格 2026-09-09 §2.1），但同样只对**这一批落后**有效。
 *
 * 原来的规矩是「不能关」，理由是它是这件事在控制台里唯一的出处。那条理由仍然成立
 * ——所以关掉的粒度是「这一批」，不是「以后都别说了」：任一落后任务再跑一轮、
 * 或者落后的集合变了，它就回来。
 */
describe('「N 个任务已经落后」那条横幅关得掉，但只对这一批有效', () => {
  const KEY = 'mde.jobs.overdue.dismissed'

  function overduePayload(runId = 900): Record<string, unknown> {
    return payload({
      jobs: [
        job({ name: 'archive_nas', label: '归档到 NAS', health: 'overdue', lastRun: run({ id: runId }) }),
        job({ name: 'fetch_recordings', label: '拉取新录制', health: 'ok' }),
      ],
    })
  }

  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  test('点「关闭这条提醒」，横幅消失，并记下这一批的身份', async () => {
    await mount(overduePayload())
    expect(await screen.findByTestId('jobs-overdue')).toBeInTheDocument()
    const banner = screen.getByTestId('jobs-overdue')
    await userEvent.click(within(banner).getByRole('button', { name: '关闭这条提醒' }))
    await waitFor(() => expect(screen.queryByTestId('jobs-overdue')).toBeNull())
    expect(localStorage.getItem(KEY)).toBe('archive_nas@900')
  })

  test('这一批已经关过：首次渲染就没有这条横幅', async () => {
    localStorage.setItem(KEY, 'archive_nas@900')
    await mount(overduePayload())
    await screen.findAllByTestId('job-card')
    expect(screen.queryByTestId('jobs-overdue')).toBeNull()
  })

  test('那个落后的任务又跑了一轮：横幅回来', async () => {
    localStorage.setItem(KEY, 'archive_nas@900')
    await mount(overduePayload(901))
    expect(await screen.findByTestId('jobs-overdue')).toBeInTheDocument()
  })

  test('一个落后的都没有了：那个身份被删掉，下一批从头提醒', async () => {
    localStorage.setItem(KEY, 'archive_nas@900')
    await mount()   // 默认五个任务都是 ok
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
  })

  test('两条横幅同时在时各关各的：关掉落后那条，连续失败那条还在', async () => {
    const both = payload({
      jobs: [
        job({ name: 'archive_nas', label: '归档到 NAS', health: 'overdue', lastRun: run({ id: 900 }) }),
        job({
          name: 'fetch_recordings', label: '拉取新录制', health: 'ok',
          recentRuns: Array.from({ length: TENCENT_DOWN_STREAK }, (_, i) => run({ id: 800 - i, status: 'failed' })),
        }),
      ],
    })
    await mount(both)
    const overdue = await screen.findByTestId('jobs-overdue')
    // 两条的可访问名相同（都是「关闭这条提醒」），所以按 testid 定位到各自那一颗
    await userEvent.click(within(overdue).getByRole('button', { name: '关闭这条提醒' }))
    await waitFor(() => expect(screen.queryByTestId('jobs-overdue')).toBeNull())
    expect(screen.getByTestId('jobs-fetch-stalled')).toBeInTheDocument()
    expect(localStorage.getItem('mde.jobs.fetch-stall.dismissed')).toBeNull()
  })
})
```

同时把已有的那条 `'点「关闭这条提醒」，横幅消失，并记下这一段故障的身份'` 里的
`screen.getByRole('button', { name: '关闭这条提醒' })` 改成
`within(screen.getByTestId('jobs-fetch-stalled')).getByRole('button', { name: '关闭这条提醒' })`
——那一组用例里只有一条横幅，但按 testid 限定范围之后，将来两条同时在也不会歧义。

- [ ] **Step 6: 跑它，确认红**

Run: `cd console && bunx vitest run tests/pages/Jobs.test.tsx`
Expected: FAIL——落后横幅里没有按钮。

- [ ] **Step 7: 泛化 `dismiss.ts`**

`console/src/pages/Jobs/dismiss.ts`：三个存储辅助改成收键名，hook 拆两层。文件头那段注释保留（它讲的是「为什么按身份记、为什么故障结束就删键」，对两条横幅都成立），在末尾补一段说明泛化。

```ts
import { useCallback, useEffect, useState } from 'react'
import type { FetchStall } from './view'

/** 「最近 N 轮拉取连续失败」那条。身份是这一段故障里最新那次 failed 运行的 id */
export const STALL_DISMISS_KEY = 'mde.jobs.fetch-stall.dismissed'
/** 「N 个任务已经落后」那条。身份是 `overdueIdentity()` 拼的那串 */
export const OVERDUE_DISMISS_KEY = 'mde.jobs.overdue.dismissed'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存不了就只在本次会话生效 */
  }
}

function clear(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 同上：删不掉也不能让它炸掉整个页面 */
  }
}

export interface DismissedBanner {
  /** 这一段（这一批）已经被关过了——横幅不显示 */
  hidden: boolean
  /** 关掉眼前这一段。`identity` 为 null 时是空操作 */
  dismiss: () => void
}

/**
 * 一条「可以关，但只对眼前这一段有效」的横幅的关闭状态。
 *
 * `identity` 就是「这是哪一段」：它变了就是一件你还没看过的新事实，横幅回来；
 * 它是 `null` 表示这件事已经不存在了，那时把存储键**删掉**（理由见文件头：留着
 * 一个旧身份，换一套数据之后完全可能撞上，把下一段的第一眼提醒悄悄吞掉）。
 *
 * 泛化成两个参数是为了让两条横幅共用同一套判据。它们唯一的区别就是这两个入参
 * ——各写一份的话，「关掉之后什么时候该回来」这条规矩会在两处慢慢漂开。
 */
export function useDismissedBanner(storageKey: string, identity: string | null): DismissedBanner {
  // 惰性初始化必须包一层箭头：`useState(read)` 会把 React 传进来的（没有）参数
  // 当 key 用，读到 `localStorage.getItem(undefined)`
  const [dismissed, setDismissed] = useState<string | null>(() => read(storageKey))

  useEffect(() => {
    if (identity !== null) return
    clear(storageKey)
    setDismissed(null)
  }, [storageKey, identity])

  const dismiss = useCallback(() => {
    if (identity === null) return
    write(storageKey, identity)
    // 先写存储再落 state，但两者不绑在一起：写失败（私密窗口）时横幅照样关掉，
    // 只是下次刷新还会回来。
    setDismissed(identity)
  }, [storageKey, identity])

  return { hidden: identity !== null && dismissed === identity, dismiss }
}

/**
 * 「最近 N 轮拉取连续失败」那条。行为与泛化之前**逐字不变**：同一个存储键、
 * 同一个身份（`String(latestFailedRunId)`）。
 */
export function useDismissedStall(stall: FetchStall | null): DismissedBanner {
  return useDismissedBanner(
    STALL_DISMISS_KEY,
    // 依赖是那个 id 而不是 `stall` 本身：`fetchStall()` 每次渲染都返回一个新对象
    stall === null ? null : String(stall.latestFailedRunId),
  )
}
```

（旧的 `DismissedStall` 接口如果还有别处 import，保留一行
`export type DismissedStall = DismissedBanner`；否则删掉。`grep -rn "DismissedStall" console/src` 确认。）

- [ ] **Step 8: 给落后横幅加关闭按钮**

`console/src/pages/Jobs/index.tsx`：

import 改成
```ts
import { useDismissedBanner, useDismissedStall, OVERDUE_DISMISS_KEY } from './dismiss'
import { chainEdgeText, fetchStall, jobOrdinal, overdueIdentity, overdueJobs, runQueuedNote, splitLanes } from './view'
```

`Ready` 里在 `useDismissedStall` 旁边加：
```ts
  /**
   * 落后横幅也关得掉，粒度是**这一批落后**（`overdueIdentity`）。
   *
   * 从前它不给关闭按钮，理由是「顶栏的 liveAlert() 不报 overdue，关掉就等于把
   * 『调度器死了』从整个控制台里抹掉」。那条理由是对的，所以关掉的不是这件事
   * 本身而是这一批：任一落后任务再跑一轮、或落后集合变了，它就回来。知道了的人
   * 在等修复期间还要继续用这一页，而一条关不掉的横幅会把四张卡片一直往下挤。
   */
  const overdueId = overdueIdentity(o.jobs)
  const { hidden: overdueDismissed, dismiss: dismissOverdue } = useDismissedBanner(
    OVERDUE_DISMISS_KEY,
    overdueId,
  )
```

外层条件从 `{overdue.length > 0 && (` 改成 `{overdue.length > 0 && !overdueDismissed && (`，并在那个 `<div data-testid="jobs-overdue">` 的 `</p>` 之后、`</div>` 之前加：
```ts
          {/* 可访问名与黄色那条相同（「关闭」这个名字在全站归 ui/Sheet 头部那个
              × 所有）。两条同时在时靠 data-testid 区分，测试也按它定位。 */}
          <button
            type="button"
            className={styles.bannerClose}
            aria-label="关闭这条提醒"
            data-testid="jobs-overdue-close"
            onClick={dismissOverdue}
          >
            <span aria-hidden="true">×</span>
          </button>
```
黄色那条的关闭按钮一并补上 `data-testid="jobs-fetch-stalled-close"`。

- [ ] **Step 9: 跑控制台测试**

Run: `cd console && bunx vitest run tests/pages/Jobs.test.tsx tests/pages/JobsView.test.ts && bunx tsc --noEmit`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add console/src/pages/Jobs/dismiss.ts console/src/pages/Jobs/view.ts console/src/pages/Jobs/index.tsx \
        console/tests/pages/Jobs.test.tsx console/tests/pages/JobsView.test.ts
git commit -m "feat(console): 落后横幅可关，关闭状态的 hook 泛化成 useDismissedBanner"
```

---

## Task 6：控制台——失败项的行级/组级动作与「技术详情」

**Files:**
- Modify: `console/src/api/admin/jobs.ts`（两个动作函数）
- Modify: `console/src/api/mock/install.ts`（两个动作端点的假实现）
- Modify: `console/src/pages/Jobs/view.ts`（`isActionableFailure` 与三句文案）
- Modify: `console/src/pages/Jobs/FailuresTable.tsx`
- Modify: `console/src/pages/Jobs/index.tsx`
- Modify: `console/src/pages/Jobs/Jobs.module.css`
- Test: `console/tests/api/jobs.test.ts`、`console/tests/pages/JobsView.test.ts`、`console/tests/pages/Jobs.test.tsx`

**Interfaces:**
- Produces：
  ```ts
  // console/src/api/admin/jobs.ts
  export interface FailureActionResult { affected: number; skipped: number[] }
  export function retryFailures(ids: readonly number[]): Promise<FailureActionResult>
  export function ignoreFailures(ids: readonly number[]): Promise<FailureActionResult>

  // console/src/pages/Jobs/view.ts
  export type FailureActionKind = 'retry' | 'ignore'
  export const FAILURE_ACTION_LABEL: Record<FailureActionKind, string>          // 重试 / 忽略
  export const FAILURE_GROUP_ACTION_LABEL: Record<FailureActionKind, string>    // 全部重试 / 全部忽略
  export function isActionableFailure(f: Pick<JobFailure, 'jobName' | 'meetingId'>): boolean
  export function actionableIds(g: Pick<FailureGroup, 'items'>): number[]
  export function failureActionErrorText(action: FailureActionKind, message: string): string
  export function failureActionSkippedText(action: FailureActionKind, done: number, skipped: number): string

  // FailuresTable 的 props
  { o, now, removedIds, onAct }  // onAct: (action: FailureActionKind, ids: number[]) => void
  ```
- Consumes：Task 2 的 `JobFailure.detail`；Task 4 的两个端点与 `{ affected, skipped }`。

- [ ] **Step 1: 写 api 层用例（先红）**

`console/tests/api/jobs.test.ts` 追加：

```ts
test('retryFailures / ignoreFailures 打到各自的端点，请求体是 {ids}', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? 'null')) })
    return new Response(JSON.stringify({ affected: 2, skipped: [7] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', f)

  expect(await retryFailures([1, 2, 7])).toEqual({ affected: 2, skipped: [7] })
  expect(calls[0]!.url).toContain('/api/v1/admin/jobs/failures/retry')
  expect(calls[0]!.method).toBe('POST')
  expect(calls[0]!.body).toEqual({ ids: [1, 2, 7] })

  await ignoreFailures([3])
  expect(calls[1]!.url).toContain('/api/v1/admin/jobs/failures/ignore')
  expect(calls[1]!.body).toEqual({ ids: [3] })
})

test('响应形状不对就抛（带端点名），不静默当成"做成了"', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ affected: 1 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
  await expect(retryFailures([1])).rejects.toThrow('/api/v1/admin/jobs/failures/retry')
})
```

- [ ] **Step 2: 跑它，确认红**

Run: `cd console && bunx vitest run tests/api/jobs.test.ts`
Expected: FAIL——两个函数不存在。

- [ ] **Step 3: 写 api 层**

`console/src/api/admin/jobs.ts` 末尾追加（`reader` 没有 `numList`，所以自己收窄一次，并把出错位置说清楚）：

```ts
/** 两个失败项动作的响应（后端 `actOnFailures`）。 */
export interface FailureActionResult {
  /** 真的被处理掉的失败项条数 */
  affected: number
  /**
   * 没能处理的失败项 id：找不到、已经恢复了、或者不是可以单独重试的那种。
   * **不是错误**——一次批量里混进这三种是常事，界面上说一句就够。
   */
  skipped: number[]
}

async function actOnFailures(
  action: 'retry' | 'ignore',
  ids: readonly number[],
): Promise<FailureActionResult> {
  const path = `${BASE}/jobs/failures/${action}`
  const raw = await apiSend<unknown>('POST', path, { ids: [...ids] })
  const r = reader(`POST ${path}`)
  const o = r.object(raw, '')
  const skipped = o.skipped
  if (!Array.isArray(skipped) || skipped.some((v) => typeof v !== 'number')) {
    // 这里不能宽容：`skipped` 读不出来就意味着「哪几条没做成」这句话没有依据，
    // 而界面正要拿它告诉人「另外 N 条没能处理」。宁可整条报错。
    throw new Error(`POST ${path} 的 skipped 应该是 number[]，实际是 ${typeof skipped}`)
  }
  return { affected: r.num(o, 'affected', ''), skipped: skipped as number[] }
}

/** 把这几条失败项对应会议的 failed/dead 资产打回下载队列（后端会把 attempts 清零）。 */
export function retryFailures(ids: readonly number[]): Promise<FailureActionResult> {
  return actOnFailures('retry', ids)
}

/** 把这几条失败项对应会议的 dead 资产判成「不用管了」。 */
export function ignoreFailures(ids: readonly number[]): Promise<FailureActionResult> {
  return actOnFailures('ignore', ids)
}
```

- [ ] **Step 4: 跑 api 测试，确认绿**

Run: `cd console && bunx vitest run tests/api/jobs.test.ts`
Expected: PASS。

- [ ] **Step 5: 写呈现口径的用例（先红）**

`console/tests/pages/JobsView.test.ts`：把 `FAILURE_ACTION_LABEL` / `FAILURE_GROUP_ACTION_LABEL` /
`actionableIds` / `failureActionErrorText` / `failureActionSkippedText` / `isActionableFailure`
加进文件顶部**已有的那个** `import { … } from '../../src/pages/Jobs/view'` 块，末尾追加：

```ts
describe('哪些失败项能单独动', () => {
  test('只有拉取任务的、带会议的那种', () => {
    expect(isActionableFailure({ jobName: 'fetch_recordings', meetingId: 'm-1' })).toBe(true)
    // 归档失败项每轮自己判定、自己恢复，「重试」在它上面没有对应的动作
    expect(isActionableFailure({ jobName: 'archive_nas', meetingId: 'm-1' })).toBe(false)
    // 整轮维度的失败项没有会议，没有可以打回队列的资产
    expect(isActionableFailure({ jobName: 'fetch_recordings', meetingId: null })).toBe(false)
    expect(isActionableFailure({ jobName: 'fetch_recordings', meetingId: '' })).toBe(false)
  })

  test('一组里只挑得动的那几条 id，顺序照组内顺序', () => {
    const g = { items: [
      { id: 3, jobName: 'fetch_recordings', meetingId: 'm-1' },
      { id: 4, jobName: 'archive_nas', meetingId: 'm-2' },
      { id: 5, jobName: 'fetch_recordings', meetingId: 'm-3' },
    ] } as any
    expect(actionableIds(g)).toEqual([3, 5])
  })
})

describe('动作的两句话', () => {
  test('按钮文案逐字照规格', () => {
    expect(FAILURE_ACTION_LABEL.retry).toBe('重试')
    expect(FAILURE_ACTION_LABEL.ignore).toBe('忽略')
    expect(FAILURE_GROUP_ACTION_LABEL.retry).toBe('全部重试')
    expect(FAILURE_GROUP_ACTION_LABEL.ignore).toBe('全部忽略')
  })

  test('出错那句带上动作名与后端的原话——不说一句笼统的「操作失败」', () => {
    const t = failureActionErrorText('retry', 'HTTP 500')
    expect(t).toContain('重试')
    expect(t).toContain('HTTP 500')
  })

  test('部分没做成那句把两个数都说出来，不含糊成「部分成功」', () => {
    const t = failureActionSkippedText('ignore', 5, 2)
    expect(t).toContain('忽略')
    expect(t).toContain('5')
    expect(t).toContain('2')
  })
})
```

- [ ] **Step 6: 跑它，确认红，然后写实现**

Run: `cd console && bunx vitest run tests/pages/JobsView.test.ts` → FAIL。

`console/src/pages/Jobs/view.ts` 的失败项那一节末尾追加：

```ts
export type FailureActionKind = 'retry' | 'ignore'

/** 行级按钮的字（规格 §2.3，逐字） */
export const FAILURE_ACTION_LABEL: Record<FailureActionKind, string> = {
  retry: '重试',
  ignore: '忽略',
}
/** 归并组上那两颗按钮的字 */
export const FAILURE_GROUP_ACTION_LABEL: Record<FailureActionKind, string> = {
  retry: '全部重试',
  ignore: '全部忽略',
}

/**
 * 这一条失败项能不能单独动。**判据与后端逐字相同**（`isActionableFailure`，
 * `src/http/handlers/console/jobs.ts`）：拉取任务记的、带会议的那种。
 *
 * 两处各判一次不是重复：后端那一份是权威（端点对不可操作的返回 skipped），
 * 前端这一份决定**给不给按钮**。少了前端这一份，界面上会出现一颗点下去只会
 * 回一句「这条没能处理」的按钮——一个承诺了一件做不到的事的按钮。
 */
export function isActionableFailure(f: Pick<JobFailure, 'jobName' | 'meetingId'>): boolean {
  return f.jobName === FETCH_JOB_NAME && f.meetingId !== null && f.meetingId !== ''
}

/**
 * 一组里能动的那几条 id。
 *
 * 作用范围是**这一批下发下来的失败项**（`g.items`），不是"展开列表里正显示的那几条"：
 * 组行上写的就是「18 场会议」，那颗「全部重试」必须真的是这 18 场。被后端
 * `FAILURES_PAGE_LIMIT` 截掉的那些压根不在 `o.failures` 里，所以也不在动作里——
 * 表头上方那句「还有 N 条没有列出来」已经把这件事说了。
 *
 * 条数上限天然满足端点的 1–100：整页失败项就最多 100 条，一组不会更多。
 */
export function actionableIds(g: Pick<FailureGroup, 'items'>): number[] {
  return g.items.filter(isActionableFailure).map((f) => f.id)
}

/** 动作没做成时那句 toast。带上动作名与后端原话——「操作失败」等于什么都没说 */
export function failureActionErrorText(action: FailureActionKind, message: string): string {
  return `${FAILURE_ACTION_LABEL[action]}没做成：${message}`
}

/**
 * 一批里有几条没能处理时那句 toast。**两个数都说出来**：只说「部分成功」的话，
 * 人无法判断还剩多少要管，也不知道该不该再点一次。
 */
export function failureActionSkippedText(
  action: FailureActionKind,
  done: number,
  skipped: number,
): string {
  return `${FAILURE_ACTION_LABEL[action]}了 ${done} 条；另外 ${skipped} 条没能处理（已经恢复了，或者不是能单独处理的那种）。`
}
```

Run: `cd console && bunx vitest run tests/pages/JobsView.test.ts`
Expected: PASS。

- [ ] **Step 7: 写页面用例（先红）**

`console/tests/pages/Jobs.test.tsx` 追加一个 describe（`failure()` 工厂已在 Task 2 加过 `detail`；这里再给它一个默认 `jobName`/`meetingId` 的覆盖用法）：

```ts
/**
 * 失败项上的两个动作（规格 §2.3）与「技术详情」（§2.4）。
 *
 * 这一组盯三件事：**不可操作的行不给按钮**（一颗点了只会报错的按钮比没有更糟）、
 * **点完当场消失**（不然要等一次重取才看得出有反应）、**失败时行回来并说清原因**
 * （乐观移除不能把一个没做成的操作演成做成了）。
 */
describe('失败项的重试 / 忽略', () => {
  const fetchFailure = (over: Record<string, unknown> = {}) =>
    failure({
      jobName: 'fetch_recordings',
      reason: '录像：腾讯那边没有这个文件',
      impact: '录制在腾讯会议过期后就再也拉不回来了',
      detail: 'video/r-1/mp4: http 404',
      ...over,
    })

  function withFailures(fs: Record<string, unknown>[]): Record<string, unknown> {
    return payload({ failures: fs, failuresTotal: fs.length })
  }

  /**
   * `stubApi` 对所有 POST 回同一个 `runBody`，默认是「立即运行」那个 202 载荷。
   * 动作端点的契约是 `{ affected, skipped }`，读不出来会当场抛——所以凡是要点按钮的
   * 用例都得显式给一个动作端点的响应。
   */
  const acted = (affected: number, skipped: number[] = []) =>
    ({ runStatus: 200, runBody: { affected, skipped } })

  test('可操作的行给「重试」「忽略」两颗按钮', async () => {
    await mount(withFailures([fetchFailure({ id: 11, meetingId: 'm-1' })]))
    const row = await screen.findByTestId('failure-row')
    expect(within(row).getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '忽略' })).toBeInTheDocument()
  })

  test('归档任务与整轮那种不给按钮——它们每轮自己判定、自己恢复', async () => {
    await mount(withFailures([
      failure({ id: 21, jobName: 'archive_nas', meetingId: 'm-2', reason: 'NAS 写入超时' }),
      fetchFailure({ id: 22, meetingId: null, target: '__round__', reason: '整轮没跑成' }),
    ]))
    const rows = await screen.findAllByTestId('failure-row')
    for (const row of rows) {
      expect(within(row).queryByRole('button', { name: '重试' })).toBeNull()
      expect(within(row).queryByRole('button', { name: '忽略' })).toBeNull()
    }
  })

  test('归并组给「全部重试」「全部忽略」，一次带上组内全部 id', async () => {
    const three = [11, 12, 13].map((id) => fetchFailure({ id, meetingId: `m-${id}` }))
    const { calls } = await mount(withFailures(three), acted(3))
    const row = await screen.findByTestId('failure-row')
    expect(row).toHaveAttribute('data-count', '3')
    await userEvent.click(within(row).getByRole('button', { name: '全部重试' }))
    const post = await waitFor(() => {
      const c = calls.find((x) => x.method === 'POST')
      expect(c).toBeDefined()
      return c!
    })
    expect(post.url).toContain('/jobs/failures/retry')
    expect(post.body).toEqual({ ids: [11, 12, 13] })
  })

  test('点完当场从表上消失，并重新拉一次 /admin/jobs', async () => {
    const { calls } = await mount(withFailures([fetchFailure({ id: 11, meetingId: 'm-1' })]), acted(1))
    const row = await screen.findByTestId('failure-row')
    await userEvent.click(within(row).getByRole('button', { name: '忽略' }))
    await waitFor(() => expect(screen.queryByTestId('failure-row')).toBeNull())
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBe(2))
  })

  // 乐观移除不能把一次失败演成一次成功：没做成，那一行必须回来。
  test('后端报错：行回来，并且说清是哪个动作、后端原话是什么', async () => {
    await mount(withFailures([fetchFailure({ id: 11, meetingId: 'm-1' })]), {
      runStatus: 500, runBody: { error: 'boom' },
    })
    const row = await screen.findByTestId('failure-row')
    await userEvent.click(within(row).getByRole('button', { name: '重试' }))
    // toast 是 role="status"（ui/Toast.tsx），按角色找到它再断言内容
    const toast = await screen.findByText(/重试没做成/)
    expect(toast).toBeInTheDocument()
    expect(toast.textContent ?? '').toContain('500')
    expect(screen.getByTestId('failure-row')).toBeInTheDocument()
  })

  test('一批里有几条没做成：两个数都说出来，不含糊成「部分成功」', async () => {
    const two = [11, 12].map((id) => fetchFailure({ id, meetingId: `m-${id}` }))
    await mount(withFailures(two), acted(1, [12]))
    const row = await screen.findByTestId('failure-row')
    await userEvent.click(within(row).getByRole('button', { name: '全部忽略' }))
    const toast = await screen.findByText(/另外 1 条没能处理/)
    expect(toast.textContent ?? '').toContain('忽略了 1 条')
  })

  test('detail 非空时有一个默认收起的「技术详情」，原文在里面', async () => {
    await mount(withFailures([fetchFailure({ id: 11, meetingId: 'm-1' })]))
    const row = await screen.findByTestId('failure-row')
    const details = within(row).getByTestId('failure-detail') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(row).getByText('技术详情')).toBeInTheDocument()
    expect(details).toHaveTextContent('video/r-1/mp4: http 404')
  })

  test('detail 是 null 就不画那个折叠——不留一个展开后空着的东西', async () => {
    await mount(withFailures([fetchFailure({ id: 11, meetingId: 'm-1', detail: null })]))
    const row = await screen.findByTestId('failure-row')
    expect(within(row).queryByTestId('failure-detail')).toBeNull()
  })
})
```

`stubApi` 目前只按 `method === 'POST'` 分流，这一族用例正好复用它（动作端点也是 POST）；把 `calls` 的记录扩成带 body：
```ts
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url: String(url), method, body: init?.body === undefined ? null : JSON.parse(String(init.body)) })
```
（已有用例只读 `url` / `method`，加一个字段不影响它们。）

- [ ] **Step 8: 跑它，确认红**

Run: `cd console && bunx vitest run tests/pages/Jobs.test.tsx`
Expected: FAIL——没有按钮、没有折叠。

- [ ] **Step 9: 改 `FailuresTable.tsx`**

1) import 补：
```ts
import {
  FAILURE_ACTION_LABEL,
  FAILURE_GROUP_ACTION_LABEL,
  FAILURE_GROUPS_PAGE,
  FAILURE_ITEMS_PAGE,
  actionableIds,
  attemptsText,
  failureCountsByJob,
  fmtAgo,
  groupAttemptsText,
  groupFailures,
  groupScopeText,
  hiddenFailureCount,
  targetView,
  type FailureActionKind,
  type FailureGroup,
} from './view'
```

（`isActionableFailure` **不**在这里 import：组件只用 `actionableIds`，判据本身收在
`view.ts` 里一处。多 import 一个没用到的名字会被 `tsc --noEmit` 挡下。）

2) 组件签名与 props：
```ts
export function FailuresTable({
  o,
  now,
  removedIds,
  onAct,
}: {
  o: JobsOverview
  now: number
  /** 已经乐观移除、等重取确认的失败项 id。放在页面那一层，理由见 `index.tsx` */
  removedIds: ReadonlySet<number>
  onAct: (action: FailureActionKind, ids: number[]) => void
}) {
```
`groups` 那个 memo 先滤掉已移除的：
```ts
  const groups = useMemo(() => {
    const base = o.failures.filter((f) => !removedIds.has(f.id))
    const list = activeFilter === null ? base : base.filter((f) => f.jobName === activeFilter)
    return groupFailures(list)
  }, [o.failures, activeFilter, removedIds])
```
（`counts` / `o.failures.length` 那两处保持读全量：那是「后端这一批有多少条」，与屏幕上乐观移除掉几条是两件事。）

3) 表头加一列，放在「如果不处理」之后：
```ts
                <th scope="col">如果不处理</th>
                {/* 「操作」而不是「动作」：这一列里是两颗按钮，不是一个状态 */}
                <th scope="col">操作</th>
```

4) `GroupRows` 加 props 并透传：
```ts
              {shown.map((g) => (
                <GroupRows key={g.key} g={g} label={labelOf(g.jobName)} base={base} now={now} onAct={onAct} />
              ))}
```
```ts
function GroupRows({ g, label, base, now, onAct }: {
  g: FailureGroup; label: string; base: Date; now: number
  onAct: (action: FailureActionKind, ids: number[]) => void
}) {
```
`GroupRows` 里加：
```ts
  const canAct = actionableIds(g)
```

5) 原因那一格加「技术详情」：
```ts
        <td className={styles.reason} data-label="原因">
          {g.reason}
          <FailureDetails g={g} />
        </td>
```

6) 新的操作格（接在「如果不处理」那一格之后）：
```ts
        <td className={styles.actions} data-label="操作">
          {/* 不可操作的行不给按钮：那种失败项每轮由各自的任务重新判定、自动恢复，
              一颗点下去只会回一句「这条没能处理」的按钮比没有按钮更糟。 */}
          {canAct.length > 0 && (
            <div className={styles.actionRow}>
              <Button size="sm" onClick={() => onAct('retry', canAct)}>
                {single ? FAILURE_ACTION_LABEL.retry : FAILURE_GROUP_ACTION_LABEL.retry}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => onAct('ignore', canAct)}>
                {single ? FAILURE_ACTION_LABEL.ignore : FAILURE_GROUP_ACTION_LABEL.ignore}
              </Button>
            </div>
          )}
        </td>
```

7) 展开明细那一行的 `colSpan` 从 6 改成 7。

8) 文件末尾加 `FailureDetails`，并把文件头那段「为什么每行没有『重试』按钮」整段换掉：

```ts
/**
 * 「技术详情」：原始报错，默认收起。
 *
 * 放在**组行**上而不是逐条明细里：归并键是「任务 + 原因 + 影响」，所以一组里
 * 每一条的人话原因逐字相同，不同的正是这一段——把它们摆在一起，运维一眼看得出
 * 「这 23 场是不是同一个毛病」。等宽字体、可换行：里面是 `video/r-1/mp4: http 404`
 * 这种东西，按正文排版会在标点处断得很难读。
 *
 * `detail` 全为 null 时**不画这个折叠**：一个展开之后空着的 `<details>` 比没有
 * 更糟——它承诺了一份并不存在的明细。
 */
function FailureDetails({ g }: { g: FailureGroup }) {
  const withDetail = g.items.filter((f) => f.detail !== null && f.detail !== '')
  if (withDetail.length === 0) return null
  return (
    <details className={styles.detailBox} data-testid="failure-detail">
      <summary className={styles.detailSummary}>技术详情</summary>
      {withDetail.map((f) => (
        <pre key={f.id} className={styles.detailText}>
          {targetView(f).name}
          {'\n'}
          {f.detail}
        </pre>
      ))}
    </details>
  )
}
```

文件头替换掉的那一段改成：

```
 * ## 每行的「重试」「忽略」（规格 2026-09-09 §2.3）
 *
 * 这两颗按钮从前不存在，理由写在这里：后端只有「跑一整轮任务」这一条写端点，
 * 把它伪装成行内的「重试」是一个名字和行为对不上的按钮。现在有了两条真的作用在
 * 一条失败项上的端点，那条理由不再成立。
 *
 * 但**只有一种失败项给按钮**：拉取任务按 dead 资产记的、带会议的那种
 * （`isActionableFailure`，判据与后端逐字相同）。归档、清理那几种失败项每轮由
 * 各自的枚举源重新判定、`resolveStaleFailures` 自动关掉——对它们「重试」没有
 * 对应的动作（下一轮本来就会再试），「忽略」是个假承诺（它下一轮还会回来）。
 *
 * 归并组上的是「全部重试」「全部忽略」，作用于**这一批下发下来的**组内失败项
 * （`actionableIds`）。被 `FAILURES_PAGE_LIMIT` 截掉的不在其中，表头上方那句
 * 「还有 N 条没有列出来」已经把这件事说清楚了。
```

- [ ] **Step 10: 改 `index.tsx`——动作的状态机与 toast**

import 补：
```ts
import { fetchJobs, ignoreFailures, newestFailedAt, retryFailures, runJob, type JobItem, type JobsOverview } from '@/api/admin/jobs'
import { Toast } from '@/ui/Toast'
import { failureActionErrorText, failureActionSkippedText, ... } from './view'
import type { FailureActionKind } from './view'
```

`JobsPage` 里，`onRun` 之后加：

```ts
  /**
   * 已经乐观移除、等重取确认的失败项 id。
   *
   * 放在 `JobsPage` 而不是 `Ready`：`retry()` 会把资源打回 loading，`Ready` 因此
   * 卸载重建，state 放在它里面会丢。（loading 期间整张表本来就不在屏幕上，所以
   * 那一瞬间没有可闪的东西。）
   */
  const [removedIds, setRemovedIds] = useState<ReadonlySet<number>>(() => new Set())
  const [toast, setToast] = useState<string | null>(null)

  const showToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(null), 4200)
  }, [])

  const onAct = useCallback(
    (action: FailureActionKind, ids: number[]) => {
      // 先移除再发请求：这两条端点是两句 UPDATE，快得看不见，但网络不是。
      // 点下去屏幕上什么都不变，看起来像按钮坏了——同 `onRun` 那句 note 的理由。
      setRemovedIds((prev) => new Set([...prev, ...ids]))
      const call = action === 'retry' ? retryFailures : ignoreFailures
      void call(ids)
        .then((r) => {
          if (r.skipped.length > 0) {
            showToast(failureActionSkippedText(action, r.affected, r.skipped.length))
          }
          // 重取会带回真相（没做成的那几条还在里面），乐观移除到此为止
          setRemovedIds(new Set())
          retry()
        })
        .catch((e: unknown) => {
          // 没做成就必须让行回来：乐观移除不能把一次失败演成一次成功
          setRemovedIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))))
          showToast(failureActionErrorText(action, e instanceof Error ? e.message : String(e)))
        })
    },
    [retry, showToast],
  )
```

`Ready` 的调用与签名各加两个参数，`<FailuresTable o={o} now={o.now} removedIds={removedIds} onAct={onAct} />`；`JobsPage` 的返回里 `PageShell` 内末尾加：
```ts
      <Toast open={toast !== null} onClose={() => setToast(null)} message={toast ?? ''} />
```

- [ ] **Step 11: 补两条 CSS**

`console/src/pages/Jobs/Jobs.module.css`，接在 `.impactCell` 之后：

```css
/* 操作格：两颗小按钮，窄屏（卡片模式）下换行不挤 */
.actions {
  white-space: nowrap;
}

.actionRow {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}

/* 「技术详情」：原始报错，默认收起。等宽 + 可换行——里面是
   `video/r-1/mp4: http 404` 这种东西，按正文排版会在标点处断得很难读。 */
.detailBox {
  margin-top: var(--s-2);
}

.detailSummary {
  cursor: pointer;
  font-size: var(--t-2xs);
  color: var(--ink-3);
}

.detailText {
  margin: var(--s-2) 0 0;
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: var(--t-2xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 12: 给原型模式补两个端点**

`console/src/api/mock/install.ts`，在 `jobRun` 那一段之后加：

```ts
  // 失败项动作。原型里没有真的资产队列，所以它只回一个诚实的形状：
  // 认得出的 id 算做成了，认不出的进 skipped。**不假装改了什么** ——
  // 下一次 GET /jobs 仍然由 buildJobs 现算，那批失败项还在，这正是原型该有的样子
  // （它演的是界面，不是后端的状态机）。
  const failureAction = /^\/api\/v1\/admin\/jobs\/failures\/(retry|ignore)$/.exec(path)
  if (failureAction && method === 'POST') {
    const ids = Array.isArray((body as { ids?: unknown })?.ids) ? ((body as { ids: unknown[] }).ids) : []
    const known = new Set(buildJobs(nowSec, snapshot()).failures.map((f) => f.id as number))
    const skipped = ids.filter((id): id is number => typeof id !== 'number' || !known.has(id))
    return json({ affected: ids.length - skipped.length, skipped })
  }
```
（`body` 是该文件里已解析好的请求体变量；照抄它在别处的取法。）

- [ ] **Step 13: 跑控制台全套**

Run:
```
cd console && bunx vitest run tests/pages/Jobs.test.tsx tests/pages/JobsView.test.ts tests/api/jobs.test.ts tests/mock.test.ts tests/mock-pages.test.ts && bunx tsc --noEmit && bun scripts/a11y-check.ts
```
Expected: PASS（a11y 检查关注新按钮的触控尺寸与对比度；不过再回来调 CSS）。

- [ ] **Step 14: 提交**

```bash
git add console/src/api/admin/jobs.ts console/src/api/mock/install.ts \
        console/src/pages/Jobs/view.ts console/src/pages/Jobs/FailuresTable.tsx \
        console/src/pages/Jobs/index.tsx console/src/pages/Jobs/Jobs.module.css \
        console/tests/api/jobs.test.ts console/tests/pages/JobsView.test.ts console/tests/pages/Jobs.test.tsx
git commit -m "feat(console): 失败项可重试/忽略，原始报错收进「技术详情」折叠"
```

---

## Task 7：文档——spec §4.8 改写 + 上线 runbook

**Files:**
- Modify: `docs/console/spec.md`（§4.8 那两条）
- Create: `docs/2026-09-09-jobs-failures-rollout.md`

**Interfaces:** 无代码接口。这个任务的验收是「文档说的与代码做的一致」。

- [ ] **Step 1: 改 `docs/console/spec.md` §4.8**

把 `- 页顶两条横幅各说一件事。…` 那一条整条替换成：

```markdown
- 页顶两条横幅各说一件事，**两条都能关，关的都只是"眼前这一段"**。
  「N 个任务已经落后」意味着调度器多半不在跑了，关掉的是**这一批落后**（身份 =
  落后任务按名字排序后拼成的 `<name>@<lastRunId>`，存 `mde.jobs.overdue.dismissed`）
  ——任一落后任务再跑一轮、或落后集合变了，它就回来。
  「最近 N 轮拉取连续失败」写观察、能做什么、超过拉取窗口要人工补拉，关掉的是
  **这一段故障**（身份 = 最新那次 failed 运行的 id），又失败一轮就回来。
  后者只在这一页显示，不进顶栏的全局状态条，理由见 §7.1
```

在「失败项按『任务 + 原因 + 影响』归并显示…」那一条之后插入两条新的：

```markdown
- **失败项的原因是一句人话**（「录像：腾讯那边没有这个文件」），原始报错在同一格里
  一个默认收起的「技术详情」折叠中。两者分列不是排版偏好：归并键就是那句原因，
  原始报错里带着 remote_id 与本地路径，留在原因里会让一轮拉取里 23 场同一件事的
  会议变成 23 行。翻译口径在 `src/worker/failure-text.ts`
- **拉取任务的失败项能单独处理**：行上是「重试」「忽略」，归并组上是「全部重试」
  「全部忽略」。重试把那场会议的 failed/dead 资产打回下载队列并清零重试计数；
  忽略把 dead 判成「不用管了」（`skipped/ignored_by_admin`），下一轮不再登记。
  两个动作都要管理员写权限、都留审计。**其余任务的失败项不给按钮**——它们每轮
  由各自的枚举源重新判定、自动恢复，一颗点下去只会回一句「这条没能处理」的按钮
  比没有按钮更糟
```

- [ ] **Step 2: 写 runbook**

新建 `docs/2026-09-09-jobs-failures-rollout.md`：

```markdown
# 2026-09-09 上线：失败项可重试/忽略、404 判永久缺失、横幅可关

规格：`docs/superpowers/specs/2026-09-09-jobs-failures-actions-design.md`

## 0. 前置

- 这一批**不改任何已落盘的文件、不删任何东西**，只加一列、改几条状态流转。不需要停机备份磁盘。
- 库还是要备一份：`mysqldump <db> job_failures meeting_assets > backup-jobs-2026-09-09.sql`。
- 与「周期会议按录制记录拆场次」那一批**互不重叠**，先后顺序随意；两批都上完再做第 4 步的收敛。

## 1. 部署

    git pull && bun install && bun run typecheck
    cd console && bun run build && cd ..

迁移 `migrations/014_job_failures_detail.sql` 在网关/调度器启动时自动跑（`runMigrations`），
它只做一件事：`job_failures` 加一列 `detail TEXT NULL`。守卫是幂等的，重跑安全。

先起网关，再起调度器。启动日志里不该有 `mig014` 相关的报错。

## 2. 确认新列到位

    SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_failures' AND COLUMN_NAME = 'detail'

出一行就对了。存量失败项的 `detail` 是 NULL——它们是上一版写的，没有明细，
界面上不画「技术详情」折叠。下一轮拉取跑完之后，仍然 dead 的那些会被重记一遍，
`reason` 换成人话、`detail` 补上原文。

## 3. 看一轮拉取

等一轮（或者在「定时任务」页点「立即运行」）。跑完看失败项表：

- 原因那一列应该已经是「录像：腾讯那边没有这个文件」这种句子，不再是 `ENOENT: …` 一长串
- 同一件事的会议应该归并成一行，「涉及」那一格写着「N 场会议」

## 4. **把存量的 33 条 dead 404 收敛掉**

这一步必须做，它是这一批改动落地的最后一环。

规格 §2.2 定的是：**不写数据迁移**，靠界面上的一次「全部重试」把它们打回队列，
下一轮拉取重新试一次——这一次下载器会在 404 上换一条新链再试，第二次仍 404 就
判永久缺失，资产落成 `skipped/upstream_missing`，失败项自然消失。

操作：

1. 打开控制台「定时任务」页，找到原因是「录像：腾讯那边没有这个文件」的那一组
   （屏幕上写着「33 场会议」这种数字）
2. 点这一组的 **「全部重试」**
3. 等下一轮拉取跑完（每 15 分钟一轮，也可以在拉取那张卡片上点「立即运行」）

跑完之后核对：

    SELECT status, last_error, COUNT(*) FROM meeting_assets
     WHERE last_error IN ('http 404', 'upstream_missing') GROUP BY status, last_error

期望：`skipped / upstream_missing` 一批，`dead / http 404` 归零。

    SELECT COUNT(*) FROM job_failures WHERE resolved_at IS NULL AND job_name = 'fetch_recordings'

期望：只剩真正需要人处理的那几条（本机实测是 ENOENT 那一小撮，引擎已修，
重试一次就该成功）。

**如果重试之后它们又变回 dead**，说明下载器那条 404 分支没有生效——去看一轮 worker
日志里那几条资产的 `last_error`：应该是 `http 404` 且状态是 `skipped`。仍是 `dead`
就回滚代码（这一批没有不可逆动作），别继续点。

## 5. 顺手验一下另外两件事

- 「归档到 NAS」那张卡片如果是「已经落后」，页顶横幅右上角现在有一个 ×。点掉它，
  刷新页面不该回来；在那个任务上点一次「立即运行」（它会多一轮运行记录），
  横幅应该回来。
- 随便找一条拉取失败项点「忽略」，那一行当场消失；去库里看那场会议的资产应该是
  `skipped / ignored_by_admin`。这一步做完记得在「操作审计」页确认有一条
  「忽略一条失败项」的记录，操作者是你。

## 6. 回滚

代码回滚即可，`detail` 那一列留着不碍事（旧代码不读它，也不写它）。
第 4 步已经跑过的话，那些资产已经是 `skipped/upstream_missing`——那是一个正确的
终态，回滚之后它们也不会变回 dead，不需要额外处理。
```

- [ ] **Step 3: 核一遍文档与代码是否对得上**

逐条对照：`mde.jobs.overdue.dismissed`、`upstream_missing`、`ignored_by_admin`、
两个端点路径、两个审计标签的字（「重试一条失败项」/「忽略一条失败项」）、
`src/worker/failure-text.ts` 的路径——都要与代码里的一致。

- [ ] **Step 4: 跑一次全量门槛**

Run:
```
bun run typecheck
cd console && bunx tsc --noEmit && bunx vitest run && bun scripts/a11y-check.ts
```
Expected: PASS。（网关与引擎的库在前六个任务里已各自跑过；这里不再跑全量，
按要求不做整仓库测试。）

- [ ] **Step 5: 提交**

```bash
git add docs/console/spec.md docs/2026-09-09-jobs-failures-rollout.md
git commit -m "docs: 定时任务页失败项动作与横幅可关的规格改写与上线 runbook"
```

---

## 自查（写完之后按规格重读一遍的结果）

**规格覆盖**

| 规格条目 | 落在哪个任务 |
| --- | --- |
| §2.1 落后横幅可关、身份字符串、`useDismissedBanner` 泛化、新键、可访问名、spec 改写 | Task 5（改写在 Task 7） |
| §2.2 `DownloadResult.permanent`、404 换链一次、`markSkipped('upstream_missing')`、存量靠重试收敛 | Task 1（收敛写在 Task 7 的 runbook 第 4 步） |
| §2.3 两个端点、body/响应形状、可操作判据、两个 Store 方法、审计两个动作、控制台行级与组级按钮、乐观移除 + 重取 + toast | Task 4（后端）、Task 6（前端） |
| §2.4 迁移 014、`failure-text.ts` 五条翻译、`deadAssetsReason` / `deadAssetsDetail`、`recordDeadAssets` 改写、`detail` 贯穿到控制台、「技术详情」折叠、归并键不变 | Task 2（列与契约）、Task 3（文本与写侧）、Task 6（折叠） |
| §2.5 不做的那几件（已恢复历史、7 天统计、时间截断、整轮重跑按钮） | 无任务——本计划一件都不做 |
| §3 验收 | Task 7 的 runbook 第 3–5 步逐条对应 |

**规格里没写、我在这里定下来的四件事**（执行时按这里的写法，别再自行发挥）：

1. **`DeadAsset` 要加 `remoteId` / `fileType`**。规格的 `deadAssetsDetail` 要
   `<asset_type>/<remote_id>/<file_type>`，而 `deadAssets()` 现在只取四列。
   在 Task 3 里扩这个接口与那一条 SQL。
2. **`deadAssetsReason` 的去重键是整句（类型 + 人话），不是只看资产类型**。规格写
   「按资产类型去重」，但同一类资产两种不同的错（一段录像 404、另一段磁盘满）是
   两件事、两种处置，只按类型去重会丢掉后一句。
3. **审计逐条一行，不是一批一行**。规格说「`target` = 失败项 target，明细含 ids 数」
   ——一批里有多个 target，只能逐条一行才写得出各自的 target；`batchSize` 进
   `detail` 的结构化那一段。先例是 `purge_local`（逐场一条）。
4. **`AuditAction` 的联合类型在 `src/audit/actions.ts`**（`AUDIT_ACTION_LABELS` 的键），
   不在 `src/store/audit.ts`（那里 `action` 是 `string`）。镜像清单在
   `tests/audit/actions.test.ts` 的 `WRITTEN_ACTIONS`，三处一起改。
```
