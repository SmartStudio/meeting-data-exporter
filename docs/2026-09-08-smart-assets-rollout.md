# 2026-09-08 上线：六类资产 + 目录去中文

## 0. 前置
- 本机与服务器的定时任务都停掉（`MDE_SCHEDULER` 进程 / systemd unit），网关也停——改名脚本与归档并发会把文件写进旧目录。
- 备份：`mysqldump <db> meetings meeting_assets archived_assets meeting_archives > backup-2026-09-08.sql`。

## 1. 部署代码
`git pull && bun install && bun run typecheck`；控制台 `cd console && bun run build`。

## 2. 改名
    DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts          # 看清单
    DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts --apply 2>&1 | tee rename-$(date +%s).log
若任何一场会议的 `meeting_archives.nas_dir` 够不着（NAS 没挂上/挂错路径），`--apply` 直接以退出码 2 中止、
一场都不改——先修好挂载点再重跑。跑完看最后一行 `renamed=… already_done=… not_found=… conflict=… failed=…`：
有 conflict 或 failed，脚本退出码非零。`not_found`（旧目录、新目录本地和 NAS 上都找不到）不算失败，但**必须
人工看**——多半是归档区被清理过、或 `MDE_ARCHIVE_ROOT` 指错了地方，不能当成「反正是老会议不用管」跳过。
有 conflict 的会议手工看两个目录，合并后再跑一次（脚本可重复跑）。日志已经 `tee` 下来了，出事第一现场就是
这份文件。

## 3. 起服务
先起网关，再起定时任务。看一轮日志无 `InvalidAssetIdError`。

## 4. 回填纪要与时间轴
    bun src/worker/index.ts --from 2026-09-01 --to <今天>
discovery 会给窗口内每场会议补 `ai_minutes` / `chapters`（没开智能录制的会议 chapters 直接 abandoned，理由 upstream_timeout）；下载走 data: URL；`listMeetingsNeedingArchive` 按「completed 数 > archived 数」把这些会议再归一次档，正文随归档入库。
每个 record_file 每轮 discovery 要探两次智能接口（minutes + chapters），窗口拉大、会议一多，调用量就跟着上去——
回填期间盯着 worker 日志，看有没有腾讯 190310（调用超限）；出现了就把 `--from/--to` 收窄到几天一段，分批跑完
整个窗口，别一次性拉到底。

## 5. 验收
    SELECT asset_type, COUNT(*) FROM archived_assets GROUP BY 1;   -- 出现 ai_minutes / chapters
    SELECT asset_type, status, COUNT(*) FROM asset_contents GROUP BY 1,2;  -- ai_minutes/chapters 为 parsed
    SELECT asset_type, last_error, COUNT(*) FROM meeting_assets WHERE status IN ('dead','skipped') GROUP BY 1,2;
NAS 抽一场：`<nas_dir>/2026/09/2026-09-0X_HHMM_<会议号>/` 下有 `minutes.md`、`chapters.json`（开了智能录制的）。
`_manifest.json` **不在这个会议目录里**，在 `<nas_dir>/_manifest.json`（同一条归档规则渲染出的所有会议共用
这一份）——去那份文件里找这场会议对应的条目，确认它的 `nasPath` 指向新目录。
控制台：任一场会议 → 内容预览 → 三个 tab 都有内容；规则编辑器资产类型下拉是六项。

## 6. 回滚
代码回退到上一版；目录名不回滚（新格式对旧代码也只是「另一场会议的目录」，旧代码会在旧路径新建目录，不会破坏已有文件）。
