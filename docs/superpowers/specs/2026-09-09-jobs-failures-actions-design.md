# 定时任务页：落后横幅可关、404 判永久缺失、失败项可重试/忽略、原因用人话 — 设计裁定

日期：2026-09-09。前置：`docs/superpowers/specs/2026-09-09-recurring-meetings-by-record-design.md`（周期会议按录制记录拆场次）先落地——失败项按 (meeting_id, sub_meeting_id) 记，拆开之后天然按场次。

## 1. 事实（2026-09-09 本机实测）

- 本机库 `job_failures` 29 条未恢复，全是 `fetch_recordings` 的「下载重试用尽，已放弃」（dead 资产）。其中 23 场是「转写_」录制记录的 video HTTP 404（腾讯没有这个文件，永远拉不到），其余是逐字稿空文件导致的 ENOENT（引擎已修，commit bff6004）。
- dead 资产每轮被 `recordDeadAssets` 重新登记，所以失败项永远不会自动「恢复」；控制台没有任何按钮能作用于一条失败项。
- `reason` 列直接拼原始报错（`ENOENT: no such file or directory, open '/Users/…/transcript_3.txt.part'`），路径还是改名前的旧路径。
- 顶部「N 个任务已经落后」横幅（`jobs-overdue`）按 spec §4.8 不能关；「最近 N 轮拉取连续失败」（`jobs-fetch-stalled`）能关，关的是「这一段故障」（`console/src/pages/Jobs/dismiss.ts`）。
- 引擎下载器（`packages/engine/src/downloader/index.ts`）对 403/410 换链续传，对 5xx 换链重试，其他非 200/206 一律 `failed: http <status>`；执行器 5 次后 dead。
- `Store.resetFailed`（`src/worker/store-mysql.ts:294`）把 failed/dead 打回 pending 但**不清 attempts**；回队列后 `claimNext` 再 +1，第一次失败就 `attempts >= MAX_ATTEMPTS` 又 dead。

## 2. 裁定

### 2.1 「N 个任务已经落后」横幅可关（只改控制台）

- 与黄色横幅同一套机制：关的是**这一段落后**。身份字符串 = 落后任务按名字排序后，每个拼成 `<name>@<lastRunId ?? 'none'>`，用 `|` 连接。
- `dismiss.ts` 泛化成 `useDismissedBanner(storageKey, identity: string | null)`：`identity === null`（没有落后）时删掉存储键；identity 与存储值相等时 `hidden = true`；`dismiss()` 写入当前 identity。现有 `useDismissedStall` 改为基于它实现，行为逐字不变（storageKey 仍是 `mde.jobs.fetch-stall.dismissed`，identity 仍是 `String(latestFailedRunId)`）。
- 新键 `mde.jobs.overdue.dismissed`。任一落后任务再跑一次（lastRunId 变）、或落后集合变化，身份就变、横幅回来。
- 关闭按钮的可访问名「关闭这条提醒」与黄色那条相同；两条同时在时靠 `data-testid` 区分测试。
- 卡片上的红字「已经落后」不动。`docs/console/spec.md` §4.8 那句「不能关」改为「可以关，关的是这一段落后；任一任务再跑就回来」。

### 2.2 下载 404 = 平台没有这个文件（引擎）

- `DownloadResult` 的 failed 分支加 `permanent?: true`。下载器遇到 404：第一次换新链接再试一次（与 403/410 同一条换链路径，但**不保留** size，`discardPart`）；第二次仍 404 → `{ status: 'failed', error: 'http 404', permanent: true }`。
- 执行器：`res.permanent === true` → `markSkipped(row.id, 'upstream_missing', now)`，`result.skipped++`，不进 failed 计数、不进 dead。
- 对所有资产类型一视同仁；`skipped` 不计入「completed 数 > archived 数」的归档判定，所以转写记录的 video 不再拖住会议的「已归档」。
- 存量 33 条 dead 404 行：不写迁移，靠 2.3 的「重试」打回队列，下一轮拉取自然收敛成 `skipped`。上线 runbook 写明这一步。

### 2.3 失败项动作：重试 / 忽略（网关 + 控制台）

- 两个批量端点，body `{ ids: number[] }`（`job_failures.id`，1–100 个），响应 `{ affected: number, skipped: number[] }`（skipped = 找不到、已恢复、或不是可操作的失败项）：
  - `POST /api/v1/admin/jobs/failures/retry`
  - `POST /api/v1/admin/jobs/failures/ignore`
- **可操作的失败项**只有一种：`job_name = 'fetch_recordings'` 且 `meeting_id IS NOT NULL` 且 `resolved_at IS NULL`（即 `recordDeadAssets` 记的那种）。其他任务的失败项每轮自己判定、自己恢复，端点对它们返回 skipped。
- 重试：`UPDATE meeting_assets SET status='pending', attempts=0, last_error=NULL, lease_expires_at=NULL, updated_at=? WHERE meeting_id=? AND sub_meeting_id=? AND status IN ('failed','dead')`（新增 `Store.retryMeetingAssets(key, now)`，现有 `resetFailed` 不动，CLI 照旧）；随后 `job_failures.resolved_at = now`。再失败会重新登记、重新出现。
- 忽略：`UPDATE meeting_assets SET status='skipped', last_error='ignored_by_admin', lease_expires_at=NULL, updated_at=? WHERE meeting_id=? AND sub_meeting_id=? AND status='dead'`（新增 `Store.ignoreDeadAssets(key, now)`）；随后 `resolved_at = now`。资产不再是 dead，下一轮不会被重新登记。
- 两个端点都要管理员写权限（与 `runJob` 同一 `requireAdminWrite`），都写审计（`action` = `job_failure_retry` / `job_failure_ignore`，`target` = 失败项 target，明细含 ids 数）。
- 控制台 `FailuresTable`：可操作的行给「重试」「忽略」两个 `Button`（size sm）；归并组给「全部重试」「全部忽略」，作用于组内屏幕上这一批失败项的 id（被截断的不在屏幕上就不在动作里，表头已有「显示 N 条」提示）。点击后乐观移除该行/组并重新拉 `GET /admin/jobs`；失败时 toast 报错、行回来。不可操作的行不显示按钮。

### 2.4 原因用人话，原始报错折叠（网关 + 控制台）

- 迁移 `014_job_failures_detail.sql`（013 归周期会议那份规格）：`ALTER TABLE job_failures ADD COLUMN detail TEXT NULL` —— 原始技术信息，`reason` 从此只放人话。
- `src/worker/failure-text.ts`（新）：
  - `describeDownloadError(lastError: string | null): string`，按前缀匹配：`http 404` → `腾讯那边没有这个文件`；`http 5` 开头或 `too many link renewals` → `腾讯下载服务出错`；含 `ENOENT` / `EACCES` / `ENOSPC` → `本地写入失败`；`size mismatch` 开头 → `下载不完整`；null / 其他 → `下载失败`。
  - `deadAssetsReason(assets)`：`<中文资产名>：<人话>`，按资产类型去重后用 `；` 连接，例：`录像：腾讯那边没有这个文件；逐字稿：本地写入失败`。中文资产名来自 `src/domain/asset-labels.ts`。
  - `deadAssetsDetail(assets)`：`<asset_type>/<remote_id>/<file_type>: <lastError>` 每项一行。
- `recordDeadAssets` 改为 `reason = deadAssetsReason(...)`，`detail = deadAssetsDetail(...)`；`ctx.fail` / `JobsStore.recordFailure` 加 `detail?: string | null`；`listFailures` 带出 `detail`；`GET /admin/jobs` 的 `failures[].detail: string | null`（`console/src/api/admin/jobs.ts` 与 mock 同步）。
- 控制台原因列显示 `reason`；`detail` 非空时行内一个「技术详情」展开（`<details>`，等宽字体、可换行），默认收起。归并键不变（任务 + 原因 + 影响）。
- 归档任务等其他失败项的 reason 不改（它们本来就是一句话）。

### 2.5 不做

- 已恢复的历史不上表；不加「最近 7 天已恢复 N 条」；不按时间截断。
- 不给单条失败项加「重试」以外的重跑整轮按钮（卡片上已有「立即运行」）。

## 3. 验收

- 本机：调度器跑一轮后，失败项表只剩真正需要人处理的行；对「23 场会议」点「全部重试」，下一轮拉取后它们消失、对应 video 行为 `skipped/upstream_missing`；ENOENT 那几条点「重试」后成功。
- 落后横幅能关，`立即运行`一个落后任务后横幅回来。

## 4. Entity delta

+1 迁移（`detail` 列）/ +2 管理端点 / +2 Store 方法 / +1 模块 `failure-text.ts` / `DownloadResult.permanent` 字段 / `useDismissedBanner` 泛化。不加配置、不加依赖。
