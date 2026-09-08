# 2026-09-08 上线：六类资产 + 目录去中文

## 0. 前置
- 本机与服务器的定时任务都停掉（`MDE_SCHEDULER` 进程 / systemd unit），网关也停——改名脚本与归档并发会把文件写进旧目录。
- 备份：`mysqldump <db> meetings meeting_assets archived_assets meeting_archives > backup-2026-09-08.sql`。

## 1. 部署代码
`git pull && bun install && bun run typecheck`；控制台 `cd console && bun run build`。

## 2. 改名
    DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts          # 看清单
    DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/rename-archive-dirs.ts --apply 2>&1 | tee rename-$(date +%s).log
脚本的计划同时来自 `meetings` 表和三列路径（`meeting_assets.target_path`、`archived_assets.local_path` /
`nas_path`）里长得像旧格式的目录前缀，所以周期性会议那些「行里只剩最新一场、磁盘上还有好几天」的旧实例目录
也在覆盖范围里；反过来，`meetings` 行算出来的那一场若从没落过盘，汇总里它报 `not_found` 是预期的。
若任何一场会议的 `meeting_archives.nas_dir` 够不着（NAS 没挂上/挂错路径），`--apply` 直接以退出码 2 中止、
一场都不改——先修好挂载点再重跑。跑完看最后一行 `renamed=… already_done=… not_found=… conflict=… failed=…`：
有 conflict 或 failed，脚本退出码非零。`not_found`（旧目录、新目录本地和 NAS 上都找不到）不算失败，但**必须
人工看**——三种原因：归档区被清理过、`MDE_ARCHIVE_ROOT` 指错了地方，或者**归档之后有人改过会议主题**
（旧目录名是按当时那个主题算出来的，库里现在是新主题，算出来的旧目录名对不上磁盘上真实的那一个）。第三种
要手工把目录名对上再重跑，不能当成「反正是老会议不用管」跳过。
有 conflict 的会议手工看两个目录，合并后再跑一次（脚本可重复跑）。日志已经 `tee` 下来了，出事第一现场就是
这份文件。归档半途中断的会议（`archived_assets` 有行、`meeting_archives` 那一行还没写成）NAS 基准目录是从
`nas_path` 反推出来的，所以它们的 NAS 目录照样改得动；反推结果与 `meeting_archives.nas_dir` 对不上的那几条
一律报 conflict、原地不动，得人工确认这场会议到底归到哪个基准目录下。

`failed` 里有一种特殊情况脚本会**在那一行里写明**：目录改名与三张表都已经改完并提交了，只差 `nas_dir` 根上
那份 `_manifest.json` 没写成。这一场重跑修不了（旧目录已经不在，会被判 `already_done`），照那行提示手工把
manifest 里对应的 `nasPath` 前缀改过来即可。dry-run 若发现**重复目录**（多场会议算出同一个目录名）同样以
退出码 1 结束——那是计划本身有问题，先把它处理掉再谈 `--apply`。

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

**存量白名单里不会自己长出 `chapters`**，必须查一遍。`grants.ts` 把规范化、展开后的键列表**原样存进库**
（`service_accounts.auto_grant_asset_types`、`meeting_grants.asset_types`），本次上线之前写下的那些行装的还是
老的八个键减去删掉的三个，代码升级不会去改它们——于是这些程序永远拿不到 `chapters`（以及 `ai_minutes`），
而界面上看不出任何异常：

    -- 显式配了自动授权白名单的程序（NULL = 不限制，那一档不用管）
    SELECT id, name, auto_grant_asset_types FROM service_accounts WHERE auto_grant_asset_types IS NOT NULL;
    -- 生效中的授权行里，范围没有 chapters 的（asset_types IS NULL 同样是「不限制」，排除掉）
    SELECT program_id, meeting_id, sub_meeting_id, asset_types
      FROM meeting_grants
     WHERE revoked_at = 0 AND asset_types IS NOT NULL AND asset_types NOT LIKE '%chapters%';

两条查询任何一条有命中，就去控制台把那个程序（或那条授权）的资产范围**重新勾一遍并保存**——保存会按新的
六类重写这一行。不勾就等于这些程序继续按老白名单取数据。

## 6. 回滚
**回退代码之前**先把还没跑完的 `chapters` / `ai_minutes` 行标成 `skipped`：

    UPDATE meeting_assets SET status = 'skipped', last_error = '回滚到 2026-09-08 之前的版本'
     WHERE asset_type IN ('chapters', 'ai_minutes') AND status NOT IN ('dead', 'skipped');

旧版的 `parseAssetId` 不认这两类新 id，留着没跑完（`pending` / `running` / `failed`）或已 `completed` 待归档的
行，旧代码每轮都会在它们身上抛 `InvalidAssetIdError`。

然后代码回退到上一版；目录名不回滚（新格式对旧代码也只是「另一场会议的目录」，旧代码会在旧路径新建目录，不会破坏已有文件）。
