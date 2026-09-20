# 网关对采集程序改出已存数据（设计与实施计划）

日期 2026-09-20。状态：用户已认可方向（列会议、列资产改读库；文件由网关直出本地归档）。

## 1. 问题

采集程序（`mde` CLI）走的三个端点今天全部实时调腾讯会议：

| 端点 | 今天 | 代价 |
|---|---|---|
| `GET /api/v1/meetings?from&to` | `corp.listRange` 全窗口枚举 `/v1/corp/records`，每次请求、每一页游标都重新枚举 | 10 次/分配额，每页 20 场；31 天窗口要几分钟，2026-09-20 生产实测请求被静默切断 |
| `GET /api/v1/meetings/:id/assets` | `catalog.listAssets` 打 `/v1/addresses` + `/v1/smart/*` | 每场至少 1 次，60 次/分 |
| `POST /api/v1/assets/:id/download-url` | `catalog.resolveDownloadUrl` 打 `/v1/addresses` | 每个资产 1 次；文件从腾讯 CDN 下 |

而调度器（`src/worker/scheduler.ts`）每 15 分钟已经把最近 24 小时的会议写进 `meeting_cache` 与 `meetings`，把资产下载到 `MDE_ARCHIVE_ROOT` 并在 `meeting_assets` 标 `completed`，每小时再归档到 NAS。网关手里就有全部数据，却每次都去问腾讯。

## 2. 目标

采集程序的整条链路只碰网关和网关的库与盘，零腾讯调用。腾讯只由调度器调。`mde` CLI 与线上契约（路径、响应字段、`next_cursor`、错误码）不变，客户端不用改。

## 3. 设计

### 3.1 数据形状

三张既有表，不新增表、不改 schema：

- `meeting_cache`（PK `meeting_record_id`）：网关 `Meeting` 域类型需要的全部字段（含 `state`、`record_type`）。调度器每轮经 `createRecordsApi` 写透。范围列表新增按 `start_time` 范围读。
- `meeting_assets`（`status='completed'` 且 `target_path` 非空）：`asset_id`（网关格式 `<meetingRecordId>:<recordFileId>:<assetType>:<selector>`）、`asset_type`、`remote_id`、`file_type`、`bytes_expected`、`target_path`（相对 `MDE_ARCHIVE_ROOT`）。
- `archived_assets`（`nas_path`）：本地副本被保留策略清掉后（`meeting_archives.local_purged_at`）的回退来源。

### 3.2 模块划分

1. `MeetingCacheStore.listByRange(from, to)`：`WHERE start_time BETWEEN ? AND ? ORDER BY start_time DESC, meeting_record_id ASC`。用现有 `idx_meeting_cache_code`/新索引不必；`start_time` 已有 `(meeting_code, start_time)` 复合索引，行数在万级，全表扫可接受；若要加索引写迁移 017 `idx_meeting_cache_start (start_time)`。
2. `createStoredRecordsApi(cache): RecordsApi`（放 `src/store/meetings.ts` 旁边，或 `src/store/stored-records.ts`）：
   - `range` → `cache.listByRange`。
   - `code`/`id` → 只查缓存（现有 `listByMeetingCode`/`listByMeetingId`，会议号先 `normalizeMeetingCode`，把这个函数从 `tencent/records.ts` 导出）；未命中抛 `MeetingNotFoundInRangeError`，但 message 换成"网关存储里没有这场会议：调度器每 15 分钟拉最近 24 小时（`MDE_SCHEDULER_FETCH_LOOKBACK_HOURS`），更早的会议要在控制台或调度器补跑窗口"。因此 `MeetingNotFoundInRangeError` 构造改为接受 note 参数（或拆两个错误类型共用 name），`client/src/gateway/client.ts` 里的注释同步改。
   - 网关进程（`src/index.ts`）用它；调度器（`scheduler.ts` 941 行）继续用 `createRecordsApi`（活路）。`createRecordsApi` 的范围/精确写透逻辑不动。
3. `listAssets` / `getMeeting` 处理器：`catalog.listAssets(meeting)` 换成 `archivesStore.listCompletedAssets(meeting.meetingId, meeting.subMeetingId)` 映射为 `Asset`（`assetId=row.asset_id`，`recordFileId=remote_id`，`allowDownload=true`，`fileType`、`bytesExpected` 原样）。`asset_id` 为 NULL 的行跳过并 warn（老数据）。`CompletedAssetRow` 需带上 `asset_id` 列。策略过滤 `filterAssetsByDecision` 与审计不变。
4. `downloadUrl` 处理器：策略判定通过后，用 `assetId` 查 `meeting_assets`（新方法 `archivesStore.findCompletedAssetByAssetId(assetId)`，返回 `target_path` 与会议键）。没有 → 404 `asset_not_found`。有 → 返回
   `{ url: <gatewayBaseUrl>/api/v1/assets/<assetId>/content?token=<t>, expires_at }`，`t` 由 `auth/tokens.ts` 新增 `signDownloadToken({assetId, exp}, secret)` / `verifyDownloadToken` 生成（HMAC-SHA256，沿用 `b64u`/`hmac`，有效期 15 分钟，与 `expires_at` 一致）。审计 `recordDownloadUrl` 不变。
5. 新路由 `GET /api/v1/assets/:assetId/content?token=`：
   - 不走 Bearer（引擎下载器只 `fetch(url, {headers:{range}})`）；校验 token 的签名、过期与 `assetId` 一致，失败 403。
   - 解析文件：`join(localArchiveRoot, target_path)`，必须 `resolve` 后仍在根目录内（防穿越）；本地不存在时查 `archived_assets.nas_path`，同样做根目录包含检查（`nasRoot`）；都没有 → 404 `asset_not_found`。
   - 支持 `Range: bytes=N-`：206 + `Content-Range` + `Content-Length`，用 `Bun.file(path).slice(start)`；无 Range 200。设置 `Content-Type` 由 `Bun.file` 推断，`Accept-Ranges: bytes`。
   - `AppDeps` 新增 `localArchiveRoot: string | null`、`nasRoot: string | null`（`src/index.ts` 160 行附近已读了 `MDE_ARCHIVE_ROOT`）；为 null 时该端点 503 `archive_root_unconfigured`。
6. 删除：网关 `AppDeps.catalog` 及 `src/index.ts` 里网关侧的 `createCatalog`/`addressesApi`/`smartApi` 装配（先确认没有别的处理器用）。`TencentClient` 在网关进程若只剩 `tm_users` 身份映射用，保留。

### 3.3 行为约定

- 范围列表现在是"调度器已经存下来的会议"，不是"腾讯此刻有的会议"。首次上线后 24 小时以前的会议要靠调度器补跑窗口，这一点写进 `GET /api/v1/meetings` 的 doc 注释与 README 的采集程序一节。
- 资产清单只含已 `completed` 的资产。引擎 `judgeReadiness` 对"缺席"的类型按 `wait` 处理，到 `end_time + 各类等待上限` 才 `skip_timeout`，与今天腾讯侧"还没转码完"的语义一致，`mde run` 下一轮会补上。
- `download-url` 的 `expires_at` 语义不变。

### 3.4 测试

- `tests/store/meetings.test.ts`（或现有 store 测试）：`listByRange` 边界含头含尾、排序。
- 新 `tests/store/stored-records.test.ts`：range 直读缓存零 Tencent 调用；code 带横杠归一；未命中报错 message 含"调度器"提示。
- `tests/http/meetings.test.ts` 与 `tests/e2e/flow.test.ts`：范围列表、资产清单、download-url 三段改为向库里种数据（`createMeetingCacheStore.upsertMany` + `createMysqlStore.upsertAsset` + 直接 `UPDATE meeting_assets SET status='completed', target_path=?`），在临时目录放真实文件，断言 `/v1/corp/records`、`/v1/addresses` 的桩**一次都没被调用**；content 端点断言 200 全量、206 Range 续传、坏 token 403、穿越路径 404、本地被清后回退 NAS。
- `tests/tencent/records.test.ts` 的活路用例保留（调度器仍用）。
- `client/tests` 不动（契约未变）。跑 `bun test` 全量 + `bunx tsc --noEmit`。

### 3.5 部署

网关、调度器两个容器都要重建（共享代码），命令交用户在面板里贴：

```
cd /opt/mde/app && git pull && docker compose --env-file /opt/mde/.env build gateway scheduler && docker compose --env-file /opt/mde/.env up -d --no-deps gateway scheduler
```

上线后本机 `set -a; . ~/.mde-prod.env; set +a; mde run --out …` 验证整条链路。

## 4. 任务拆分（顺序执行，每步测试绿再进下一步）

1. store 层：`listByRange`、`CompletedAssetRow.assetId`、`findCompletedAssetByAssetId`；`createStoredRecordsApi`；`MeetingNotFoundInRangeError` 的 note 参数；对应单测。
2. HTTP 层：三个处理器改读库；`signDownloadToken`/`verifyDownloadToken`；content 路由与 Range；`AppDeps` 增删字段；`src/index.ts` 装配；`tests/http/testApp.ts` 跟着改；重写受影响的 http 与 e2e 用例。
3. 收尾：README 采集程序一节与相关 doc 注释；`client/src/gateway/client.ts` 注释；`/deslop`；全量测试；提交。
