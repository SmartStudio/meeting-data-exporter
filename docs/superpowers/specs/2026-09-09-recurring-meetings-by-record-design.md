# 周期会议按录制记录拆场次 — 设计裁定

日期：2026-09-09。依据：2026-09-09 本机实调 + 代码事实清单。

## 1. 事实

- 腾讯 `/v1/corp/records` 的每条记录带 `meeting_record_id`（每个场次一条）与 `meeting_id`（周期会议所有场次共用），**没有 `sub_meeting_id`**。`src/tencent/records.ts` 的 `toMeeting` 写死 `subMeetingId: ''`。
- 全库九张表按 `(meeting_id, sub_meeting_id)` 认「一场会议」：`meetings`、`meeting_assets`、`meeting_asset_probes`、`archived_assets`、`meeting_archives`、`meeting_grants`、`meeting_overrides`、`asset_contents`、`job_failures`（`target = meetingId|subMeetingId`）。`meeting_cache` 以 `meeting_record_id` 为主键，是唯一已经按场次存的表。`audit_log` 没有 sub 列，把它编进 `asset_id`（`sub:<subMeetingId>`，只有延长保留期一种写入）。
- 后果（本机库）：86 场「会议」装着 232 条录制记录，销售日会 6 个场次 = 36 个资产一行；`Store.meetingsForPaths()` 只按 `meeting_id` 建 Map，所有场次的文件落进某一个场次的目录（`store-mysql.ts:311` 的注释承认了这个洞）；授权、归档状态、保留期、失败项都按整串算。
- `meeting_assets.asset_id` 形如 `<meetingRecordId>:<recordFileId>:<assetType>:<selector>`，**每一行都带着自己场次的 record id**，存量数据可以据此回填。`remote_id` = `record_file_id`。
- 目录命名 `<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<code>` 按会议 `startTime` 起名；各场次 start_time 不同，目录天然分开——命名规则不用改，改的是喂给它的 Map。**「各场次 start_time 不同」这个前提实测不成立**：腾讯常给同一场会议一条正常录制 + 一条主题带「转写_」前缀的孪生记录，两者 `media_start_time` 完全相同（本机库 294 场里 84 组），它们会算出同一个目录——补救办法见 §2.3 的补充。
- 文件名后缀 `_2/_3` 来自 `siblingRank`：同 `(meeting_id, sub_meeting_id, asset_type, file_type)` 组内按 id 排序的序号。拆开之后组变小，存量文件名会变（`transcript_5.txt` → 自己目录里的 `transcript.txt`）。
- 引擎 `AssetSource.listAssets(meetingId, from?, to?)` 只带 meeting_id；进程内实现把同 meeting_id 的所有记录的资产**并起来**返回（`source-inproc.ts:88`）。拆开后若不收窄，每个场次都会把全部场次的资产各存一份。
- 控制台管理端已经全程两段键（`consoleMeetingId = enc(mid)[,enc(sub)]`，`?sub=`，body `subMeetingId`），列表、计数、抽屉不需要改就会一场次一行。公开 API `GET /api/v1/meetings/:id` 与 `/assets` 没有 sub 参数，多条记录取 `startTime` 最新的一条。
- CLI 用引擎的 SQLite store，同样调 `meetingsForPaths()`，同一个洞；它通过 HTTP 网关取资产清单。

## 2. 裁定

### 2.1 身份：`sub_meeting_id = meeting_record_id`，一律如此

- `toMeeting`：`subMeetingId: r.meeting_record_id`。不区分「周期会议」与「单次会议」——单次会议也只有一条记录，规则统一，没有特例。
- `meeting_cache.sub_meeting_id` 同样写 `meeting_record_id`（`upsertMany`），列保留，含义与主键一致。
- 引擎 `Meeting.subMeetingId` 因此就是场次 id；`toEngineMeeting` 不用改签名。
- `job_failures.target`、`consoleMeetingId`、`archiveStateKey`、`overrideKey` 等编码全部沿用（record id 是纯数字，分隔符安全）。

### 2.2 资产清单按场次收窄

- 引擎 `AssetSource.listAssets(meetingId, subMeetingId, from?, to?)`——加第二个位置参数。`discover` 传 `m.subMeetingId`，`runProbes` 传 `p.sub_meeting_id`。
- 进程内实现（`source-inproc.ts`）：`meetingsById` 命中多条时只保留 `meetingRecordId === subMeetingId` 的那条；`subMeetingId === ''` 时保留全部（旧 CLI 库、旧探测行的兼容口径，逐步自然消失）。
- 公开 API：`GET /api/v1/meetings/:meetingId` 与 `GET /api/v1/meetings/:meetingId/assets` 加可选 query `sub_meeting_id`；给了就取 `meetingRecordId` 相等的那条，没命中回 404 `meeting_not_found_in_range`；没给保持「取最新一条」。CLI 的网关客户端 `listAssets` 带上 `sub_meeting_id`。

### 2.3 目录 Map 按两段键

- `Store.meetingsForPaths()` 返回 `Map<string, …>`，键 = `meetingPathKey(meetingId, subMeetingId)` = `` `meetingId + '\\u0000' + subMeetingId`（与 `archiveStateKey` 同一分隔符） ``（新导出，放 `packages/engine/src/domain/types.ts`）。两个宿主（SQLite / MySQL）同改；不再有「后行覆盖」。
- 执行器 `buildRelPath` 用 `(row.meeting_id, row.sub_meeting_id)` 查；`writeMeetingManifests` 照旧遍历 Map。
- `tests/worker/store-mysql.test.ts:530` 那条「sub_meeting_id 最大的一条胜出」的用例改成「两个场次各自一项」。

**补充（目录序号 `_2`/`_3`）：** 同一 `meeting_id` 下算出同名目录的多条记录，按 `(created_at, sub_meeting_id)` 升序编号，第 1 条目录名不变、第 2 条起在最后一段末尾加 `_2`、`_3`（`packages/engine/src/domain/dir-ordinal.ts` 的 `assignDirOrdinals`，引擎与拆分脚本共用同一份实现）。主序是 `created_at`（首次发现时间，`upsertMeeting` 冲突时不改这一列）而不是 record id 字符串：单按字符串排的话，上游后补出一条更早的 record id 会把一个已经装着文件的目录当场改名。存量的 `''` 行 `created_at` 更早，所以存量目录保持原名；拆分脚本一批插进去的场次共用同一个 `created_at`，那一档才由 `sub_meeting_id` 定次序。

### 2.4 存量数据迁移：`scripts/split-recurring-meetings.ts`

一次性脚本，默认 dry-run，`--apply` 才动手；可重复跑（只处理 `sub_meeting_id = ''` 的 `meetings` 行，跑完就没有了）。环境：`DATABASE_URL`、`MDE_ARCHIVE_ROOT`。

**规划**（每个 `sub_meeting_id = ''` 的 `meetings` 行一个计划项）：

1. 场次清单 = `meeting_cache` 里该 `meeting_id` 的所有行（record id、start/end、subject、code、host）。
2. 该会议的每条 `meeting_assets` 行按 `SUBSTRING_INDEX(asset_id, ':', 1)` 归到一个 record id。资产指向的 record id 不在 `meeting_cache` 里：用 `meetings` 行自身的 subject/code/host/start/end 顶上（只可能是单场次会议的老数据）；多于一个这样的 record id → 该会议标 `undecidable`，跳过，退出码 2。
3. 每个 record id R 的新目录 = `meetingDirPath({subject, startTime: 该 record 的 start_time, meetingCode})`；每个资产的新文件名 = `assetKeyToFilename(key, remote_id, file_type, ordinal)`，ordinal = 该资产在新组 `(meeting_id, R, asset_type, file_type)` 里按 `id` 升序的序号。新 `target_path` = 新目录/新文件名；`archived_assets.local_path` / `nas_path` 同样换成新目录/新文件名（NAS 基准目录按 `rename-archive-dirs.ts` 的 `resolveNasBase` 取）。
4. 一个会议只要有任何一个资产的 record id 在 `meeting_cache` 里查不到 start_time，且资产数 > 0，就按第 2 条处理；没有资产的会议只拆 `meetings` 行本身（按 `meeting_cache` 场次）。

**执行**（每个会议一个单位，顺序固定，任一步失败回滚该会议已做的文件移动）：

1. 本地文件：`MDE_ARCHIVE_ROOT/<旧 target_path>` → `MDE_ARCHIVE_ROOT/<新 target_path>`（`mkdir -p` 新目录）；旧文件不存在跳过（记 `not_found`），新路径已存在且不是同一文件 → 该会议 `conflict`，什么都不动。
2. NAS 文件：`<nasBase>/<旧 nas_path>` → `<nasBase>/<新 nas_path>`，同上。
3. 一个事务：
   - `meetings`：为每个 R 插入一行（subject/code/host/start/end 来自 `meeting_cache`），删除 `''` 行。
   - `meeting_assets`：`sub_meeting_id = R`，`target_path = 新路径`。
   - `archived_assets`、`asset_contents`：`sub_meeting_id = R`（按 `(meeting_id, asset_type, remote_id, file_type)` 与 `meeting_assets` 对上），`local_path` / `nas_path` 换新。
   - `meeting_archives`：`''` 行复制成每个**有 `archived_assets` 行的** R 一行（`archived_at`、`nas_dir`、`retention_days`、`extended_days`、`local_purged_at` 原样），删除 `''` 行。
   - `meeting_grants`、`meeting_overrides`：`''` 行复制成每个 R 一行（含已撤销的，`revoked_at` 原样），删除 `''` 行——一场会议上的授权与改写对它的每个场次都成立。
   - `meeting_asset_probes`：删除 `''` 行。探测状态是过程量，下一轮发现按场次重建。
   - `job_failures`：`target = '<meeting_id>|'` 的行 `resolved_at = now`。dead 资产下一轮由调度器按场次重新登记。
   - `audit_log`：不动。延长保留期的历史记录仍挂在 `meeting_id` 上，抽屉里「延长 N 次」对拆分前的延长记录会按场次各显示不到——已知损失，写进 runbook。
4. 旧目录里的 `_manifest.json` / `meeting.json`（本地与 NAS）删除；本地清单由下一次 worker 运行按场次重写；NAS 侧车按新场次由脚本重写——`src/worker/archive.ts` 的 `writeNasSidecars` 抽成可复用函数（输入：会议行 + 该场次的 `archived_assets` 行 + nas 目录），脚本与归档流水线共用。
5. 旧目录空了就删掉；不空（有不认识的文件）保留并记 `left_over`。

**输出**：与改名脚本同一套口径——每项 `renamed | already_done | not_found | conflict | undecidable`，`--apply` 下 `conflict/undecidable` 非零退出码 2。

**迁移 013**：`013_meeting_cache_sub_meeting_id.sql`——`UPDATE meeting_cache SET sub_meeting_id = meeting_record_id WHERE sub_meeting_id = ''`。幂等；放迁移是因为它没有文件副作用、所有环境都要跑。

### 2.5 上线顺序

1. 停本机与服务器的网关和调度器（脚本移动文件期间不能有人写目录）。
2. 部署新代码；`bun scripts/split-recurring-meetings.ts` dry-run → 看计划 → `--apply`（输出 tee 到日志）。
3. 起网关与调度器。首轮 `fetch_recordings` 会按场次重建探测行与本地清单。
4. 验收：`SELECT meeting_id, COUNT(*) FROM meetings GROUP BY 1 HAVING COUNT(*) > 1` 有行（周期会议已拆）；`meetings` 无 `sub_meeting_id = ''`；控制台会议列表里「销售日会」按日期一场次一行、资产计数 6；每个场次目录里 `transcript.txt`/`minutes.md`/`chapters.json` 不带后缀（除非同场次真有多个录制文件）；`SELECT COUNT(*) FROM meeting_assets a LEFT JOIN meetings m USING(meeting_id, sub_meeting_id) WHERE m.meeting_id IS NULL` = 0。

## 3. 不做

- 不改目录命名规则、不改 UTC。
- 不给 `audit_log` 加 sub 列。
- 不改控制台页面（它已经按两段键工作；只把 `api/mock/*` 里的 `subMeetingId: ''` 换成示例 record id）。
- 不处理 CLI 的旧 SQLite 库存量数据（`--out` 目录换一个即可；README 写一句）。

## 4. Entity delta

+1 迁移 / +1 一次性脚本 / `AssetSource.listAssets` 加一个参数 / `meetingsForPaths` 键改两段 / 公开 API 两个端点加一个可选 query / +1 导出 `meetingPathKey` / `writeNasSidecars` 抽成可复用。不加表、不加配置、不加依赖。
